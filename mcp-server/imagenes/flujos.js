'use strict';

/**
 * FEAT-212 §2 — Los flujos de ComfyUI: las reglas de ruta, la lectura por caso, la ficha y quién resuelve cuál se usa.
 *
 * `resolverFlujo` es la única que dice qué flujo usa un caso (el propio del perfil o la plantilla del plugin): la usan
 * la vista de Ajustes, lo disponible, Probar y la generación.
 */

const fs = require('node:fs');
const path = require('node:path');
const { crearMatcher } = require('../lib/glob-rutas.js');
const perfiles = require('./perfiles.js');

const DIR_PLANTILLAS = path.join(__dirname, '..', '..', 'telegram-bridge', 'imagenes', 'plantillas');
const TOPE_FLUJO = 2 * 1024 * 1024;
const CASOS_PROPIOS = Object.freeze(['nueva', 'variacion', 'edicion']);
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;

/** Los marcadores que se pueden usar en cualquier caso, y los que suma cada uno. */
const COMUNES = Object.freeze(['semilla', 'ancho', 'alto', 'pasos', 'cfg', 'guia', 'fuerza', 'prompt', 'negativo', 'modelo', 'unet', 'clip_1', 'clip_2', 'vae', 'sampler', 'scheduler']);
const DEL_CASO = Object.freeze({ nueva: [], variacion: ['foto'], retoque: ['foto', 'zona'], edicion: ['foto', 'instruccion'] });
const ENTEROS = new Set(['semilla', 'ancho', 'alto', 'pasos']);
const DECIMALES = new Set(['cfg', 'guia', 'fuerza', 'lora_1_fuerza', 'lora_2_fuerza', 'lora_3_fuerza', 'lora_4_fuerza']);
const MAX_HUECOS = 4;
/** La política de lectura (`permissions.deny_paths`) que acompaña a la sección normalizada: no viaja en JSON. */
const DENY = Symbol('deny_paths');

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Los marcadores `{{…}}` de un valor JSON ya parseado. */
function marcadoresDe(valor, salida = new Set()) {
  if (typeof valor === 'string') for (const m of valor.matchAll(/\{\{(\w+)\}\}/g)) salida.add(m[1]);
  else if (Array.isArray(valor)) valor.forEach((v) => marcadoresDe(v, salida));
  else if (esObjeto(valor)) Object.values(valor).forEach((v) => marcadoresDe(v, salida));
  return salida;
}

const conBarras = (r) => String(r).replace(/\\/g, '/');

/** La ruta real (sin symlinks), o `null` si no existe. */
function rutaReal(r) {
  try { return fs.realpathSync(r); } catch { return null; }
}

const ANTIGUAS = /\/telegram-bridge\/imagenes\/plantillas\/sdxl-(txt2img|img2img)\.json$/i;

/** ¿Es una plantilla del plugin? (las de ahora, o las dos de 2.18 en cualquier carpeta de instalación). */
function esPlantilla(ruta) {
  if (typeof ruta !== 'string' || !ruta.trim()) return false;
  const r = path.resolve(ruta.trim());
  if (ANTIGUAS.test(conBarras(r))) return true;
  const igual = (a) => (process.platform === 'win32' ? a.toLowerCase() : a);
  const base = igual(conBarras(rutaReal(DIR_PLANTILLAS) || DIR_PLANTILLAS));
  return [r, rutaReal(r)].filter(Boolean).some((x) => { const y = igual(conBarras(x)); return y === base || y.startsWith(`${base}/`); });
}

/**
 * La forma de la ruta de un flujo propio: absoluta, local, `.json`, sin `..`, fuera de `deny_paths` (la original y la
 * real) y que no sea una plantilla del plugin. No lee el archivo. `{ ok, ruta }` (normalizada) o `{ ok: false, motivo }`.
 */
function formaDeFlujo(ruta, { denyPaths = [] } = {}) {
  if (typeof ruta !== 'string' || !ruta.trim() || ruta.length > 500 || CONTROLES.test(ruta)) return { ok: false, motivo: 'tiene que ser una ruta' };
  const r = ruta.trim();
  if (/^[\\/]{2}/.test(r)) return { ok: false, motivo: 'tiene que ser una ruta de esta máquina' };
  if (r.split(/[\\/]/).includes('..')) return { ok: false, motivo: 'no puede tener ..' };
  if (!path.isAbsolute(r)) return { ok: false, motivo: 'tiene que ser una ruta absoluta' };
  if (!/\.json$/i.test(r)) return { ok: false, motivo: 'tiene que ser un archivo .json' };
  const denegada = crearMatcher(denyPaths, { absolutas: true });
  if (denegada(r)) return { ok: false, motivo: 'está en deny_paths' };
  const real = rutaReal(r);
  if (real && /^[\\/]{2}/.test(real)) return { ok: false, motivo: 'tiene que ser una ruta de esta máquina' };
  if (real && denegada(real)) return { ok: false, motivo: 'está en deny_paths' };
  if (esPlantilla(r)) return { ok: false, motivo: 'es una plantilla del plugin: elegí «Usar la plantilla»', plantilla: true };
  return { ok: true, ruta: conBarras(path.resolve(r)) };
}

/** Lee un JSON de 2 MB como mucho, de un archivo regular. `{ ok, valor }` o `{ ok: false, motivo }`. */
function leerJson(ruta, que) {
  let st;
  try { st = fs.statSync(ruta); } catch { return { ok: false, motivo: `el archivo ${que} no existe`, falta: true }; }
  if (!st.isFile()) return { ok: false, motivo: `${que === 'del flujo' ? 'el flujo' : 'la ficha'} no es un archivo` };
  if (st.size > TOPE_FLUJO) return { ok: false, motivo: `${que === 'del flujo' ? 'el flujo' : 'la ficha'} pesa más de 2 MB` };
  let crudo;
  try { crudo = fs.readFileSync(ruta, 'utf8'); } catch { return { ok: false, motivo: `el archivo ${que} no se puede leer` }; }
  try { return { ok: true, valor: JSON.parse(crudo.replace(/^\uFEFF/, '')) }; } catch { return { ok: false, motivo: `${que === 'del flujo' ? 'el flujo' : 'la ficha'} no es JSON` }; }
}

const rutaDeFicha = (ruta) => ruta.replace(/\.json$/i, '.ficha.json');

/** Los nodos `SaveImage` de un flujo, en su orden. */
const salidasDe = (flujo) => Object.entries(flujo).filter(([, n]) => esObjeto(n) && n.class_type === 'SaveImage').map(([id]) => id);

/** Con qué loaders conocidos carga el modelo: `{ checkpoint, unet }`. */
function cargasDe(flujo) {
  const clases = new Set(Object.values(flujo).filter(esObjeto).map((n) => n.class_type));
  return { checkpoint: clases.has('CheckpointLoaderSimple'), unet: clases.has('UNETLoader') };
}

/** ¿El loader del flujo sirve para esa carga? Sin ningún loader conocido (un GGUF), no se contrasta. */
function cargaCoincide(flujo, tipo) {
  const c = cargasDe(flujo);
  return (!c.checkpoint && !c.unet) || c[tipo] === true;
}

/** Qué archivos inyecta el flujo en loaders conocidos: `{ checkpoints, unets, clips, vaes }` (marcador de cada uno). */
function inyectados(flujo) {
  const salida = { checkpoints: new Set(), unets: new Set(), clips: new Set(), vaes: new Set() };
  const marcador = (v) => { const m = typeof v === 'string' ? /^\{\{(\w+)\}\}$/.exec(v) : null; return m ? m[1] : null; };
  for (const n of Object.values(flujo)) {
    if (!esObjeto(n) || !esObjeto(n.inputs)) continue;
    const sumar = (donde, v) => { const m = marcador(v); if (m) salida[donde].add(m); };
    if (n.class_type === 'CheckpointLoaderSimple') sumar('checkpoints', n.inputs.ckpt_name);
    if (n.class_type === 'UNETLoader') sumar('unets', n.inputs.unet_name);
    if (n.class_type === 'DualCLIPLoader') { sumar('clips', n.inputs.clip_name1); sumar('clips', n.inputs.clip_name2); }
    if (n.class_type === 'VAELoader') sumar('vaes', n.inputs.vae_name);
  }
  return salida;
}

/** ¿El flujo mete el modelo del caso en un loader conocido? (si no, el modelo de Ajustes no lo frena). */
function inyectaModelo(flujo) {
  const i = inyectados(flujo);
  return [...i.checkpoints, ...i.unets].some((m) => m === 'modelo' || m === 'unet');
}

/** Valida la ficha contra el flujo. `{ ok, salida, salidaMascara, huecos }` o `{ ok: false }`. */
function validarFicha(ficha, flujo) {
  const mal = { ok: false };
  if (!esObjeto(ficha)) return mal;
  for (const k of Object.keys(ficha)) if (!['salida', 'salidaMascara', 'loras'].includes(k)) return mal;
  const nodo = (id) => (typeof id === 'string' && Object.hasOwn(flujo, id) && esObjeto(flujo[id]) ? flujo[id] : null);
  let salida = null;
  if (ficha.salida !== undefined) {
    const n = nodo(ficha.salida);
    if (!n || n.class_type !== 'SaveImage') return mal;
    salida = ficha.salida;
  }
  let salidaMascara = null;
  if (ficha.salidaMascara !== undefined) {
    const n = nodo(ficha.salidaMascara);
    if (!n || !['PreviewImage', 'SaveImage'].includes(n.class_type)) return mal;
    salidaMascara = ficha.salidaMascara;
  }
  const huecos = [];
  if (ficha.loras !== undefined) {
    if (!Array.isArray(ficha.loras) || ficha.loras.length > MAX_HUECOS) return mal;
    for (const [k, h] of ficha.loras.entries()) {
      const n = esObjeto(h) ? nodo(h.nodo) : null;
      if (!n || !esObjeto(n.inputs) || huecos.includes(h.nodo)) return mal;
      const i = k + 1;
      if (n.inputs.lora_name !== `{{lora_${i}}}` || n.inputs.strength_model !== `{{lora_${i}_fuerza}}`) return mal;
      if (n.class_type === 'LoraLoader') { if (n.inputs.strength_clip !== `{{lora_${i}_fuerza}}`) return mal; } else if (n.class_type !== 'LoraLoaderModelOnly') return mal;
      huecos.push(h.nodo);
    }
  }
  return { ok: true, salida, salidaMascara, huecos };
}

/**
 * FEAT-214 — La forma de un grafo ya leído (formato API): un objeto de nodos de ComfyUI, sin el envoltorio de
 * `graphToPrompt()` y, con `conSalida`, con algún `SaveImage` o `PreviewImage` y hasta 2 MB. No pide marcadores.
 * `{ ok }` o `{ ok: false, motivo }`.
 */
function formaDeGrafo(grafo, { conSalida = true } = {}) {
  if (!esObjeto(grafo)) return { ok: false, motivo: 'el flujo no es un objeto de nodos de ComfyUI (formato API)' };
  if (esObjeto(grafo.output) && (Object.hasOwn(grafo, 'workflow') || Object.keys(grafo).length === 1)) return { ok: false, motivo: 'mandá output (el formato API), no lo que devuelve graphToPrompt entero' };
  if (!Object.values(grafo).some((n) => esObjeto(n) && typeof n.class_type === 'string')) return { ok: false, motivo: 'el flujo no es un objeto de nodos de ComfyUI (formato API)' };
  for (const n of Object.values(grafo)) {
    if (!esObjeto(n) || typeof n.class_type !== 'string' || !n.class_type || n.class_type.length > 200 || !esObjeto(n.inputs)) return { ok: false, motivo: 'un nodo del flujo no tiene class_type o sus inputs' };
  }
  if (!conSalida) return { ok: true };
  if (Object.keys(grafo).length > 2000) return { ok: false, motivo: 'el flujo tiene más de 2000 nodos' };
  if (!Object.values(grafo).some((n) => n.class_type === 'SaveImage' || n.class_type === 'PreviewImage')) return { ok: false, motivo: 'el flujo no tiene SaveImage ni PreviewImage' };
  let largo = 0;
  try { largo = Buffer.byteLength(JSON.stringify(grafo)); } catch { return { ok: false, motivo: 'el flujo no es JSON' }; }
  if (largo > TOPE_FLUJO) return { ok: false, motivo: 'el flujo pesa más de 2 MB' };
  return { ok: true };
}

/**
 * Lee un flujo para un caso, con su ficha si la trae al lado.
 * `{ ok, flujo, marcadores, salidas, ficha, conFicha }` o `{ ok: false, motivo, … }`.
 */
function leerFlujo(ruta, { caso = 'nueva', denyPaths = null } = {}) {
  const l = leerJson(ruta, 'del flujo');
  if (!l.ok) return { ok: false, motivo: l.motivo };
  const flujo = l.valor;
  const forma = formaDeGrafo(flujo, { conSalida: false });
  if (!forma.ok) return { ok: false, motivo: forma.motivo };
  const marcadores = [...marcadoresDe(flujo)].sort();
  const salidas = salidasDe(flujo);
  const parcial = { flujo, marcadores, salidas };
  const mal = (motivo) => ({ ok: false, motivo, ...parcial });

  let ficha = { salida: null, salidaMascara: null, huecos: [] };
  let conFicha = false;
  const rf = rutaDeFicha(ruta);
  if (denyPaths === null || formaDeFlujo(rf, { denyPaths }).ok) {
    const f = leerJson(rf, 'de la ficha');
    if (f.ok) {
      const v = validarFicha(f.valor, flujo);
      conFicha = true;
      parcial.conFicha = true;
      if (!v.ok) return mal('la ficha no coincide con el flujo');
      ficha = { salida: v.salida, salidaMascara: v.salidaMascara, huecos: v.huecos };
    } else if (!f.falta) { parcial.conFicha = true; return mal(f.motivo); }
  }

  if (caso === 'edicion') { if (!marcadores.includes('instruccion') && !marcadores.includes('prompt')) return mal('el flujo no tiene {{instruccion}} ni {{prompt}}'); } else if (!marcadores.includes('prompt')) return mal('el flujo no tiene {{prompt}}');
  for (const m of DEL_CASO[caso] || []) if (m !== 'instruccion' && !marcadores.includes(m)) return mal(`el flujo no tiene {{${m}}}`);
  const deLora = new Set();
  ficha.huecos.forEach((_, k) => { deLora.add(`lora_${k + 1}`); deLora.add(`lora_${k + 1}_fuerza`); });
  const admitidos = new Set([...COMUNES, ...(DEL_CASO[caso] || []), ...deLora]);
  const ajeno = marcadores.find((m) => !admitidos.has(m));
  if (ajeno) return mal(`el flujo usa {{${ajeno}}} y este caso no lo da`);
  if (!salidas.length) return mal('el flujo no tiene SaveImage');
  return { ok: true, ...parcial, ficha, conFicha };
}

/** El archivo de la plantilla del plugin para un perfil y un caso, o `{ ok: false, motivo }`. */
function plantillaDe(imagenes, perfil, caso) {
  // Con `fill`, el modelo de retoque tiene que ser un Fill: otro repintaría con Crop and Stitch sin que nadie lo pidiera.
  if (caso === 'retoque' && imagenes.comfyui.retoque === 'fill' && perfil.plantillas !== 'flux-fill') return { ok: false, motivo: 'el modelo de retoque no es un Fill' };
  const nombre = caso === 'retoque' ? `retoque-${imagenes.comfyui.mascara}` : caso;
  const ruta = path.join(DIR_PLANTILLAS, perfil.plantillas, `${nombre}.json`);
  if (!fs.existsSync(ruta)) return { ok: false, motivo: 'no hay plantilla para este caso' };
  if (perfil.carga.tipo !== perfiles.CARGA_DE_FAMILIA[perfil.plantillas]) return { ok: false, motivo: 'no hay plantilla para esta carga' };
  if (perfil.carga.tipo === 'unet' && !(perfil.carga.clip1 && perfil.carga.clip2 && perfil.carga.vae)) return { ok: false, motivo: 'falta el clip o el vae' };
  return { ok: true, ruta, nombre: `${perfil.plantillas}/${nombre}` };
}

/** La entrada propia de un perfil y un caso, o `null`. */
function flujoPropio(imagenes, perfilId, caso) {
  const f = imagenes && imagenes.comfyui && imagenes.comfyui.flujos;
  if (!esObjeto(f) || !Object.hasOwn(f, perfilId) || !CASOS_PROPIOS.includes(caso)) return null;
  const e = f[perfilId];
  return esObjeto(e) && Object.hasOwn(e, caso) && esObjeto(e[caso]) ? e[caso] : null;
}

/**
 * Qué flujo usa un caso con un perfil.
 * `{ ok, flujo, ficha, salida, salidaMascara, huecos, marcadores, salidas, propio, archivo, nombre, conFicha, motivo }`.
 */
function resolverFlujo(imagenes, perfil, caso) {
  const propio = flujoPropio(imagenes, perfil.id, caso);
  const base = propio
    ? { propio: true, archivo: propio.archivo, nombre: path.basename(propio.archivo), conFicha: false }
    : { propio: false, archivo: null, nombre: null, conFicha: false };
  const vacio = { flujo: null, salida: null, salidaMascara: null, huecos: [], marcadores: [], salidas: [] };
  const mal = (motivo, extra = {}) => ({ ok: false, ...vacio, ...base, ...extra, motivo });
  if (!perfil.casos.includes(caso)) return mal('el perfil no tiene este caso');
  let ruta = propio ? propio.archivo : null;
  if (!propio) {
    const p = plantillaDe(imagenes, perfil, caso);
    if (!p.ok) return mal(p.motivo);
    ruta = p.ruta;
    base.nombre = p.nombre;
  }
  const deny = (imagenes && imagenes[DENY]) || [];
  if (propio) {
    const forma = formaDeFlujo(ruta, { denyPaths: deny });
    if (!forma.ok) return mal(`el flujo ${forma.motivo}`);
  }
  const l = leerFlujo(ruta, { caso, denyPaths: propio ? deny : null });
  const visto = { marcadores: l.marcadores || [], salidas: l.salidas || [], conFicha: propio ? Boolean(l.conFicha) : false };
  if (!l.ok) return mal(l.motivo, visto);
  visto.huecos = l.ficha.huecos;
  let salida = l.ficha.salida;
  if (propio) {
    // La salida tiene una sola fuente: la entrada. La ficha solo se contrasta.
    if (propio.salida) {
      if (!l.salidas.includes(propio.salida)) return mal('el nodo de salida no es un SaveImage del flujo', visto);
      if (l.ficha.salida && l.ficha.salida !== propio.salida) return mal('la ficha no coincide con el flujo', visto);
      salida = propio.salida;
    } else if (l.salidas.length === 1) salida = l.salidas[0];
    else return mal('varios SaveImage sin salida', visto);
    if (!cargaCoincide(l.flujo, perfil.carga.tipo)) return mal('la carga del flujo no coincide con el perfil', { ...visto, salida });
  }
  return { ok: true, ...vacio, ...base, ...visto, flujo: l.flujo, ficha: l.ficha, salida, salidaMascara: l.ficha.salidaMascara, motivo: null };
}

/** FEAT-214 — Las plantillas del plugin que solo existen en el taller. */
const PLANTILLAS_TALLER = Object.freeze(['retoque-a-mano']);

/**
 * FEAT-214 — Una plantilla del taller, sin pasar por `plantillaDe` (que arma `retoque-<mascara>`): la misma forma que
 * `resolverFlujo`. Hoy solo «Retoque a mano», de la familia SDXL; parte de una imagen, como una variación.
 */
function resolverPlantillaTaller(perfil, nombre) {
  const vacio = { flujo: null, salida: null, salidaMascara: null, huecos: [], marcadores: [], salidas: [], propio: false, archivo: null, conFicha: false };
  const mal = (motivo) => ({ ok: false, ...vacio, nombre: null, motivo });
  if (!PLANTILLAS_TALLER.includes(nombre)) return mal('no es una plantilla del taller');
  if (!perfil || typeof perfil.plantillas !== 'string') return mal('solo con un perfil SDXL');
  const ruta = path.join(DIR_PLANTILLAS, perfil.plantillas, `${nombre}.json`);
  if (!fs.existsSync(ruta)) return mal('solo con un perfil SDXL');
  if (perfil.carga.tipo !== perfiles.CARGA_DE_FAMILIA[perfil.plantillas]) return mal('no hay plantilla para esta carga');
  const l = leerFlujo(ruta, { caso: 'variacion' });
  if (!l.ok) return mal(l.motivo);
  return { ok: true, ...vacio, marcadores: l.marcadores, salidas: l.salidas, flujo: l.flujo, ficha: l.ficha, salida: l.ficha.salida || l.salidas[0], huecos: l.ficha.huecos, nombre: `${perfil.plantillas}/${nombre}`, motivo: null };
}

/** Saca los huecos de LoRA que no se usan (los que siguen a los primeros `usados`) y reconecta lo que colgaba de ellos. */
function puentear(flujo, huecos, usados) {
  const fuera = new Set(huecos.slice(usados));
  if (!fuera.size) return flujo;
  const destino = (enlace) => {
    let e = enlace;
    for (let v = 0; v <= huecos.length && Array.isArray(e) && e.length === 2 && fuera.has(String(e[0])); v++) {
      const n = flujo[String(e[0])];
      e = e[1] === 1 ? n.inputs.clip : n.inputs.model;
    }
    return e;
  };
  return Object.fromEntries(Object.entries(flujo).filter(([id]) => !fuera.has(id)).map(([id, n]) => [
    id, esObjeto(n) && esObjeto(n.inputs) ? { ...n, inputs: Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [k, destino(v)])) } : n
  ]));
}

/** El primer marcador del grafo que los datos no dan (o que es un número que no lo es), o `null`. */
function marcadorFaltante(flujo, datos) {
  for (const m of [...marcadoresDe(flujo)].sort()) {
    if (!Object.hasOwn(datos, m)) return m;
    const v = datos[m];
    if ((ENTEROS.has(m) || DECIMALES.has(m)) && (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)))) return m;
  }
  return null;
}

/** Reemplaza los marcadores sobre el flujo parseado. Un valor que es exactamente `{{numérico}}` queda como número. */
function aplicarMarcadores(valor, datos) {
  if (typeof valor === 'string') {
    const solo = /^\{\{(\w+)\}\}$/.exec(valor);
    if (solo && Object.hasOwn(datos, solo[1])) {
      const v = datos[solo[1]];
      if (ENTEROS.has(solo[1])) return Math.round(Number(v));
      if (DECIMALES.has(solo[1])) return Number(v);
      return v == null ? '' : String(v);
    }
    return valor.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(datos, k) ? String(datos[k] ?? '') : m));
  }
  if (Array.isArray(valor)) return valor.map((v) => aplicarMarcadores(v, datos));
  if (esObjeto(valor)) return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, aplicarMarcadores(v, datos)]));
  return valor;
}

/** Los nodos de la rama de máscara: `salidaMascara` y sus ancestros, menos `LoadImage` y los cargadores del modelo. */
function ramaDeMascara(flujo, salidaMascara) {
  const rama = new Set();
  const ver = (id) => {
    const n = Object.hasOwn(flujo, id) ? flujo[id] : null;
    if (!esObjeto(n) || rama.has(id) || ['LoadImage', 'CheckpointLoaderSimple', 'UNETLoader', 'DualCLIPLoader', 'VAELoader'].includes(n.class_type)) return;
    rama.add(id);
    for (const v of Object.values(esObjeto(n.inputs) ? n.inputs : {})) if (Array.isArray(v) && v.length === 2) ver(String(v[0]));
  };
  if (salidaMascara) ver(String(salidaMascara));
  return rama;
}

/**
 * Lo que le falta a ComfyUI para un flujo, según el catálogo: `{ faltan: { nodos, archivos }, faltanLoras }`.
 * `valores` son los del caso (`modelo`, `unet`, `clip_1`…); `loras`, los archivos que podrían usarse.
 */
function faltantes(resuelto, valores, catalogo, loras = []) {
  const vacio = { faltan: { nodos: [], archivos: [] }, faltanLoras: [] };
  if (!catalogo || !resuelto.flujo) return vacio;
  const huecos = new Set(resuelto.huecos);
  // Un hueco de LoRA se puede puentear: su nodo no cuenta.
  const clases = new Set(Object.entries(resuelto.flujo).filter(([id, n]) => esObjeto(n) && !huecos.has(id)).map(([, n]) => n.class_type).filter((c) => typeof c === 'string'));
  const nodos = [...clases].filter((c) => !catalogo.nodos.has(c)).sort();
  const iny = inyectados(resuelto.flujo);
  const archivos = [];
  const mirar = (marcadores, lista) => {
    for (const m of marcadores) {
      const v = valores[m];
      if (typeof v === 'string' && v && !perfiles.enLista(lista, v) && !archivos.includes(v)) archivos.push(v);
    }
  };
  mirar(iny.checkpoints, catalogo.checkpoints);
  mirar(iny.unets, catalogo.unets);
  mirar(iny.clips, catalogo.clips);
  mirar(iny.vaes, catalogo.vaes);
  const faltanLoras = resuelto.huecos.length ? loras.filter((a) => !perfiles.enLista(catalogo.loras, a)) : [];
  return { faltan: { nodos, archivos }, faltanLoras };
}

module.exports = {
  DENY, DIR_PLANTILLAS, TOPE_FLUJO, CASOS_PROPIOS, COMUNES, DEL_CASO, ENTEROS, DECIMALES, MAX_HUECOS,
  marcadoresDe, esPlantilla, formaDeFlujo, formaDeGrafo, rutaDeFicha, salidasDe, cargasDe, cargaCoincide, inyectados, inyectaModelo, validarFicha, leerFlujo,
  plantillaDe, flujoPropio, resolverFlujo, PLANTILLAS_TALLER, resolverPlantillaTaller, puentear, marcadorFaltante, aplicarMarcadores, ramaDeMascara, faltantes
};
