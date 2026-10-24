/**
 * BE-164 — Identidad del arranque del sistema, para decidir si el PID de un
 * lock sigue siendo el daemon que lo escribió.
 *
 * Antes se usaba solo `Date.now() - os.uptime()` en minutos. En WSL2, cuando
 * Windows suspende la VM, el reloj de pared y el uptime se separan y un daemon
 * sano caía en `otro-arranque` («bridge caído» en la statusline). `btime` de
 * `/proc/stat` no sirve de ancla: se calcula igual. En Linux se usa
 * `/proc/sys/kernel/random/boot_id`, que no cambia hasta el próximo arranque;
 * para un lock viejo sin él, el ejecutable del PID vivo. Windows no cambia.
 *
 * Puro e inyectable: lo usan `bot.js` (al tomar el lock) y `paths.js`
 * (`estadoDaemon`, que lee la statusline y el MCP).
 */
import fs from 'node:fs';
import os from 'node:os';

const leerBootIdLinux = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');

/**
 * @returns {{ bootUuid: string|null, bootId: string|null }}
 *   Linux con `boot_id`: el UUID y `bootId` null. Otro sistema, o Linux sin
 *   `boot_id`: el minuto del arranque derivado del uptime.
 */
export function identidadDeArranque({
  plataforma = process.platform,
  ahora = Date.now(),
  uptime = os.uptime(),
  leerBootId = leerBootIdLinux
} = {}) {
  if (plataforma === 'linux') {
    try {
      const uuid = String(leerBootId()).trim();
      if (uuid) return { bootUuid: uuid, bootId: null };
    } catch {}
  }
  return { bootUuid: null, bootId: String(Math.floor((ahora - uptime * 1000) / 60000)) };
}

/** Ruta real del ejecutable de un PID (Linux, por `/proc/<pid>/exe`), o null. Nunca lanza. */
export function exeDePid(pid, { plataforma = process.platform, leerEnlace = fs.realpathSync } = {}) {
  if (plataforma !== 'linux' || !Number.isInteger(pid)) return null;
  try {
    return leerEnlace(`/proc/${pid}/exe`) || null;
  } catch {
    return null;
  }
}

/**
 * ¿El lock es de este arranque del sistema?
 *
 * @param {{ bootUuid?: string|null, bootId?: string|null, exe?: string|null }} lock
 * @param {{ bootUuid: string|null, bootId: string|null }} actual  `identidadDeArranque()`
 * @param {object} [o]
 * @param {boolean} [o.pidVivo]       si el PID del lock existe
 * @param {string|null} [o.exeVivo]   `exeDePid(lock.pid)`
 * @param {(p: string) => string} [o.realpath]
 * @returns {boolean|null} null si el lock no trae con qué decidir (formato legado).
 */
export function mismoArranque(lock, actual, { pidVivo = false, exeVivo = null, toleranciaMin = 1, realpath = fs.realpathSync } = {}) {
  if (lock?.bootUuid && actual?.bootUuid) return lock.bootUuid === actual.bootUuid;
  if (!lock?.bootUuid && pidVivo && lock?.exe && exeVivo) {
    let exeLock = lock.exe;
    try { exeLock = realpath(lock.exe); } catch {}
    return exeLock === exeVivo;
  }
  if (lock?.bootId != null && actual?.bootId != null) {
    return Math.abs(Number(lock.bootId) - Number(actual.bootId)) <= toleranciaMin;
  }
  if (!lock?.bootUuid && lock?.bootId == null) return null;
  return false;
}
