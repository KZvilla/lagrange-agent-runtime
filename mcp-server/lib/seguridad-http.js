/**
 * SEC-011 — Defensas de un servidor HTTP que solo atiende por loopback.
 *
 * Las comparten el visor (`fanout-watch.js`) y la consola web del bridge
 * (FEAT-052). Escuchar en 127.0.0.1 no alcanza: cualquier pestaña del
 * navegador puede pedirle cosas a loopback, y un dominio del atacante puede
 * resolver a 127.0.0.1 (DNS rebinding).
 */

const crypto = require('node:crypto');

const HOSTS_LOOPBACK = Object.freeze(['127.0.0.1', 'localhost', '::1']);

/**
 * Comparación en tiempo constante. Un `===` sobre el token filtra, por cuánto
 * tarda en fallar, cuántos caracteres acertó quien prueba.
 */
function tokenCoincide(esperado, recibido) {
  if (typeof esperado !== 'string' || typeof recibido !== 'string' || recibido.length !== esperado.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(esperado));
  } catch {
    return false;
  }
}

/**
 * Anti DNS rebinding: el navegador trataría la página del atacante como
 * mismo-origen nuestro. Lo que delata el intento es el `Host`.
 */
function hostEsLoopback(req) {
  const host = String(req.headers.host || '');
  const soloHost = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return HOSTS_LOOPBACK.includes(soloHost);
}

/**
 * Para las mutaciones. `Sec-Fetch-Site` lo pone el navegador y no se puede
 * falsear desde JavaScript; `Origin` cubre a los clientes que no lo mandan.
 * Un cliente sin navegador (curl, un test) no manda ninguno de los dos: eso
 * se acepta, porque ahí el token es toda la autenticación que hay y no existe
 * el problema de la petición cruzada involuntaria.
 */
function origenAceptable(req) {
  const sitio = req.headers['sec-fetch-site'];
  if (sitio && sitio !== 'same-origin' && sitio !== 'none') return false;

  const origen = req.headers.origin;
  if (!origen) return true;
  try {
    return HOSTS_LOOPBACK.includes(new URL(origen).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

module.exports = { HOSTS_LOOPBACK, tokenCoincide, hostEsLoopback, origenAceptable };
