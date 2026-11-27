/**
 * FEAT-214 — El taller: abrir el flujo de una imagen (o una plantilla, o lo que preparó un alma) en ComfyUI para editarlo a
 * mano, y traer de vuelta lo que se hace ahí.
 *
 * Una sesión es un flujo abierto en una ventana del taller. Lo que corre en ComfyUI vuelve mirando su historial: por la carpeta
 * de salida de la sesión (`lagrange-taller/<sesion>/`) o, si no la tiene, por el `client_id` de la ventana (eso va a «lo de la
 * ventana», `v-<ventana>`). Nada entra a la galería solo: el usuario elige qué quedarse.
 *
 * Todo vive en `~/.claude/lagrange-taller` (o `LAGRANGE_TALLER_DIR`): sobrevive a las versiones del plugin. Ningún nombre que
 * viene de ComfyUI se usa como nombre local, y todo id se valida antes de usarse.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { armarPedido, subirBase, TOPE_BYTES, leerHasta, medidasDe, tipoDe, extDe } from './comfyui.js';
import { camposDeImagen } from '../imagenes-cola.js';

const require = createRequire(import.meta.url);
// Perezosos: importar bot.js no carga la config del MCP (BE-176).
const perezoso = (ruta) => { let m = null; return new Proxy({}, { get: (_, k) => (m ||= require(ruta))[k] }); };
const indice = perezoso('../../mcp-server/imagenes/indice.js');
const flujosLib = perezoso('../../mcp-server/imagenes/flujos.js');
const casosLib = perezoso('../../mcp-server/imagenes/casos.js');
const perfilesLib = perezoso('../../mcp-server/imagenes/perfiles.js');
const catalogos = perezoso('../../mcp-server/imagenes/catalogo.js');
const procesoLib = perezoso('../../mcp-server/imagenes/comfyui-proceso.js');
const ajustes = perezoso('../../mcp-server/lib/ajustes-imagenes.js');
const almasRutas = perezoso('../../mcp-server/almas/rutas.js');
const archivos = perezoso('../../mcp-server/almas/archivos.js');
// FEAT-217 — La disposición de los nodos: la forma, los topes y la clave de cada flujo.
const disposicionLib = perezoso('../../mcp-server/imagenes/disposicion.js');

export const RE_SESION = /^s-[a-z0-9]{16}$/;
export const RE_VENTANA = /^v-[a-z0-9]{16}$/;
export const RE_PREPARADO = /^p-[a-z0-9]{16}$/;
export const RE_IMAGEN = /^img-[a-z0-9]{16}$/;
const RE_PROPIA = /^[a-z0-9]{16}$/;
const RE_CLIENTE = /^[A-Za-z0-9-]{1,64}$/;
const RE_ID_CLIENTE = /^[A-Za-z0-9-]{8,64}$/;
const RE_LOCAL = /^(img|input)-[a-z0-9]{16}\.(png|jpg|webp)$/;
const RE_PLANTILLA = /^(plugin:(nueva|variacion|retoque|edicion|retoque-a-mano)|propia:[a-z0-9]{16})$/;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
const CASOS = ['nueva', 'variacion', 'retoque', 'edicion'];
const NOMBRE_CASO = { nueva: 'imagen nueva', variacion: 'variación', retoque: 'retoque', edicion: 'edición' };
export const TOPE_SESIONES = 4;
export const TOPE_PLANTILLAS = 200;
export const TOPE_VISTOS = 500;
const SENAL_MS = 2 * 60 * 1000;
const USO_MS = 30 * 1000;
const PREPARADO_MS = 2 * 60 * 60 * 1000;
const CERRADA_MS = 7 * 24 * 60 * 60 * 1000;
const BARRIDO_MS = 60 * 60 * 1000;
const DISCO_MS = 30 * 1000;
const DISCO_VIEJO_MS = 60 * 1000;
const ESPERA_LEVANTAR_MS = 120 * 1000;
const PEDIDO_MS = 30 * 1000;
const TOPE_FALLOS = 200;
// FEAT-217 — Hasta 200 disposiciones de plantillas del plugin y flujos propios; una plantilla propia se lee hasta 2,5 MB
// (el tope del cuerpo con que se guarda).
export const TOPE_DISPOSICIONES = 200;
const TOPE_PROPIA = Math.round(2.5 * 1024 * 1024);

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const id16 = () => crypto.randomBytes(8).toString('hex');
const no = (status, motivo, mensaje) => ({ ok: false, status, motivo, mensaje });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const clon = (o) => JSON.parse(JSON.stringify(o));

export function dirTaller(env = process.env) {
  return env.LAGRANGE_TALLER_DIR ? path.resolve(env.LAGRANGE_TALLER_DIR) : path.join(os.homedir(), '.claude', 'lagrange-taller');
}

/** El nombre de un archivo de `input` como lo escribe ComfyUI («sub/x.png [input]»), sin la marca de tipo. */
const sinMarca = (nombre) => String(nombre).replace(/\s\[(input|output|temp)\]$/, '');

/** Un nombre remoto que se puede pedir por `/view`: relativo, sin `..` ni controles. `{ filename, subfolder }` o `null`. */
export function nombreRemoto(valor, subfolder = '') {
  if (typeof valor !== 'string' || !valor || typeof subfolder !== 'string' || valor.length + subfolder.length > 300 || CONTROLES.test(valor + subfolder)) return null;
  if (/^[\\/]/.test(valor) || /^[\\/]/.test(subfolder)) return null;
  const segmentos = [...subfolder.split(/[\\/]/), ...valor.split(/[\\/]/)].filter((x) => x !== '');
  // Ningún segmento puede ser `..`, `.` ni empezar con una unidad (`C:`).
  if (!segmentos.length || segmentos.some((x) => x === '..' || x === '.' || /^[A-Za-z]:/.test(x) || x.includes(':'))) return null;
  const filename = segmentos.pop();
  return { filename, subfolder: segmentos.join('/') };
}

/** Los nodos que cargan una imagen de `input`, con el nombre que usan: `[[id, nombre]]`. */
function cargadoresDe(grafo) {
  const salida = [];
  for (const [id, n] of Object.entries(esObjeto(grafo) ? grafo : {})) {
    if (!esObjeto(n) || typeof n.class_type !== 'string' || !/LoadImage/.test(n.class_type) || !esObjeto(n.inputs)) continue;
    if (typeof n.inputs.image === 'string' && n.inputs.image) salida.push([id, n.inputs.image]);
  }
  return salida;
}

/** La semilla si hay una sola (en los samplers del grafo), o `null`. */
function semillaDe(grafo) {
  const semillas = new Set();
  for (const n of Object.values(esObjeto(grafo) ? grafo : {})) {
    if (!esObjeto(n) || !/KSampler/.test(String(n.class_type)) || !esObjeto(n.inputs)) continue;
    for (const k of ['seed', 'noise_seed']) if (Number.isInteger(n.inputs[k])) semillas.add(n.inputs[k]);
  }
  return semillas.size === 1 ? [...semillas][0] : null;
}

/** El prompt si el grafo tiene un solo `CLIPTextEncode` positivo (lo que entra al `positive` de un sampler). */
function promptDe(grafo) {
  const textos = new Set();
  for (const n of Object.values(esObjeto(grafo) ? grafo : {})) {
    if (!esObjeto(n) || !esObjeto(n.inputs) || !Array.isArray(n.inputs.positive)) continue;
    const p = grafo[String(n.inputs.positive[0])];
    if (esObjeto(p) && p.class_type === 'CLIPTextEncode' && esObjeto(p.inputs) && typeof p.inputs.text === 'string') textos.add(p.inputs.text);
  }
  return textos.size === 1 ? [...textos][0].slice(0, 2000) : null;
}

/** Cada `SaveImage` a la carpeta de la sesión, si su prefijo es un texto o no está (un enlace a otro nodo se deja). */
function prefijar(grafo, sesion) {
  for (const n of Object.values(grafo)) {
    if (!esObjeto(n) || n.class_type !== 'SaveImage') continue;
    n.inputs = esObjeto(n.inputs) ? n.inputs : {};
    if (n.inputs.filename_prefix === undefined || typeof n.inputs.filename_prefix === 'string') n.inputs.filename_prefix = `lagrange-taller/${sesion}/img`;
  }
  return grafo;
}

/**
 * Los nombres con que ComfyUI muestra los nodos de una plantilla del plugin (`_meta.title`, que `loadApiJson` respeta): los
 * que hay que tocar y la vista previa de la máscara, que es un control y no el resultado. Se ponen sobre el flujo armado,
 * antes de los marcadores (el marcador dice qué es cada nodo). Un título que ya está no se cambia.
 */
export const TITULO_MASCARA = 'Máscara de la zona (control, no es el resultado)';
const TITULOS = { prompt: 'Prompt', negativo: 'Negativo', zona: 'Zona a retocar: escribí qué parte', instruccion: 'Instrucción: qué cambiar', foto: 'Imagen de base' };
function titular(armado, salidaMascara) {
  const g = clon(armado);
  for (const [id, n] of Object.entries(g)) {
    if (!esObjeto(n) || !esObjeto(n.inputs)) continue;
    let t = id === salidaMascara ? TITULO_MASCARA : null;
    for (const v of Object.values(n.inputs)) {
      const m = !t && typeof v === 'string' && /^\{\{(prompt|negativo|zona|instruccion|foto)\}\}$/.exec(v);
      if (m) t = TITULOS[m[1]];
    }
    if (t && !(esObjeto(n._meta) && n._meta.title)) n._meta = { ...(esObjeto(n._meta) ? n._meta : {}), title: t };
  }
  return g;
}

/** ¿El flujo armado usa ese marcador? (`{{zona}}` sin zona: la máscara sale vacía o al azar). */
const usaMarcador = (armado, k) => JSON.stringify(armado).includes(`{{${k}}}`);

/** La vista previa de la máscara de una plantilla del plugin: no va a la tira (es un control del retoque, no una imagen). */
const esVistaDeMascara = (grafo, nodo) => {
  const n = esObjeto(grafo) && Object.hasOwn(grafo, nodo) ? grafo[nodo] : null;
  return esObjeto(n) && n.class_type === 'PreviewImage' && esObjeto(n._meta) && n._meta.title === TITULO_MASCARA;
};

/** Reemplaza un nombre de `input` en todos los nodos que lo cargan. */
function renombrar(grafo, viejo, nuevo) {
  for (const n of Object.values(grafo)) if (esObjeto(n) && esObjeto(n.inputs) && n.inputs.image === viejo) n.inputs.image = nuevo;
}

/** El error de una entrada del historial, filtrado: el id del nodo y la clase. */
function errorDe(entrada) {
  const m = entrada && entrada.status && Array.isArray(entrada.status.messages) ? entrada.status.messages : [];
  const e = m.find((x) => Array.isArray(x) && x[0] === 'execution_error' && esObjeto(x[1]));
  return {
    nodo: e ? String(e[1].node_id ?? '').replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 40) : null,
    clase: e ? String(e[1].node_type || '').replace(/[^A-Za-z0-9_ ]/g, '').slice(0, 40) : null,
    mensaje: 'ComfyUI falló al correr el flujo.'
  };
}

/** 2.25.1 — Lo que el taller espera el catálogo de ComfyUI cuando no está en la caché. */
const TOPE_CATALOGO_MS = 8000;

function leerJsonSeguro(ruta) {
  try { const v = JSON.parse(fs.readFileSync(ruta, 'utf8')); return esObjeto(v) ? v : null; } catch { return null; }
}

/**
 * Crea el taller. Se inyecta: `leerConfig()` (la sección `imagenes`), `proceso` (el de ComfyUI: `comprobar`, `levantar`, `estado`,
 * `anotarUso`), `dirAdjuntos()`, `cola` (`podar`, `invalidarMapas`), `alCambiar(clave)` (imágenes de un alma), `publicar(tema,
 * tipo, datos)` (los eventos de la v2), `fetchImpl`, `log`, `env`, `ahora`, `dir` y los tiempos en los tests.
 *
 * El catálogo de ComfyUI: `catalogoDe(url)` lo mira en la caché (sin pedir nada) y `pedirCatalogo(url)` lo pide si no está
 * (el daemon le pasa `catalogo.catalogoDe`; sin él, solo la caché). El pedido tiene su tope (`tiempos.catalogo`, 8 s): la
 * terminal espera 10 s la lista de plantillas.
 */
export function crearTaller({
  leerConfig, proceso = null, dirAdjuntos = () => null, cola = null, alCambiar = () => {}, publicar = () => {}, fetchImpl = (...a) => globalThis.fetch(...a),
  log = () => {}, env = process.env, ahora = () => new Date(), dir = dirTaller(env), catalogoDe = (url) => catalogos.enCache(url), pedirCatalogo = null, tiempos = {}
}) {
  const T = { vuelta: 2000, senal: SENAL_MS, uso: USO_MS, levantar: ESPERA_LEVANTAR_MS, disco: DISCO_MS, catalogo: TOPE_CATALOGO_MS, ...tiempos };
  const dirSesiones = path.join(dir, 'sesiones');
  const dirPlantillas = path.join(dir, 'plantillas');
  const dirPreparados = path.join(dir, 'preparados');
  const dirDisposiciones = path.join(dir, 'disposiciones');
  const sesiones = new Map();
  const fallos = new Map();
  const rutaFallos = path.join(dir, 'preparados', 'fallos.json');
  try { const f = JSON.parse(fs.readFileSync(rutaFallos, 'utf8')); if (Array.isArray(f)) for (const [k, v] of f.slice(-TOPE_FALLOS)) if (typeof k === 'string' && esObjeto(v)) fallos.set(k, v); } catch {}
  const ms = () => ahora().getTime();
  let reloj = null;
  let relojBarrido = null;
  let enVuelta = false;
  let primera = true;
  let siguienteEn = 0;
  let fallosSeguidos = 0;
  let sinComfy = false;
  let ultimoUso = 0;
  let ultimoDisco = 0;

  const base = (config) => String(config.comfyui.url || ajustes.URL_COMFYUI).replace(/\/+$/, '');
  const pedir = (config, ruta, opciones = {}) => fetchImpl(`${base(config)}${ruta}`, { ...opciones, signal: opciones.signal ? AbortSignal.any([opciones.signal, AbortSignal.timeout(PEDIDO_MS)]) : AbortSignal.timeout(PEDIDO_MS) });
  const jsonDe = (config) => async (ruta, opciones = {}) => {
    const r = await pedir(config, ruta, opciones);
    if (!r.ok) throw Object.assign(new Error(`ComfyUI ${r.status}`), { status: r.status });
    return r.json();
  };

  // ---------------------------------------------------------------- Lo guardado.
  const dirDe = (id) => path.join(dirSesiones, id);
  function guardar(s) {
    fs.mkdirSync(dirDe(s.id), { recursive: true });
    archivos.escribirAtomico(path.join(dirDe(s.id), 'sesion.json'), `${JSON.stringify(s)}\n`);
  }
  /** Un archivo de la sesión, por su nombre local (generado por nosotros), solo si queda adentro de su carpeta. */
  function rutaLocal(s, nombre) {
    if (typeof nombre !== 'string' || !RE_LOCAL.test(nombre) && !/^g-[a-z0-9]{16}\.json$/.test(nombre)) return null;
    try { fs.mkdirSync(dirDe(s.id), { recursive: true }); } catch {}
    return indice.rutaDentroDe(dirDe(s.id), path.join(dirDe(s.id), nombre));
  }

  /** FEAT-218 — El modelo de una sesión: un nombre de archivo de hasta 200, o `null`. */
  const modeloValido = (m) => (typeof m === 'string' && m && perfilesLib.formaDeArchivo(m) === null ? m.trim() : null);

  function cargar() {
    let nombres = [];
    try { nombres = fs.readdirSync(dirSesiones); } catch { return; }
    for (const id of nombres) {
      if (!RE_SESION.test(id) && !RE_VENTANA.test(id)) continue;
      const s = leerJsonSeguro(path.join(dirDe(id), 'sesion.json'));
      if (s && s.id === id && esObjeto(s.imagenes) && RE_VENTANA.test(String(s.ventana))) sesiones.set(id, { ...s, clave: disposicionLib.validarClave(s.clave), modelo: modeloValido(s.modelo), modeloAuto: s.modeloAuto === true, enCurso: [] });
    }
  }

  // ---------------------------------------------------------------- Helpers de las almas.
  const almaExiste = (alma) => typeof alma === 'string' && almasRutas.CLAVE_VALIDA.test(alma) && indice.claves(env).includes(alma);
  const refValida = (o) => esObjeto(o) && typeof o.alma === 'string' && almasRutas.CLAVE_VALIDA.test(o.alma) && typeof o.tareaId === 'string' && indice.RE_TAREA.test(o.tareaId)
    && Number.isInteger(o.n) && o.n >= 1 && o.n <= 99 && Number.isInteger(o.intento) && o.intento >= 1;

  /** Una foto de base que existe, en sus carpetas o en la de adjuntos (como la cola), y de hasta 20 MB: `{ ok, ruta }` o un error. */
  function fotoDe(ruta, perdida) {
    const r = typeof ruta === 'string' ? indice.fotoPermitida(ruta, { dirAdjuntos: dirAdjuntos(), env }) : null;
    let st = null;
    try { st = r ? fs.statSync(r) : null; } catch {}
    if (!st || !st.isFile()) return no(409, 'base-perdida', perdida);
    if (st.size > TOPE_BYTES) return no(413, 'grande', 'La imagen de base pesa más de 20 MB.');
    return { ok: true, ruta: r };
  }

  /** Las medidas del perfil para una base: las de su proporción, o la más cercana a sus medidas; si no, 1:1. */
  function medidasParaBase(perfil, e) {
    const med = (perfil && perfil.medidas) || {};
    if (e && med[e.proporcion]) return med[e.proporcion];
    if (e && Number.isInteger(e.ancho) && Number.isInteger(e.alto) && e.ancho > 0 && e.alto > 0) {
      let mejor = null;
      let dif = Infinity;
      for (const [clave, m] of Object.entries(med)) {
        if (!Array.isArray(m) || !(m[0] > 0 && m[1] > 0)) continue;
        const d = Math.abs(Math.log(m[0] / m[1]) - Math.log(e.ancho / e.alto));
        if (d < dif) { dif = d; mejor = clave; }
      }
      if (mejor) return med[mejor];
    }
    return med['1:1'] || [1024, 1024];
  }

  /** La imagen de una referencia de la galería: `{ ok, e, ruta }` o un error. */
  function imagenDe(ref) {
    if (!refValida(ref)) return no(400, 'referencia', 'La imagen tiene que ser { alma, tareaId, n, intento }.');
    const e = indice.leer(ref.alma, ref.tareaId, ref.n, env);
    const ruta = e && e.lista ? indice.archivoDe(ref.alma, e, env) : null;
    if (!ruta || !fs.existsSync(ruta)) return no(404, 'no-existe', 'Esa imagen ya no está.');
    if ((e.intento || 1) !== ref.intento) return no(409, 'cambio', 'Esa imagen cambió: hay un intento más nuevo.');
    try { if (fs.statSync(ruta).size > TOPE_BYTES) return no(413, 'grande', 'La imagen pesa más de 20 MB.'); } catch { return no(404, 'no-existe', 'Esa imagen ya no está.'); }
    return { ok: true, e, ruta };
  }

  /** Los LoRAs de una imagen vieja, por su clave en los de ComfyUI (los que ya no están se saltean). */
  function lorasPorClave(config, usadas, modelo = null) {
    const todos = Array.isArray(config.comfyui.loras) ? config.comfyui.loras : [];
    return (Array.isArray(usadas) ? usadas : []).map((u) => {
      const l = todos.find((x) => x && x.clave === (u && u.clave));
      if (!l) return null;
      // FEAT-218 — Una LoRA que ya no va con este modelo se saltea.
      if (!casosLib.loraVaCon(l, modelo)) { log(`[taller] El LoRA "${l.clave}" no va con ${String(modelo).slice(0, 80)}; se saltea.`); return null; }
      return { clave: l.clave, archivo: l.archivo, fuerza: Number.isFinite(u.fuerza) ? u.fuerza : l.fuerza };
    }).filter(Boolean);
  }

  // ---------------------------------------------------------------- ComfyUI.
  async function asegurarComfy(config) {
    if (!proceso) return no(503, 'sin-comfy', 'ComfyUI no se maneja desde este proceso.');
    let e = await proceso.comprobar(config);
    if (e === 'ok') return { ok: true };
    if (e === 'otro-programa') return no(409, 'otro-programa', 'En esa dirección responde otro programa, no ComfyUI.');
    const a = config.comfyui.arranque || {};
    if (!a.carpeta || !a.automatico) return no(503, 'sin-comfy', 'ComfyUI está apagado.');
    const promesa = proceso.levantar(config);
    if (!promesa) {
      let est = null;
      try { est = await proceso.estado(config); } catch {}
      return no(503, 'sin-comfy', (est && est.mensaje) || 'Ahora no se puede levantar ComfyUI.');
    }
    await Promise.race([Promise.resolve(promesa).catch(() => null), dormir(Math.min(T.levantar, (a.espera_s || 120) * 1000))]);
    e = await proceso.comprobar(config);
    return e === 'ok' ? { ok: true } : no(503, 'levantando', 'Levantando ComfyUI…');
  }

  /** Los ids del historial, o `null` si no se pudo leer (que no es lo mismo que un historial vacío). */
  async function idsDelHistorial(config, cuantos) {
    try { const h = await jsonDe(config)(`/history?max_items=${cuantos}`); return esObjeto(h) ? Object.keys(h).slice(-TOPE_VISTOS) : null; } catch { return null; }
  }

  // ---------------------------------------------------------------- Armar lo que se abre.
  /**
   * `{ ok, grafo | (armado, datos), base, archivos, baseEnPropia, externoBase, origen, caso, etiqueta, aviso }` o un error.
   */
  /** 2.25.1 — El catálogo de la caché o, si no está, pedido (hasta `T.catalogo`). Nunca lanza: sin respuesta, `null`. */
  async function catalogoVigente(url) {
    const enCache = catalogoDe(url);
    if (enCache || typeof pedirCatalogo !== 'function') return enCache || null;
    let reloj = null;
    const tope = new Promise((ok) => { reloj = setTimeout(() => ok(null), T.catalogo); });
    try {
      const pedido = Promise.resolve().then(() => pedirCatalogo(url)).catch(() => null);
      return (await Promise.race([pedido, tope])) || null;
    } finally { clearTimeout(reloj); }
  }

  function armar(c, config, catalogo = catalogoDe(config.comfyui.url)) {
    if (c.desde !== undefined) return armarDesde(c.desde, config, catalogo);
    if (c.plantilla !== undefined) return armarPlantilla(c, config, catalogo);
    return armarPreparado(c.preparado, config, catalogo);
  }

  function armarDesde(ref, config, catalogo) {
    const im = imagenDe(ref);
    if (!im.ok) return im;
    const e = im.e;
    const externoBase = indice.esExterna(e);
    const origen = { tipo: 'desde', alma: ref.alma, tareaId: ref.tareaId, n: ref.n, num: Number.isInteger(e.num) ? e.num : null };
    const etiqueta = `${NOMBRE_CASO[e.caso] || 'imagen'} de ${ref.alma}${origen.num ? ` #${origen.num}` : ''}`;
    // Una del taller vuelve con su grafo guardado, tal cual.
    if (typeof e.flujo === 'string') {
      const dirF = indice.rutaDentroDe(indice.dirImagenes(ref.alma, env), e.flujo);
      const grafo = dirF ? leerJsonSeguro(path.join(dirF, 'grafo.json')) : null;
      if (!grafo || !flujosLib.formaDeGrafo(grafo).ok) return no(409, 'sin-flujo', 'El flujo guardado de esa imagen ya no está.');
      const man = (dirF && leerJsonSeguro(path.join(dirF, 'archivos.json'))) || {};
      const lista = [];
      let falta = Boolean(e.incompleto);
      for (const [orig, local] of Object.entries(man)) {
        const ruta = typeof local === 'string' && RE_LOCAL.test(local) ? indice.rutaDentroDe(dirF, path.join(dirF, local)) : null;
        if (ruta && fs.existsSync(ruta)) lista.push({ orig, ruta }); else falta = true;
      }
      return { ok: true, grafo, archivos: lista, externoBase, origen, caso: e.caso || null, etiqueta, aviso: falta ? 'Faltó un archivo del flujo (la máscara o la base): revisá los LoadImage.' : null, clave: null };
    }
    const perfil = typeof e.perfil === 'string' ? perfilesLib.perfil(config, e.perfil) : null;
    if (!perfil || (e.proveedor && e.proveedor !== 'comfyui')) return no(409, 'sin-flujo', 'Esa imagen no la hizo ComfyUI: abrila como base de una variación.');
    const caso = CASOS.includes(e.caso) ? e.caso : e.fotoRuta ? 'variacion' : 'nueva';
    let baseRuta = null;
    if (caso !== 'nueva') {
      const f = fotoDe(e.fotoRuta, 'La imagen de la que partió ya no está.');
      if (!f.ok) return f;
      baseRuta = f.ruta;
    }
    const [ancho, alto] = Number.isInteger(e.ancho) && Number.isInteger(e.alto) ? [e.ancho, e.alto] : (perfil.medidas && perfil.medidas[e.proporcion]) || [1024, 1024];
    const modelo = e.modelo || casosLib.modeloDeCaso(config, caso);
    const p = armarPedido({
      seccion: config, caso, modelo, perfil, catalogo, log, loras: lorasPorClave(config, e.lorasUsadas, modelo),
      pedido: { prompt: e.prompt || '', negativo: e.negativo || '', ancho, alto, semilla: Number.isInteger(e.semilla) ? e.semilla : undefined, fuerza: e.fuerza ?? null, zona: e.zona || '', instruccion: e.instruccion || '' }
    });
    if (!p.ok) return no(409, 'sin-flujo', `No se pudo armar su flujo${p.detalle ? ` (${p.detalle})` : ''}.`);
    return { ok: true, armado: p.armado, datos: p.datos, mascara: (p.resuelto && p.resuelto.salidaMascara) || null, base: baseRuta, externoBase, origen, caso, etiqueta, aviso: null, clave: disposicionLib.claveDeResuelto(p.resuelto), modelo };
  }

  function armarPlantilla(c, config, catalogo) {
    const id = String(c.plantilla);
    const conBase = () => {
      if (c.base === undefined) return no(400, 'base', 'Esta plantilla parte de una imagen: falta base.');
      const im = imagenDe(c.base);
      return im.ok ? { ok: true, ruta: im.ruta, externo: indice.esExterna(im.e), num: Number.isInteger(im.e.num) ? im.e.num : null, e: im.e } : im;
    };
    let m = /^plugin:(nueva|variacion|retoque|edicion)$/.exec(id);
    if (m) {
      const caso = m[1];
      if (!catalogo) return no(409, 'no-disponible', 'ComfyUI no respondió: probá de nuevo en un momento.');
      const est = casosLib.estadoComfyui(config, caso, catalogo);
      if (!est.puede) return no(409, 'no-disponible', `No se puede: ${est.motivo || 'falta algo'}.`);
      const b = caso === 'nueva' ? { ok: true, ruta: null, externo: false, num: null } : conBase();
      if (!b.ok) return b;
      const [ancho, alto] = caso === 'nueva' ? est.perfil.medidas['1:1'] : medidasParaBase(est.perfil, b.e);
      const p = armarPedido({ seccion: config, caso, modelo: est.modelo, perfil: est.perfil, catalogo, log, loras: casosLib.lorasDe(config, est.perfil.plantillas, est.modelo), pedido: { prompt: '', negativo: '', ancho, alto, zona: '', instruccion: '' } });
      if (!p.ok) return no(409, 'no-disponible', 'No se pudo armar la plantilla.');
      return { ok: true, armado: p.armado, datos: p.datos, mascara: (p.resuelto && p.resuelto.salidaMascara) || null, base: b.ruta, externoBase: b.externo, origen: { tipo: 'plantilla', plantilla: id, num: b.num }, caso, etiqueta: NOMBRE_CASO[caso], aviso: null, clave: disposicionLib.claveDeResuelto(p.resuelto), modelo: est.modelo };
    }
    if (id === 'plugin:retoque-a-mano') {
      if (!catalogo) return no(409, 'no-disponible', 'ComfyUI no respondió: probá de nuevo en un momento.');
      const fila = filaRetoqueAMano(config, catalogo);
      if (!fila.disponible) return no(409, 'no-disponible', `No se puede: ${fila.motivo}.`);
      const b = conBase();
      if (!b.ok) return b;
      const est = casosLib.estadoComfyui(config, 'variacion', catalogo);
      const [ancho, alto] = medidasParaBase(est.perfil, b.e);
      const p = armarPedido({ seccion: config, plantilla: 'retoque-a-mano', modelo: est.modelo, perfil: est.perfil, catalogo, log, pedido: { prompt: '', negativo: '', ancho, alto, fuerza: est.perfil.muestreo.fuerzaRetoque } });
      if (!p.ok) return no(409, 'no-disponible', 'No se pudo armar la plantilla.');
      return { ok: true, armado: p.armado, datos: p.datos, mascara: (p.resuelto && p.resuelto.salidaMascara) || null, base: b.ruta, externoBase: b.externo, origen: { tipo: 'plantilla', plantilla: id, num: b.num }, caso: 'retoque', etiqueta: 'retoque a mano', aviso: null, clave: disposicionLib.claveDeResuelto(p.resuelto), modelo: est.modelo };
    }
    m = /^propia:([a-z0-9]{16})$/.exec(id);
    if (m) {
      const o = leerPropia(m[1]);
      if (!o || !esObjeto(o.grafo) || !flujosLib.formaDeGrafo(o.grafo).ok) return no(404, 'no-existe', 'Esa plantilla ya no está.');
      // Si tiene un LoadImage, la lista dice `conBase`: sin base no se abre (cargaría lo que haya quedado en `input`).
      if (c.base === undefined && cargadoresDe(o.grafo).length) return no(400, 'base', 'Esta plantilla parte de una imagen: falta base.');
      let b = { ok: true, ruta: null, num: null };
      if (c.base !== undefined) b = conBase();
      if (!b.ok) return b;
      // Una plantilla propia puede cargar cualquier cosa: lo que sale de ella cuenta como de afuera.
      return { ok: true, grafo: o.grafo, baseEnPropia: b.ruta, externoBase: true, origen: { tipo: 'plantilla', plantilla: id, num: b.num }, caso: null, etiqueta: String(o.nombre || 'plantilla').slice(0, 80), aviso: null, clave: `propia:${m[1]}` };
    }
    return no(400, 'plantilla', 'No es una plantilla.');
  }

  function armarPreparado(id, config, catalogo) {
    if (typeof id !== 'string' || !RE_PREPARADO.test(id)) return no(400, 'preparado', 'No es un preparado.');
    const pr = leerJsonSeguro(path.join(dirPreparados, `${id}.json`));
    if (!pr || pr.id !== id || !vigente(pr)) return no(404, 'no-existe', 'Ese preparado ya no está.');
    const perfil = typeof pr.perfil === 'string' ? perfilesLib.perfil(config, pr.perfil) : null;
    if (!perfil) return no(409, 'sin-flujo', 'El perfil de ese preparado ya no está.');
    let baseRuta = null;
    if (pr.base) {
      const f = fotoDe(pr.base.ruta, 'La imagen de la que partía ya no está.');
      if (!f.ok) return f;
      baseRuta = f.ruta;
    }
    const p = armarPedido({
      seccion: config, caso: pr.caso, modelo: pr.modelo, perfil, catalogo, log, loras: Array.isArray(pr.loras) ? pr.loras : [],
      pedido: { prompt: pr.prompt || '', negativo: pr.negativo || '', ancho: pr.ancho, alto: pr.alto, semilla: Number.isInteger(pr.semilla) ? pr.semilla : undefined, fuerza: pr.fuerza ?? null, zona: pr.zona || '', instruccion: pr.instruccion || '' }
    });
    if (!p.ok) return no(409, 'sin-flujo', 'No se pudo armar el flujo del preparado.');
    return { ok: true, armado: p.armado, datos: p.datos, mascara: (p.resuelto && p.resuelto.salidaMascara) || null, base: baseRuta, externoBase: Boolean(pr.externo), origen: { tipo: 'preparado', tareaId: pr.tareaId, alma: pr.clave }, caso: pr.caso, etiqueta: `${NOMBRE_CASO[pr.caso] || 'imagen'} de ${pr.clave}`, aviso: null, clave: disposicionLib.claveDeResuelto(p.resuelto),
      // FEAT-218 — El modelo del preparado, y si lo eligió el refinador.
      modelo: typeof pr.modelo === 'string' ? pr.modelo : null, modeloAuto: pr.modeloAuto === true };
  }

  const vivas = () => [...sesiones.values()].filter((s) => RE_SESION.test(s.id) && s.abierta);

  /** La respuesta de `:abrir`. */
  const abierta = (s, config) => ({ ok: true, sesion: s.id, url: base(config), nombre: `Lagrange: ${s.etiqueta}`, grafo: s.grafo, aviso: s.aviso || null, disposicion: disposicionDe(s, config) });

  /** Hasta 4 abiertas: la que se abre cierra la más vieja sin actividad. */
  function aplicarTope(nueva) {
    const otras = vivas().filter((s) => s !== nueva).sort((x, y) => x.ultimaSenal - y.ultimaSenal);
    while (otras.length >= TOPE_SESIONES) { const vieja = otras.shift(); vieja.abierta = false; guardar(vieja); }
  }

  // Los pedidos en vuelo por `idCliente`: un reintento mientras el primero espera recibe la misma respuesta.
  const enVueloPorCliente = new Map();

  /** `POST /taller:abrir`. */
  function abrir(c = {}) {
    const k = esObjeto(c) && typeof c.idCliente === 'string' && RE_ID_CLIENTE.test(c.idCliente) ? c.idCliente : null;
    if (k && enVueloPorCliente.has(k)) return enVueloPorCliente.get(k);
    const p = abrirUna(c);
    if (!k) return p;
    enVueloPorCliente.set(k, p);
    return p.finally(() => enVueloPorCliente.delete(k));
  }

  async function abrirUna(c = {}) {
    const config = leerConfig();
    if (!config.taller.activo) return no(409, 'apagado', 'El taller está apagado.');
    if (!esObjeto(c)) return no(400, 'cuerpo', 'Falta el pedido.');
    if (!RE_VENTANA.test(String(c.ventana || ''))) return no(400, 'ventana', 'Falta la ventana (v- y 16 letras o números).');
    if (c.idCliente !== undefined && !RE_ID_CLIENTE.test(String(c.idCliente))) return no(400, 'idCliente', 'idCliente inválido.');
    const formas = ['desde', 'plantilla', 'preparado', 'reabrir'].filter((k) => c[k] !== undefined);
    if (formas.length !== 1) return no(400, 'forma', 'Va una de desde, plantilla, preparado o reabrir.');
    if (c.reabrir !== undefined) {
      if (!RE_SESION.test(String(c.reabrir))) return no(400, 'reabrir', 'No es una sesión.');
      const s = sesiones.get(c.reabrir);
      if (!s) return no(404, 'no-existe', 'Esa sesión ya no está.');
      if (!esLoopbackDe(config)) return no(409, 'no-loopback', 'ComfyUI tiene que estar en esta máquina.');
      const listo = await asegurarComfy(config);
      if (!listo.ok) return listo;
      Object.assign(s, { abierta: true, ultimaSenal: ms(), ventana: c.ventana, resto: null });
      aplicarTope(s);
      guardar(s);
      arrancarMirada();
      return abierta(s, config);
    }
    if (!almaExiste(c.alma)) return no(400, 'alma', 'No es un alma de esta máquina.');
    // Las formas baratas, antes de levantar ComfyUI.
    if (c.desde !== undefined && !refValida(c.desde)) return no(400, 'referencia', 'La imagen tiene que ser { alma, tareaId, n, intento }.');
    if (c.base !== undefined && !refValida(c.base)) return no(400, 'referencia', 'La imagen tiene que ser { alma, tareaId, n, intento }.');
    if (c.plantilla !== undefined && !RE_PLANTILLA.test(String(c.plantilla))) return no(400, 'plantilla', 'No es una plantilla.');
    if (c.preparado !== undefined && !RE_PREPARADO.test(String(c.preparado))) return no(400, 'preparado', 'No es un preparado.');
    if (c.idCliente) {
      const ya = [...sesiones.values()].find((s) => s.idCliente === c.idCliente && RE_SESION.test(s.id));
      if (ya) return abierta(ya, config);
    }
    // Lo que preparó el alma se abre una vez por ventana: otro «Abrir» (el automático y el botón del turno) trae la misma
    // sesión, con lo que se haya hecho en ella, en vez de otra vacía.
    const pr = c.preparado !== undefined ? leerJsonSeguro(path.join(dirPreparados, `${c.preparado}.json`)) : null;
    if (pr && pr.id === c.preparado && vigente(pr)) {
      const ya = [...sesiones.values()].find((s) => s.preparado === c.preparado && s.ventana === c.ventana && s.abierta && RE_SESION.test(s.id));
      if (ya) { ya.ultimaSenal = ms(); return abierta(ya, config); }
    }
    if (!esLoopbackDe(config)) return no(409, 'no-loopback', 'ComfyUI tiene que estar en esta máquina.');
    const listo = await asegurarComfy(config);
    if (!listo.ok) return listo;
    // Recién levantado, ComfyUI olvidó el catálogo: se pide otra vez.
    const a = armar(c, config, await catalogoVigente(config.comfyui.url));
    if (!a.ok) return a;
    // 6 — Con `mirar` apagado no se pregunta el historial. Si no se pudo leer, no se sabe qué había: no se abre.
    const vistos = config.taller.mirar === false ? [] : await idsDelHistorial(config, 200);
    if (!vistos) return no(503, 'sin-comfy', 'ComfyUI no dio su historial: probá de nuevo en un momento.');
    const id = `s-${id16()}`;
    const json = jsonDe(config);
    const subidos = [];
    let grafo;
    try {
      if (a.datos) {
        if (a.base) { a.datos.foto = await subirBase({ json, foto: a.base }); subidos.push(a.datos.foto); }
        grafo = flujosLib.aplicarMarcadores(titular(a.armado, a.mascara), a.datos);
      } else {
        grafo = clon(a.grafo);
        for (const f of a.archivos || []) { const nuevo = await subirBase({ json, foto: f.ruta }); subidos.push(nuevo); renombrar(grafo, f.orig, nuevo); }
        if (a.baseEnPropia) {
          const nombre = await subirBase({ json, foto: a.baseEnPropia });
          subidos.push(nombre);
          const primero = cargadoresDe(grafo)[0];
          if (primero) grafo[primero[0]].inputs.image = nombre;
        }
      }
    } catch (err) {
      log(`[taller] no se pudo subir la base: ${String(err.message).slice(0, 200)}`);
      return no(503, 'sin-comfy', 'ComfyUI no aceptó la imagen de base.');
    }
    prefijar(grafo, id);
    const nodosBase = cargadoresDe(grafo).filter(([, nombre]) => subidos.includes(nombre)).map(([nodo]) => nodo);
    const s = {
      id, alma: c.alma, ventana: c.ventana, idCliente: c.idCliente || null, origen: a.origen, caso: a.caso, etiqueta: a.etiqueta, aviso: a.aviso || (a.armado && usaMarcador(a.armado, 'zona') && !(a.datos && a.datos.zona) ? 'Escribí qué parte retocar en el nodo «Zona a retocar»: sin eso, la máscara sale vacía o al azar.' : null),
      clientId: null, vistos, abierta: true, ultimaSenal: ms(), creada: ahora().toISOString(),
      preparado: c.preparado !== undefined ? String(c.preparado) : null, clave: disposicionLib.validarClave(a.clave),
      // FEAT-218 — Con qué modelo se armó (`null` en una propia: su grafo trae su loader), y si lo eligió el refinador.
      modelo: modeloValido(a.modelo), modeloAuto: a.modeloAuto === true,
      grafo, subidos, nodosBase, externoBase: Boolean(a.externoBase), baseRuta: a.base || a.baseEnPropia || null, imagenes: {}, entradas: {}, salidas: [], enCurso: []
    };
    sesiones.set(id, s);
    aplicarTope(s);
    guardar(s);
    arrancarMirada();
    anotarUso(config, true);
    return abierta(s, config);
  }

  const esLoopbackDe = (config) => ajustes.esLoopback(config.comfyui.url);

  // ---------------------------------------------------------------- Mirar el historial.
  function anotarUso(config, ya = false) {
    if (!proceso || (!ya && ms() - ultimoUso < T.uso)) return;
    ultimoUso = ms();
    try { proceso.anotarUso(config); } catch {}
  }

  function arrancarMirada() {
    if (reloj) return;
    reloj = setInterval(() => { vuelta().catch((err) => log(`[taller] la vuelta falló: ${String(err.message).slice(0, 200)}`)); }, T.vuelta);
    reloj.unref?.();
  }

  /** Lo de la ventana: una sesión más, `v-<ventana>`, que se crea al primero que llega. */
  function deLaVentana(ventana) {
    if (!RE_VENTANA.test(String(ventana))) return null;
    const id = `v-${String(ventana).slice(2)}`;
    let s = sesiones.get(id);
    if (!s) {
      s = { id, alma: null, ventana, origen: { tipo: 'ventana' }, caso: null, etiqueta: 'de la ventana', aviso: null, clientId: null, vistos: [], abierta: true, ultimaSenal: ms(), creada: ahora().toISOString(), grafo: null, subidos: [], nodosBase: [], externoBase: false, baseRuta: null, imagenes: {}, entradas: {}, salidas: [], enCurso: [] };
      sesiones.set(id, s);
    }
    return s;
  }

  /** De qué sesión es una entrada: por su carpeta de salida y, si no, por el `client_id` de una ventana. */
  function duenoDe(grafo, salidas, clientId, abiertas) {
    const deCarpeta = (sub) => { const m = /^lagrange-taller\/(s-[a-z0-9]{16})(\/|$)/.exec(String(sub || '').replace(/\\/g, '/')); return m && sesiones.has(m[1]) ? sesiones.get(m[1]) : null; };
    for (const img of salidas) { const s = deCarpeta(img.subfolder); if (s) return s; }
    for (const n of Object.values(esObjeto(grafo) ? grafo : {})) {
      if (esObjeto(n) && n.class_type === 'SaveImage' && esObjeto(n.inputs) && typeof n.inputs.filename_prefix === 'string') { const s = deCarpeta(n.inputs.filename_prefix); if (s) return s; }
    }
    if (typeof clientId === 'string' && clientId) {
      const s = abiertas.find((x) => x.clientId === clientId) || [...sesiones.values()].find((x) => RE_VENTANA.test(x.id) && x.abierta && x.clientId === clientId);
      if (s) return deLaVentana(s.ventana);
    }
    return null;
  }

  /** ¿Esta imagen trae algo de afuera? La confianza de su base, o un archivo de `input` que no es de la sesión. */
  function externaSegun(s, grafo, abiertas) {
    const mias = s.id.startsWith('v-') ? abiertas.filter((x) => x.ventana === s.ventana) : [s];
    if (mias.some((x) => x.externoBase) || (s.id.startsWith('v-') && !mias.length)) return true;
    const subidos = new Set(mias.flatMap((x) => x.subidos || []));
    const nodosBase = new Set(mias.flatMap((x) => x.nodosBase || []));
    return cargadoresDe(grafo).some(([nodo, nombre]) => {
      const limpio = sinMarca(nombre);
      if (subidos.has(limpio)) return false;
      // El editor de máscaras guarda lo que pinta el usuario en `clipspace/`, en el nodo que tenía la base.
      return !(limpio.startsWith('clipspace/') && nodosBase.has(nodo));
    });
  }

  async function bajar(config, consulta, s, prefijo) {
    const r = await pedir(config, `/view?${new URLSearchParams(consulta)}`);
    if (!r.ok) return null;
    const bytes = await leerHasta(r, TOPE_BYTES);
    if (!bytes || !bytes.length) return null;
    const ext = extDe(tipoDe(consulta.filename));
    const nombre = `${prefijo}-${id16()}.${ext}`;
    const ruta = rutaLocal(s, nombre);
    if (!ruta) return null;
    fs.writeFileSync(ruta, bytes);
    return { nombre, bytes, tipo: tipoDe(consulta.filename) };
  }

  /** Los archivos de `input` que nombra un grafo, a la carpeta de la sesión (la máscara pintada vive solo en ComfyUI). */
  async function bajarEntradas(config, s, grafo) {
    for (const [, nombre] of cargadoresDe(grafo)) {
      if (Object.hasOwn(s.entradas, nombre)) continue;
      const tipo = /\s\[(output|temp)\]$/.exec(nombre);
      const remoto = nombreRemoto(sinMarca(nombre));
      s.entradas[nombre] = null;
      if (!remoto) continue;
      try {
        const b = await bajar(config, { ...remoto, type: tipo ? tipo[1] : 'input' }, s, 'input');
        if (b) s.entradas[nombre] = b.nombre;
      } catch {}
    }
  }

  async function procesar(config, s, pid, entrada, abiertas) {
    const grafo = Array.isArray(entrada.prompt) && esObjeto(entrada.prompt[2]) ? entrada.prompt[2] : {};
    s.vistos.push(pid);
    while (s.vistos.length > TOPE_VISTOS) s.vistos.shift();
    const creada = ahora().toISOString();
    if (entrada.status && entrada.status.status_str === 'error') {
      const id = `img-${id16()}`;
      s.imagenes[id] = { id, estado: 'error', promptId: pid, creada, error: errorDe(entrada) };
      publicar('salud', 'taller.imagen', { sesion: s.id, id, estado: 'error' });
      return;
    }
    await bajarEntradas(config, s, grafo);
    const externo = externaSegun(s, grafo, abiertas);
    const g = `g-${id16()}.json`;
    const rg = rutaLocal(s, g);
    if (rg) fs.writeFileSync(rg, JSON.stringify(grafo));
    const semilla = semillaDe(grafo);
    const prompt = promptDe(grafo);
    for (const [nodo, out] of Object.entries(esObjeto(entrada.outputs) ? entrada.outputs : {})) {
      const imgs = esObjeto(out) && Array.isArray(out.images) ? out.images : [];
      for (const [i, img] of imgs.entries()) {
        if (!esObjeto(img) || !['output', 'temp'].includes(img.type)) continue;
        if (img.type === 'temp' && esVistaDeMascara(grafo, nodo)) continue;
        const remoto = nombreRemoto(String(img.filename || ''), String(img.subfolder || ''));
        if (!remoto) continue;
        let b = null;
        try { b = await bajar(config, { ...remoto, type: img.type }, s, 'img'); } catch {}
        if (!b) continue;
        const id = `img-${b.nombre.slice(4, 20)}`;
        const m = medidasDe(b.bytes);
        s.salidas.push(`${remoto.subfolder}/${remoto.filename}`);
        s.imagenes[id] = {
          id, estado: 'lista', archivo: b.nombre, tipo: b.tipo, promptId: pid, nodo: String(nodo).slice(0, 40), indice: i, creada,
          ancho: m ? m.ancho : null, alto: m ? m.alto : null, bytes: b.bytes.length, semilla, prompt, grafo: rg ? g : null, externo
        };
        publicar('salud', 'taller.imagen', { sesion: s.id, id, estado: 'lista' });
      }
    }
  }

  /** Lo que corre o espera en ComfyUI, por sesión. */
  function enCursoDe(q, abiertas) {
    for (const s of sesiones.values()) s.enCurso = [];
    for (const e of [...(Array.isArray(q.queue_running) ? q.queue_running : []), ...(Array.isArray(q.queue_pending) ? q.queue_pending : [])]) {
      if (!Array.isArray(e) || typeof e[1] !== 'string') continue;
      const s = duenoDe(e[2], [], esObjeto(e[3]) ? e[3].client_id : null, abiertas);
      if (s && s.enCurso.length < 20) s.enCurso.push(e[1].slice(0, 64));
    }
  }

  /** Si ComfyUI perdió su historial: lo que quedó en su carpeta de salida y no se bajó (más de un minuto atrás). */
  function leerDelDisco(config, abiertas) {
    if (ms() - ultimoDisco < T.disco) return;
    ultimoDisco = ms();
    const a = config.comfyui.arranque || {};
    if (!a.carpeta) return;
    const inst = procesoLib.resolverInstalacion(a.carpeta);
    if (!inst.ok) return;
    const flag = (Array.isArray(a.flags) ? a.flags : []).find((f) => f && f.flag === '--output-directory' && typeof f.valor === 'string' && f.valor);
    const salida = flag ? path.resolve(inst.cwd, flag.valor) : path.join(path.dirname(inst.main), 'output');
    for (const s of abiertas) {
      const carpeta = path.join(salida, 'lagrange-taller', s.id);
      let nombres = [];
      try { nombres = fs.readdirSync(carpeta); } catch { continue; }
      for (const f of nombres) {
        const clave = `lagrange-taller/${s.id}/${f}`;
        if (!/\.(png|jpe?g|webp)$/i.test(f) || s.salidas.includes(clave)) continue;
        const ruta = indice.rutaDentroDe(carpeta, path.join(carpeta, f));
        let st;
        try { st = ruta && fs.statSync(ruta); } catch { continue; }
        if (!st || !st.isFile() || st.size > TOPE_BYTES || ms() - st.mtimeMs < DISCO_VIEJO_MS) continue;
        const bytes = fs.readFileSync(ruta);
        const tipo = tipoDe(f);
        const nombre = `img-${id16()}.${extDe(tipo)}`;
        const local = rutaLocal(s, nombre);
        if (!local) continue;
        fs.writeFileSync(local, bytes);
        s.salidas.push(clave);
        const m = medidasDe(bytes);
        const id = `img-${nombre.slice(4, 20)}`;
        // Sin el grafo no se sabe qué cargó: cuenta como de afuera.
        s.imagenes[id] = { id, estado: 'lista', archivo: nombre, tipo, promptId: null, nodo: null, indice: 0, creada: ahora().toISOString(), ancho: m ? m.ancho : null, alto: m ? m.alto : null, bytes: bytes.length, semilla: null, prompt: null, grafo: null, externo: true, delDisco: true };
        guardar(s);
        publicar('salud', 'taller.imagen', { sesion: s.id, id, estado: 'lista' });
      }
    }
  }

  async function vuelta() {
    if (enVuelta) return;
    for (const s of vivas()) if (ms() - s.ultimaSenal > T.senal) { s.abierta = false; guardar(s); }
    const abiertas = vivas();
    if (!abiertas.length) {
      clearInterval(reloj);
      reloj = null;
      for (const s of sesiones.values()) if (RE_VENTANA.test(s.id) && s.abierta) { s.abierta = false; guardar(s); }
      return;
    }
    const config = leerConfig();
    // Una sesión viva cuenta como uso para el apagado de ComfyUI, mirando o no.
    anotarUso(config);
    if (!config.taller.mirar) { for (const s of sesiones.values()) s.enCurso = []; sinComfy = false; return; }
    if (ms() < siguienteEn) return;
    enVuelta = true;
    try {
      const json = jsonDe(config);
      const h = await json(`/history?max_items=${primera ? 200 : 30}`);
      const q = await json('/queue');
      primera = false;
      fallosSeguidos = 0;
      sinComfy = false;
      enCursoDe(esObjeto(q) ? q : {}, abiertas);
      const tocadas = new Set();
      for (const [pid, entrada] of Object.entries(esObjeto(h) ? h : {})) {
        if (!esObjeto(entrada) || !esObjeto(entrada.status) || (!entrada.status.completed && entrada.status.status_str !== 'error')) continue;
        const salidas = Object.values(esObjeto(entrada.outputs) ? entrada.outputs : {}).flatMap((o) => (esObjeto(o) && Array.isArray(o.images) ? o.images : []));
        const clientId = Array.isArray(entrada.prompt) && esObjeto(entrada.prompt[3]) ? entrada.prompt[3].client_id : null;
        const s = duenoDe(Array.isArray(entrada.prompt) ? entrada.prompt[2] : null, salidas, clientId, abiertas);
        if (!s || s.vistos.includes(pid)) continue;
        // Lo que había al abrir la sesión de esa ventana no cuenta.
        if (s.id.startsWith('v-') && abiertas.some((x) => x.ventana === s.ventana && x.vistos.includes(pid))) { s.vistos.push(pid); continue; }
        await procesar(config, s, pid, entrada, abiertas);
        tocadas.add(s);
        // Lo que termina después de `:cerrar` sigue la decisión de ese cierre.
        if (!s.abierta && s.resto) await aplicarResto(s);
      }
      for (const s of tocadas) guardar(s);
      leerDelDisco(config, abiertas);
    } catch (err) {
      fallosSeguidos++;
      sinComfy = true;
      siguienteEn = ms() + Math.min(30000, T.vuelta * 2 ** Math.min(fallosSeguidos, 4));
      if (fallosSeguidos === 1) log(`[taller] ComfyUI no responde al historial: ${String(err.message).slice(0, 120)}`);
    } finally {
      enVuelta = false;
    }
  }

  // ---------------------------------------------------------------- Lo que pide la terminal.
  const sesionDe = (id) => ((RE_SESION.test(String(id)) || RE_VENTANA.test(String(id))) ? sesiones.get(id) || null : undefined);
  const activo = () => { const c = leerConfig(); return c.taller.activo ? null : no(409, 'apagado', 'El taller está apagado.'); };

  function sigue(id, c = {}) {
    const ap = activo(); if (ap) return ap;
    if (!RE_SESION.test(String(id))) return no(400, 'sesion', 'No es una sesión.');
    const s = sesiones.get(id);
    if (!s || !s.abierta) return no(410, 'cerrada', 'Esa sesión se cerró: abrila de nuevo.');
    if (c.clientId !== undefined) {
      if (typeof c.clientId !== 'string' || !RE_CLIENTE.test(c.clientId)) return no(400, 'clientId', 'clientId inválido.');
      s.clientId = c.clientId;
    }
    s.ultimaSenal = ms();
    const v = sesiones.get(`v-${String(s.ventana).slice(2)}`);
    if (v) { v.abierta = true; v.resto = null; v.ultimaSenal = ms(); if (c.clientId !== undefined) v.clientId = c.clientId; }
    guardar(s);
    arrancarMirada();
    return { ok: true };
  }

  function fila(img) {
    return { id: img.id, estado: img.estado, creada: img.creada, ancho: img.ancho ?? null, alto: img.alto ?? null, semilla: img.semilla ?? null, bytes: img.bytes ?? null, error: img.error || null, externo: img.externo !== false };
  }

  function estado(id) {
    const ap = activo(); if (ap) return ap;
    const s = sesionDe(id);
    if (s === undefined) return no(400, 'sesion', 'No es una sesión.');
    if (!s) return no(404, 'no-existe', 'Esa sesión no está.');
    const config = leerConfig();
    return {
      ok: true, sesion: s.id, alma: s.alma, origen: s.origen, aviso: s.aviso || null, abierta: Boolean(s.abierta), mirando: Boolean(reloj) && config.taller.mirar !== false, sinComfy,
      enCurso: s.enCurso || [], grafo: s.grafo, imagenes: Object.values(s.imagenes).sort((a, b) => (a.creada < b.creada ? 1 : -1)).map(fila),
      disposicion: disposicionDe(s, config)
    };
  }

  function imagenDeSesion(id, imgId) {
    const s = sesionDe(id);
    if (s === undefined) return no(400, 'sesion', 'No es una sesión.');
    if (!s) return no(404, 'no-existe', 'Esa sesión no está.');
    if (!RE_IMAGEN.test(String(imgId))) return no(400, 'imagen', 'No es una imagen del taller.');
    const img = s.imagenes[imgId];
    if (!img) return no(404, 'no-existe', 'Esa imagen no está.');
    return { ok: true, s, img };
  }

  function bytes(id, imgId) {
    const ap = activo(); if (ap) return ap;
    const r = imagenDeSesion(id, imgId);
    if (!r.ok) return r;
    if (r.img.estado !== 'lista') return no(404, 'no-existe', 'Esa imagen no está.');
    const ruta = rutaLocal(r.s, r.img.archivo);
    try { return { ok: true, bytes: fs.readFileSync(ruta), tipo: r.img.tipo || 'image/png' }; } catch { return no(404, 'no-existe', 'Esa imagen no está.'); }
  }

  /** Pasa una imagen de la sesión a la galería de un alma. */
  async function quedar(id, imgId, c = {}) {
    const ap = activo(); if (ap) return ap;
    const r = imagenDeSesion(id, imgId);
    if (!r.ok) return r;
    const { s, img } = r;
    if (img.estado !== 'lista') return no(409, 'decidida', img.estado === 'quedada' ? 'Ya te la quedaste.' : 'Esa imagen ya no está.');
    if (!esObjeto(c) || !almaExiste(c.alma)) return no(400, 'alma', 'No es un alma de esta máquina.');
    const alma = c.alma;
    let datos;
    try { datos = fs.readFileSync(rutaLocal(s, img.archivo)); } catch { return no(404, 'no-existe', 'Esa imagen ya no está.'); }
    const tareaId = `t_taller${id16()}`;
    const tipo = img.tipo || 'image/png';
    const final = indice.rutaArchivo(alma, tareaId, 1, 1, extDe(tipo), env);
    fs.mkdirSync(path.dirname(final), { recursive: true });
    fs.writeFileSync(final, datos);
    // El grafo, con los archivos de `input` que nombra (los que la sesión ya bajó).
    const dirF = path.join(indice.dirImagenes(alma, env), 'flujos', `${tareaId}-1`);
    let flujo = null;
    let incompleto = false;
    const grafo = img.grafo ? leerJsonSeguro(rutaLocal(s, img.grafo)) : null;
    if (grafo) {
      fs.mkdirSync(dirF, { recursive: true });
      fs.writeFileSync(path.join(dirF, 'grafo.json'), JSON.stringify(grafo));
      const man = {};
      for (const [, nombre] of cargadoresDe(grafo)) {
        if (Object.hasOwn(man, nombre)) continue;
        const local = s.entradas && s.entradas[nombre];
        const origen = local ? rutaLocal(s, local) : null;
        if (!origen || !fs.existsSync(origen)) { incompleto = true; continue; }
        const copia = `input-${id16()}.${local.split('.').pop()}`;
        fs.copyFileSync(origen, path.join(dirF, copia));
        man[nombre] = copia;
      }
      fs.writeFileSync(path.join(dirF, 'archivos.json'), JSON.stringify(man));
      flujo = dirF;
    }
    let num = null;
    for (let i = 0; !num && i < 5; i++) {
      try { num = indice.tomarNumero(alma, env, { esperaMs: 0 }); } catch { await dormir(100); }
    }
    const m = medidasDe(datos);
    indice.actualizar(alma, tareaId, 1, () => ({
      ...camposDeImagen({
        archivo: final, tipo, foto: null, hilo: null, externo: img.externo !== false, sha256: indice.sha256(datos), prompt: img.prompt || '', negativo: '', proporcion: null,
        semilla: img.semilla, perfil: null, proveedor: 'comfyui', modelo: s.modelo || null, ancho: m ? m.ancho : img.ancho, alto: m ? m.alto : img.alto, bytes: datos.length,
        cambio: null, fuerza: null, lorasUsadas: [], vistaEstado: null, ahora: ahora(), intento: 1, num,
        // FEAT-218 — El modelo con que se armó la sesión; elegido por el refinador solo en un preparado que lo trae.
        modeloAuto: s.modeloAuto === true && Boolean(s.modelo)
      }),
      caso: s.caso && CASOS.includes(s.caso) ? s.caso : null, casoPedido: null, zona: '', instruccion: '', loras: [], origen: 'taller', deNum: null,
      baseNum: s.origen && Number.isInteger(s.origen.num) ? s.origen.num : null, elegida: null, baseFija: false, fotoOpcional: false,
      telegram: { sha256: null, envio: null }, flujo, incompleto
    }), env);
    try { cola && cola.podar(alma, { tareaId, n: 1 }); } catch (err) { log(`[taller] no se pudo podar ${alma}: ${err.message}`); }
    try { cola && cola.invalidarMapas(); } catch {}
    try { alCambiar(alma); } catch {}
    img.estado = 'quedada';
    try { fs.rmSync(rutaLocal(s, img.archivo), { force: true }); } catch {}
    guardar(s);
    publicar('salud', 'taller.imagen', { sesion: s.id, id: img.id, estado: 'quedada' });
    return { ok: true, alma, tareaId, n: 1, intento: 1, num };
  }

  function descartar(id, imgId) {
    const ap = activo(); if (ap) return ap;
    const r = imagenDeSesion(id, imgId);
    if (!r.ok) return r;
    if (!['lista', 'error'].includes(r.img.estado)) return no(409, 'decidida', 'Esa imagen ya se decidió.');
    if (r.img.archivo) { try { fs.rmSync(rutaLocal(r.s, r.img.archivo), { force: true }); } catch {} }
    r.img.estado = 'descartada';
    guardar(r.s);
    publicar('salud', 'taller.imagen', { sesion: r.s.id, id: r.img.id, estado: 'descartada' });
    return { ok: true };
  }

  async function cerrar(id, c = {}) {
    const ap = activo(); if (ap) return ap;
    const s = sesionDe(id);
    if (s === undefined) return no(400, 'sesion', 'No es una sesión.');
    if (!s) return no(404, 'no-existe', 'Esa sesión no está.');
    if (!esObjeto(c) || !['descartar', 'quedar'].includes(c.resto)) return no(400, 'resto', 'resto tiene que ser descartar o quedar.');
    if (c.resto === 'quedar' && !almaExiste(c.alma)) return no(400, 'alma', 'No es un alma de esta máquina.');
    s.resto = { resto: c.resto, alma: c.resto === 'quedar' ? c.alma : null };
    s.abierta = false;
    const resultados = await aplicarResto(s);
    guardar(s);
    return { ok: true, resultados };
  }

  /** Aplica a lo que queda sin decidir la decisión del último `:cerrar` (también a lo que termina después). */
  async function aplicarResto(s) {
    const { resto, alma } = s.resto || {};
    const resultados = [];
    if (!resto) return resultados;
    for (const img of Object.values(s.imagenes)) {
      if (img.estado !== 'lista' && !(resto === 'descartar' && img.estado === 'error')) continue;
      const r = resto === 'quedar' ? await quedar(s.id, img.id, { alma }) : descartar(s.id, img.id);
      resultados.push({ id: img.id, ok: r.ok !== false });
    }
    return resultados;
  }

  // ---------------------------------------------------------------- FEAT-217 — La disposición de los nodos.
  const rutaPropia = (id) => path.join(dirPlantillas, `${id}.json`);
  /** Una plantilla propia, leída con tope (`statSync` antes de leer); `null` si no está o pesa más de 2,5 MB. */
  const leerPropia = (id) => (RE_PROPIA.test(String(id)) ? disposicionLib.leerJsonHasta(rutaPropia(id), TOPE_PROPIA) : null);
  /** El archivo de la del usuario para una clave `plugin:` o `flujo:`. */
  const archivoDisposicion = (clave) => path.join(dirDisposiciones, `${crypto.createHash('sha1').update(clave).digest('hex').slice(0, 16)}.json`);
  /** Una disposición ya validada, o `null` si no está o no vale. */
  const validada = (d) => { if (d === undefined || d === null) return null; const v = disposicionLib.validarDisposicion(d); return v.ok ? v.disposicion : null; };

  /** La del usuario para una clave: dentro de su plantilla propia o en `disposiciones/`. Una que no vale cuenta como que no está. */
  function deUsuario(clave) {
    if (clave.startsWith('propia:')) { const o = leerPropia(clave.slice(7)); return o ? validada(o.disposicion) : null; }
    const o = disposicionLib.leerJsonHasta(archivoDisposicion(clave), disposicionLib.TOPE_ARCHIVO);
    return o && o.clave === clave ? validada(o.disposicion) : null;
  }

  /** La del plugin para una clave, si la casilla está prendida. */
  const delPluginSegun = (clave, config) => (clave && clave.startsWith('plugin:') && config.taller.disposicion_plugin !== false ? disposicionLib.delPlugin(clave) : null);

  /**
   * La disposición de una sesión: `{ clave, guardada, deUsuario, delPlugin }`. `guardada` es la que se aplica (la del usuario y, si
   * no hay, la del plugin); con la casilla apagada, nunca es la del plugin. La usan `:abrir`, el estado y `:disposicion-borrar`.
   */
  function disposicionDe(s, config) {
    const clave = disposicionLib.validarClave(s && s.clave);
    if (!clave) return { clave: null, guardada: null, deUsuario: false, delPlugin: null };
    const usuario = deUsuario(clave);
    const plugin = delPluginSegun(clave, config);
    return { clave, guardada: usuario || plugin, deUsuario: Boolean(usuario), delPlugin: plugin };
  }

  /** Lo que dice cada fila del plugin de la lista de plantillas. */
  const marcasDeFila = (clave, config) => ({ conDisposicion: Boolean(clave && deUsuario(clave)), disposicionDelPlugin: Boolean(delPluginSegun(clave, config)) });

  /** La sesión y su clave, o el error: 409 `sin-clave` si no tiene a qué guardarle la disposición. */
  function sesionConClave(id) {
    const s = sesionDe(id);
    if (s === undefined) return no(400, 'sesion', 'No es una sesión.');
    if (!s) return no(404, 'no-existe', 'Esa sesión no está.');
    const clave = disposicionLib.validarClave(s.clave);
    if (!clave) return no(409, 'sin-clave', 'Este flujo no es de una plantilla: no tiene a qué guardarle la disposición.');
    return { ok: true, s, clave };
  }

  /** `POST /taller/<sesion>:disposicion`: guarda la del usuario según la clave de la sesión. `{ ok, clave }`. */
  function guardarDisposicion(id, c = {}) {
    const ap = activo(); if (ap) return ap;
    const r = sesionConClave(id);
    if (!r.ok) return r;
    const v = disposicionLib.validarDisposicion(esObjeto(c) ? c.disposicion : undefined);
    if (!v.ok) return { ...no(400, 'disposicion', `La disposición no vale: ${v.campo} ${v.motivo}.`), campo: v.campo };
    if (r.clave.startsWith('propia:')) {
      const pid = r.clave.slice(7);
      const o = leerPropia(pid);
      if (!o) return no(404, 'no-existe', 'Esa plantilla ya no está.');
      // El archivo nunca pasa el tope con que se lee: si no, la plantilla dejaría de verse y no se podría deshacer.
      const texto = `${JSON.stringify({ ...o, disposicion: v.disposicion })}\n`;
      if (Buffer.byteLength(texto) > TOPE_PROPIA) return no(413, 'grande', 'Con esa disposición, la plantilla pasaría los 2,5 MB: no se guardó.');
      archivos.escribirAtomico(rutaPropia(pid), texto);
      return { ok: true, clave: r.clave };
    }
    const ruta = archivoDisposicion(r.clave);
    if (!fs.existsSync(ruta)) {
      let cuantas = 0;
      try { cuantas = fs.readdirSync(dirDisposiciones).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)).length; } catch {}
      if (cuantas >= TOPE_DISPOSICIONES) return no(409, 'tope', `Ya hay ${TOPE_DISPOSICIONES} disposiciones guardadas: volvé alguna plantilla al acomodo automático.`);
    }
    fs.mkdirSync(dirDisposiciones, { recursive: true });
    archivos.escribirAtomico(ruta, `${JSON.stringify({ clave: r.clave, disposicion: v.disposicion, guardada: ahora().toISOString() })}\n`);
    return { ok: true, clave: r.clave };
  }

  /** `POST /taller/<sesion>:disposicion-borrar` («Acomodo automático»): `{ ok, borrada, delPlugin }`. */
  function borrarDisposicion(id) {
    const ap = activo(); if (ap) return ap;
    const r = sesionConClave(id);
    if (!r.ok) return r;
    const borrada = deUsuario(r.clave);
    if (r.clave.startsWith('propia:')) {
      const pid = r.clave.slice(7);
      const o = leerPropia(pid);
      if (!o) return no(404, 'no-existe', 'Esa plantilla ya no está.');
      if (Object.hasOwn(o, 'disposicion')) {
        const { disposicion: _fuera, ...resto } = o;
        archivos.escribirAtomico(rutaPropia(pid), `${JSON.stringify(resto)}\n`);
      }
    } else {
      try { fs.rmSync(archivoDisposicion(r.clave), { force: true }); } catch {}
    }
    return { ok: true, borrada, delPlugin: disposicionDe(r.s, leerConfig()).delPlugin };
  }

  // ---------------------------------------------------------------- Plantillas.
  function filaRetoqueAMano(config, catalogo) {
    const est = casosLib.estadoComfyui(config, 'variacion', catalogo);
    const r = flujosLib.resolverPlantillaTaller(est.perfil, 'retoque-a-mano');
    const fila = { id: 'plugin:retoque-a-mano', nombre: 'Retoque a mano', caso: 'retoque', perfil: est.perfil ? est.perfil.id : null, modelo: est.modelo || null, conBase: true, disponible: false, motivo: null, ...marcasDeFila(disposicionLib.claveDeResuelto(r), config) };
    if (!catalogo) return { ...fila, motivo: 'ComfyUI no respondió' };
    if (!r.ok) return { ...fila, motivo: r.motivo };
    if (!est.modelo) return { ...fila, motivo: 'falta el modelo' };
    const f = flujosLib.faltantes(r, casosLib.valoresDeCarga(est.modelo, est.perfil), catalogo);
    if (f.faltan.archivos.length) return { ...fila, motivo: 'falta el modelo' };
    if (f.faltan.nodos.length) return { ...fila, motivo: 'faltan nodos de ComfyUI' };
    return { ...fila, disponible: true };
  }

  /** ¿El grafo nombra un modelo que ComfyUI no tiene? (los loaders conocidos). */
  function modelosQueFaltan(grafo, catalogo) {
    const de = { CheckpointLoaderSimple: [['ckpt_name', 'checkpoints']], UNETLoader: [['unet_name', 'unets']], DualCLIPLoader: [['clip_name1', 'clips'], ['clip_name2', 'clips']], VAELoader: [['vae_name', 'vaes']] };
    return Object.values(grafo).some((n) => esObjeto(n) && esObjeto(n.inputs) && (de[n.class_type] || []).some(([k, lista]) => typeof n.inputs[k] === 'string' && !perfilesLib.enLista(catalogo[lista], n.inputs[k])));
  }

  /** 2.25.1 — La lista de la galería («Taller…»): con el catálogo de la caché o, si no está, pedido. */
  async function listarPlantillas() {
    const ap = activo(); if (ap) return ap;
    return plantillas(await catalogoVigente(leerConfig().comfyui.url));
  }

  function plantillas(conCatalogo) {
    const ap = activo(); if (ap) return ap;
    const config = leerConfig();
    const catalogo = conCatalogo !== undefined ? conCatalogo : catalogoDe(config.comfyui.url);
    const lista = CASOS.map((caso) => {
      const est = casosLib.estadoComfyui(config, caso, catalogo);
      return {
        id: `plugin:${caso}`, nombre: NOMBRE_CASO[caso].replace(/^./, (x) => x.toUpperCase()), caso, perfil: est.perfil ? est.perfil.id : null, modelo: est.modelo || null,
        conBase: caso !== 'nueva', disponible: Boolean(catalogo) && est.puede, motivo: !catalogo ? 'ComfyUI no respondió' : est.puede ? null : est.motivo,
        ...marcasDeFila(disposicionLib.claveDeResuelto(est.resuelto), config)
      };
    });
    lista.push(filaRetoqueAMano(config, catalogo));
    let nombres = [];
    try { nombres = fs.readdirSync(dirPlantillas); } catch {}
    for (const f of nombres) {
      const m = /^([a-z0-9]{16})\.json$/.exec(f);
      const o = m ? leerPropia(m[1]) : null;
      if (!o || !esObjeto(o.grafo)) continue;
      const clases = Object.values(o.grafo).filter(esObjeto).map((n) => n.class_type);
      const faltan = catalogo ? clases.filter((cl) => !catalogo.nodos.has(cl)) : [];
      const faltaModelo = catalogo ? modelosQueFaltan(o.grafo, catalogo) : false;
      lista.push({
        id: `propia:${m[1]}`, nombre: String(o.nombre || '').slice(0, 80), caso: null, perfil: null, modelo: null, conBase: cargadoresDe(o.grafo).length > 0,
        disponible: Boolean(catalogo) && !faltan.length && !faltaModelo, motivo: !catalogo ? 'ComfyUI no respondió' : faltan.length ? 'faltan nodos de ComfyUI' : faltaModelo ? 'falta el modelo' : null, creada: typeof o.creada === 'string' ? o.creada : null,
        conDisposicion: validada(o.disposicion) !== null
      });
    }
    return { ok: true, plantillas: lista };
  }

  function guardarPlantilla(c = {}) {
    const ap = activo(); if (ap) return ap;
    if (!esObjeto(c)) return no(400, 'cuerpo', 'Falta el pedido.');
    const nombre = typeof c.nombre === 'string' ? c.nombre.trim() : '';
    if (!nombre || nombre.length > 80 || CONTROLES.test(nombre)) return no(400, 'nombre', 'El nombre tiene que tener de 1 a 80 caracteres.');
    const forma = flujosLib.formaDeGrafo(c.grafo);
    if (!forma.ok) return no(400, 'grafo', forma.motivo);
    let cuantas = 0;
    try { cuantas = fs.readdirSync(dirPlantillas).filter((f) => /^[a-z0-9]{16}\.json$/.test(f)).length; } catch {}
    if (cuantas >= TOPE_PLANTILLAS) return no(409, 'tope', `Ya hay ${TOPE_PLANTILLAS} plantillas: borrá alguna.`);
    // FEAT-217 — «Siempre» no depende de un tope visual: si la disposición no vale, la plantilla se guarda sin ella.
    let disposicion = null;
    let sinDisposicion = null;
    if (c.disposicion !== undefined && c.disposicion !== null) {
      const v = disposicionLib.validarDisposicion(c.disposicion);
      if (v.ok) disposicion = v.disposicion; else sinDisposicion = `${v.campo} ${v.motivo}`;
    }
    const id = id16();
    const creada = ahora().toISOString();
    let texto = `${JSON.stringify({ nombre, grafo: c.grafo, ...(disposicion ? { disposicion } : {}), creada })}\n`;
    // El archivo nunca pasa el tope con que se lee (el grafo ya va hasta 2 MB, por formaDeGrafo).
    if (disposicion && Buffer.byteLength(texto) > TOPE_PROPIA) {
      sinDisposicion = 'la plantilla con su disposición pasaría los 2,5 MB';
      texto = `${JSON.stringify({ nombre, grafo: c.grafo, creada })}\n`;
    }
    fs.mkdirSync(dirPlantillas, { recursive: true });
    archivos.escribirAtomico(path.join(dirPlantillas, `${id}.json`), texto);
    return { ok: true, id: `propia:${id}`, ...(sinDisposicion ? { sinDisposicion: true, motivo: `La disposición no vale (${sinDisposicion}): se guardó sin ella.` } : {}) };
  }

  function borrarPlantilla(c = {}) {
    const ap = activo(); if (ap) return ap;
    const m = esObjeto(c) ? /^propia:([a-z0-9]{16})$/.exec(String(c.id || '')) : null;
    if (!m || !RE_PROPIA.test(m[1])) return no(400, 'id', 'No es una plantilla propia.');
    const ruta = path.join(dirPlantillas, `${m[1]}.json`);
    if (!fs.existsSync(ruta)) return no(404, 'no-existe', 'Esa plantilla ya no está.');
    fs.rmSync(ruta, { force: true });
    return { ok: true };
  }

  // ---------------------------------------------------------------- «Que lo prepare el alma».
  /** Lo deja la cola en lugar de generar. `{ ok, id }`. */
  function preparar(datos) {
    const id = `p-${id16()}`;
    // La semilla se elige al prepararlo: abrirlo dos veces da el mismo flujo.
    const semilla = Number.isInteger(datos.semilla) ? datos.semilla : crypto.randomInt(0, 2 ** 31);
    fs.mkdirSync(dirPreparados, { recursive: true });
    archivos.escribirAtomico(path.join(dirPreparados, `${id}.json`), `${JSON.stringify({ ...datos, semilla, id, creada: ahora().toISOString() })}\n`);
    publicar(`sujeto:${datos.clave}`, 'taller.preparado', { id, alma: datos.clave, tareaId: datos.tareaId, ok: true });
    return { ok: true, id };
  }

  function fallo({ tareaId, clave, codigo }) {
    fallos.set(tareaId, { codigo: String(codigo || 'error').slice(0, 40), alma: clave });
    while (fallos.size > TOPE_FALLOS) fallos.delete(fallos.keys().next().value);
    try { fs.mkdirSync(dirPreparados, { recursive: true }); archivos.escribirAtomico(rutaFallos, `${JSON.stringify([...fallos])}\n`); } catch {}
    publicar(`sujeto:${clave}`, 'taller.preparado', { alma: clave, tareaId, ok: false, codigo: String(codigo || 'error').slice(0, 40) });
  }

  function leerPreparados() {
    let nombres = [];
    try { nombres = fs.readdirSync(dirPreparados); } catch { return []; }
    return nombres.filter((f) => /^p-[a-z0-9]{16}\.json$/.test(f)).map((f) => leerJsonSeguro(path.join(dirPreparados, f))).filter((p) => p && RE_PREPARADO.test(String(p.id)));
  }
  const vigente = (p) => ms() - Date.parse(p.creada || 0) < PREPARADO_MS;

  /** `GET /taller/preparados?tareaId=`: el preparado de ese turno (o su fallo), sin depender del evento. */
  function preparadoDe(tareaId) {
    const ap = activo(); if (ap) return ap;
    if (typeof tareaId !== 'string' || !indice.RE_TAREA.test(tareaId)) return no(400, 'tareaId', 'tareaId inválido.');
    const p = leerPreparados().find((x) => x.tareaId === tareaId && vigente(x));
    if (p) return { ok: true, preparado: { id: p.id, alma: p.clave, tareaId, ok: true } };
    const f = fallos.get(tareaId);
    if (f) return { ok: true, preparado: { alma: f.alma, tareaId, ok: false, codigo: f.codigo } };
    return no(404, 'no-existe', 'Ese turno no dejó nada para el taller.');
  }

  // ---------------------------------------------------------------- Lo que mira el resto del daemon.
  /** Las bases de las sesiones vivas y de los preparados: la poda y Borrar no las tocan. */
  function fotosEnUso() {
    return [...vivas().map((s) => s.baseRuta), ...leerPreparados().filter(vigente).map((p) => p.base && p.base.ruta)].filter((r) => typeof r === 'string' && r);
  }

  /** Cuántas sesiones vivas hay (Apagar y Reiniciar no tiran ComfyUI con el taller abierto). */
  const abiertas = () => vivas().length;

  function barrer() {
    for (const s of [...sesiones.values()]) {
      if (s.abierta || ms() - (s.ultimaSenal || 0) < CERRADA_MS) continue;
      try { fs.rmSync(dirDe(s.id), { recursive: true, force: true }); } catch {}
      sesiones.delete(s.id);
    }
    for (const p of leerPreparados()) {
      if (ms() - Date.parse(p.creada || 0) < PREPARADO_MS) continue;
      try { fs.rmSync(path.join(dirPreparados, `${p.id}.json`), { force: true }); } catch {}
    }
  }

  cargar();
  try { barrer(); } catch {}
  relojBarrido = setInterval(() => { try { barrer(); } catch {} }, BARRIDO_MS);
  relojBarrido.unref?.();
  if (vivas().length) arrancarMirada();

  function parar() { clearInterval(reloj); reloj = null; clearInterval(relojBarrido); relojBarrido = null; }

  return {
    abrir, sigue, estado, bytes, quedar, descartar, cerrar, plantillas, listarPlantillas, guardarPlantilla, borrarPlantilla, guardarDisposicion, borrarDisposicion, preparar, fallo, preparadoDe, fotosEnUso, abiertas, barrer, parar,
    _vuelta: vuelta, _sesiones: sesiones
  };
}
