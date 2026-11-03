/**
 * BE-176 — Arnés común de la suite del bridge.
 *
 * El estado de test vive en un fichero temporal: nunca se toca el `state.json`
 * real del usuario. Debe fijarse ANTES de importar `state.js`, de ahí que
 * `test-bridge.js` llame a `crearEntorno()` antes de sus imports dinámicos.
 *
 * `copiarFixture()` reemplaza la lista manual del Test 35: copia todos los
 * módulos de la raíz del bridge, `mcp-server/lib` completo y los árboles que
 * `bot.js` necesita. Un archivo nuevo bajo esas carpetas ya no exige editar una
 * lista; si falta uno del manifiesto, el error lo nombra.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FAKE_TOKEN = '1234567890:AAFakeTokenForTestingOnly_DoNotUse';
// BE-051 — El id del bot de prueba es el de su token, como en producción
// (`ctx.me.id` sale del mismo token). `tg(chat)` arma la referencia de chat de
// Telegram que piden las funciones de `state.js`.
export const BOT_ID_PRUEBA = '1234567890';
export const tg = (chat) => ({ bot: BOT_ID_PRUEBA, chat });

const BRIDGE_DIR = path.resolve(import.meta.dirname, '..');
const REPO_DIR = path.resolve(BRIDGE_DIR, '..');
const TEMPORALES = [];

process.once('exit', () => {
  for (const dir of TEMPORALES) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** BE-084 — Un temporal más que se borra al salir, también si un test tira. */
export function registrarTemporal(dir) {
  TEMPORALES.push(dir);
}

/**
 * Fija el estado y el `.env` de prueba. No crea `state.json`: `state.js` debe
 * seguir viendo el archivo ausente.
 */
export function crearEntorno() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-test-'));
  const stateFile = path.join(dataDir, 'state.json');
  process.env.TELEGRAM_BRIDGE_STATE_FILE = stateFile;

  // BE-044 — Los tests apuntan USERPROFILE a un home falso con su `.claude.json`;
  // con CLAUDE_CONFIG_DIR heredada, el launcher leería el de la cuenta real.
  delete process.env.CLAUDE_CONFIG_DIR;

  // El primer `notify.js` o `bot.js` que se importe carga el primer `.env` que
  // encuentre, y en una máquina con el bridge instalado es el real: sus bots
  // extra (`TELEGRAM_BOTS`, FEAT-091) desviaban las copias al bot de un alma, y
  // su `ALLOWED_USER_IDS` era el dueño que algunos tests daban por hecho.
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-env-'));
  const envFile = path.join(envDir, '.env');
  fs.writeFileSync(envFile, 'ALLOWED_USER_IDS=555000111\n');
  process.env.TELEGRAM_BRIDGE_ENV_FILE = envFile;

  registrarTemporal(dataDir);
  registrarTemporal(envDir);
  return { dataDir, stateFile, envFile };
}

function copiarArchivo(origen, destino) {
  if (!fs.existsSync(origen)) throw new Error(`Falta ${origen} para el fixture (BE-176)`);
  fs.copyFileSync(origen, destino);
}

function copiarDir(origen, destino) {
  if (!fs.existsSync(origen)) throw new Error(`Falta ${origen} para el fixture (BE-176)`);
  fs.cpSync(origen, destino, { recursive: true });
}

/**
 * Copia al temporal el árbol mínimo real que `bot.js` necesita para importarse.
 * Devuelve las rutas del código copiado y del directorio de datos.
 */
export function copiarFixture(destino) {
  const codigo = path.join(destino, 'telegram-bridge');
  const datos = path.join(destino, 'datos');
  fs.mkdirSync(codigo, { recursive: true });
  fs.mkdirSync(path.join(destino, 'mcp-server'), { recursive: true });

  // Todos los módulos de la raíz del bridge, salvo la propia suite. Un archivo
  // nuevo se copia solo; no hay lista que mantener.
  for (const f of fs.readdirSync(BRIDGE_DIR)) {
    if (!f.endsWith('.js') || f === 'test-bridge.js') continue;
    fs.copyFileSync(path.join(BRIDGE_DIR, f), path.join(codigo, f));
  }
  // FEAT-052: bot.js importa el canal de la consola web.
  copiarDir(path.join(BRIDGE_DIR, 'web'), path.join(codigo, 'web'));
  // FEAT-092: y el endpoint local de los mensajes entre sesiones.
  copiarDir(path.join(BRIDGE_DIR, 'red'), path.join(codigo, 'red'));

  // FEAT-022: bot.js importa `../mcp-server/agents/` (el cast compartido).
  // FEAT-043: y los módulos de las almas.
  // FEAT-071: charla, consolidación y cast arman el argv con el motor.
  // FEAT-061 fase 4: la consola comparte el servicio confinado completo.
  // BE-015/SEC-027/FEAT-069/FEAT-092/BE-123/FEAT-172: todo `mcp-server/lib`
  // completo, para que un módulo nuevo no exija tocar esta lista.
  for (const d of ['agents', 'almas', 'motores', 'lotes', 'lib']) {
    copiarDir(path.join(REPO_DIR, 'mcp-server', d), path.join(destino, 'mcp-server', d));
  }

  // FEAT-034: executor.js carga el lector del stream de mcp-server/.
  // FEAT-064: bot.js lista los worktrees sin integrar para el barrido.
  for (const f of ['agy-stream.js', 'fanout-tail.js', 'prompt-offload.js', 'fanout-estado.js', 'fanout.js', 'reparto.js', 'adversarial-review.js', 'worktrees.js']) {
    copiarArchivo(path.join(REPO_DIR, 'mcp-server', f), path.join(destino, 'mcp-server', f));
  }

  fs.symlinkSync(path.join(BRIDGE_DIR, 'node_modules'), path.join(codigo, 'node_modules'), 'junction');
  return { codigo, datos };
}
