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
// ==============================================================================
// Rama feat/cast-favorito: FEAT-025 recortada, el último workspace primero.
// ==============================================================================

// Test 67 [FEAT-025]: el teclado de /cast pone el último workspace primero, con
// ⭐ en lugar de 📁. Ordenar y marcar van juntos: no puede quedar una ⭐ fuera
// del primer lugar.
{
  const botMod = await import('../bot.js');
  const ws = [
    { id: 'aaaaaaaa', displayName: 'uno (a)' },
    { id: 'bbbbbbbb', displayName: 'dos (b)' },
    { id: 'cccccccc', displayName: 'tres (c)' }
  ];
  const textos = (kb) => kb.inline_keyboard.flat().map((b) => b.text);
  assert.deepStrictEqual(textos(botMod.buildCastWorkspacesKeyboard('0a1b2c3d', ws)).slice(0, 3),
    ['📁 uno (a)', '📁 dos (b)', '📁 tres (c)'], 'sin favorito, el orden y los íconos de siempre');

  const conFav = botMod.buildCastWorkspacesKeyboard('0a1b2c3d', ws, 'cccccccc').inline_keyboard.flat();
  assert.strictEqual(conFav[0].text, '⭐ tres (c)', 'el favorito va primero y la ⭐ reemplaza al 📁');
  assert.strictEqual(conFav[0].callback_data, 'cast_ws:0a1b2c3d:cccccccc', 'el callback_data no cambia');
  assert.strictEqual(conFav.filter((b) => b.text.startsWith('⭐')).length, 1, 'una sola ⭐');
  assert.deepStrictEqual(conFav.slice(1, 3).map((b) => b.text), ['📁 uno (a)', '📁 dos (b)'], 'el resto conserva su orden');
  assert(conFav.every((b) => Buffer.byteLength(b.callback_data, 'utf8') <= 64), 'todo callback_data entra en 64 bytes');
  assert.deepStrictEqual(ws.map((w) => w.id), ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], 'no muta la lista');

  const fantasma = textos(botMod.buildCastWorkspacesKeyboard('0a1b2c3d', ws, 'dddddddd'));
  assert(fantasma[0] === '📁 uno (a)' && !fantasma.some((t) => t.startsWith('⭐')), 'un favorito que ya no existe no marca nada');
}
console.log('✔ Test 67 [FEAT-025]: el favorito va primero con ⭐ y el callback no cambia');

// Test 68 [FEAT-025]: el favorito se guarda por chat, con la forma de un id, y
// /reset (que reinicia la conversación) no lo borra.
{
  assert.strictEqual(state.getUltimoWorkspaceCast(tg(777000)), null, 'chat sin registro → null');
  assert.strictEqual(state.setUltimoWorkspaceCast(tg(777000), 'abcdef12'), true);
  assert.strictEqual(state.getUltimoWorkspaceCast(tg('777000')), 'abcdef12', 'número y string son el mismo chat');
  assert.strictEqual(state.setUltimoWorkspaceCast(tg(777000), '../x'), false, 'un id con otra forma no se escribe');
  assert.strictEqual(state.getUltimoWorkspaceCast(tg(777000)), 'abcdef12', 'y el anterior queda');
  state.setConversationId(tg(777000), 'conv-x');
  state.clearConversationId(tg(777000));
  assert.strictEqual(state.getUltimoWorkspaceCast(tg(777000)), 'abcdef12', '/reset no borra el favorito');
}
console.log('✔ Test 68 [FEAT-025]: el favorito se guarda por chat y sobrevive a /reset');

// Test 69 [FEAT-025]: de punta a punta. /cast, tocar el segundo proyecto, y el
// siguiente /cast lo ofrece primero. Home falso y sin allowlist del entorno:
// el test no puede depender de la configuración real de la máquina.
{
  const botMod = await import('../bot.js');
  const homeFalso = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fav-home-'));
  const proyA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fav-a-')));
  const proyB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fav-b-')));
  const previo = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    ALLOWED_CLAUDE_WORKSPACES: process.env.ALLOWED_CLAUDE_WORKSPACES,
    ALLOWED_WORKSPACES: process.env.ALLOWED_WORKSPACES
  };
  process.env.USERPROFILE = homeFalso;
  process.env.HOME = homeFalso;
  delete process.env.ALLOWED_CLAUDE_WORKSPACES;
  delete process.env.ALLOWED_WORKSPACES;
  fs.mkdirSync(path.join(homeFalso, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeFalso, '.claude', 'antigravity-agents.json'), JSON.stringify({
    agents: { lector: { skill: 'agency-code-reviewer', read_only: true } }
  }));
  fs.writeFileSync(path.join(homeFalso, '.claude.json'), JSON.stringify({
    projects: { [proyA]: { hasTrustDialogAccepted: true }, [proyB]: { hasTrustDialogAccepted: true } }
  }));

  const { bot, llamadas } = botDePrueba();
  botMod.resetRuntimeState();
  let casteos = 0;
  botMod.usarEjecutoresDePrueba({
    castear: async () => { casteos++; return { ok: true, respuesta: 'listo', memoria: {} }; }
  });
  const botonesDelUltimoTeclado = () => {
    const m = llamadas.filter((c) => c.method === 'sendMessage' && c.payload.reply_markup).at(-1);
    return m ? m.payload.reply_markup.inline_keyboard.flat().filter((b) => b.callback_data.startsWith('cast_ws:')) : [];
  };

  try {
    await bot.handleUpdate(comandoDe('/cast lector revisá esto', 830));
    const primero = botonesDelUltimoTeclado();
    assert.strictEqual(primero.length, 2, `dos proyectos: ${JSON.stringify(primero)}`);
    assert(!primero.some((b) => b.text.startsWith('⭐')), 'la primera vez no hay favorito');

    const elegido = primero[1];
    const idElegido = elegido.callback_data.split(':')[2];
    await bot.handleUpdate({
      update_id: 831,
      callback_query: {
        id: '831',
        from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
        chat_instance: 'ci',
        data: elegido.callback_data,
        message: { message_id: 5, date: 0, chat: { id: Number(USUARIO_OK), type: 'private' }, text: 'x' }
      }
    });
    const limite = Date.now() + 2000;
    while (casteos === 0 && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(casteos, 1, 'se casteó');
    assert.strictEqual(state.getUltimoWorkspaceCast(tg(USUARIO_OK)), idElegido, 'y se recordó ese workspace');

    await bot.handleUpdate(comandoDe('/cast lector otra cosa', 832));
    const segundo = botonesDelUltimoTeclado();
    assert(segundo[0].text.startsWith('⭐') && segundo[0].callback_data.endsWith(`:${idElegido}`),
      `el siguiente /cast lo ofrece primero: ${JSON.stringify(segundo)}`);
  } finally {
    botMod.resetRuntimeState();
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of [homeFalso, proyA, proyB]) fs.rmSync(d, { recursive: true, force: true });
  }
}
console.log('✔ Test 69 [FEAT-025]: el workspace del último cast aparece primero en el siguiente');

// Test 70 [BE-015]: compatibilidad de --effort y modelos en executor
{
  const executor = await import('../executor.js');
  const { spawn: spawnReal } = await import('node:child_process');

  assert.strictEqual(executor.modeloAdmiteEsfuerzo(null), false, 'sin modelo no se arriesga effort');
  assert.strictEqual(executor.modeloAdmiteEsfuerzo('claude-opus-4-6-thinking'), false, 'rechaza Claude Opus');
  assert.strictEqual(executor.modeloAdmiteEsfuerzo('claude-sonnet-4-6'), false, 'rechaza Claude Sonnet');
  assert.strictEqual(executor.modeloAdmiteEsfuerzo('gpt-oss-120b-medium'), false, 'rechaza GPT-OSS');
  assert.strictEqual(executor.modeloAdmiteEsfuerzo('gemini-3.8-flash-high'), false, 'rechaza sufijado');
  assert.strictEqual(executor.modeloAdmiteEsfuerzo('gemini-3.8-flash'), true, 'acepta base');

  let capturados = [];
  const fakeSpawn = (bin, args) => {
    capturados = args;
    return spawnReal(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"ok"}})+"\\n")']);
  };

  const envPrevio = { ...process.env };
  delete process.env.AGY_EFFORT;
  delete process.env.AGY_MODEL;
  try {
    await executor.runAgyTask({ prompt: 'test', spawnFn: fakeSpawn });
    assert(!capturados.includes('--effort'), 'sin AGY_EFFORT no se añade --effort');
    assert(!capturados.includes('--model'), 'sin AGY_MODEL no se añade --model');

    assert.deepStrictEqual(executor.modeloPorDefecto(), { model: null, effortPorDefecto: null }, 'sin .env no hay modelo ni esfuerzo por defecto');

    // El incidente: AGY_EFFORT en el entorno del daemon y ningún modelo.
    process.env.AGY_EFFORT = 'high';
    assert.deepStrictEqual(executor.modeloPorDefecto(), { model: null, effortPorDefecto: 'high' }, 'modeloPorDefecto lee el entorno en cada llamada');
    await executor.runAgyTask({ prompt: 'test', spawnFn: fakeSpawn });
    assert(!capturados.includes('--effort'), 'AGY_EFFORT sin modelo no añade --effort');

    await executor.runAgyTask({ prompt: 'test', model: 'claude-opus-4-6-thinking', spawnFn: fakeSpawn });
    assert(!capturados.includes('--effort'), 'AGY_EFFORT con modelo Claude se omite');
    assert(capturados.includes('--model'), 'pero sí se pasa --model');

    await executor.runAgyTask({ prompt: 'test', model: 'gemini-3.8-flash', spawnFn: fakeSpawn });
    assert(capturados.includes('--effort'), 'AGY_EFFORT con modelo Gemini se pasa --effort');
    assert(capturados.includes('--model'), 'y también --model');

    // Paridad con el MCP: un pedido explícito incompatible se corta antes del spawn.
    capturados = null;
    const rVal = await executor.runAgyTask({ prompt: 'test', model: 'claude-opus-4-6-thinking', effort: 'high', spawnFn: fakeSpawn });
    assert.strictEqual(capturados, null, 'pedido explícito incompatible no llega a lanzar agy');
    assert(!rVal.success && /no admite effort/.test(rVal.error), 'y explica el motivo');

    const rArgs = await executor.runAgyArgs(['--model', 'gemini-3.8-flash-high', '--effort', 'low', '-p', 'x'], { spawnFn: fakeSpawn });
    assert.strictEqual(capturados, null, 'runAgyArgs (cast) tampoco lanza agy');
    assert(!rArgs.success && /ya fija el esfuerzo/.test(rArgs.error), 'y explica la colisión');
  } finally {
    for (const [k, v] of Object.entries(envPrevio)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
console.log('✔ Test 70 [BE-015]: compatibilidad de --effort y modelos en executor');

