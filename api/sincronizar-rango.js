const getAdmin = require("../_lib/firebaseAdmin");
const { handleCorsAndMethod, getCallerUidOrThrow, sendError } = require("../_lib/helpers");

// OPCIONAL: el trigger original (sincronizarRangoEnAuth) se disparaba solo
// cada vez que cambiaba un documento en /usuarios. Como Vercel no puede
// "escuchar" Firestore, este endpoint hace lo mismo pero hay que llamarlo
// a mano después de crear/editar un usuario (ver comentario en el README).
// HOY el sistema no usa custom claims en ningún lado (las reglas de Firestore
// leen el rango directo del documento), así que esto es un extra por si en
// el futuro lo necesitás para reglas más rápidas o para el frontend.
module.exports = async (req, res) => {
  if (handleCorsAndMethod(req, res)) return;

  try {
    const callerUid = await getCallerUidOrThrow(req);
    const { targetUid } = req.body || {};
    if (!targetUid) return res.status(400).json({ error: "Se requiere targetUid." });

    const callerDoc = await getAdmin().firestore().collection("usuarios").doc(callerUid).get();
    if (!callerDoc.exists || !["owner_supremo", "director_nacional"].includes(callerDoc.data().rango)) {
      return res.status(403).json({ error: "No tenés permiso para sincronizar rangos." });
    }

    const targetDoc = await getAdmin().firestore().collection("usuarios").doc(targetUid).get();
    if (!targetDoc.exists) {
      await getAdmin().auth().setCustomUserClaims(targetUid, null);
      return res.status(200).json({ success: true, cleared: true });
    }

    await getAdmin().auth().setCustomUserClaims(targetUid, { rango: targetDoc.data().rango });
    res.status(200).json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
};
