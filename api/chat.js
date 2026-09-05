const getAdmin = require("../_lib/firebaseAdmin");
const { handleCorsAndMethod, getCallerUidOrThrow, verificarLimiteDeUso } = require("../_lib/helpers");
const { preguntarGroq, preguntarGemini, VERSION_IA } = require("../_lib/proveedoresIA");

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
  const db = getAdmin().firestore();
  // Timeout propio: si Firestore se cuelga, esto no puede comerse todo el
  // presupuesto de 10s de la función y dejar sin tiempo a Groq/Gemini.
  const snap = await Promise.race([
    db.collection("formacion_modulos").limit(300).get(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Firestore tardó más de 3s en responder")), 3000)),
  ]);
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

module.exports = async (req, res) => {
  if (handleCorsAndMethod(req, res)) return;
  const inicio = Date.now();

  try {
    // ------------------------------------------------------------------
    // CORREGIDO 2026-09-01: este endpoint NO exigía sesión iniciada — está
    // escrito en el frontend (backend-api.js), a la vista de cualquiera que
    // abra las herramientas de desarrollador del navegador, así que
    // cualquier persona en internet (sin ser alumno ni personal de CMA)
    // podía llamarlo directo, sin límite, gastando la cuota PAGA de
    // Groq/Gemini de la escuela. formacion.html —el único lugar del sitio
    // que usa este chat— YA exige sesión iniciada antes de mostrar el chat
    // (si no hay sesión, redirige a index.html), así que exigirla acá
    // también no le quita nada a ningún uso real: solo cierra el hueco para
    // quien no pasa por la interfaz.
    // ------------------------------------------------------------------
    let callerUid;
    try {
      callerUid = await getCallerUidOrThrow(req);
    } catch (errAuth) {
      return res.status(errAuth.status || 401).json({
        error: errAuth.message,
        categoria: "no_autenticado",
        version: VERSION_IA,
      });
    }

    // Límite de uso POR PERSONA (no por IP): así una escuela entera
    // compartiendo la misma conexión a internet no se traba entre sí, pero
    // una sola cuenta (comprometida, o con un bug del lado del cliente que
    // reintente en loop) no puede agotar la cuota de todos.
    try {
      await verificarLimiteDeUso(`chat_${callerUid}`, { maxPedidos: 30, ventanaMs: 10 * 60 * 1000 });
    } catch (errLimite) {
      // Si es el límite real (nuestro propio throw en helpers.js), 429 con
      // el mensaje real. Si en cambio verificarLimiteDeUso falló por otra
      // razón (ej. Firestore caído justo en ese momento), NO le echamos la
      // culpa al límite de uso con un mensaje falso — pero igual frenamos
      // el pedido acá (fail-safe: mejor bloquear de más una vez que
      // arriesgarse a que el protector de cuota falle en silencio).
      const esLimiteReal = errLimite.status === 429;
      return res.status(esLimiteReal ? 429 : 500).json({
        error: esLimiteReal ? errLimite.message : "No se pudo verificar el límite de uso por una falla interna. Probá de nuevo en un momento.",
        categoria: esLimiteReal ? (errLimite.categoria || "limite_de_uso_excedido") : "error_interno_servidor",
        version: VERSION_IA,
      });
    }

    const { mensaje, historial } = req.body || {};
    if (!mensaje || !mensaje.trim()) {
      return res.status(400).json({ error: "Falta el mensaje.", categoria: "pedido_invalido", version: VERSION_IA });
    }
    if (mensaje.length > 1000) {
      return res.status(400).json({ error: "El mensaje es demasiado largo (máx. 1000 caracteres).", categoria: "pedido_invalido", version: VERSION_IA });
    }

    let contexto;
    try {
      contexto = await construirContexto(mensaje);
    } catch (errContexto) {
      console.error("No se pudo construir el contexto desde Formación (sigo sin él):", errContexto.message);
      contexto = "(No se pudo leer el material de Formación en este momento — revisá FIREBASE_SERVICE_ACCOUNT_KEY en Vercel si esto persiste.)";
    }
    const systemPrompt = `${SYSTEM_PROMPT_BASE}\n\nMATERIAL OFICIAL DE FORMACIÓN (usalo cuando aplique):\n${contexto}`;

    let respuesta, proveedor;
    let motivoGroq = null, motivoGemini = null;
    try {
      respuesta = await preguntarGroq(systemPrompt, historial, mensaje);
      proveedor = "groq";
    } catch (errGroq) {
      motivoGroq = errGroq.message;
      console.error("Groq falló, probando Gemini:", errGroq.message);
      try {
        respuesta = await preguntarGemini(systemPrompt, historial, mensaje);
        proveedor = "gemini";
      } catch (errGemini) {
        motivoGemini = errGemini.message;
        console.error("Gemini también falló:", errGemini.message);
        return res.status(502).json({
          error: "Los dos proveedores de IA fallaron.",
          categoria: "ambos_proveedores_fallaron",
          detalle_groq: motivoGroq,
          detalle_gemini: motivoGemini,
          tiempo_ms: Date.now() - inicio,
          version: VERSION_IA,
        });
      }
    }

    if (!respuesta) {
      return res.status(502).json({ error: "La IA no devolvió una respuesta.", categoria: "respuesta_vacia", tiempo_ms: Date.now() - inicio, version: VERSION_IA });
    }

    res.status(200).json({ respuesta, proveedor, aviso_groq: motivoGroq, tiempo_ms: Date.now() - inicio, version: VERSION_IA });
  } catch (err) {
    console.error("Error no esperado en /api/chat:", err);
    res.status(500).json({
      error: "Error interno inesperado en el servidor.",
      categoria: "error_interno_servidor",
      detalle: err.message,
      tiempo_ms: Date.now() - inicio,
      version: VERSION_IA,
    });
  }
};