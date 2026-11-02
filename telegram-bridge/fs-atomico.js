/**
 * BE-172 — Escritura atómica compartida para `telegram-bridge`.
 *
 * Misma semántica que `mcp-server/lib/fs-atomico.js`, pero en ESM y dentro del
 * paquete del bridge para no cruzar la frontera CJS/ESM. Temporal único +
 * `rename`, con reintento corto ante EPERM/EBUSY/EACCES de Windows.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const OCUPADO_TRANSITORIO = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ESPERA_RENOMBRE_MS = 1000;

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function escribirAtomico(ruta, contenido, { mode = null, esperaRenombreMs = ESPERA_RENOMBRE_MS } = {}) {
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

export { ESPERA_RENOMBRE_MS, OCUPADO_TRANSITORIO };
