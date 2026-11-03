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
// ==============================================================================
// Rama feat/bot-comandos-lectura: /diff, /logs y hardening del ask.
// ==============================================================================

const lectura = await import('../lectura.js');
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

// Test 52 [FEAT-028]: /diff solo muestra archivos del workspace, nunca los de
// deny_paths, y git no interpreta la magia de pathspec. Contra un repo real:
// las invariantes que importan son de git.
{
  const { repo, g } = repoDeLectura();
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'config'));
  fs.mkdirSync(path.join(repo, 'viejo'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'uno\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=1\n');
  fs.writeFileSync(path.join(repo, 'config', '.env'), 'SECRETO=2\n');
  fs.writeFileSync(path.join(repo, 'borrado.js'), 'x\n');
  fs.writeFileSync(path.join(repo, 'viejo', 'v1.js'), '1\n');
  fs.writeFileSync(path.join(repo, 'viejo', 'v2.js'), '2\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'inicial');
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'uno\ndos\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=cambiado\n');
  fs.writeFileSync(path.join(repo, 'config', '.env'), 'SECRETO=cambiado\n');
  fs.unlinkSync(path.join(repo, 'borrado.js'));
  fs.rmSync(path.join(repo, 'viejo'), { recursive: true, force: true });
  fs.writeFileSync(path.join(repo, 'nuevo.js'), 'hola\n');

  const r = (arg, opts) => lectura.resolverRutaEnWorkspace(arg, repo, opts);
  const malos = ['', '.', './', '../x', 'src/../../x', ':(literal).env', ':(glob)**', ':/', 'a.txt:stream', '-x',
    path.join(os.tmpdir(), 'x'), 'config', 'viejo', 'no-existe.js'];
  for (const malo of malos) {
    assert.strictEqual(r(malo).ok, false, `rechaza ${JSON.stringify(malo)}`);
  }
  assert(r('src/a.js').ok && r('./src/a.js').ok, 'acepta rutas relativas dentro del repo');
  const borrado = r('borrado.js');
  assert(borrado.ok && borrado.existe === false, 'acepta un archivo versionado que se borró');
  const fsSymlink = { ...fs, lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => false }) };
  assert.strictEqual(r('src/a.js', { fsImpl: fsSymlink }).ok, false, 'rechaza un symlink');

  const espiaGit = [];
  const espia = (...args) => { espiaGit.push(args); return ''; };
  for (const bloqueado of ['.env', 'config/.env', '.ENV', 'k/server.key']) {
    const res = lectura.diffDeArchivo({ cwd: repo, abs: path.join(repo, bloqueado), rel: bloqueado, execFileSyncFn: espia, denyPatterns: DENY_POR_DEFECTO });
    assert(res.aviso && res.aviso.includes('deny_paths'), `bloquea ${bloqueado}`);
  }
  assert.strictEqual(espiaGit.length, 0, 'deny_paths corta antes de cualquier llamada a git');

  const registro = [];
  const gitRegistrado = (cmd, args, opts) => { registro.push(args); return execFileSyncReal(cmd, args, opts); };
  const modificado = lectura.diffDeArchivo({ ...r('src/a.js'), cwd: repo, execFileSyncFn: gitRegistrado, denyPatterns: DENY_POR_DEFECTO });
  assert(modificado.lenguaje === 'diff' && modificado.contenido.includes('+dos'), 'diff del archivo modificado');
  lectura.resumenDeCambios({ cwd: repo, execFileSyncFn: gitRegistrado });
  lectura.resolverRutaEnWorkspace('borrado.js', repo, { execFileSyncFn: gitRegistrado });
  assert(registro.length > 0 && registro.every((a) => a.includes('--literal-pathspecs')), 'toda llamada a git lleva --literal-pathspecs');

  const nuevo = lectura.diffDeArchivo({ ...r('nuevo.js'), cwd: repo, denyPatterns: DENY_POR_DEFECTO });
  assert(nuevo.encabezado.includes('archivo nuevo') && nuevo.contenido.includes('hola'), 'un untracked se muestra como archivo nuevo');
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([1, 0, 2]));
  assert(lectura.diffDeArchivo({ ...r('bin.dat'), cwd: repo, denyPatterns: DENY_POR_DEFECTO }).aviso.includes('binario'), 'un binario nuevo no se vuelca');
  fs.writeFileSync(path.join(repo, 'grande.txt'), 'a'.repeat(1024 * 1024));
  const grande = lectura.diffDeArchivo({ ...r('grande.txt'), cwd: repo, denyPatterns: DENY_POR_DEFECTO });
  assert(grande.contenido.length === lectura.TOPE_LECTURA_BYTES && grande.encabezado.includes('primeros'), 'de un archivo grande lee solo el tope');

  const resumen = lectura.resumenDeCambios({ cwd: repo });
  assert(resumen.contenido.includes('?? nuevo.js') && resumen.contenido.includes('src/a.js'), 'el resumen incluye los untracked');

  g('add', '-A');
  g('commit', '-q', '-m', 'todo');
  const llamadasLimpio = [];
  const gitLimpio = (cmd, args, opts) => { llamadasLimpio.push(args); return execFileSyncReal(cmd, args, opts); };
  assert(lectura.resumenDeCambios({ cwd: repo, execFileSyncFn: gitLimpio }).aviso.includes('Sin cambios'), 'árbol limpio: aviso');
  assert(!llamadasLimpio.some((a) => a.includes('HEAD~1')), 'sin fallback a HEAD~1');
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
console.log('✔ Test 52 [FEAT-028]: /diff valida la ruta, respeta deny_paths y usa pathspecs literales');

// Test 53 [FEAT-028/029]: formato del bloque, cola del log, N de /logs y
// plataforma del daemon.
{
  const bloque = lectura.formatearBloque('a\n```\nb\nc', { lenguaje: 'diff', maxLineas: 2 });
  assert(bloque.startsWith('```diff\n'), 'abre el bloque con su lenguaje');
  assert.strictEqual(bloque.split('```').length - 1, 2, 'el ``` del contenido no cierra el bloque');
  assert(bloque.includes('más omitidas'), 'avisa el recorte');
  assert(lectura.formatearBloque('tok 1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAA').includes('[REDACTED]'), 'redacta tokens');

  const dirLog = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cola-'));
  const archivo = path.join(dirLog, 'daemon.log');
  let contenido = '';
  for (let i = 0; i < 20000; i++) contenido += `linea ${i}\r\n`;
  fs.writeFileSync(archivo, contenido);
  const cinco = lectura.leerColaDeArchivo({ file: archivo, lineas: 5 });
  assert.deepStrictEqual(cinco, ['linea 19995', 'linea 19996', 'linea 19997', 'linea 19998', 'linea 19999'], 'las últimas N, sin \\r');
  const todas = lectura.leerColaDeArchivo({ file: archivo, lineas: 1e9 });
  assert(/^linea \d+$/.test(todas[0]), 'descarta la primera línea partida');
  assert(Buffer.byteLength(todas.join('\n')) <= lectura.TOPE_LECTURA_BYTES, 'nunca lee más que el tope');
  assert.strictEqual(lectura.leerColaDeArchivo({ file: path.join(dirLog, 'no.log') }), null, 'archivo inexistente → null');
  fs.rmSync(dirLog, { recursive: true, force: true });

  assert.deepStrictEqual(lectura.parsearLineasLogs('500'), { lineas: 100, aviso: 'Tope de 100 líneas (pediste 500).' });
  assert.strictEqual(lectura.parsearLineasLogs('abc').lineas, 30);
  assert.strictEqual(lectura.parsearLineasLogs('0').lineas, 30);
  assert.strictEqual(lectura.parsearLineasLogs('5').lineas, 5);
  assert.strictEqual(lectura.parsearLineasLogs(undefined).lineas, 30);

  // Fuera de un repo: `rev-parse` falla. Con un git falso, para no depender de
  // si el temporal del sistema cae dentro de algún repositorio.
  const gitSinRepo = () => { throw new Error('fatal: not a git repository'); };
  assert(lectura.resumenDeCambios({ cwd: os.tmpdir(), execFileSyncFn: gitSinRepo }).aviso.includes('no es un repositorio'), 'fuera de un repo: aviso');

  assert(lectura.logsDelDaemon({ platform: 'darwin' }).aviso.includes('Sin daemon'), 'macOS: sin daemon');
  let argsJournal = null;
  lectura.logsDelDaemon({ platform: 'linux', lineas: 7, execFileSyncFn: (cmd, args) => { argsJournal = [cmd, ...args]; return 'x\n'; } });
  assert(argsJournal[0] === 'journalctl' && argsJournal.includes('--no-pager') && argsJournal.includes('7'), 'Linux: journalctl con -n');
  assert(lectura.logsDelDaemon({ platform: 'win32', logFile: path.join(os.tmpdir(), 'no-existe-agy.log') }).aviso.includes('daemon.log'), 'Windows sin log: aviso');
}
console.log('✔ Test 53 [FEAT-028/029]: bloque saneado, cola del log acotada y /logs por plataforma');

// Test 54 [FEAT-028/029]: los handlers responden en el acto, sin encolar.
{
  const { repo, g } = repoDeLectura();
  fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=1\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'inicial');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=filtrado\n');

  // Un log propio: nunca el daemon.log real de la máquina que corre la suite.
  const logDePrueba = path.join(repo, 'daemon-de-prueba.log');
  fs.writeFileSync(logDePrueba, 'arranque\r\nmarca-del-test-54\r\n');

  const workspacePrevio = process.env.WORKSPACE_DIR;
  process.env.WORKSPACE_DIR = repo;
  try {
    const { bot, llamadas } = botDePrueba({ logFile: logDePrueba });
    resetRuntimeState();
    await bot.handleUpdate(comandoDe('/diff ../fuera', 600));
    assert(textosEnviados(llamadas).includes('se sale del workspace'), '/diff ../fuera se rechaza');
    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/diff .env', 601));
    const respuesta = textosEnviados(llamadas);
    assert(respuesta.includes('deny_paths') && !respuesta.includes('filtrado'), '/diff .env se bloquea y no filtra contenido');
    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/logs 500', 602));
    const logs = textosEnviados(llamadas);
    assert(logs.includes('Tope de 100'), '/logs 500 avisa el tope');
    if (process.platform === 'win32') {
      assert(logs.includes('marca-del-test-54'), '/logs lee el log inyectado, no el real');
    }
    assert.strictEqual(queue.getQueueLength(), 0, 'ninguno pasa por la cola');
    resetRuntimeState();
  } finally {
    if (workspacePrevio === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = workspacePrevio;
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
console.log('✔ Test 54 [FEAT-028/029]: /diff y /logs responden sin encolar y sin filtrar deny_paths');

// Test 55 [FEAT-035 hardening]: solo el chat al que se mandó el ask puede
// responderlo. El callback_data lo puede fabricar cualquier cliente.
{
  const USUARIO_OK_2 = '555000222';
  const { bot, llamadas } = botDePrueba({ allowedUserIds: new Set([USUARIO_OK, USUARIO_OK_2]) });
  resetRuntimeState();
  const callbackDe = (data, userId, updateId) => ({
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: Number(userId), is_bot: false, first_name: 'Test' },
      chat_instance: 'ci',
      data,
      message: { message_id: 1, date: 0, chat: { id: Number(userId), type: 'private' }, text: 'pregunta' }
    }
  });

  state.registerPendingAsk('ask_ajeno', { question: 'q', options: ['a', 'b'], chatId: USUARIO_OK, messageId: 1 });
  await bot.handleUpdate(callbackDe('ask:ask_ajeno:0', USUARIO_OK_2, 700));
  const rechazos = llamadas.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text);
  assert(rechazos.some((t) => t.includes('no pertenece')), 'otro chat recibe el rechazo');
  assert.strictEqual(state.getPendingAsk('ask_ajeno').status, 'pending', 'y el ask sigue abierto');

  await bot.handleUpdate(callbackDe('ask:ask_ajeno:1', USUARIO_OK, 701));
  assert.strictEqual(state.getPendingAsk('ask_ajeno').status, 'answered', 'el chat dueño lo resuelve');

  state.registerPendingAsk('ask_sin_chat', { question: 'q', options: ['a'], chatId: null, messageId: 2 });
  await bot.handleUpdate(callbackDe('ask:ask_sin_chat:0', USUARIO_OK, 702));
  assert.strictEqual(state.getPendingAsk('ask_sin_chat').status, 'pending', 'un ask sin chatId no se resuelve');
  resetRuntimeState();
}
console.log('✔ Test 55 [FEAT-035]: un ask solo se responde desde su propio chat');

// Test 56 [FEAT-035 hardening]: el askId es aleatorio y conserva su forma.
{
  const notify = await import('../notify.js');
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = notify.nuevoAskId();
    assert(/^ask_[0-9a-f]{16}$/.test(id), `forma del askId: ${id}`);
    ids.add(id);
  }
  assert.strictEqual(ids.size, 1000, 'no se repiten');
  assert(`ask:${notify.nuevoAskId()}:9`.length < 64, 'cabe en callback_data');
}
console.log('✔ Test 56 [FEAT-035]: askId aleatorio, con forma estable y dentro de callback_data');

// Test 57 [fix/telegram-ask]: estadoDaemon decide si hay un bot que pueda
// atender los botones de un ask. Mismo criterio que acquireLock, con EPERM
// como vivo y ±1 minuto de tolerancia en bootId.
{
  const paths = await import('../paths.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-daemon-'));
  const lock = path.join(dir, 'bridge.lock');
  const ahora = Date.now();
  const uptime = os.uptime();
  const bootActual = Math.floor((ahora - uptime * 1000) / 60000);
  const estado = (extra = {}) => paths.estadoDaemon({ dataDir: dir, ahora, uptime, ...extra });
  const errorCon = (code) => () => { const e = new Error(code); e.code = code; throw e; };

  assert.strictEqual(estado().motivo, 'sin-lock', 'sin lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 'desde-test', bootId: String(bootActual) }));
  const vivo = estado();
  assert(vivo.vivo && vivo.pid === process.pid && vivo.startedAt === 'desde-test', 'lock propio del arranque actual → vivo, con pid y startedAt');
  for (const delta of [-1, 1]) {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, bootId: String(bootActual + delta) }));
    assert(estado().vivo, `bootId desfasado ${delta} se tolera`);
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, bootId: String(bootActual + 2) }));
  assert.strictEqual(estado().motivo, 'otro-arranque', 'bootId de otro arranque');
  fs.writeFileSync(lock, JSON.stringify({ pid: 424242, bootId: String(bootActual) }));
  assert.strictEqual(estado({ killFn: errorCon('ESRCH') }).motivo, 'pid-muerto', 'ESRCH: no hay proceso');
  assert(estado({ killFn: errorCon('EPERM') }).vivo, 'EPERM: el proceso existe aunque no sea nuestro');
  fs.writeFileSync(lock, String(process.pid));
  assert(estado().vivo, 'lock legado (solo el PID)');
  fs.writeFileSync(lock, '{roto');
  assert.strictEqual(estado().motivo, 'lock-ilegible', 'lock corrupto');
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('✔ Test 57 [fix/telegram-ask]: estadoDaemon reconoce un bot vivo, uno muerto y uno de otro arranque');

// Test 58 [fix/telegram-ask]: sin daemon, askTelegramQuestion se niega ANTES de
// tocar la red. La pregunta habría llegado con botones que nadie atiende.
{
  const notify = await import('../notify.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sin-daemon-'));
  const dirPrevio = process.env.TELEGRAM_BRIDGE_DATA_DIR;
  const fetchPrevio = globalThis.fetch;
  let llamadasRed = 0;
  process.env.TELEGRAM_BRIDGE_DATA_DIR = dir;
  globalThis.fetch = async () => { llamadasRed++; throw new Error('no debería salir a la red'); };
  try {
    await assert.rejects(() => notify.askTelegramQuestion({ question: '¿Sigo?' }), /no está corriendo \(sin-lock\)/);
    assert.strictEqual(llamadasRed, 0, 'no se mandó nada a Telegram');
  } finally {
    globalThis.fetch = fetchPrevio;
    if (dirPrevio === undefined) delete process.env.TELEGRAM_BRIDGE_DATA_DIR;
    else process.env.TELEGRAM_BRIDGE_DATA_DIR = dirPrevio;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log('✔ Test 58 [fix/telegram-ask]: sin daemon, el ask falla rápido y sin tocar la red');

