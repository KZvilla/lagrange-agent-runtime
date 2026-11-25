'use strict';

/**
 * FEAT-212 §6 — El catálogo de ComfyUI (`GET /object_info`): modelos, LoRAs, samplers y nodos instalados.
 *
 * Una caché de módulo por URL: 5 minutos si respondió, 30 segundos si falló, y
 * un solo pedido en vuelo. `catalogoDe` es la única entrada y nunca lanza: sin
 * respuesta devuelve `null`. `enCache` mira sin pedir nada.
 */

const ajustes = () => require('../lib/ajustes-imagenes.js');

const DURA_OK_MS = 5 * 60 * 1000;
const DURA_FALLO_MS = 30 * 1000;
const TIEMPO_MS = 15 * 1000;
const TOPE_BYTES = 32 * 1024 * 1024;
const MAX_LISTA = 2000;

/** url → `{ cache: { catalogo, hasta } | null, enVuelo: Promise | null }`. */
const porUrl = new Map();

const normalizarUrl = (url) => String(url || '').trim().replace(/\/+$/, '');
const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Las opciones de un combo, en sus dos formas: la lista directa o `["COMBO", { options }]`. */
function opcionesDe(info, clase, entrada) {
  const n = info[clase];
  const req = n && esObjeto(n.input) ? { ...(n.input.optional || {}), ...(n.input.required || {}) } : {};
  const def = req[entrada];
  if (!Array.isArray(def)) return [];
  const lista = Array.isArray(def[0]) ? def[0] : def[0] === 'COMBO' && esObjeto(def[1]) && Array.isArray(def[1].options) ? def[1].options : [];
  return lista.filter((x) => typeof x === 'string').slice(0, MAX_LISTA);
}

/** El `/object_info` crudo, en lo que usa el plugin. */
function leerObjectInfo(info) {
  const archivos = (...pares) => {
    const vistos = new Set();
    for (const [clase, entrada] of pares) for (const v of opcionesDe(info, clase, entrada)) vistos.add(v);
    // La etiqueta es la ruta relativa: dos archivos con el mismo nombre en carpetas distintas se ven distintos.
    return [...vistos].slice(0, MAX_LISTA).map((valor) => ({ valor, etiqueta: valor.replace(/\\/g, '/') }));
  };
  return {
    checkpoints: archivos(['CheckpointLoaderSimple', 'ckpt_name']),
    unets: archivos(['UNETLoader', 'unet_name']),
    clips: archivos(['DualCLIPLoader', 'clip_name1'], ['DualCLIPLoader', 'clip_name2']),
    vaes: archivos(['VAELoader', 'vae_name']),
    loras: archivos(['LoraLoader', 'lora_name'], ['LoraLoaderModelOnly', 'lora_name']),
    samplers: opcionesDe(info, 'KSampler', 'sampler_name'),
    schedulers: opcionesDe(info, 'KSampler', 'scheduler'),
    nodos: new Set(Object.keys(info))
  };
}

async function pedir(url, { fetchImpl, tiempoMs, topeBytes }) {
  try {
    const signal = AbortSignal.timeout(tiempoMs);
    const r = await fetchImpl(`${url}/object_info`, { signal });
    if (!r.ok) return null;
    let texto;
    if (r.body && typeof r.body.getReader === 'function') {
      // El tope corta mientras llega: un cuerpo enorme no se junta entero en memoria.
      const lector = r.body.getReader();
      const partes = [];
      let total = 0;
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        total += value.byteLength;
        if (total > topeBytes) { try { await lector.cancel(); } catch {} return null; }
        partes.push(Buffer.from(value));
      }
      texto = Buffer.concat(partes).toString('utf8');
    } else {
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > topeBytes) return null;
      texto = bytes.toString('utf8');
    }
    const info = JSON.parse(texto);
    return esObjeto(info) ? leerObjectInfo(info) : null;
  } catch {
    return null;
  }
}

/** El catálogo de esa URL, de la caché o con un pedido. `forzar` ignora la caché. `null` si no hay catálogo. */
async function catalogoDe(url, { forzar = false, fetchImpl = globalThis.fetch, ahora = () => Date.now(), tiempoMs = TIEMPO_MS, topeBytes = TOPE_BYTES } = {}) {
  const u = normalizarUrl(url);
  if (!ajustes().esLoopback(u)) return null;
  let e = porUrl.get(u);
  if (!e) { e = { cache: null, enVuelo: null }; porUrl.set(u, e); }
  if (e.enVuelo) return e.enVuelo;
  if (!forzar && e.cache && ahora() < e.cache.hasta) return e.cache.catalogo;
  e.enVuelo = pedir(u, { fetchImpl, tiempoMs, topeBytes }).then((catalogo) => {
    const t = ahora();
    if (catalogo) e.cache = { catalogo, hasta: t + DURA_OK_MS };
    // Un forzado que falla no pisa un catálogo vigente.
    else if (!(e.cache && e.cache.catalogo && t < e.cache.hasta)) e.cache = { catalogo: null, hasta: t + DURA_FALLO_MS };
    return catalogo;
  }).finally(() => { e.enVuelo = null; });
  return e.enVuelo;
}

/** El catálogo vigente de esa URL, sin pedir nada, o `null`. */
function enCache(url, { ahora = () => Date.now() } = {}) {
  const e = porUrl.get(normalizarUrl(url));
  return e && e.cache && e.cache.catalogo && ahora() < e.cache.hasta ? e.cache.catalogo : null;
}

/** Lo que viaja a la terminal: sin el Set de nodos. */
function publico(catalogo) {
  if (!catalogo) return null;
  const { nodos, ...resto } = catalogo;
  return resto;
}

function olvidarParaTests() { porUrl.clear(); }

module.exports = { DURA_OK_MS, DURA_FALLO_MS, TIEMPO_MS, TOPE_BYTES, leerObjectInfo, catalogoDe, enCache, publico, olvidarParaTests };
