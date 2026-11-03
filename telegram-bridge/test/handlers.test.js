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
// ==============================================================================
// Tests de handlers sobre un bot real, con la API interceptada.
// ==============================================================================

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

// Test 30 [SEC-001]: la whitelist autoriza a una PERSONA, no a un CANAL. Si el
// bot entra en un grupo donde participa un usuario autorizado, sus respuestas
// —código, diffs, rutas locales, /status— quedan a la vista de todo el grupo.
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();

  for (const tipo of ['group', 'supergroup', 'channel']) {
    await bot.handleUpdate(updateDeTexto({ userId: USUARIO_OK, chatId: -100123, chatType: tipo, text: '/status', updateId: 1 }));
  }
  assert.strictEqual(llamadas.length, 0, 'Un usuario autorizado en grupo/canal no obtiene respuesta alguna');

  await bot.handleUpdate(updateDeTexto({ userId: USUARIO_AJENO, text: '/status', updateId: 2 }));
  assert.strictEqual(llamadas.length, 0, 'Un usuario fuera de la whitelist tampoco');

  await bot.handleUpdate(updateDeTexto({ userId: USUARIO_OK, text: '/reset', updateId: 3 }));
  assert(llamadas.length > 0, 'El mismo usuario en su chat privado sí es atendido');
  assert.strictEqual(llamadas[0].method, 'sendMessage', 'Y la respuesta es un mensaje');
  resetRuntimeState();
}
console.log('✔ Test 30 [SEC-001]: solo se atienden chats privados de usuarios en whitelist');

// Test 31 [FEAT-001]: audio, fotos y documentos entrantes reciben respuesta.
// Sin handler, enviar una nota de voz no producía nada: ni respuesta ni error,
// indistinguible desde el móvil de un bridge caído.
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();

  const base = (extra, updateId) => ({
    update_id: updateId,
    message: {
      message_id: 200 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(USUARIO_OK), type: 'private' },
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      ...extra
    }
  });

  await bot.handleUpdate(base({ voice: { file_id: 'v1', file_unique_id: 'v1u', duration: 3 } }, 10));
  assert.strictEqual(llamadas.length, 1, 'Una nota de voz recibe respuesta');
  assert(llamadas[0].payload.text.includes('audio'), 'La respuesta explica que el audio no se procesa');

  // FEAT-065: las fotos y los documentos ya no caen acá (tienen su propio
  // camino, Test 113). Lo que sigue sin soporte es el video y el sticker.
  await bot.handleUpdate(base({ video: { file_id: 'vd1', file_unique_id: 'vd1u', width: 1, height: 1, duration: 1 } }, 11));
  assert.strictEqual(llamadas.length, 2, 'Un video recibe respuesta');
  assert(llamadas[1].payload.text.includes('imágenes y texto plano'), 'La respuesta dice qué sí se acepta');

  await bot.handleUpdate(base({ sticker: { file_id: 's1', file_unique_id: 's1u', width: 1, height: 1, type: 'regular', is_animated: false, is_video: false } }, 12));
  assert.strictEqual(llamadas.length, 3, 'Un sticker recibe respuesta');
  resetRuntimeState();
}
console.log('✔ Test 31 [FEAT-001]: los mensajes no soportados reciben feedback explícito');

// Test 32 [SEC-003]: `callback_data` lo puede fabricar un cliente. Un
// exec_plan con un id que no tiene forma de identificador no debe llegar a
// `agy --conversation`.
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();

  const callback = (data, updateId) => ({
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 300 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'bot' },
        text: 'plan'
      }
    }
  });

  await bot.handleUpdate(callback('exec_plan:../../etc/passwd', 20));
  const respuestas = llamadas.filter((c) => c.method === 'answerCallbackQuery');
  assert.strictEqual(respuestas.length, 1, 'Se responde al callback');
  assert(respuestas[0].payload.text.includes('inválido'), 'Se rechaza por identificador inválido');
  assert.strictEqual(llamadas.filter((c) => c.method === 'sendMessage').length, 0, 'No se despacha ninguna tarea');
  resetRuntimeState();
}
console.log('✔ Test 32 [SEC-003]: exec_plan valida la forma del identificador de conversación');


// Tests 33 y 34 se extrajeron a `test/rutas-entorno.test.js` (BE-176, tercera rebanada).

// Test 35 [BE-007] se extrajo a `test/importacion.test.js` (BE-176): el arnés
// común arma el fixture y la lista de módulos dejó de ser manual.

// Tests 36, 37, 38, 39 y 40 se extrajeron a `test/rutas-entorno.test.js` (BE-176, tercera rebanada).
// Test 41 [FEAT-003 / BE-009]: Persistencia y liveliness check de claudeSession
{
  // 1. Estado inicial limpio
  state.clearActiveClaudeSession();
  assert.strictEqual(state.getActiveClaudeSession(), null, 'Inicialmente no debe haber sesión activa');

  // 2. Registrar sesión con el PID del proceso actual (proceso vivo conocido)
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-test-'));
  const testSession = {
    pid: process.pid,
    projectPath: dirTmp,
    sessionName: 'Mobile-test-project'
  };
  const registered = state.setActiveClaudeSession(testSession);
  assert.strictEqual(registered.pid, process.pid, 'Debe registrar el PID indicado');
  assert.strictEqual(registered.projectPath, dirTmp, 'Debe registrar el projectPath');
  assert.strictEqual(registered.sessionName, 'Mobile-test-project', 'Debe registrar el sessionName');
  assert(typeof registered.startedAt === 'string' && registered.startedAt.length > 0, 'Debe incluir timestamp startedAt');

  // 3. getActiveClaudeSession debe retornar la sesión viva
  const active = state.getActiveClaudeSession();
  assert(active !== null, 'Debe retornar la sesión activa viva');
  assert.strictEqual(active.pid, process.pid, 'El PID debe coincidir');
  assert.strictEqual(active.projectPath, dirTmp, 'El projectPath debe coincidir');
  assert.strictEqual(active.sessionName, 'Mobile-test-project', 'El sessionName debe coincidir');
  assert.strictEqual(active.startedAt, registered.startedAt, 'startedAt debe coincidir');

  // 4. Comprobar persistencia física en state.json
  const rawState = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
  assert(rawState.claudeSession, 'state.json debe contener la clave claudeSession');
  assert.strictEqual(rawState.claudeSession.pid, process.pid, 'El PID debe estar persistido en disco');

  // 5. Comprobar que un PID muerto es purgado automáticamente al consultar
  const FAKE_DEAD_PID = 99999999;
  state.setActiveClaudeSession({
    pid: FAKE_DEAD_PID,
    projectPath: dirTmp,
    sessionName: 'Mobile-dead-session'
  });
  const deadActive = state.getActiveClaudeSession();
  assert.strictEqual(deadActive, null, 'Un PID inexistente debe retornar null');
  assert.strictEqual(state.loadState().claudeSession, null, 'El estado debe haberse limpiado automáticamente');

  // 6. Comprobar clearActiveClaudeSession explícito
  state.setActiveClaudeSession(testSession);
  assert(state.getActiveClaudeSession() !== null, 'La sesión debe estar activa antes de limpiar');
  state.clearActiveClaudeSession();
  assert.strictEqual(state.getActiveClaudeSession(), null, 'clearActiveClaudeSession debe eliminar la sesión');
  assert.strictEqual(state.loadState().claudeSession, null, 'El estado en caché/disco debe ser null');

  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 41 [FEAT-003 / BE-009]: Persistencia y liveliness check de claudeSession validados');

// Test 42 [FEAT-003 / SEC-005]: launchClaudeRemoteSession inicia sesión desacoplada sin secretos en entorno
{
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-test-'));
  state.clearActiveClaudeSession();

  // FEAT-169 — Una sola cuenta: el nombre por defecto sigue siendo Mobile-<carpeta>.
  const cuentasUna = [{ account: 'principal', configDir: null, claudeHome: path.join(dirTmp, '.claude'), claudeJsonPath: path.join(dirTmp, '.claude.json'), label: 'principal' }];

  // 1. Validar fallo si el directorio de trabajo no existe
  const noExistePath = path.join(os.tmpdir(), 'no-existe-para-launch-test-xyz');
  const resInexistente = claudeLauncher.launchClaudeRemoteSession({ workspacePath: noExistePath });
  assert.strictEqual(resInexistente.success, false, 'Debe fallar si workspacePath no existe');
  assert(resInexistente.error.includes('no existe'), 'Error debe indicar que la ruta no existe');

  // 1.b Validar rechazo por Project Allowlist si la ruta no está autorizada
  const resNoAllowlist = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmp,
    skipAllowlistCheck: false
  });
  assert.strictEqual(resNoAllowlist.success, false, 'Debe fallar si no pertenece a la Project Allowlist');
  assert(resNoAllowlist.error.includes('Project Allowlist'), 'Debe reportar violación de Project Allowlist');

  // 2. Simular spawnFn para capturar invocación exacta y registrar listeners
  const spawnCalls = [];
  let unrefCalled = false;
  let errorHandler = null;
  const mockChild = {
    pid: process.pid, // Usamos process.pid para que getActiveClaudeSession lo considere vivo
    unref: () => { unrefCalled = true; },
    on: (event, fn) => {
      if (event === 'error') errorHandler = fn;
    }
  };
  const mockSpawn = (bin, args, opts) => {
    spawnCalls.push({ bin, args, opts });
    return mockChild;
  };

  // Asegurar que existe un secreto en process.env para verificar saneamiento
  process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;

  // 3. Invocación con sessionName por defecto (Mobile-<basename>)
  const resOk = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmp,
    spawnFn: mockSpawn,
    skipAllowlistCheck: true,
    accounts: cuentasUna,
    findExistingFn: () => null
  });

  assert.strictEqual(resOk.success, true, 'El lanzamiento debe ser exitoso');
  assert.strictEqual(resOk.pid, process.pid, 'Debe retornar el PID del proceso');
  assert.strictEqual(resOk.projectPath, dirTmp, 'Debe retornar el projectPath');
  assert.strictEqual(resOk.spawnMode, 'same-dir', 'Debe usar same-dir por defecto');
  const expectedDefaultName = `Mobile-${path.basename(dirTmp)}`;
  assert.strictEqual(resOk.sessionName, expectedDefaultName, 'Debe formatear Mobile-<basename> por defecto');
  assert.strictEqual(unrefCalled, true, 'child.unref() debe haber sido llamado');

  // Verificar llamada a spawnFn (subcomando headless remote-control con flag --spawn)
  assert.strictEqual(spawnCalls.length, 1, 'Debe haber llamado a spawnFn una vez');
  const call = spawnCalls[0];
  assert.strictEqual(call.bin, claudeLauncher.resolveClaudeBin(), 'Debe usar el binario resuelto de Claude');
  assert.deepStrictEqual(
    call.args,
    ['remote-control', '--name', expectedDefaultName, '--spawn=same-dir'],
    'Argumentos deben ser [remote-control, --name, sessionName, --spawn=same-dir]'
  );
  assert.strictEqual(call.opts.cwd, dirTmp, 'cwd debe ser workspacePath');
  assert(
    call.opts.stdio === 'ignore' || (Array.isArray(call.opts.stdio) && call.opts.stdio[0] === 'ignore'),
    'stdio debe ser ignore o descriptor desacoplado [ignore, fd, fd]'
  );

  // Invariante de seguridad [SEC-005]: el entorno pasado NO debe contener secretos de Telegram
  assert.strictEqual(call.opts.env.TELEGRAM_BOT_TOKEN, undefined, 'TELEGRAM_BOT_TOKEN no debe heredarse');
  assert.strictEqual(call.opts.env.TELEGRAM_NOTIFY_CHAT_ID, undefined, 'TELEGRAM_NOTIFY_CHAT_ID no debe heredarse');
  assert.strictEqual(call.opts.env.ALLOWED_USER_IDS, undefined, 'ALLOWED_USER_IDS no debe heredarse');

  // Verificar que la sesión quedó registrada en state
  const activeSession = state.getActiveClaudeSession();
  assert(activeSession !== null, 'La sesión debe estar registrada en state');
  assert.strictEqual(activeSession.sessionName, expectedDefaultName);

  // 4. FEAT-169 — Otro proyecto convive con la primera sesión, hasta el tope.
  const dirTmpOtro = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-other-'));
  const mockChildOtro = { pid: process.ppid, unref: () => {}, on: () => {} };
  const resOtro = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmpOtro,
    spawnFn: (bin, args, opts) => { spawnCalls.push({ bin, args, opts }); return mockChildOtro; },
    skipAllowlistCheck: true,
    accounts: cuentasUna,
    maxSessions: 2,
    findExistingFn: () => null
  });
  assert.strictEqual(resOtro.success, true, 'Una segunda sesión en otro proyecto debe convivir con la primera');
  assert.strictEqual(state.getActiveClaudeSessions().length, 2, 'Deben quedar dos sesiones activas');
  const dirTmpTercero = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-third-'));
  const resTope = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmpTercero,
    spawnFn: mockSpawn,
    skipAllowlistCheck: true,
    accounts: cuentasUna,
    maxSessions: 2,
    findExistingFn: () => null
  });
  assert.strictEqual(resTope.success, false, 'No debe pasar del tope de sesiones');
  assert.strictEqual(resTope.limitReached, true, 'Debe avisar que se alcanzó el tope');
  assert.strictEqual(resTope.activeSessions.length, 2, 'Debe devolver las sesiones activas');
  assert.strictEqual(spawnCalls.length, 2, 'El tope no debe llamar a spawnFn');
  state.clearActiveClaudeSession(resOtro.key);
  spawnCalls.pop();
  fs.rmSync(dirTmpOtro, { recursive: true, force: true });
  fs.rmSync(dirTmpTercero, { recursive: true, force: true });

  // 5. Invocación con sessionName y spawnMode personalizados
  state.clearActiveClaudeSession();
  const resCustom = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmp,
    sessionName: 'MiSesionPersonalizada',
    spawnMode: 'worktree',
    spawnFn: mockSpawn,
    skipAllowlistCheck: true,
    accounts: cuentasUna,
    findExistingFn: () => null
  });
  assert.strictEqual(resCustom.success, true);
  assert.strictEqual(resCustom.sessionName, 'MiSesionPersonalizada');
  assert.strictEqual(resCustom.spawnMode, 'worktree');
  assert.deepStrictEqual(spawnCalls[1].args, ['remote-control', '--name', 'MiSesionPersonalizada', '--spawn=worktree']);

  // 6. Validar F-01: child.on('error') limpia la sesión activa si el proceso falla asíncronamente
  assert(typeof errorHandler === 'function', 'Debe haber registrado listener para child.on("error")');
  errorHandler(new Error('Simulated spawn ENOENT'));
  assert.strictEqual(state.getActiveClaudeSession(), null, 'El error en proceso hijo debe limpiar activeSession');

  // 7. Validar F-02: binario terminado en .cmd en Windows se envuelve en cmd.exe /d /s /c
  if (process.platform === 'win32') {
    const cmdCalls = [];
    const mockSpawnCmd = (bin, args, opts) => {
      cmdCalls.push({ bin, args, opts });
      return mockChild;
    };
    claudeLauncher.launchClaudeRemoteSession({
      workspacePath: dirTmp,
      claudeBin: 'C:\\fake\\npm\\claude.cmd',
      spawnFn: mockSpawnCmd,
      skipAllowlistCheck: true,
      accounts: cuentasUna,
      findExistingFn: () => null
    });
    assert.strictEqual(cmdCalls.length, 1);
    assert(cmdCalls[0].bin.toLowerCase().endsWith('cmd.exe'), 'Debe usar cmd.exe como binario de spawn');
    assert.strictEqual(cmdCalls[0].args[0], '/d');
    assert.strictEqual(cmdCalls[0].args[1], '/s');
    assert.strictEqual(cmdCalls[0].args[2], '/c');
    assert.strictEqual(cmdCalls[0].args[3], 'C:\\fake\\npm\\claude.cmd');
    assert.strictEqual(cmdCalls[0].args[4], 'remote-control');
  }

  // Limpieza
  state.clearActiveClaudeSession();
  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 42 [FEAT-003 / SEC-005 / BE-008]: launchClaudeRemoteSession desacoplado, sin secretos, headless y con guardas F-01/F-02');

// Test 43 [FEAT-003 / BE-009]: stopClaudeRemoteSession termina el árbol de procesos y limpia el estado
{
  state.clearActiveClaudeSession();

  // 1. Validar error si no hay sesión activa
  const resNoSession = claudeLauncher.stopClaudeRemoteSession();
  assert.strictEqual(resNoSession.success, false, 'Debe fallar si no hay sesión activa');
  assert.strictEqual(
    resNoSession.error,
    'No hay ninguna sesión activa de Claude para detener.',
    'Debe retornar mensaje exacto de sesión inexistente'
  );

  // 2. Registrar sesión activa simulada con process.pid
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stop-test-'));
  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: dirTmp,
    sessionName: 'Mobile-to-stop'
  });
  assert(state.getActiveClaudeSession() !== null, 'Debe haber sesión activa antes de detener');

  // 3. Simular execFileFn para Windows
  const execCalls = [];
  const mockExecFile = (file, args, cb) => {
    execCalls.push({ file, args });
    if (typeof cb === 'function') cb(null, '', '');
  };

  // 4. Detener sesión en Windows
  const resStopWin = claudeLauncher.stopClaudeRemoteSession({
    execFileFn: mockExecFile,
    platform: 'win32'
  });

  assert.strictEqual(resStopWin.success, true, 'stopClaudeRemoteSession debe ser exitoso');
  assert.strictEqual(resStopWin.pid, process.pid, 'Debe retornar el pid detenido');
  assert.strictEqual(resStopWin.sessionName, 'Mobile-to-stop', 'Debe retornar el sessionName');

  assert.strictEqual(execCalls.length, 1, 'Debe haber invocado taskkill una vez');
  assert.strictEqual(execCalls[0].file, 'taskkill', 'El comando debe ser taskkill');
  assert.deepStrictEqual(
    execCalls[0].args,
    ['/pid', String(process.pid), '/T', '/F'],
    'Debe invocar taskkill con /pid <PID> /T /F'
  );

  // Verificar que el estado se limpió
  assert.strictEqual(state.getActiveClaudeSession(), null, 'El estado debe quedar limpio tras detener');

  // 5. Probar rama POSIX (señales SIGTERM y SIGKILL)
  const posixSignals = [];
  const mockKill = (targetPid, signal) => {
    posixSignals.push({ targetPid, signal });
  };

  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: dirTmp,
    sessionName: 'Mobile-posix-test'
  });

  const resStopPosix = claudeLauncher.stopClaudeRemoteSession({
    platform: 'linux',
    killFn: mockKill
  });

  assert.strictEqual(resStopPosix.success, true, 'stopClaudeRemoteSession en POSIX debe ser exitoso');
  assert.strictEqual(resStopPosix.pid, process.pid);
  assert.strictEqual(resStopPosix.sessionName, 'Mobile-posix-test');
  assert(posixSignals.some((s) => s.signal === 'SIGTERM'), 'Debe enviar SIGTERM');
  assert(posixSignals.some((s) => s.signal === 'SIGKILL'), 'Debe enviar SIGKILL');
  assert.strictEqual(state.getActiveClaudeSession(), null, 'El estado debe quedar limpio en POSIX');

  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 43 [FEAT-003 / BE-009]: stopClaudeRemoteSession termina el árbol de procesos y limpia el estado');

// Test 44 [FEAT-001 / BE-008]: buildWorkspacesKeyboard genera teclado interactivo con callback_data compacto
{
  const mockWorkspaces = [
    { id: 'a1b2c3d4', path: 'C:\\vs work\\app1\\frontend', name: 'frontend', displayName: 'frontend (app1)' },
    { id: 'e5f60718', path: 'C:\\vs work\\app2\\frontend', name: 'frontend', displayName: 'frontend (app2)' },
    { id: '293a4b5c', path: 'C:\\vs work\\landing', name: 'landing', displayName: 'landing' }
  ];

  const keyboard = buildWorkspacesKeyboard(mockWorkspaces);
  const inline = keyboard.inline_keyboard;

  // 3 filas para los proyectos + 1 fila para el botón Cancelar = 4 filas
  assert.strictEqual(inline.length, 4, 'Debe haber 4 filas en el teclado');
  assert.strictEqual(inline[0][0].text, '📁 frontend (app1)');
  assert.strictEqual(inline[0][0].callback_data, 'rc_start:a1b2c3d4');
  assert.strictEqual(inline[1][0].text, '📁 frontend (app2)');
  assert.strictEqual(inline[1][0].callback_data, 'rc_start:e5f60718');
  assert.strictEqual(inline[2][0].text, '📁 landing');
  assert.strictEqual(inline[2][0].callback_data, 'rc_start:293a4b5c');
  assert.strictEqual(inline[3][0].text, '❌ Cancelar');
  assert.strictEqual(inline[3][0].callback_data, 'rc_cancel');

  // Verificar que NINGÚN callback_data exceda el límite de 64 bytes de Telegram
  for (const fila of inline) {
    for (const btn of fila) {
      const bytes = Buffer.byteLength(btn.callback_data, 'utf8');
      assert(bytes <= 64, `callback_data "${btn.callback_data}" excede 64 bytes (${bytes} bytes)`);
    }
  }
}
console.log('✔ Test 44 [FEAT-001 / BE-008]: buildWorkspacesKeyboard genera teclado con callback_data compacto');

// Test 45 [FEAT-001 / FEAT-002]: Comando /claude responde con estado o lista de workspaces
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();
  state.clearActiveClaudeSession();

  const updateCmd = (cmd, args = '', updateId = 100) => {
    const text = args ? `/${cmd} ${args}` : `/${cmd}`;
    return {
      update_id: updateId,
      message: {
        message_id: 100 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: cmd.length + 1 }]
      }
    };
  };

  // 1. /claude status cuando no hay sesión
  await bot.handleUpdate(updateCmd('claude', 'status', 100));
  assert(llamadas.length > 0, 'Debe haber respondido a /claude status');
  assert(llamadas[0].payload.text.includes('No hay ninguna sesión activa'), 'Avisa que no hay sesión');

  // 2. /claude stop cuando no hay sesión
  llamadas.length = 0;
  await bot.handleUpdate(updateCmd('claude', 'stop', 101));
  assert(llamadas.length > 0, 'Debe haber respondido a /claude stop');
  assert(llamadas[0].payload.text.includes('No hay ninguna sesión activa'), 'Reporta que no hay sesión');

  // 3. /claude cuando hay sesión activa inyectada
  llamadas.length = 0;
  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: 'C:\\fake\\project',
    sessionName: 'Mobile-test'
  });

  await bot.handleUpdate(updateCmd('claude', '', 102));
  assert(llamadas[0].payload.text.includes('Sesiones de Claude Code activas: 1'), 'Detecta sesión activa (FEAT-169: lista de sesiones)');
  assert(llamadas[0].payload.text.includes('Mobile-test'), 'Muestra nombre de sesión');
  assert(llamadas[0].payload.reply_markup, 'Ofrece botones para detener o cambiar');

  // 4. Limpiamos sesión activa
  state.clearActiveClaudeSession();
  resetRuntimeState();
}
console.log('✔ Test 45 [FEAT-001 / FEAT-002]: Comando /claude responde con estado y gestión de sesión');

// Test 45b [FEAT-169]: `/claude <proyecto> [cuenta]`, `rc_start` y `rc_acct` con dos cuentas
{
  const botMod = await import('../bot.js');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feat169-bot-'));
  const homeFalso = path.join(raiz, 'home');
  const cfgTrabajo = path.join(raiz, 'trabajo');
  const repo = path.join(raiz, 'repos', 'compartido');
  const soloPrincipal = path.join(raiz, 'repos', 'solo-principal');
  for (const d of [path.join(homeFalso, '.claude'), cfgTrabajo, repo, soloPrincipal]) fs.mkdirSync(d, { recursive: true });
  const repoReal = fs.realpathSync.native(repo);
  const soloReal = fs.realpathSync.native(soloPrincipal);
  fs.writeFileSync(path.join(homeFalso, '.claude', 'antigravity.json'), JSON.stringify({ motores: { cuentas: { trabajo: { configDir: cfgTrabajo } } } }));
  fs.writeFileSync(path.join(homeFalso, '.claude.json'), JSON.stringify({ projects: { [repoReal]: { hasTrustDialogAccepted: true }, [soloReal]: { hasTrustDialogAccepted: true } } }));
  fs.writeFileSync(path.join(cfgTrabajo, '.claude.json'), JSON.stringify({ projects: { [repoReal]: { hasTrustDialogAccepted: true } } }));
  const previo = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = homeFalso;
  process.env.HOME = homeFalso;

  const lanzados = [];
  botMod.usarLanzadorClaudeParaTests((opciones) => {
    lanzados.push(opciones);
    return { success: true, key: `${opciones.account || 'principal'}:abcdef12`, account: opciones.account || 'principal', pid: process.pid, sessionName: 'Mobile-x', projectPath: opciones.workspacePath, spawnMode: 'same-dir', logFile: null };
  });
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();
  try {
    const id = claudeLauncher.getKnownWorkspaces().find((w) => w.path.toLowerCase() === repoReal.toLowerCase())?.id;
    assert(id, 'El repo compartido está en la lista');

    const comando = (args, updateId) => ({
      update_id: updateId,
      message: {
        message_id: 100 + updateId, date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' }, from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
        text: `/claude ${args}`, entities: [{ type: 'bot_command', offset: 0, length: 7 }]
      }
    });
    const callback = (data, updateId) => ({
      update_id: updateId,
      callback_query: {
        id: String(updateId), from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' }, chat_instance: 'ci', data,
        message: { message_id: 500 + updateId, date: Math.floor(Date.now() / 1000), chat: { id: Number(USUARIO_OK), type: 'private' }, from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'bot' }, text: 'prompt' }
      }
    });

    await bot.handleUpdate(comando('compartido', 900));
    const pregunta = llamadas.find((c) => c.method === 'sendMessage' && c.payload.text.includes('¿Con qué cuenta'));
    assert(pregunta, '/claude <proyecto> confiable en dos cuentas, sin por defecto, pregunta la cuenta');
    const datosBotones = pregunta.payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert(datosBotones.includes(`rc_acct:${id}:principal`) && datosBotones.includes(`rc_acct:${id}:trabajo`), 'Ofrece las dos cuentas');
    assert.strictEqual(lanzados.length, 0, 'Preguntar no lanza');

    llamadas.length = 0;
    await bot.handleUpdate(comando('compartido trabajo', 901));
    assert.strictEqual(lanzados.at(-1)?.account, 'trabajo', '/claude <proyecto> <cuenta> lanza con esa cuenta');
    // F4 — Sin la config, el launcher no veía `sesiones_claude` (carpetas agregadas, cuenta fija y por defecto, tope).
    assert(lanzados.at(-1)?.config && typeof lanzados.at(-1).config === 'object', 'Y le pasa la config de Lagrange al launcher');
    assert(llamadas.some((c) => c.method === 'sendMessage' && c.payload.text.includes('iniciada con éxito')), 'Y responde que arrancó');

    llamadas.length = 0;
    await bot.handleUpdate(callback(`rc_start:${id}`, 902));
    assert(llamadas.some((c) => (c.method === 'editMessageText' || c.method === 'sendMessage') && String(c.payload.text).includes('¿Con qué cuenta')), 'rc_start con dos cuentas confiables pregunta');
    assert.strictEqual(lanzados.length, 1, 'rc_start no lanza sin cuenta');

    await bot.handleUpdate(callback(`rc_acct:${id}:trabajo`, 903));
    assert.strictEqual(lanzados.length, 2, 'rc_acct lanza');
    assert.strictEqual(lanzados.at(-1).account, 'trabajo', 'Con la cuenta del botón');

    const idSolo = claudeLauncher.getKnownWorkspaces().find((w) => w.path.toLowerCase() === soloReal.toLowerCase()).id;
    llamadas.length = 0;
    await bot.handleUpdate(callback(`rc_acct:${idSolo}:trabajo`, 904));
    assert.strictEqual(lanzados.length, 2, 'rc_acct con una cuenta no confiable no lanza');
    assert(llamadas.some((c) => c.method === 'answerCallbackQuery' && c.payload.text.includes('no es confiable')), 'Y lo dice');
    await bot.handleUpdate(callback(`rc_acct:${id}:fantasma`, 905));
    assert.strictEqual(lanzados.length, 2, 'rc_acct con una cuenta desconocida no lanza');
    await bot.handleUpdate(callback('rc_acct:zz:trabajo', 906));
    assert.strictEqual(lanzados.length, 2, 'rc_acct malformado no lanza');

    llamadas.length = 0;
    await bot.handleUpdate(callback(`rc_start:${idSolo}`, 907));
    assert.strictEqual(lanzados.length, 3, 'rc_start de un proyecto con una sola cuenta confiable lanza directo');
    assert.strictEqual(lanzados.at(-1).account, null, 'Y deja que el launcher resuelva la cuenta');
  } finally {
    botMod.usarLanzadorClaudeParaTests(null);
    state.clearActiveClaudeSession();
    resetRuntimeState();
    process.env.USERPROFILE = previo.USERPROFILE;
    process.env.HOME = previo.HOME;
    if (previo.HOME === undefined) delete process.env.HOME;
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 45b [FEAT-169]: /claude <proyecto> [cuenta], rc_start y rc_acct con dos cuentas');

// Test 46 [FEAT-001 / BE-008]: Callbacks interactivos rc_cancel y rc_stop
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();

  const callback = (data, updateId) => ({
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 500 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'bot' },
        text: 'prompt'
      }
    }
  });

  // Callback rc_cancel
  await bot.handleUpdate(callback('rc_cancel', 200));
  const ansCancel = llamadas.find((c) => c.method === 'answerCallbackQuery' && c.payload.text === 'Operación cancelada');
  assert(ansCancel, 'rc_cancel responde con acuse');

  // Callback rc_start con id inexistente
  llamadas.length = 0;
  await bot.handleUpdate(callback('rc_start:9999', 201));
  const ansInvalido = llamadas.find((c) => c.method === 'answerCallbackQuery' && c.payload.text.includes('no encontrado'));
  assert(ansInvalido, 'rc_start con ID inválido responde que no fue encontrado');

  // Callback rc_stop cuando no hay sesión activa
  llamadas.length = 0;
  state.clearActiveClaudeSession();
  await bot.handleUpdate(callback('rc_stop', 202));
  const ansStopNoSession = llamadas.find((c) => c.method === 'answerCallbackQuery' && c.payload.text.includes('Deteniendo'));
  assert(ansStopNoSession, 'rc_stop responde con acuse');
  const msgNoSession = llamadas.find((c) => c.method === 'sendMessage' && c.payload.text.includes('No hay ninguna sesión activa'));
  assert(msgNoSession, 'rc_stop informa que no hay sesión activa');

  resetRuntimeState();
}
console.log('✔ Test 46 [FEAT-001 / BE-008]: Callbacks interactivos rc_cancel, rc_stop y validación de IDs en rc_start');

// Test 47 [FEAT-001 / BE-008]: Cambio de proyecto (F-03) detiene la sesión activa previa y lanza la nueva
{
  state.clearActiveClaudeSession();
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-switch-test-'));

  // Simular sesión activa previa
  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: 'C:\\fake\\old-proj',
    sessionName: 'Mobile-old'
  });
  assert(state.getActiveClaudeSession() !== null, 'Debe haber sesión activa previa');

  // Mock para execFileSyncFn y spawnFn
  let killCalledWith = null;
  const mockKill = (bin, args) => {
    killCalledWith = { bin, args };
  };

  let mockSpawnCalled = false;
  const mockSpawn = () => {
    mockSpawnCalled = true;
    return { pid: process.pid, unref: () => {}, on: () => {} };
  };

  const resSwitch = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmp,
    replaceActive: true,
    spawnFn: mockSpawn,
    skipAllowlistCheck: true,
    findExistingFn: () => null,
    stopOptions: { execFileSyncFn: mockKill, platform: 'win32' }
  });

  assert.strictEqual(resSwitch.success, true, 'El reemplazo de sesión debe ser exitoso');
  assert(killCalledWith !== null, 'Debe haber llamado a taskkill mockeado');
  assert.strictEqual(killCalledWith.args[1], String(process.pid));
  assert.strictEqual(mockSpawnCalled, true, 'Debe haber invocado spawnFn para la nueva sesión');
  const active = state.getActiveClaudeSession();
  assert(active !== null, 'Debe haber nueva sesión activa');
  assert.strictEqual(active.projectPath, dirTmp, 'La nueva sesión debe apuntar al nuevo proyecto');

  state.clearActiveClaudeSession();
  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 47 [FEAT-001 / BE-008]: Cambio de proyecto (F-03) reemplaza sesión activa limpiamente');

// Test 48 [SEC-006 / BE-010]: Separación estricta de Allowlists e Idempotencia del spawn (una sesión por proyecto)
{
  state.clearActiveClaudeSession();

  // --- Parte 1: Separación de Allowlists (Project Allowlist) ---
  const dirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-allowlist-test-'));
  const dirProjA = path.join(dirBase, 'proj-allowed');
  const dirProjB = path.join(dirBase, 'proj-forbidden');
  const dirSecret = path.join(dirBase, 'proj-secret');
  fs.mkdirSync(dirProjA, { recursive: true });
  fs.mkdirSync(dirProjB, { recursive: true });
  fs.mkdirSync(dirSecret, { recursive: true });

  const mockClaudeJson = path.join(dirBase, 'claude.json');
  fs.writeFileSync(mockClaudeJson, JSON.stringify({
    projects: {
      [dirProjA]: { remoteControlSpawnMode: 'same-dir' },
      [dirProjB]: { remoteControlSpawnMode: 'worktree' },
      [dirSecret]: { remoteControlSpawnMode: 'same-dir' }
    }
  }, null, 2));

  // 1.1 Con allowedWorkspacesSet restringiendo solo a 'proj-allowed'
  const allowlistOnlyA = claudeLauncher.getProjectAllowlist({
    claudeJsonPath: mockClaudeJson,
    allowedWorkspacesSet: new Set(['proj-allowed']),
    denyPaths: ['*secret*']
  });
  assert.strictEqual(allowlistOnlyA.length, 1, 'Solo debe incluir el proyecto permitido');
  assert.strictEqual(path.resolve(allowlistOnlyA[0].path).toLowerCase(), path.resolve(dirProjA).toLowerCase());

  // 1.2 isWorkspaceAllowed valida membresía
  assert.strictEqual(
    claudeLauncher.isWorkspaceAllowed(dirProjA, {
      claudeJsonPath: mockClaudeJson,
      allowedWorkspacesSet: new Set(['proj-allowed']),
      denyPaths: ['*secret*']
    }),
    true,
    'dirProjA debe ser permitido'
  );

  assert.strictEqual(
    claudeLauncher.isWorkspaceAllowed(dirProjB, {
      claudeJsonPath: mockClaudeJson,
      allowedWorkspacesSet: new Set(['proj-allowed']),
      denyPaths: ['*secret*']
    }),
    false,
    'dirProjB debe ser rechazado por no estar en la allowlist explícita'
  );

  assert.strictEqual(
    claudeLauncher.isWorkspaceAllowed(dirSecret, {
      claudeJsonPath: mockClaudeJson,
      denyPaths: ['*secret*']
    }),
    false,
    'dirSecret debe ser rechazado por coincidir con deny_paths'
  );

  // 1.3 launchClaudeRemoteSession rechaza workspace no permitido sin invocar spawnFn
  let unauthorizedSpawnInvoked = false;
  const resDenied = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirProjB,
    allowlistOptions: {
      claudeJsonPath: mockClaudeJson,
      allowedWorkspacesSet: new Set(['proj-allowed'])
    },
    spawnFn: () => {
      unauthorizedSpawnInvoked = true;
      return { pid: 99999, unref: () => {}, on: () => {} };
    }
  });
  assert.strictEqual(resDenied.success, false, 'Debe fallar ante proyecto no autorizado');
  assert(resDenied.error.includes('Project Allowlist'), 'Debe reportar que no pertenece a la Project Allowlist');
  assert.strictEqual(unauthorizedSpawnInvoked, false, 'No debe invocar spawnFn bajo ninguna circunstancia');

  // 1.4 F-06 / F-07: Comprobar fusión de trust status y rechazo si hasTrustDialogAccepted es false
  const dirUntrusted = path.join(dirBase, 'proj-untrusted');
  fs.mkdirSync(dirUntrusted, { recursive: true });
  const mockClaudeTrustJson = path.join(dirBase, 'claude-trust.json');
  fs.writeFileSync(mockClaudeTrustJson, JSON.stringify({
    projects: {
      [dirUntrusted]: { hasTrustDialogAccepted: false },
      [dirProjA.toLowerCase()]: { hasTrustDialogAccepted: false },
      [dirProjA]: { hasTrustDialogAccepted: true, remoteControlSpawnMode: 'worktree' }
    }
  }, null, 2));

  const allowlistMerged = claudeLauncher.getProjectAllowlist({ claudeJsonPath: mockClaudeTrustJson });
  const mergedA = allowlistMerged.find((w) => w.path.toLowerCase() === dirProjA.toLowerCase());
  assert(mergedA !== undefined, 'dirProjA debe estar en la lista');
  assert.strictEqual(mergedA.hasTrustDialogAccepted, true, 'Debe fusionar a true si alguna entrada aceptó trust');
  assert.strictEqual(mergedA.spawnMode, 'worktree', 'Debe adoptar el spawnMode explícito');

  // 1.4 F-06 / F-07: Comprobar que un workspace untrusted es excluido por defecto de la allowlist
  assert.strictEqual(
    claudeLauncher.isWorkspaceAllowed(dirUntrusted, { claudeJsonPath: mockClaudeTrustJson }),
    false,
    'dirUntrusted debe ser excluido de la Project Allowlist por no tener hasTrustDialogAccepted: true'
  );

  // Guarda en lanzamiento: si se omite el allowlist check, la guarda F-06 lo rechaza explícitamente
  const resUntrusted = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirUntrusted,
    skipAllowlistCheck: true,
    allowlistOptions: { claudeJsonPath: mockClaudeTrustJson, requireTrust: false }
  });
  assert.strictEqual(resUntrusted.success, false);
  assert(resUntrusted.error.includes('Workspace no confiable'), 'Debe reportar workspace no confiable');

  // --- Parte 2: Idempotencia del Spawn (Una sesión por proyecto) ---
  // 2.1 Idempotencia por Bridge State
  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: dirProjA,
    sessionName: 'Mobile-proj-allowed',
    spawnMode: 'same-dir'
  });

  let duplicateSpawnCalled = false;
  const resBridgeIdempotent = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirProjA,
    allowlistOptions: {
      claudeJsonPath: mockClaudeJson
    },
    spawnFn: () => {
      duplicateSpawnCalled = true;
      return { pid: 88888, unref: () => {}, on: () => {} };
    }
  });

  assert.strictEqual(resBridgeIdempotent.success, true, 'Debe responder success ante sesión existente');
  assert.strictEqual(resBridgeIdempotent.alreadyRunning, true, 'Debe indicar alreadyRunning: true');
  assert.strictEqual(resBridgeIdempotent.source, 'bridge', 'Fuente debe ser bridge');
  assert.strictEqual(resBridgeIdempotent.pid, process.pid, 'Debe retornar el PID existente');
  assert.strictEqual(duplicateSpawnCalled, false, 'No debe disparar spawn repetido si ya está vivo en bridge');

  state.clearActiveClaudeSession();

  // 2.2 Idempotencia por Claude Native Pointer (~/.claude/projects/<slug>/bridge-pointer.json)
  const mockClaudeHome = path.join(dirBase, 'claude-home');
  const slugA = path.resolve(dirProjA).replace(/[^a-zA-Z0-9]/g, '-');
  const pointerDir = path.join(mockClaudeHome, 'projects', slugA);
  fs.mkdirSync(pointerDir, { recursive: true });
  fs.writeFileSync(path.join(pointerDir, 'bridge-pointer.json'), JSON.stringify({
    sessionId: 'session-xyz-123',
    environmentId: 'env_native_456',
    pid: process.pid,
    source: 'standalone'
  }));

  let pointerSpawnCalled = false;
  const resPointerIdempotent = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirProjA,
    allowlistOptions: {
      claudeJsonPath: mockClaudeJson
    },
    findExistingFn: (targetPath) => claudeLauncher.findExistingClaudeSession(targetPath, { claudeHome: mockClaudeHome }),
    spawnFn: () => {
      pointerSpawnCalled = true;
      return { pid: 77777, unref: () => {}, on: () => {} };
    }
  });

  assert.strictEqual(resPointerIdempotent.success, true);
  assert.strictEqual(resPointerIdempotent.alreadyRunning, true);
  assert.strictEqual(resPointerIdempotent.source, 'claude-pointer');
  assert.strictEqual(resPointerIdempotent.environmentId, 'env_native_456');
  assert.strictEqual(pointerSpawnCalled, false, 'No debe disparar spawn si existe bridge-pointer.json vivo');
  assert.strictEqual(state.getActiveClaudeSession()?.pid, process.pid, 'Debe sincronizar la sesión viva en state');

  state.clearActiveClaudeSession();

  // 2.3 Idempotencia por tmux pane
  let tmuxSpawnCalled = false;
  const resTmuxIdempotent = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirProjA,
    allowlistOptions: {
      claudeJsonPath: mockClaudeJson
    },
    findExistingFn: () => ({
      pid: process.pid,
      source: 'tmux',
      projectPath: dirProjA
    }),
    spawnFn: () => {
      tmuxSpawnCalled = true;
      return { pid: 66666, unref: () => {}, on: () => {} };
    }
  });

  assert.strictEqual(resTmuxIdempotent.success, true);
  assert.strictEqual(resTmuxIdempotent.alreadyRunning, true);
  assert.strictEqual(resTmuxIdempotent.source, 'tmux');
  assert.strictEqual(tmuxSpawnCalled, false, 'No debe disparar spawn si existe pane en tmux');

  // Limpieza
  state.clearActiveClaudeSession();
  fs.rmSync(dirBase, { recursive: true, force: true });
}
console.log('✔ Test 48 [SEC-006 / BE-010]: Separación estricta de Allowlists e Idempotencia del spawn (una sesión por proyecto)');

// Test 49 [FEAT-004 / BE-011]: Detección y purga segura de worktrees huérfanos de Claude Code (Opción B)
{
  state.clearActiveClaudeSession();

  // --- Parte 1: inspectClaudeWorktrees ---
  // 1.1 Si el proyecto no es válido o no existe
  const resInvalid = claudeLauncher.inspectClaudeWorktrees('C:\\ruta\\inexistente\\12345');
  assert.deepStrictEqual(resInvalid, { cleanWorktrees: [], dirtyWorktrees: [] });

  // 1.2 Repositorio Git con simulación de execFileSyncFn
  const fakeRepo = path.join(os.tmpdir(), 'fake-repo-worktrees');
  const wtClean = path.join(fakeRepo, '.claude', 'worktrees', 'bridge-clean-123');
  const wtDirtyUncommitted = path.join(fakeRepo, '.claude', 'worktrees', 'bridge-dirty-uncommitted');
  const wtDirtyCommits = path.join(fakeRepo, '.claude', 'worktrees', 'bridge-dirty-commits');
  const wtOther = path.join(fakeRepo, 'other-worktree');

  // Creamos carpetas para simular existencia física en disco
  fs.mkdirSync(wtClean, { recursive: true });
  fs.mkdirSync(wtDirtyUncommitted, { recursive: true });
  fs.mkdirSync(wtDirtyCommits, { recursive: true });
  fs.mkdirSync(wtOther, { recursive: true });

  const mockExec = (bin, args) => {
    // rev-parse --is-inside-work-tree
    if (args.includes('--is-inside-work-tree')) return 'true\n';
    // rev-parse --abbrev-ref HEAD
    if (args.includes('--abbrev-ref')) return 'main\n';

    // worktree list --porcelain
    if (args.includes('list') && args.includes('--porcelain')) {
      return [
        `worktree ${fakeRepo}`,
        `HEAD 1111111111111111111111111111111111111111`,
        `branch refs/heads/main`,
        ``,
        `worktree ${wtClean}`,
        `HEAD 2222222222222222222222222222222222222222`,
        `branch refs/heads/worktree-bridge-clean-123`,
        ``,
        `worktree ${wtDirtyUncommitted}`,
        `HEAD 3333333333333333333333333333333333333333`,
        `branch refs/heads/worktree-bridge-dirty-uncommitted`,
        ``,
        `worktree ${wtDirtyCommits}`,
        `HEAD 4444444444444444444444444444444444444444`,
        `branch refs/heads/worktree-bridge-dirty-commits`,
        ``,
        `worktree ${wtOther}`,
        `HEAD 5555555555555555555555555555555555555555`,
        `branch refs/heads/feature-random`,
        ``
      ].join('\n');
    }

    // status --porcelain
    if (args.includes('status') && args.includes('--porcelain')) {
      const targetCwd = args[args.indexOf('-C') + 1];
      if (targetCwd === wtDirtyUncommitted) {
        return ' M modified-file.txt\n?? untracked.js\n';
      }
      return '';
    }

    // log base..branch --oneline
    if (args.includes('log') && args.includes('--oneline')) {
      const range = args[args.indexOf('--oneline') - 1];
      if (range === 'main..worktree-bridge-dirty-commits') {
        return 'abc1234 feat: mobile commit 1\ndef5678 fix: mobile commit 2\n';
      }
      return '';
    }

    return '';
  };

  const inspectResult = claudeLauncher.inspectClaudeWorktrees(fakeRepo, mockExec);
  assert.strictEqual(inspectResult.cleanWorktrees.length, 1, 'Debe haber exactamente 1 worktree limpio');
  assert.strictEqual(inspectResult.cleanWorktrees[0].branch, 'worktree-bridge-clean-123');
  assert.strictEqual(inspectResult.cleanWorktrees[0].sessionId, 'clean-123');

  assert.strictEqual(inspectResult.dirtyWorktrees.length, 2, 'Debe haber 2 worktrees con cambios (dirty)');
  const dirtyUncommitted = inspectResult.dirtyWorktrees.find((w) => w.branch === 'worktree-bridge-dirty-uncommitted');
  assert(dirtyUncommitted !== undefined);
  assert.strictEqual(dirtyUncommitted.reason, 'Archivos modificados sin commitear');

  const dirtyCommits = inspectResult.dirtyWorktrees.find((w) => w.branch === 'worktree-bridge-dirty-commits');
  assert(dirtyCommits !== undefined);
  assert.strictEqual(dirtyCommits.reason, '2 commit(s) sin mergear hacia main');

  // --- Parte 2: pruneCleanClaudeWorktrees ---
  // Invariante: solo remueve worktrees limpios, NUNCA los dirty
  const executedCommands = [];
  const mockExecPrune = (bin, args) => {
    executedCommands.push({ bin, args });
    return mockExec(bin, args);
  };

  const pruneResult = claudeLauncher.pruneCleanClaudeWorktrees(fakeRepo, mockExecPrune);
  assert.strictEqual(pruneResult.removedCount, 1, 'Debe remover 1 worktree limpio');
  assert.strictEqual(pruneResult.removedWorktrees[0].branch, 'worktree-bridge-clean-123');
  assert.strictEqual(pruneResult.preservedCount, 2, 'Debe preservar los 2 dirty worktrees');

  // Comprobar que git worktree unlock, remove y branch -D se llamaron SOLO para wtClean
  const unlocked = executedCommands.filter((c) => c.args.includes('unlock'));
  assert.strictEqual(unlocked.length, 1);
  assert.strictEqual(unlocked[0].args[unlocked[0].args.indexOf('unlock') + 1], wtClean);

  const removed = executedCommands.filter((c) => c.args.includes('remove'));
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(removed[0].args[removed[0].args.indexOf('remove') + 1], wtClean);

  const branchD = executedCommands.filter((c) => c.args.includes('-D'));
  assert.strictEqual(branchD.length, 1);
  assert.strictEqual(branchD[0].args[branchD[0].args.indexOf('-D') + 1], 'worktree-bridge-clean-123');

  const pruned = executedCommands.filter((c) => c.args.includes('prune'));
  assert.strictEqual(pruned.length, 1);

  // --- Parte 3: buildStopMessageAndKeyboard (UI de Telegram) ---
  const mockWorkspaces = [
    { id: '11223344', numericId: 1, path: fakeRepo, name: 'fake-repo', displayName: 'fake-repo' }
  ];

  // Caso 3.1: Sesión detenida con worktrees limpios y dirty
  const stopResWithWorktrees = {
    success: true,
    pid: 12345,
    projectPath: fakeRepo
  };

  const uiWithWorktrees = buildStopMessageAndKeyboard(
    stopResWithWorktrees,
    mockWorkspaces,
    () => inspectResult
  );

  assert(uiWithWorktrees.text.includes('Sesión de Claude Code finalizada'), 'Debe reportar sesión finalizada');
  assert(uiWithWorktrees.text.includes('*1* worktree(s) temporales de Claude sin cambios'), 'Debe alertar de 1 limpio');
  assert(uiWithWorktrees.text.includes('Worktrees con cambios detectados (conservados intactos)'), 'Debe listar los dirty');
  assert(uiWithWorktrees.text.includes('worktree-bridge-dirty-commits'), 'Muestra rama con commits');
  assert(uiWithWorktrees.keyboard !== null, 'Debe ofrecer teclado interactivo');

  const buttons = uiWithWorktrees.keyboard.inline_keyboard.flat();
  const cleanBtn = buttons.find((b) => b.callback_data === 'rc_clean:11223344');
  assert(cleanBtn !== undefined, 'Debe existir botón para purgar');
  assert(cleanBtn.text.includes('Purgar 1 worktree(s) limpios'));
  const keepBtn = buttons.find((b) => b.callback_data === 'rc_keep');
  assert(keepBtn !== undefined, 'Debe existir botón para conservar');

  // Verificar límite de 64 bytes de Telegram
  assert(Buffer.byteLength(cleanBtn.callback_data, 'utf8') <= 64);
  assert(Buffer.byteLength(keepBtn.callback_data, 'utf8') <= 64);

  // Caso 3.2: Sesión detenida sin worktrees limpios
  const uiNoClean = buildStopMessageAndKeyboard(
    stopResWithWorktrees,
    mockWorkspaces,
    () => ({ cleanWorktrees: [], dirtyWorktrees: [] })
  );
  assert.strictEqual(uiNoClean.keyboard, null, 'No debe ofrecer botones si no hay worktrees limpios que purgar');

  // --- Parte 4: Handlers de Telegram del Bot (Callbacks rc_clean y rc_keep, y /claude clean) ---
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();

  const callbackEvt = (data, updateId) => ({
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 600 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'bot' },
        text: 'aviso'
      }
    }
  });

  // Callback rc_keep
  llamadas.length = 0;
  await bot.handleUpdate(callbackEvt('rc_keep', 300));
  const ansKeep = llamadas.find((c) => c.method === 'answerCallbackQuery' && c.payload.text.includes('conservados'));
  assert(ansKeep !== undefined, 'rc_keep debe responder con acuse');
  const msgKeep = llamadas.find((c) => c.method === 'sendMessage' && c.payload.text.includes('conservados'));
  assert(msgKeep !== undefined, 'rc_keep debe confirmar conservación de worktrees');

  // Callback rc_clean con id desconocido
  llamadas.length = 0;
  await bot.handleUpdate(callbackEvt('rc_clean:unknown-id', 301));
  const msgUnknown = llamadas.find((c) => c.method === 'sendMessage' && c.payload.text.includes('No se encontró el proyecto'));
  assert(msgUnknown !== undefined, 'rc_clean rechaza id desconocido');

  // Comando /claude clean con argumento no reconocido
  llamadas.length = 0;
  await bot.handleUpdate({
    update_id: 302,
    message: {
      message_id: 902,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(USUARIO_OK), type: 'private' },
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      text: '/claude clean non-existent-workspace',
      entities: [{ type: 'bot_command', offset: 0, length: 7 }]
    }
  });
  const msgCleanNotFound = llamadas.find((c) => c.method === 'sendMessage' && c.payload.text.includes('Workspace no encontrado'));
  assert(msgCleanNotFound !== undefined, '/claude clean rechaza workspace inexistente');

  // Limpieza
  fs.rmSync(fakeRepo, { recursive: true, force: true });
}
console.log('✔ Test 49 [FEAT-004 / BE-011]: Detección y purga segura de worktrees huérfanos de Claude Code (Opción B)');

// Test 50 [FEAT-022]: /cast desde Telegram.
// Lo que se afirma es la superficie de seguridad, no el camino feliz (que
// lanzaría `agy`): solo agentes registrados y read-only, workspace solo por
// botón, pendientes de un uso y del mismo chat, el token de memoria fuera del
// entorno del hijo, y ningún camino que retome el hilo de un agente sin
// `--agent`.
{
  const botMod = await import('../bot.js');
  const policyMod = await import('../policy.js');

  const entornoCast = policyMod.sanitizeEnv({ PATH: '/usr/bin', LAGRANGE_MEMORY_TOKEN: 'secreto-memoria' });
  assert.strictEqual(entornoCast.LAGRANGE_MEMORY_TOKEN, undefined, 'El token de memoria no se hereda al hijo');

  // Home falso: registro de agentes y estado de hilos sin tocar los del usuario.
  // `os.homedir()` lee USERPROFILE/HOME en cada llamada.
  const homeFalso = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cast-home-'));
  const homePrevio = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = homeFalso;
  process.env.HOME = homeFalso;
  fs.mkdirSync(path.join(homeFalso, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeFalso, '.claude', 'antigravity-agents.json'), JSON.stringify({
    agents: {
      lector: { skill: 'agency-code-reviewer', read_only: true },
      escritor: { skill: 'agency-code-reviewer', read_only: false }
    }
  }));
  fs.writeFileSync(path.join(homeFalso, '.claude', 'antigravity-agents-state.json'), JSON.stringify({
    agents: { lector: { conversation_id: 'hilo-del-agente', casts: 1 } }
  }));

  try {
    assert.strictEqual(botMod.validarCastDesdeChat('lector').ok, true, 'Un agente read-only registrado se acepta');
    const rw = botMod.validarCastDesdeChat('escritor');
    assert(!rw.ok && rw.mensaje.includes('read/write'), 'Un agente read/write se rechaza');
    const fantasma = botMod.validarCastDesdeChat('fantasma');
    assert(!fantasma.ok && fantasma.mensaje.includes('no es un agente registrado'), 'Uno sin registrar se rechaza');
    assert(fantasma.mensaje.includes('`lector`') && !fantasma.mensaje.includes('`escritor`'),
      'El listado de disponibles ofrece solo los read-only');
    const raro = botMod.validarCastDesdeChat('../x`*');
    assert(!raro.ok && !raro.mensaje.includes('../x'), 'Un nombre sin forma de nombre no se repite en el Markdown');

    const kb = botMod.buildCastWorkspacesKeyboard('0a1b2c3d', [
      { id: 'a1b2c3d4', displayName: 'app' },
      { id: 'e5f60718', displayName: 'otra' }
    ]);
    const botones = kb.inline_keyboard.flat();
    assert(botones.every((b) => Buffer.byteLength(b.callback_data, 'utf8') <= 64), 'Todo callback_data entra en 64 bytes');
    assert(botones.some((b) => b.callback_data === 'cast_ws:0a1b2c3d:a1b2c3d4'), 'El botón lleva id de cast y de workspace');

    botMod.resetRuntimeState();
    const t0 = 1_000_000;
    const idA = botMod.guardarCastPendiente({ chatId: 1, agent: 'lector', prompt: 'p' }, t0);
    assert.strictEqual(botMod.tomarCastPendiente(idA, 2, t0), null, 'Otro chat no puede consumir el pendiente');
    assert.strictEqual(botMod.tomarCastPendiente(idA, 1, t0).agent, 'lector', 'El mismo chat sí');
    assert.strictEqual(botMod.tomarCastPendiente(idA, 1, t0), null, 'Es de un solo uso');
    const idB = botMod.guardarCastPendiente({ chatId: 1, agent: 'lector', prompt: 'p' }, t0);
    assert.strictEqual(botMod.tomarCastPendiente(idB, 1, t0 + 11 * 60 * 1000), null, 'Vence a los 10 minutos');

    const { bot, llamadas } = botDePrueba();
    botMod.resetRuntimeState();
    const comando = (text, updateId) => ({
      update_id: updateId,
      message: {
        message_id: 1000 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }]
      }
    });
    const textos = () => llamadas.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);

    await bot.handleUpdate(comando('/cast', 400));
    assert(textos().at(-1).includes('Uso'), '/cast sin argumentos explica el uso');
    await bot.handleUpdate(comando('/cast escritor revisá esto', 401));
    assert(textos().at(-1).includes('read/write'), '/cast de un agente read/write se rechaza sin encolar');
    assert.strictEqual(queue.getQueueLength(), 0, 'Nada quedó en la cola');

    await bot.handleUpdate({
      update_id: 402,
      callback_query: {
        id: '402',
        from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
        chat_instance: 'ci',
        data: 'cast_ws:deadbeef:a1b2c3d4',
        message: {
          message_id: 1402,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(USUARIO_OK), type: 'private' },
          from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'bot' },
          text: 'cast'
        }
      }
    });
    const respuestaCb = llamadas.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    assert(respuestaCb.payload.text.includes('expiró'), 'Un cast_ws sin pendiente se rechaza');
    assert.strictEqual(queue.getQueueLength(), 0, 'Y no se despacha nada');

    // El camino al fail-open: la sesión del chat apunta al hilo de un agente
    // (por la vía que sea) y el usuario hace /resume. Correría el agente por
    // defecto con escritura sobre la conversación del agente.
    state.setConversationId(tg(Number(USUARIO_OK)), 'hilo-del-agente');
    await bot.handleUpdate(comando('/resume seguí', 403));
    assert(textos().at(-1).includes('hilo de un agente persistido'), '/resume se niega a retomar el hilo de un agente');
    assert.strictEqual(queue.getQueueLength(), 0, 'No se encola la tarea');
    assert.strictEqual(state.getConversationId(tg(Number(USUARIO_OK))), null, 'Y la sesión envenenada del chat se limpia');

    const callbackCast = (data, updateId) => ({
      update_id: updateId,
      callback_query: {
        id: String(updateId),
        from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
        chat_instance: 'ci',
        data,
        message: {
          message_id: 1000 + updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(USUARIO_OK), type: 'private' },
          from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'bot' },
          text: 'plan'
        }
      }
    });

    // exec_plan con el hilo de un agente: se rechaza ANTES del acuse
    // optimista, no después de haber anunciado «Plan Aprobado».
    const antesExec = llamadas.length;
    await bot.handleUpdate(callbackCast('exec_plan:hilo-del-agente', 404));
    const trasExec = llamadas.slice(antesExec);
    assert(trasExec.some((c) => c.method === 'answerCallbackQuery' && c.payload.text.includes('agente persistido')),
      'exec_plan con el hilo de un agente se rechaza');
    assert(!trasExec.some((c) => c.method === 'sendMessage'), 'Sin anunciar «Plan Aprobado»');
    assert.strictEqual(queue.getQueueLength(), 0, 'Ni encolar nada');

    const idCancel = botMod.guardarCastPendiente({ chatId: Number(USUARIO_OK), agent: 'lector', prompt: 'p' });
    await bot.handleUpdate(callbackCast(`cast_cancel:${idCancel}`, 405));
    assert.strictEqual(botMod.tomarCastPendiente(idCancel, Number(USUARIO_OK)), null, 'cast_cancel descarta el pendiente');
    botMod.resetRuntimeState();
  } finally {
    process.env.USERPROFILE = homePrevio.USERPROFILE;
    process.env.HOME = homePrevio.HOME;
    if (homePrevio.HOME === undefined) delete process.env.HOME;
    fs.rmSync(homeFalso, { recursive: true, force: true });
  }
}
console.log('✔ Test 50 [FEAT-022]: /cast solo castea agentes read-only y nada retoma su hilo sin --agent');

// Test 51: /help responde. Las viñetas llevaban backticks sin escapar dentro
// del template literal: el archivo parseaba (`...` / plan < instrucción > `...`
// es una expresión válida) pero cada /help tiraba ReferenceError y moría en
// silencio. Roto desde 42d4b08 sin que ningún test lo notara.
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();
  const text = '/help';
  await bot.handleUpdate({
    update_id: 500,
    message: {
      message_id: 1500,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(USUARIO_OK), type: 'private' },
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }]
    }
  });
  const ayuda = llamadas.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text).join('\n');
  assert(ayuda.includes('/plan') && ayuda.includes('/cast'), '/help responde y lista los comandos, /cast incluido');
  assert(ayuda.includes('/diff') && ayuda.includes('/logs'), '/help lista /diff y /logs');
  assert(ayuda.includes('/cancel cast'), '/help explica /cancel cast');
  resetRuntimeState();
}
console.log('✔ Test 51: /help responde con la lista de comandos');

