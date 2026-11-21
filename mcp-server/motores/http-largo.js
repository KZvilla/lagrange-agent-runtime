/**
 * Un POST que espera lo que diga el plazo del pedido, y no los 5 minutos del `fetch` de Node.
 *
 * El `fetch` global de Node (undici) corta con `UND_ERR_HEADERS_TIMEOUT` si los headers de la respuesta no llegan en
 * 300 s, y con `UND_ERR_BODY_TIMEOUT` si el cuerpo se queda quieto 300 s. Un pedido sin streaming no recibe headers
 * hasta que el modelo termina, y una respuesta larga en esfuerzo `max` (una auditoría, al final) pasa los 5 minutos:
 * la corrida se cortaba como «sin conexión» aunque el plazo del ejecutor fuera de 30.
 *
 * Esto es `node:https` (o `node:http`) sin timeouts propios: el plazo lo pone el `signal` del ejecutor. Devuelve la
 * parte de `Response` que usan los ejecutores (`ok`, `status`, `text()`), y un error de red sale con su `code`.
 */

const http = require('node:http');
const https = require('node:https');

function fetchLargo(url, { method = 'GET', headers = {}, body = null, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(errorDeAbortar()); return; }
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const cuerpo = body == null ? null : Buffer.from(String(body));
    const req = mod.request(u, {
      method,
      headers: { ...headers, ...(cuerpo ? { 'content-length': cuerpo.length } : {}) },
      ...(signal ? { signal } : {})
    }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        const status = res.statusCode || 0;
        resolve({ ok: status >= 200 && status < 300, status, text: async () => texto });
      });
    });
    req.on('error', (e) => reject(signal && signal.aborted ? errorDeAbortar() : e));
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

function errorDeAbortar() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  e.code = 'ABORT_ERR';
  return e;
}

/** El código de un error de red, para el texto: `ECONNRESET`, `ENOTFOUND`, `UND_ERR_*`… o `null`. */
function codigoDeRed(e) {
  if (!e) return null;
  const c = e.code || (e.cause && e.cause.code) || null;
  return typeof c === 'string' && /^[A-Z_0-9]{2,40}$/.test(c) ? c : null;
}

/** Errores en los que la conexión ni se abrió: reintentar no repite trabajo del modelo. */
const SIN_CONECTAR = Object.freeze(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

module.exports = { fetchLargo, codigoDeRed, SIN_CONECTAR };
