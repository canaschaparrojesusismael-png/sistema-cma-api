// Funciones compartidas para hablar con Groq y Gemini. Las usa tanto
// api/chat.js (para responder de verdad) como api/diagnostico.js (para
// probar si funcionan) — así el diagnóstico SIEMPRE refleja la realidad,
// nunca un chequeo más simple que no detecta el problema real.

// ================================================================
// VERSIÓN DEL CÓDIGO — cambia cada vez que se edita este archivo.
// Aparece en CADA respuesta (éxito o error) de /api/chat y /api/diagnostico.
// Sirve para confirmar sin ninguna duda si Vercel ya tiene el código nuevo:
// si la versión que ves en el chat/los logs NO es esta, el deploy todavía
// no se aplicó (hay que revisar GitHub → Vercel, no el código en sí).
// ================================================================
const VERSION_IA = "2026-09-01.5-modelos-vigentes";

// El frontend arma el historial con nombres de campo en español
// ({ rol: "usuario"|"ia", texto: "..." }), pero las APIs de Groq/Gemini
// esperan el formato estándar en inglés ({ role: "user"|"assistant",
// content: "..." }). Este normalizador acepta cualquiera de los dos formatos.
function normalizarHistorial(historial) {
  return (historial || [])
    .map((h) => {
      const rolOriginal = h.role || h.rol || "user";
      const role = ["assistant", "ia", "bot", "model"].includes(rolOriginal) ? "assistant" : "user";
      const content = h.content ?? h.texto ?? "";
      return { role, content: String(content) };
    })
    .filter((h) => h.content.trim());
}

// Fusiona turnos consecutivos del mismo rol en uno solo. Gemini (y en
// general las APIs de chat) esperan que los turnos alternen
// user/assistant/user/assistant... Si varios mensajes seguidos fallaron
// (nunca hubo respuesta de la IA para intercalar entre medio), el historial
// termina con varios turnos "user" seguidos — eso rompe el pedido con
// Gemini. Esta función se usa tanto para el historial como para pegar el
// mensaje actual al final, así la conversación entera siempre alterna.
function armarConversacion(historial, mensajeActual) {
  const mensajeLimpio = String(mensajeActual ?? "").trim();
  if (!mensajeLimpio) throw new Error("el mensaje llegó vacío (bug — revisar quién llama a esta función).");

  const turnos = [...normalizarHistorial(historial).slice(-6), { role: "user", content: mensajeLimpio }];

  const fusionado = [];
  for (const t of turnos) {
    const ultimo = fusionado[fusionado.length - 1];
    if (ultimo && ultimo.role === t.role) {
      ultimo.content += "\n" + t.content;
    } else {
      fusionado.push({ ...t });
    }
  }
  return fusionado;
}

// ================================================================
// LISTAS DE MODELOS CON RESPALDO ("self-healing"):
// Antes había UN SOLO nombre de modelo hardcodeado por proveedor. Si ese
// modelo específico se daba de baja (como pasó con gemini-1.5-flash), TODO
// el proveedor dejaba de funcionar hasta que alguien editara el código a
// mano. Ahora cada proveedor tiene una lista ordenada: se prueba el primero,
// y si ese en particular falla por "el modelo no existe" (404) se prueba
// automáticamente el siguiente de la lista, sin intervención humana. Si
// definís GROQ_MODEL o GEMINI_MODEL en Vercel, ese va PRIMERO en la lista
// (por si querés forzar uno en particular), pero los demás quedan como red
// de contención.
// ================================================================
// ------------------------------------------------------------------
// ACTUALIZADO 2026-09-01: Groq dio de baja "llama-3.3-70b-versatile" y
// "llama-3.1-8b-instant" el 16 de agosto de 2026 (anuncio oficial:
// console.groq.com/docs/deprecations). Google dio de baja "gemini-2.0-flash"
// el 1 de junio de 2026. Los tres estaban en las listas de respaldo de abajo
// — o sea que 3 de los 7 modelos que este código podía llegar a probar ya
// no existen, y cualquier pedido a ellos devuelve 404 ("el modelo no existe").
// Mientras el modelo PRINCIPAL de cada proveedor respondiera bien, esto no
// se notaba. Pero apenas ese modelo principal tuviera un tropiezo puntual,
// el "self-healing" caía directo en modelos muertos en vez de en un
// respaldo real. Reemplazados por los reemplazos oficiales recomendados por
// cada proveedor, verificados como activos a día de hoy (1 sept 2026).
// ------------------------------------------------------------------
const MODELOS_GROQ = [process.env.GROQ_MODEL, "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"].filter(Boolean);
const MODELOS_GEMINI = [process.env.GEMINI_MODEL, "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite"].filter(Boolean);

function categorizarStatusHttp(status, proveedor, modelo) {
  if (status === 401) return `401: ${proveedor}_API_KEY inválida o vencida`;
  if (status === 403) return `403: la clave no tiene permiso para usar "${modelo}" (revisá el plan/cuenta)`;
  if (status === 404) return `404: el modelo "${modelo}" no existe o fue dado de baja`;
  if (status === 400) return `400: pedido mal formado para "${modelo}" (puede ser un problema real de código, no de configuración)`;
  if (status === 413) return "413: el prompt es demasiado largo para el modelo";
  if (status === 429) return "429: límite de uso (rate limit/cuota) alcanzado";
  if (status >= 500) return `${status}: el servidor del proveedor tuvo un problema (no es culpa de este código)`;
  return `código ${status}`;
}

// ---------- Groq (rápido, gratis, modelos abiertos tipo OpenAI) ----------
async function preguntarGroq(systemPrompt, historial, mensaje) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY no configurada");

  let conversacion;
  try {
    conversacion = armarConversacion(historial, mensaje);
  } catch (e) {
    throw new Error(`Groq: ${e.message}`);
  }
  const messages = [{ role: "system", content: systemPrompt }, ...conversacion];

  const erroresPorModelo = [];

  for (const modelo of MODELOS_GROQ) {
    let resp;
    try {
      resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: modelo,
          messages,
          temperature: 0.4,
          // "openai/gpt-oss-120b" y modelos similares RAZONAN internamente
          // antes de responder ("chain of thought"), y ese razonamiento
          // se descuenta del mismo límite de tokens de la respuesta final.
          // "reasoning_effort: low" reduce cuánto "piensa" (este chatbot no
          // necesita razonamiento profundo) y dejamos margen alto por las dudas.
          max_completion_tokens: 2048,
          reasoning_effort: "low",
        }),
        signal: AbortSignal.timeout(4000),
      });
    } catch (errRed) {
      const motivo = errRed.name === "TimeoutError" || errRed.name === "AbortError"
        ? "timeout de 4s"
        : `no se pudo conectar (${errRed.message})`;
      erroresPorModelo.push(`${modelo}: ${motivo}`);
      continue; // probamos el siguiente modelo de la lista
    }

    if (!resp.ok) {
      const texto = await resp.text().catch(() => "");
      const categoria = categorizarStatusHttp(resp.status, "GROQ", modelo);
      erroresPorModelo.push(`${modelo} → ${categoria}. Respuesta: ${texto.slice(0, 200) || "(vacía)"}`);
      // Si es 404 (modelo dado de baja) o 400, probamos el siguiente modelo.
      // Si es 401/403/429, probar OTRO modelo con la MISMA clave no va a
      // arreglar nada — cortamos ahí para no perder tiempo del límite de Vercel.
      if ([401, 403, 429].includes(resp.status)) break;
      continue;
    }

    const data = await resp.json();
    const texto = data.choices?.[0]?.message?.content?.trim();
    if (!texto) {
      const motivoCorte = data.choices?.[0]?.finish_reason || "desconocido";
      erroresPorModelo.push(
        `${modelo}: respondió 200 pero sin texto (motivo de corte: "${motivoCorte}"` +
        (motivoCorte === "length" ? ", se quedó sin tokens" : "") + ")"
      );
      continue;
    }
    return texto; // ¡Funcionó! No hace falta probar más modelos.
  }

  throw new Error(`Groq — ningún modelo funcionó. Detalle por modelo: ${erroresPorModelo.join(" | ")}`);
}

// ---------- Google Gemini (respaldo si Groq falla) ----------
async function preguntarGemini(systemPrompt, historial, mensaje) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY no configurada");

  let conversacion;
  try {
    conversacion = armarConversacion(historial, mensaje);
  } catch (e) {
    throw new Error(`Gemini: ${e.message}`);
  }
  const contents = conversacion.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content }],
  }));

  const erroresPorModelo = [];

  for (const modelo of MODELOS_GEMINI) {
    let resp;
    try {
      resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 2048,
              thinkingConfig: { thinkingLevel: "low" },
            },
          }),
          signal: AbortSignal.timeout(4000),
        }
      );
    } catch (errRed) {
      const motivo = errRed.name === "TimeoutError" || errRed.name === "AbortError"
        ? "timeout de 4s"
        : `no se pudo conectar (${errRed.message})`;
      erroresPorModelo.push(`${modelo}: ${motivo}`);
      continue;
    }

    if (!resp.ok) {
      const texto = await resp.text().catch(() => "");
      const categoria = categorizarStatusHttp(resp.status, "GEMINI", modelo);
      erroresPorModelo.push(`${modelo} → ${categoria}. Respuesta: ${texto.slice(0, 200) || "(vacía)"}`);
      if ([401, 403, 429].includes(resp.status)) break;
      continue;
    }

    const data = await resp.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!texto) {
      const motivoCorte = data.candidates?.[0]?.finishReason || "desconocido";
      erroresPorModelo.push(`${modelo}: respondió 200 pero sin texto (motivo de corte: "${motivoCorte}")`);
      continue;
    }
    return texto;
  }

  throw new Error(`Gemini — ningún modelo funcionó. Detalle por modelo: ${erroresPorModelo.join(" | ")}`);
}

module.exports = { preguntarGroq, preguntarGemini, VERSION_IA, MODELOS_GROQ, MODELOS_GEMINI };

// ---------------------------------------------------------------
// Nota sobre los tiempos (4000ms por modelo, por proveedor):
// La función en Vercel tiene un límite de 10s (vercel.json → maxDuration).
// Ahora que cada proveedor puede probar varios modelos en fila, el peor
// caso teórico (todos los modelos de los dos proveedores fallan) podría
// superar los 10s si hay muchos modelos en la lista. Por eso las listas de
// arriba tienen como máximo 3-4 modelos cada una, y el bucle corta apenas
// aparece un error de credenciales/cuota (401/403/429) en vez de seguir
// probando modelos que van a fallar igual con la misma clave.
// ---------------------------------------------------------------
