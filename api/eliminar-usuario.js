const admin = require("../_lib/firebaseAdmin");
const { handleCorsAndMethod, getCallerUidOrThrow, sendError } = require("../_lib/helpers");

const JERARQUIA = {
  owner_supremo: 70,
  director_nacional: 60,
  director_regional: 50,
  director_nucleo: 40,
  admin: 30,
  profesor: 20,
  estudiante: 10,
};

module.exports = async (req, res) => {
  if (handleCorsAndMethod(req, res)) return;

  try {
    const callerUid = await getCallerUidOrThrow(req);
    const { targetUid } = req.body || {};
    if (!targetUid) return res.status(400).json({ error: "Se requiere targetUid." });
    if (targetUid === callerUid) {
      return res.status(400).json({ error: "No podés eliminar tu propia cuenta desde aquí." });
    }

    const callerDoc = await admin.firestore().collection("usuarios").doc(callerUid).get();
    if (!callerDoc.exists) return res.status(404).json({ error: "Solicitante no encontrado." });
    const caller = callerDoc.data();

    const targetDoc = await admin.firestore().collection("usuarios").doc(targetUid).get();
    if (!targetDoc.exists) return res.status(404).json({ error: "Usuario objetivo no encontrado." });
    const target = targetDoc.data();

    const nivelCaller = JERARQUIA[caller.rango] || 0;
    const nivelTarget = JERARQUIA[target.rango] || 0;

    let autorizado = false;
    if (caller.rango === "owner_supremo") autorizado = true;
    else if (caller.rango === "director_nacional" && nivelTarget < nivelCaller) autorizado = true;
    else if (caller.rango === "director_regional" && target.estado === caller.estado && nivelTarget < nivelCaller) autorizado = true;
    else if ((caller.rango === "director_nucleo" || caller.rango === "admin") && target.nucleo === caller.nucleo && nivelTarget < nivelCaller) autorizado = true;

    if (!autorizado) return res.status(403).json({ error: "No tenés permiso para eliminar a este usuario." });

    try {
      await admin.auth().deleteUser(targetUid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        return res.status(500).json({ error: "Error al borrar de Authentication: " + error.message });
      }
    }
    await admin.firestore().collection("usuarios").doc(targetUid).delete();

    res.status(200).json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
};
