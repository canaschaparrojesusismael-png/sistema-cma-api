const crypto = require("crypto");
const getAdmin = require("./firebaseAdmin");

// v4.0: ALLOWED_ORIGIN ahora acepta VARIOS orígenes separados por coma
// (ej. "https://tu-usuario.github.io,https://sistema.tudominio.com"). Si no
// está definida, queda en "*" (solo recomendable mientras se prueba).
const ORIGENES_PERMITIDOS = (process.env.ALLOWED_ORIGIN || "*")
  .split(",").map((o) => o.trim()).filter(Boolean);

// Niveles de la jerarquía — una sola fuente de verdad para todos los endpoints.
const JERARQUIA = {
  owner_supremo: 70,
  director_nacional: 60,
  director_regional: 50,
  director_nucleo: 40,
  admin: 30,
  profesor: 20,
  estudiante: 10,
};

function setCors(req, res) {
  const origen = req.headers.origin;
  if (ORIGENES_PERMITIDOS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origen && ORIGENES_PERMITIDOS.includes(origen)) {
    res.setHeader("Access-Control-Allow-Origin", origen);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
}

// Maneja el preflight OPTIONS y exige POST. Devuelve true si ya respondió
// (y por lo tanto el handler debe cortar ahí mismo).
function handleCorsAndMethod(req, res) {
  setCors(req, res);
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

// v4.0: además de verificar el token, (a) rechaza tokens REVOCADOS (cuando se
// desactiva una cuenta o se resetea su contraseña, sus sesiones viejas dejan de
// servir al instante en vez de seguir válidas hasta 1 hora) y (b) carga el perfil
// real del solicitante desde Firestore y exige que la cuenta siga activa.
async function getCallerOrThrow(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    const err = new Error("Debes iniciar sesión.");
    err.status = 401; err.categoria = "sin_token";
    throw err;
  }
  let decoded;
  try {
    decoded = await getAdmin().auth().verifyIdToken(token, true);
  } catch (e) {
    const esConfig = e.message?.includes("FIREBASE_SERVICE_ACCOUNT_KEY");
    const err = new Error(esConfig ? e.message : "Sesión inválida o expirada.");
    err.status = esConfig ? 500 : 401;
    err.categoria = esConfig ? "config_servidor" : "token_invalido";
    throw err;
  }
  const snap = await getAdmin().firestore().collection("usuarios").doc(decoded.uid).get();
  if (!snap.exists) {
    const err = new Error("Solicitante no encontrado.");
    err.status = 403; err.categoria = "perfil_inexistente";
    throw err;
  }
  const perfil = snap.data();
  if (perfil.cuentaActiva === false) {
    const err = new Error("Tu cuenta está desactivada.");
    err.status = 403; err.categoria = "cuenta_desactivada";
    throw err;
  }
  return { uid: decoded.uid, perfil };
}

// Contraseña aleatoria con CSPRNG (crypto.randomInt), sin caracteres ambiguos
// (0/O, 1/l/I). Antes la generaba el navegador con Math.random(), que NO es
// criptográficamente seguro.
function generarClave(largo = 14) {
  const mayus = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const minus = "abcdefghijkmnpqrstuvwxyz";
  const nums = "23456789";
  const simb = "!@#$%&*?";
  const todos = mayus + minus + nums + simb;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(mayus), pick(minus), pick(nums), pick(simb)];
  while (chars.length < largo) chars.push(pick(todos));
  for (let i = chars.length - 1; i > 0; i--) {           // Fisher-Yates con CSPRNG
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function limpiarTexto(valor, max = 120) {
  return String(valor ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
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

module.exports = { JERARQUIA, EMAIL_RE, setCors, handleCorsAndMethod, getCallerUidOrThrow, getCallerOrThrow, generarClave, limpiarTexto, sendError, verificarLimiteDeUso, obtenerIp };
