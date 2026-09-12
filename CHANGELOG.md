# Changelog — Backend (API del Sistema de Orquestas)

> v3.0 (P-61): resumen por versión de los cambios de este repo. Los códigos
> entre paréntesis referencian el plan maestro v3.0.

## v3.0 — 2026-09

### ⚠️ El motor de IA no se tocó
`_lib/proveedoresIA.js` (prompts base de Groq/Gemini, `VERSION_IA`, listas de
modelos con respaldo) sigue **byte por byte idéntico** al de la versión
anterior — se puede confirmar con `md5sum` contra el zip previo. Todo lo
nuevo se agregó en archivos/funciones aparte, nunca editando ese motor.

### `api/chat.js`
- **(G-24, G-25)** Nueva función `construirContextoAdicional()`, completamente
  separada de `construirContexto()` (Formación, sin tocar). Amplía lo que el
  Tutor Musical puede citar: piezas del repertorio (con instrumentos/
  partituras cargadas) y próximos eventos del calendario, cada uno con su
  propia "ubicación" para citar (`Piezas → [Agrupación] → [Pieza]`,
  `Panel → Calendario`).
- Ambos contextos (Formación + el nuevo) se piden en **paralelo** con
  `Promise.allSettled`, no en serie — el presupuesto de tiempo total no
  cambia respecto a la versión anterior, y si el contexto nuevo falla por
  cualquier motivo, el chat sigue funcionando exactamente igual que antes
  (con Formación solamente). Ver comentarios en el archivo para el detalle.
- `SYSTEM_PROMPT_BASE`: se extendió la regla #3 (ya existente, sobre cómo
  citar Formación) para que también sepa citar Piezas/Eventos con el
  formato de arriba. El resto del prompt (reglas 1, 2, 4, 5) no cambió.

### `api/diagnostico.js`
- **(P-59)** Cabecera `Cache-Control: no-store` explícita, además de la
  caché propia de 30s que ya tenía en Firestore — evita que un proxy/CDN
  intermedio guarde una respuesta vieja por su cuenta.

### `_lib/helpers.js`
- **(P-60)** `getCallerUidOrThrow` ahora también adjunta una `categoria`
  programática al error (`sin_token` / `token_invalido` / `config_servidor`),
  siguiendo el mismo patrón que ya tenía el error de límite de uso
  (`limite_de_uso_excedido`). `sendError` la incluye en la respuesta JSON
  cuando está presente. **No cambia ningún status code ni mensaje
  existente** — es un campo adicional para quien quiera reaccionar distinto
  en el frontend más adelante.
- Confirmado: la distinción 401 (no autenticado) vs 403 (autenticado pero
  sin permiso) ya estaba bien hecha en `reset-password.js` y
  `eliminar-usuario.js` — no hizo falta tocar esos archivos.

### `firestore.rules` (vive en el repo del frontend, documentado acá porque
lo usa este backend)
- **(P-58)** Reglas explícitas de denegación para `_limites_uso` y `_meta`
  (antes denegadas solo "por defecto" al no estar declaradas).
- **(G-07)** Regla nueva para `contenido/{docId}` (citas editables de la
  portada), mismo criterio de permisos que `carrusel/{docId}`.

## Pendiente — requiere una acción tuya, no se puede hacer desde código

- **(G-36)** Política de TTL sobre `_limites_uso` en Firebase Console
  (Firestore → Índices → TTL, campo `expira`) — ya estaba anotado como
  pendiente en el propio `helpers.js` desde antes de esta ronda.
- **(G-37)** `ALLOWED_ORIGIN`: hoy sigue en `"*"` por defecto. Antes de
  lanzar la v3.0 en serio, poné el dominio real de producción como variable
  de entorno en Vercel (`ALLOWED_ORIGIN=https://tu-dominio-real`).

## v3.1 — 2026-09

### `api/chat.js` — un solo agregado al `SYSTEM_PROMPT_BASE`
Se reportó que, ante una pregunta biográfica/histórica puntual (ej. "quién
es José Antonio Abreu"), el Tutor Musical contestaba con seguridad algunos
detalles que no eran del material del sitio y no eran correctos. Eso lo
permite la regla #4 (ya existente: contestar con conocimiento general
cuando no está en Formación), que sigue igual — el problema no era la
regla en sí, sino que no había ninguna instrucción sobre qué hacer cuando
el modelo no está seguro de un dato puntual.

Se agregó la regla #6, aclarando que para datos biográficos/históricos
específicos que no estén en el material del sitio, conteste solo con lo
que sepa con alta confianza, y que diga explícitamente cuando no está
seguro de un detalle en vez de inventarlo con tono seguro. Es la única
línea que cambió en todo el backend — nada de `_lib/proveedoresIA.js`
(motor de Groq/Gemini, selección de modelo, reintentos) se tocó, y las
reglas 1, 2, 3, 4 y 5 quedaron exactamente iguales.

**Esto no es una garantía absoluta.** Ningún ajuste de prompt elimina el
100% de las alucinaciones de un modelo de lenguaje — lo que hace es
reducir bastante la frecuencia de este patrón puntual (inventar un detalle
específico con tono seguro). Si sigue pasando con la misma pregunta,
avisá — puede necesitar una vuelta más de ajuste, o directamente sumar ese
dato a Formación para que la IA lo cite del material oficial en vez de su
conocimiento general.

## v2.x y anteriores
Ver comentarios `CORREGIDO`/`AGREGADO` fechados dentro de cada archivo.
