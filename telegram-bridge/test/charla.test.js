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
// FEAT-047 — Modo charla: el texto suelto sigue con el alma mientras esté fresca.
// ==============================================================================
{
  const botMod = await import('../bot.js');
  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-modo-'));
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });

  const { bot } = botDePrueba();
  botMod.resetRuntimeState();

  const charlas = [];
  let trabajos = 0;
  let turnoOk = true;
  let pendiente = null;
  let lanzar = false;
  botMod.usarEjecutoresDePrueba({
    charlar: async ({ clave, texto }) => {
      charlas.push({ clave, texto });
      if (lanzar) throw new Error('explotó el carril');
      if (pendiente) return pendiente;
      return turnoOk
        ? { ok: true, clave, respuesta: 'Te escucho.', aplicadas: [], rechazadas: [] }
        : { ok: false, clave, motivo: 'agy no contestó' };
    },
    runAgyTask: async () => { trabajos++; return { success: true, data: {}, durationSeconds: 1, conversationId: null }; }
  });

  const esperar = async (cond) => {
    const limite = Date.now() + 3000;
    while (!cond() && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
  };
  const suelto = (text, updateId) => updateDeTexto({ userId: USUARIO_OK, text, updateId });

  try {
    // 1. Después de una charla, el texto suelto la sigue.
    await bot.handleUpdate(comandoDe('/charla hola', 920));
    await esperar(() => charlas.length === 1);
    await bot.handleUpdate(suelto('y esto también es charla', 921));
    await esperar(() => charlas.length === 2);
    assert.strictEqual(charlas.length, 2, 'el texto suelto sigue la charla');
    assert.strictEqual(trabajos, 0, 'y no abre trabajo');

    // 2. Mensaje en vuelo, arrancando EN FRÍO: el modo lo tiene que encender
    // dispatchCharla al despachar. Si el caso heredara el modo del anterior, el
    // test pasaría aunque ese encendido no existiera.
    state.limpiarModoCharla(tg(Number(USUARIO_OK)));
    assert.strictEqual(state.getModoCharla(tg(Number(USUARIO_OK))), null, 'el caso arranca sin modo charla');
    let resolverEnVuelo;
    pendiente = new Promise((r) => { resolverEnVuelo = r; });
    await bot.handleUpdate(comandoDe('/charla primero', 922));
    await esperar(() => charlas.length === 3);
    assert.strictEqual(state.getModoCharla(tg(Number(USUARIO_OK))), 'alya', 'despachar la charla ya enciende el modo, sin esperar la respuesta');
    await bot.handleUpdate(suelto('segundo, mientras pensás', 923));
    // El carril serializa: el segundo queda ENCOLADO en la charla, no ejecutado.
    await esperar(() => queue.getQueueLength('alma') === 1);
    assert.strictEqual(queue.getQueueLength('alma'), 1, 'el mensaje en vuelo se encola en la charla');
    assert.strictEqual(trabajos, 0, 'y no abre un plan');
    resolverEnVuelo({ ok: true, clave: 'alya', respuesta: 'ya voy', aplicadas: [], rechazadas: [] });
    pendiente = null;
    await esperar(() => charlas.length === 4);
    assert.strictEqual(charlas.length, 4, 'y se procesa cuando el alma termina');

    // 3. Un turno fallido apaga el modo.
    turnoOk = false;
    await bot.handleUpdate(suelto('turno que falla', 924));
    await esperar(() => charlas.length === 5);
    await new Promise((r) => setTimeout(r, 50));
    await bot.handleUpdate(suelto('esto ya es trabajo', 925));
    await esperar(() => trabajos > 0);
    assert.strictEqual(trabajos, 1, 'tras un turno fallido el texto suelto vuelve a trabajo');
    turnoOk = true;

    // 4. /charla nuevo enciende el modo (el aviso promete que el próximo mensaje sigue).
    await bot.handleUpdate(comandoDe('/charla nuevo', 926));
    await bot.handleUpdate(suelto('arranco de cero', 927));
    await esperar(() => charlas.length === 6);
    assert.strictEqual(charlas.length, 6, '/charla nuevo deja el chat en modo charla');
    assert.strictEqual(trabajos, 1, 'sin abrir trabajo');

    // 5. Con la charla fresca, responder al mensaje de un plan sigue siendo
    // trabajo (FEAT-027) y además apaga el modo.
    await bot.handleUpdate({
      update_id: 928,
      message: {
        message_id: 1928, date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
        text: 'cambiá el paso 2',
        reply_to_message: {
          message_id: 8899, date: 0,
          chat: { id: Number(USUARIO_OK), type: 'private' },
          from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'test' },
          text: ['🧠 Plan', '', '_¿Quieres ajustarlo? Responde con los cambios_'].join(String.fromCharCode(10))
        }
      }
    });
    await esperar(() => trabajos > 1);
    assert.strictEqual(trabajos, 2, 'responder al plan sigue yendo a trabajo aunque la charla esté fresca');
    assert.strictEqual(charlas.length, 6, 'y no se lo queda la charla');
    assert.strictEqual(state.getModoCharla(tg(Number(USUARIO_OK))), null, 'y además apaga el modo');

    // 6. Vencimiento de punta a punta: con el ts viejo en el estado, el texto
    // suelto vuelve a trabajo sin que nadie apague nada a mano.
    state.setModoCharla(tg(Number(USUARIO_OK)), 'alya');
    const estadoCrudo = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
    estadoCrudo.chats[`${BOT_ID_PRUEBA}:${USUARIO_OK}`].modoCharla.ts = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(estadoCrudo, null, 2));
    await bot.handleUpdate(suelto('esto es de trabajo, ya pasó media hora', 929));
    await esperar(() => trabajos > 2);
    assert.strictEqual(trabajos, 3, 'con el modo vencido el texto suelto vuelve a trabajo');
    assert.strictEqual(charlas.length, 6, 'y no va a la charla');

    // 8. La renovación al terminar bien: se envejece el ts mientras el alma
    // piensa, así lo único que puede dejar el modo vivo es el refresco de
    // responderCharla (el encendido de dispatchCharla ya quedó viejo).
    let resolverRenovacion;
    pendiente = new Promise((r) => { resolverRenovacion = r; });
    await bot.handleUpdate(comandoDe('/charla turno que renueva', 931));
    await esperar(() => charlas.length === 7);
    const previo = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
    previo.chats[`${BOT_ID_PRUEBA}:${USUARIO_OK}`].modoCharla.ts = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(previo, null, 2));
    assert.strictEqual(state.getModoCharla(tg(Number(USUARIO_OK))), null, 'el modo quedó vencido mientras el alma pensaba');
    resolverRenovacion({ ok: true, clave: 'alya', respuesta: 'listo', aplicadas: [], rechazadas: [] });
    pendiente = null;
    await esperar(() => state.getModoCharla(tg(Number(USUARIO_OK))) !== null);
    assert.strictEqual(state.getModoCharla(tg(Number(USUARIO_OK))), 'alya', 'un turno exitoso renueva la ventana');

    // 7. Si la rama del carril se cae, el modo no puede quedar prendido.
    lanzar = true;
    await bot.handleUpdate(comandoDe('/charla esto va a explotar', 930));
    await esperar(() => state.getModoCharla(tg(Number(USUARIO_OK))) === null);
    assert.strictEqual(state.getModoCharla(tg(Number(USUARIO_OK))), null, 'una excepción en el carril apaga el modo');
    lanzar = false;
  } finally {
    botMod.resetRuntimeState();
    delete process.env.LAGRANGE_ALMAS_DIR;
    try { fs.rmSync(almasDir, { recursive: true, force: true }); } catch {}
  }
}
console.log('✔ Test 76 [FEAT-047]: la charla fresca se queda con el texto suelto, incluso en vuelo');

{
  const botMod = await import('../bot.js');
  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-corte-'));
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });

  const { bot } = botDePrueba();
  botMod.resetRuntimeState();
  let charlas = 0;
  let trabajos = 0;
  botMod.usarEjecutoresDePrueba({
    charlar: async ({ clave }) => { charlas++; return { ok: true, clave, respuesta: 'Ok.', aplicadas: [], rechazadas: [] }; },
    runAgyTask: async () => { trabajos++; return { success: true, data: {}, durationSeconds: 1, conversationId: null }; }
  });
  const esperar = async (cond) => {
    const limite = Date.now() + 3000;
    while (!cond() && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
  };
  const chat = Number(USUARIO_OK);

  // Cada caso: enciende el modo charlando, manda el comando, y mira a dónde va
  // el texto suelto siguiente.
  const casos = [
    { nombre: '/plan', comando: '/plan algo', apaga: true },
    { nombre: '/run', comando: '/run algo', apaga: true },
    { nombre: '/reset', comando: '/reset', apaga: true },
    { nombre: '/resume sin sesión', comando: '/resume seguí', apaga: true },
    { nombre: '/cast', comando: '/cast lector revisá esto', apaga: true },
    { nombre: '/cancel', comando: '/cancel', apaga: true },
    { nombre: '/cancel alma', comando: '/cancel alma', apaga: true },
    { nombre: '/cancel cast', comando: '/cancel cast', apaga: false },
    { nombre: '/status', comando: '/status', apaga: false },
    { nombre: '/queue', comando: '/queue', apaga: false }
  ];

  let updateId = 940;
  try {
    for (const caso of casos) {
      state.setModoCharla(tg(chat), 'alya');
      await bot.handleUpdate(comandoDe(caso.comando, updateId++));
      // El propio comando puede despachar trabajo (/plan lo hace): la foto se
      // toma DESPUÉS, para medir solo a dónde va el texto suelto siguiente.
      await new Promise((r) => setTimeout(r, 200));
      const trabajosAntes = trabajos;
      const charlasAntes = charlas;
      await bot.handleUpdate(updateDeTexto({ userId: USUARIO_OK, text: 'siguiente mensaje suelto', updateId: updateId++ }));
      await esperar(() => trabajos > trabajosAntes || charlas > charlasAntes);
      if (caso.apaga) {
        assert.strictEqual(trabajos, trabajosAntes + 1, `${caso.nombre} apaga el modo charla`);
        assert.strictEqual(charlas, charlasAntes, `${caso.nombre}: el mensaje no fue a la charla`);
      } else {
        assert.strictEqual(charlas, charlasAntes + 1, `${caso.nombre} NO apaga el modo charla`);
        assert.strictEqual(trabajos, trabajosAntes, `${caso.nombre}: el mensaje no fue a trabajo`);
      }
    }
  } finally {
    botMod.resetRuntimeState();
    state.limpiarModoCharla(tg(chat));
    delete process.env.LAGRANGE_ALMAS_DIR;
    try { fs.rmSync(almasDir, { recursive: true, force: true }); } catch {}
  }
}
console.log('✔ Test 77 [FEAT-047]: qué comandos cortan la charla y cuáles no');

{
  // El botón de workspace llama a dispatchCast sin pasar por bot.command('cast'):
  // ese camino también tiene que apagar la charla.
  const botMod = await import('../bot.js');
  botMod.resetRuntimeState();
  botMod.usarEjecutoresDePrueba({ castear: async () => ({ ok: true, respuesta: 'listo', memoria: {} }) });
  const chat = Number(USUARIO_OK);
  const ctxFalso = { chat: { id: chat }, reply: async () => ({ message_id: 4242 }) };
  try {
    state.setModoCharla(tg(chat), 'alya');
    await botMod.dispatchCast(ctxFalso, { agent: 'lector', prompt: 'revisá', cwd: os.tmpdir(), workspaceName: 'tmp' });
    assert.strictEqual(state.getModoCharla(tg(chat)), null, 'dispatchCast apaga el modo charla');
  } finally {
    botMod.resetRuntimeState();
    state.limpiarModoCharla(tg(chat));
  }
}
console.log('✔ Test 78 [FEAT-047]: el botón de workspace del cast también corta la charla');

{
  const chatA = 111222333;
  const chatB = 444555666;

  state.setConversationId(tg(chatA), 'conv-de-trabajo');
  state.setUltimoWorkspaceCast(tg(chatA), 'abcdef12');
  state.setModoCharla(tg(chatA), 'alya');
  assert.strictEqual(state.getModoCharla(tg(chatA)), 'alya', 'el modo se guarda');
  assert.strictEqual(state.getConversationId(tg(chatA)), 'conv-de-trabajo', 'y no pisa la sesión de trabajo');
  assert.strictEqual(state.getUltimoWorkspaceCast(tg(chatA)), 'abcdef12', 'ni el workspace del último cast');
  assert.strictEqual(state.getModoCharla(tg(chatB)), null, 'el modo de un chat no alcanza a otro');

  assert.strictEqual(state.getModoCharla(tg(chatA), { ahora: Date.now() + 31 * 60 * 1000 }), null, 'vence a los 30 minutos');
  state.setModoCharla(tg(chatA), 'alya');
  assert.strictEqual(state.getModoCharla(tg(chatA), { ahora: Date.now() + 29 * 60 * 1000 }), 'alya', 'y un turno nuevo renueva la ventana');

  state.limpiarModoCharla(tg(chatA));
  assert.strictEqual(state.getModoCharla(tg(chatA)), null, 'limpiarModoCharla lo borra');
  assert.strictEqual(state.getConversationId(tg(chatA)), 'conv-de-trabajo', 'sin tocar el resto del chat');
}
console.log('✔ Test 79 [FEAT-047]: el modo charla vive por chat, vence y no pisa nada');

{
  // El alma del modo ya no existe: se avisa y NO se despacha trabajo.
  const botMod = await import('../bot.js');
  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-fantasma-'));
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  const { bot, llamadas } = botDePrueba();
  botMod.resetRuntimeState();
  let trabajos = 0;
  botMod.usarEjecutoresDePrueba({
    charlar: async () => ({ ok: true, respuesta: 'no debería pasar', aplicadas: [], rechazadas: [] }),
    runAgyTask: async () => { trabajos++; return { success: true, data: {}, durationSeconds: 1, conversationId: null }; }
  });
  try {
    state.setModoCharla(tg(Number(USUARIO_OK)), 'fantasma');
    llamadas.length = 0;
    await bot.handleUpdate(updateDeTexto({ userId: USUARIO_OK, text: 'jajaja qué bueno', updateId: 980 }));
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(trabajos, 0, 'un mensaje de charla no abre un plan porque el alma ya no esté');
    assert(textosEnviados(llamadas).includes('Se terminó la charla'), 'y se avisa');
    assert.strictEqual(state.getModoCharla(tg(Number(USUARIO_OK))), null, 'el modo queda limpio');
  } finally {
    botMod.resetRuntimeState();
    delete process.env.LAGRANGE_ALMAS_DIR;
    try { fs.rmSync(almasDir, { recursive: true, force: true }); } catch {}
  }
}
console.log('✔ Test 80 [FEAT-047]: con el alma borrada se avisa y no se abre trabajo');

