/**
 * FEAT-210 — La sección `imagenes` de la configuración: las imágenes de las almas.
 *
 * Solo global (`~/.claude/antigravity.json`): un repo clonado no puede encender
 * un proveedor remoto ni apuntar a un flujo de ComfyUI. `normalizar` es la
 * lectura tolerante (lo inválido cae a su valor por defecto, con aviso) y la usa
 * todo lo que decide en caliente (la consigna del alma, la cola, `capacidades`);
 * `aplicarImagenes` es la escritura estricta de Ajustes.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const almasRutas = require('../almas/rutas.js');
const { crearMatcher } = require('./glob-rutas.js');
const { ErrorAjuste } = require('./ajustes-general.js');

const PROVEEDORES = Object.freeze(['comfyui', 'antigravity', 'openai', 'gemini']);
const REMOTOS = Object.freeze({ openai: 'openai_imagen', gemini: 'gemini_imagen' });
const BOOLEANOS = Object.freeze(['activas', 'refinar', 'alma_la_ve', 'otra_version', 'fotos_seguras', 'reconocer_propias']);
const CAMPOS = Object.freeze([...BOOLEANOS, 'orden', 'por_alma', 'comfyui', 'openai_imagen', 'gemini_imagen']);
const URL_COMFYUI = 'http://127.0.0.1:8188';
const MAX_TEXTO = 200;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
const RE_KEY_ENV = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RE_NODO = /^[A-Za-z0-9_:.-]{1,40}$/;

const RANGOS = Object.freeze({
  pasos: { min: 1, max: 150, defecto: 30 },
  tiempo_s: { min: 10, max: 3600, defecto: 300 },
  tope_prompt: { min: 100, max: 900, defecto: 300 }
});

/** Los flujos que trae el plugin (SDXL). */
const DIR_PLANTILLAS = path.join(__dirname, '..', '..', 'telegram-bridge', 'imagenes', 'plantillas');
const PLANTILLA_TXT2IMG = path.join(DIR_PLANTILLAS, 'sdxl-txt2img.json');
const PLANTILLA_IMG2IMG = path.join(DIR_PLANTILLAS, 'sdxl-img2img.json');

function defectos() {
  return {
    activas: true,
    orden: ['comfyui', 'antigravity'],
    por_alma: {},
    refinar: true,
    alma_la_ve: true,
    otra_version: true,
    fotos_seguras: true,
    reconocer_propias: true,
    comfyui: {
      url: URL_COMFYUI, modelo: 'sd_xl_base_1.0.safetensors', flujo_txt2img: null, flujo_img2img: null, nodo_salida: null,
      pasos: RANGOS.pasos.defecto, tiempo_s: RANGOS.tiempo_s.defecto, tope_prompt: RANGOS.tope_prompt.defecto, liberar_gpu: true
    },
    openai_imagen: { url: null, modelo: null, key_env: null },
    gemini_imagen: { url: null, modelo: null, key_env: null }
  };
}

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** ¿Es una URL `http(s)` de loopback (127.0.0.1, localhost o [::1])? */
function esLoopback(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

function esHttps(url) {
  try { const u = new URL(String(url)); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}

function texto(v) {
  return typeof v === 'string' && v.trim() && v.trim().length <= MAX_TEXTO && !CONTROLES.test(v) ? v.trim() : null;
}

/** Un flujo de ComfyUI: ruta absoluta a un `.json`, fuera de `deny_paths`. `{ ok, motivo }` sin leer el archivo. */
function formaDeFlujo(ruta, { denyPaths = [] } = {}) {
  if (typeof ruta !== 'string' || !ruta.trim() || CONTROLES.test(ruta)) return { ok: false, motivo: 'tiene que ser una ruta' };
  const r = ruta.trim();
  if (!path.isAbsolute(r)) return { ok: false, motivo: 'tiene que ser una ruta absoluta' };
  if (!/\.json$/i.test(r)) return { ok: false, motivo: 'tiene que ser un archivo .json' };
  if (crearMatcher(denyPaths)(r.replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''))) return { ok: false, motivo: 'está en deny_paths' };
  return { ok: true };
}

/** Los marcadores `{{…}}` de un valor JSON ya parseado. */
function marcadoresDe(valor, salida = new Set()) {
  if (typeof valor === 'string') for (const m of valor.matchAll(/\{\{(\w+)\}\}/g)) salida.add(m[1]);
  else if (Array.isArray(valor)) valor.forEach((v) => marcadoresDe(v, salida));
  else if (esObjeto(valor)) Object.values(valor).forEach((v) => marcadoresDe(v, salida));
  return salida;
}

/**
 * Lee y valida un flujo: existe, es JSON, tiene `{{prompt}}` (y `{{foto}}` si es de img2img).
 * `{ ok, flujo, marcadores }` o `{ ok: false, motivo }`.
 */
function leerFlujo(ruta, { img2img = false } = {}) {
  let crudo;
  try { crudo = fs.readFileSync(ruta, 'utf8'); } catch { return { ok: false, motivo: 'el archivo del flujo no existe o no se puede leer' }; }
  let flujo;
  try { flujo = JSON.parse(crudo); } catch { return { ok: false, motivo: 'el flujo no es JSON' }; }
  if (!esObjeto(flujo)) return { ok: false, motivo: 'el flujo no es un objeto de nodos de ComfyUI (formato API)' };
  const marcadores = [...marcadoresDe(flujo)].sort();
  if (!marcadores.includes('prompt')) return { ok: false, motivo: 'el flujo no tiene {{prompt}}' };
  if (img2img && !marcadores.includes('foto')) return { ok: false, motivo: 'el flujo de img2img no tiene {{foto}}' };
  return { ok: true, flujo, marcadores };
}

function rangoTolerante(v, campo) {
  const r = RANGOS[campo];
  return Number.isInteger(v) && v >= r.min && v <= r.max ? v : r.defecto;
}

/**
 * La lectura tolerante: cada campo inválido cae a su valor por defecto y se avisa. `{ imagenes, avisos }`.
 * `almas`, si viene, filtra `por_alma` a las que existen (con aviso).
 */
function normalizar(crudo, { almas = null, denyPaths = [] } = {}) {
  const d = defectos();
  const avisos = [];
  if (crudo === undefined || crudo === null) return { imagenes: d, avisos };
  if (!esObjeto(crudo)) return { imagenes: d, avisos: ['imagenes tiene que ser un objeto; se usan los valores por defecto'] };
  for (const k of BOOLEANOS) {
    if (crudo[k] === undefined) continue;
    if (typeof crudo[k] === 'boolean') d[k] = crudo[k];
    else avisos.push(`imagenes.${k} tiene que ser true o false; se usa ${d[k]}`);
  }
  if (crudo.orden !== undefined) {
    if (Array.isArray(crudo.orden) && crudo.orden.every((p) => PROVEEDORES.includes(p)) && new Set(crudo.orden).size === crudo.orden.length) d.orden = [...crudo.orden];
    else avisos.push(`imagenes.orden tiene que ser una lista sin repetidos de ${PROVEEDORES.join(', ')}; se usa ${d.orden.join(', ')}`);
  }
  if (crudo.por_alma !== undefined) {
    if (!esObjeto(crudo.por_alma)) avisos.push('imagenes.por_alma tiene que ser un objeto { alma: false }; se ignora');
    else {
      const existe = almas ? new Set(almas) : null;
      for (const [clave, v] of Object.entries(crudo.por_alma)) {
        if (!almasRutas.CLAVE_VALIDA.test(clave) || v !== false) { avisos.push(`imagenes.por_alma.${clave} no vale (solo false para un alma); se ignora`); continue; }
        if (existe && !existe.has(clave)) { avisos.push(`imagenes.por_alma: el alma "${clave}" no existe; su entrada no se usa ni se toca`); continue; }
        d.por_alma[clave] = false;
      }
    }
  }
  if (crudo.comfyui !== undefined) {
    const c = crudo.comfyui;
    if (!esObjeto(c)) avisos.push('imagenes.comfyui tiene que ser un objeto; se usan los valores por defecto');
    else {
      if (c.url !== undefined && c.url !== null) {
        if (esLoopback(c.url)) d.comfyui.url = String(c.url).replace(/\/+$/, '');
        else avisos.push('imagenes.comfyui.url tiene que ser de esta máquina (127.0.0.1, localhost o [::1]); se usa la de siempre');
      }
      if (c.modelo !== undefined && c.modelo !== null) {
        if (texto(c.modelo)) d.comfyui.modelo = texto(c.modelo);
        else avisos.push('imagenes.comfyui.modelo no es un nombre de archivo válido; se usa el de siempre');
      }
      for (const k of ['flujo_txt2img', 'flujo_img2img']) {
        if (c[k] === undefined || c[k] === null || c[k] === '') continue;
        const forma = formaDeFlujo(c[k], { denyPaths });
        if (forma.ok) d.comfyui[k] = c[k].trim();
        else avisos.push(`imagenes.comfyui.${k} ${forma.motivo === 'está en deny_paths' ? 'está en deny_paths' : 'no es una ruta absoluta a un .json'}; se ignora`);
      }
      if (c.nodo_salida !== undefined && c.nodo_salida !== null && c.nodo_salida !== '') {
        if (RE_NODO.test(String(c.nodo_salida))) d.comfyui.nodo_salida = String(c.nodo_salida);
        else avisos.push('imagenes.comfyui.nodo_salida no es un id de nodo; se ignora');
      }
      for (const k of Object.keys(RANGOS)) {
        if (c[k] === undefined || c[k] === null) continue;
        d.comfyui[k] = rangoTolerante(c[k], k);
        if (d.comfyui[k] !== c[k]) avisos.push(`imagenes.comfyui.${k} tiene que ser un entero entre ${RANGOS[k].min} y ${RANGOS[k].max}; se usa ${RANGOS[k].defecto}`);
      }
      if (typeof c.liberar_gpu === 'boolean') d.comfyui.liberar_gpu = c.liberar_gpu;
      else if (c.liberar_gpu !== undefined && c.liberar_gpu !== null) avisos.push('imagenes.comfyui.liberar_gpu tiene que ser true o false; se ignora');
    }
  }
  for (const campo of Object.values(REMOTOS)) {
    const r = crudo[campo];
    if (r === undefined || r === null) continue;
    if (!esObjeto(r)) { avisos.push(`imagenes.${campo} tiene que ser un objeto; se ignora`); continue; }
    if (r.url) { if (esHttps(r.url)) d[campo].url = String(r.url); else avisos.push(`imagenes.${campo}.url tiene que ser https; se ignora`); }
    if (r.modelo) { if (texto(r.modelo)) d[campo].modelo = texto(r.modelo); else avisos.push(`imagenes.${campo}.modelo no es un nombre válido; se ignora`); }
    if (r.key_env) { if (RE_KEY_ENV.test(String(r.key_env))) d[campo].key_env = String(r.key_env); else avisos.push(`imagenes.${campo}.key_env tiene que ser el nombre de una variable (MAYÚSCULAS_Y_GUIONES); se ignora`); }
  }
  return { imagenes: d, avisos };
}

/** El flujo efectivo de cada modo: el configurado o la plantilla del plugin (txt2img); img2img, solo si hay uno. */
function flujosEfectivos(imagenes) {
  return {
    txt2img: imagenes.comfyui.flujo_txt2img || PLANTILLA_TXT2IMG,
    img2img: imagenes.comfyui.flujo_img2img || null
  };
}

/** La política de lectura de la config (`permissions.deny_paths`), o la de siempre. */
function denyDe(datos) {
  const p = datos && esObjeto(datos.permissions) ? datos.permissions : null;
  return p && Array.isArray(p.deny_paths) ? p.deny_paths : ['.env*', '**/*.key', '**/*.pem'];
}

/** La sección, para la pantalla: los valores normalizados y, por flujo, sus marcadores o su problema. */
function leerImagenes(datos, { almas = null } = {}) {
  const { imagenes, avisos } = normalizar(datos.imagenes, { almas, denyPaths: denyDe(datos) });
  const flujos = {};
  const f = flujosEfectivos(imagenes);
  for (const [modo, ruta] of Object.entries(f)) {
    if (!ruta) { flujos[modo] = null; continue; }
    const l = leerFlujo(ruta, { img2img: modo === 'img2img' });
    flujos[modo] = l.ok ? { ok: true, marcadores: l.marcadores, plantilla: ruta === PLANTILLA_TXT2IMG } : { ok: false, motivo: l.motivo };
    if (!l.ok) avisos.push(`El flujo de ${modo} no sirve: ${l.motivo}`);
  }
  return { imagenes, avisos, flujos };
}

/** Lo crudo de la sección, para su versión. */
function crudoImagenes(datos) {
  return datos.imagenes ?? null;
}

/**
 * La escritura estricta de Ajustes: cada campo que viene se valida y se aplica sobre lo guardado (las claves que el
 * panel no conoce se conservan). Lanza `ErrorAjuste`. `almas` son las claves que existen; `denyPaths`, los de la config.
 */
function aplicarImagenes(datos, pedido, { almas = [], denyPaths = [] } = {}) {
  if (!esObjeto(pedido)) throw new ErrorAjuste(`imagenes tiene que ser un objeto { ${CAMPOS.join(', ')} }`, 'imagenes');
  for (const k of Object.keys(pedido)) if (!CAMPOS.includes(k)) throw new ErrorAjuste(`imagenes.${k} no está permitido`, `imagenes.${k}`);
  const previo = esObjeto(datos.imagenes) ? datos.imagenes : {};
  const nuevo = { ...previo };
  for (const k of BOOLEANOS) {
    if (pedido[k] === undefined) continue;
    if (typeof pedido[k] !== 'boolean') throw new ErrorAjuste(`imagenes.${k} tiene que ser true o false`, `imagenes.${k}`);
    nuevo[k] = pedido[k];
  }
  if (pedido.orden !== undefined) {
    const o = pedido.orden;
    if (!Array.isArray(o) || !o.every((p) => PROVEEDORES.includes(p)) || new Set(o).size !== o.length) {
      throw new ErrorAjuste(`El orden tiene que ser una lista sin repetidos de ${PROVEEDORES.join(', ')}`, 'imagenes.orden');
    }
    nuevo.orden = [...o];
  }
  if (pedido.por_alma !== undefined) {
    if (pedido.por_alma !== null && !esObjeto(pedido.por_alma)) throw new ErrorAjuste('imagenes.por_alma tiene que ser un objeto { alma: false }', 'imagenes.por_alma');
    const viejo = esObjeto(previo.por_alma) ? previo.por_alma : {};
    const existe = new Set(almas);
    const tabla = {};
    for (const [clave, v] of Object.entries(pedido.por_alma || {})) {
      if (v === null || v === true) continue; // prendida: sin entrada
      if (!almasRutas.CLAVE_VALIDA.test(clave) || v !== false) throw new ErrorAjuste(`imagenes.por_alma.${clave} tiene que ser false (o no estar)`, `imagenes.por_alma.${clave}`);
      if (viejo[clave] !== false && !existe.has(clave)) throw new ErrorAjuste(`"${clave}" no es un alma de esta máquina`, `imagenes.por_alma.${clave}`);
      tabla[clave] = false;
    }
    if (Object.keys(tabla).length) nuevo.por_alma = tabla; else delete nuevo.por_alma;
  }
  if (pedido.comfyui !== undefined) {
    const c = pedido.comfyui;
    if (!esObjeto(c)) throw new ErrorAjuste('imagenes.comfyui tiene que ser un objeto', 'imagenes.comfyui');
    const permitidos = ['url', 'modelo', 'flujo_txt2img', 'flujo_img2img', 'nodo_salida', 'pasos', 'tiempo_s', 'tope_prompt', 'liberar_gpu'];
    for (const k of Object.keys(c)) if (!permitidos.includes(k)) throw new ErrorAjuste(`imagenes.comfyui.${k} no está permitido`, `imagenes.comfyui.${k}`);
    const sal = esObjeto(previo.comfyui) ? { ...previo.comfyui } : {};
    const quitar = (k) => { delete sal[k]; };
    if (c.url !== undefined) {
      if (c.url === null || c.url === '') quitar('url');
      else if (!esLoopback(c.url)) throw new ErrorAjuste('La URL de ComfyUI tiene que ser de esta máquina (127.0.0.1, localhost o [::1])', 'imagenes.comfyui.url');
      else sal.url = String(c.url).trim().replace(/\/+$/, '');
    }
    if (c.modelo !== undefined) {
      if (c.modelo === null || c.modelo === '') quitar('modelo');
      else if (!texto(c.modelo)) throw new ErrorAjuste(`El modelo tiene que ser un nombre (hasta ${MAX_TEXTO} caracteres)`, 'imagenes.comfyui.modelo');
      else sal.modelo = texto(c.modelo);
    }
    for (const k of ['flujo_txt2img', 'flujo_img2img']) {
      if (c[k] === undefined) continue;
      if (c[k] === null || c[k] === '') { quitar(k); continue; }
      const forma = formaDeFlujo(c[k], { denyPaths });
      if (!forma.ok) throw new ErrorAjuste(`El flujo ${k === 'flujo_txt2img' ? 'de txt2img' : 'de img2img'} ${forma.motivo}`, `imagenes.comfyui.${k}`);
      const l = leerFlujo(c[k].trim(), { img2img: k === 'flujo_img2img' });
      if (!l.ok) throw new ErrorAjuste(`El flujo ${k === 'flujo_txt2img' ? 'de txt2img' : 'de img2img'}: ${l.motivo}`, `imagenes.comfyui.${k}`);
      sal[k] = c[k].trim();
    }
    if (c.nodo_salida !== undefined) {
      if (c.nodo_salida === null || c.nodo_salida === '') quitar('nodo_salida');
      else if (!RE_NODO.test(String(c.nodo_salida))) throw new ErrorAjuste('El nodo de salida tiene que ser el id de un nodo del flujo', 'imagenes.comfyui.nodo_salida');
      else sal.nodo_salida = String(c.nodo_salida);
    }
    for (const [k, r] of Object.entries(RANGOS)) {
      if (c[k] === undefined) continue;
      if (c[k] === null) { quitar(k); continue; }
      if (!Number.isInteger(c[k]) || c[k] < r.min || c[k] > r.max) throw new ErrorAjuste(`imagenes.comfyui.${k} tiene que ser un entero de ${r.min} a ${r.max}`, `imagenes.comfyui.${k}`);
      sal[k] = c[k];
    }
    if (c.liberar_gpu !== undefined) {
      if (typeof c.liberar_gpu !== 'boolean') throw new ErrorAjuste('imagenes.comfyui.liberar_gpu tiene que ser true o false', 'imagenes.comfyui.liberar_gpu');
      sal.liberar_gpu = c.liberar_gpu;
    }
    if (Object.keys(sal).length) nuevo.comfyui = sal; else delete nuevo.comfyui;
  }
  for (const campo of Object.values(REMOTOS)) {
    if (pedido[campo] === undefined) continue;
    const r = pedido[campo];
    if (r === null) { delete nuevo[campo]; continue; }
    if (!esObjeto(r)) throw new ErrorAjuste(`imagenes.${campo} tiene que ser un objeto { url, modelo, key_env }`, `imagenes.${campo}`);
    for (const k of Object.keys(r)) if (!['url', 'modelo', 'key_env'].includes(k)) throw new ErrorAjuste(`imagenes.${campo}.${k} no está permitido`, `imagenes.${campo}.${k}`);
    const sal = esObjeto(previo[campo]) ? { ...previo[campo] } : {};
    if (r.url !== undefined) {
      if (r.url === null || r.url === '') delete sal.url;
      else if (!esHttps(r.url)) throw new ErrorAjuste('La URL tiene que ser https', `imagenes.${campo}.url`);
      else sal.url = String(r.url).trim();
    }
    if (r.modelo !== undefined) {
      if (r.modelo === null || r.modelo === '') delete sal.modelo;
      else if (!texto(r.modelo)) throw new ErrorAjuste(`El modelo tiene que ser un nombre (hasta ${MAX_TEXTO} caracteres)`, `imagenes.${campo}.modelo`);
      else sal.modelo = texto(r.modelo);
    }
    if (r.key_env !== undefined) {
      if (r.key_env === null || r.key_env === '') delete sal.key_env;
      else if (!RE_KEY_ENV.test(String(r.key_env))) throw new ErrorAjuste('key_env es el NOMBRE de la variable del .env (MAYÚSCULAS_Y_GUIONES), nunca la key', `imagenes.${campo}.key_env`);
      else sal.key_env = String(r.key_env);
    }
    if (Object.keys(sal).length) nuevo[campo] = sal; else delete nuevo[campo];
  }
  const salida = { ...datos };
  if (Object.keys(nuevo).length) salida.imagenes = nuevo; else delete salida.imagenes;
  return salida;
}

module.exports = {
  PROVEEDORES, REMOTOS, BOOLEANOS, CAMPOS, RANGOS, URL_COMFYUI, PLANTILLA_TXT2IMG, PLANTILLA_IMG2IMG,
  defectos, esLoopback, esHttps, formaDeFlujo, leerFlujo, marcadoresDe, normalizar, denyDe, flujosEfectivos, leerImagenes, crudoImagenes, aplicarImagenes
};
