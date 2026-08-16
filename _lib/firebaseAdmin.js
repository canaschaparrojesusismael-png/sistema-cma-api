const admin = require("firebase-admin");

// La service account se guarda como variable de entorno en Vercel
// (FIREBASE_SERVICE_ACCOUNT_KEY), NUNCA como archivo en el repo.
// Ver README.md para cómo generarla y cargarla.
//
// IMPORTANTE: esto se inicializa DE FORMA PEREZOSA (lazy). Si tirábamos el
// error acá arriba (a nivel de módulo), Vercel no llegaba ni a cargar la
// función — y como el CORS se pone DESPUÉS de este require, el navegador
// veía la función caída como si fuera un bloqueo de CORS (confuso: parecía
// un problema de CORS pero en realidad era Firebase mal configurado).
// Ahora, si falla, el error se guarda y recién se lanza cuando alguien
// intenta USAR admin.firestore()/admin.auth() — para entonces el handler
// ya puso los headers de CORS, así que el navegador SÍ ve el error real.
let initError = null;

function getAdmin() {
  if (admin.apps.length) return admin;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) {
      throw new Error("Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT_KEY en Vercel.");
    }
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(raw);
    } catch (e) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY no es un JSON válido (revisá que la pegaste completa, sin cortar).");
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (err) {
    initError = err;
    throw err;
  }
  return admin;
}

module.exports = getAdmin;
module.exports.getInitError = () => initError;
