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
// Rama feat/bot-carril-cast: FEAT-026, un carril de casts al lado del principal.
// ==============================================================================

// Test 59 [FEAT-026]: una cola por carril. Con [run, cast] esperando, el cast
// sale por su carril aunque el run esté primero: con una sola cola y un
// shift(), quedaba bloqueado detrás (head-of-line).
{
  queue.clearQueue();
  const run = { prompt: 'run', mode: 'accept-edits' };
  const cast = { prompt: 'cast', mode: 'cast', kind: 'cast', agent: 'lector' };
  assert.strictEqual(queue.enqueueTask(run), 1, 'posición dentro del carril principal');
  assert.strictEqual(queue.enqueueTask(cast), 1, 'posición dentro del carril de casts');
  assert.strictEqual(run.carril, 'principal');
  assert.strictEqual(cast.carril, 'cast');
  assert.strictEqual(queue.getQueueLength(), 2, 'sin carril: el total');
  assert.strictEqual(queue.getQueueLength('cast'), 1);

  const todo = queue.getQueueSnapshot();
  assert.deepStrictEqual(todo.map((t) => t.carril), ['principal', 'cast'], 'snapshot: primero el principal');
  assert.strictEqual(todo[1].agent, 'lector', 'el snapshot trae el agente del cast');
  assert.strictEqual(todo[1].kind, 'cast');
  assert.strictEqual(queue.getQueueSnapshot('cast').length, 1, 'snapshot de un solo carril');

  assert.strictEqual(queue.dequeueTask('cast'), cast, 'el cast sale aunque el run esté antes');
  assert.strictEqual(queue.getQueueLength('principal'), 1, 'y el run sigue en su cola');
  queue.enqueueTask({ ...cast });
  assert.strictEqual(queue.clearQueue('cast'), 1, 'vaciar un carril');
  assert.strictEqual(queue.getQueueLength(), 1, 'deja el otro intacto');
  assert.strictEqual(queue.clearQueue(), 1);
  assert.throws(() => queue.dequeueTask('otro'), /Carril desconocido/);
}
console.log('✔ Test 59 [FEAT-026]: una cola por carril, sin head-of-line blocking');

// Test 60 [FEAT-026]: un cast arranca mientras un /run sigue en curso, un
// segundo cast espera al primero, y /cancel cast corta solo su carril. Con
// ejecutores falsos: la rama de ejecución real lanza agy.
{
  const botMod = await import('../bot.js');
  const { bot, llamadas } = botDePrueba();
  botMod.resetRuntimeState();
  // Espera determinista: sondea la condición en vez de dormir un tiempo fijo,
  // que bajo carga daría falsos rojos. Si no se cumple en 2 s, falla con motivo.
  const esperarQue = async (condicion, motivo) => {
    const limite = Date.now() + 2000;
    while (!condicion()) {
      if (Date.now() > limite) throw new Error(`Test 60: no se cumplió a tiempo: ${motivo}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const diferido = () => { let resolver; const promesa = new Promise((r) => { resolver = r; }); return { promesa, resolver }; };

  const run = diferido();
  let runIniciado = 0;
  let cancelRun = 0;
  let llamadasCastear = 0;
  let cancelCast = 0;
  const opcionesDelCast = [];
  botMod.usarEjecutoresDePrueba({
    runAgyTask: async ({ onSpawn }) => {
      runIniciado++;
      onSpawn(() => { cancelRun++; run.resolver({ success: false, cancelled: true }); return true; });
      return run.promesa;
    },
    castear: async ({ opciones }) => {
      llamadasCastear++;
      opcionesDelCast.push(opciones);
      const d = diferido();
      opciones.onSpawn(() => { cancelCast++; d.resolver({ ok: false, cancelled: true }); return true; });
      return d.promesa;
    }
  });
  assert.strictEqual(botMod.ejecutoresSonLosReales(), false, 'los ejecutores falsos están puestos');

  const avisosCast = [];
  const ctxCast = {
    chat: { id: Number(USUARIO_OK) },
    reply: async (t) => { avisosCast.push(t); return { message_id: 900 + avisosCast.length }; }
  };
  const cast = { agent: 'lector', prompt: 'revisá el último commit', cwd: os.tmpdir(), workspaceName: 'tmp' };

  try {
    await bot.handleUpdate(comandoDe('/run correr la suite completa', 800));
    await esperarQue(() => runIniciado === 1, 'el run arranca');

    // BE-015: el cast toma modelo y esfuerzo del .env, no del `/model` de agy.
    const modeloPrevio = process.env.AGY_MODEL;
    const effortPrevio = process.env.AGY_EFFORT;
    process.env.AGY_MODEL = 'gemini-3.8-flash';
    process.env.AGY_EFFORT = 'high';
    try {
      await botMod.dispatchCast(ctxCast, cast);
      await esperarQue(() => llamadasCastear === 1, 'el cast arranca');
    } finally {
      if (modeloPrevio === undefined) delete process.env.AGY_MODEL; else process.env.AGY_MODEL = modeloPrevio;
      if (effortPrevio === undefined) delete process.env.AGY_EFFORT; else process.env.AGY_EFFORT = effortPrevio;
    }
    assert.strictEqual(opcionesDelCast[0].model, 'gemini-3.8-flash', 'el cast recibe AGY_MODEL del .env');
    assert.strictEqual(opcionesDelCast[0].effortPorDefecto, 'high', 'y AGY_EFFORT como esfuerzo por defecto, no como pedido');
    assert.strictEqual(opcionesDelCast[0].effort, undefined, 'el esfuerzo del .env nunca se trata como pedido explícito');
    assert.strictEqual(opcionesDelCast[0].soloLectura, true, 'sin perder soloLectura');
    assert(cancelRun === 0 && botMod.carrilOcupado('principal'), 'el cast arrancó CON el run todavía en curso');
    assert(avisosCast[0].includes('Casteando'), 'y su aviso no dice que está esperando');

    // Sin espera a propósito: dispatchCast ya dejó el cast en su cola y el
    // carril está ocupado, así que no hay nada asíncrono que pudiera arrancarlo.
    await botMod.dispatchCast(ctxCast, { ...cast, prompt: 'segundo pedido' });
    assert.strictEqual(llamadasCastear, 1, 'el segundo cast no arranca: uno a la vez por carril');
    assert(avisosCast[1].includes('Ya hay un cast en curso') && avisosCast[1].includes('#2'), 'y su aviso lo dice');
    assert.strictEqual(queue.getQueueLength('cast'), 1, 'queda en la cola de casts');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/queue', 801));
    const vista = textosEnviados(llamadas);
    assert(vista.includes('Principal') && vista.includes('Casts') && vista.includes('lector'), '/queue muestra los dos carriles');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/cancel cast', 802));
    assert(cancelCast === 1 && cancelRun === 0, '/cancel cast corta el cast y no el run');
    assert.strictEqual(queue.getQueueLength('cast'), 0, 'y vacía la cola de casts');
    assert(textosEnviados(llamadas).includes('cast en curso abortado'), 'el mensaje dice qué se cortó');
    await esperarQue(() => !botMod.carrilOcupado('cast'), 'el carril de casts queda libre');
    assert(botMod.carrilOcupado('principal'), 'y el run sigue en curso');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/cancel foo', 803));
    assert(textosEnviados(llamadas).includes('No se canceló nada') && cancelRun === 0, 'un argumento desconocido no cancela nada');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/cancel CAST', 804));
    assert(textosEnviados(llamadas).includes('No hay ningún cast'), 'sin cast: su propio mensaje, y el argumento se normaliza');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/cancel', 805));
    assert.strictEqual(cancelRun, 1, '/cancel corta el run');
    assert(textosEnviados(llamadas).includes('tarea en curso abortada'));
    await esperarQue(() => !botMod.carrilOcupado('principal'), 'el carril principal queda libre');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/queue', 806));
    assert(textosEnviados(llamadas).includes('No hay nada en curso'), 'los dos carriles quedaron libres');
  } finally {
    botMod.resetRuntimeState();
  }
  assert.strictEqual(botMod.ejecutoresSonLosReales(), true, 'resetRuntimeState vuelve a los ejecutores reales');
}
console.log('✔ Test 60 [FEAT-026]: el cast corre al lado del run, uno a la vez, y /cancel cast corta solo su carril');

// Test 61 [FEAT-026]: /status informa cada carril por separado.
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();
  await bot.handleUpdate(comandoDe('/status', 810));
  const estado = textosEnviados(llamadas);
  assert(estado.includes('Cola principal') && estado.includes('Cola de casts'), '/status muestra los dos carriles');
  resetRuntimeState();
}
console.log('✔ Test 61 [FEAT-026]: /status muestra los dos carriles');

// Test 62 [FEAT-026]: el aviso de un cast encolado da la razón correcta.
{
  assert(avisoDeDespacho({ habiaTareaEnCurso: false, posEnCola: 1, mode: 'cast' }).includes('Casteando'), 'cast sin espera');
  const encolado = avisoDeDespacho({ habiaTareaEnCurso: true, posEnCola: 1, mode: 'cast' });
  assert(encolado.includes('Ya hay un cast en curso') && encolado.includes('#2'), 'cast detrás de otro cast');
  assert(!encolado.includes('Antigravity está ocupado'), 'no culpa al carril principal');
}
console.log('✔ Test 62 [FEAT-026]: el aviso de un cast encolado nombra al otro cast');

