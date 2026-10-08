const getAdmin = require("../_lib/firebaseAdmin");
const {
  JERARQUIA, EMAIL_RE, handleCorsAndMethod, getCallerOrThrow,
  generarClave, limpiarTexto, sendError, verificarLimiteDeUso,
} = require("../_lib/helpers");

const ESTADOS = [
  "Amazonas", "Anzoátegui", "Apure", "Aragua", "Barinas", "Bolívar", "Carabobo",
  "Cojedes", "Delta Amacuro", "Distrito Capital", "Falcón", "Guárico", "Lara",
  "Mérida", "Miranda", "Monagas", "Nueva Esparta", "Portuguesa", "Sucre",
  "Táchira", "Trujillo", "La Guaira", "Yaracuy", "Zulia",
];

// v4.0 — cambios de seguridad respecto a v3:
//  · La contraseña ya NO la manda el navegador: se genera acá con crypto.randomInt
//    y se devuelve UNA sola vez en la respuesta.
//  · Se validan formato de correo, largos de texto, edad y que estado/núcleo
//    existan de verdad (antes se aceptaba cualquier texto).
//  · La ubicación se normaliza según el rango (un director nacional no tiene
//    núcleo; un profesor SIEMPRE debe tenerlo) para no crear usuarios huérfanos.
//  · Si falla guardar el perfil en Firestore, se borra la cuenta de Auth que se
//    acababa de crear (antes quedaba una cuenta "fantasma" sin perfil).
//  · Nuevo campo opcional `instrumento`.
module.exports = async (req, res) => {
  if (handleCorsAndMethod(req, res)) return;

  try {
    const { uid: callerUid, perfil: caller } = await getCallerOrThrow(req);
    await verificarLimiteDeUso(`crear_${callerUid}`, { maxPedidos: 60, ventanaMs: 10 * 60 * 1000 });

    const body = req.body || {};
    const email = limpiarTexto(body.email, 160).toLowerCase();
    const nombre = limpiarTexto(body.nombre, 80);
    const rango = limpiarTexto(body.rango, 30);
    const agrupacion = limpiarTexto(body.agrupacion, 80);
    const instrumento = limpiarTexto(body.instrumento, 60);
    let estado = limpiarTexto(body.estado, 40);
    let nucleo = limpiarTexto(body.nucleo, 80);
    const edad = Number.isFinite(Number(body.edad)) ? Math.max(0, Math.min(120, Math.trunc(Number(body.edad)))) : 0;

    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "El correo no tiene un formato válido." });
    if (nombre.length < 2) return res.status(400).json({ error: "Escribí el nombre completo." });
    if (!JERARQUIA[rango]) return res.status(400).json({ error: "Rol inválido." });

    const nivelSolicitante = JERARQUIA[caller.rango] || 0;
    const nivelObjetivo = JERARQUIA[rango];
    if (caller.rango !== "owner_supremo" && nivelSolicitante <= nivelObjetivo) {
      return res.status(403).json({ error: "No podés crear un usuario con un rango igual o superior al tuyo." });
    }
    if (nivelSolicitante < JERARQUIA.admin) {
      return res.status(403).json({ error: "Tu rango no permite crear usuarios." });
    }

    // ---- Ubicación según el rango del nuevo usuario ----
    if (nivelObjetivo >= JERARQUIA.director_nacional) { estado = ""; nucleo = ""; }
    else if (nivelObjetivo === JERARQUIA.director_regional) { nucleo = ""; }

    if (nivelObjetivo <= JERARQUIA.director_regional) {
      if (!ESTADOS.includes(estado)) return res.status(400).json({ error: "Elegí un estado válido." });
    }
    if (nivelObjetivo <= JERARQUIA.director_nucleo) {
      if (!nucleo) return res.status(400).json({ error: "Elegí el núcleo." });
      const nSnap = await getAdmin().firestore().collection("nucleos")
        .where("nombre", "==", nucleo).where("estado", "==", estado).limit(1).get();
      if (nSnap.empty) return res.status(400).json({ error: `El núcleo "${nucleo}" no existe en ${estado}.` });
    }

    // ---- Alcance geográfico de quien crea ----
    if (caller.rango === "director_regional" && nivelObjetivo <= JERARQUIA.director_regional && estado !== caller.estado) {
      return res.status(403).json({ error: "Solo podés crear usuarios en tu estado." });
    }
    if ((caller.rango === "director_nucleo" || caller.rango === "admin") && nucleo !== caller.nucleo) {
      return res.status(403).json({ error: "Solo podés crear usuarios en tu núcleo." });
    }

    // ---- Agrupación (si se indicó, tiene que existir en ESE núcleo) ----
    if (agrupacion) {
      const aSnap = await getAdmin().firestore().collection("agrupaciones")
        .where("nucleo", "==", nucleo).where("nombre", "==", agrupacion).limit(1).get();
      if (aSnap.empty) return res.status(400).json({ error: `La agrupación "${agrupacion}" no existe en ese núcleo.` });
    }

    // ---- Crear en Auth + perfil, con rollback si algo falla ----
    const clave = generarClave();
    let userRecord;
    try {
      userRecord = await getAdmin().auth().createUser({ email, password: clave, displayName: nombre });
    } catch (error) {
      const yaExiste = error.code === "auth/email-already-exists";
      return res.status(yaExiste ? 409 : 500).json({
        error: yaExiste ? "Ese correo ya tiene una cuenta." : "Error al crear usuario en Auth: " + error.message,
      });
    }

    try {
      await getAdmin().firestore().collection("usuarios").doc(userRecord.uid).set({
        username: email, email, nombre, rango, agrupacion, instrumento, estado, nucleo,
        isOnline: false, currentSessionId: "", cuentaActiva: true, edad,
        fechaCreacion: new Date().toISOString(), creadoPor: callerUid,
      });
    } catch (errPerfil) {
      await getAdmin().auth().deleteUser(userRecord.uid).catch(() => {});
      throw errPerfil;
    }

    res.status(200).json({ success: true, uid: userRecord.uid, clave });
  } catch (err) {
    sendError(res, err);
  }
};
