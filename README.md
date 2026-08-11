# sistema-cma-api

Backend reemplazando las Cloud Functions de Firebase (que pedían el plan Blaze
con tarjeta). Corre gratis en Vercel usando el SDK de Firebase Admin — eso NO
requiere Blaze, solo Cloud Functions/Cloud Build lo requerían.

## Qué reemplaza

| Cloud Function (antes) | Endpoint nuevo (ahora) |
|---|---|
| `crearUsuario` | `POST /api/crear-usuario` |
| `resetUserPassword` | `POST /api/reset-password` |
| `eliminarUsuario` | `POST /api/eliminar-usuario` |
| `sincronizarRangoEnAuth` (trigger) | `POST /api/sincronizar-rango` (opcional, manual) |
| — (nuevo) | `POST /api/chat` — chat IA del tutor musical (Groq + Gemini como respaldo) |

## Paso 1 — Generar la Service Account Key

1. Andá a [Firebase Console](https://console.firebase.google.com) → tu proyecto `sistema-cma`.
2. Ícono de engranaje (arriba a la izquierda) → **Configuración del proyecto**.
3. Pestaña **Cuentas de servicio**.
4. Click en **Generar nueva clave privada**. Se descarga un `.json`.
5. **Nunca subas ese archivo a GitHub.** Lo vamos a pegar como variable de entorno en Vercel (paso 3).

## Paso 2 — Subir este proyecto a Vercel

1. Creá un repositorio nuevo en GitHub (por ejemplo `sistema-cma-api`) y subí **solo esta carpeta** (`sistema-cma-api/`), no el resto del sitio.
2. Andá a [vercel.com](https://vercel.com) → **Add New → Project** → importá ese repositorio.
3. Dejá la configuración por defecto (Vercel detecta las funciones en `/api` solo). Click en **Deploy**.
4. Cuando termine, Vercel te da una URL como `https://sistema-cma-api.vercel.app`. Guardala.

## Paso 3 — Cargar la Service Account Key como variable de entorno

1. En el proyecto de Vercel → **Settings → Environment Variables**.
2. Agregá una variable llamada `FIREBASE_SERVICE_ACCOUNT_KEY`.
3. Como valor, pegá el **contenido completo** del `.json` que descargaste en el Paso 1 (todo el JSON, en una sola línea está bien).
4. (Opcional pero recomendado) Agregá también `ALLOWED_ORIGIN` con el dominio de tu GitHub Pages, por ejemplo `https://tu-usuario.github.io` — así solo tu sitio puede llamar a esta API.
5. Volvé a **Deployments** y hacé **Redeploy** para que tome las variables nuevas.

## Paso 3.5 — Cargar las claves de IA (para el chat)

El chat usa **dos proveedores** (Groq primero, Gemini como respaldo automático si Groq falla). Agregá estas dos variables de entorno igual que en el Paso 3:

- `GROQ_API_KEY` — la sacás gratis en [console.groq.com](https://console.groq.com) → API Keys.
- `GEMINI_API_KEY` — la sacás gratis en [aistudio.google.com](https://aistudio.google.com) → Get API Key.

> ⚠️ **Importante**: si en algún momento pegaste una clave de estas en un chat, documento
> compartido, o cualquier lugar que no sea directamente el campo de Vercel, **revocá esa
> clave y generá una nueva** antes de usarla acá. Una clave que estuvo en texto plano en
> otro lugar debe considerarse comprometida, aunque el lugar donde se escribió parezca
> privado.

Ninguna de las dos requiere tarjeta para el uso gratuito normal de este sitio.

## Paso 4 — Probar que responde

Abrí en el navegador: `https://sistema-cma-api.vercel.app/api/crear-usuario`
Debería darte un error `405 Método no permitido` (eso es bueno — significa que el endpoint existe y solo acepta POST, no GET).

## Paso 5 — Conectar el frontend

En `Sistema-Prueba-main/backend-api.js`, cambiá la constante `API_BASE_URL` por
la URL real que te dio Vercel. Ese archivo ya está enlazado desde `auth.js` y
`miembros.html` — no hace falta tocar nada más ahí.

## Notas de seguridad

- Cada endpoint verifica el token de Firebase del usuario que llama
  (`Authorization: Bearer <idToken>`), igual que hacía `context.auth` en
  Cloud Functions. Nadie puede llamar a estos endpoints sin haber iniciado
  sesión en el sitio.
- La jerarquía de permisos (quién puede crear/borrar/resetear a quién) está
  copiada 1:1 de las Cloud Functions originales.
- Podés borrar por completo la carpeta `functions/` del proyecto principal
  cuando confirmes que todo funciona — ya no se usa.
