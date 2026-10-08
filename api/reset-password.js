const getAdmin = require("../_lib/firebaseAdmin");
const { handleCorsAndMethod, getCallerOrThrow, generarClave, sendError, verificarLimiteDeUso } = require("../_lib/helpers");

// v4.0: la contraseña nueva ya no viene del navegador (antes se generaba con
// Math.random y viajaba en el pedido): se genera acá con CSPRNG y se devuelve
// una sola vez. Además se REVOCAN las sesiones abiertas de esa cuenta, así la
// clave vieja deja de servir al instante en cualquier dispositivo.
module.exports = async (req, res) => {
  if (handleCorsAndMethod(req, res)) return;

  try {
    const { uid: callerUid, perfil: caller } = await getCallerOrThrow(req);
    if (caller.rango !== "owner_supremo") {
      return res.status(403).json({ error: "Únicamente el Owner Supremo puede restablecer contraseñas." });
    }
    await verificarLimiteDeUso(`reset_${callerUid}`, { maxPedidos: 30, ventanaMs: 10 * 60 * 1000 });

    const { targetUid } = req.body || {};
    if (!targetUid || typeof targetUid !== "string") return res.status(400).json({ error: "Se requiere targetUid." });

    const targetDoc = await getAdmin().firestore().collection("usuarios").doc(targetUid).get();
    if (!targetDoc.exists) return res.status(404).json({ error: "Usuario no encontrado." });
    if (targetDoc.data().rango === "owner_supremo" && targetUid !== callerUid) {
      return res.status(403).json({ error: "No podés restablecer la contraseña de otro Owner Supremo." });
    }

    const clave = generarClave();
    await getAdmin().auth().updateUser(targetUid, { password: clave });
    await getAdmin().auth().revokeRefreshTokens(targetUid);
    await getAdmin().firestore().collection("usuarios").doc(targetUid).update({ currentSessionId: "", isOnline: false });

    res.status(200).json({ success: true, clave });
  } catch (err) {
    sendError(res, err);
  }
};
