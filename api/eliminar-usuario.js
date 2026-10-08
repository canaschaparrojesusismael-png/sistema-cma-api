const getAdmin = require("../_lib/firebaseAdmin");
const { JERARQUIA, handleCorsAndMethod, getCallerOrThrow, sendError, verificarLimiteDeUso } = require("../_lib/helpers");

module.exports = async (req, res) => {
  if (handleCorsAndMethod(req, res)) return;

  try {
    const { uid: callerUid, perfil: caller } = await getCallerOrThrow(req);
    await verificarLimiteDeUso(`eliminar_${callerUid}`, { maxPedidos: 40, ventanaMs: 10 * 60 * 1000 });

    const { targetUid } = req.body || {};
    if (!targetUid || typeof targetUid !== "string") return res.status(400).json({ error: "Se requiere targetUid." });
    if (targetUid === callerUid) return res.status(400).json({ error: "No podés eliminar tu propia cuenta desde acá." });

    const targetDoc = await getAdmin().firestore().collection("usuarios").doc(targetUid).get();
    if (!targetDoc.exists) return res.status(404).json({ error: "Usuario no encontrado." });
    const target = targetDoc.data();

    // v4.0: un Owner Supremo no se elimina desde la interfaz (evita quedarse sin
    // ninguno por error o por una cuenta comprometida). Si hace falta, se borra
    // a mano desde Firebase Console.
    if (target.rango === "owner_supremo") {
      return res.status(403).json({ error: "Una cuenta de Owner Supremo no se puede eliminar desde el sitio." });
    }

    const nivelCaller = JERARQUIA[caller.rango] || 0;
    const nivelTarget = JERARQUIA[target.rango] || 0;

    let autorizado = false;
    if (caller.rango === "owner_supremo") autorizado = true;
    else if (caller.rango === "director_nacional") autorizado = nivelTarget < nivelCaller;
    else if (caller.rango === "director_regional") autorizado = target.estado === caller.estado && nivelTarget < nivelCaller;
    else if (caller.rango === "director_nucleo" || caller.rango === "admin") autorizado = target.nucleo === caller.nucleo && nivelTarget < nivelCaller;

    if (!autorizado) return res.status(403).json({ error: "No tenés permiso para eliminar a este usuario." });

    try {
      await getAdmin().auth().deleteUser(targetUid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        return res.status(500).json({ error: "Error al borrar de Authentication: " + error.message });
      }
    }
    await getAdmin().firestore().collection("usuarios").doc(targetUid).delete();
    res.status(200).json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
};
