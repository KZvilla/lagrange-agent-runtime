/**
 * FEAT-201 F0 S2 — La credencial del contrato v2 (`api-v2.json`).
 *
 * Es distinta del token de la consola (`web-token.json`): la consola congelada
 * no abre v2 y v2 no abre la consola. Se escribe al arrancar, con
 * `escribirAtomico` y modo 0o600 desde el primer arranque, y lleva
 * `{ url, token, pid, creado, arranque }`. `arranque` es el UUID del proceso
 * (`INSTANCIA_PROCESO`), no una hora.
 *
 * El lector falla cerrado: el PID tiene que estar vivo, `creado` tiene que caer
 * entre el inicio de ese proceso (según el sistema operativo) y ahora, y, si se
 * pide, `arranque` tiene que ser el esperado. Un PID reciclado tiene un inicio
 * posterior a `creado`; una fecha futura no pasa.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { escribirAtomico } = require('../../../mcp-server/lib/fs-atomico.js');

export const ARCHIVO_API_V2 = 'api-v2.json';
// Margen para el redondeo de las horas de inicio que da el sistema operativo.
const MARGEN_INICIO_MS = 2000;

export function nuevoToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function escribirCredencial(archivo, { url, token, pid = process.pid, arranque, creado = new Date().toISOString() }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('La credencial v2 necesita un token de al menos 32 caracteres.');
  if (typeof arranque !== 'string' || !arranque || arranque.includes(':')) throw new Error('La credencial v2 necesita un arranque opaco, sin «:».');
  escribirAtomico(archivo, JSON.stringify({ url, token, pid, creado, arranque }, null, 2), { mode: 0o600 });
}

/** Borra el archivo solo si es de este proceso: otro daemon pudo haberlo reescrito. */
export function borrarCredencial(archivo, pid = process.pid) {
  try {
    const guardado = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    if (guardado.pid === pid) fs.unlinkSync(archivo);
  } catch {}
}

export function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Hora de inicio de un proceso en ms, o `null` si no se puede saber. */
export function inicioDeProceso(pid, { plataforma = process.platform, ejecutar = spawnSync, leer = fs.readFileSync } = {}) {
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  try {
    if (plataforma === 'win32') {
      const r = ejecutar('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const ms = Date.parse(String(r.stdout || '').trim());
      return Number.isFinite(ms) ? ms : null;
    }
    if (plataforma === 'linux') {
      // Campo 22 de /proc/<pid>/stat: arranque en ticks desde el boot; btime de /proc/stat: el boot en segundos.
      const stat = String(leer(`/proc/${Number(pid)}/stat`, 'utf8'));
      const campos = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(campos[19]);
      const btime = Number(/^btime (\d+)$/m.exec(String(leer('/proc/stat', 'utf8')))?.[1]);
      const hz = 100;
      return Number.isFinite(ticks) && Number.isFinite(btime) ? btime * 1000 + (ticks / hz) * 1000 : null;
    }
  } catch {}
  return null;
}

/**
 * `{ ok: true, credencial }` o `{ ok: false, motivo }`. Falla cerrado: lo que no
 * se puede comprobar no pasa.
 */
export function leerCredencial(archivo, { vivo = pidVivo, inicio = inicioDeProceso, ahora = Date.now, arranqueEsperado = null } = {}) {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch {
    return { ok: false, motivo: 'sin-archivo' };
  }
  if (!c || typeof c.token !== 'string' || c.token.length < 32 || typeof c.url !== 'string' || typeof c.arranque !== 'string') {
    return { ok: false, motivo: 'mal-formado' };
  }
  if (!vivo(c.pid)) return { ok: false, motivo: 'pid-muerto' };
  const creado = Date.parse(c.creado);
  if (!Number.isFinite(creado)) return { ok: false, motivo: 'mal-formado' };
  if (creado > ahora() + MARGEN_INICIO_MS) return { ok: false, motivo: 'creado-futuro' };
  const desde = inicio(c.pid);
  if (desde === null) return { ok: false, motivo: 'inicio-desconocido' };
  if (creado + MARGEN_INICIO_MS < desde) return { ok: false, motivo: 'pid-reciclado' };
  if (arranqueEsperado !== null && c.arranque !== arranqueEsperado) return { ok: false, motivo: 'otro-arranque' };
  return { ok: true, credencial: c };
}
