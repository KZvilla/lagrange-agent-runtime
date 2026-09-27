/**
 * FEAT-089 §2.2 — Archivos JSON de la red (`servidor.json`, `nodos.json`,
 * `nodo.json`) con el mismo patrón que `state.json`: lock con `'wx'`, ciclo
 * leer-modificar-escribir completo adentro, escritura atómica por rename y el
 * EPERM de Windows tratado como ocupado (BE-050). En Linux, modo 0600: dos de
 * los tres guardan una clave privada.
 */

import fs from 'node:fs';
import path from 'node:path';

const OCUPADO_TRANSITORIO = new Set(['EPERM', 'EACCES', 'EBUSY']);
const ESPERA_LOCK_MS = 3000;
const LOCK_VIEJO_MS = 10_000;

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tomarLock(archivo) {
  const lock = `${archivo}.lock`;
  const limite = Date.now() + ESPERA_LOCK_MS;
  for (;;) {
    try {
      return { fd: fs.openSync(lock, 'wx'), lock };
    } catch (err) {
      if (OCUPADO_TRANSITORIO.has(err.code)) {
        if (Date.now() < limite) { dormir(10); continue; }
        return null;
      }
      if (err.code !== 'EEXIST') return null;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_VIEJO_MS) { fs.unlinkSync(lock); continue; }
      } catch {
        continue;
      }
      if (Date.now() >= limite) return null;
      dormir(20);
    }
  }
}

function soltarLock(tomado) {
  if (!tomado) return;
  try { fs.closeSync(tomado.fd); } catch {}
  try { fs.unlinkSync(tomado.lock); } catch {}
}

/** Contenido del archivo, o una copia de `vacio` si no existe o no se puede leer. */
export function leerJson(archivo, vacio = {}) {
  try {
    const datos = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return datos && typeof datos === 'object' ? datos : structuredClone(vacio);
  } catch {
    return structuredClone(vacio);
  }
}

/** Escritura atómica, 0600. */
export function escribirJson(archivo, datos) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, archivo);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Leer-modificar-escribir bajo lock. Lo que devuelva `fn` se propaga; con
 * `false` no se escribe.
 */
export function mutarJson(archivo, vacio, fn) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tomado = tomarLock(archivo);
  try {
    const datos = leerJson(archivo, vacio);
    const r = fn(datos);
    if (r !== false) escribirJson(archivo, datos);
    return r;
  } finally {
    soltarLock(tomado);
  }
}

export function borrarJson(archivo) {
  try { fs.unlinkSync(archivo); return true; } catch { return false; }
}
