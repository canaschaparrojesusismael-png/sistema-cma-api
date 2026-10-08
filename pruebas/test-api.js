const path = require("path"), API = path.join(__dirname, "..");
process.env.ALLOWED_ORIGIN = "https://escuela.github.io,https://otro.ve";
const log = []; let fallos = 0;
const ok = (c, m) => { console.log((c ? "OK    " : "FALLA ") + m); if (!c) fallos++; };
// ---- Firebase Admin simulado ----
const usuarios = {
  u_owner: { rango: "owner_supremo", cuentaActiva: true }, u_nac: { rango: "director_nacional", cuentaActiva: true },
  u_dn: { rango: "director_nucleo", estado: "Táchira", nucleo: "Puente Real", cuentaActiva: true },
  u_adm: { rango: "admin", estado: "Táchira", nucleo: "Puente Real", cuentaActiva: true },
  u_est: { rango: "estudiante", estado: "Táchira", nucleo: "Puente Real", cuentaActiva: true },
  u_old: { rango: "director_nucleo", nucleo: "X", cuentaActiva: false },
};
const nucleos = [{ nombre: "Puente Real", estado: "Táchira" }, { nombre: "Teatro", estado: "Táchira" }];
const agrups = [{ nombre: "Coro", nucleo: "Puente Real" }];
const E = { creados: [], borrados: [], actualizados: [], revocados: [], falloSet: false };
const consulta = (lista) => { const f = []; const q = { where: (k, o, v) => { f.push([k, v]); return q; }, limit: () => q, get: async () => { const r = lista.filter((x) => f.every(([k, v]) => x[k] === v)); return { empty: !r.length, size: r.length, docs: r.map((d) => ({ data: () => d })) }; } }; return q; };
const admin = {
  auth: () => ({
    verifyIdToken: async (t, revisar) => { E.revisaRevocacion = revisar; return { uid: t }; },
    createUser: async (d) => { if (d.email === "dup@t.ve") { const e = new Error("dup"); e.code = "auth/email-already-exists"; throw e; } E.creados.push(d); return { uid: "nuevo1" }; },
    deleteUser: async (u) => E.borrados.push(u), updateUser: async (u, d) => E.actualizados.push([u, d]), revokeRefreshTokens: async (u) => E.revocados.push(u),
  }),
  firestore: () => ({
    collection: (n) => n === "nucleos" ? consulta(nucleos) : n === "agrupaciones" ? consulta(agrups) : {
      doc: (id) => ({
        get: async () => ({ exists: !!usuarios[id], data: () => usuarios[id] }),
        set: async (d) => { if (E.falloSet) throw new Error("Firestore caído"); usuarios[id] = d; E.docNuevo = d; },
        update: async (d) => Object.assign(usuarios[id], d), delete: async () => delete usuarios[id],
      }),
    },
  }),
};
const fa = path.join(API, "_lib/firebaseAdmin.js");
require.cache[require.resolve(fa)] = { id: fa, filename: fa, loaded: true, exports: () => admin };
const H = require(path.join(API, "_lib/helpers.js")); H.verificarLimiteDeUso = async () => {};
const crear = require(path.join(API, "api/crear-usuario.js")), estado = require(path.join(API, "api/estado-cuenta.js")),
  eliminar = require(path.join(API, "api/eliminar-usuario.js")), reset = require(path.join(API, "api/reset-password.js"));
const call = async (fn, uid, body, origin = "https://escuela.github.io") => {
  const res = { h: {}, code: 200, body: null, setHeader(k, v) { this.h[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await fn({ method: "POST", headers: { authorization: "Bearer " + uid, origin }, body }, res); return res;
};
(async () => {
  let r = await call(crear, "u_adm", { email: "ana@t.ve", nombre: "Ana Test", rango: "estudiante", estado: "Táchira", nucleo: "Puente Real", agrupacion: "Coro", instrumento: "Flauta", edad: 12, password: "LA_QUE_MANDA_EL_CLIENTE" });
  ok(r.code === 200 && r.body.clave && r.body.clave.length >= 12, `admin crea estudiante → 200 y el servidor devuelve la clave (${r.body.clave})`);
  ok(E.creados[0].password === r.body.clave && E.creados[0].password !== "LA_QUE_MANDA_EL_CLIENTE", "la contraseña de la cuenta es la del servidor (se ignora la que manda el navegador)");
  ok(E.docNuevo.instrumento === "Flauta" && !("requiresPasswordChange" in E.docNuevo), "se guarda el instrumento y ya NO existe requiresPasswordChange");
  ok(E.revisaRevocacion === true, "verifyIdToken revisa tokens revocados");
  ok((await call(crear, "u_adm", { email: "d@t.ve", nombre: "Dir Nuevo", rango: "director_nucleo", estado: "Táchira", nucleo: "Puente Real" })).code === 403, "admin NO puede crear un director de núcleo (rango superior) → 403");
  ok((await call(crear, "u_adm", { email: "no-es-correo", nombre: "Xx", rango: "estudiante", estado: "Táchira", nucleo: "Puente Real" })).code === 400, "correo con formato inválido → 400");
  ok((await call(crear, "u_adm", { email: "a@t.ve", nombre: "Xx", rango: "estudiante", estado: "Táchira", nucleo: "Inventado" })).code === 400, "núcleo que no existe → 400");
  ok((await call(crear, "u_adm", { email: "a@t.ve", nombre: "Xx", rango: "estudiante", estado: "Táchira", nucleo: "Teatro" })).code === 403, "admin no puede crear en OTRO núcleo → 403");
  ok((await call(crear, "u_adm", { email: "a@t.ve", nombre: "Xx", rango: "estudiante", estado: "Táchira", nucleo: "Puente Real", agrupacion: "Fantasma" })).code === 400, "agrupación inexistente en ese núcleo → 400");
  ok((await call(crear, "u_adm", { email: "dup@t.ve", nombre: "Xx", rango: "estudiante", estado: "Táchira", nucleo: "Puente Real" })).code === 409, "correo repetido → 409");
  ok((await call(crear, "u_old", { email: "z@t.ve", nombre: "Xx", rango: "estudiante" })).code === 403, "cuenta desactivada no puede usar la API → 403");
  E.falloSet = true; const nBorr = E.borrados.length;
  r = await call(crear, "u_adm", { email: "roll@t.ve", nombre: "Roll Back", rango: "estudiante", estado: "Táchira", nucleo: "Puente Real" }); E.falloSet = false;
  ok(r.code >= 500 && E.borrados.length === nBorr + 1, "si falla guardar el perfil, se BORRA la cuenta recién creada (sin cuentas huérfanas)");
  r = await call(estado, "u_dn", { targetUid: "u_est", activa: false });
  ok(r.code === 200 && E.actualizados.some(([u, d]) => u === "u_est" && d.disabled === true) && E.revocados.includes("u_est") && usuarios.u_est.cuentaActiva === false, "desactivar = deshabilita en Auth + revoca sesiones + marca el perfil");
  ok((await call(estado, "u_dn", { targetUid: "u_owner", activa: false })).code === 403, "director de núcleo no puede desactivar al Owner → 403");
  ok((await call(eliminar, "u_nac", { targetUid: "u_owner" })).code === 403, "director nacional no puede eliminar al Owner → 403");
  ok((await call(reset, "u_dn", { targetUid: "u_adm" })).code === 403, "solo el Owner restablece contraseñas → 403 para los demás");
  r = await call(reset, "u_owner", { targetUid: "u_adm" });
  ok(r.code === 200 && r.body.clave && E.revocados.includes("u_adm"), "Owner restablece: clave generada en el servidor + sesiones revocadas");
  const claves = new Set(); let bien = true; for (let i = 0; i < 2000; i++) { const c = H.generarClave(); claves.add(c); if (c.length !== 14 || /[0OlI1]/.test(c) || !/[A-Z]/.test(c) || !/[a-z]/.test(c) || !/\d/.test(c) || !/[!@#$%&*?]/.test(c)) bien = false; }
  ok(bien && claves.size === 2000, "generarClave: 14 caracteres, sin ambiguos, con mayús/minús/número/símbolo, 2000 únicas");
  r = await call(estado, "u_dn", { targetUid: "u_est", activa: true }, "https://escuela.github.io"); ok(r.h["Access-Control-Allow-Origin"] === "https://escuela.github.io", "CORS: responde al origen permitido");
  r = await call(estado, "u_dn", { targetUid: "u_est", activa: true }, "https://malo.com"); ok(!r.h["Access-Control-Allow-Origin"], "CORS: NO responde a un origen no permitido");
  console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTODO OK"); process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error("ERROR DE PRUEBA", e); process.exit(2); });
