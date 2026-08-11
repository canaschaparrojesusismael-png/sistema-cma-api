const admin = require("../_lib/firebaseAdmin");
const { handleCorsAndMethod, sendError } = require("../_lib/helpers");

const SYSTEM_PROMPT_BASE = `Sos el asistente virtual del Sistema Nacional de Orquestas y Coros
Juveniles e Infantiles de Venezuela (Fundación Musical Simón Bolívar).

REGLAS ESTRICTAS:
1. SOLO respondés preguntas relacionadas con música: teoría musical, instrumentos,
   solfeo, historia de la música, compositores, técnica, repertorio, y el
   contenido de Formación del sitio (los libros/temas que te paso abajo).
2. Si te preguntan algo que NO es de música (tecnología, política, tareas de
   otras materias, etc.), respondé amablemente que solo podés ayudar con temas
   musicales, y no respondas la pregunta.
3. Cuando la respuesta esté en el material de Formación de abajo, decilo
   explícitamente: "Esto lo encontrás en Formación → [Nivel] → [nombre del recurso]".
4. Si no está en el material del sitio pero es una pregunta legítima de música
   general, respondé igual con tu conocimiento, dejando claro que es
   información general (no del material oficial del sitio).
5. Sé breve, claro y pedagógico — le hablás a estudiantes de orquesta, muchos
   niños y jóvenes. Nada de lenguaje ofensivo ni fuera de tema.`;

// ---------- RAG liviano: trae el material de Formación y arma contexto ----------
async function construirContexto(pregunta) {
  const db = admin.firestore();
  const snap = await db.collection("formacion_modulos").limit(300).get();
  const recursos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!recursos.length) return "(Todavía no hay recursos cargados en Formación.)";

  // Scoring simple por coincidencia de palabras — no es un embedding real,
  // pero para un catálogo de recursos de un sitio institucional alcanza y sobra,
  // y no depende de ningún servicio pago de vectores.
  const palabrasPregunta = (pregunta || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/\W+/)
    .filter((w) => w.length > 3);

  function score(r) {
    const texto = `${r.nombre || ""} ${r.descripcion || ""} ${r.contenido || ""}`
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return palabrasPregunta.reduce((acc, w) => acc + (texto.includes(w) ? 1 : 0), 0);
  }

  const relevantes = recursos
    .map((r) => ({ ...r, _score: score(r) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 6);

  return relevantes
    .map((r) => {
      const cuerpo = r.contenido ? r.contenido.slice(0, 600) : (r.url ? `Enlace: ${r.url}` : (r.descripcion || ""));
      return `· "${r.nombre}" (Nivel: ${r.nivel || "—"} / Tipo: ${r.tipo || "—"})\n  ${cuerpo}`;
    })
    .join("\n\n");
}

// ---------- Proveedor 1: Groq (rápido, gratis, modelos Llama) ----------
async function preguntarGroq(systemPrompt, historial, mensaje) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY no configurada");

  const messages = [
    { role: "system", content: systemPrompt },
    ...(historial || []).slice(-6),
    { role: "user", content: mensaje },
  ];

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.4,
      max_tokens: 700,
    }),
  });
  if (!resp.ok) throw new Error(`Groq respondió ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim();
}

// ---------- Proveedor 2: Google Gemini (respaldo si Groq falla) ----------
async function preguntarGemini(systemPrompt, historial, mensaje) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY no configurada");

  const contents = [
    ...(historial || []).slice(-6).map((h) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    })),
    { role: "user", parts: [{ text: mensaje }] },
  ];

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 700 },
      }),
    }
  );
  if (!resp.ok) throw new Error(`Gemini respondió ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
}

module.exports = async (req, res) => {
  if (handleCorsAndMethod(req, res)) return;

  try {
    const { mensaje, historial } = req.body || {};
    if (!mensaje || !mensaje.trim()) {
      return res.status(400).json({ error: "Falta el mensaje." });
    }
    if (mensaje.length > 1000) {
      return res.status(400).json({ error: "El mensaje es demasiado largo (máx. 1000 caracteres)." });
    }

    const contexto = await construirContexto(mensaje);
    const systemPrompt = `${SYSTEM_PROMPT_BASE}\n\nMATERIAL OFICIAL DE FORMACIÓN (usalo cuando aplique):\n${contexto}`;

    let respuesta, proveedor;
    try {
      respuesta = await preguntarGroq(systemPrompt, historial, mensaje);
      proveedor = "groq";
    } catch (errGroq) {
      console.error("Groq falló, probando Gemini:", errGroq.message);
      try {
        respuesta = await preguntarGemini(systemPrompt, historial, mensaje);
        proveedor = "gemini";
      } catch (errGemini) {
        console.error("Gemini también falló:", errGemini.message);
        return res.status(502).json({
          error: "Los dos proveedores de IA fallaron. Probá de nuevo en un momento.",
        });
      }
    }

    if (!respuesta) {
      return res.status(502).json({ error: "La IA no devolvió una respuesta." });
    }

    res.status(200).json({ respuesta, proveedor });
  } catch (err) {
    sendError(res, err);
  }
};
