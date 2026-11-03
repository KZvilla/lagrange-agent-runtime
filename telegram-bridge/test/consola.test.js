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
// Test 120 [BE-020]: una reacción sobre una nota de voz se responde en texto y
// además con voz; sobre texto, solo texto. La voz no frena la cola, no se apila
// sobre otra síntesis y su falla no se lleva el texto.
{
  const botMod = await import('../bot.js');
  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-voz-'));
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });
  let reloj = 500_000;
  const { bot, llamadas } = botDePrueba({ ahora: () => reloj });
  // La nota de voz devuelve un mensaje, como Telegram.
  bot.api.config.use(async (prev, method, payload) => {
    if (method === 'sendVoice' || method === 'sendAudio') {
      llamadas.push({ method, payload });
      return { ok: true, result: { message_id: 90000 + llamadas.length, date: 0, chat: { id: Number(USUARIO_OK) } } };
    }
    return prev(method, payload);
  });
  botMod.resetRuntimeState();
  const sintesis = [];
  let resultadoVoz = 'ok';
  botMod.usarEjecutoresDePrueba({
    charlar: async (args) => ({ ok: true, clave: args.clave, respuesta: 'Ya te escuché, no insistas.', aplicadas: [], rechazadas: [] }),
    sintetizar: async (op) => {
      sintesis.push(op);
      if (resultadoVoz === 'falla') return { ok: false, motivo: 'voicebox_caido' };
      const wavPath = path.join(almasDir, `voz-${sintesis.length}.wav`);
      fs.writeFileSync(wavPath, 'RIFF....WAVEfmt prueba');
      return { ok: true, wavPath };
    }
  });
  const esperar = async (cond, ms = 3000) => {
    const limite = Date.now() + ms;
    while (!cond() && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
  };
  const chat = Number(USUARIO_OK);
  const voces = () => llamadas.filter((x) => x.method === 'sendVoice');

  try {
    // 1. Sobre una nota de voz: texto primero, después la voz.
    state.registrarReaccionable(84000, { alma: 'alya', modalidad: 'voz', extracto: 'Te mandé un audio.' }, tg(chat));
    await bot.handleUpdate(updateDeReaccion({ messageId: 84000, newReaction: [emoji('❤')], updateId: 2000 }));
    await esperar(() => voces().length === 1);
    const texto = llamadas.find((x) => x.method === 'sendMessage' && String(x.payload.text).includes('no insistas'));
    assert(texto, 'la respuesta en texto sale igual');
    assert.strictEqual(voces().length, 1, 'y además sale una nota de voz');
    assert(llamadas.indexOf(texto) < llamadas.indexOf(voces()[0]), 'el texto va primero');
    assert.strictEqual(sintesis[0].voz, 'Alya', 'con la voz del alma');
    assert.strictEqual(sintesis[0].texto, 'Ya te escuché, no insistas.', 'leyendo la respuesta');
    assert.deepStrictEqual(voces()[0].payload.reply_parameters, { message_id: 84000, allow_sending_without_reply: true }, 'la voz también responde al mensaje reaccionado');
    await esperar(() => !fs.existsSync(path.join(almasDir, 'voz-1.wav')));
    assert(!fs.existsSync(path.join(almasDir, 'voz-1.wav')), 'el wav se borra después de mandarlo');
    const idVoz = 90000 + llamadas.indexOf(voces()[0]) + 1;
    const registrada = state.getReaccionable(idVoz, tg(chat));
    assert(registrada && registrada.modalidad === 'voz', 'la nota nueva es reaccionable como voz');

    // 2. Sobre texto: solo texto.
    reloj += 20_000;
    state.registrarReaccionable(84001, { alma: 'alya', modalidad: 'texto', extracto: 'Te escribí.' }, tg(chat));
    const antes = sintesis.length;
    await bot.handleUpdate(updateDeReaccion({ messageId: 84001, newReaction: [emoji('👍')], updateId: 2001 }));
    await esperar(() => !botMod.carrilOcupado('alma'));
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(sintesis.length, antes, 'una reacción sobre texto no sintetiza');

    // 3. La síntesis falla: el texto ya llegó y nada revienta.
    reloj += 20_000;
    resultadoVoz = 'falla';
    const mensajesAntes = llamadas.filter((x) => x.method === 'sendMessage').length;
    state.registrarReaccionable(84002, { alma: 'alya', modalidad: 'voz', extracto: 'Otro audio.' }, tg(chat));
    await bot.handleUpdate(updateDeReaccion({ messageId: 84002, newReaction: [emoji('🔥')], updateId: 2002 }));
    await esperar(() => sintesis.length === antes + 1);
    await new Promise((r) => setTimeout(r, 50));
    assert(llamadas.filter((x) => x.method === 'sendMessage').slice(mensajesAntes).some((x) => String(x.payload.text).includes('no insistas')), 'el texto llegó aunque la voz falló');
    assert.strictEqual(voces().length, 1, 'y no se mandó ninguna nota');

    // 4. Con otra síntesis en curso, no se apila GPU.
    resultadoVoz = 'ok';
    const task = { voz: 'Alya', clave: 'alya' };
    const ctxFalso = { chat: { id: chat }, replyWithVoice: async () => { throw new Error('no debería llamarse'); } };
    let soltar;
    botMod.usarEjecutoresDePrueba({ sintetizar: () => new Promise((r) => { soltar = r; }) });
    const primera = botMod.responderConVoz(ctxFalso, task, { respuesta: 'uno' });
    const segunda = await botMod.responderConVoz(ctxFalso, task, { respuesta: 'dos' });
    assert.deepStrictEqual(segunda, { ok: false, motivo: 'ocupado' }, 'con el cerrojo tomado no sintetiza');
    soltar({ ok: false, motivo: 'cancelada' });
    await primera;
    const liberado = await botMod.escucharTarea('t_noexiste');
    assert.strictEqual(liberado.codigo, 404, 'y al terminar el cerrojo queda libre para la web');
  } finally {
    botMod.resetRuntimeState();
    delete process.env.LAGRANGE_ALMAS_DIR;
    try { fs.rmSync(almasDir, { recursive: true, force: true }); } catch {}
  }
}
console.log('✔ Test 120 [BE-020]: una reacción sobre voz se responde también con voz, sin frenar ni apilar');

// Test 121 [BE-030]: lo que ya está abierto no se propone otra vez.
{
  const tareas = await import('../tareas.js');
  fs.rmSync(tareas.rutaTareas(), { force: true });
  tareas.reiniciarParaTests();
  try {
    const alya = { clave: 'alya' };
    const primera = tareas.proponerTarjeta({ ...alya, titulo: 'Revisar telegram-bridge/web/nucleo.js', pedido: 'auditar' });
    assert.strictEqual(primera.ok, true, JSON.stringify(primera));
    const otra = tareas.proponerTarjeta({ ...alya, titulo: 'Revisar telegram-bridge/web/nucleo.js', pedido: 'auditar de nuevo' });
    assert.strictEqual(otra.codigo, 409, 'la misma propuesta dos veces no entra');
    assert.strictEqual(otra.rechazo, 'repetida', 'y el pie lo dice');
    assert.strictEqual(tareas.proponerTarjeta({ ...alya, titulo: '  REVISAR   telegram-bridge/web/núcleo.js ', pedido: 'x' }).rechazo, 'repetida', 'ni con mayúsculas, tildes o espacios distintos');
    assert.strictEqual(tareas.proponerTarjeta({ clave: 'priscilla', titulo: 'Revisar telegram-bridge/web/nucleo.js', pedido: 'x' }).rechazo, 'repetida', 'ni desde otra alma');

    // Una tarjeta del usuario con ese título también bloquea; una cerrada no.
    const mia = tareas.crearTarjeta({ titulo: 'Pulir la interfaz', pedido: 'a mano' });
    assert.strictEqual(tareas.proponerTarjeta({ ...alya, titulo: 'pulir la interfaz', pedido: 'x' }).rechazo, 'repetida', 'contra una tarjeta del usuario');
    tareas.borrarTarjeta(mia.tarea.id);
    const tras = tareas.proponerTarjeta({ ...alya, titulo: 'pulir la interfaz', pedido: 'x' });
    assert.strictEqual(tras.ok, true, 'borrada la del usuario, se puede proponer');

    // Hijas: se comparan entre hermanas, no contra todo el tablero.
    const madreA = tareas.crearTarjeta({ titulo: 'Trabajo A', pedido: 'a' }).tarea;
    const madreB = tareas.crearTarjeta({ titulo: 'Trabajo B', pedido: 'b' }).tarea;
    const orq = { autor: 'agente:lagrange-architect' };
    assert.strictEqual(tareas.proponerTarjeta({ ...orq, madre: madreA.id, titulo: 'Escribir tests', pedido: 'x' }).ok, true);
    assert.strictEqual(tareas.proponerTarjeta({ ...orq, madre: madreB.id, titulo: 'Escribir tests', pedido: 'x' }).ok, true, 'el mismo nombre en otro trabajo es otra tarjeta');
    assert.strictEqual(tareas.proponerTarjeta({ ...orq, madre: madreA.id, titulo: 'Escribir tests', pedido: 'x' }).rechazo, 'repetida', 'entre hermanas sí se repite');
  } finally {
    tareas.reiniciarParaTests();
  }
}
console.log('✔ Test 121 [BE-030]: una propuesta repetida se rechaza, con hijas comparadas entre hermanas');

// Test 122 [BE-031]: reanudar lo que ya no tiene próxima falla sin tocar nada.
{
  const prog = await import('../programaciones.js');
  prog.reiniciarParaTests();
  for (const p of prog.listar()) prog.borrar(p.id);
  try {
    const f = (h, min = 0) => new Date(2026, 8, 17, h, min, 0, 0);
    const { programacion } = prog.crear({
      pedido: 'recordame', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' }, horario: 'en 30m', ahora: () => f(10)
    });
    prog.marcarDisparo(programacion.id, { ahora: () => f(10, 30) });
    const corrida = prog.obtener(programacion.id);
    assert.strictEqual(corrida.activa, false, 'una cita única se apaga al correr');
    const r = prog.activar(programacion.id, true, { ahora: () => f(11) });
    assert.strictEqual(r.codigo, 400, 'reanudarla no tiene próxima');
    assert.strictEqual(prog.obtener(programacion.id).activa, false, 'y sigue pausada en memoria');
    prog.reiniciarParaTests();
    assert.strictEqual(prog.obtener(programacion.id).activa, false, 'y en disco');
    assert.strictEqual(prog.activar(programacion.id, false).ok, true, 'pausar una ya pausada sigue andando');
  } finally {
    for (const p of prog.listar()) prog.borrar(p.id);
    prog.reiniciarParaTests();
  }
}
console.log('✔ Test 122 [BE-031]: reanudar sin próxima falla sin dejar la programación a medias');

// Test 123 [FEAT-067]: un cron creado en la consola, con la opción marcada,
// corre por la consola y además avisa al teléfono. Sin la opción, no; silencioso
// sin novedades, no; si falla, avisa el fallo.
{
  const botMod = await import('../bot.js');
  const prog = await import('../programaciones.js');
  const tareas = await import('../tareas.js');
  const cola = await import('../queue.js');
  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-cron-tg-'));
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });
  const previoDueno = process.env.ALLOWED_USER_IDS;
  process.env.ALLOWED_USER_IDS = USUARIO_OK;
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cron-tg-'));
  const { llamadas } = botDePrueba();
  botMod.resetRuntimeState();
  prog.reiniciarParaTests();
  for (const p of prog.listar()) prog.borrar(p.id);
  let respuesta = { ok: true, respuesta: 'Hay dos tarjetas esperando.' };
  botMod.usarEjecutoresDePrueba({
    charlar: async (args) => ({ clave: args.clave, aplicadas: [], rechazadas: [], ...respuesta })
  });
  const f = (h, min = 0) => new Date(2026, 8, 18, h, min, 0, 0);
  const esperarVacio = async () => {
    const limite = Date.now() + 3000;
    while (Date.now() < limite && (cola.getQueueLength('programado') > 0 || botMod.carrilOcupado('programado'))) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 30));
  };
  const alTelefono = () => llamadas.filter((x) => x.method === 'sendMessage' && String(x.payload.chat_id) === USUARIO_OK
    && String(x.payload.text).includes('🕒'));
  const alya = { tipo: 'alma', clave: 'alya', voz: 'Alya' };
  let web = null;
  try {
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const disparar = async (extra, h) => {
      const { programacion } = prog.crear({ titulo: 'guardia', pedido: '¿pendientes?', sujeto: alya, horario: 'cada 1h', ahora: () => f(h), ...extra });
      await botMod.pasoDelReloj({ ahora: () => f(h + 1) });
      await esperarVacio();
      prog.borrar(programacion.id);
      return programacion;
    };

    // 1. Con la opción: la copia llega al dueño con título y resultado.
    await disparar({ avisarTelegram: true }, 1);
    const copia = alTelefono();
    assert.strictEqual(copia.length, 1, `una copia al teléfono: ${JSON.stringify(llamadas.map((x) => [x.method, x.payload.chat_id]))}`);
    assert(copia[0].payload.text.includes('guardia') && copia[0].payload.text.includes('programada en la consola'), copia[0].payload.text);
    assert(copia[0].payload.text.includes('Hay dos tarjetas esperando.'), 'con el resultado');

    // 2. Sin la opción: nada al teléfono.
    await disparar({}, 3);
    assert.strictEqual(alTelefono().length, 1, 'sin la opción no manda nada');

    // 3. Silenciosa sin novedades: nada.
    respuesta = { ok: true, respuesta: botMod.MARCA_SILENCIO };
    await disparar({ avisarTelegram: true, silencioso: true }, 5);
    assert.strictEqual(alTelefono().length, 1, 'silenciosa sin novedades no avisa');

    // 4. Falla: avisa el fallo.
    respuesta = { ok: false, motivo: 'agy no respondió' };
    await disparar({ avisarTelegram: true }, 7);
    const trasFallo = alTelefono();
    assert.strictEqual(trasFallo.length, 2, 'un fallo también avisa');
    assert(trasFallo[1].payload.text.includes('falló'), trasFallo[1].payload.text);
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    for (const p of prog.listar()) prog.borrar(p.id);
    prog.reiniciarParaTests();
    tareas.reiniciarParaTests();
    if (previoDueno === undefined) delete process.env.ALLOWED_USER_IDS; else process.env.ALLOWED_USER_IDS = previoDueno;
    delete process.env.LAGRANGE_ALMAS_DIR;
    for (const d of [raiz, almasDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}
console.log('✔ Test 123 [FEAT-067]: un cron de la consola también avisa al teléfono, si se pide');

// Test 124 [FEAT-068]: archivar tarjetas cerradas. Solo cerradas, idempotente
// (sin evento ni aviso de más), un solo guardado por lote, sin tocar madre ni
// hijas, y la API: la masiva archiva solo los ids que se le mandan.
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const { TOPE_ARCHIVAR } = await import('../web/nucleo.js');
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  const ruta = tareas.rutaTareas();
  try { fs.rmSync(ruta, { force: true }); } catch {}
  const leerDisco = () => JSON.parse(fs.readFileSync(ruta, 'utf8'));
  const alma = { tipo: 'alma', clave: 'alya', voz: 'Alya' };
  const cerradaCon = (estadoFinal, extra = {}) => {
    const t = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: `p ${estadoFinal}`, ...extra });
    tareas.actualizar(t.id, { estado: estadoFinal, error: estadoFinal === 'ok' ? null : 'falló' });
    return tareas.obtener(t.id);
  };
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-archivar-'));
  const previo = { LAGRANGE_ALMAS_DIR: process.env.LAGRANGE_ALMAS_DIR };
  process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
  let web = null;

  try {
    // Registro: cada estado cerrado se archiva; lo abierto y Por hacer, no.
    const cerradas = ['ok', 'error', 'cancelada', 'interrumpida'].map((e) => cerradaCon(e));
    const enCola = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: 'espera' });
    const enCurso = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: 'corre' });
    tareas.actualizar(enCurso.id, { estado: 'en_curso' });
    const porHacer = tareas.crearTarjeta({ pedido: 'todavía no' }).tarea;
    assert.strictEqual(cerradas[0].archivada, undefined, 'una tarea sin el campo no está archivada');

    const avisos = [];
    tareas.suscribir((t) => avisos.push(t.id));
    const actualizadaAntes = cerradas[1].actualizada;
    const r = tareas.archivarTareas([...cerradas.map((t) => t.id), cerradas[0].id, enCola.id, enCurso.id, porHacer.id, 't_nadie']);
    assert.deepStrictEqual(
      [r.ok, r.archivadas, r.yaArchivadas, r.rechazadas, r.noExisten],
      [true, cerradas.map((t) => t.id), [], [enCola.id, enCurso.id, porHacer.id], ['t_nadie']],
      'reparto del lote, con el id repetido deduplicado');
    assert.deepStrictEqual(avisos, cerradas.map((t) => t.id), 'un aviso por archivada, ninguno por las rechazadas');
    const archivada = tareas.obtener(cerradas[1].id);
    assert(archivada.archivada && archivada.eventos.at(-1).tipo === 'archivada' && archivada.archivada === archivada.eventos.at(-1).t);
    assert.strictEqual(archivada.actualizada, actualizadaAntes, 'archivar no es trabajo: no toca actualizada');
    assert.strictEqual(archivada.estado, 'error', 'ni el estado');
    assert.deepStrictEqual([tareas.obtener(enCola.id).estado, tareas.obtener(enCurso.id).estado, tareas.obtener(porHacer.id).estado], ['en_cola', 'en_curso', 'por_hacer']);
    assert(!('archivada' in tareas.obtener(enCola.id)), 'la rechazada queda igual');
    assert.strictEqual(leerDisco().tareas.find((t) => t.id === archivada.id).archivada, archivada.archivada, 'persiste');
    assert.strictEqual(tareas.resumen(archivada).archivada, archivada.archivada, 'viaja en el resumen');

    // Idempotente: ni evento, ni fecha nueva, ni aviso, ni guardado.
    avisos.length = 0;
    const eventosAntes = archivada.eventos.length;
    const fecha = archivada.archivada;
    const mtime = fs.statSync(ruta).mtimeMs;
    const otraVez = tareas.archivarTareas([archivada.id]);
    assert.deepStrictEqual([otraVez.archivadas, otraVez.yaArchivadas], [[], [archivada.id]]);
    assert.strictEqual(tareas.archivarTarea(archivada.id).ok, true, 'la individual también');
    assert.deepStrictEqual([archivada.eventos.length, archivada.archivada, avisos.length], [eventosAntes, fecha, 0]);
    assert.strictEqual(fs.statSync(ruta).mtimeMs, mtime, 'sin cambios no se guarda');

    // Individuales: 404, 409 y desarchivar.
    assert.strictEqual(tareas.archivarTarea('t_nadie').codigo, 404);
    assert.strictEqual(tareas.archivarTarea(enCola.id).codigo, 409);
    assert.strictEqual(tareas.archivarTarea(porHacer.id).codigo, 409);
    assert.strictEqual(tareas.desarchivarTarea('t_nadie').codigo, 404);
    assert.strictEqual(tareas.desarchivarTarea(enCola.id).codigo, 409, 'no estaba archivada');
    const vuelta = tareas.desarchivarTarea(archivada.id);
    assert(vuelta.ok && !('archivada' in vuelta.tarea) && vuelta.tarea.eventos.at(-1).tipo === 'desarchivada');
    assert.strictEqual(tareas.desarchivarTarea(archivada.id).codigo, 409, 'desarchivar dos veces');

    // Devolver una archivada: la nueva nace sin marca y la original sigue archivada.
    const devuelta = tareas.devolver(cerradas[2].id);
    assert(devuelta.ok && !devuelta.tarea.archivada && tareas.obtener(cerradas[2].id).archivada);

    // Madre e hija: archivar una no toca a la otra.
    const madre = tareas.crearTarjeta({ pedido: 'madre', sujeto: alma }).tarea;
    const hija = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: 'hija', motivo: 'hija', madre: madre.id });
    tareas.actualizar(hija.id, { estado: 'ok' });
    const madreAntes = JSON.stringify(tareas.obtener(madre.id));
    assert.strictEqual(tareas.archivarTarea(hija.id).ok, true);
    assert.strictEqual(JSON.stringify(tareas.obtener(madre.id)), madreAntes, 'la madre no cambia');
    assert.strictEqual(tareas.obtener(hija.id).madre, madre.id, 'la hija sigue siendo hija');

    // El tope sigue contando las archivadas: salen a la historia como cualquier cerrada.
    for (let i = 0; i < tareas.TOPE_TAREAS + 3; i++) cerradaCon('ok');
    assert(!tareas.obtener(cerradas[0].id), 'la archivada más vieja sale por tope');

    // Solo lectura: 503 en las tres.
    const futuro = { version: tareas.VERSION + 1, tareas: [{ ...leerDisco().tareas.at(-1) }] };
    fs.writeFileSync(ruta, JSON.stringify(futuro));
    tareas.reiniciarParaTests();
    const original = console.error;
    console.error = () => {};
    try {
      const id = futuro.tareas[0].id;
      assert.deepStrictEqual([tareas.archivarTareas([id]).codigo, tareas.archivarTarea(id).codigo, tareas.desarchivarTarea(id).codigo], [503, 503, 503]);
    } finally {
      console.error = original;
    }
    tareas.reiniciarParaTests();
    fs.rmSync(ruta, { force: true });

    // API.
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const puerto = web.servidor.address().port;
    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const get = (r) => pedirWeb(puerto, { ruta: r, headers: cookie });
    const post = (r, cuerpo = {}, headers = {}) => pedirWeb(puerto, {
      metodo: 'POST', ruta: r, headers: { ...cookie, 'content-type': 'application/json', ...headers }, cuerpo: JSON.stringify(cuerpo)
    });

    const deA = cerradaCon('error', { proyecto: 'a' });
    const deB = cerradaCon('error', { proyecto: 'b' });
    const abierta = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: 'abierta' });

    // Masiva: archiva exactamente los ids pedidos (lo que el filtro dejaba ver).
    const masiva = await post('/api/tareas/archivar', { ids: [deA.id, abierta.id, 't_nadie'] });
    assert.strictEqual(masiva.status, 200, masiva.texto);
    assert.deepStrictEqual([masiva.json().archivadas, masiva.json().rechazadas, masiva.json().noExisten], [[deA.id], [abierta.id], ['t_nadie']]);
    assert(!tareas.obtener(deB.id).archivada, 'la del otro proyecto sigue en el tablero');
    for (const [cuerpo, motivo] of [
      [{}, 'sin ids'], [{ ids: 'x' }, 'no es lista'], [{ ids: [] }, 'lista vacía'],
      [{ ids: [deB.id, 'f:w1:lote'] }, 'un id de lote'], [{ ids: Array.from({ length: TOPE_ARCHIVAR + 1 }, (_, i) => `t_${i}`) }, 'más del tope']
    ]) {
      assert.strictEqual((await post('/api/tareas/archivar', cuerpo)).status, 400, motivo);
    }
    assert(!tareas.obtener(deB.id).archivada, 'un pedido inválido no archiva nada');

    // Individuales.
    const una = await post(`/api/tareas/${deB.id}/archivar`);
    assert.deepStrictEqual([una.status, Boolean(una.json().tarea.archivada)], [200, true], una.texto);
    assert(!('eventos' in una.json().tarea), 'responde el resumen');
    assert.strictEqual((await post(`/api/tareas/${deB.id}/archivar`)).status, 200, 'dos veces: igual éxito');
    assert.strictEqual(tareas.obtener(deB.id).eventos.filter((e) => e.tipo === 'archivada').length, 1, 'sin evento repetido');
    assert.strictEqual((await post(`/api/tareas/${abierta.id}/archivar`)).status, 409, 'una abierta no');
    assert.strictEqual((await post('/api/tareas/t_nadie/archivar')).status, 404);
    assert.strictEqual((await post(`/api/tareas/${abierta.id}/desarchivar`)).status, 409, 'no estaba archivada');
    const des = await post(`/api/tareas/${deB.id}/desarchivar`);
    assert.deepStrictEqual([des.status, 'archivada' in des.json().tarea], [200, false], des.texto);
    assert.strictEqual((await post('/api/tareas/nada/archivar')).status, 400, 'id inválido');
    assert.strictEqual((await post('/api/tareas/T_MAL/desarchivar')).status, 400, 'id inválido');
    assert.strictEqual((await post(`/api/tareas/${deB.id}/archivar`, {}, { origin: 'http://evil.example' })).status, 403, 'origen ajeno');
    assert.strictEqual((await post('/api/tareas/archivar', { ids: [deB.id] }, { origin: 'http://evil.example' })).status, 403, 'origen ajeno en la masiva');
    const sinSesion = await pedirWeb(puerto, { metodo: 'POST', ruta: `/api/tareas/${deB.id}/archivar`, headers: { 'content-type': 'application/json' }, cuerpo: '{}' });
    assert.strictEqual(sinSesion.status, 401, 'sin sesión');
    assert(!tareas.obtener(deB.id).archivada, 'nada de eso archivó');

    // El tablero trae la marca.
    const tablero = (await get('/api/tareas')).json().tareas;
    assert.strictEqual(tablero.find((t) => t.id === deA.id).archivada, tareas.obtener(deA.id).archivada);
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
    try { fs.rmSync(ruta, { force: true }); } catch {}
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 124 [FEAT-068]: archivar tarjetas cerradas');

// Test 125 [FEAT-068]: el cliente, de forma estática. Usa las rutas, filtra
// lotes y archivadas al armar «Archivar N», y el detalle se repinta al archivar.
{
  const js = codigoCliente();
  for (const ruta of ["'/api/tareas/archivar'", "${archivar ? 'archivar' : 'desarchivar'}"]) assert(js.includes(ruta), `el cliente usa ${ruta}`);
  assert(/\.filter\(\(x\) => !x\.lote && !x\.archivada\)/.test(js), '«Archivar N» sin lotes ni archivadas');
  // FEAT-136 — El detalle es un componente: el pie se redibuja solo con la tarea recargada.
  assert(js.includes("${t.archivada ? 'desarchivar' : 'archivar'}"), 'el detalle muestra archivar o desarchivar según la tarea');
  assert(/Boolean\(d\.tarea\.archivada\) !== Boolean\(t\.archivada\)/.test(js), 'y el aviso SSE lo detecta');
  assert(/if \(f\.archivadas \|\| f\.origen/.test(js), 'los lotes no aparecen en «ver archivadas»');
  assert(/archivadas: false,( agrupar: false,)? q: '' \}/.test(js) && /\{ \.\.\.FILTRO_VACIO/.test(js), 'limpiar apaga «ver archivadas»');
  assert(/case 'archivada': return 'Archivada';/.test(js) && /case 'desarchivada': return 'Desarchivada';/.test(js));
}
console.log('✔ Test 125 [FEAT-068]: el cliente archiva sin lotes ni archivadas y repinta el detalle');

// Test 126 [FEAT-069]: Proveedores. La versión instalada se cachea por mtime del
// binario (si el usuario actualiza en su terminal, /status y la consola lo ven);
// la API es solo GET y devuelve lo que da el proveedor; la vista recarga sin
// 404; y el cliente copia el comando, nunca lo ejecuta.
{
  const executor = await import('../executor.js');
  const { crearNucleoWeb } = await import('../web/nucleo.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const { crearServidorWeb, cookieWeb } = await import('../web/servidor.js');

  // Versión instalada.
  let consultas = 0;
  let marca = 1;
  const consultar = () => { consultas++; return `1.2.${consultas}`; };
  executor.olvidarVersionParaTests();
  const v = () => executor.getAgyVersion({ consultar, marca: () => marca });
  assert.strictEqual(v(), '1.2.1');
  assert.strictEqual(v(), '1.2.1', 'con el mismo binario, del caché');
  assert.strictEqual(consultas, 1);
  marca = 2;
  assert.strictEqual(v(), '1.2.2', 'otro mtime: se vuelve a consultar');
  marca = null;
  v(); v();
  assert.strictEqual(consultas, 4, 'sin marca (ruta relativa o stat fallido) no se cachea');
  executor.olvidarVersionParaTests();
  let fallos = 0;
  const falla = () => { fallos++; return null; };
  assert.match(executor.getAgyVersion({ consultar: falla, marca: () => 7 }), /^Desconocida/);
  executor.getAgyVersion({ consultar: falla, marca: () => 7 });
  assert.strictEqual(fallos, 2, 'un fallo no se cachea');
  executor.olvidarVersionParaTests();

  // Núcleo.
  const canal = crearCanalWeb();
  const lista = [{ id: 'antigravity', estado: 'disponible', instalada: '1.2.5', ultima: '1.2.6', comando: 'agy update' }];
  const conProveedores = crearNucleoWeb({ canal, bot: {}, almas: {}, workspaces: () => [], proveedores: { lista: async () => lista } });
  assert.deepStrictEqual(await conProveedores.proveedores(), { ok: true, proveedores: lista });
  const roto = crearNucleoWeb({ canal, bot: {}, almas: {}, workspaces: () => [], proveedores: { lista: async () => { throw new Error('boom'); } } });
  assert.strictEqual((await roto.proveedores()).codigo, 503);
  assert.deepStrictEqual(await crearNucleoWeb({ canal, bot: {}, almas: {}, workspaces: () => [] }).proveedores(), { codigo: 503, ok: false, error: 'Sin datos de proveedores.' }, 'sin proveedores inyectados');

  // Servidor: GET sí, POST no; /proveedores sirve la página.
  const token = 'p'.repeat(48);
  const servidor = crearServidorWeb({ nucleo: { canal, chatId: 'web', proveedores: () => conProveedores.proveedores() }, token, latidoMs: 60_000 });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  const cookie = { cookie: `${cookieWeb(puerto)}=${token}` };
  try {
    assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/proveedores' })).status, 401, 'sin sesión');
    const r = await pedirWeb(puerto, { ruta: '/api/proveedores', headers: cookie });
    assert.strictEqual(r.status, 200, r.texto);
    assert.deepStrictEqual(r.json().proveedores, lista);
    const post = await pedirWeb(puerto, { metodo: 'POST', ruta: '/api/proveedores', headers: { ...cookie, 'content-type': 'application/json' }, cuerpo: '{}' });
    assert(post.status === 404 || post.status === 405, `no hay POST: ${post.status}`);
    const actualizar = await pedirWeb(puerto, { metodo: 'POST', ruta: '/api/proveedores/antigravity/actualizar', headers: { ...cookie, 'content-type': 'application/json' }, cuerpo: '{}' });
    assert(actualizar.status === 404 || actualizar.status === 405, `ni ruta para actualizar: ${actualizar.status}`);
    const pagina = await pedirWeb(puerto, { ruta: '/proveedores', headers: cookie });
    assert.strictEqual(pagina.status, 200, 'recargar /proveedores no da 404');
    assert.match(pagina.texto, /<html/i);
  } finally {
    await new Promise((r) => servidor.close(r));
  }

  // Cliente, de forma estática.
  const js = codigoCliente();
  const html = fs.readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  assert(js.includes("api('/api/proveedores')"), 'el cliente pide la API');
  assert(!/api\([^)]*proveedores[^)]*,/.test(js), 'y nunca con cuerpo (sin POST)');
  // FEAT-136 — El botón es un componente (`BotonCopiar`) y la tarjeta le pasa el comando.
  assert(js.includes('navigator.clipboard.writeText(texto)') && js.includes('<${BotonCopiar} texto=${p.comando} />'), 'el comando se copia, no se ejecuta');
  assert(/href="\/proveedores" data-ruta data-vista="proveedores"/.test(html), 'el segmento está en el menú');
  // FEAT-162 — Orquestación también es un segmento.
  assert(js.includes("['tablero', 'tuberias', 'programado', 'orquestacion', 'proveedores', 'rendimiento', 'ajustes'].includes(estado.ruta.vista)"), 'proveedores y rendimiento se marcan activos');
}
console.log('✔ Test 126 [FEAT-069]: Proveedores informa y no actualiza');

// Test 127 [FEAT-075]: motor, modelo y esfuerzo por alma y por agente desde la
// consola. Solo roles de sujetos existentes (`alma:<clave>`, `cast:<nombre>`
// castable); validación estricta sin tocar el archivo; claude dispara sondas en
// segundo plano; y el estado "corriendo" sale del testigo.
{
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { crearNucleoWeb } = await import('../web/nucleo.js');
  const { crearServidorWeb, cookieWeb } = await import('../web/servidor.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const motoresMod = req('../../mcp-server/motores/index.js');
  const { catalogo } = req('../../mcp-server/motores/niveles.js');
  const { guardarRol, rutaConfigGlobal } = req('../../mcp-server/motores/config-motores.js');
  const { validarRoles } = req('../../mcp-server/motores/roles.js');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feat075-'));
  const ruta = rutaConfigGlobal(home);
  const disparos = [];
  let sondasCorriendo = false;
  let huellas = 0;
  const motores = {
    config: () => {
      if (!fs.existsSync(ruta)) return { motores: {}, avisos: [] };
      const r = validarRoles(JSON.parse(fs.readFileSync(ruta, 'utf8')).motores?.roles);
      return { motores: { roles: r.roles }, avisos: r.avisos };
    },
    elegir: (config, rol) => { const e = motoresMod.elegir(config, rol); return { motor: e.motor.id, modelo: e.modelo, esfuerzo: e.esfuerzo }; },
    catalogo,
    guardarRol: (rol, entrada) => guardarRol(rol, entrada, { homeDir: home }),
    sondasClaude: () => ({
      corriendo: () => sondasCorriendo,
      huellaActual: () => { huellas++; return { versionCli: '1' }; },
      leerSondas: async (perfil, { huella } = {}) => { assert(huella, 'la huella llega calculada'); return { ok: false, motivo: 'todavía no se verificó' }; },
      dispararSiHaceFalta: async () => { disparos.push('claude'); return []; }
    })
  };
  const canal = crearCanalWeb();
  const bot = {
    almasDisponibles: () => [{ clave: 'alya', voz: 'Alya' }, { clave: 'tm', voz: 'TM' }],
    agentesCasteables: () => [{ nombre: 'revisor', descripcion: null }]
  };
  const nucleo = crearNucleoWeb({ canal, bot, almas: {}, workspaces: () => [], motores });
  try {
    assert.strictEqual((await crearNucleoWeb({ canal, bot, almas: {}, workspaces: () => [] }).motores()).codigo, 503, 'sin motores inyectados');

    const inicial = await nucleo.motores();
    assert.deepStrictEqual(inicial.sujetos.map((s) => s.rol), ['alma:alya', 'alma:tm', 'consolidar:alya', 'consolidar:tm', 'cast:revisor']);
    assert(inicial.sujetos.every((s) => s.efectivo.motor === 'antigravity' && s.origen === null && s.propio === null), 'sin config: todo antigravity, por defecto');
    assert.strictEqual(inicial.sondas, null, 'sin claude no se leen sondas');
    assert(inicial.catalogo.some((c) => c.motor === 'claude'), 'trae el catálogo');

    for (const rol of ['alma', 'cast', 'consolidar', 'alma:nadie', 'cast:escritor', '', 'alma:TM', 'consolidar:nadie', 'consolidar:TM']) {
      assert.strictEqual((await nucleo.guardarMotor({ rol, motor: 'antigravity' })).codigo, 404, `rol no editable: ${rol}`);
    }
    const haiku = await nucleo.guardarMotor({ rol: 'alma:tm', motor: 'claude', modelo: 'claude-haiku-4-5', esfuerzo: 'high' });
    assert.strictEqual(haiku.codigo, 400);
    assert.match(haiku.error, /no admite esfuerzo/);
    assert(!fs.existsSync(ruta), 'un rechazo no crea el archivo');
    assert.strictEqual(disparos.length, 0, 'ni dispara sondas');

    const ok = await nucleo.guardarMotor({ rol: 'alma:tm', motor: 'claude', modelo: 'sonnet', esfuerzo: 'medium' });
    assert.strictEqual(ok.ok, true, ok.error);
    const tm = ok.sujetos.find((s) => s.rol === 'alma:tm');
    assert.deepStrictEqual(tm.efectivo, { motor: 'claude', modelo: 'sonnet', esfuerzo: 'medium' });
    assert.strictEqual(tm.origen, 'alma:tm');
    assert.strictEqual(ok.sujetos.find((s) => s.rol === 'alma:alya').efectivo.motor, 'antigravity', 'la otra alma no cambia');
    assert.deepStrictEqual(disparos, ['claude'], 'claude dispara sondas si hacen falta');
    assert.deepStrictEqual(ok.sondas, { claude: { estado: 'no-vigentes', motivo: 'todavía no se verificó' } });
    assert.strictEqual(huellas, 1, 'una huella por pedido, no una por perfil (where.exe es síncrono)');
    sondasCorriendo = true;
    assert.strictEqual((await nucleo.motores()).sondas.claude.estado, 'corriendo', 'el testigo manda');
    sondasCorriendo = false;

    const agente = await nucleo.guardarMotor({ rol: 'cast:revisor', motor: 'antigravity', modelo: 'gemini-3.1-pro', esfuerzo: 'high' });
    assert.strictEqual(agente.sujetos.find((s) => s.rol === 'cast:revisor').efectivo.modelo, 'gemini-3.1-pro');
    assert.strictEqual(disparos.length, 1, 'agy no dispara sondas de claude');

    // FEAT-079 — La consolidación del alma se edita aparte y no toca su charla.
    const cons = await nucleo.guardarMotor({ rol: 'consolidar:tm', motor: 'antigravity', modelo: 'gemini-3.8-flash', esfuerzo: 'low' });
    assert.strictEqual(cons.ok, true, cons.error);
    const consTm = cons.sujetos.find((s) => s.rol === 'consolidar:tm');
    assert.deepStrictEqual([consTm.tipo, consTm.general, consTm.origen, consTm.efectivo.modelo], ['consolidacion', 'consolidar', 'consolidar:tm', 'gemini-3.8-flash']);
    assert.strictEqual(cons.sujetos.find((s) => s.rol === 'alma:tm').efectivo.motor, 'claude', 'la charla del alma sigue en claude');
    assert.strictEqual(cons.sujetos.find((s) => s.rol === 'consolidar:alya').origen, null, 'la otra alma no cambia');

    const quitado = await nucleo.guardarMotor({ rol: 'alma:tm', quitar: true });
    assert.strictEqual(quitado.sujetos.find((s) => s.rol === 'alma:tm').origen, null, 'vuelve a heredar');
    assert.strictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')).motores.roles['cast:revisor'].esfuerzo, 'high', 'quitar uno no toca los demás');

    // Servidor: GET y POST cableados; el POST es mutación (origen).
    const token = 'm'.repeat(48);
    const servidor = crearServidorWeb({ nucleo: { canal, chatId: 'web', motores: () => nucleo.motores(), guardarMotor: (c) => nucleo.guardarMotor(c) }, token, latidoMs: 60_000 });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    const puerto = servidor.address().port;
    const cookie = { cookie: `${cookieWeb(puerto)}=${token}` };
    try {
      assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/motores' })).status, 401, 'sin sesión');
      const g = await pedirWeb(puerto, { ruta: '/api/motores', headers: cookie });
      assert.strictEqual(g.status, 200, g.texto);
      const cuerpo = JSON.stringify({ rol: 'alma:alya', motor: 'antigravity', modelo: 'gemini-3.8-flash', esfuerzo: 'low' });
      const ajeno = await pedirWeb(puerto, { metodo: 'POST', ruta: '/api/motores/rol', headers: { ...cookie, 'content-type': 'application/json', origin: 'http://evil.example' }, cuerpo });
      assert.strictEqual(ajeno.status, 403, 'otro origen no escribe');
      const p = await pedirWeb(puerto, { metodo: 'POST', ruta: '/api/motores/rol', headers: { ...cookie, 'content-type': 'application/json' }, cuerpo });
      assert.strictEqual(p.status, 200, p.texto);
      assert.strictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')).motores.roles['alma:alya'].esfuerzo, 'low');
      const mal = await pedirWeb(puerto, { metodo: 'POST', ruta: '/api/motores/rol', headers: { ...cookie, 'content-type': 'application/json' }, cuerpo: JSON.stringify({ rol: 'alma:alya', motor: 'antigravity', modelo: 'gemini-3.1-pro', esfuerzo: 'medium' }) });
      assert.strictEqual(mal.status, 400, 'la validación estricta llega como 400');
    } finally {
      await new Promise((r) => servidor.close(r));
    }

    // Cliente, de forma estática.
    const js = codigoCliente();
    assert(js.includes("api('/api/motores')") && js.includes("api('/api/motores/rol', cuerpo)"), 'el cliente usa las dos rutas');
    assert(js.includes('<${BloqueMotor} s=${s} />'), 'el panel pinta el motor del sujeto');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
console.log('✔ Test 127 [FEAT-075]: motor por alma y por agente desde la consola');

// Test 128 [FEAT-076]: panel lateral. Reglas del proyecto sobre un árbol con la
// FORMA de AppCargaHoras (canónicos por citas, uno por agente, citados, docs,
// un catálogo que no entra, una carpeta hermana con prefijo común, un
// junction que sale); contención con path.relative; ninguna ruta absoluta en
// las respuestas; HTML crudo escapado; índice sin los `#` de un bloque de
// código; redacción; topes. Más hilo, diario, actividad y el cliente.
{
  const reglas = await import('../web/reglas.js');
  const { crearNucleoWeb } = await import('../web/nucleo.js');
  const { crearServidorWeb, cookieWeb } = await import('../web/servidor.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const { createRequire } = await import('node:module');
  const almasHilos = createRequire(import.meta.url)('../../mcp-server/almas/hilos.js');
  const botMod = await import('../bot.js');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feat076-'));
  const app = path.join(base, 'app');
  const escribir = (rel, texto, raiz = app) => {
    const p = path.join(raiz, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, texto);
  };
  const sinAbsolutas = (obj, etiqueta) => {
    const json = JSON.stringify(obj);
    // La letra de unidad no puede venir precedida de otra letra: `https://` no es `s:/`.
    assert(!/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(json) && !json.includes('\\\\\\\\') && !json.includes(base.replace(/\\/g, '\\\\')) && !json.includes(base),
      `${etiqueta}: no lleva rutas absolutas`);
  };
  try {
    escribir('AGENTS.md', [
      '# Proyecto',
      'Ver [flujo](WORKFLOW.md) y [la guía](docs/guia/uso.md).',
      '[secreto](../app-secretos/x.md) · [fuera](../fuera/y.md) · [externo](https://example.com/x)',
      '```bash', '# 1) esto no es un título', '```',
      '<script>alert(1)</script>',
      'ADMIN_PASSWORD=hunter2secret',
      '## Sección [ancla](#proyecto)',
      '| a | b |', '|---|---|', '| 1 | 2 |'
    ].join('\n'));
    escribir('CLAUDE.md', '[a](AGENTS.md) [w](WORKFLOW.md) [b](BACKLOG.md) [g](GRANDE.md) [e](ENORME.md)');
    escribir('GEMINI.md', '[a](AGENTS.md) y [w](WORKFLOW.md)');
    escribir('.agents/AGENTS.md', 'Leé [la raíz](../AGENTS.md).');
    escribir('WORKFLOW.md', '# Flujo\n\nVolver a [AGENTS](AGENTS.md).');
    escribir('BACKLOG.md', '# Backlog');
    escribir('GRANDE.md', `# Grande\n\n${'x'.repeat(150 * 1024)}`);
    escribir('ENORME.md', `# Enorme\n\n${'x'.repeat(300 * 1024)}`);
    escribir('.claude/agents/persona.md', '# Una persona del catálogo');
    escribir('docs/guia/uso.md', '# Uso');
    escribir('docs/otra.md', '# Otra');
    escribir('docs/node_modules/x.md', '# no');
    escribir('docs/a/b/c/d/profundo.md', '# demasiado hondo');
    escribir('x.md', '# secreto', path.join(base, 'app-secretos'));
    escribir('y.md', '# fuera', path.join(base, 'fuera'));
    let hayJunction = true;
    try { fs.symlinkSync(path.join(base, 'fuera'), path.join(app, 'docs', 'fuera'), 'junction'); } catch { hayJunction = false; }

    reglas.olvidarCacheParaTests();
    const d = await reglas.descubrir(app);
    sinAbsolutas(d, 'descubrir');
    assert.strictEqual(d.raiz, 'app');
    const por = Object.fromEntries(d.archivos.map((a) => [a.ruta, a]));
    assert.deepStrictEqual(d.archivos.filter((a) => a.canonico).map((a) => a.ruta).sort(), ['AGENTS.md', 'WORKFLOW.md'], 'canónicos por citas, sin nombres cableados');
    assert.strictEqual(por['CLAUDE.md'].para, 'claude');
    assert.strictEqual(por['GEMINI.md'].para, 'antigravity');
    assert.strictEqual(por['.agents/AGENTS.md'].grupo, 'agente');
    assert.strictEqual(por['BACKLOG.md'].grupo, 'citado');
    assert(por['GRANDE.md'].grande && !por['GRANDE.md'].excede, '150 KB: grande');
    assert(por['ENORME.md'].excede, '300 KB: pasa el tope');
    assert(!d.archivos.some((a) => /persona|app-secretos|fuera|x\.md|y\.md/.test(a.ruta)), 'ni catálogo, ni hermana con prefijo común, ni afuera');
    const docs = d.docs.archivos.map((x) => x.ruta);
    assert.strictEqual(docs[0], 'docs/guia/uso.md', 'el citado desde las reglas va primero');
    assert(docs.includes('docs/otra.md'));
    assert(!docs.some((r) => /node_modules|profundo|fuera/.test(r)), `sin node_modules, sin pasar la profundidad, sin salir por el junction (${hayJunction ? 'con' : 'sin'} junction): ${docs.join(', ')}`);

    assert.strictEqual(await reglas.contenida(fs.realpathSync(app), path.join(base, 'app-secretos', 'x.md')), null, 'carpeta hermana con prefijo común: afuera');
    assert.strictEqual(await reglas.contenida(fs.realpathSync(app), app), null, 'la raíz misma no es un archivo contenido');
    assert.deepStrictEqual(reglas.enlacesMd('[a](A.md)\n```\n[b](B.md)\n```\n`[c](C.md)` [d](https://x/D.md) [e](/E.md)'), ['A.md'], 'enlaces fuera de código, relativos');

    const agents = await reglas.leer(app, por['AGENTS.md'].id);
    sinAbsolutas(agents, 'leer');
    assert(agents.ok && !agents.excede);
    assert(!/<script/i.test(agents.html) && agents.html.includes('&lt;script&gt;'), 'el HTML crudo sale escapado');
    assert(!agents.indice.some((t) => /esto no es/.test(t.texto)), 'un # dentro de un bloque de código no es título');
    assert.deepStrictEqual(agents.indice.map((t) => t.texto), ['Proyecto', 'Sección ancla']);
    assert(agents.html.includes(`data-md-id="${por['WORKFLOW.md'].id}"`), 'un .md de la lista navega dentro del visor');
    assert(!/app-secretos|fuera\/y/.test(agents.html.match(/href="[^"]*"/g)?.join(' ') || ''), 'un .md fuera de la lista queda como texto');
    assert(agents.html.includes('href="https://example.com/x"'), 'https sigue siendo enlace');
    assert(agents.html.includes('ADMIN_PASSWORD=[REDACTADO]') && !agents.html.includes('hunter2secret'), 'la credencial se redacta');
    assert(agents.html.includes('<table>'), 'tablas GFM');
    assert.strictEqual((await reglas.leer(app, por['GRANDE.md'].id)).aviso, 'grande');
    const enorme = await reglas.leer(app, por['ENORME.md'].id);
    assert(enorme.excede && enorme.html === '', 'lo que pasa el tope no se lee');
    assert.strictEqual((await reglas.leer(app, '000000000000')).codigo, 404);

    const masivo = path.join(base, 'masivo');
    for (let i = 0; i < reglas.TOPE_DOCS + 5; i++) escribir(`docs/n${String(i).padStart(3, '0')}.md`, '#', masivo);
    escribir('AGENTS.md', '# a', masivo);
    const dm = await reglas.descubrir(masivo);
    assert(dm.docs.cortado && dm.docs.archivos.length === reglas.TOPE_DOCS, 'tope de docs');

    // raizDeAgente: solo si el cwd del agente es un workspace conocido.
    const home = path.join(base, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity-agents-state.json'), JSON.stringify({ agents: { revisor: { ultimo_cwd: app }, suelto: { ultimo_cwd: masivo } } }));
    const conocidos = () => [{ id: 'w1', path: process.platform === 'win32' ? app.toUpperCase() : app }];
    assert.strictEqual(path.resolve(botMod.raizDeAgente('revisor', { homeDir: home, conocidos })).toLowerCase(), path.resolve(app).toLowerCase());
    assert.strictEqual(botMod.raizDeAgente('suelto', { homeDir: home, conocidos }), null, 'un cwd que no es workspace conocido no tiene reglas');
    assert.strictEqual(botMod.raizDeAgente('nadie', { homeDir: home, conocidos }), null);

    // motorDelTurno: lo que guarda el registro de tareas.
    assert.deepStrictEqual(botMod.motorDelTurno({ motor: 'claude', modelo: 'sonnet', modeloReal: 'claude-sonnet-5', esfuerzo: 'medium' }), { motor: 'claude', modelo: 'claude-sonnet-5', esfuerzo: 'medium' });
    assert.deepStrictEqual(botMod.motorDelTurno({ motor: 'antigravity', model: 'gemini-3.8-flash', effort: 'high' }), { motor: 'antigravity', modelo: 'gemini-3.8-flash', esfuerzo: 'high' });
    assert.deepStrictEqual(botMod.motorDelTurno({ ok: false }), {}, 'un rechazo previo no inventa motor');
    const registro = await import('../tareas.js');
    const t = registro.crear({ carril: 'alma', origen: 'web', sujeto: { tipo: 'alma', clave: 'tm', voz: 'TM' }, pedido: 'hola' });
    registro.actualizar(t.id, { estado: 'ok', motor: 'claude', modelo: 'claude-sonnet-5', esfuerzo: 'medium' });
    const guardada = registro.resumen(registro.obtener(t.id));
    assert.deepStrictEqual([guardada.motor, guardada.modelo, guardada.esfuerzo], ['claude', 'claude-sonnet-5', 'medium'], 'la tarea guarda motor, modelo y esfuerzo');

    // Núcleo: hilo, diario y reglas.
    const ahora = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const almas = {
      hilos: {
        VENTANA_MS: almasHilos.VENTANA_MS,
        hilosDe: almasHilos.hilosDe,
        leerEstado: () => ({ almas: { tm: {
          turnos: 9, conversation_id: 'agy-hilo-viejo', ultimo_turno: iso(ahora - 7 * 3600e3),
          hilos_por_motor: { claude: { conversation_id: 'abcdef1234567890', ultimo_turno: iso(ahora - 3600e3) } }
        } } })
      },
      diario: {
        ultimas: () => [
          { ts: iso(ahora - 5000), superficie: 'telegram', resumen: 'un turno de charla' },
          { ts: iso(ahora - 4000), tipo: 'consolidacion', motivo: 'sin cambios' },
          { ts: iso(ahora - 3000), tipo: 'memoria:agregar', id: 'm4', resumen: 'le gusta el té' },
          { ts: iso(ahora - 2000), tipo: 'saneado', resumen: '1 etiqueta' },
          { ts: iso(ahora - 1000), tipo: 'otra-cosa' }
        ]
      }
    };
    const bot = {
      almasDisponibles: () => [{ clave: 'tm', voz: 'TM' }],
      agentesCasteables: () => [{ nombre: 'revisor' }, { nombre: 'suelto' }]
    };
    const motores = { config: () => ({}), elegir: () => ({ motor: 'claude', modelo: 'sonnet', esfuerzo: null }), catalogo: () => [] };
    const nucleo = crearNucleoWeb({
      canal: crearCanalWeb(), bot, almas, workspaces: () => [], motores,
      nombreAgenteValido: (n) => /^[a-z][a-z0-9-]*$/.test(n),
      reglas: { raizDe: (n) => (n === 'revisor' ? app : null), descubrir: reglas.descubrir, leer: reglas.leer }
    });
    const h = nucleo.hiloAlma('tm', ahora);
    assert.strictEqual(h.efectivo, 'claude');
    assert.strictEqual(h.turnos, 9);
    const hc = h.hilos.find((x) => x.motor === 'claude');
    assert(hc.venceEnMs > 4.9 * 3600e3 && hc.venceEnMs <= 5 * 3600e3, `claude vence en ~5 h: ${hc.venceEnMs}`);
    assert.strictEqual(hc.hilo, 'abcdef12', 'el id del hilo va recortado');
    assert.strictEqual(h.hilos.find((x) => x.motor === 'antigravity').venceEnMs, null, 'el de 7 h ya venció');
    assert.strictEqual(nucleo.hiloAlma('nadie').codigo, 404);
    const di = nucleo.diarioAlma('tm');
    assert.deepStrictEqual(di.eventos.map((e) => e.tipo), ['saneado', 'memoria:agregar', 'consolidacion'], 'solo lo de fondo, lo más nuevo primero');
    const lista = await nucleo.reglasAgente('revisor');
    assert(lista.ok && lista.archivos.length >= 5);
    sinAbsolutas(lista, 'GET reglas');
    assert.strictEqual((await nucleo.reglasAgente('suelto')).codigo, 404, 'sin proyecto conocido');
    assert.strictEqual((await nucleo.reglasAgente('nadie')).codigo, 404, 'no castable');
    assert.strictEqual((await nucleo.reglaAgente('revisor', '../AGENTS')).codigo, 400, 'el id no es una ruta');
    assert.strictEqual((await crearNucleoWeb({ canal: crearCanalWeb(), bot, almas, workspaces: () => [], nombreAgenteValido: () => true }).reglasAgente('revisor')).codigo, 503);

    // Servidor: las cuatro rutas GET cableadas.
    const token = 'r'.repeat(48);
    const servidor = crearServidorWeb({ nucleo: { canal: crearCanalWeb(), chatId: 'web',
      hiloAlma: (c) => nucleo.hiloAlma(c), diarioAlma: (c) => nucleo.diarioAlma(c),
      reglasAgente: (n) => nucleo.reglasAgente(n), reglaAgente: (n, i) => nucleo.reglaAgente(n, i) }, token, latidoMs: 60_000 });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    const puerto = servidor.address().port;
    const cookie = { cookie: `${cookieWeb(puerto)}=${token}` };
    try {
      for (const ruta of ['/api/almas/tm/hilo', '/api/almas/tm/diario', '/api/agentes/revisor/reglas', `/api/agentes/revisor/reglas/${por['AGENTS.md'].id}`]) {
        const r = await pedirWeb(puerto, { ruta, headers: cookie });
        assert.strictEqual(r.status, 200, `${ruta}: ${r.texto}`);
        sinAbsolutas(r.json(), ruta);
      }
      assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/agentes/revisor/reglas' })).status, 401, 'sin sesión');
    } finally {
      await new Promise((r) => servidor.close(r));
    }

    // Cliente, de forma estática.
    const js = codigoCliente();
    // FEAT-136 F4 — El panel es un componente (ui/panel.js).
    const panelUi = fs.readFileSync(new URL('../web/public/ui/panel.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert(panelUi.includes('<details class=${`plegable ${clase}`}') && panelUi.includes('persistente(k, porDefecto'), 'plegables con estado recordado');
    assert(/export function abiertoDe[\s\S]{0,500}catch/.test(panelUi), 'leer el estado viejo tolera no tener almacenamiento');
    assert(!/\.innerHTML\s*=/.test(js), 'nunca innerHTML');
    assert(js.includes('PERMITIDAS_MD') && js.includes("new Set(['B', 'STRONG', 'I', 'EM', 'U', 'INS', 'S', 'STRIKE', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE', 'BR', 'SPAN', 'TG-SPOILER'])"), 'la lista del visor es aparte; la de resultados no cambia');
    const hiloNuevo = js.indexOf('>Hilo nuevo</button>');
    assert(hiloNuevo > js.indexOf('export function BloqueHilo') && js.indexOf('>Hilo nuevo<', hiloNuevo + 1) === -1, '"Hilo nuevo" vive solo en el bloque Hilo');
    assert(!/api\(`\/api\/agentes\/[^`]*\/reglas\/\$\{encodeURIComponent\((?!actual\))/.test(js), 'el cliente pide reglas por id, nunca por ruta');

    // BE-042 — El panel se refresca al terminar un turno, en su lugar.
    const cuerpoDe = (firma) => {
      const i = js.indexOf(firma);
      assert(i >= 0, `falta ${firma}`);
      return js.slice(i, js.indexOf('\n  }\n', i));
    };
    const panelJs = cuerpoDe('function pintarPanel()');
    assert(/estado\.panel = null;[\s\S]*const s = sujetoActual\(\)/.test(panelJs), 'pintarPanel olvida el refresco anterior antes de pintar');
    assert(panelJs.includes('refrescar: refrescarPanel') && panelJs.includes('key: clave'), 'un panel por sujeto, con su refresco');
    // Lo que depende de un turno vuelve a pedirse cuando sube `refresco`; el motor no.
    const seccion = (firma) => { const i = panelUi.indexOf(firma); assert(i >= 0, `falta ${firma}`); return panelUi.slice(i, panelUi.indexOf('\n}\n', i)); };
    for (const f of ['export function BloqueHilo', 'export function SeccionesMemoria', 'export function SeccionDiario', 'export function BloqueProyecto', 'export function SeccionContexto', 'export function SeccionCuarentena', 'export function SeccionCriterio']) {
      assert(seccion(f).includes('const v = refresco.value;'), `${f} se refresca tras un turno`);
    }
    assert(!seccion('export function BloqueMotor').includes('refresco.value'), 'el motor no cambia con un turno');
    // Una caja de Proyecto quitada vuelve sin parpadear «cargando…»: la respuesta anterior queda hasta la nueva.
    assert(/if \(!hay\) return null;/.test(seccion('export function BloqueProyecto')), 'sin reglas, el bloque Proyecto no se pinta');
    const programar = cuerpoDe('function programarRefrescoPanel');
    assert(programar.includes('p.clave === claveDe(s)') && programar.includes('clearTimeout(refrescoPanelPendiente)'), 'refresco con debounce y solo para el sujeto del panel');
    const tareaJs = cuerpoDe('function alCambiarTarea(t)');
    const iRefresco = tareaJs.indexOf('programarRefrescoPanel(clave)');
    assert(iRefresco >= 0 && iRefresco < tareaJs.indexOf('if (!clave || !estado.tareas.has(clave)) return;'), 'un turno terminado refresca el panel sin depender de las tareas cargadas');
    assert(/t\.estado !== 'en_cola' && t\.estado !== 'en_curso'\) programarRefrescoPanel/.test(tareaJs), 'solo turnos terminados');
    assert(cuerpoDe('function conectar()').includes("if (antes === 'caida') recargarTodo();") && cuerpoDe('function recargarTodo()').includes('programarRefrescoPanel(null)'), 'también tras reconectar el SSE');
  } finally {
    reglas.olvidarCacheParaTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
}
console.log('✔ Test 128 [FEAT-076]: panel lateral (reglas, hilo, diario, actividad)');

// Test 129 [FEAT-077]: el cast recibe los archivos de reglas de su proyecto
// (ningún motor los carga solo: sonda F). Salen del mismo `descubrir` del
// visor; si el descubrimiento falla, el cast sale igual, sin puntero.
{
  const botMod = await import('../bot.js');
  const proy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reglas-cast-')));
  fs.writeFileSync(path.join(proy, 'AGENTS.md'), '# Reglas\n\nVer [flujo](WORKFLOW.md).\n');
  fs.writeFileSync(path.join(proy, 'CLAUDE.md'), '# Claude\n\nVer [flujo](WORKFLOW.md).\n');
  fs.writeFileSync(path.join(proy, 'WORKFLOW.md'), '# Flujo\n');
  const vacio = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reglas-vacio-')));
  const ctxCast = { chat: { id: Number(USUARIO_OK) }, reply: async () => ({ message_id: 1 }) };
  const opcionesDelCast = [];
  const esperarCasts = async (n) => {
    const limite = Date.now() + 3000;
    while (opcionesDelCast.length < n || botMod.carrilOcupado('cast')) {
      if (Date.now() > limite) throw new Error(`Test 129: esperaba ${n} casts`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const castearFalso = async ({ opciones }) => { opcionesDelCast.push(opciones); return { ok: true, respuesta: 'listo', memoria: {} }; };
  try {
    botMod.resetRuntimeState();
    botMod.usarEjecutoresDePrueba({ castear: castearFalso });
    await botMod.dispatchCast(ctxCast, { agent: 'lector', prompt: 'revisá las convenciones', cwd: proy, workspaceName: 'proy' });
    await esperarCasts(1);
    const reglas = opcionesDelCast[0].reglas;
    assert(Array.isArray(reglas), `el cast recibe la lista: ${JSON.stringify(reglas)}`);
    assert.deepStrictEqual(reglas.map((r) => r.ruta).sort(), ['AGENTS.md', 'CLAUDE.md', 'WORKFLOW.md'], 'entradas y el citado');
    assert(reglas.find((r) => r.ruta === 'WORKFLOW.md').canonico, 'el citado por dos es el canónico');
    assert.strictEqual(reglas.find((r) => r.ruta === 'CLAUDE.md').para, 'claude');
    assert(reglas.every((r) => Object.keys(r).sort().join() === 'canonico,para,ruta'), 'solo ruta, canonico y para: nada del disco');
    assert(!JSON.stringify(reglas).includes(proy), 'sin rutas absolutas');

    await botMod.dispatchCast(ctxCast, { agent: 'lector', prompt: 'otra', cwd: vacio, workspaceName: 'vacio' });
    await esperarCasts(2);
    assert.deepStrictEqual(opcionesDelCast[1].reglas, [], 'sin archivos de reglas, lista vacía');

    botMod.usarEjecutoresDePrueba({ castear: castearFalso, reglasDelCast: async () => { throw new Error('disco roto'); } });
    await botMod.dispatchCast(ctxCast, { agent: 'lector', prompt: 'igual', cwd: proy, workspaceName: 'proy' });
    await esperarCasts(3);
    assert.deepStrictEqual(opcionesDelCast[2].reglas, [], 'si el descubrimiento falla, el cast sale igual y sin puntero');

    const js = codigoCliente();
    assert(!js.includes('depende del motor') && js.includes('Ningún motor los carga solo'), 'el pie del visor dice lo medido');
  } finally {
    botMod.resetRuntimeState();
    fs.rmSync(proy, { recursive: true, force: true });
    fs.rmSync(vacio, { recursive: true, force: true });
  }
}
console.log('✔ Test 129 [FEAT-077]: el cast recibe los archivos de reglas de su proyecto');

// Test 130 [FEAT-079]: criterio guardado del agente, de solo lectura. Valida
// nombre y castabilidad; un fallo del servicio no reenvía su motivo; tipos
// mapeados, tope de entradas y de texto, secretos redactados, sin hash ni
// sesión. Más la ruta, el bloque Consolidación y el plegable del cliente.
{
  const { crearNucleoWeb, TOPE_CRITERIO, TOPE_TEXTO_CRITERIO } = await import('../web/nucleo.js');
  const { crearServidorWeb, cookieWeb } = await import('../web/servidor.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const canal = crearCanalWeb();
  const bot = { almasDisponibles: () => [], agentesCasteables: () => [{ nombre: 'revisor', descripcion: null }] };
  const nombreAgenteValido = (n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(n));
  let respuesta = null;
  const pedidos = [];
  const criterio = async (nombre) => { pedidos.push(nombre); if (respuesta instanceof Error) throw respuesta; return respuesta; };
  const nucleo = crearNucleoWeb({ canal, bot, almas: {}, workspaces: () => [], nombreAgenteValido, criterio });

  assert.strictEqual((await nucleo.criterioAgente('../x')).codigo, 400, 'nombre inválido');
  assert.strictEqual((await nucleo.criterioAgente('escritor')).codigo, 404, 'no castable');
  assert.strictEqual(pedidos.length, 0, 'sin consultar el servicio');
  assert.strictEqual((await crearNucleoWeb({ canal, bot, almas: {}, workspaces: () => [], nombreAgenteValido }).criterioAgente('revisor')).codigo, 503, 'sin el servicio inyectado');

  respuesta = { ok: false, motivo: 'HTTP 500 en http://interno:8000/mcp con token abc' };
  const caido = await nucleo.criterioAgente('revisor');
  assert.strictEqual(caido.codigo, 503);
  assert.strictEqual(caido.error, 'El servicio de memoria no respondió.', 'mensaje fijo');
  respuesta = new Error('explotó');
  assert.strictEqual((await nucleo.criterioAgente('revisor')).codigo, 503, 'una excepción también es 503');

  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const entradas = Array.from({ length: TOPE_CRITERIO + 5 }, (_, i) => ({
    contenido: i === 0 ? `usar pnpm; token ${token}` : i === 1 ? 'x'.repeat(TOPE_TEXTO_CRITERIO + 100) : `regla ${i}`,
    tipo: ['decision', 'user-correction', 'observation'][i % 3],
    sessionId: 'sesion-secreta',
    usos: i === 0 ? 3 : 0,
    creado: '2026-09-24T01:00:00Z',
    hash: 'hash-secreto'
  }));
  respuesta = { ok: true, entradas, truncado: false };
  const r = await nucleo.criterioAgente('revisor');
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.total, TOPE_CRITERIO + 5, 'total real');
  assert.strictEqual(r.entradas.length, TOPE_CRITERIO, 'tope de entradas');
  assert.deepStrictEqual(r.entradas.slice(0, 3).map((e) => e.tipo), ['decision', 'correccion', 'otro'], 'tipos mapeados');
  assert(!r.entradas[0].texto.includes(token) && r.entradas[0].texto.includes('[REDACTADO]') && r.entradas[0].texto.includes('usar pnpm'), `redactado: ${r.entradas[0].texto}`);
  assert.strictEqual(r.entradas[1].texto.length, TOPE_TEXTO_CRITERIO + 1, 'texto recortado con …');
  assert(r.entradas[1].texto.endsWith('…'));
  assert.strictEqual(r.entradas[0].usos, 3);
  const plano = JSON.stringify(r);
  assert(!plano.includes('hash-secreto') && !plano.includes('sesion-secreta'), 'ni hash ni sesión');
  assert(r.entradas.every((e) => Object.keys(e).sort().join() === 'creado,texto,tipo,usos'), 'solo los campos de la vista');

  // Servidor: la ruta GET, detrás de la sesión.
  const tokenWeb = 'c'.repeat(48);
  const servidor = crearServidorWeb({ nucleo: { canal, chatId: 'web', criterioAgente: (n) => nucleo.criterioAgente(n) }, token: tokenWeb, latidoMs: 60_000 });
  await new Promise((res) => servidor.listen(0, '127.0.0.1', res));
  const puerto = servidor.address().port;
  try {
    assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/agentes/revisor/criterio' })).status, 401, 'sin sesión');
    const g = await pedirWeb(puerto, { ruta: '/api/agentes/revisor/criterio', headers: { cookie: `${cookieWeb(puerto)}=${tokenWeb}` } });
    assert.strictEqual(g.status, 200, g.texto);
    assert.strictEqual(JSON.parse(g.texto).entradas.length, TOPE_CRITERIO);
  } finally {
    await new Promise((res) => servidor.close(res));
  }

  // Cliente, de forma estática.
  const js = codigoCliente();
  assert(js.includes('<${BloqueMotor} s=${s} rol=${`consolidar:${s.clave}`} id="consolidacion" />'), 'el alma pinta su bloque Consolidación');
  assert(js.includes('<${Plegable} s=${s} id="criterio" titulo="Criterio guardado"'), 'el agente tiene el plegable');
  assert(js.includes("const abierto = abiertoDe(s.tipo, 'criterio').value;") && js.includes('if (!abierto || cargadoEn.current === v) return undefined;'), 'solo se consulta abierto');
  assert(js.includes("filas.push(['Guardado en el último cast'") && !js.includes("filas.push(['Criterio guardado'"), 'la fila del contexto dice lo que cuenta');
  assert(js.includes("if (suj.tipo === 'alma' && motor !== suj.efectivo.motor)"), 'la consolidación no avisa de conversación nueva');
}
console.log('✔ Test 130 [FEAT-079]: criterio guardado del agente y consolidación por alma en la consola');

// Test 131 [FEAT-082]: el panel y la lateral como cajón (tablet, teléfono y
// foco). Solo cliente: se valida la fuente, como el resto de la consola.
{
  const html = fs.readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const js = codigoCliente().replace(/\r\n/g, '\n');
  const css = fs.readFileSync(new URL('../web/public/app.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const cuerpoDe = (firma) => {
    const i = js.indexOf(firma);
    assert(i >= 0, `falta ${firma}`);
    return js.slice(i, js.indexOf('\n  }\n', i));
  };

  // Estructura: la tira es su propio elemento, con velo y ☰.
  assert(/<nav class="tira" id="tira"/.test(html), 'la tira vive fuera de #panel');
  assert(/<div class="velo-cajon" id="velo-cajon" hidden>/.test(html), 'velo del cajón, oculto de entrada');
  assert(/id="abrir-lateral"[^>]*aria-controls="lateral"/.test(html), 'el ☰ controla la lateral');
  assert(html.includes('<span class="texto-paleta">'), 'el texto de la paleta se puede ocultar en el teléfono');

  // pintarPanel: sin tira adentro, con registro de secciones y cabecera de cajón.
  const panelJs = cuerpoDe('function pintarPanel()');
  assert(!panelJs.includes("class: 'tira'"), 'pintarPanel ya no crea la tira');
  assert(panelJs.includes('secciones: SECCIONES[s.tipo].map('), 'alma y agente registran sus secciones');
  assert(js.includes('<${CabeceraCajon} titulo=') && panelJs.includes('pintarTira()'), 'cabecera de cajón y tira repintada');
  assert(panelJs.includes('get nodo() { return panel.querySelector(`[data-seccion="${x.id}"]`); }'), 'cada sección se busca cada vez: Proyecto puede no estar');

  // Cajones: inert detrás, la tira queda viva; cerrar lo deshace.
  assert(js.includes("const INERTES = { panel: ['#barra', '#lateral', '#centro'], lateral: ['#barra', '#centro', '#panel'] };"), 'qué queda inert en cada cajón');
  assert(!/INERTES = \{[^}]*#tira/.test(js), 'la tira nunca queda inert');
  const abrir = cuerpoDe('function abrirCajon(');
  assert(abrir.includes('$(sel).inert = true') && abrir.includes("$('#velo-cajon').hidden = false"), 'abrir marca inert y muestra el velo');
  assert(/if \(plegable\) sec\.nodo\.open = true;[\s\S]*scrollIntoView/.test(abrir), 'abrir una sección la despliega y la muestra');
  const cerrar = cuerpoDe('function cerrarCajon(');
  assert(cerrar.includes('$(sel).inert = false') && cerrar.includes("$('#velo-cajon').hidden = true") && cerrar.includes('c.origen.focus()'), 'cerrar deshace todo y devuelve el foco');

  // Quién cierra: Esc antes que el detalle y el foco, la ruta, y salir del foco.
  // El manejador global (el visor de reglas tiene su propio Escape antes).
  const teclado = js.slice(js.indexOf('if (menuCancelar.value)'), js.indexOf("if (ev.key === 'f' || ev.key === 'F') alternarFoco();"));
  const iCajon = teclado.indexOf('if (estado.cajon) { cerrarCajon(); return; }');
  assert(iCajon > teclado.indexOf('menuCancelar.value = false') && teclado.indexOf('menuCancelar.value = false') >= 0 &&iCajon < teclado.indexOf('cerrarDetalle()') && iCajon < teclado.indexOf('alternarFoco(false)'), 'Esc: menú, cajón, detalle, foco');
  const iP = teclado.indexOf("ev.key === 'p'");
  assert(iP > teclado.indexOf('if (enCampo ||') && teclado.slice(iP).includes('alternarCajonPanel()'), 'P respeta la guarda de campos');
  assert(/estado\.ruta = leerRuta\(\);\s*\/\/[^\n]*\n\s*if \(estado\.cajon\) cerrarCajon\(\{ devolverFoco: false \}\);/.test(cuerpoDe('function alCambiarRuta()')), 'cambiar de ruta cierra el cajón');
  const foco = cuerpoDe('function alternarFoco(');
  assert(foco.includes('if (mqTelefono.matches) estado.foco = false;'), 'sin foco en el teléfono');
  assert(/estado\.cajon\?\.tipo === 'panel' && panelEnLinea\(\)\) \{\s*cerrarCajon\(\{ devolverFoco: false \}\)/.test(foco), 'salir del foco con el panel en su columna cierra el cajón');
  assert(js.includes("mq1100.addEventListener('change'") && js.includes("mqTelefono.addEventListener('change'"), 'un cambio de ancho cierra el cajón que sobra');
  // FEAT-136 F4 — La barra marca sus segmentos; las vistas del cajón las marca el componente `Lateral`.
  assert(js.includes("'#segmentos [data-vista]'") && js.includes("class=${vista === activa ? 'activo' : undefined}"), 'las vistas del cajón marcan la activa');

  // CSS: nada nuevo aplica por encima de 1100 px fuera de foco.
  assert(css.includes('.app.panel-abierto .panel {') && css.includes('.app.lateral-abierta .lateral {'), 'reglas de los cajones');
  assert(!css.includes('.app.foco .panel > :not(.tira)'), 'la regla de la tira vieja no existe');
  assert(/\.cabecera-acciones \.boton-panel, \.boton-lateral, \.lupa-paleta \{ display: none; \}/.test(css), 'botones nuevos ocultos por defecto (ganan a .boton.fantasma)');
  assert(/@media \(prefers-reduced-motion: reduce\) \{\s*\.app\.panel-abierto \.panel, \.app\.lateral-abierta \.lateral \{ animation: none; \}/.test(css), 'sin animación con movimiento reducido');
  const media1100 = css.slice(css.indexOf('@media (max-width: 1100px) {\n  .app {'), css.indexOf('\n}\n', css.indexOf('@media (max-width: 1100px) {\n  .app {')));
  assert(media1100.includes('.app .panel { display: none; }') && media1100.includes('.app:not(.foco) .cabecera-acciones .boton-panel { display: inline-flex; }'), 'hasta 1100 px aparece el botón Panel');
}
console.log('✔ Test 131 [FEAT-082]: panel y lateral como cajón en tablet, teléfono y foco');

// Test 132 [FEAT-080]: las programaciones del sujeto, en su panel. Solo
// cliente: reusa GET /api/programaciones y pausar/seguir.
{
  const js = codigoCliente().replace(/\r\n/g, '\n');
  const cuerpoDe = (firma) => {
    const i = js.indexOf(firma);
    assert(i >= 0, `falta ${firma}`);
    return js.slice(i, js.indexOf('\n  }\n', i));
  };

  // El plegable, en los dos tipos, registrado para la tira del foco.
  // FEAT-136 F4 — El panel es un componente: la sección está en los dos tipos y registrada en SECCIONES.
  assert.strictEqual((js.match(/<\$\{SeccionProgramado\} s=\$\{s\} \/>/g) || []).length, 2, 'alma y agente tienen el plegable');
  assert.strictEqual((js.match(/\{ id: 'programado', titulo: 'Programado' \}/g) || []).length, 2, 'registrado en secciones');
  assert(js.includes('<${Plegable} s=${s} id="programado" titulo="Programado" resumen=${html`<${ResumenProgramado} s=${s} />`}><${ProgramadoSujeto} s=${s} /><//>'), 'resumen y cuerpo son componentes');
  assert(/programado: 'M/.test(js), 'ícono de la tira');

  // FEAT-136 F4 — Programado es un componente (ui/vista-programado.js): sección del panel y vista.
  const prog = fs.readFileSync(new URL('../web/public/ui/vista-programado.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const desde = (firma, hasta) => prog.slice(prog.indexOf(firma), hasta ? prog.indexOf(hasta, prog.indexOf(firma)) : undefined);
  const sujeto = desde('export function ProgramadoSujeto(');
  assert(prog.includes("p.sujeto?.tipo === s.tipo && (s.tipo === 'alma' ? p.sujeto.clave === s.clave : p.sujeto.nombre === s.nombre)"), 'filtra por tipo y clave o nombre');
  assert(!/innerHTML|dangerouslySetInnerHTML/.test(prog), 'sin innerHTML');
  assert(sujeto.includes('`/programado?nueva=${encodeURIComponent(clave)}`'), 'Programar para lleva el sujeto codificado');
  assert(sujeto.includes('`/programado?abrir=${enc(p.id)}`'), 'Ver corridas lleva el id');
  assert((prog.match(/<\$\{BotonAlternar\} p=\$\{p\} \/>/g) || []).length === 2, 'pausar/seguir compartido');
  assert(!sujeto.includes('/borrar'), 'borrar no está en el panel');
  // El resumen entra en una línea: la fecha corta ('hoy 18:28'), y el título del plegable no se recorta.
  assert(prog.includes('próxima ${cuandoCorto(proxima.proxima)}'), 'el resumen usa la fecha corta');
  const css = fs.readFileSync(new URL('../web/public/app.css', import.meta.url), 'utf8');
  assert(css.includes('grid-template-columns: 12px auto minmax(0, 1fr);') && /\.resumen-plegable \{[^}]*text-overflow: ellipsis/.test(css), 'el que se recorta es el resumen, no el título');

  // Refresco: el resumen y el cuerpo leen la señal (se redibujan solos); el SSE avisa solo a esa sección.
  assert(/export function ResumenProgramado\(\{ s \}\) \{\n  void programaciones\.value;/.test(prog), 'el resumen se redibuja con la señal');
  assert(js.includes('const alCambiarProgramacion = alCambiarProgramacionUi;') && js.includes('const alBorrarProgramacion = alBorrarProgramacionUi;'), 'el SSE solo actualiza la señal: no refresca el resto del panel');

  // /programado: los parámetros se guardan antes de limpiar la URL y se aplican cuando hay sujetos.
  const vista = desde('export function VistaProgramado(', '// ── La sección del panel');
  const iGuarda = vista.indexOf('pendiente.value = {');
  assert(iGuarda >= 0 && iGuarda < vista.indexOf("history.replaceState(null, '', '/programado')"), 'guarda antes de limpiar la URL');
  assert(vista.includes('if (!p || (!almas.length && !agentes.length)) return;'), 'aplica cuando hay sujetos');
  assert(!cuerpoDe('async function refrescarGlobal()').includes('aplicarProgramadoPendiente'), 'no se aplica antes del repintado del arranque');
  assert(/pendiente\.value = null;[\s\S]*ID_PROGRAMACION_WEB\.test\(p\.abrir\)/.test(vista), 'una sola vez, y valida el id');
  assert(vista.includes("setAbrirCon(existe ? p.nueva : '')") && desde('function Formulario(', 'export function VistaProgramado(').includes('if (abrirCon === null || abierto) return;'), 'no pisa un formulario abierto ni elige un sujeto inexistente');
  assert(prog.includes('const ID_PROGRAMACION_WEB = /^p_[a-z0-9]{1,40}$/;'), 'misma forma que ID_PROGRAMACION del servidor');
  assert(desde('function FilaProgramacion(', 'function Formulario(').includes("scrollIntoView({ block: 'center' })"), 'la fila pedida se muestra cuando está pintada');
  assert(prog.includes("onClick=${() => { setAsignacion({ sujeto: '', workspaceId: '' }); setAbierto(true); }}"), 'el botón de siempre abre sin elegir');
}
console.log('✔ Test 132 [FEAT-080]: Programado del sujeto en el panel');

// Test 133 [FEAT-081, FEAT-171]: buscar en lo que el alma supo, desde el panel.
// FEAT-171 — Busca en el archivo local con la misma regla que la charla: sin
// servicio. El núcleo valida, recorta a 10 y marca lo que sigue también en la
// memoria caliente. Más la ruta y el plegable, que no pide nada al abrirse.
{
  const { crearNucleoWeb, TOPE_PROFUNDA } = await import('../web/nucleo.js');
  const { crearServidorWeb, cookieWeb } = await import('../web/servidor.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const { createRequire } = await import('node:module');
  const archivoReal = createRequire(import.meta.url)('../../mcp-server/almas/archivo.js');
  const canal = crearCanalWeb();
  const bot = { almasDisponibles: () => [{ clave: 'alya', voz: 'Alya' }], agentesCasteables: () => [] };
  const recuerdos = {
    leer: (_ruta, prefijo) => ({ prefijo }),
    entradas: (m) => (m.prefijo === 'm' ? [{ id: 'm1', texto: 'uno' }] : [{ id: 'u2', texto: 'dos' }]),
    usado: () => 3,
    TOPE_MEMORIA: 100,
    TOPE_USUARIO: 100
  };
  const rutas = { rutasDe: () => ({ memoria: 'memoria.md' }), rutaUsuario: () => 'usuario.md' };
  let respuesta = null;
  const pedidos = [];
  const archivo = {
    ID_VALIDO: archivoReal.ID_VALIDO,
    tokensSignificativos: archivoReal.tokensSignificativos,
    leer: (_clave, o = {}) => (o.compartido ? [{ id: 'tu1', fecha: '2026-10-18', texto: 'compartido', tema: null }] : [{ id: 'm9', fecha: '2026-09-21', texto: 'archivado', tema: 'juegos' }]),
    buscar: (clave, q, opciones) => {
      pedidos.push({ clave, q, opciones });
      if (respuesta instanceof Error) throw respuesta;
      return respuesta;
    }
  };
  const nucleo = crearNucleoWeb({ canal, bot, almas: { recuerdos, rutas, archivo }, workspaces: () => [] });

  assert.strictEqual((await nucleo.buscarProfunda('nadie', 'qué toma de mañana')).codigo, 404, 'alma inexistente');
  assert.strictEqual((await nucleo.buscarProfunda('alya', 'x'.repeat(501))).codigo, 400, 'consulta larga');
  const vacia = await nucleo.buscarProfunda('alya', 'hola, ¿cómo estás?');
  assert.strictEqual(vacia.codigo, 422, 'sin palabras que digan de qué se habla');
  assert.strictEqual(vacia.error, 'Escribí de qué querés buscar.');
  assert.strictEqual(pedidos.length, 0, 'sin leer el archivo');
  const sinModulo = crearNucleoWeb({ canal, bot, almas: { recuerdos, rutas }, workspaces: () => [] });
  assert.strictEqual((await sinModulo.buscarProfunda('alya', 'qué toma de mañana')).codigo, 503, 'sin el módulo inyectado');
  assert.strictEqual(sinModulo.memoria('alya').profunda, false, 'sin módulo, apagada');
  assert.deepStrictEqual(sinModulo.memoria('alya').archivo, [], 'y sin archivo');

  respuesta = new Error('explotó en C:\interno');
  const excepcion = await nucleo.buscarProfunda('alya', 'qué toma de mañana');
  assert.strictEqual(excepcion.codigo, 503, 'una excepción es 503');
  assert(!JSON.stringify(excepcion).includes('interno'), 'sin el motivo');

  const resultados = [
    { id: 'm1', texto: 'sigue en su memoria', fecha: '2026-09-18' },
    { id: 'U2', texto: 'sigue en lo que saben', fecha: '2026-09-18' },
    { id: 'm9', texto: 'se archivó', fecha: null },
    { id: 'tmabc', texto: 'rechazado por tope', fecha: '2026-10-01' },
    { id: 'raro!', texto: 'id con otra forma' },
    ...Array.from({ length: 7 }, (_, i) => ({ id: null, texto: `sin id ${i}` }))
  ];
  respuesta = { resultados, omitidas: [] };
  const r = await nucleo.buscarProfunda('alya', 'qué toma de mañana');
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(pedidos.at(-1).opciones.limite, TOPE_PROFUNDA, 'pide el tope');
  assert.strictEqual(r.resultados.length, TOPE_PROFUNDA, 'recorta a 10 aunque vengan 12');
  assert.deepStrictEqual(r.resultados.slice(0, 5).map((e) => [e.id, e.enArchivo]),
    [['m1', true], ['u2', true], ['m9', false], ['tmabc', false], [null, false]], 'enArchivo (también en la memoria caliente) e ids');
  assert.strictEqual(r.resultados[2].creado, null, 'sin fecha, null');
  assert.strictEqual(r.resultados[3].creado, '2026-10-01', 'la fecha del archivo');
  assert(r.resultados.every((e) => Object.keys(e).sort().join() === 'creado,enArchivo,id,texto'), 'solo los campos de la vista');

  const m = nucleo.memoria('alya');
  assert.strictEqual(m.profunda, true, 'memoria() dice que hay buscador');
  assert.deepStrictEqual(m.archivo.map((e) => e.id), ['m9', 'tu1'], 'y trae lo archivado, del alma y compartido');
  assert.strictEqual(m.archivo[0].tema, 'juegos');

  // Servidor: la ruta GET, detrás de la sesión, con la consulta decodificada.
  const tokenWeb = 'd'.repeat(48);
  const llegadas = [];
  const servidor = crearServidorWeb({
    nucleo: { canal, chatId: 'web', buscarProfunda: async (clave, q) => { llegadas.push([clave, q]); return { ok: true, resultados: [] }; } },
    token: tokenWeb,
    latidoMs: 60_000
  });
  await new Promise((res) => servidor.listen(0, '127.0.0.1', res));
  const puerto = servidor.address().port;
  try {
    const ruta = `/api/almas/alya/profunda?q=${encodeURIComponent('qué toma de mañana')}`;
    assert.strictEqual((await pedirWeb(puerto, { ruta })).status, 401, 'sin sesión');
    const g = await pedirWeb(puerto, { ruta, headers: { cookie: `${cookieWeb(puerto)}=${tokenWeb}` } });
    assert.strictEqual(g.status, 200, g.texto);
    assert.deepStrictEqual(llegadas, [['alya', 'qué toma de mañana']]);
  } finally {
    await new Promise((res) => servidor.close(res));
  }

  // Cliente, de forma estática.
  const js = codigoCliente().replace(/\r\n/g, '\n');
  const cuerpoDe = (firma) => {
    const i = js.indexOf(firma);
    assert(i >= 0, `falta ${firma}`);
    return js.slice(i, js.indexOf('\n  }\n', i));
  };
  // FEAT-136 F4 — El panel es un componente (ui/panel.js).
  const desdeUi = (firma) => { const i = js.indexOf(firma); assert(i >= 0, `falta ${firma}`); return js.slice(i, js.indexOf('\n}\n', i)); };
  assert(js.includes('<${Plegable} s=${s} id="profunda" titulo="Archivo" clase=${tono(s.clave)}'), 'el alma tiene el plegable');
  assert(js.includes("{ id: 'profunda', titulo: 'Archivo' }"), 'registrado en secciones');
  assert(desdeUi('export function SeccionesMemoria(').includes('const activa = !r ? null : r.error ? r.error : Boolean(r.profunda);'), 'la memoria le dice si está encendida');
  assert(/profunda: 'M/.test(js), 'ícono de la tira');
  const prof = desdeUi('export function SeccionProfunda(');
  assert(!/onToggle|refresco/.test(prof), 'abrir el plegable no pide nada');
  assert.strictEqual((prof.match(/api\(|olvidar\(s,/g) || []).length, 2, 'solo buscar y olvidar llaman a la API');
  assert(prof.includes('profunda?q=${encodeURIComponent(q)}'), 'la consulta va codificada');
  assert(prof.includes('<${BotonDosPasos} texto="olvidar"'), 'olvidar pide confirmación');
  assert(prof.includes('if (busqueda.enVuelo) return;'), 'una búsqueda por vez');
  assert(!prof.includes('innerHTML'), 'sin innerHTML');
}
console.log('✔ Test 133 [FEAT-081, FEAT-171]: el archivo del alma en el panel');

// Test 134 [FEAT-083]: pulido tras la prueba en vivo de v0.47.0. Solo
// cliente: barra de escritorio, fechas de otro día, proyecto oculto para un
// alma, orden de la memoria profunda, charla en el teléfono y resumen vacío.
{
  const js = codigoCliente().replace(/\r\n/g, '\n');
  const css = fs.readFileSync(new URL('../web/public/app.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const cuerpoDe = (firma) => {
    const i = js.indexOf(firma);
    assert(i >= 0, `falta ${firma}`);
    return js.slice(i, js.indexOf('\n  }\n', i));
  };
  const bloqueMedia = (cabecera) => {
    const i = css.indexOf(cabecera);
    assert(i >= 0, `falta ${cabecera}`);
    return css.slice(i, css.indexOf('\n}\n', i));
  };

  // A. La barra: libres agrupados, el PID se oculta por ancho (nunca "sin conexión").
  // FEAT-136 F4 — La barra son componentes (ui/barra.js).
  const barra = js.slice(js.indexOf('export function EstadoDaemon('), js.indexOf('export const menuCancelar'));
  assert(barra.includes("const pid = vivo ? ' estado-pid' : '';"), 'estado-pid solo con el daemon vivo');
  assert(barra.includes('`estado-texto${pid}`') && barra.includes('`separador estado-texto${pid}`'), 'el PID y su separador llevan la clase');
  assert(barra.includes('title=${`Libres: ${libres.join(\', \')}`}') && barra.includes('`${libres.length} libres`'), 'los libres van en un chip, con sus nombres en el title');
  assert(barra.includes('ocupados.map((t) => html`<span class="chip activo">${t}</span>`)'), 'los ocupados siguen uno por uno');
  assert(css.includes('.barra .estado-daemon { flex: 0 1 auto; min-width: 13px; }'), 'el punto del estado siempre se ve');
  assert(/\.barra-derecha \{[^}]*flex-shrink: 0;/.test(css) && css.includes('.barra .segmentos { flex-shrink: 0; }'), 'lo que cede es el estado');
  assert(css.includes('@media (max-width: 1440px) { .estado-daemon .estado-pid { display: none; } }'), 'sin PID por debajo de 1440');
  assert(css.includes('@media (max-width: 1280px) { .marca .tenue, .boton-paleta .tecla { display: none; } .barra { gap: 12px; } }'), 'por debajo de 1280: sin "consola local" ni "Ctrl K", y gap de 12');

  // B. Turnos de otro día.
  // FEAT-136 F2 — Las filas de la charla son el componente `Turno` (ui/vista-charla.js).
  const charlaJs = fs.readFileSync(new URL('../web/public/ui/vista-charla.js', import.meta.url), 'utf8');
  const turnoJs = charlaJs.slice(charlaJs.indexOf('function Turno('), charlaJs.indexOf('\nexport function Conversacion('));
  assert(turnoJs.length > 100 && !/(?<!\w)hora\(/.test(turnoJs) && (turnoJs.match(/fechaCorta\(/g) || []).length === 3, 'la charla dice qué día');
  assert(js.slice(js.indexOf('export function SeccionActividad(')).includes('${momentoCorto(t.iniciada || t.creada)}'), 'Actividad reciente dice qué día');
  assert(/\.turno \{ display: grid; grid-template-columns: 76px /.test(css), 'la columna entra "ayer 14:14"');
  // momentoCorto, evaluada desde la fuente con un `ahora` fijo.
  // FEAT-136 — Vive en ui/nucleo.js (módulo): se prueba la función real.
  const { momentoCorto } = await import('../web/public/ui/nucleo.js');
  const ahora = new Date(2026, 8, 24, 15, 0);
  assert.strictEqual(momentoCorto(new Date(2026, 8, 24, 9, 5).toISOString(), ahora), '09:05', 'hoy: la hora');
  assert.strictEqual(momentoCorto(new Date(2026, 8, 23, 14, 14).toISOString(), ahora), 'ayer 14:14', 'ayer');
  assert.strictEqual(momentoCorto(new Date(2026, 8, 19, 8, 0).toISOString(), ahora), '19/9 08:00', 'antes: día/mes');
  assert.strictEqual(momentoCorto(new Date(2026, 8, 30, 8, 0).toISOString(), new Date(2026, 9, 1, 0, 30)), 'ayer 08:00', 'ayer aunque cambie el mes (30/9 → 1/10)');
  assert.strictEqual(momentoCorto(null, ahora), '');

  // C. El proyecto se oculta para un alma, en los cuatro llamadores, sin :has.
  // FEAT-136 — Es el componente `Asignacion` (ui/vista-tablero.js): la etiqueta del proyecto solo se dibuja para un agente.
  const sel = js.slice(js.indexOf('export function Asignacion('), js.indexOf('function NuevaTarjeta('));
  assert(sel.includes("const esAgente = String(valor || '').startsWith('agente:');") && sel.includes('${esAgente ? html`<${EtiquetaCampo}'), 'oculta la etiqueta que lo envuelve');
  assert(!css.includes(':has('), 'sin :has');
  assert(css.includes('[hidden] { display: none !important; }'), 'el [hidden] global que lo hace funcionar');

  // D. Archivo (antes, memoria profunda): primero lo que solo está ahí.
  // FEAT-136 F4 — La sección es un componente (ui/panel.js).
  const prof = js.slice(js.indexOf('export function SeccionProfunda('), js.indexOf('\n}\n', js.indexOf('export function SeccionProfunda(')));
  assert(prof.includes('.sort((a, b) => Number(Boolean(a.enArchivo)) - Number(Boolean(b.enArchivo)))') && prof.includes('setBusqueda({ resultados: orden,'), 'ordena antes de pintar');
  assert(prof.includes("r.enArchivo ? 'recuerdo en-archivo' : 'recuerdo'") && css.includes('.recuerdo.en-archivo .recuerdo-texto'), 'lo que está en su memoria, atenuado');
  assert(prof.includes('solo en el archivo` : \'\'}'), 'el resumen cuenta lo que solo está en el archivo');

  // E. Teléfono.
  const telefono = bloqueMedia('@media (max-width: 800px) {\n  .app, .app.foco');
  assert(telefono.includes('.fila-suya { max-width: 100%; }') && telefono.includes('.fila-mia { max-width: 85%; }'), 'la charla usa el ancho');
  assert(css.includes('@media (hover: none) and (pointer: coarse) { .tecla { display: none; } }'), 'sin atajos de teclado en pantallas táctiles');

  // F. Programado sin programaciones.
  // FEAT-136 F4 — El resumen vive en ui/vista-programado.js (`resumenProgramado`).
  assert(js.includes("pausada${propias.length === 1 ? '' : 's'}` : 'nada';"), 'el resumen vacío dice nada');
}
console.log('✔ Test 134 [FEAT-083]: pulido de la consola tras la prueba en vivo de v0.47.0');

// Test 135 [FEAT-084]: pulido tras la prueba en vivo de v0.49.0. Cancelar
// neutro sin charla ni cast, mínimo de palabras de la profunda, ids con title,
// criterio Decisión/Motivo (más el tipo de las correcciones) y la paleta con
// foco pendiente.
{
  const js = codigoCliente().replace(/\r\n/g, '\n');
  const css = fs.readFileSync(new URL('../web/public/app.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const html = fs.readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const cuerpoDe = (firma) => {
    const i = js.indexOf(firma);
    assert(i >= 0, `falta ${firma}`);
    return js.slice(i, js.indexOf('\n  }\n', i));
  };

  // 1. Frenar… (FEAT-160 F5b; antes «Cancelar…»): rojo solo con alma o cast; ícono de 44 px en el teléfono.
  // FEAT-136 F4 — El botón y su menú son el componente `MenuCancelar` (ui/barra.js).
  const barra = js.slice(js.indexOf('export function MenuCancelar('), js.indexOf('export function SelectorNodo('));
  assert(barra.includes("(c.carril === 'alma' || c.carril === 'cast') && (c.enCurso || c.enCola)"), 'solo cuentan charla y cast');
  assert(barra.includes("class=${`boton${cancelable ? ' peligro' : ''}`} id=\"cancelar\""), 'alterna peligro');
  assert(!/cancelar\.disabled|disabled=\$\{[^}]*\} id="cancelar"/.test(js), 'el botón no se deshabilita');
  const botonCancelar = barra.slice(barra.indexOf('id="cancelar"') - 60, barra.indexOf('</button>', barra.indexOf('id="cancelar"')));
  assert(!/^\s*<button type="button" class="boton peligro"/.test(botonCancelar), 'nace neutro: el rojo depende de los carriles');
  assert(botonCancelar.includes('aria-label="Frenar…"'), 'nombre accesible fijo');
  assert(/<svg class="icono-cancelar"[^>]*aria-hidden="true"><rect /.test(botonCancelar), 'ícono con rect y aria-hidden');
  assert(botonCancelar.includes('<span class="texto-cancelar">Frenar…</span>'), 'texto en su span');
  assert(css.includes('.icono-cancelar { display: none; }'), 'sin ícono en escritorio');
  const telefono = css.slice(css.indexOf('@media (max-width: 800px) {\n  .app, .app.foco'));
  const reglaIcono = telefono.slice(0, telefono.indexOf('\n}\n'));
  assert(/#cancelar \{[^}]*min-width: 44px; min-height: 44px;/.test(reglaIcono), '44 × 44 en el teléfono');
  // FEAT-160 F5b — Siempre el ícono (también con algo en curso: entonces en rojo).
  assert(reglaIcono.includes('#cancelar.peligro { color: var(--peligro); }') && reglaIcono.includes('#cancelar .texto-cancelar { display: none; }') && reglaIcono.includes('#cancelar .icono-cancelar { display: inline; }'), 'solo el ícono, rojo con peligro');

  // 3. Mínimo de palabras del buscador, del lado del cliente. FEAT-171: una basta; el
  // servidor decide si dice de qué se habla (`archivo.tokensSignificativos`).
  // FEAT-136 F4 — El panel es un componente (ui/panel.js).
  const desdeUi = (firma) => { const i = js.indexOf(firma); assert(i >= 0, `falta ${firma}`); return js.slice(i, js.indexOf('\n}\n', i)); };
  const prof = desdeUi('export function SeccionProfunda(');
  assert(prof.includes('Busca por palabras: plurales y conjugaciones cuentan; las de relleno, no.'), 'la ayuda dice cómo busca');
  assert(js.includes('export const contarPalabras = (texto) => texto.trim().split(/\\s+/).filter(Boolean).length;'), 'cuenta como el servidor, sin vacíos');
  // El botón se deriva del estado en cada dibujo: en vuelo o con menos del mínimo, deshabilitado.
  assert(prof.includes('const corta = contarPalabras(consulta.value) < MIN_PALABRAS_PROFUNDA;') && prof.includes('disabled=${busqueda.enVuelo || corta}'), 'el estado del botón en un solo lugar');
  const minCliente = Number(/export const MIN_PALABRAS_PROFUNDA = (\d+);/.exec(js)?.[1]);
  assert.strictEqual(minCliente, 1, 'una palabra alcanza para intentar');

  // 4. Ids con su explicación, en las tres listas.
  assert(js.includes("const TITULO_ID_RECUERDO = 'Id del recuerdo: en Telegram, /alma olvidar <id>';"), 'el title');
  assert.strictEqual((js.match(/<span class="recuerdo-id" title=\$\{TITULO_ID_RECUERDO\}>\$\{[er]\.id \|\| '—'\}<\/span>/g) || []).length, 2, 'las dos construcciones llevan title');

  // 5. Criterio: partirCriterio, evaluada desde la fuente.
  const iPartir = js.indexOf('const DECISION_CRITERIO =');
  const fuentePartir = js.slice(iPartir, js.indexOf('\n}\n', js.indexOf('function partirCriterio(', iPartir)) + 3).replace('export function', 'function');
  const partirCriterio = new Function(`${fuentePartir}\nreturn partirCriterio;`)();
  assert.deepStrictEqual(partirCriterio('Decision: usar pnpm — Reason: el lockfile es de pnpm'), { principal: 'usar pnpm', secundario: 'Motivo: el lockfile es de pnpm', rotulo: 'decision' }, 'raya larga');
  assert.deepStrictEqual(partirCriterio('Decision: usar pnpm – Reason: x'), { principal: 'usar pnpm', secundario: 'Motivo: x', rotulo: 'decision' }, 'raya media');
  assert.deepStrictEqual(partirCriterio('Decision: usar pnpm - Reason: x'), { principal: 'usar pnpm', secundario: 'Motivo: x', rotulo: 'decision' }, 'guion');
  assert.deepStrictEqual(partirCriterio('Decision: usar pnpm'), { principal: 'usar pnpm', secundario: null, rotulo: 'decision' }, 'sin Reason');
  assert.deepStrictEqual(partirCriterio('Decision: usar pnpm — Reason: '), { principal: 'usar pnpm', secundario: null, rotulo: 'decision' }, 'Reason vacío');
  assert.deepStrictEqual(partirCriterio('Decision: línea uno\nlínea dos — Reason: por\nesto'), { principal: 'línea uno\nlínea dos', secundario: 'Motivo: por\nesto', rotulo: 'decision' }, 'con saltos de línea');
  assert.deepStrictEqual(partirCriterio('User corrected: npm → pnpm'), { principal: 'Creías: npm', secundario: 'Lo correcto: pnpm', rotulo: 'correccion' }, 'corrección con →');
  assert.deepStrictEqual(partirCriterio('User corrected: npm -> pnpm'), { principal: 'Creías: npm', secundario: 'Lo correcto: pnpm', rotulo: 'correccion' }, 'corrección con ->');
  assert.strictEqual(partirCriterio('User corrected: npm'), null, 'corrección sin flecha');
  assert.strictEqual(partirCriterio('regla cualquiera'), null, 'texto cualquiera');
  const criterioJs = desdeUi('export function SeccionCriterio(');
  assert(criterioJs.includes('const partes = partirCriterio(e.texto);') && criterioJs.includes(': html`<p class="criterio-texto">${e.texto}</p>`'), 'usa partirCriterio y conserva el camino crudo');

  // 5. Tipo de las correcciones en el núcleo.
  const { crearNucleoWeb } = await import('../web/nucleo.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const bot = { almasDisponibles: () => [], agentesCasteables: () => [{ nombre: 'revisor', descripcion: null }] };
  const criterio = async () => ({ ok: true, truncado: false, entradas: [
    { tipo: 'observation', contenido: 'User corrected: a → b' },
    { tipo: 'decision', contenido: 'Decision: x — Reason: y' },
    { tipo: 'raro', contenido: 'una nota' }
  ] });
  const nucleo = crearNucleoWeb({ canal: crearCanalWeb(), bot, almas: {}, workspaces: () => [], nombreAgenteValido: () => true, criterio });
  const r = await nucleo.criterioAgente('revisor');
  assert.deepStrictEqual(r.entradas.map((e) => e.tipo), ['correccion', 'decision', 'otro'], 'la corrección se deduce del prefijo');

  // 6. Paleta: profunda y criterio con foco pendiente, sin setTimeout.
  const paletaJs = cuerpoDe('function comandosDePaleta()');
  assert(paletaJs.includes("texto: `Buscar en el archivo de ${a.voz}`") && paletaJs.includes("irASeccion(ruta, 'profunda', 'input[type=search]')"), 'entrada por alma');
  assert(paletaJs.includes("texto: `Ver el criterio guardado de ${g.nombre}`") && paletaJs.includes("irASeccion(ruta, 'criterio')"), 'entrada por agente');
  assert(cuerpoDe('function irASeccion(').includes('estado.seccionPendiente = { vista: ruta, id, enfocar };') && !cuerpoDe('function irASeccion(').includes('setTimeout'), 'deja el pendiente, sin setTimeout');
  // La profunda consume lo pendiente cuando sabe si está encendida (también con error).
  assert(prof.includes("cfg.tomarSeccionPendiente?.('profunda')") && prof.includes('encendida === true ? { enfocar: p.enfocar } : {}'), 'la profunda consume; apagada o con error, sin foco');
  assert(prof.includes('if (activa === null) return;') && prof.includes('}, [activa]);'), 'también lo limpia con error');
  const panelJs = js.slice(js.indexOf('function pintarPanel()'), js.indexOf('function pintarTira()'));
  assert(panelJs.includes("if (!estado.panel.secciones.some((x) => x.id === pendiente.id)) estado.seccionPendiente = null;"), 'pintarPanel descarta una sección que no hay');
  assert(panelJs.includes('abrirSeccion(pendiente.id, { enfocar: pendiente.enfocar });'), 'pintarPanel consume');
  const ruta = cuerpoDe('function alCambiarRuta()');
  assert(ruta.includes("} else if (estado.seccionPendiente) {") && ruta.includes("estado.panel?.profundaCargada?.()") && ruta.includes('abrirSeccion(p.id, { enfocar: p.enfocar });'), 'mismoSujeto consume');
  assert(ruta.includes('if (estado.seccionPendiente && !esVistaActual(estado.seccionPendiente.vista)) estado.seccionPendiente = null;'), 'otra navegación lo descarta');
  const cajon = cuerpoDe('function abrirCajon(');
  assert(cajon.startsWith('function abrirCajon(tipo, seccion = null, origen = document.activeElement, { enfocar = null } = {})'), 'enfocar es el cuarto parámetro');
  assert(cajon.includes('const pedido = enfocar ? sec.nodo.querySelector(enfocar) : null;'), 'abrirCajon enfoca lo pedido');
  assert(cuerpoDe('function abrirSeccion(').includes("abrirCajon('panel', id, document.activeElement, { enfocar })"), 'abrirSeccion conserva origen');
  // En vivo, a 375 px, el campo enfocado quedaba fuera de la pantalla: la
  // profunda se abría con "cargando…" encima y el cajón no tenía por dónde bajar.
  // Con componentes, la profunda se entera en el mismo dibujo que llena las dos memorias: su efecto corre después.
  const memoriaJs = desdeUi('export function SeccionesMemoria(');
  assert(memoriaJs.indexOf('<${SeccionProfunda} s=${s} activa=${activa}') > memoriaJs.indexOf('id="usuario"'), 'la profunda va después de las dos memorias');
  // Y lo de arriba (hilo, actividad) también crece después: la sección se sostiene a la vista.
  assert(cajon.includes('sostenerALaVista(sec.nodo);') && cuerpoDe('function abrirSeccion(').includes('sostenerALaVista(sec.nodo);'), 'abrirCajon y abrirSeccion sostienen la sección');
  const sostener = cuerpoDe('function sostenerALaVista(');
  assert(sostener.includes("['wheel', 'touchstart', 'pointerdown']") && sostener.includes('!nodo.contains(document.activeElement)') && sostener.includes('performance.now() > fin'), 'se suelta con el usuario, sin foco o por tiempo');
  assert(sostener.includes('requestAnimationFrame(paso)') && !sostener.includes('setTimeout'), 'por cuadro, sin setTimeout');
  // En vivo, el criterio a 375 px quedaba en el borde: su contenido carga debajo al desplegarse.
  assert(sostener.includes('caja.scrollHeight !== alto'), 'también vuelve a bajar cuando crece el panel');
}
console.log('✔ Test 135 [FEAT-084]: pulido de la consola tras la prueba en vivo de v0.49.0');

// Test 136 [FEAT-085]: cuenta de Claude por rol en la consola. La consola la
// muestra y la CONSERVA al cambiar el modelo (no la edita: se asigna con
// set_config); las sondas se leen y disparan por cuenta; el pie la nombra.
{
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { crearNucleoWeb } = await import('../web/nucleo.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const { etiquetaDeMotor } = await import('../bot.js');
  const motoresMod = req('../../mcp-server/motores/index.js');
  const { catalogo } = req('../../mcp-server/motores/niveles.js');
  const { guardarRol, rutaConfigGlobal } = req('../../mcp-server/motores/config-motores.js');
  const { validarRoles } = req('../../mcp-server/motores/roles.js');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feat085-'));
  const ruta = rutaConfigGlobal(home);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, JSON.stringify({ motores: {
    cuentas: { trabajo: { configDir: path.join(home, '.claude-work') } },
    roles: { 'cast:revisor': { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' } }
  } }));
  const leidas = [];
  const disparadas = [];
  const motores = {
    config: () => {
      const r = validarRoles(JSON.parse(fs.readFileSync(ruta, 'utf8')).motores?.roles);
      return { motores: { roles: r.roles }, avisos: r.avisos };
    },
    elegir: (config, rol) => { const e = motoresMod.elegir(config, rol); return { motor: e.motor.id, modelo: e.modelo, esfuerzo: e.esfuerzo, cuenta: e.cuenta }; },
    catalogo,
    guardarRol: (rol, entrada) => guardarRol(rol, entrada, { homeDir: home }),
    sondasClaude: (clave) => ({
      corriendo: () => false,
      huellaActual: () => ({ versionCli: '1' }),
      leerSondas: async () => { leidas.push(clave); return { ok: clave === 'claude@trabajo', motivo: 'no' }; },
      dispararSiHaceFalta: async () => { disparadas.push(clave); return []; }
    })
  };
  const bot = { almasDisponibles: () => [], agentesCasteables: () => [{ nombre: 'revisor', descripcion: null }] };
  const nucleo = crearNucleoWeb({ canal: crearCanalWeb(), bot, almas: {}, workspaces: () => [], motores });
  try {
    const vista = await nucleo.motores();
    const revisor = vista.sujetos.find((s) => s.rol === 'cast:revisor');
    assert.strictEqual(revisor.efectivo.cuenta, 'trabajo', 'la vista trae la cuenta');
    assert.deepStrictEqual(Object.keys(vista.sondas), ['claude@trabajo'], 'las sondas son las de la cuenta');
    assert(leidas.every((c) => c === 'claude@trabajo'), 'y se leen con su clave');

    // La consola manda { motor, modelo, esfuerzo }: la cuenta no puede caerse.
    const cambio = await nucleo.guardarMotor({ rol: 'cast:revisor', motor: 'claude', modelo: 'opus', esfuerzo: null });
    assert.strictEqual(cambio.ok, true, cambio.error);
    const guardado = JSON.parse(fs.readFileSync(ruta, 'utf8')).motores;
    assert.deepStrictEqual(guardado.roles['cast:revisor'], { motor: 'claude', modelo: 'opus', esfuerzo: null, cuenta: 'trabajo' }, 'cambiar el modelo conserva la cuenta');
    assert.deepStrictEqual(guardado.cuentas, { trabajo: { configDir: path.join(home, '.claude-work') } }, 'y las cuentas quedan como estaban');
    assert.deepStrictEqual(disparadas, ['claude@trabajo'], 'dispara las sondas de la cuenta, no las de claude');

    assert.strictEqual(etiquetaDeMotor({ motor: 'claude', modeloReal: 'claude-sonnet-5', cuenta: 'trabajo' }), 'claude-sonnet-5 · claude · cuenta trabajo');
    assert.strictEqual(etiquetaDeMotor({ motor: 'claude', modeloReal: 'claude-sonnet-5' }), 'claude-sonnet-5 · claude', 'sin cuenta, el pie de siempre');
    // FEAT-173 — Un turno de Go que cayó a agy se avisa; Go normal lleva su pie; agy normal, nada.
    assert.strictEqual(etiquetaDeMotor({ motor: 'antigravity', fallback: { motivo: 'opencode-go' } }), 'agy (fallback: OpenCode Go no pudo)');
    assert.strictEqual(etiquetaDeMotor({ motor: 'opencode-go', modeloReal: 'deepseek-v4.1-flash' }), 'deepseek-v4.1-flash · opencode-go');
    assert.strictEqual(etiquetaDeMotor({ motor: 'antigravity' }), null);

    const js = codigoCliente();
    assert(js.includes('r.sondas[claveSondas]'), 'el cliente busca las sondas por la clave de cuenta');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
console.log('✔ Test 136 [FEAT-085]: cuenta de Claude por rol en la consola');

// Test 137 [FEAT-086]: la consola dice a qué modelo resolvió el alias de cada
// rol (lo observado en turnos), solo si corresponde a lo configurado hoy, y
// marca un cambio reciente; los IDs completos se ofrecen después de los alias.
{
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { crearNucleoWeb, CAMBIO_RECIENTE_MS } = await import('../web/nucleo.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const motoresMod = req('../../mcp-server/motores/index.js');
  const { catalogo } = req('../../mcp-server/motores/niveles.js');

  const AHORA = Date.parse('2026-09-25T12:00:00Z');
  let tabla = {
    'cast:revisor': { motor: 'claude', modelo: 'opus' },
    'cast:fijo': { motor: 'claude', modelo: 'claude-opus-5' },
    'cast:viejo': { motor: 'claude', modelo: 'sonnet' }
  };
  const resoluciones = {
    'cast:revisor': { alias: 'opus', cuenta: null, modelo: 'claude-opus-5-5', visto_en: '2026-09-25T11:00:00Z', anterior: { modelo: 'claude-opus-5', hasta: '2026-09-24T10:00:00Z' }, cambio_en: '2026-09-24T12:00:00Z' },
    // De otra configuración (el rol pedía haiku): no se muestra.
    'cast:viejo': { alias: 'haiku', cuenta: null, modelo: 'claude-haiku-4-5', visto_en: '2026-09-20T11:00:00Z', anterior: null, cambio_en: null }
  };
  const motores = {
    config: () => ({ motores: { roles: tabla }, avisos: [] }),
    elegir: (config, rol) => { const e = motoresMod.elegir(config, rol); return { motor: e.motor.id, modelo: e.modelo, esfuerzo: e.esfuerzo, cuenta: e.cuenta }; },
    catalogo,
    guardarRol: () => ({ ok: true, roles: tabla }),
    sondasClaude: () => ({ corriendo: () => false, huellaActual: () => ({}), leerSondas: async () => ({ ok: true }), dispararSiHaceFalta: async () => [] }),
    resoluciones: () => resoluciones
  };
  const bot = { almasDisponibles: () => [], agentesCasteables: () => ['revisor', 'fijo', 'viejo'].map((nombre) => ({ nombre, descripcion: null })) };
  const nucleo = crearNucleoWeb({ canal: crearCanalWeb(), bot, almas: {}, workspaces: () => [], motores, fanout: { ahora: () => AHORA } });
  const suj = async (rol) => (await nucleo.motores()).sujetos.find((s) => s.rol === rol);

  const revisor = await suj('cast:revisor');
  assert.deepStrictEqual([revisor.resolucion.modelo, revisor.resolucion.anterior, revisor.resolucion.cambioReciente], ['claude-opus-5-5', 'claude-opus-5', true]);
  assert.strictEqual((await suj('cast:viejo')).resolucion, null, 'una resolución de otro alias no se muestra');
  assert.strictEqual((await suj('cast:fijo')).resolucion, null, 'un ID sin turnos todavía no trae resolución');

  const pasado = crearNucleoWeb({ canal: crearCanalWeb(), bot, almas: {}, workspaces: () => [], motores, fanout: { ahora: () => AHORA + CAMBIO_RECIENTE_MS } });
  const tarde = (await pasado.motores()).sujetos.find((s) => s.rol === 'cast:revisor');
  assert.strictEqual(tarde.resolucion.cambioReciente, false, 'pasada una semana, el cambio deja de marcarse');

  tabla = { ...tabla, 'cast:revisor': { motor: 'claude', modelo: 'opus', cuenta: 'trabajo' } };
  assert.strictEqual((await suj('cast:revisor')).resolucion, null, 'con otra cuenta, la resolución vieja no vale');

  const sinResoluciones = crearNucleoWeb({ canal: crearCanalWeb(), bot, almas: {}, workspaces: () => [], motores: { ...motores, resoluciones: undefined } });
  assert((await sinResoluciones.motores()).sujetos.every((s) => s.resolucion === null), 'sin historia, sin resolución (y no rompe)');

  const cat = (await nucleo.motores()).catalogo.find((c) => c.motor === 'claude').modelos.map((m) => m.modelo);
  assert(cat.indexOf('claude-opus-5-5') > cat.indexOf('haiku'), 'los IDs van después de los alias');

  const js = codigoCliente();
  assert(js.includes('<${LineaResolucion} ef=${ef} res=${suj.resolucion} />') && js.includes('Versión fijada'), 'el cliente pinta la resolución y el ID fijado');
}
console.log('✔ Test 137 [FEAT-086]: a qué modelo resuelve el alias de cada rol, en la consola');

// Test 138 [SEC-021]: memoria en cuarentena en la consola. Ver, promover (el
// commit lo hace el módulo real con un cerrarSesion doble) y descartar, con el
// chequeo de origen de toda mutación; el texto es no confiable y el cliente
// lo pinta como texto.
{
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { crearNucleoWeb } = await import('../web/nucleo.js');
  const { crearServidorWeb, cookieWeb } = await import('../web/servidor.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const cuarentenaMod = req('../../mcp-server/agents/cuarentena.js');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sec021-'));
  const prov = { motor: 'antigravity', modeloReal: 'gemini-3.1-pro', red: 'usada', herramientasRed: ['search_web'], origen: 'usuario', sesion: 'h1' };
  const a = cuarentenaMod.retener('revisor', { decisions: ['<img src=x onerror=alert(1)> usar v2'], procedencia: prov }, { homeDir: home });
  const b = cuarentenaMod.retener('revisor', { userCorrections: ['otra'], procedencia: prov }, { homeDir: home });
  cuarentenaMod.retener('ajeno', { decisions: ['de otro'], procedencia: prov }, { homeDir: home });
  const commits = [];
  let memoriaAcepta = false;
  const cuarentena = {
    listar: (nombre) => cuarentenaMod.listar(nombre, { homeDir: home }),
    promover: (id, nombre) => cuarentenaMod.promover(id, {
      agente: nombre, homeDir: home,
      cerrarSesion: async (agente, datos) => { commits.push({ agente, datos }); return memoriaAcepta ? { ok: true } : { ok: false, motivo: 'caída' }; }
    }),
    descartar: (id, nombre) => cuarentenaMod.descartar(id, { agente: nombre, homeDir: home })
  };
  const bot = { almasDisponibles: () => [], agentesCasteables: () => [{ nombre: 'revisor', descripcion: null }] };
  const nucleo = crearNucleoWeb({ canal: crearCanalWeb(), bot, almas: {}, workspaces: () => [], nombreAgenteValido: (n) => /^[a-z0-9-]+$/.test(n), cuarentena });
  try {
    const vista = await nucleo.cuarentenaAgente('revisor');
    assert.strictEqual(vista.total, 2, 'solo las del agente');
    assert.deepStrictEqual(vista.entradas[0].procedencia, { motor: 'antigravity', modeloReal: 'gemini-3.1-pro', red: 'usada', herramientasRed: ['search_web'], origen: 'usuario' });
    assert.strictEqual((await nucleo.cuarentenaAgente('nadie')).codigo, 404, 'un agente no castable');
    assert.strictEqual((await crearNucleoWeb({ canal: crearCanalWeb(), bot, almas: {}, workspaces: () => [], nombreAgenteValido: () => true }).cuarentenaAgente('revisor')).codigo, 503);

    const falla = await nucleo.promoverCuarentena('revisor', a.id);
    assert.strictEqual(falla.codigo, 409, 'la memoria no aceptó');
    assert.strictEqual((await nucleo.cuarentenaAgente('revisor')).total, 2, 'y la entrada sigue');
    memoriaAcepta = true;
    const ok = await nucleo.promoverCuarentena('revisor', a.id);
    assert.strictEqual(ok.total, 1, ok.error);
    assert.strictEqual(commits.at(-1).agente, 'revisor');
    assert.strictEqual(commits.at(-1).datos.sessionId, a.id, 'la sesión es el id de la entrada');
    assert.strictEqual((await nucleo.promoverCuarentena('revisor', 'q_noexiste00')).codigo, 409);

    // Servidor: GET y los dos POST, con chequeo de origen.
    const token = 'q'.repeat(48);
    const servidor = crearServidorWeb({
      nucleo: {
        canal: crearCanalWeb(), chatId: 'web',
        cuarentenaAgente: (n) => nucleo.cuarentenaAgente(n),
        promoverCuarentena: (n, id) => nucleo.promoverCuarentena(n, id),
        descartarCuarentena: (n, id) => nucleo.descartarCuarentena(n, id)
      },
      token, latidoMs: 60_000
    });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    const puerto = servidor.address().port;
    const cookie = { cookie: `${cookieWeb(puerto)}=${token}` };
    try {
      assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/agentes/revisor/cuarentena' })).status, 401, 'sin sesión');
      assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/agentes/revisor/cuarentena', headers: cookie })).status, 200);
      const cuerpo = JSON.stringify({ id: b.id });
      const ajeno = await pedirWeb(puerto, { metodo: 'POST', ruta: '/api/agentes/revisor/cuarentena/descartar', headers: { ...cookie, 'content-type': 'application/json', origin: 'http://evil.example' }, cuerpo });
      assert.strictEqual(ajeno.status, 403, 'otro origen no descarta');
      const d = await pedirWeb(puerto, { metodo: 'POST', ruta: '/api/agentes/revisor/cuarentena/descartar', headers: { ...cookie, 'content-type': 'application/json' }, cuerpo });
      assert.strictEqual(d.status, 200, d.texto);
      assert.strictEqual(JSON.parse(d.texto).total, 0);
    } finally {
      await new Promise((r) => servidor.close(r));
    }
    assert.strictEqual(cuarentenaMod.listar('ajeno', { homeDir: home }).entradas.length, 1, 'lo de otro agente no se toca');

    // BE-164 — Una entrada dañada (antes de BE-078) no cuenta como pendiente y no se ofrece promover.
    const rutaQ = cuarentenaMod.rutaCuarentena(home);
    const tablaQ = JSON.parse(fs.readFileSync(rutaQ, 'utf8'));
    tablaQ.entradas.push({ id: 'q_danada01', agente: 'revisor', creada: new Date().toISOString(), decisions: ['[object Object]'], userCorrections: [], procedencia: {} });
    fs.writeFileSync(rutaQ, JSON.stringify(tablaQ));
    const soloDanada = await nucleo.cuarentenaAgente('revisor');
    assert.strictEqual(soloDanada.total, 0, 'la dañada no es pendiente');
    assert.strictEqual(soloDanada.danadas, 1, 'pero se cuenta aparte');
    assert.strictEqual(soloDanada.entradas[0].promovible, false, 'y se marca no promovible');

    const js = codigoCliente();
    // FEAT-136 F4 — Componentes de ui/panel.js: htm interpola texto, nunca HTML.
    const pintar = js.slice(js.indexOf('export function SeccionCuarentena'), js.indexOf('// ---------------------------------------------------------------- FEAT-076: proyecto y reglas'));
    assert(pintar.includes('<p class="criterio-texto">${t}</p>') && !/innerHTML|dangerouslySetInnerHTML/.test(pintar), 'el texto retenido se pinta como texto');
    assert(pintar.includes('Confirmar'), 'promover pide confirmación');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
console.log('✔ Test 138 [SEC-021]: memoria en cuarentena en la consola');

// Test 139 [BE-046]: la red de un cast se ve aunque no haya nada retenido. En
// la prueba en vivo de SEC-021 un cast del clima usó search_web, el hilo quedó
// marcado y ni el pie ni la consola lo decían.
{
  const { segmentoDeRed, formatearPieDeCast, cierreDeCast: cierreDeCastParaTest } = await import('../bot.js');

  const clima = { usada: true, recuperada: false, guardadas: 0, enCuarentena: 0, extraidas: 0, red: 'usada', herramientasRed: ['search_web', 'read_url_content'] };
  assert.strictEqual(segmentoDeRed(clima), '🌐 usó red (search_web, read_url_content): lo que aprenda este hilo va a cuarentena');
  assert.strictEqual(segmentoDeRed({ ...clima, red: 'heredada', herramientasRed: [] }), '🌐 hilo con red: lo que aprenda este hilo va a cuarentena');
  assert.strictEqual(segmentoDeRed({ ...clima, red: 'desconocida', herramientasRed: [] }), '🌐 sin datos de red: lo que aprenda este hilo va a cuarentena');
  assert.strictEqual(segmentoDeRed({ ...clima, enCuarentena: 1 }), null, 'con algo retenido, la línea 🔒 ya lo dice');
  assert.strictEqual(segmentoDeRed({ ...clima, red: 'no' }), null);
  assert.strictEqual(segmentoDeRed(undefined), null);
  const pie = formatearPieDeCast({ agent: 'lagrange-reviewer', workspaceName: 'repo' }, { ok: true, motor: 'antigravity', memoria: clima }, 26);
  assert(pie.includes('criterio guardado: 0') && pie.includes('🌐 usó red (search_web, read_url_content)'), pie);
  assert(!formatearPieDeCast({ agent: 'a', workspaceName: 'r' }, { ok: true, motor: 'antigravity', memoria: { ...clima, red: 'no' } }, 1).includes('🌐'), 'sin red, el pie de siempre');

  // El registro de tareas lleva la red para la consola (solo si hubo).
  const cierre = cierreDeCastParaTest({ ok: true, respuesta: 'x', motor: 'antigravity', memoria: clima });
  assert.strictEqual(cierre.memoria.red, 'usada', JSON.stringify(cierre));
  assert(!('red' in cierreDeCastParaTest({ ok: true, respuesta: 'x', motor: 'antigravity', memoria: { ...clima, red: 'no' } }).memoria), 'sin red, no se agrega');

  const js = codigoCliente();
  assert(js.includes('RED_EN_CHIP[m.red]'), 'el cliente pinta el chip de red en la actividad del cast');
}
console.log('✔ Test 139 [BE-046]: la red de un cast se ve aunque no haya nada retenido');

