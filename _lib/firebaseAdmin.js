const admin = require("firebase-admin");

// La service account se guarda como variable de entorno en Vercel
// (FIREBASE_SERVICE_ACCOUNT_KEY), NUNCA como archivo en el repo.
// Ver README.md para cómo generarla y cargarla.
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      "Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT_KEY en Vercel. Revisá el README.md."
    );
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

module.exports = admin;
