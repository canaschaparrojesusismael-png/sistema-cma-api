const admin = require("../_lib/firebaseAdmin");
const { handleCorsAndMethod, getCallerUidOrThrow, sendError } = require("../_lib/helpers");

module.exports = async (req, res) => {
  if (handleCorsAndMethod(req, res)) return;

  try {
    const callerUid = await getCallerUidOrThrow(req);
    const { targetUid, newPassword } = req.body || {};
    if (!targetUid || !newPassword) {
      return res.status(400).json({ error: "Se requiere targetUid y newPassword." });
    }

    const callerDoc = await admin.firestore().collection("usuarios").doc(callerUid).get();
    if (!callerDoc.exists || callerDoc.data().rango !== "owner_supremo") {
      return res.status(403).json({ error: "Únicamente el Owner Supremo puede resetear contraseñas." });
    }

    const targetDoc = await admin.firestore().collection("usuarios").doc(targetUid).get();
    if (targetDoc.exists && targetDoc.data().rango === "owner_supremo" && targetUid !== callerUid) {
      return res.status(403).json({ error: "No puedes resetear la contraseña de otro Owner Supremo." });
    }

    await admin.auth().updateUser(targetUid, { password: newPassword });
    await admin.firestore().collection("usuarios").doc(targetUid).update({ requiresPasswordChange: true });

    res.status(200).json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
};
