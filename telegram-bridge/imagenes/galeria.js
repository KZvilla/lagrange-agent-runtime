/**
 * FEAT-213 §2 — La galería: lista, baja y borra las imágenes de las almas desde su índice privado.
 *
 * Lee del índice y no del registro de tareas, que guarda 200: lo viejo también se ve. Nunca salen rutas, el hilo, el mensaje
 * de Telegram ni lo que vio la mirada.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Perezosos: importar bot.js no carga la config del MCP (BE-176).
const perezoso = (ruta) => { let m = null; return new Proxy({}, { get: (_, k) => (m ||= require(ruta))[k] }); };
const indice = perezoso('../../mcp-server/imagenes/indice.js');
const almasRutas = perezoso('../../mcp-server/almas/rutas.js');

export const LIMITE_POR_DEFECTO = 60;
export const LIMITE_MAX = 100;
export const TOPE_BORRAR = 100;
const TOPE_REFERENCIA = 20 * 1024 * 1024;
const CASOS = new Set(['nueva', 'variacion', 'retoque', 'edicion']);
// FEAT-214 — El filtro «Del taller» no es un caso: mira de dónde salió.
const FILTROS = new Set([...CASOS, 'taller']);
const CAMBIOS = new Set(['leve', 'medio', 'fuerte']);
const texto = (v, tope) => (typeof v === 'string' && v ? v.slice(0, tope) : null);
const entero = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/** El cursor es opaco: `(creada, tareaId, n)` de la última fila. */
const cursorDe = (e) => Buffer.from(JSON.stringify([String(e.creada || ''), e.tareaId, e.n])).toString('base64url');
export function leerCursor(v) {
  try {
    const o = JSON.parse(Buffer.from(String(v), 'base64url').toString('utf8'));
    return Array.isArray(o) && o.length === 3 && typeof o[0] === 'string' && typeof o[1] === 'string' && Number.isInteger(o[2]) ? { creada: o[0], tareaId: o[1], n: o[2] } : null;
  } catch {
    return null;
  }
}

/** Negativo si `a` es más nueva que `b`. */
function masNueva(a, b) {
  const x = String(a.creada || '');
  const y = String(b.creada || '');
  if (x !== y) return x < y ? 1 : -1;
  if (a.tareaId !== b.tareaId) return a.tareaId < b.tareaId ? 1 : -1;
  return b.n - a.n;
}

/** Las medidas de un PNG, por su cabecera. `null` si no es PNG. */
function medidasDePng(ruta) {
  try {
    const fd = fs.openSync(ruta, 'r');
    try {
      const b = Buffer.alloc(24);
      if (fs.readSync(fd, b, 0, 24, 0) < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
      const ancho = b.readUInt32BE(16);
      const alto = b.readUInt32BE(20);
      return ancho > 0 && alto > 0 && ancho <= 16384 && alto <= 16384 ? { ancho, alto } : null;
    } finally { fs.closeSync(fd); }
  } catch {
    return null;
  }
}

/**
 * `crearGaleria({ cola, registro, leerConfig, alCambiar, env })`. `cola`: la de imágenes; `registro.tarea(id)`: el de tareas;
 * `alCambiar(clave)`: el evento `imagenes.cambio`.
 */
export function crearGaleria({ cola, registro, leerConfig, alCambiar = () => {}, env = process.env }) {
  // El tamaño de cada archivo, mirado una vez (`null` si no está o apunta afuera): con miles, no se vuelve al disco por cada pedido.
  const tamanos = new Map();
  const bytesDe = (clave, e) => {
    const k = `${clave}/${e.tareaId}-${e.n}-${e.intento || 1}`;
    if (!tamanos.has(k)) {
      let b = null;
      const ruta = indice.archivoDe(clave, e, env);
      if (!ruta) cola.avisarAfuera?.(e);
      try { b = ruta ? fs.statSync(ruta).size : null; } catch {}
      // Que no esté puede ser de ahora: solo se recuerda lo que hay.
      if (b === null) return null;
      tamanos.set(k, b);
      if (tamanos.size > 20000) tamanos.delete(tamanos.keys().next().value);
    }
    return tamanos.get(k);
  };

  const terminadas = (clave) => indice.listar(clave, env).filter((e) => e.lista && e.archivo);
  const claves = () => indice.claves(env);

  /** Una fila, o `null` si su archivo no está o apunta afuera de su carpeta. */
  function fila(clave, e, config) {
    const ruta = indice.archivoDe(clave, e, env);
    if (!ruta) cola.avisarAfuera?.(e);
    if (!ruta || !fs.existsSync(ruta)) return null;
    const t = registro.tarea(e.tareaId);
    const del = t && Array.isArray(t.imagenes) ? t.imagenes.find((i) => i.n === e.n && (i.intento || 1) === (e.intento || 1)) : null;
    const de = (k) => e[k] ?? (del ? del[k] : null) ?? null;
    let ancho = entero(de('ancho'));
    let alto = entero(de('alto'));
    if (!ancho || !alto) { const m = medidasDePng(ruta); ancho = m ? m.ancho : null; alto = m ? m.alto : null; }
    const loras = Array.isArray(e.lorasUsadas) ? e.lorasUsadas : del && Array.isArray(del.loras) ? del.loras : Array.isArray(e.loras) ? e.loras.map((clave2) => ({ clave: clave2, fuerza: null })) : [];
    const externo = indice.esExterna(e);
    return {
      alma: clave, tareaId: e.tareaId, n: e.n, intento: e.intento || 1, creada: texto(e.creada, 40),
      prompt: texto(de('prompt'), 2000), negativo: texto(de('negativo'), 500), caso: CASOS.has(de('caso')) ? de('caso') : null, casoPedido: CASOS.has(de('casoPedido')) ? de('casoPedido') : null,
      perfil: texto(de('perfil'), 40), proveedor: texto(de('proveedor'), 32), modelo: texto(de('modelo'), 200),
      // FEAT-218 — Si el modelo lo eligió el refinador.
      modeloAuto: de('modeloAuto') === true, ancho, alto, bytes: bytesDe(clave, e), tipo: texto(e.tipo, 32),
      zona: texto(de('zona'), 120), instruccion: texto(de('instruccion'), 2000),
      loras: loras.filter((l) => l && typeof l.clave === 'string').slice(0, 4).map((l) => ({ clave: l.clave.slice(0, 30), fuerza: Number.isFinite(l.fuerza) ? l.fuerza : null })),
      cambio: CAMBIOS.has(e.cambio) ? e.cambio : null, fuerza: Number.isFinite(e.fuerza) ? e.fuerza : null,
      // FEAT-215 — Su número, de dónde salió y si es de la que se parte.
      num: entero(e.num), origen: indice.origenDe(e), deNum: entero(e.deNum), baseNum: entero(e.baseNum), elegida: Boolean(config.partir && e.elegida),
      externo, segura: !externo && Boolean(config.fotos_seguras && config.reconocer_propias), enRegistro: Boolean(del && del.estado === 'lista')
    };
  }

  /** Cuántas y cuántos bytes por alma, con su tope (0 = sin tope). */
  function resumen(config) {
    const salida = {};
    for (const clave of claves()) {
      const tam = terminadas(clave).map((e) => bytesDe(clave, e)).filter((b) => b !== null);
      if (tam.length) salida[clave] = { n: tam.length, bytes: tam.reduce((s, b) => s + b, 0), tope: config.tope_por_alma };
    }
    return salida;
  }

  /** `{ ok, imagenes, siguiente, resumen }` o `{ ok: false, codigo, campo, motivo }`. */
  function listar({ alma = null, caso = null, busca = null, antes = null, limite = null } = {}) {
    const mal = (campo, motivo) => ({ ok: false, codigo: 400, campo, motivo });
    if (alma && !almasRutas.CLAVE_VALIDA.test(alma)) return mal('alma', 'No es un alma.');
    if (caso && !FILTROS.has(caso)) return mal('caso', 'No es un caso.');
    const desde = antes ? leerCursor(antes) : null;
    if (antes && !desde) return mal('antes', 'No es un cursor.');
    const tope = limite === null || limite === '' ? LIMITE_POR_DEFECTO : Number(limite);
    if (!Number.isInteger(tope) || tope < 1 || tope > LIMITE_MAX) return mal('limite', `Tiene que ser de 1 a ${LIMITE_MAX}.`);
    const q = String(busca || '').trim().toLowerCase().slice(0, 200);
    const config = leerConfig();
    const todas = [];
    for (const clave of alma ? [alma] : claves()) {
      for (const e of terminadas(clave)) {
        if (caso === 'taller' ? e.origen !== 'taller' : caso && (e.caso !== caso || e.origen === 'taller')) continue;
        if (q && !`${e.prompt || ''} ${e.instruccion || ''} ${e.zona || ''}`.toLowerCase().includes(q)) continue;
        if (desde && masNueva(desde, e) >= 0) continue;
        todas.push({ clave, e });
      }
    }
    todas.sort((a, b) => masNueva(a.e, b.e));
    const imagenes = [];
    let ultima = null;
    let i = 0;
    for (; i < todas.length && imagenes.length < tope; i++) {
      const f = fila(todas[i].clave, todas[i].e, config);
      ultima = todas[i].e;
      if (f) imagenes.push(f);
    }
    return { ok: true, imagenes, siguiente: i < todas.length ? cursorDe(ultima) : null, resumen: resumen(config) };
  }

  const valida = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o) && typeof o.alma === 'string' && almasRutas.CLAVE_VALIDA.test(o.alma)
    && typeof o.tareaId === 'string' && indice.RE_TAREA.test(o.tareaId) && Number.isInteger(o.n) && o.n >= 1 && o.n <= 99 && Number.isInteger(o.intento) && o.intento >= 1;

  /** Responde una por una: `borrada`, `no-existe`, `cambio` u `ocupada`. */
  function borrar(lista) {
    if (!Array.isArray(lista) || !lista.length || lista.length > TOPE_BORRAR || !lista.every(valida)) return { ok: false, codigo: 400, campo: 'imagenes', motivo: `De 1 a ${TOPE_BORRAR} imágenes { alma, tareaId, n, intento }.` };
    const tocadas = new Set();
    const resultados = lista.map(({ alma, tareaId, n, intento }) => {
      const resultado = cola.borrarImagen({ clave: alma, tareaId, n, intento });
      if (resultado === 'borrada') tocadas.add(alma);
      return { alma, tareaId, n, intento, resultado };
    });
    for (const clave of tocadas) alCambiar(clave);
    return { ok: true, resultados };
  }

  /** Los bytes de una, por su lugar en el índice. */
  function bytes(alma, tareaId, n) {
    if (!valida({ alma, tareaId, n, intento: 1 })) return { ok: false, codigo: 400 };
    return cola.bytesDelIndice(alma, tareaId, n);
  }

  /** El archivo original de una imagen, para mandarla a un alma. `{ ok, ruta }` o `{ ok: false, codigo, motivo }`. */
  function referencia(r) {
    if (!valida(r)) return { ok: false, codigo: 400, motivo: 'referencia tiene que ser { alma, tareaId, n, intento }.' };
    const e = indice.leer(r.alma, r.tareaId, r.n, env);
    const ruta = e && e.lista ? indice.archivoDe(r.alma, e, env) : null;
    if (!ruta) return { ok: false, codigo: 404, motivo: 'Esa imagen ya no está.' };
    if ((e.intento || 1) !== r.intento) return { ok: false, codigo: 409, motivo: 'Esa imagen cambió: hay un intento más nuevo.' };
    try {
      const st = fs.statSync(ruta);
      if (!st.isFile()) throw new Error('no');
      if (st.size > TOPE_REFERENCIA) return { ok: false, codigo: 413, motivo: 'La imagen pesa más de 20 MB.' };
    } catch {
      return { ok: false, codigo: 404, motivo: 'Esa imagen ya no está.' };
    }
    return { ok: true, ruta };
  }

  return { listar, borrar, bytes, referencia, valida };
}
