const getAdmin = require("../_lib/firebaseAdmin");
const { JERARQUIA, handleCorsAndMethod, getCallerOrThrow, sendError, verificarLimiteDeUso } = require("../_lib/helpers");

// NUEVO en v4.0 — activar / desactivar una cuenta DE VERDAD.
// Antes "Desactivar" solo ponía cuentaActiva:false en Firestore: la cuenta de
// Authentication seguía habilitada y su token seguía válido hasta 1 hora.
// Ahora además se deshabilita el usuario en Auth y se revocan sus sesiones.
module.exports = async (req, res) => {
  if (handleCorsAndMethod(req, res)) return;

  try {
    const { uid: callerUid, perfil: caller } = await getCallerOrThrow(req);
    await verificarLimiteDeUso(`estado_${callerUid}`, { maxPedidos: 60, ventanaMs: 10 * 60 * 1000 });

    const { targetUid, activa } = req.body || {};
    if (!targetUid || typeof targetUid !== "string" || typeof activa !== "boolean") {
      return res.status(400).json({ error: "Se requiere targetUid y activa (true/false)." });
    }
    if (targetUid === callerUid) return res.status(400).json({ error: "No podés cambiar el estado de tu propia cuenta." });

    const targetDoc = await getAdmin().firestore().collection("usuarios").doc(targetUid).get();
    if (!targetDoc.exists) return res.status(404).json({ error: "Usuario no encontrado." });
    const target = targetDoc.data();

    const nivelCaller = JERARQUIA[caller.rango] || 0;
    const nivelTarget = JERARQUIA[target.rango] || 0;
    let autorizado = false;
    if (caller.rango === "owner_supremo") autorizado = true;
    else if (caller.rango === "director_nacional") autorizado = nivelTarget < nivelCaller;
    else if (caller.rango === "director_regional") autorizado = target.estado === caller.estado && nivelTarget < nivelCaller;
    else if (caller.rango === "director_nucleo" || caller.rango === "admin") autorizado = target.nucleo === caller.nucleo && nivelTarget < nivelCaller;
    if (!autorizado) return res.status(403).json({ error: "No tenés permiso sobre este usuario." });

    await getAdmin().auth().updateUser(targetUid, { disabled: !activa });
    if (!activa) await getAdmin().auth().revokeRefreshTokens(targetUid);
    await getAdmin().firestore().collection("usuarios").doc(targetUid).update(
      activa
        ? { cuentaActiva: true, fechaEliminacion: null }
        : { cuentaActiva: false, fechaEliminacion: new Date().toISOString(), isOnline: false, currentSessionId: "" }
    );
    res.status(200).json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
};
