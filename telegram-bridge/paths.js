/**
 * Ubicación canónica de los datos vivos del bridge (estado y lockfile).
 *
 * El problema que resuelve
 * -----------------------
 * `state.json` y `bridge.lock` se resolvían como `path.join(__dirname, ...)`,
 * es decir, relativos a la carpeta del código que los abre. Eso da por supuesto
 * que solo existe una copia del bridge en la máquina, y no es cierto: el plugin
 * se instala en `~/.claude/plugins/marketplaces/<marketplace>/` mientras que el
 * desarrollo ocurre en el checkout del repositorio. Los dos procesos del bridge
 * no tienen por qué salir de la misma carpeta:
 *
 *   - `bot.js` lo lanza la tarea programada, que apunta al directorio desde el
 *     que se ejecutó `daemon.ps1 install`.
 *   - `notify.js` lo lanza el servidor MCP por spawn, relativo a SU propio
 *     `__dirname`, el del plugin instalado.
 *
 * Con dos `state.json` distintos, el human-in-the-loop no puede funcionar:
 * `telegram_ask` registra la pregunta en un fichero y `bot.js` resuelve el botón
 * contra otro, así que la espera nunca se desbloquea. Y con dos `bridge.lock`
 * distintos, el candado de instancia única deja de valer: ambas copias se creen
 * la primera y Telegram devuelve 409 Conflict a las dos.
 *
 * La invariante correcta no es «un bridge por carpeta» sino «un bridge por
 * máquina y por token», así que estos ficheros pasan a vivir en un directorio
 * de usuario, no junto al código.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

// ==============================================================================
// BE-053 — Rol del daemon
// ==============================================================================

export const ROLES = Object.freeze(['solo', 'nodo', 'servidor']);
// FEAT-089 — Los tres disponibles: `servidor` acepta nodos.
export const ROLES_DISPONIBLES = ROLES;

/**
 * `BRIDGE_ROL` del entorno. Vacío o ausente es `solo`, que es lo de siempre.
 *
 * @returns {{ rol: string|null, error: string|null }}
 */
export function leerRol(env = process.env) {
  const crudo = String(env.BRIDGE_ROL ?? '').trim().toLowerCase();
  if (!crudo) return { rol: 'solo', error: null };
  if (!ROLES.includes(crudo)) {
    return { rol: null, error: `BRIDGE_ROL=${crudo} no es un rol válido (valores: ${ROLES_DISPONIBLES.join(', ')})` };
  }
  return { rol: crudo, error: null };
}

/**
 * Ruta del directorio de datos, SIN tocar el disco. Precedencia:
 *   1. `TELEGRAM_BRIDGE_DATA_DIR` (explícito).
 *   2. `%LOCALAPPDATA%\antigravity-telegram-bridge` en Windows.
 *   3. `$XDG_STATE_HOME/antigravity-telegram-bridge` o
 *      `~/.local/state/antigravity-telegram-bridge` en el resto.
 *
 * Separada de `resolveBridgeDataDir` porque hay un caso que solo necesita LEER:
 * la busqueda del `.env`, que ocurre en el cuerpo del modulo. Crear directorios
 * ahi convertiria un `import` en una escritura en disco.
 */
export function bridgeDataDirPath() {
  const explicito = (process.env.TELEGRAM_BRIDGE_DATA_DIR || '').trim();
  if (explicito) return path.resolve(explicito);

  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'antigravity-telegram-bridge');
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'antigravity-telegram-bridge');
}

/**
 * BE-052 — ¿Corre este proceso dentro de WSL?
 *
 * Con WSL en red mirrored, Windows y WSL comparten el loopback, así que lo que
 * escucha en un puerto de uno choca con el otro. El kernel de WSL se delata en
 * `/proc/version` (`...microsoft-standard-WSL2...`). FEAT-089 la reusa para el
 * nombre por defecto del nodo.
 *
 * `plataforma` y `leer` son inyectables para los tests.
 */
export function esWsl({
  plataforma = process.platform,
  leer = () => fs.readFileSync('/proc/version', 'utf8')
} = {}) {
  if (plataforma !== 'linux') return false;
  try {
    return /microsoft/i.test(leer());
  } catch {
    return false;
  }
}

/**
 * ¿Hay un bot vivo atendiendo este directorio de datos?
 *
 * Los botones de un `telegram_ask` solo los recibe el daemon (el único que
 * consume `getUpdates`). Sin él, la pregunta sale igual —el envío es HTTPS
 * directo— y el usuario toca un botón que se queda girando para siempre. Esto
 * es lo que permite negarse ANTES de mandarla.
 *
 * Mismo criterio que `acquireLock` de bot.js, con dos matices:
 *   - `EPERM` en `process.kill(pid, 0)` significa que el proceso EXISTE pero es
 *     de otro usuario o está elevado: cuenta como vivo.
 *   - `bootId` tiene resolución de minuto y sale de `Date.now()` menos
 *     `os.uptime()`, que no avanzan igual: dos cálculos del mismo arranque
 *     pueden diferir en uno. Se tolera ±1; exigir igualdad rechazaría un bot
 *     vivo.
 *
 * Pura salvo por la lectura del lock; `ahora`, `uptime` y `killFn` son
 * inyectables para los tests.
 *
 * BE-053 — `rol` sale del lock; uno sin `rol` es de antes y se lee `solo`.
 *
 * @returns {{ vivo: boolean, motivo: 'vivo'|'sin-lock'|'pid-muerto'|'otro-arranque'|'lock-ilegible', pid: number|null, startedAt: string|null, rol: string|null }}
 */
export function estadoDaemon({
  dataDir = bridgeDataDirPath(),
  ahora = Date.now(),
  uptime = os.uptime(),
  killFn = (pid, senal) => process.kill(pid, senal)
} = {}) {
  const sinDatos = { pid: null, startedAt: null, rol: null };
  let raw;
  try {
    raw = fs.readFileSync(path.join(dataDir, 'bridge.lock'), 'utf8').trim();
  } catch (err) {
    return { vivo: false, motivo: err.code === 'ENOENT' ? 'sin-lock' : 'lock-ilegible', ...sinDatos };
  }

  // Formato actual (JSON) o legado (solo el PID), como `readLockFrom` de bot.js.
  let lock = null;
  try {
    if (raw.startsWith('{')) {
      const p = JSON.parse(raw);
      if (Number.isInteger(p.pid)) lock = { pid: p.pid, startedAt: p.startedAt ?? null, bootId: p.bootId ?? null, rol: p.rol || 'solo' };
    } else {
      const pid = parseInt(raw, 10);
      if (Number.isInteger(pid)) lock = { pid, startedAt: null, bootId: null, rol: 'solo' };
    }
  } catch {}
  if (!lock) return { vivo: false, motivo: 'lock-ilegible', ...sinDatos };

  const datos = { pid: lock.pid, startedAt: lock.startedAt, rol: lock.rol };
  try {
    killFn(lock.pid, 0);
  } catch (err) {
    if (err?.code !== 'EPERM') return { vivo: false, motivo: 'pid-muerto', ...datos };
  }

  if (lock.bootId !== null) {
    const bootActual = Math.floor((ahora - uptime * 1000) / 60000);
    if (!(Math.abs(Number(lock.bootId) - bootActual) <= 1)) {
      return { vivo: false, motivo: 'otro-arranque', ...datos };
    }
  }
  return { vivo: true, motivo: 'vivo', ...datos };
}

/**
 * Como `bridgeDataDirPath`, pero garantizando que el directorio existe.
 *
 * Si no se puede crear —permisos, disco lleno— se cae al directorio indicado
 * por `fallbackDir`, que es el comportamiento anterior: peor tener el estado
 * partido que no tener bridge.
 */
export function resolveBridgeDataDir(fallbackDir = null) {
  const dir = bridgeDataDirPath();
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    if (fallbackDir) {
      console.error(`[paths] No se pudo usar ${dir} (${err.message}). Se cae a ${fallbackDir}.`);
      return fallbackDir;
    }
    throw err;
  }
}

// ==============================================================================
// Carga de credenciales (.env)
// ==============================================================================

/**
 * Rutas donde se busca el `.env`, en orden de precedencia.
 *
 * El motivo del ultimo candidato: `claude plugin update` instala cada version
 * en su PROPIO directorio (`cache/<market>/<plugin>/<version>/`) y no arrastra
 * los ficheros que no estan en git. Un `.env` colocado junto al plugin
 * desaparece en cada actualizacion, y el sintoma no es un error de arranque
 * sino una herramienta que un dia responde «No hay usuarios configurados»: las
 * credenciales estaban dentro de un directorio versionado.
 *
 * Es la misma correccion que se hizo con `state.json` y `bridge.lock`: lo que
 * dura mas que una version no puede vivir junto al codigo.
 *
 * El orden preserva exactamente el comportamiento anterior —primero el `.env`
 * del bridge, luego el de la raiz del plugin— y solo AÑADE el duradero al
 * final, para que ninguna instalacion existente cambie de fichero.
 */
export function bridgeEnvCandidates(moduleDir) {
  const explicito = (process.env.TELEGRAM_BRIDGE_ENV_FILE || '').trim();
  const candidatos = [];
  if (explicito) candidatos.push(path.resolve(explicito));
  candidatos.push(path.join(moduleDir, '.env'));
  candidatos.push(path.join(moduleDir, '..', '.env'));
  candidatos.push(path.join(bridgeDataDirPath(), '.env'));
  return candidatos;
}

/**
 * Carga el primer `.env` que exista. Solo lee; nunca crea nada.
 *
 * Deliberadamente NO copia el `.env` a la ubicacion duradera por su cuenta.
 * El proyecto sostiene que ningun canal de instalacion debe mover credenciales
 * sin que el usuario lo pida, y un fichero de secretos duplicandose solo por
 * arrancar el proceso seria justo eso. Lo que si hace es decir donde ha mirado
 * cuando no encuentra nada, que es lo que faltaba para diagnosticarlo.
 *
 * @returns {{ loaded: string|null, searched: string[] }}
 */
export function loadBridgeEnv(moduleDir) {
  const searched = bridgeEnvCandidates(moduleDir);
  if (typeof process.loadEnvFile !== 'function') return { loaded: null, searched };

  for (const file of searched) {
    if (!fs.existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      return { loaded: file, searched };
    } catch (err) {
      console.error(`[paths] No se pudo leer ${file}: ${err.message}. Se prueba el siguiente.`);
    }
  }

  return { loaded: null, searched };
}

/**
 * Mensaje de diagnostico para cuando faltan credenciales. Enumerar donde se ha
 * buscado convierte un «no hay usuarios configurados» en algo accionable.
 */
export function describeEnvSearch(searched) {
  const duradero = path.join(bridgeDataDirPath(), '.env');
  return [
    'No se encontró ningún .env. Se buscó, en este orden:',
    ...searched.map((f, i) => `  ${i + 1}. ${f}`),
    '',
    `Para que las credenciales sobrevivan a "claude plugin update", colócalas en:`,
    `  ${duradero}`,
    '(cada versión del plugin se instala en su propio directorio, así que un .env',
    ' junto al código desaparece en la siguiente actualización).'
  ].join('\n');
}

/**
 * BE-053 — Lo que los instaladores necesitan saber del `.env` que usaría el
 * bot: cuál gana, cuáles pierden, el rol y si están las dos credenciales de
 * `solo`. Lo consultan `daemon.sh` y `daemon.ps1` (`node paths.js
 * --informe-env`) para no rearmar la lista de candidatos por su cuenta: la de
 * `daemon.ps1` no miraba el directorio de datos duradero y rechazaba un `.env`
 * que el bot sí cargaba (BE-054).
 *
 * Como `process.loadEnvFile`, una variable ya presente en el entorno gana a la
 * del archivo. No expone ningún valor, solo si está.
 *
 * @returns {{ usa: string|null, ignora: string[], rol: string|null, errorRol: string|null, token: boolean, usuarios: boolean, duradero: string }}
 */
export function informeEnv(moduleDir, { env = process.env, leer = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const existen = bridgeEnvCandidates(moduleDir).filter((f) => fs.existsSync(f));
  let delArchivo = {};
  if (existen[0]) {
    try { delArchivo = parseEnv(leer(existen[0])); } catch {}
  }
  const efectivo = { ...delArchivo, ...env };
  const { rol, error } = leerRol(efectivo);
  const presente = (clave) => String(efectivo[clave] ?? '').trim() !== '';
  return {
    usa: existen[0] || null,
    ignora: existen.slice(1),
    rol,
    errorRol: error,
    token: presente('TELEGRAM_BOT_TOKEN'),
    usuarios: presente('ALLOWED_USER_IDS'),
    duradero: path.join(bridgeDataDirPath(), '.env')
  };
}

/** `informeEnv` en líneas `CLAVE<TAB>valor`, fáciles de leer desde bash y PowerShell. */
export function informeEnvEnLineas(informe) {
  const lineas = [];
  if (informe.usa) lineas.push(`USA\t${informe.usa}`);
  else lineas.push('NINGUNO\t-');
  for (const f of informe.ignora) lineas.push(`IGNORA\t${f}`);
  if (informe.errorRol) lineas.push(`ERROR\t${informe.errorRol}`);
  else lineas.push(`ROL\t${informe.rol}`);
  lineas.push(`TOKEN\t${informe.token ? 1 : 0}`);
  lineas.push(`USUARIOS\t${informe.usuarios ? 1 : 0}`);
  lineas.push(`DURADERO\t${informe.duradero}`);
  return lineas.join('\n');
}

/**
 * Devuelve la ruta canónica de un fichero de datos, migrando una sola vez el
 * que hubiera junto al código.
 *
 * La migración es deliberadamente conservadora: solo mueve si el destino NO
 * existe. Si ya hay estado canónico, el fichero antiguo se deja intacto en su
 * sitio en lugar de fusionarlo o pisarlo — dos `state.json` con historiales
 * distintos no se pueden reconciliar automáticamente sin arriesgar perder
 * conversaciones, y el usuario puede inspeccionar el sobrante.
 *
 * @param {string} nombre nombre del fichero (`state.json`, `bridge.lock`)
 * @param {string} legacyDir carpeta del módulo llamante, donde vivía antes
 */
export function resolveDataFile(nombre, legacyDir) {
  const dataDir = resolveBridgeDataDir(legacyDir);
  const destino = path.join(dataDir, nombre);

  if (dataDir === legacyDir) return destino;

  const legacy = path.join(legacyDir, nombre);
  if (fs.existsSync(legacy) && !fs.existsSync(destino)) {
    try {
      fs.renameSync(legacy, destino);
      // stderr, no stdout: `notify.js --ask-json` resuelve state.json por aquí,
      // y su stdout es un JSON que el servidor MCP parsea.
      console.error(`[paths] ${nombre} migrado de ${legacyDir} a ${dataDir}.`);
    } catch (err) {
      // `rename` entre volúmenes distintos falla con EXDEV; copiar y borrar sí
      // funciona. Si tampoco se puede, se sigue con el destino vacío: es estado
      // recuperable, no vale tumbar el bridge por ello.
      try {
        fs.copyFileSync(legacy, destino);
        fs.unlinkSync(legacy);
        console.error(`[paths] ${nombre} copiado de ${legacyDir} a ${dataDir}.`);
      } catch (err2) {
        console.error(`[paths] No se pudo migrar ${legacy}: ${err2.message}. Se parte de cero en ${destino}.`);
      }
    }
  }

  return destino;
}

/**
 * Rutas heredadas del mismo fichero, para los casos en que hay que seguir
 * mirando la ubicación antigua aunque ya no se escriba en ella. El lockfile lo
 * necesita: durante el despliegue puede haber un bot de la versión anterior
 * todavía vivo sujetando el lock antiguo, y arrancar ignorándolo daría dos
 * `getUpdates` concurrentes y 409 Conflict — justo lo que el lock evita.
 */
export function legacyDataFile(nombre, legacyDir) {
  return path.join(legacyDir, nombre);
}

// `node paths.js --informe-env [dir]`: la consulta de los instaladores. Importado
// no hace nada.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--informe-env') {
  const dir = process.argv[3] ? path.resolve(process.argv[3]) : path.dirname(fileURLToPath(import.meta.url));
  process.stdout.write(`${informeEnvEnLineas(informeEnv(dir))}\n`);
}
