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
// FEAT-043 — Almas: carril de charla, desvío del reply y comandos.
// ==============================================================================
{
  const botMod = await import('../bot.js');
  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-bridge-'));
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });

  const { bot } = botDePrueba();
  botMod.resetRuntimeState();

  const charlas = [];
  let trabajos = 0;
  botMod.usarEjecutoresDePrueba({
    charlar: async ({ clave, texto }) => {
      charlas.push({ clave, texto });
      return { ok: true, clave, respuesta: 'Te escucho.', aplicadas: [{ tipo: 'agregar', id: 'm1' }], rechazadas: [] };
    },
    runAgyTask: async () => {
      trabajos++;
      return { success: true, data: {}, durationSeconds: 1, conversationId: null };
    }
  });

  const esperar = async (cond) => {
    const limite = Date.now() + 3000;
    while (!cond() && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
  };

  // Un update de texto que RESPONDE a un mensaje del bot (el `from.id` es el de botDePrueba).
  const updateConReply = ({ text, replyId, replyText, updateId }) => ({
    update_id: updateId,
    message: {
      message_id: 500 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(USUARIO_OK), type: 'private' },
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      text,
      reply_to_message: {
        message_id: replyId,
        date: 0,
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'test', username: 'test_bot' },
        text: replyText
      }
    }
  });

  try {
    await bot.handleUpdate(comandoDe('/charla hola, ¿cómo andás?', 900));
    await esperar(() => charlas.length > 0);
    assert.strictEqual(charlas.length, 1, '/charla llega al carril del alma');
    assert.strictEqual(charlas[0].clave, 'alya', 'con la única alma que existe');
    assert.strictEqual(trabajos, 0, '/charla no toca el carril de trabajo');

    state.registrarReaccionable(4242, { alma: 'alya', extracto: 'Te escucho.' }, tg(Number(USUARIO_OK)));
    await bot.handleUpdate(updateConReply({ text: 'seguime contando', replyId: 4242, replyText: '💬 *Alya:* Te escucho.', updateId: 901 }));
    await esperar(() => charlas.length > 1);
    assert.strictEqual(charlas.length, 2, 'un reply a un mensaje registrado sigue la charla');
    assert.strictEqual(trabajos, 0, 'y no abre trabajo');

    // Purgado del mapa: queda el prefijo.
    await bot.handleUpdate(updateConReply({ text: 'y esto otro', replyId: 7777, replyText: '💬 *Alya:* algo de la semana pasada', updateId: 902 }));
    await esperar(() => charlas.length > 2);
    assert.strictEqual(charlas.length, 3, 'el prefijo alcanza cuando el mapa ya no la tiene');

    // FEAT-027: responder al plan es la forma de ajustarlo. No se lo queda la charla.
    await bot.handleUpdate(updateConReply({
      text: 'cambiá el paso 2',
      replyId: 8888,
      replyText: '🧠 Plan\n\n_¿Quieres ajustarlo? Responde con los cambios: sigue sobre este mismo plan._',
      updateId: 903
    }));
    await esperar(() => trabajos > 0);
    assert.strictEqual(trabajos, 1, 'un reply al plan sigue abriendo trabajo');
    assert.strictEqual(charlas.length, 3, 'y la charla no lo intercepta');
  } finally {
    botMod.resetRuntimeState();
    delete process.env.LAGRANGE_ALMAS_DIR;
    try { fs.rmSync(almasDir, { recursive: true, force: true }); } catch {}
  }
}
console.log('✔ Test 71 [FEAT-043]: /charla y el reply al alma no tocan el workspace');

{
  assert.match(
    avisoDeDespacho({ habiaTareaEnCurso: false, posEnCola: 1, mode: 'alma' }),
    /Pensando/,
    'el aviso de charla no dice «Ejecutando tarea»'
  );
  assert.match(
    avisoDeDespacho({ habiaTareaEnCurso: true, posEnCola: 1, mode: 'alma' }),
    /otra charla en curso/,
    'encolada, lo dice con sus palabras'
  );
  assert.strictEqual(queue.carrilDe({ kind: 'alma' }), 'alma', 'una charla va a su carril');
  assert(queue.CARRILES.includes('alma'), 'el carril está declarado');
}
console.log('✔ Test 72 [FEAT-043]: avisos y carril propios de la charla');

{
  state.registrarReaccionable(1001, { alma: 'alya', extracto: 'hola' }, tg(Number(USUARIO_OK)));
  state.setConversationId(tg(777), 'conv-persistente');
  assert(state.getReaccionable(1001, tg(Number(USUARIO_OK))), 'reaccionables sobrevive a otra escritura del estado');
  assert.strictEqual(state.getConversationId(tg(777)), 'conv-persistente', 'y no rompe lo demás');
  assert.strictEqual(state.getReaccionable(999999, tg(Number(USUARIO_OK))), null, 'un id desconocido da null');
}
console.log('✔ Test 73 [FEAT-043]: el mapa de reaccionables persiste en state.json');

{
  const botMod = await import('../bot.js');
  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-cmd-'));
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });

  const { bot, llamadas } = botDePrueba();
  botMod.resetRuntimeState();

  // Una charla que se queda en curso: así hay algo que cancelar y algo que listar.
  let resolverTurno;
  const enCurso = new Promise((r) => { resolverTurno = r; });
  botMod.usarEjecutoresDePrueba({ charlar: async () => enCurso });

  try {
    await bot.handleUpdate(comandoDe('/charla contame algo', 910));
    const hastaEnCurso = Date.now() + 3000;
    while (!botMod.carrilOcupado('alma') && Date.now() < hastaEnCurso) await new Promise((r) => setTimeout(r, 5));
    assert(botMod.carrilOcupado('alma'), 'la charla queda en curso en su carril');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/status', 911));
    assert(textosEnviados(llamadas).includes('Cola de charla'), '/status nombra la cola de charla');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/queue', 912));
    const cola = textosEnviados(llamadas);
    // sendSafeChunk manda HTML: el markdown ya viene convertido.
    assert(/Charla/.test(cola), '/queue titula el carril de charla');
    assert(cola.includes('charla con'), '/queue describe la tarea sin decir «modo undefined»');
    assert(!cola.includes('undefined'), '/queue no imprime undefined');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/cancel alma', 913));
    const cancelacion = textosEnviados(llamadas);
    assert(cancelacion.includes('charla en curso abortada'), '/cancel alma nombra el carril');
    assert(!cancelacion.includes('undefined'), '/cancel alma no imprime undefined');
    resolverTurno({ ok: false, cancelled: true });

    // Con dos almas y sin voz, hay que nombrarla.
    semilla.sembrar('diego', { name: 'Diego', personality: 'Tranquilo', language: 'es' });
    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/charla hola a quien sea', 914));
    const ambiguo = textosEnviados(llamadas);
    assert(ambiguo.includes('¿Con cuál?'), '/charla sin voz y con dos almas pide el nombre');
    assert(ambiguo.includes('Alya') && ambiguo.includes('Diego'), 'y las lista');
  } finally {
    botMod.resetRuntimeState();
    delete process.env.LAGRANGE_ALMA_POR_DEFECTO;
    delete process.env.LAGRANGE_ALMAS_DIR;
    try { fs.rmSync(almasDir, { recursive: true, force: true }); } catch {}
  }
}
console.log('✔ Test 74 [FEAT-043]: /status, /queue, /cancel alma y la desambiguación de voz');

{
  // La purga del mapa: por antigüedad, en el mismo ciclo que la de asks.
  state.registrarReaccionable(2001, { alma: 'alya', extracto: 'vieja' }, tg(Number(USUARIO_OK)));
  const crudo = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
  crudo.reaccionables[`${BOT_ID_PRUEBA}:${USUARIO_OK}:2001`].ts = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(crudo, null, 2));

  state.registrarReaccionable(2002, { alma: 'alya', extracto: 'nueva' }, tg(Number(USUARIO_OK)));
  assert.strictEqual(state.getReaccionable(2001, tg(Number(USUARIO_OK))), null, 'una entrada de más de 7 días se purga');
  assert(state.getReaccionable(2002, tg(Number(USUARIO_OK))), 'y la nueva queda');
}
console.log('✔ Test 75 [FEAT-043]: el mapa de reaccionables se purga por antigüedad');

