/**
 * FEAT-172 — Los hilos de un alma que recibieron contenido de afuera.
 *
 * La descripción de una foto, los resultados de una búsqueda o una página
 * quedan en el historial del hilo (del proveedor en agy/Claude, `hilo-local.js`
 * en DeepSeek). Una inyección puede actuar en cualquier turno siguiente, así
 * que la marca es del HILO: mientras dure, el alma no escribe memoria ni toca el
 * tablero. Se va sola cuando el hilo se renueva, porque el nuevo tiene otro id.
 *
 *   <dir del alma>/contaminados.json
 *   { "<conversationId>": { desde, motivos: ['foto'], tokens: ['potus', …], fuentes: ['https://…'] } }
 *
 * Va aparte de `estado.json`, que es un registro liviano de ids y fechas.
 * `tokens` son los significativos de lo que trajeron los mediadores: la regla
 * de la consulta web en un hilo contaminado (§7.3) los usa. `fuentes` son las
 * URLs que trajo una búsqueda: las únicas, con las del usuario, que se pueden leer.
 *
 * **Falla cerrado:** un archivo ilegible cuenta como contaminado.
 */

const path = require('node:path');
const { leerJson, guardarJson } = require('../agents/almacen.js');
const { conLock } = require('./archivos.js');
const rutas = require('./rutas.js');

const VIDA_MS = 7 * 24 * 60 * 60 * 1000;
const TOPE_TOKENS = 300;
const TOPE_FUENTES = 30;

function ruta(clave, env = process.env) {
  return path.join(rutas.rutasDe(clave, env).dir, 'contaminados.json');
}

function leer(clave, env) {
  const { datos, ilegible } = leerJson(ruta(clave, env));
  return { hilos: datos && typeof datos === 'object' && !Array.isArray(datos) ? datos : {}, ilegible };
}

/** ¿Este hilo trajo contenido de afuera? Sin hilo, no. Ante la duda, sí. */
function contaminado(clave, conversationId, env = process.env) {
  if (!conversationId) return false;
  try {
    const { hilos, ilegible } = leer(clave, env);
    return ilegible || Boolean(hilos[conversationId]);
  } catch {
    return true;
  }
}

/** Los tokens que trajeron los mediadores en ese hilo (`[]` si no hay). */
function tokensDe(clave, conversationId, env = process.env) {
  if (!conversationId) return [];
  try {
    const h = leer(clave, env).hilos[conversationId];
    return h && Array.isArray(h.tokens) ? h.tokens : [];
  } catch {
    return [];
  }
}

/** Las URLs que trajo una búsqueda en ese hilo (`[]` si no hay). */
function fuentesDe(clave, conversationId, env = process.env) {
  if (!conversationId) return [];
  try {
    const h = leer(clave, env).hilos[conversationId];
    return h && Array.isArray(h.fuentes) ? h.fuentes : [];
  } catch {
    return [];
  }
}

/**
 * Marca el hilo, suma el motivo y los tokens (sin repetir, con tope) y poda
 * lo de más de 7 días. Lanza si no puede escribir: quien llama decide, y
 * `charlar` igual bloquea la memoria de ese turno.
 */
function marcar(clave, conversationId, { motivo, tokens = [], fuentes = [] } = {}, env = process.env, ahora = Date.now()) {
  if (!conversationId) return null;
  const destino = ruta(clave, env);
  return conLock(destino, () => {
    const { hilos, ilegible } = leer(clave, env);
    for (const [id, h] of Object.entries(hilos)) {
      if (!h || !(ahora - Date.parse(h.desde || '') <= VIDA_MS)) delete hilos[id];
    }
    const previo = hilos[conversationId] || { desde: new Date(ahora).toISOString(), motivos: [], tokens: [], fuentes: [] };
    const motivos = [...new Set([...(previo.motivos || []), ...(motivo ? [String(motivo)] : [])])];
    const juntos = [...new Set([...(previo.tokens || []), ...tokens.map(t => String(t).toLowerCase())])];
    const urls = [...new Set([...(previo.fuentes || []), ...fuentes.map(String)])];
    hilos[conversationId] = { desde: previo.desde, motivos, tokens: juntos.slice(-TOPE_TOKENS), fuentes: urls.slice(-TOPE_FUENTES) };
    guardarJson(destino, hilos, { ilegible });
    return hilos[conversationId];
  });
}

module.exports = { VIDA_MS, TOPE_TOKENS, TOPE_FUENTES, ruta, contaminado, tokensDe, fuentesDe, marcar };
