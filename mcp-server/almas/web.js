/**
 * FEAT-172 F3 — Búsqueda web y lectura de links para las almas, con las APIs
 * de DeepSeek (`POST /v1/tools/search` y `/v1/tools/fetch`, $0,75 cada 1000
 * llamadas exitosas). El alma no las llama: pide en su bloque y el código
 * decide si la consulta sale (§7.3 del plan) y la ejecuta acá.
 *
 * Lo que vuelve es de afuera: no llega al alma crudo, lo resume el mediador
 * aislado (`mediador.sintetizar`) y el hilo queda contaminado.
 *
 * Mismos principios que `deepseek-ejecutar.js`: la key se lee del `.env` en
 * cada pedido y nada de lo que sale de acá lleva la key ni el mensaje del
 * proveedor.
 */

const { URL_BASE, leerKey, errorPorEstado } = require('../motores/deepseek-ejecutar.js');
const { tokensSignificativos } = require('./archivo.js');

const USER_AGENT = 'lagrange-almas';
const TIMEOUT_MS = 20000;
const CANTIDAD = 8;
const MAXIMO_RESULTADOS = 5;
const RERANK_BUENO = 1.5;
const TOPE_CONTENIDO = 30000;

const MIN_CONSULTA = 3;
const MAX_CONSULTA = 100;
const MAX_PALABRAS = 12;
// Los únicos operadores que pasan: idioma y fechas. `site:`, comillas, `-` y
// `OR` se quitan (sirven para apuntar la búsqueda, no para preguntar algo).
const OPERADOR_PERMITIDO = /^(lang:[a-z]{2}(,[a-z]{2})*|after:\d{4}(-\d{2}(-\d{2})?)?|before:\d{4}(-\d{2}(-\d{2})?)?)$/i;
const RE_URL = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|ar|es|dev|app|me)(\/|\b)/i;

/**
 * La consulta que puede salir, o por qué no.
 *
 * En un hilo contaminado, una inyección podría hacer que el alma saque por la
 * consulta lo que sabe del usuario. Se rechaza un token que esté en
 * `prohibidos` (lo que el alma sabe: `usuario.md`, su memoria, su archivo) y no
 * en `permitidos` (lo que escribió el usuario en este turno y lo que trajeron
 * los mediadores en ese hilo). Igualdad exacta (sin plural), no por prefijo:
 * una palabra común no se frena por parecerse a otra.
 *
 * Medido en vivo (2026-10-20): el modelo reformula, y en inglés («latest
 * stable release»). Exigir que cada palabra viniera del usuario frenaba eso;
 * esto frena solo lo que sale de la memoria.
 *
 * `{ ok: true, consulta }` o `{ ok: false, motivo }`.
 */
function validarConsulta(cruda, { contaminado = false, permitidos = [], prohibidos = [] } = {}) {
  const texto = String(cruda || '').replace(/\s+/g, ' ').trim();
  const palabras = [];
  for (const p of texto.replace(/["“”«»]/g, ' ').split(' ')) {
    if (!p) continue;
    if (/^site:/i.test(p)) continue;
    if (RE_URL.test(p)) return { ok: false, motivo: 'la consulta tenía una URL' };
    if (/^[a-z]+:/i.test(p)) {
      if (OPERADOR_PERMITIDO.test(p)) palabras.push(p.toLowerCase());
      continue;
    }
    if (/^-/.test(p) || /^OR$/.test(p)) continue;
    palabras.push(p);
  }
  const consulta = palabras.join(' ');
  // Después de quitar los operadores: `site:malo.com` se va, una URL suelta no.
  if (RE_URL.test(consulta)) return { ok: false, motivo: 'la consulta tenía una URL' };
  if (consulta.length < MIN_CONSULTA) return { ok: false, motivo: 'la consulta quedó vacía' };
  if (consulta.length > MAX_CONSULTA) return { ok: false, motivo: `la consulta pasa los ${MAX_CONSULTA} caracteres` };
  if (palabras.length > MAX_PALABRAS) return { ok: false, motivo: `la consulta pasa las ${MAX_PALABRAS} palabras` };
  if (contaminado) {
    const libres = tokensSignificativos(palabras.filter(p => !OPERADOR_PERMITIDO.test(p)).join(' '));
    // `tokensSignificativos` pliega tildes y mayúsculas: lo de los dos lados queda igual.
    const tuyos = tokensSignificativos(permitidos.join(' '));
    const sabidos = tokensSignificativos(prohibidos.join(' '));
    const esta = (t, lista) => lista.some(x => mismaPalabra(t, x));
    if (libres.some(t => esta(t, sabidos) && !esta(t, tuyos))) {
      return { ok: false, motivo: 'la consulta usaba algo que sé de vos y que no dijiste en este mensaje' };
    }
  }
  return { ok: true, consulta };
}

/** Las URLs que aparecen en un texto, tal cual (sin la puntuación final). */
/**
 * La misma palabra, o una en singular y la otra en plural (`-s` o `-es`, en
 * cualquier dirección): `paciente`/`pacientes`, `pared`/`paredes`,
 * `service`/`services`. Nunca por prefijo: `juego` y `jugador` son distintas.
 */
function mismaPalabra(a, b) {
  if (a === b) return true;
  const [corta, larga] = a.length < b.length ? [a, b] : [b, a];
  return larga === `${corta}s` || larga === `${corta}es`;
}

function urlsDe(texto) {
  return (String(texto || '').match(/https?:\/\/[^\s<>"'«»]+/gi) || []).map(u => u.replace(/[.,;:!?)\]]+$/, ''));
}

/**
 * ¿Se puede leer esta URL? Solo si el usuario la escribió en este turno o vino
 * entre las fuentes de una búsqueda de este hilo. Nunca una que armó el alma:
 * el path o los parámetros son el canal de exfiltración más directo.
 */
function validarLink(cruda, { textoUsuario = '', fuentes = [] } = {}) {
  const url = String(cruda || '').trim().replace(/[.,;:!?)\]]+$/, '');
  let u;
  try { u = new URL(url); } catch { return { ok: false, motivo: 'no es una URL' }; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return { ok: false, motivo: 'solo leo http(s) sin credenciales' };
  const conocidas = new Set([...urlsDe(textoUsuario), ...fuentes]);
  if (!conocidas.has(url)) return { ok: false, motivo: 'solo leo links que me pasaste vos o que salieron de una búsqueda' };
  return { ok: true, url };
}

async function pedir(ruta, cuerpo, { leer = leerKey, fetchImpl = globalThis.fetch, signal } = {}) {
  const key = await leer();
  if (!key) return { ok: false, motivo: 'para buscar en internet hace falta DEEPSEEK_API_KEY' };
  let r;
  try {
    r = await fetchImpl(`${URL_BASE}${ruta}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(cuerpo),
      signal: signal || AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    return { ok: false, motivo: 'la búsqueda no respondió' };
  }
  let texto = '';
  try { texto = await r.text(); } catch {}
  if (!r.ok) {
    if (ruta.endsWith('/fetch') && (r.status === 403 || r.status === 404)) return { ok: false, motivo: 'la página no se deja leer' };
    if ([401, 402, 429].includes(r.status) || r.status >= 500) return { ok: false, motivo: errorPorEstado(r.status) };
    return { ok: false, motivo: `la búsqueda no respondió (${r.status})` };
  }
  try {
    return { ok: true, datos: JSON.parse(texto) };
  } catch {
    return { ok: false, motivo: 'la búsqueda devolvió algo ilegible' };
  }
}

function dominio(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Busca y se queda con hasta 5 resultados buenos (`rerank_score ≥ 1.5`; si
 * ninguno llega, los 3 mejores). `{ ok, resultados: [{titulo, url, dominio, texto, fecha}] }`.
 */
async function buscarWeb(consulta, opciones = {}) {
  const r = await pedir('/v1/tools/search', { query: consulta, count: CANTIDAD, need_content: false }, opciones);
  if (!r.ok) return r;
  const crudos = Array.isArray(r.datos && r.datos.results) ? r.datos.results : [];
  const ordenados = [...crudos].sort((a, b) => (Number(b.rerank_score) || 0) - (Number(a.rerank_score) || 0));
  const buenos = ordenados.filter(x => Number(x.rerank_score) >= RERANK_BUENO);
  const elegidos = (buenos.length ? buenos : ordenados.slice(0, 3)).slice(0, MAXIMO_RESULTADOS);
  const resultados = elegidos
    .filter(x => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
    .map(x => ({
      titulo: String(x.title || '').slice(0, 200),
      url: x.url,
      dominio: dominio(x.url),
      texto: String(x.summary || x.snippet || '').slice(0, 1200),
      fecha: typeof x.date === 'string' ? x.date.slice(0, 10) : null
    }));
  return { ok: true, resultados };
}

/** Lee una página. `{ ok, titulo, texto, dominio }` con el contenido recortado. */
async function leerLink(url, opciones = {}) {
  const r = await pedir('/v1/tools/fetch', { url }, opciones);
  if (!r.ok) return r;
  const texto = String((r.datos && r.datos.content) || '').slice(0, TOPE_CONTENIDO);
  if (!texto.trim()) return { ok: false, motivo: 'la página no tenía texto' };
  return { ok: true, titulo: String((r.datos && r.datos.title) || '').slice(0, 200), texto, dominio: dominio(url) };
}

module.exports = {
  MAX_CONSULTA, MAX_PALABRAS, RERANK_BUENO,
  validarConsulta, validarLink, mismaPalabra, urlsDe, buscarWeb, leerLink, dominio
};
