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
// Rama feat/bot-breadcrumb: FEAT-034, la herramienta activa en el progreso.
// ==============================================================================

// Test 63 [FEAT-034]: el texto del progreso y el recorte de la actividad.
{
  const botMod = await import('../bot.js');
  assert.strictEqual(botMod.lineaDeProgreso('⚙️ Ejecutando tarea', 135), `⚙️ Ejecutando tarea · ${formatElapsed(135)}`, 'sin actividad, el texto de siempre');
  assert.strictEqual(
    botMod.lineaDeProgreso('⚙️ Ejecutando tarea', 135, 'write_to_file → src/a.js'),
    `⚙️ Ejecutando tarea · ${formatElapsed(135)} · write_to_file → src/a.js`,
    'con actividad, al final'
  );
  const larga = botMod.recortarActividad(`run_command → npm test ${'x'.repeat(200)}`);
  assert(larga.length === 60 && larga.endsWith('…'), 'recorta a 60 con …');
  assert.strictEqual(botMod.recortarActividad('run_command →\n  npm\ttest'), 'run_command → npm test', 'colapsa espacios y saltos');
  const conToken = botMod.recortarActividad('run_command → curl -H 1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert(conToken.includes('[REDACTED]') && !conToken.includes('AAAAAAAAAAAAAAAAAAAA'), 'redacta un token antes de recortar');
}
console.log('✔ Test 63 [FEAT-034]: lineaDeProgreso y recortarActividad');

// Test 64 [FEAT-034]: runAgyTask por stream-json, con un agy falso. Cada guion
// fija un camino del cierre: éxito, error de agy, crash con y sin NDJSON,
// stream sin `result`, basura intercalada y cancelación a mitad.
{
  const executor = await import('../executor.js');
  const { spawn: spawnReal } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-falso-'));
  const script = path.join(dir, 'agy-falso.js');
  fs.writeFileSync(script, `
    const modo = process.argv[2];
    const e = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    const tool = (i, params) => ({ event: 'step_update', step_update: { step_index: i, step_type: 'tool', state: 'ACTIVE', tool_name: params.CommandLine ? 'run_command' : 'write_to_file', tool_info: { parameters: params } } });
    if (modo === 'feliz') {
      e({ event: 'init', conversation_id: 'conv-1', init: {} });
      e(tool(1, { TargetFile: 'src/a.js' }));
      e({ event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', text_delta: 'Hola' } });
      e({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'Listo.', duration_seconds: 42, usage: { input_tokens: 10, output_tokens: 5 } } });
    } else if (modo === 'error-agy') {
      e({ event: 'init', conversation_id: 'conv-2' });
      e({ event: 'result', result: { status: 'ERROR', error: 'cuota agotada' } });
    } else if (modo === 'crash-texto') {
      process.stdout.write('panic: flag desconocido --xyz\\n');
      process.exitCode = 1;
    } else if (modo === 'crash-stderr') {
      process.stderr.write('boom en stderr\\n');
      process.exitCode = 1;
    } else if (modo === 'sin-result') {
      e({ event: 'init', conversation_id: 'conv-3' });
      e({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'parcial' } });
    } else if (modo === 'basura') {
      process.stdout.write('aviso raro de agy\\n');
      e({ event: 'result', result: { conversation_id: 'conv-4', status: 'SUCCESS', response: 'ok' } });
    } else if (modo === 'lento') {
      e({ event: 'init', conversation_id: 'conv-5' });
      let i = 0;
      setInterval(() => e(tool(i, { CommandLine: 'npm test ' + i++ })), 20);
      setTimeout(() => process.exit(0), 5000);
    } else if (modo === 'json') {
      process.stdout.write(JSON.stringify({ conversation_id: 'c', response: 'r', status: 'SUCCESS' }));
    }
  `);
  // BE-033 — Lo que el ejecutor le pasa al spawn: agy sin ventana de consola.
  let opcionesVistas = null;
  const falso = (modo) => (bin, args, opts) => { opcionesVistas = opts; return spawnReal(process.execPath, [script, modo], opts); };
  const correr = (modo, extra = {}) => executor.runAgyTask({ prompt: 'x', spawnFn: falso(modo), ...extra });

  const actividades = [];
  const feliz = await correr('feliz', { onActividad: (t) => actividades.push(t) });
  assert(feliz.success && feliz.responseText === 'Listo.', `feliz: ${JSON.stringify(feliz).slice(0, 200)}`);
  assert.strictEqual(feliz.conversationId, 'conv-1', 'conversationId del stream');
  assert.deepStrictEqual([opcionesVistas.windowsHide, opcionesVistas.shell], [true, false], 'BE-033: agy se lanza con windowsHide y sin shell');
  assert(opcionesVistas.env && !('TELEGRAM_BOT_TOKEN' in opcionesVistas.env), 'y con el entorno saneado de siempre');
  assert.strictEqual(opcionesVistas.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true', 'BE-034: y sin que agy se actualice solo');
  assert.strictEqual(feliz.data.usage.output_tokens, 5, 'data.usage para formatExecutionMeta');
  assert.strictEqual(feliz.sessionSeconds, 42, 'sessionSeconds desde duration_seconds, como con json');
  assert.deepStrictEqual(actividades, ['write_to_file → src/a.js'], 'onActividad recibe la herramienta activa');

  const errorAgy = await correr('error-agy');
  assert(!errorAgy.success && errorAgy.error.includes('cuota agotada'), `error de agy: ${errorAgy.error}`);

  const crashTexto = await correr('crash-texto');
  assert(!crashTexto.success && crashTexto.error.includes('flag desconocido'), `crash sin NDJSON conserva el diagnóstico: ${crashTexto.error}`);

  const crashStderr = await correr('crash-stderr');
  assert(!crashStderr.success && crashStderr.error.includes('boom en stderr'), 'crash con stderr');

  const sinResult = await correr('sin-result');
  assert(sinResult.success && sinResult.responseText === 'parcial' && sinResult.sessionSeconds === 0, 'sin result y código 0: éxito tolerante con los deltas');

  const basura = await correr('basura');
  assert(basura.success && basura.responseText === 'ok', 'una línea ilegible no rompe el resultado');
  assert(!basura.responseText.includes('{'), 'y nunca vuelca NDJSON crudo');

  const tardias = [];
  let cancelar = null;
  const promesa = correr('lento', { onActividad: (t) => tardias.push(t), onSpawn: (c) => { cancelar = c; } });
  const limite = Date.now() + 3000;
  while (tardias.length < 2 && Date.now() < limite) await new Promise((r) => setTimeout(r, 10));
  assert(tardias.length >= 2, 'el guion lento emitió herramientas');
  assert.strictEqual(cancelar(), true, 'cancelar a mitad');
  const alCancelar = tardias.length;
  const cancelada = await promesa;
  await new Promise((r) => setTimeout(r, 200));
  assert(cancelada.cancelled, 'la tarea queda cancelada');
  assert.strictEqual(tardias.length, alCancelar, 'ninguna actividad después de cancelar');

  // Test 65 [FEAT-034]: los casts siguen por json, sin cambios.
  const cast = await executor.runAgyArgs(['--agent', 'x'], { spawnFn: falso('json') });
  assert(cast.success && cast.data.response === 'r', `runAgyArgs sigue en json: ${JSON.stringify(cast).slice(0, 200)}`);
  console.log('✔ Test 65 [FEAT-034]: los casts siguen por --output-format json');

  // Test 65b [FEAT-054]: un cast que pide stream-json muestra su actividad, y
  // la salida cruda (NDJSON) nunca vuelve como respuesta.
  const actividadCast = [];
  const castStream = await executor.runAgyArgs(['--output-format', 'stream-json', '--agent', 'x'], {
    spawnFn: falso('feliz'),
    onActividad: (t) => actividadCast.push(t)
  });
  assert(castStream.success && castStream.data.response === 'Listo.', `stream rearma la respuesta: ${JSON.stringify(castStream).slice(0, 200)}`);
  assert.strictEqual(castStream.data.conversation_id, 'conv-1');
  assert.deepStrictEqual(actividadCast, ['write_to_file → src/a.js'], 'onActividad recibe la herramienta');
  assert.strictEqual(castStream.rawOutput, '', 'en stream no se devuelve el NDJSON crudo');
  const sinStream = [];
  await executor.runAgyArgs(['--agent', 'x'], { spawnFn: falso('json'), onActividad: (t) => sinStream.push(t) });
  assert.strictEqual(sinStream.length, 0, 'en json no hay actividad');
  console.log('✔ Test 65b [FEAT-054]: el cast en stream muestra actividad sin volcar NDJSON');

  // Test 65c [FEAT-055]: en stream, el texto del agente llega por onTexto; en
  // json, nunca.
  const textos = [];
  const actividadConTexto = [];
  await executor.runAgyArgs(['--output-format', 'stream-json', '--agent', 'x'], {
    spawnFn: falso('feliz'),
    onActividad: (t) => actividadConTexto.push(t),
    onTexto: (t) => textos.push(t)
  });
  assert.deepStrictEqual(textos, ['Hola'], 'onTexto recibe el delta de agent_response');
  assert.deepStrictEqual(actividadConTexto, ['write_to_file → src/a.js'], 'y la actividad sigue llegando aparte');
  const textosJson = [];
  await executor.runAgyArgs(['--agent', 'x'], { spawnFn: falso('json'), onTexto: (t) => textosJson.push(t) });
  assert.strictEqual(textosJson.length, 0, 'en json no hay texto en vivo');
  console.log('✔ Test 65c [FEAT-055]: el texto en vivo llega por onTexto solo en stream');

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
console.log('✔ Test 64 [FEAT-034]: runAgyTask por stream-json respeta el contrato y los diagnósticos');

// Test 66 [FEAT-034]: processTaskQueue le pasa onActividad a runAgyTask.
{
  const botMod = await import('../bot.js');
  const { bot } = botDePrueba();
  botMod.resetRuntimeState();
  let recibido = null;
  botMod.usarEjecutoresDePrueba({
    runAgyTask: async ({ onActividad }) => {
      recibido = onActividad;
      onActividad('write_to_file → src/a.js');
      return { success: false, cancelled: true };
    }
  });
  try {
    await bot.handleUpdate(comandoDe('/run algo', 820));
    const limite = Date.now() + 2000;
    while (recibido === null && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(typeof recibido, 'function', 'la rama principal cablea onActividad');
  } finally {
    botMod.resetRuntimeState();
  }
}
console.log('✔ Test 66 [FEAT-034]: la rama principal cablea onActividad');

