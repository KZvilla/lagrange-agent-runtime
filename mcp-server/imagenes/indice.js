'use strict';

/**
 * FEAT-210 §4 — El índice privado de las imágenes de un alma.
 *
 * Lo público de cada imagen viaja en `turno.imagenes`; lo privado vive acá, un
 * archivo por imagen (`<alma>/imagenes/indice/<tareaId>-<n>.json`): el archivo,
 * la foto de origen, el hilo, si nació de algo de afuera, su `sha256` y lo que
 * vio la mirada. Ni el historial de la consola, ni `tarea(id)`, ni v2 ven
 * rutas. Cada escritura es leer-modificar-escribir bajo `conLock` (la cola y la
 * marca de entregada no se pisan).
 *
 * FEAT-213 — La lista de cada alma vive en memoria: `actualizar` y `borrar` la
 * mantienen al día, y un cambio hecho por fuera se ve por la fecha de la
 * carpeta. Toda ruta que sale del índice se usa solo si `rutaDentroDe` la deja
 * en su carpeta.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rutas = require('../almas/rutas.js');
const { conLock, escribirAtomico } = require('../almas/archivos.js');

const RE_TAREA = /^t_[a-z0-9]{4,40}$/;
/** El tope por defecto (`imagenes.tope_por_alma`). */
const TOPE_POR_ALMA = 500;

function validar(tareaId, n) {
  if (!RE_TAREA.test(String(tareaId)) || !Number.isInteger(n) || n < 1 || n > 99) throw new Error('imagen inválida');
}

const dirImagenes = (clave, env = process.env) => path.join(rutas.rutasDe(clave, env).dir, 'imagenes');
const dirIndice = (clave, env = process.env) => path.join(dirImagenes(clave, env), 'indice');
const dirTmp = (clave, env = process.env) => path.join(dirImagenes(clave, env), '.tmp');

function rutaIndice(clave, tareaId, n, env = process.env) {
  validar(tareaId, n);
  return path.join(dirIndice(clave, env), `${tareaId}-${n}.json`);
}

/** El nombre final de una imagen: `<tareaId>-<n>-<intento>.<ext>`. */
function rutaArchivo(clave, tareaId, n, intento, ext, env = process.env) {
  validar(tareaId, n);
  if (!Number.isInteger(intento) || intento < 1 || !/^(png|jpg|webp)$/.test(ext)) throw new Error('imagen inválida');
  return path.join(dirImagenes(clave, env), `${tareaId}-${n}-${intento}.${ext}`);
}

function leer(clave, tareaId, n, env = process.env) {
  try {
    const o = JSON.parse(fs.readFileSync(rutaIndice(clave, tareaId, n, env), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

// FEAT-213 — La lista por carpeta de índice: `{ fecha, porNombre, orden }`.
const listas = new Map();
const fechaDe = (dir) => { try { return fs.statSync(dir).mtimeMs; } catch { return null; } };

/** Lo que cambió una escritura de este proceso, en la lista ya leída. */
function anotarEnLista(clave, tareaId, n, entrada, env) {
  const dir = dirIndice(clave, env);
  const l = listas.get(dir);
  if (!l) return;
  const nombre = `${tareaId}-${n}.json`;
  if (entrada) l.porNombre.set(nombre, { ...entrada, tareaId, n });
  else l.porNombre.delete(nombre);
  l.orden = null;
  l.fecha = fechaDe(dir);
}

/**
 * Leer-modificar-escribir bajo el lock de ese archivo. `fn(previo)` devuelve lo nuevo (o `null` para no escribir).
 * `esperaMs: 0` no espera el lock (que duerme el proceso): lanza `ErrorLock` en el acto.
 */
function actualizar(clave, tareaId, n, fn, env = process.env, { esperaMs } = {}) {
  const ruta = rutaIndice(clave, tareaId, n, env);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  let escrito = null;
  const r = conLock(ruta, () => {
    const previo = leer(clave, tareaId, n, env);
    const nuevo = fn(previo);
    if (!nuevo) return previo;
    escribirAtomico(ruta, `${JSON.stringify({ ...nuevo, tareaId, n }, null, 2)}\n`);
    escrito = nuevo;
    return nuevo;
  }, esperaMs === undefined ? {} : { esperaMs });
  if (escrito) anotarEnLista(clave, tareaId, n, escrito, env);
  return r;
}

/**
 * FEAT-212 — Borra la entrada, bajo su lock y solo si sigue siendo la que se eligió (`sha256`, `envio` e `intento`): una
 * que un Reintento escribió en la misma `n` no se toca. No espera el lock; `false` si no se borró.
 * FEAT-213 — `alBorrar(entrada)` corre bajo el lock, antes de borrar el índice; `false` deja todo como estaba.
 */
function borrar(clave, tareaId, n, { sha256: sha, envio, intento, alBorrar = null, env = process.env } = {}) {
  const ruta = rutaIndice(clave, tareaId, n, env);
  let borrada = false;
  try {
    conLock(ruta, () => {
      const e = leer(clave, tareaId, n, env);
      if (e && ((sha !== undefined && (e.sha256 || null) !== (sha || null)) || (envio !== undefined && ((e.telegram && e.telegram.envio) || null) !== (envio || null)))) return;
      if (intento !== undefined && (!e || (e.intento || 1) !== intento)) return;
      if (alBorrar && alBorrar(e) === false) return;
      fs.rmSync(ruta, { force: true });
      borrada = true;
    }, { esperaMs: 0 });
  } catch {
    return false;
  }
  if (borrada) anotarEnLista(clave, tareaId, n, null, env);
  return borrada;
}

/** Todas las entradas de un alma, de la más vieja a la más nueva (por `creada`). */
function listar(clave, env = process.env) {
  const dir = dirIndice(clave, env);
  const fecha = fechaDe(dir);
  if (fecha === null) { listas.delete(dir); return []; }
  let l = listas.get(dir);
  if (!l || l.fecha !== fecha) {
    let nombres = [];
    try { nombres = fs.readdirSync(dir); } catch { return []; }
    l = { fecha, porNombre: new Map(), orden: null };
    for (const f of nombres) {
      const m = /^(t_[a-z0-9]{4,40})-(\d{1,2})\.json$/.exec(f);
      const e = m && leer(clave, m[1], Number(m[2]), env);
      if (e) l.porNombre.set(f, { ...e, tareaId: m[1], n: Number(m[2]) });
    }
    listas.set(dir, l);
  }
  if (!l.orden) {
    l.orden = [...l.porNombre.values()].sort((a, b) => {
      const x = String(a.creada || '');
      const y = String(b.creada || '');
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  return [...l.orden];
}

/** Las claves de las almas con carpeta. */
function claves(env = process.env) {
  try { return fs.readdirSync(rutas.dirAlmas(env)).filter((c) => rutas.CLAVE_VALIDA.test(c)); } catch { return []; }
}

/** FEAT-213 — `ruta` resuelta (`realpath`) si queda adentro de `base`; si no, `null`. Una que no existe se mira por su carpeta. */
function rutaDentroDe(base, ruta) {
  if (typeof ruta !== 'string' || !ruta || !path.isAbsolute(ruta)) return null;
  let raiz;
  try { raiz = fs.realpathSync.native(base); } catch { return null; }
  let real;
  try { real = fs.realpathSync.native(ruta); } catch {
    try { real = path.join(fs.realpathSync.native(path.dirname(ruta)), path.basename(ruta)); } catch { return null; }
  }
  const rel = path.relative(raiz, real);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? real : null;
}

/** El archivo de una entrada, si queda en la carpeta de imágenes de su alma. */
const archivoDe = (clave, e, env = process.env) => (e && e.archivo ? rutaDentroDe(dirImagenes(clave, env), e.archivo) : null);

/** Una foto de base: en la carpeta de adjuntos o en la de imágenes de alguna alma. Sin `dirAdjuntos`, no se mira. */
function fotoPermitida(ruta, { dirAdjuntos = null, env = process.env } = {}) {
  if (typeof ruta !== 'string' || !ruta) return null;
  if (!dirAdjuntos) return ruta;
  const r = rutaDentroDe(dirAdjuntos, ruta);
  if (r) return r;
  for (const clave of claves(env)) {
    const x = rutaDentroDe(dirImagenes(clave, env), ruta);
    if (x) return x;
  }
  return null;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** FEAT-213 — Solo `externo: false`, escrito, es de adentro: lo desconocido cuenta como externo. */
const esExterna = (e) => !e || e.externo !== false;

/** El mapa `sha256 → { clave, tareaId, n, externo }` de todas las almas (para reconocer una foto propia). */
function construirMapa(env = process.env) {
  const mapa = new Map();
  for (const clave of claves(env)) {
    for (const e of listar(clave, env)) if (e.sha256 && e.archivo) mapa.set(e.sha256, { clave, tareaId: e.tareaId, n: e.n, externo: esExterna(e) });
  }
  return mapa;
}

/** FEAT-212 §7 — El mapa del `sha256` del JPEG que devolvió Telegram → la imagen. */
function construirMapaTelegram(env = process.env) {
  const mapa = new Map();
  for (const clave of claves(env)) {
    for (const e of listar(clave, env)) {
      if (e.archivo && e.telegram && typeof e.telegram.sha256 === 'string') mapa.set(e.telegram.sha256, { clave, tareaId: e.tareaId, n: e.n, externo: esExterna(e) });
    }
  }
  return mapa;
}

/** FEAT-213 — La imagen de un mensaje de Telegram, por su terna exacta. `{ clave, entrada }` o `null`. Sobrevive a un reinicio. */
function porMensaje({ bot, chat, id }, env = process.env) {
  if (bot === undefined || bot === null || chat === undefined || chat === null || !Number.isInteger(id)) return null;
  for (const clave of claves(env)) {
    for (const e of listar(clave, env)) {
      const m = e.telegram && e.telegram.mensaje;
      if (m && m.id === id && String(m.bot) === String(bot) && String(m.chat) === String(chat)) return { clave, entrada: e };
    }
  }
  return null;
}

/**
 * FEAT-213 — La única escritura de `telegram`: funde `cambios` (`sha256`, `mensaje`) si la entrada sigue siendo la de ese
 * envío, y conserva lo demás. `true` si se anotó. Lanza `ErrorLock` si está ocupada.
 */
function anotarTelegram(clave, tareaId, n, idEnvio, cambios, { env = process.env, esperaMs } = {}) {
  let anotado = false;
  actualizar(clave, tareaId, n, (p) => {
    if (!idEnvio || !p || !p.telegram || p.telegram.envio !== idEnvio) return null;
    anotado = true;
    return { ...p, telegram: { ...p.telegram, ...cambios, envio: idEnvio } };
  }, env, { esperaMs });
  return anotado;
}

/** FEAT-213 — La última imagen lista (con su archivo) del primero de esos hilos que tenga alguna. `null` si no hay. */
function ultimaImagen(clave, hilos, env = process.env) {
  const todas = listar(clave, env);
  for (const hilo of hilos || []) {
    if (!hilo) continue;
    for (let i = todas.length - 1; i >= 0; i--) {
      const e = todas[i];
      if (e.hilo !== hilo || !e.lista) continue;
      const ruta = archivoDe(clave, e, env);
      if (ruta && fs.existsSync(ruta)) return { tareaId: e.tareaId, n: e.n, ruta, externo: esExterna(e) };
    }
  }
  return null;
}

/** §2.1 — Las vistas `lista`, sin entregar, de ese hilo. */
const MIRADA_COLGADA_MS = 5 * 60 * 1000;
const mirandoTodavia = (e, ahora) => e.vistaEstado === 'pendiente' && ahora - Date.parse(e.vistaDesde || 0) < MIRADA_COLGADA_MS;

function vistasPendientes(clave, hilo, env = process.env, ahora = Date.now()) {
  if (!hilo) return [];
  return listar(clave, env)
    .filter((e) => {
      if (e.hilo !== hilo || !e.lista || e.vistaEntregada || mirandoTodavia(e, ahora)) return false;
      const ruta = archivoDe(clave, e, env);
      return Boolean(ruta && fs.existsSync(ruta));
    })
    .map((e) => ({ tareaId: e.tareaId, n: e.n, vista: e.vista || null, prompt: e.prompt || '', externo: Boolean(e.externo), vistaOrden: Boolean(e.vistaOrden) }));
}

/** §2.1 — Marca entregadas las vistas que llevó un turno que terminó bien. */
function marcarEntregadas(clave, lista, env = process.env) {
  for (const { tareaId, n } of lista || []) {
    try { actualizar(clave, tareaId, n, (p) => (p ? { ...p, vistaEntregada: true } : null), env); } catch {}
  }
}

/** Vacía `.tmp/` (el barrido de arranque). */
function vaciarTmp(clave, env = process.env) {
  try { fs.rmSync(dirTmp(clave, env), { recursive: true, force: true }); } catch {}
}

module.exports = {
  TOPE_POR_ALMA, RE_TAREA, dirImagenes, dirIndice, dirTmp, rutaIndice, rutaArchivo, leer, actualizar, borrar, listar, sha256,
  construirMapa, construirMapaTelegram, vistasPendientes, marcarEntregadas, vaciarTmp,
  claves, rutaDentroDe, archivoDe, fotoPermitida, esExterna, porMensaje, anotarTelegram, ultimaImagen
};
