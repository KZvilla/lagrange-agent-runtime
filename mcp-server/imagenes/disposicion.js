'use strict';

/**
 * FEAT-217 — La disposición de los nodos en el taller: solo lo visual (posición, tamaño, plegado y colores por número de
 * nodo, los grupos y la vista), nunca los valores ni las conexiones. Acá están la forma y los topes (`validarDisposicion`)
 * y la clave de cada flujo, de la que depende dónde se guarda.
 *
 * Una disposición es de la plantilla que de verdad se cargó, no del pedido:
 * - `plugin:<familia>/<archivo>`: una plantilla del plugin, la misma para toda la familia;
 * - `flujo:<ruta normalizada>`: el flujo propio de un perfil;
 * - `propia:<id>`: una plantilla propia del taller (la disposición va dentro de su archivo).
 */

const fs = require('node:fs');
const path = require('node:path');

const TOPE_NODOS = 300;
const TOPE_GRUPOS = 100;
const TOPE_BYTES = 256 * 1024;
/** El tope del archivo que se lee: un poco más que la disposición, por su sobre (`{ clave, disposicion, guardada }`). */
const TOPE_ARCHIVO = 300 * 1024;
const LIMITE_POS = 1e6;
const LIMITE_TAM = 1e5;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
const RESERVADAS = new Set(['__proto__', 'constructor', 'prototype']);
const RE_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const RE_SEGMENTO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RE_PROPIA = /^propia:[a-z0-9]{16}$/;

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const finito = (v) => typeof v === 'number' && Number.isFinite(v);

/** Un fallo de forma: `{ ok: false, campo, motivo }`. */
const mal = (campo, motivo) => ({ ok: false, campo, motivo });

/** Un par de números finitos dentro de `[min, max]`, como array, o `null`. */
function par(v, min, max) {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(finito)) return null;
  return v.every((x) => x >= min && x <= max) ? [v[0], v[1]] : null;
}

const textoDeUnaLinea = (v, tope) => typeof v === 'string' && v.length <= tope && !CONTROLES.test(v);

/** Las claves de un objeto que no están en `permitidas`: la primera, o `null`. */
const sobrante = (o, permitidas) => Object.keys(o).find((k) => !permitidas.includes(k)) ?? null;

function validarNodo(n, campo) {
  if (!esObjeto(n)) return mal(campo, 'tiene que ser un objeto');
  const k = sobrante(n, ['tipo', 'pos', 'tam', 'plegado', 'color', 'fondo']);
  if (k !== null) return mal(`${campo}.${k}`, 'no es un campo de la disposición');
  if (typeof n.tipo !== 'string' || !n.tipo || !textoDeUnaLinea(n.tipo, 200)) return mal(`${campo}.tipo`, 'tiene que ser un texto de 1 a 200 caracteres');
  const pos = par(n.pos, -LIMITE_POS, LIMITE_POS);
  if (!pos) return mal(`${campo}.pos`, 'tienen que ser dos números de hasta ±1.000.000');
  const tam = par(n.tam, 0, LIMITE_TAM);
  if (!tam) return mal(`${campo}.tam`, 'tienen que ser dos números de 0 a 100.000');
  const salida = { tipo: n.tipo, pos, tam };
  if (n.plegado !== undefined) {
    if (typeof n.plegado !== 'boolean') return mal(`${campo}.plegado`, 'tiene que ser true o false');
    salida.plegado = n.plegado;
  }
  for (const c of ['color', 'fondo']) {
    if (n[c] === undefined) continue;
    if (typeof n[c] !== 'string' || !RE_COLOR.test(n[c])) return mal(`${campo}.${c}`, 'tiene que ser # y de 3 a 8 dígitos hexadecimales');
    salida[c] = n[c];
  }
  return { ok: true, nodo: salida };
}

function validarGrupo(g, campo) {
  if (!esObjeto(g)) return mal(campo, 'tiene que ser un objeto');
  const k = sobrante(g, ['titulo', 'caja', 'color', 'letra']);
  if (k !== null) return mal(`${campo}.${k}`, 'no es un campo de la disposición');
  if (!textoDeUnaLinea(g.titulo, 200)) return mal(`${campo}.titulo`, 'tiene que ser un texto de una línea, de hasta 200 caracteres');
  const c = g.caja;
  if (!Array.isArray(c) || c.length !== 4 || !c.every(finito)) return mal(`${campo}.caja`, 'tienen que ser cuatro números');
  const pos = par(c.slice(0, 2), -LIMITE_POS, LIMITE_POS);
  const tam = par(c.slice(2), 0, LIMITE_TAM);
  if (!pos || !tam) return mal(`${campo}.caja`, 'la posición va hasta ±1.000.000 y el tamaño de 0 a 100.000');
  const salida = { titulo: g.titulo, caja: [...pos, ...tam] };
  if (g.color !== undefined) {
    if (typeof g.color !== 'string' || !RE_COLOR.test(g.color)) return mal(`${campo}.color`, 'tiene que ser # y de 3 a 8 dígitos hexadecimales');
    salida.color = g.color;
  }
  if (g.letra !== undefined) {
    if (!Number.isInteger(g.letra) || g.letra < 8 || g.letra > 200) return mal(`${campo}.letra`, 'tiene que ser un entero de 8 a 200');
    salida.letra = g.letra;
  }
  return { ok: true, grupo: salida };
}

function validarVista(v, campo) {
  if (!esObjeto(v)) return mal(campo, 'tiene que ser un objeto');
  const k = sobrante(v, ['zoom', 'desplazamiento']);
  if (k !== null) return mal(`${campo}.${k}`, 'no es un campo de la disposición');
  if (!finito(v.zoom) || v.zoom < 0.1 || v.zoom > 10) return mal(`${campo}.zoom`, 'tiene que ser un número de 0,1 a 10');
  const d = par(v.desplazamiento, -LIMITE_POS, LIMITE_POS);
  if (!d) return mal(`${campo}.desplazamiento`, 'tienen que ser dos números de hasta ±1.000.000');
  return { ok: true, vista: { zoom: v.zoom, desplazamiento: d } };
}

/**
 * La forma y los topes de una disposición. `{ ok: true, disposicion }` (una copia con solo lo que vale) o
 * `{ ok: false, campo, motivo }`, con `campo` desde `disposicion` (por ejemplo `disposicion.nodos.3.pos`).
 * Tiene que traer al menos un nodo o un grupo: `{}` o una que solo trae `vista` no vale.
 */
function validarDisposicion(d, campo = 'disposicion') {
  if (!esObjeto(d)) return mal(campo, 'tiene que ser un objeto');
  const k = sobrante(d, ['nodos', 'grupos', 'vista']);
  if (k !== null) return mal(`${campo}.${k}`, 'no es un campo de la disposición');
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(d), 'utf8'); } catch { return mal(campo, 'no se puede leer'); }
  if (bytes > TOPE_BYTES) return mal(campo, 'pesa más de 256 KB');
  const salida = {};
  if (d.nodos !== undefined) {
    if (!esObjeto(d.nodos)) return mal(`${campo}.nodos`, 'tiene que ser un objeto');
    const ids = Object.keys(d.nodos);
    if (ids.length > TOPE_NODOS) return mal(`${campo}.nodos`, `tiene hasta ${TOPE_NODOS} nodos`);
    const nodos = {};
    for (const id of ids) {
      if (!id || id.length > 100 || CONTROLES.test(id) || RESERVADAS.has(id)) return mal(`${campo}.nodos`, 'un número de nodo no vale');
      const r = validarNodo(d.nodos[id], `${campo}.nodos.${id}`);
      if (!r.ok) return r;
      nodos[id] = r.nodo;
    }
    if (ids.length) salida.nodos = nodos;
  }
  if (d.grupos !== undefined) {
    if (!Array.isArray(d.grupos)) return mal(`${campo}.grupos`, 'tiene que ser una lista');
    if (d.grupos.length > TOPE_GRUPOS) return mal(`${campo}.grupos`, `tiene hasta ${TOPE_GRUPOS} grupos`);
    const grupos = [];
    for (const [i, g] of d.grupos.entries()) {
      const r = validarGrupo(g, `${campo}.grupos.${i}`);
      if (!r.ok) return r;
      grupos.push(r.grupo);
    }
    if (grupos.length) salida.grupos = grupos;
  }
  if (d.vista !== undefined) {
    const r = validarVista(d.vista, `${campo}.vista`);
    if (!r.ok) return r;
    salida.vista = r.vista;
  }
  if (!salida.nodos && !salida.grupos) return mal(campo, 'tiene que traer al menos un nodo o un grupo');
  return { ok: true, disposicion: salida };
}

/** Lee un JSON de hasta `tope` bytes (mirado con `statSync` antes de leer). `null` si no está, pesa más o no es un objeto. */
function leerJsonHasta(ruta, tope) {
  try {
    const st = fs.statSync(ruta);
    if (!st.isFile() || st.size > tope) return null;
    const v = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    return esObjeto(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Las claves.
const flujosLib = () => require('./flujos.js');

/** La carpeta de las plantillas del plugin (la de `flujos.js`, así un test puede usar la misma). */
const dirPlantillas = () => flujosLib().DIR_PLANTILLAS;

/** `plugin:<familia>/<archivo>` → `{ familia, archivo }`, o `null`. */
function partesPlugin(clave) {
  const m = typeof clave === 'string' ? /^plugin:([^/]+)\/([^/]+)$/.exec(clave) : null;
  return m && RE_SEGMENTO.test(m[1]) && RE_SEGMENTO.test(m[2]) ? { familia: m[1], archivo: m[2] } : null;
}

/** La ruta del `.disposicion.json` de una plantilla del plugin, solo si queda dentro de su carpeta; o `null`. */
function rutaDelPlugin(clave, dir = dirPlantillas()) {
  const p = partesPlugin(clave);
  if (!p) return null;
  const base = path.resolve(dir);
  const ruta = path.resolve(base, p.familia, `${p.archivo}.disposicion.json`);
  return ruta.startsWith(base + path.sep) ? ruta : null;
}

/**
 * La clave de un flujo propio: `flujo:` y la ruta normalizada con `path.resolve`; en Windows, además, en minúsculas
 * (`C:/x.json` y `c:/x.json` son el mismo archivo). `ruta` es `path`, o `path.win32` / `path.posix` en los tests.
 */
function claveDeFlujo(archivo, ruta = path) {
  if (typeof archivo !== 'string' || !archivo || archivo.length > 1000 || CONTROLES.test(archivo) || !ruta.isAbsolute(archivo)) return null;
  const r = ruta.resolve(archivo);
  return `flujo:${ruta.sep === '\\' ? r.toLowerCase() : r}`;
}

/** La clave del flujo que resolvió `resolverFlujo` / `resolverPlantillaTaller`, o `null`. */
function claveDeResuelto(r, ruta = path) {
  if (!r || r.ok === false) return null;
  if (r.propio) return claveDeFlujo(r.archivo, ruta);
  return validarClave(`plugin:${r.nombre}`);
}

/** Una clave que vale (también la de una sesión guardada, que puede estar editada a mano), o `null`. */
function validarClave(clave, ruta = path) {
  if (typeof clave !== 'string' || clave.length > 1010) return null;
  if (clave.startsWith('plugin:')) return rutaDelPlugin(clave) ? clave : null;
  if (clave.startsWith('propia:')) return RE_PROPIA.test(clave) ? clave : null;
  if (clave.startsWith('flujo:')) {
    const k = claveDeFlujo(clave.slice(6), ruta);
    return k === clave ? clave : null;
  }
  return null;
}

/** La disposición que trae el plugin para esa plantilla, ya validada; o `null`. */
function delPlugin(clave, dir = dirPlantillas()) {
  const ruta = rutaDelPlugin(clave, dir);
  const o = ruta ? leerJsonHasta(ruta, TOPE_ARCHIVO) : null;
  const v = o ? validarDisposicion(o) : null;
  return v && v.ok ? v.disposicion : null;
}

module.exports = {
  TOPE_NODOS, TOPE_GRUPOS, TOPE_BYTES, TOPE_ARCHIVO,
  validarDisposicion, leerJsonHasta, partesPlugin, rutaDelPlugin, claveDeFlujo, claveDeResuelto, validarClave, delPlugin
};
