'use strict';

/**
 * FEAT-092 §8 — En un nodo sin Voicebox, con Telegram y sin reproducción local,
 * el servidor presta su voz: el MCP le pasa al daemon del nodo el texto final
 * (ya pulido y en persona acá) y el servidor sintetiza y manda la nota.
 *
 * Resuelve con `null` si no aplica (no es un nodo), `{ ok: true, perfil }` si la
 * nota salió, o `{ ok: false, error }` para que quede el texto como hoy.
 */

const { enlaceDeNodo } = require('./almas-cliente.js');

async function vozDelServidor({ texto, voz = null, modo = null, idioma = null, alma = null, enlace = () => enlaceDeNodo(), fetchFn = globalThis.fetch, timeoutMs = 190_000 } = {}) {
  const e = enlace();
  if (!e) return null;
  try {
    const r = await fetchFn(new URL('/voz/narrar', e.url), {
      method: 'POST',
      headers: { 'x-lagrange-token': e.token, 'content-type': 'application/json' },
      // BE-059 — El idioma deja al servidor elegir su voz cuando no viene una.
      body: JSON.stringify({ texto, voz, modo, idioma, alma }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) return { ok: true, perfil: j.perfil || null, idioma: j.idioma || null };
    return { ok: false, error: j.error || `el daemon respondió ${r.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { vozDelServidor };
