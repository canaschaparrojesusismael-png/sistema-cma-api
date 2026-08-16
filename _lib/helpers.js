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
async function getCallerUidOrThrow(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    const err = new Error("Debes iniciar sesión.");
    err.status = 401;
    throw err;
  }
  try {
    const decoded = await getAdmin().auth().verifyIdToken(token);
    return decoded.uid;
  } catch (e) {
    const err = new Error(e.message?.includes("FIREBASE_SERVICE_ACCOUNT_KEY") ? e.message : "Sesión inválida o expirada.");
    err.status = e.message?.includes("FIREBASE_SERVICE_ACCOUNT_KEY") ? 500 : 401;
    throw err;
  }
}

function sendError(res, err) {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Error interno." });
}

module.exports = { setCors, handleCorsAndMethod, getCallerUidOrThrow, sendError };
