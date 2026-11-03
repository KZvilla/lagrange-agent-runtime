import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertModuloValido, codigoCliente } from './helpers.js';
import { crearEntorno, FAKE_TOKEN, BOT_ID_PRUEBA, tg, registrarTemporal } from './harness.js';

const { stateFile: TEST_STATE_FILE } = crearEntorno();
const { resolveAgyBin, getAgyStatus, loadPolicy, resolveWorkspace, resolveExtraDirs } = await import('../executor.js');
const { formatElapsed } = await import('../formatter.js');
const state = await import('../state.js');
const queue = await import('../queue.js');
const claudeLauncher = await import('../claude-launcher.js');

process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
const {
  createBot, resetRuntimeState, avisoDeDespacho, buildWorkspacesKeyboard,
  buildStopMessageAndKeyboard, armarPromptDeReaccion, ALLOWED_UPDATES, iniciarPolling
} = await import('../bot.js');

const testChatId = 999999999;

const USUARIO_OK = '555000111';
const USUARIO_AJENO = '999888777';

/**
 * Construye un bot cuyas llamadas a la API se capturan en lugar de salir a la
 * red. Un transformer que no llama a `prev` corta la petición en seco.
 */
function botDePrueba({ allowedUserIds = new Set([USUARIO_OK]), logFile, ahora } = {}) {
  const bot = createBot({ token: FAKE_TOKEN, allowedUserIds, logFile, ahora });
  const llamadas = [];
  bot.api.config.use(async (prev, method, payload) => {
    llamadas.push({ method, payload });
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: llamadas.length, date: 0, chat: { id: 1 }, text: payload.text } };
    }
    return { ok: true, result: true };
  });
  bot.botInfo = {
    id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'test', username: 'test_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business_account: false, has_main_web_app: false
  };
  return { bot, llamadas };
}

function updateDeTexto({ userId, chatId = userId, chatType = 'private', text = 'hola', updateId = 1 }) {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: chatType, title: chatType === 'private' ? undefined : 'Grupo' },
      from: { id: Number(userId), is_bot: false, first_name: 'Test' },
      text
    }
  };
}
const { execFileSync: execFileSyncReal } = await import('node:child_process');
const DENY_POR_DEFECTO = ['.env*', '**/*.key', '**/*.pem'];

/** Repo git real en un temporal, con identidad propia: sin ella `commit` falla en CI. */
function repoDeLectura() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lectura-')));
  const g = (...args) => execFileSyncReal('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSyncReal('git', ['init', '-q', repo], { stdio: 'ignore' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  return { repo, g };
}

function comandoDe(text, updateId, userId = USUARIO_OK) {
  const cmd = text.split(/\s/)[0];
  return {
    update_id: updateId,
    message: {
      message_id: 1000 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(userId), type: 'private' },
      from: { id: Number(userId), is_bot: false, first_name: 'Test' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: cmd.length }]
    }
  };
}

const textosEnviados = (llamadas) => llamadas.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text).join('\n');
const httpMod = await import('node:http');
function pedirWeb(puerto, { metodo = 'GET', ruta = '/', headers = {}, cuerpo } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpMod.request({ host: '127.0.0.1', port: puerto, method: metodo, path: ruta, headers }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { texto += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto, json: () => JSON.parse(texto) }));
    });
    req.on('error', reject);
    if (cuerpo !== undefined) req.write(cuerpo);
    req.end();
  });
}

/** Abre un SSE y resuelve cuando el texto acumulado cumple `cond`. */
function esperarSse(puerto, headers, cond, { ruta = '/api/eventos', ms = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let texto = '';
    const req = httpMod.request({ host: '127.0.0.1', port: puerto, path: ruta, headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        texto += d;
        if (cond(texto)) { clearTimeout(t); req.destroy(); resolve({ status: res.statusCode, headers: res.headers, texto }); }
      });
    });
    const t = setTimeout(() => { req.destroy(); reject(new Error(`SSE sin lo esperado. Llegó: ${texto}`)); }, ms);
    req.on('error', (err) => { if (!req.destroyed) reject(err); });
    req.end();
  });
}
const updateDeReaccion = ({
  userId = USUARIO_OK,
  chatId = userId,
  chatType = 'private',
  messageId,
  oldReaction = [],
  newReaction = [],
  updateId
}) => ({
  update_id: updateId,
  message_reaction: {
    chat: { id: Number(chatId), type: chatType, title: chatType === 'private' ? undefined : 'Grupo' },
    message_id: messageId,
    user: { id: Number(userId), is_bot: false, first_name: 'Test' },
    date: Math.floor(Date.now() / 1000),
    old_reaction: oldReaction,
    new_reaction: newReaction
  }
});

const emoji = (valor) => ({ type: 'emoji', emoji: valor });
// Test 1: Resolución de binario agy
const bin = resolveAgyBin();
console.log('✔ Test 1: resolveAgyBin() ->', bin);
assert(bin && bin.length > 0, 'El binario de agy no debe ser nulo');

// Test 2: Estado de agy
const status = getAgyStatus();
console.log('✔ Test 2: getAgyStatus() ->', status.version);
assert(status.binPath, 'Debe retornar binPath');
assert(Array.isArray(status.denyCommands), 'Debe tener denyCommands');

// Test 3 se extrajo a `test/formatter.test.js` (BE-176, segunda rebanada).

// Tests 4, 5, 6, 7 y 8 se extrajeron a `test/estado-cola.test.js` (BE-176, cuarta rebanada).

// Test 9: la política se carga de .claude/antigravity.json con la misma
// precedencia que el servidor MCP, y el entorno la sobreescribe.
const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-policy-'));
fs.mkdirSync(path.join(policyDir, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(policyDir, '.claude', 'antigravity.json'),
  JSON.stringify({ permissions: { deny_commands: ['docker *'], sandbox: true } }),
  'utf8'
);

const basePolicy = loadPolicy(policyDir);
assert.deepStrictEqual(basePolicy.denyCommands, ['docker *'], 'deny_commands sale del fichero de política');
assert.strictEqual(basePolicy.sandbox, true, 'sandbox sale del fichero de política');
assert(basePolicy.denyPaths.includes('.env*'), 'Las claves ausentes conservan el valor por defecto');
assert.strictEqual(
  basePolicy.configFile,
  path.join(policyDir, '.claude', 'antigravity.json'),
  'Debe reportar de dónde salió la política'
);

process.env.AGY_SANDBOX = 'false';
assert.strictEqual(loadPolicy(policyDir).sandbox, false, 'AGY_SANDBOX debe ganar sobre el fichero');
delete process.env.AGY_SANDBOX;
fs.rmSync(policyDir, { recursive: true, force: true });

// El sandbox va INACTIVO por defecto: medido, no limita rutas (la herramienta
// de escritura sale del workspace igual) y convierte cada comando de terminal
// en un UAC de elevación. Activarlo por defecto no añadiría frontera.
const dirSinPolitica = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-nopol-'));
assert.strictEqual(
  loadPolicy(dirSinPolitica).sandbox,
  false,
  'Sin fichero de política ni AGY_SANDBOX, el sandbox va inactivo'
);
fs.rmSync(dirSinPolitica, { recursive: true, force: true });
console.log('✔ Test 9: loadPolicy() respeta fichero y entorno');

// Test 10: getAgyStatus distingue lo que se aplica de lo que solo se sugiere.
// Es lo que impide que /status vuelva a prometer una protección inexistente.
assert.strictEqual(status.enforcement.denyCommands, 'prompt', 'deny_commands solo se sugiere al modelo');
assert.strictEqual(status.enforcement.denyPaths, 'prompt', 'deny_paths solo se sugiere al modelo');
assert.strictEqual(typeof status.enforcement.sandbox, 'boolean', 'sandbox es un control real, booleano');
assert.strictEqual(status.enforcement.skipPermissions, true, 'el bridge siempre auto-aprueba herramientas');
console.log('✔ Test 10: getAgyStatus() declara qué se aplica y qué solo se sugiere');

// Tests 11, 12 y 13 se extrajeron a `test/estado-cola.test.js` (BE-176, cuarta rebanada).
// Tests 14, 15, 18 y 19 se extrajeron a `test/formatter.test.js` (BE-176, segunda rebanada).

// Test 16 se extrajo a `test/estado-cola.test.js` (BE-176, cuarta rebanada).
// Test 17: el workspace es una fuente única de verdad y no depende del cwd.
// El banner de bot.js resolvía la raíz del repo y el executor usaba
// process.cwd(), que con `npm --prefix telegram-bridge start` es otra carpeta:
// el bot decía un directorio y agy trabajaba en otro.
const wsPrevio = process.env.WORKSPACE_DIR;
const dirsPrevio = process.env.AGY_ADD_DIRS;
const dirA = os.tmpdir();
const dirB = path.dirname(TEST_STATE_FILE);

process.env.WORKSPACE_DIR = dirA;
assert.strictEqual(resolveWorkspace(), path.resolve(dirA), 'WORKSPACE_DIR manda sobre el cwd');

delete process.env.WORKSPACE_DIR;
assert.strictEqual(resolveWorkspace(), path.resolve(process.cwd()), 'Sin WORKSPACE_DIR cae al cwd');

process.env.AGY_ADD_DIRS = `  ${dirA} , , ${dirB}  `;
assert.deepStrictEqual(
  resolveExtraDirs(),
  [path.resolve(dirA), path.resolve(dirB)],
  'AGY_ADD_DIRS se limpia, se resuelve y descarta los vacíos'
);

delete process.env.AGY_ADD_DIRS;
assert.deepStrictEqual(resolveExtraDirs(), [], 'Sin AGY_ADD_DIRS no hay extras');

if (wsPrevio !== undefined) process.env.WORKSPACE_DIR = wsPrevio;
if (dirsPrevio !== undefined) process.env.AGY_ADD_DIRS = dirsPrevio;
console.log('✔ Test 17: resolveWorkspace() y resolveExtraDirs()');
