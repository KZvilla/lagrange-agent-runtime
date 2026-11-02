'use strict';

/**
 * BE-172 — Escritura atómica compartida para `mcp-server`.
 *
 * Temporal único + `rename`, con reintento corto ante los bloqueos transitorios
 * de Windows (`EPERM`/`EBUSY`/`EACCES`). No lee, no toma locks y no interpreta
 * JSON: cada módulo conserva su semántica.
 *
 * `mode: null` (default) no pasa `mode` a `writeFileSync`, así se conserva el
 * modo que cada archivo tenía (`0o666 & ~umask`). Los archivos sensibles pasan
 * `mode: 0o600` explícito.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OCUPADO_TRANSITORIO = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ESPERA_RENOMBRE_MS = 1000;

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function escribirAtomico(ruta, contenido, { mode = null, esperaRenombreMs = ESPERA_RENOMBRE_MS } = {}) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const temporal = `${ruta}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const opciones = { encoding: 'utf8' };
  if (mode !== null && mode !== undefined) opciones.mode = mode;

  try {
    fs.writeFileSync(temporal, contenido, opciones);
    const limite = Date.now() + esperaRenombreMs;
    for (;;) {
      try {
        fs.renameSync(temporal, ruta);
        return;
      } catch (err) {
        if (!OCUPADO_TRANSITORIO.has(err.code) || Date.now() >= limite) throw err;
        dormir(20);
      }
    }
  } catch (err) {
    try { fs.unlinkSync(temporal); } catch {}
    throw err;
  }
}

module.exports = { escribirAtomico, ESPERA_RENOMBRE_MS, OCUPADO_TRANSITORIO };
