const getAdmin = require("./firebaseAdmin");

// Cambiá esto por tu dominio real de GitHub Pages para más seguridad
// (por ejemplo "https://tu-usuario.github.io"). "*" funciona pero es más laxo.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Maneja el preflight OPTIONS y exige POST. Devuelve true si ya respondió
// (y por lo tanto el handler debe cortar ahí mismo).
function handleCorsAndMethod(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido, usá POST." });
    return true;
  }
  return false;
}

// Verifica el ID token de Firebase que manda el cliente en el header
// Authorization: Bearer <token>. Equivale a lo que Cloud Functions daba
// gratis en context.auth.
//
// v3.0 (P-60): los dos motivos de fallo (no mandó token / el token que
// mandó no sirve) ya tenían mensajes distintos, pero ninguno traía una
// "categoria" programática como sí tiene el error de límite de uso más
// abajo (err.categoria = "limite_de_uso_excedido"). Se agrega acá mismo
// por si en el futuro el frontend quiere reaccionar distinto (por ejemplo,
// mandar directo a login si nunca hubo sesión, vs. avisar "tu sesión
// venció" si el token expiró) — no cambia el status ni el mensaje actual.
async function getCallerUidOrThrow(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    const err = new Error("Debes iniciar sesión.");
    err.status = 401;
    err.categoria = "sin_token";
    throw err;
  }
  try {
    const decoded = await getAdmin().auth().verifyIdToken(token);
    return decoded.uid;
  } catch (e) {
    const esErrorDeConfiguracion = e.message?.includes("FIREBASE_SERVICE_ACCOUNT_KEY");
    const err = new Error(esErrorDeConfiguracion ? e.message : "Sesión inválida o expirada.");
    err.status = esErrorDeConfiguracion ? 500 : 401;
    err.categoria = esErrorDeConfiguracion ? "config_servidor" : "token_invalido";
    throw err;
  }
}

function sendError(res, err) {
  const status = err.status || 500;
  // v3.0 (P-60): si el error trae una "categoria" (ver getCallerUidOrThrow
  // y verificarLimiteDeUso arriba), se incluye en la respuesta — antes se
  // descartaba acá mismo aunque ya se calculaba.
  const body = { error: err.message || "Error interno." };
  if (err.categoria) body.categoria = err.categoria;
  res.status(status).json(body);
}

// ---------------------------------------------------------------
// AGREGADO 2026-09-01: límite de uso simple, respaldado en Firestore.
// Por qué en Firestore y no en una variable en memoria: cada función
// serverless de Vercel puede correr en una instancia distinta en cada
// pedido, así que una variable en RAM NO protege nada de verdad (cada
// instancia tendría su propio contador en cero). Firestore es el único
// almacén persistente que este proyecto ya tiene conectado.
//
// Se usa con una clave (uid del usuario, o IP si no hay usuario) + una
// ventana de tiempo fija. Documento de ejemplo: "_limites_uso/chat_abc123_29123456"
// (endpoint + clave + número de ventana de 10 minutos).
//
// IMPORTANTE (pendiente de configurar en Firebase, no se puede hacer desde
// código): estos documentos se acumulan con el tiempo. Configurar una
// política de TTL en Firestore sobre el campo "expira" de la colección
// "_limites_uso" (Firebase Console → Firestore → Índices → TTL) para que
// se borren solos y no generen costo de almacenamiento innecesario.
// ---------------------------------------------------------------
async function verificarLimiteDeUso(clave, { maxPedidos, ventanaMs }) {
  const ventanaActual = Math.floor(Date.now() / ventanaMs);
  const docId = `${clave}_${ventanaActual}`.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 400);
  const db = getAdmin().firestore();
  const ref = db.collection("_limites_uso").doc(docId);

  const nuevoConteo = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const actual = snap.exists ? snap.data().conteo || 0 : 0;
    t.set(ref, { conteo: actual + 1, expira: Date.now() + ventanaMs }, { merge: true });
    return actual + 1;
  });

  if (nuevoConteo > maxPedidos) {
    const err = new Error(`Demasiados pedidos seguidos. Esperá unos minutos y probá de nuevo (máximo ${maxPedidos} cada ${Math.round(ventanaMs / 60000)} min).`);
    err.status = 429;
    err.categoria = "limite_de_uso_excedido";
    throw err;
  }
}

function obtenerIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "ip-desconocida").split(",")[0].trim();
}

module.exports = { setCors, handleCorsAndMethod, getCallerUidOrThrow, sendError, verificarLimiteDeUso, obtenerIp };
