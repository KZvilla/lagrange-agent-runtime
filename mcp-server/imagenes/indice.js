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
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rutas = require('../almas/rutas.js');
const { conLock, escribirAtomico } = require('../almas/archivos.js');

const RE_TAREA = /^t_[a-z0-9]{4,40}$/;
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

/** Leer-modificar-escribir bajo el lock de ese archivo. `fn(previo)` devuelve lo nuevo (o `null` para no escribir). */
function actualizar(clave, tareaId, n, fn, env = process.env) {
  const ruta = rutaIndice(clave, tareaId, n, env);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  return conLock(ruta, () => {
    const previo = leer(clave, tareaId, n, env);
    const nuevo = fn(previo);
    if (!nuevo) return previo;
    escribirAtomico(ruta, `${JSON.stringify({ ...nuevo, tareaId, n }, null, 2)}\n`);
    return nuevo;
  });
}

function borrar(clave, tareaId, n, env = process.env) {
  try { fs.rmSync(rutaIndice(clave, tareaId, n, env), { force: true }); } catch {}
}

/** Todas las entradas de un alma, de la más vieja a la más nueva (por `creada`). */
function listar(clave, env = process.env) {
  let nombres = [];
  try { nombres = fs.readdirSync(dirIndice(clave, env)).filter((f) => /^t_[a-z0-9]+-\d+\.json$/.test(f)); } catch { return []; }
  const salida = [];
  for (const f of nombres) {
    const m = /^(t_[a-z0-9]+)-(\d+)\.json$/.exec(f);
    const e = leer(clave, m[1], Number(m[2]), env);
    if (e) salida.push({ ...e, tareaId: m[1], n: Number(m[2]) });
  }
  return salida.sort((a, b) => String(a.creada || '').localeCompare(String(b.creada || '')));
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** El mapa `sha256 → { clave, tareaId, n }` de todas las almas (para reconocer una foto propia). */
function construirMapa(env = process.env) {
  const mapa = new Map();
  let claves = [];
  try { claves = fs.readdirSync(rutas.dirAlmas(env)).filter((c) => rutas.CLAVE_VALIDA.test(c)); } catch { return mapa; }
  for (const clave of claves) {
    for (const e of listar(clave, env)) if (e.sha256 && e.archivo) mapa.set(e.sha256, { clave, tareaId: e.tareaId, n: e.n });
  }
  return mapa;
}

/** §2.1 — Las vistas `lista`, sin entregar, de ese hilo. */
const MIRADA_COLGADA_MS = 5 * 60 * 1000;
const mirandoTodavia = (e, ahora) => e.vistaEstado === 'pendiente' && ahora - Date.parse(e.vistaDesde || 0) < MIRADA_COLGADA_MS;

function vistasPendientes(clave, hilo, env = process.env, ahora = Date.now()) {
  if (!hilo) return [];
  return listar(clave, env)
    .filter((e) => e.hilo === hilo && e.lista && !e.vistaEntregada && !mirandoTodavia(e, ahora) && e.archivo && fs.existsSync(e.archivo))
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
  construirMapa, vistasPendientes, marcarEntregadas, vaciarTmp
};
