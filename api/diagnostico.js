const getAdmin = require("../_lib/firebaseAdmin");
const { preguntarGroq, preguntarGemini, VERSION_IA, MODELOS_GROQ, MODELOS_GEMINI } = require("../_lib/proveedoresIA");

// Ventana durante la cual se reutiliza el último resultado real en vez de
// volver a llamar a Groq/Gemini. Ver comentario grande más abajo.
const VENTANA_CACHE_MS = 30 * 1000;

// GET/POST público — no expone ninguna clave, solo dice "configurada" o "falta".
// Pensado para abrir directo en el navegador cuando algo no responde:
// https://TU-PROYECTO.vercel.app/api/diagnostico
//
// IMPORTANTE: este endpoint usa las MISMAS funciones (preguntarGroq/
// preguntarGemini) que usa api/chat.js de verdad, con el mismo modelo y los
// mismos parámetros — antes probaba solo "listar modelos", que puede
// funcionar perfecto aunque el modelo de chat específico esté deprecado
// (fue justo lo que pasó: la clave era válida, pero el modelo ya no existía).
// Ahora el diagnóstico SIEMPRE va a mostrar el error real si lo hay.
module.exports = async (req, res) => {
  const inicio = Date.now();
  const setCorsHeaders = () => {
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  };
  setCorsHeaders();
  if (req.method === "OPTIONS") return res.status(204).end();

  const reporte = {
    ok: true,
    // ESTA VERSIÓN tiene que coincidir con la que aparece en los errores del
    // chat real. Si acá dice algo distinto a lo que ves en /api/chat, es
    // porque estás mirando un deploy viejo en caché — refrescá fuerte
    // (Ctrl+Shift+R) o esperá a que termine el último deploy en Vercel.
    version: VERSION_IA,
    timestamp: new Date().toISOString(),
    modelos_con_respaldo: {
      GROQ: MODELOS_GROQ,
      GEMINI: MODELOS_GEMINI,
    },
    variables_de_entorno: {
      FIREBASE_SERVICE_ACCOUNT_KEY: process.env.FIREBASE_SERVICE_ACCOUNT_KEY ? "configurada" : "❌ FALTA",
      GROQ_API_KEY: process.env.GROQ_API_KEY ? "configurada" : "❌ FALTA",
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? "configurada" : "❌ FALTA",
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || "(no puesta — usando '*', funciona pero es menos seguro)",
    },
    firebase_admin: "sin probar",
    groq: "sin probar (llamada de chat real, no solo 'listar modelos')",
    gemini: "sin probar (llamada de chat real, no solo 'listar modelos')",
  };

  // Probar Firebase Admin de verdad (no solo si la variable existe)
  try {
    getAdmin().firestore();
    reporte.firebase_admin = "✅ inicializa correctamente";
  } catch (err) {
    reporte.firebase_admin = "❌ " + err.message;
    reporte.ok = false;
  }

  // Probar Groq y Gemini con una pregunta real mínima (mismo camino que el
  // chat real) — PERO con cooldown (ver comentario abajo).
  //
  // CORREGIDO 2026-09-01: este endpoint es público y sin login a propósito
  // (para poder abrirlo directo en el navegador cuando algo falla), pero
  // antes CADA pedido —de cualquiera en internet, sin límite— disparaba 2
  // llamadas reales y pagas (Groq + Gemini). Peor: chat-widget.js llama a
  // este mismo endpoint automáticamente cada vez que un mensaje de chat
  // falla — así que un problema pasajero (por ejemplo Groq devolviendo 429
  // por demasiados pedidos) se retroalimentaba solo: cada estudiante con un
  // mensaje fallido disparaba 2 llamadas reales más, empeorando el mismo
  // límite que causó la falla original, para todos los que vinieran después.
  //
  // Ahora el resultado de la prueba real se guarda en Firestore
  // (_meta/diagnostico_cache) por 30 segundos. Un pedido dentro de esa
  // ventana recibe el resultado guardado (marcado como tal) en vez de
  // gastar 2 llamadas más. Sigue sirviendo igual para un desarrollador que
  // abre la URL una vez para revisar el estado.
  //
  // Ojo: si Firebase Admin no inicializa (ya lo probamos arriba y quedó
  // registrado en reporte.firebase_admin), esta parte de la caché NO puede
  // funcionar tampoco — pero eso no debería tirar abajo TODO el
  // diagnóstico con un error sin manejar (que es justo lo que este
  // endpoint existe para evitar). Por eso todo el acceso a Firestore de
  // acá está en su propio try/catch: si falla, simplemente no hay caché
  // disponible y se prueban Groq/Gemini en vivo igual (esos dos NO
  // dependen de Firebase, así que pueden seguir funcionando aunque
  // Firebase esté roto).
  let refCache = null;
  let cache = null;
  try {
    const db = getAdmin().firestore();
    refCache = db.collection("_meta").doc("diagnostico_cache");
    const snap = await refCache.get();
    if (snap.exists) cache = snap.data();
  } catch { /* sin caché disponible — seguimos igual, probando en vivo */ }

  const cacheVigente = cache && cache.version === VERSION_IA && (Date.now() - cache.timestamp) < VENTANA_CACHE_MS;

  if (cacheVigente) {
    const segundos = Math.round((Date.now() - cache.timestamp) / 1000);
    reporte.groq = `${cache.groq} (resultado guardado hace ${segundos}s — no se repitió la llamada real todavía, para no gastar cuota de más)`;
    reporte.gemini = `${cache.gemini} (resultado guardado hace ${segundos}s)`;
    reporte.ok = reporte.ok && cache.ok;
  } else {
    // CORREGIDO 2026-09-05: mismo bug de tiempos que en chat.js — Vercel
    // mata esta función a los 10s (vercel.json → maxDuration), y sin un
    // presupuesto compartido, Groq y Gemini podían sumar hasta 24s entre
    // los dos (3 modelos × 4s cada uno, por proveedor) si todos fallaban
    // por timeout. Le damos a cada proveedor una porción fija del total,
    // dejando margen para la respuesta final.
    try {
      const respuesta = await preguntarGroq("Respondé solo con la palabra: ok", [], "hola", inicio + 4200);
      reporte.groq = respuesta ? `✅ responde correctamente (dijo: "${respuesta.slice(0, 60)}")` : "❌ respondió 200 pero sin texto";
      if (!respuesta) reporte.ok = false;
    } catch (err) {
      reporte.groq = "❌ " + err.message;
      reporte.ok = false;
    }

    try {
      const respuesta = await preguntarGemini("Respondé solo con la palabra: ok", [], "hola", inicio + 8600);
      reporte.gemini = respuesta ? `✅ responde correctamente (dijo: "${respuesta.slice(0, 60)}")` : "❌ respondió 200 pero sin texto";
      if (!respuesta) reporte.ok = false;
    } catch (err) {
      reporte.gemini = "❌ " + err.message;
      reporte.ok = false;
    }

    if (refCache) {
      await refCache.set({ groq: reporte.groq, gemini: reporte.gemini, ok: reporte.ok, timestamp: Date.now(), version: VERSION_IA }).catch(() => {});
    }
  }

  res.status(200).json(reporte);
};
