const getAdmin = require("../_lib/firebaseAdmin");
const { handleCorsAndMethod } = require("../_lib/helpers");

// GET/POST público — no expone ninguna clave, solo dice "configurada" o "falta".
// Pensado para abrir directo en el navegador cuando algo no responde:
// https://TU-PROYECTO.vercel.app/api/diagnostico
module.exports = async (req, res) => {
  // Este endpoint acepta GET además de POST porque está pensado para
  // abrirse directo en el navegador.
  const setCorsHeaders = () => {
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  };
  setCorsHeaders();
  if (req.method === "OPTIONS") return res.status(204).end();

  const reporte = {
    ok: true,
    timestamp: new Date().toISOString(),
    variables_de_entorno: {
      FIREBASE_SERVICE_ACCOUNT_KEY: process.env.FIREBASE_SERVICE_ACCOUNT_KEY ? "configurada" : "❌ FALTA",
      GROQ_API_KEY: process.env.GROQ_API_KEY ? "configurada" : "❌ FALTA",
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? "configurada" : "❌ FALTA",
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || "(no puesta — usando '*', funciona pero es menos seguro)",
    },
    firebase_admin: "sin probar",
    groq: "sin probar",
    gemini: "sin probar",
  };

  // Probar Firebase Admin de verdad (no solo si la variable existe)
  try {
    getAdmin().firestore();
    reporte.firebase_admin = "✅ inicializa correctamente";
  } catch (err) {
    reporte.firebase_admin = "❌ " + err.message;
    reporte.ok = false;
  }

  // Probar Groq con una llamada mínima real
  if (process.env.GROQ_API_KEY) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      });
      reporte.groq = r.ok ? "✅ responde correctamente" : `❌ respondió ${r.status}`;
      if (!r.ok) reporte.ok = false;
    } catch (err) {
      reporte.groq = "❌ " + err.message;
      reporte.ok = false;
    }
  } else {
    reporte.groq = "❌ no se puede probar, falta la clave";
    reporte.ok = false;
  }

  // Probar Gemini con una llamada mínima real
  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
      );
      reporte.gemini = r.ok ? "✅ responde correctamente" : `❌ respondió ${r.status}`;
      if (!r.ok) reporte.ok = false;
    } catch (err) {
      reporte.gemini = "❌ " + err.message;
      reporte.ok = false;
    }
  } else {
    reporte.gemini = "❌ no se puede probar, falta la clave";
    reporte.ok = false;
  }

  res.status(200).json(reporte);
};
