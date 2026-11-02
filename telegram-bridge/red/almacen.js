/**
 * FEAT-089 §2.2 — Archivos JSON de la red (`servidor.json`, `nodos.json`,
 * `nodo.json`) con el mismo patrón que `state.json`: lock con `'wx'`, ciclo
 * leer-modificar-escribir completo adentro, escritura atómica por rename y el
 * EPERM de Windows tratado como ocupado (BE-050). En Linux, modo 0600: dos de
 * los tres guardan una clave privada.
 *
 * BE-171 — Una lectura que no distingue «no existe» de «existe y no se
 * entiende» no puede mutar: `mutarJson` usa `leerJsonEstricto`, cuarentena el
 * archivo corrupto y aborta. Un error de E/S (EACCES, EPERM, EBUSY, EROFS,
 * ENOSPC) no es corrupción: se propaga sin copia y sin escribir.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { escribirAtomico } from '../fs-atomico.js';

const OCUPADO_TRANSITORIO = new Set(['EPERM', 'EACCES', 'EBUSY']);
const ESPERA_LOCK_MS = 3000;
const LOCK_VIEJO_MS = 10_000;

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class JsonCorruptoError extends SyntaxError {
  constructor(archivo, causa, tipo = 'syntax') {
    super(`JSON corrupto en ${archivo}: ${causa.message}`);
    this.name = 'JsonCorruptoError';
    this.code = 'EJSONCORRUPTO';
    this.causa = tipo;
    this.archivo = archivo;
    this.contenido = null;
  }
}

function errorLockOcupado(lock, esperaMs) {
  return Object.assign(new Error(`No se pudo tomar ${lock} en ${esperaMs} ms: otro proceso lo tiene.`), {
    code: 'EBUSY',
    archivo: lock,
    esperaMs
  });
}

function tomarLock(archivo, { esperaLockMs = ESPERA_LOCK_MS, lockViejoMs = LOCK_VIEJO_MS } = {}) {
  const lock = `${archivo}.lock`;
  const limite = Date.now() + esperaLockMs;
  for (;;) {
    try {
      return { fd: fs.openSync(lock, 'wx'), lock };
    } catch (err) {
      if (err.code === 'EEXIST') {
        let edad;
        try {
          edad = Date.now() - fs.statSync(lock).mtimeMs;
        } catch (statErr) {
          if (statErr.code === 'ENOENT') continue;
          throw statErr;
        }
        if (edad > lockViejoMs) {
          try {
            fs.unlinkSync(lock);
          } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
          }
          continue;
        }
        if (Date.now() >= limite) throw errorLockOcupado(lock, esperaLockMs);
        dormir(20);
        continue;
      }

      if (OCUPADO_TRANSITORIO.has(err.code)) {
        // En Windows, `open(..., "wx")` puede dar EPERM/EACCES/EBUSY mientras
        // otro proceso está borrando el lock. Si el lock sigue ahí, es
        // contención; si no, el error es real (permisos del directorio).
        if (Date.now() >= limite) {
          if (fs.existsSync(lock)) throw errorLockOcupado(lock, esperaLockMs);
          throw err;
        }
        dormir(10);
        continue;
      }

      throw err;
    }
  }
}

function soltarLock(tomado) {
  if (!tomado) return;
  try { fs.closeSync(tomado.fd); } catch {}
  try { fs.unlinkSync(tomado.lock); } catch {}
}

/**
 * Lectura permisiva para llamadores de solo lectura: un archivo ausente,
 * ilegible o corrupto devuelve una copia de `vacio`. No usar para mutar:
 * `mutarJson` usa `leerJsonEstricto`.
 */
export function leerJson(archivo, vacio = {}) {
  try {
    const datos = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return datos && typeof datos === 'object' ? datos : structuredClone(vacio);
  } catch {
    return structuredClone(vacio);
  }
}

/**
 * Lectura para mutar. Solo `ENOENT` devuelve `vacio`; un `JSON.parse` inválido
 * lanza `JsonCorruptoError` con los bytes leídos; cualquier error de E/S se
 * propaga tal cual.
 */
export function leerJsonEstricto(archivo, vacio = {}) {
  let crudo;
  try {
    crudo = fs.readFileSync(archivo, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(vacio);
    throw err;
  }

  let datos;
  try {
    datos = JSON.parse(crudo);
  } catch (err) {
    if (err instanceof SyntaxError) {
      const corrupto = new JsonCorruptoError(archivo, err);
      corrupto.contenido = crudo;
      throw corrupto;
    }
    throw err;
  }

  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
    const corrupto = new JsonCorruptoError(archivo, new Error('se esperaba un objeto JSON'), 'shape');
    corrupto.contenido = crudo;
    throw corrupto;
  }
  return datos;
}

function cuarentena(archivo, contenido) {
  const base = `${archivo}.corrupto-${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  for (let intento = 0; intento < 3; intento++) {
    const copia = intento === 0 ? base : `${base}-${intento}`;
    try {
      fs.writeFileSync(copia, contenido, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') {
        // El modo de writeFileSync respeta la umask; en POSIX se fija después.
        try {
          fs.chmodSync(copia, 0o600);
        } catch (err) {
          try { fs.unlinkSync(copia); } catch {}
          throw err;
        }
      }
      return copia;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`No se pudo crear la cuarentena de ${archivo}`);
}

/** Escritura atómica, 0600. */
export function escribirJson(archivo, datos) {
  escribirAtomico(archivo, JSON.stringify(datos, null, 2), { mode: 0o600 });
}

/**
 * Leer-modificar-escribir bajo lock. Lo que devuelva `fn` se propaga; con
 * `false` no se escribe. Si el archivo existe y no se entiende, se cuarentena
 * y se lanza: nunca se pisa. Si el lock no se toma, se lanza sin leer.
 */
export function mutarJson(archivo, vacio, fn, { esperaLockMs = ESPERA_LOCK_MS, lockViejoMs = LOCK_VIEJO_MS } = {}) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tomado = tomarLock(archivo, { esperaLockMs, lockViejoMs });
  try {
    const datos = leerJsonEstricto(archivo, vacio);
    const r = fn(datos);
    if (r !== false) escribirJson(archivo, datos);
    return r;
  } catch (err) {
    if (err instanceof JsonCorruptoError) {
      try {
        err.cuarentena = cuarentena(archivo, err.contenido ?? fs.readFileSync(archivo, 'utf8'));
      } catch (copiaErr) {
        err.cuarentenaError = copiaErr;
      }
      try {
        process.stderr.write(
          `[red] ${archivo} ilegible (${err.message}); ${err.cuarentena ? `copia en ${err.cuarentena}` : 'no se pudo crear la cuarentena'}. No se escribe.\n`
        );
      } catch {}
    }
    throw err;
  } finally {
    soltarLock(tomado);
  }
}

export function borrarJson(archivo) {
  try { fs.unlinkSync(archivo); return true; } catch { return false; }
}
