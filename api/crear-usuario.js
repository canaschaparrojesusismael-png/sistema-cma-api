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
    const { email, password, nombre, rango, agrupacion, estado, nucleo, edad } = req.body || {};

    if (!email || !password || !nombre || !rango) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const callerDoc = await admin.firestore().collection("usuarios").doc(callerUid).get();
    if (!callerDoc.exists) return res.status(404).json({ error: "Solicitante no encontrado." });
    const callerRango = callerDoc.data().rango;
    const callerEstado = callerDoc.data().estado;
    const callerNucleo = callerDoc.data().nucleo;

    const nivelSolicitante = JERARQUIA[callerRango] || 0;
    const nivelObjetivo = JERARQUIA[rango] || 0;

    if (nivelSolicitante <= nivelObjetivo && callerRango !== "owner_supremo") {
      return res.status(403).json({ error: "No puedes crear un usuario con un rango igual o superior al tuyo." });
    }
    if (callerRango === "director_regional" && estado !== callerEstado) {
      return res.status(403).json({ error: "Solo puedes crear usuarios en tu estado." });
    }
    if ((callerRango === "director_nucleo" || callerRango === "admin") && nucleo !== callerNucleo) {
      return res.status(403).json({ error: "Solo puedes crear usuarios en tu núcleo." });
    }

    let userRecord;
    try {
      userRecord = await admin.auth().createUser({ email, password, displayName: nombre });
    } catch (error) {
      return res.status(500).json({ error: "Error al crear usuario en Auth: " + error.message });
    }

    await admin.firestore().collection("usuarios").doc(userRecord.uid).set({
      username: email,
      nombre,
      rango,
      agrupacion: agrupacion || "",
      estado: estado || "",
      nucleo: nucleo || "",
      email,
      isOnline: false,
      currentSessionId: "",
      requiresPasswordChange: true,
      cuentaActiva: true,
      edad: edad || 0,
      fechaCreacion: new Date().toISOString(),
    });

    res.status(200).json({ success: true, uid: userRecord.uid });
  } catch (err) {
    sendError(res, err);
  }
};
