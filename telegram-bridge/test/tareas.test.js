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
// Test 93 [FEAT-053]: el registro de tareas. Persistencia inmediata, topes,
// redacción, filtro por sujeto, cierre con fecha, reinicio que no miente y un
// archivo ilegible que se aparta en vez de pisarse.
{
  const tareas = await import('../tareas.js');
  const ruta = tareas.rutaTareas();
  assert.strictEqual(path.dirname(ruta), path.dirname(TEST_STATE_FILE), 'vive junto al state.json (aislado en los tests)');
  try { fs.rmSync(ruta, { force: true }); } catch {}
  tareas.reiniciarParaTests();

  const avisos = [];
  const baja = tareas.suscribir((t) => avisos.push([t.id, t.estado]));
  const alma = { tipo: 'alma', clave: 'alya', voz: 'Alya' };
  const t1 = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: `hola ${FAKE_TOKEN}` });
  assert(t1.id.startsWith('t_') && t1.estado === 'en_cola' && t1.creada);
  assert(!t1.pedido.includes(FAKE_TOKEN), 'el pedido se guarda redactado');
  assert.strictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')).tareas.length, 1, 'se escribe en el acto, sin esperar');

  const trabajo = tareas.crear({ carril: 'principal', origen: 'telegram', sujeto: { tipo: 'trabajo', modo: 'plan' }, pedido: 'x'.repeat(500) });
  assert(trabajo.pedido.length < 120, 'del trabajo solo queda un extracto');

  tareas.actualizar(t1.id, { estado: 'en_curso' });
  assert(tareas.obtener(t1.id).iniciada, 'pasar a en_curso pone la fecha de inicio');
  tareas.actualizar(t1.id, { estado: 'ok', resultado: '**hola** de vuelta\n' + 'y'.repeat(tareas.TOPE_TEXTO + 10), memoria: { recordo: 1 }, id: 'pisado', carril: 'otro' });
  const cerrada = tareas.obtener(t1.id);
  assert(cerrada.terminada, 'cerrar pone la fecha de fin');
  assert(cerrada.resultado.endsWith('[recortado]') && cerrada.resultado.length < tareas.TOPE_TEXTO + 40, 'el resultado se recorta');
  assert(cerrada.resultadoHtml.startsWith('<b>hola</b>'), 'y se guarda su HTML acotado');
  assert.strictEqual(cerrada.carril, 'alma', 'los campos no actualizables se ignoran');
  assert.strictEqual(tareas.actualizar(t1.id, { estado: 'inventado' }).estado, 'ok', 'un estado desconocido se ignora');
  assert.strictEqual(tareas.actualizar('t_nadie', { estado: 'ok' }), null);

  assert.strictEqual(
    tareas.prepararMarkdown('## Título\n- uno\n  * dos\n```\n# código\n- igual\n```'),
    '**Título**\n• uno\n  • dos\n```\n# código\n- igual\n```',
    'títulos y listas se adaptan para la web, sin tocar el código');

  const r = tareas.resumen(cerrada);
  assert(!('resultado' in r) && !('resultadoHtml' in r) && r.tieneResultado === true, 'el resumen no lleva los textos');

  const agente = tareas.crear({ carril: 'cast', origen: 'telegram', sujeto: { tipo: 'agente', nombre: 'lector' }, pedido: 'revisá', proyecto: 'app' });
  assert.deepStrictEqual(tareas.listar({ sujeto: 'alma:alya' }).map((t) => t.id), [t1.id], 'filtro por sujeto');
  assert.deepStrictEqual(tareas.listar().map((t) => t.id), [t1.id, trabajo.id, agente.id], 'de la más vieja a la más nueva');

  // Reinicio: lo abierto pasa a interrumpida, lo cerrado no se toca.
  tareas.reiniciarParaTests();
  assert.strictEqual(tareas.recuperarAlArrancar(), 2, 'el trabajo y el cast quedaron abiertos');
  assert.strictEqual(tareas.obtener(agente.id).estado, 'interrumpida');
  assert(tareas.obtener(agente.id).error.includes('reinició'));
  assert.strictEqual(tareas.obtener(t1.id).estado, 'ok');
  assert.strictEqual(tareas.recuperarAlArrancar(), 0, 'la segunda vez no hay nada que hacer');
  assert(avisos.length >= 4, 'los cambios se avisan a los suscriptores');
  baja();

  // Tope: se van las más viejas cerradas, nunca una abierta.
  const CERRADOS = ['ok', 'error', 'cancelada', 'interrumpida'];
  const cerradasAntes = tareas.listar().filter((t) => CERRADOS.includes(t.estado)).length;
  const masVieja = tareas.listar().find((t) => CERRADOS.includes(t.estado));
  const abierta = tareas.crear({ carril: 'cast', origen: 'web', sujeto: { tipo: 'agente', nombre: 'lector' }, pedido: 'la abierta' });
  // Una tarjeta de Por hacer tiene su propio tope y no entra en este recorte:
  // ni se expulsa ni se archiva, por vieja que sea.
  const porHacer = tareas.crearTarjeta({ titulo: 'la de por hacer', pedido: 'no me toques', sujeto: alma });
  for (let i = 0; i < tareas.TOPE_TAREAS + 5; i++) {
    const t = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: `n${i}` });
    tareas.actualizar(t.id, { estado: 'ok' });
  }
  const todas = tareas.listar();
  assert.strictEqual(todas.filter((t) => CERRADOS.includes(t.estado)).length, tareas.TOPE_TAREAS, 'respeta el tope de cerradas');
  assert(todas.some((t) => t.id === abierta.id), 'la tarea abierta sobrevive al recorte');
  assert(todas.some((t) => t.id === porHacer.tarea.id), 'la tarjeta de Por hacer también');

  // BE-028: lo que el tope expulsa se archiva antes de desaparecer, entero.
  {
    const { createRequire } = await import('node:module');
    const historia = createRequire(import.meta.url)('../../mcp-server/lib/historia.js');
    const dirHistoria = path.dirname(ruta);
    const meses = historia.mesesArchivados(dirHistoria);
    assert(meses.length > 0, 'la expulsión dejó un archivo mensual');
    const archivadas = meses.flatMap((m) => historia.leerMes(dirHistoria, m));
    // La invariante que importa: ninguna cerrada desaparece sin archivarse.
    const creadasCerradas = cerradasAntes + tareas.TOPE_TAREAS + 5;
    assert.strictEqual(archivadas.length, creadasCerradas - tareas.TOPE_TAREAS, 'se archivó todo lo que el tope expulsó');
    assert(archivadas.every((t) => CERRADOS.includes(t.estado)), 'solo se archivan cerradas');
    assert(!archivadas.some((t) => t.id === abierta.id), 'una abierta nunca se archiva');
    assert(!archivadas.some((t) => t.id === porHacer.tarea.id), 'una de Por hacer nunca se archiva');
    assert.strictEqual(tareas.obtener(porHacer.tarea.id).estado, tareas.POR_HACER, 'y sigue viva en el registro');
    assert.strictEqual(archivadas[0].id, masVieja.id, 'la primera archivada es la cerrada más vieja');
    assert(archivadas.some((t) => t.pedido === 'n0'), 'el pedido viaja entero al archivo');
    assert(archivadas.every((t) => !tareas.obtener(t.id)), 'lo archivado ya no está en el registro vivo');
    fs.rmSync(path.join(dirHistoria, historia.DIR_HISTORIA), { recursive: true, force: true });
  }

  // Archivo ilegible: se aparta y se empieza de nuevo.
  fs.writeFileSync(ruta, '{roto');
  tareas.reiniciarParaTests();
  const errorOriginal = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    assert.deepStrictEqual(tareas.listar(), [], 'un archivo ilegible se lee como vacío');
    tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: 'después del roto' });
  } finally {
    process.stderr.write = errorOriginal;
  }
  assert(fs.readdirSync(path.dirname(ruta)).some((f) => f.startsWith('tareas.json.corrupto-')), 'el ilegible quedó apartado');
  assert.strictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')).tareas.length, 1);
  tareas.reiniciarParaTests();
  fs.rmSync(ruta, { force: true });
}
console.log('✔ Test 93 [FEAT-053]: registro de tareas persistente');

// Test 94 [FEAT-053]: la cola anota cada tarea en el registro. Origen y sujeto,
// resultado y memoria de una charla, error, reacción, cast cancelado en curso y
// en cola, trabajo sin resultado, y una excepción del carril.
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const { crearCanalWeb, crearCtxWeb } = await import('../web/canal.js');
  const { bot } = botDePrueba();
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  try { fs.rmSync(tareas.rutaTareas(), { force: true }); } catch {}
  const esperar = async (cond, motivo) => {
    const limite = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > limite) throw new Error(`Test 94: no se cumplió a tiempo: ${motivo}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const ultima = () => tareas.listar().at(-1);
  const diferido = () => { let resolver; const promesa = new Promise((r) => { resolver = r; }); return { promesa, resolver }; };

  let modo = 'ok';
  const diarios = [];
  const cast = diferido();
  botMod.usarEjecutoresDePrueba({
    charlar: async ({ clave, opciones }) => {
      diarios.push(opciones.diario);
      if (modo === 'lanza') throw new Error('explotó');
      if (modo === 'error') return { ok: false, clave, motivo: 'agy no contestó' };
      return { ok: true, clave, respuesta: '*listo*', aplicadas: [{ tipo: 'agregar' }, { tipo: 'olvidar' }, { tipo: 'archivar' }], rechazadas: [{ motivo: 'x' }] };
    },
    castear: async ({ opciones }) => {
      opciones.onSpawn(() => { cast.resolver({ ok: false, cancelled: true }); return true; });
      return cast.promesa;
    },
    runAgyTask: async () => ({ success: true, responseText: 'SALIDA LARGA DEL RUN', data: {}, durationSeconds: 1, conversationId: null })
  });
  const canal = crearCanalWeb();
  botMod.conectarCanalWeb(canal);
  const ctxWeb = crearCtxWeb(canal);
  const ctxTg = { chat: { id: Number(USUARIO_OK), type: 'private' }, reply: async () => ({ message_id: 1 }) };
  const libre = (c) => () => !botMod.carrilOcupado(c) && queue.getQueueLength(c) === 0;

  try {
    // Charla web ok.
    await botMod.dispatchCharla(ctxWeb, { clave: 'alya', voz: 'Alya', texto: 'hola desde web' });
    await esperar(libre('alma'), 'charla web');
    let t = ultima();
    assert.deepStrictEqual([t.carril, t.origen, t.sujeto, t.estado], ['alma', 'web', { tipo: 'alma', clave: 'alya', voz: 'Alya' }, 'ok']);
    assert.strictEqual(t.pedido, 'hola desde web');
    assert.strictEqual(t.resultado, '*listo*');
    assert.deepStrictEqual(t.memoria, { recordo: 1, corrigio: 0, olvido: 1, archivo: 1, rechazos: 1 });
    assert(t.iniciada && t.terminada);
    assert.strictEqual(diarios.at(-1).superficie, 'web', 'el diario recibe la superficie web');

    // Charla de Telegram con error.
    modo = 'error';
    await botMod.dispatchCharla(ctxTg, { clave: 'alya', voz: 'Alya', texto: 'hola' });
    await esperar(libre('alma'), 'charla con error');
    t = ultima();
    assert.deepStrictEqual([t.origen, t.estado, t.error], ['telegram', 'error', 'agy no contestó']);
    assert.strictEqual(diarios.at(-1).superficie, 'telegram');

    // Reacción: se guarda qué hizo el usuario, no el prompt interno.
    modo = 'ok';
    await botMod.dispatchCharla(ctxTg, { clave: 'alya', voz: 'Alya', texto: 'PROMPT INTERNO', diario: { tipo: 'reaccion', reaccion: '👍', messageId: 5 } });
    await esperar(libre('alma'), 'reacción');
    t = ultima();
    assert.deepStrictEqual([t.pedido, t.motivo], ['reaccionó con 👍', 'reaccion']);
    assert.strictEqual(diarios.at(-1).tipo, 'reaccion', 'la reacción conserva su tipo en el diario');

    // Excepción en el carril.
    modo = 'lanza';
    const errorOriginal = console.error;
    console.error = () => {};
    try {
      await botMod.dispatchCharla(ctxWeb, { clave: 'alya', voz: 'Alya', texto: 'rompé' });
      await esperar(libre('alma'), 'excepción');
    } finally {
      console.error = errorOriginal;
    }
    t = ultima();
    assert.strictEqual(t.estado, 'error');
    assert(t.error.includes('explotó'));

    // Cast en curso + otro en cola; cancelar marca los dos.
    const pedidoCast = { agent: 'lector', prompt: 'revisá', cwd: os.tmpdir(), workspaceName: 'tmp' };
    await botMod.dispatchCast(ctxWeb, pedidoCast);
    await esperar(() => botMod.carrilOcupado('cast'), 'el cast arranca');
    const enCurso = ultima();
    assert.deepStrictEqual([enCurso.estado, enCurso.sujeto, enCurso.proyecto], ['en_curso', { tipo: 'agente', nombre: 'lector' }, 'tmp']);
    await botMod.dispatchCast(ctxWeb, { ...pedidoCast, prompt: 'segundo' });
    const encolado = ultima();
    assert.strictEqual(encolado.estado, 'en_cola');
    assert.strictEqual(queue.getQueueSnapshot('cast')[0].tareaId, encolado.id, 'la vista de la cola expone el id');
    botMod.cancelarCarriles(['cast'], 'web:local');
    await esperar(libre('cast'), 'el cast cancelado libera el carril');
    assert.strictEqual(tareas.obtener(encolado.id).estado, 'cancelada', 'la encolada queda cancelada');
    assert.strictEqual(tareas.obtener(enCurso.id).estado, 'cancelada', 'la que corría también');

    // Trabajo: solo metadatos.
    await bot.handleUpdate(comandoDe(`/run ${'z'.repeat(300)}`, 9401));
    await esperar(libre('principal'), 'el run termina');
    t = ultima();
    assert.deepStrictEqual([t.carril, t.sujeto, t.estado, t.resultado], ['principal', { tipo: 'trabajo', modo: 'accept-edits' }, 'ok', null]);
    assert(t.pedido.length < 120, 'del run queda un extracto');
    assert(!JSON.stringify(t).includes('SALIDA LARGA'), 'la salida del run no se guarda');

    assert(tareas.listar().every((x) => !tareas.ESTADOS_ABIERTOS.includes(x.estado)), 'no queda nada abierto');
  } finally {
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
  }
}
console.log('✔ Test 94 [FEAT-053]: la cola anota cada tarea en el registro');

// Test 95 [FEAT-053]: API de la vista A, eventos de tareas por SSE (también las
// de Telegram, sin textos largos) y estáticos servidos desde un mapa fijo.
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  try { fs.rmSync(tareas.rutaTareas(), { force: true }); } catch {}

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-iter2-'));
  const home = path.join(raiz, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'antigravity-agents.json'), JSON.stringify({
    agents: { lector: { skill: 's', read_only: true, description: 'Lee' }, escritor: { skill: 's', read_only: false } }
  }));
  fs.writeFileSync(path.join(home, '.claude', 'antigravity-agents-state.json'), JSON.stringify({
    agents: { lector: { conversation_id: 'hilo-lector', casts: 3, ultimo_cast: '2026-09-15T10:00:00.000Z', ultimo_cwd: path.join(raiz, 'mi-proyecto') } }
  }));
  const previo = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, LAGRANGE_ALMAS_DIR: process.env.LAGRANGE_ALMAS_DIR, AGY_MODEL: process.env.AGY_MODEL };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
  process.env.AGY_MODEL = 'gemini-prueba';
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });

  const pendientes = [];
  botMod.usarEjecutoresDePrueba({
    charlar: ({ clave }) => new Promise((resolve) => pendientes.push(() => resolve({ ok: true, clave, respuesta: `RESPUESTA ${FAKE_TOKEN}`, aplicadas: [], rechazadas: [] })))
  });
  const esperar = async (cond, motivo) => {
    const limite = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > limite) throw new Error(`Test 95: no se cumplió a tiempo: ${motivo}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  let web = null;

  try {
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const puerto = web.servidor.address().port;
    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const get = (ruta, headers = cookie) => pedirWeb(puerto, { ruta, headers });

    // Estáticos.
    assert.strictEqual((await get('/app.js', {})).status, 401, 'los estáticos también piden sesión');
    const js = await get('/app.js');
    assert.deepStrictEqual([js.status, js.headers['content-type']], [200, 'text/javascript; charset=utf-8']);
    assert.strictEqual((await get('/app.css')).headers['content-type'], 'text/css; charset=utf-8');
    // FEAT-136 — Los módulos de la consola: con sesión, como JS, con la CSP; nada fuera del mapa.
    assert.strictEqual((await get('/ui/main.js', {})).status, 401, 'los módulos también piden sesión');
    for (const ruta of ['/ui/main.js', '/vendor/preact.module.js', '/vendor/signals.module.js', '/vendor/htm.module.js']) {
      const r = await get(ruta);
      assert.deepStrictEqual([r.status, r.headers['content-type']], [200, 'text/javascript; charset=utf-8'], ruta);
      assert.ok(r.headers['content-security-policy'], `${ruta} con CSP`);
    }
    for (const ruta of ['/vendor/MANIFEST.json', '/vendor/preact.LICENSE.txt', '/vendor/..%2fapp.js', '/ui/..%2f..%2fservidor.js', '/ui/%2e%2e/servidor.js', '/vendor/', '/ui/no-existe.js']) {
      assert.strictEqual((await get(ruta)).status, 404, `fuera del mapa de módulos: ${ruta}`);
    }
    for (const ruta of ['/index.html', '/public/app.js', '/app.js/../bot.js', '/%2e%2e/bot.js', '/..%2fbot.js', '/app.js%00']) {
      assert.strictEqual((await get(ruta)).status, 404, `nada fuera del mapa: ${ruta}`);
    }
    const vm = await import('node:vm');
    assertModuloValido(js.texto, 'app.js');
    const perfJs = await get('/rendimiento-vista.js');
    assert.strictEqual((await get('/rendimiento-vista.js', {})).status, 401);
    assert.deepStrictEqual([perfJs.status, perfJs.headers['content-type']], [200, 'text/javascript; charset=utf-8']);
    new vm.Script(perfJs.texto);
    assert(!/\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|document\.write|eval\(|new Function/.test(perfJs.texto), 'rendimiento sin HTML inyectado ni código dinámico');
    // FEAT-136 — Las vistas viven en ui/: lo que el cliente hace se mira en todo el cliente (app.js servido + ui/).
    // codigoCliente() ya trae app.js del disco (el mismo que se sirvió): se usa tal cual, sin sumarlo dos veces.
    const clienteTexto = codigoCliente();
    assert(!/\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|document\.write/.test(clienteTexto), 'el cliente no inyecta HTML');
    // FEAT-055 — El parcial se pinta como texto y su selector se escapa.
    // FEAT-136 — La burbuja es el componente `Parcial`: htm interpola el texto, nunca HTML; sin selectores armados a mano.
    assert(clienteTexto.includes('data-parcial=${id} hidden=${!texto}>${texto}</div>'), 'el parcial va como texto');
    assert(/e\.tipo === 'parcial'/.test(clienteTexto) && /\/api\/fanout/.test(clienteTexto) && /\/recordar`/.test(clienteTexto) && /\/escuchar`/.test(clienteTexto), 'el cliente usa las rutas nuevas');
    // FEAT-056 — Preparar voz y lectura automática.
    assert(/\/api\/voz\/preparar/.test(clienteTexto), 'el cliente prepara la voz');
    assert.strictEqual((clienteTexto.match(/new Audio\(/g) || []).length, 1, 'un solo reproductor');
    assert(!/localStorage[^\n]*(lectura|auto)/i.test(clienteTexto), 'la lectura automática no se guarda');
    assert(/Date\.parse\(t\.terminada\) > vozWeb\.desde/.test(clienteTexto), 'lo nuevo se decide por terminada, no por lo visto en vivo');

    // Estado del daemon.
    const est = (await get('/api/estado')).json();
    assert.deepStrictEqual([est.daemon.pid, est.modelo, est.carriles.map((c) => c.carril)], [process.pid, 'gemini-prueba', ['principal', 'cast', 'alma', 'programado']]);

    // Sujetos con estado derivado: una charla en curso y otra en cola.
    const ctxTg = { chat: { id: Number(USUARIO_OK), type: 'private' }, reply: async () => ({ message_id: 1 }) };
    const sse = esperarSse(puerto, cookie, (t) => t.includes('"tipo":"tarea"') && t.includes('"origen":"telegram"') && t.includes('"estado":"ok"'), { ms: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    await botMod.dispatchCharla(ctxTg, { clave: 'alya', voz: 'Alya', texto: 'primero' });
    await esperar(() => pendientes.length === 1, 'la primera charla arranca');
    await botMod.dispatchCharla(ctxTg, { clave: 'alya', voz: 'Alya', texto: 'segundo' });
    let sujetos = (await get('/api/sujetos')).json();
    const alya = sujetos.almas.find((a) => a.clave === 'alya');
    assert(alya.enCurso && alya.enCurso.desde, 'alya está en curso');
    assert.deepStrictEqual(alya.enCola, { posicion: 2 }, 'y tiene otra en cola, segunda en la fila');
    assert.deepStrictEqual(sujetos.agentes.map((a) => a.nombre), ['lector'], 'solo agentes castables');

    pendientes.shift()();
    await esperar(() => pendientes.length === 1, 'la segunda arranca');
    pendientes.shift()();
    await esperar(() => !botMod.carrilOcupado('alma') && queue.getQueueLength('alma') === 0, 'las dos terminan');
    const flujo = await sse;
    assert(!flujo.texto.includes('RESPUESTA'), 'el evento de tarea no lleva el resultado');
    sujetos = (await get('/api/sujetos')).json();
    const alyaDespues = sujetos.almas.find((a) => a.clave === 'alya');
    assert(!alyaDespues.enCurso && !alyaDespues.enCola && alyaDespues.ultima, 'terminadas: queda la última actividad');

    // Historial por sujeto.
    const hist = (await get('/api/tareas?sujeto=alma%3Aalya')).json();
    assert.deepStrictEqual(hist.tareas.map((t) => t.pedido), ['primero', 'segundo'], 'de la más vieja a la más nueva');
    assert(hist.tareas[0].resultadoHtml && !hist.tareas[0].resultado.includes(FAKE_TOKEN), 'con resultado redactado y su HTML');
    for (const malo of ['', 'alma:..%2Fx', 'alma:ALYA', 'otro:x', 'agente:a%20b', 'agente:']) {
      assert.strictEqual((await get(`/api/tareas?sujeto=${malo}`)).status, 400, `sujeto inválido: ${malo}`);
    }
    assert.deepStrictEqual((await get('/api/tareas?sujeto=agente:lector')).json().tareas, []);

    // Contexto del agente, sin rutas.
    const ctxAgente = (await get('/api/agentes/lector/contexto')).json();
    assert.deepStrictEqual([ctxAgente.casts, ctxAgente.conversationId, ctxAgente.proyecto], [3, 'hilo-lector', 'mi-proyecto']);
    assert(!JSON.stringify(ctxAgente).includes(raiz), 'el contexto no expone rutas');
    assert.strictEqual((await get('/api/agentes/escritor/contexto')).status, 404, 'un agente con escritura no es castable');
    assert.strictEqual((await get('/api/agentes/a%20b/contexto')).status, 400);
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 95 [FEAT-053]: API de la vista A, eventos de tareas y estáticos');

// Test 96 [FEAT-054]: actividad en vivo. En el registro vive en memoria (sin
// escribir a disco) hasta el cierre; la cola la alimenta desde el cast (que pide
// stream) y desde el trabajo.
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const { bot } = botDePrueba();
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  const ruta = tareas.rutaTareas();
  try { fs.rmSync(ruta, { force: true }); } catch {}
  const esperar = async (cond, motivo) => {
    const limite = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > limite) throw new Error(`Test 96: no se cumplió a tiempo: ${motivo}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  try {
    // Módulo.
    const t = tareas.crear({ carril: 'cast', origen: 'web', sujeto: { tipo: 'agente', nombre: 'lector' }, pedido: 'p'.repeat(300), workspaceId: 'ab12' });
    assert.strictEqual(t.workspaceId, 'ab12');
    const enDisco = fs.readFileSync(ruta, 'utf8');
    const avisos = [];
    const baja = tareas.suscribir((x) => avisos.push(x.actividad.length));
    for (let i = 0; i < tareas.TOPE_ACTIVIDAD + 5; i++) tareas.agregarActividad(t.id, `leyó archivo ${i}`);
    tareas.agregarActividad(t.id, `token ${FAKE_TOKEN} ${'x'.repeat(300)}`);
    tareas.agregarActividad(t.id, '   ');
    baja();
    const act = tareas.obtener(t.id).actividad;
    assert.strictEqual(act.length, tareas.TOPE_ACTIVIDAD, 'tope de entradas');
    assert(!act.at(-1).texto.includes(FAKE_TOKEN) && act.at(-1).texto.length <= tareas.TOPE_TEXTO_ACTIVIDAD, 'redactada y recortada');
    assert(act[0].t && act[0].texto === 'leyó archivo 6', 'se van las más viejas');
    assert.strictEqual(avisos.length, tareas.TOPE_ACTIVIDAD + 6, 'cada entrada se avisa (el texto vacío no)');
    assert.strictEqual(fs.readFileSync(ruta, 'utf8'), enDisco, 'la actividad no escribe a disco');
    const res = tareas.resumen(tareas.obtener(t.id));
    assert(res.pedido.length <= tareas.TOPE_PEDIDO_RESUMEN + 1 && res.actividad.length === tareas.TOPE_ACTIVIDAD, 'el resumen recorta el pedido y lleva la actividad');
    tareas.actualizar(t.id, { estado: 'ok' });
    assert.strictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')).tareas[0].actividad.length, tareas.TOPE_ACTIVIDAD, 'al cerrar queda persistida');
    assert.strictEqual(tareas.agregarActividad(t.id, 'tarde'), null, 'una tarea cerrada no suma actividad');

    // Enganches: cast (con stream) y trabajo.
    const opcionesCast = [];
    botMod.usarEjecutoresDePrueba({
      castear: async ({ opciones }) => {
        opcionesCast.push(opciones);
        opciones.onActividad('read_file → bot.js');
        opciones.onActividad('grep_search → botRef.api');
        return { ok: true, respuesta: 'listo', memoria: { usada: false } };
      },
      runAgyTask: async ({ onActividad }) => {
        onActividad('run_command → npm test');
        return { success: true, responseText: 'ok', data: {}, durationSeconds: 1, conversationId: null };
      }
    });
    const ctxWeb = { chat: { id: 'web:local', type: 'private' }, reply: async () => ({ message_id: 1 }) };
    await botMod.dispatchCast(ctxWeb, { agent: 'lector', prompt: 'mirá', cwd: os.tmpdir(), workspaceName: 'tmp', workspaceId: 'cd34' });
    await esperar(() => !botMod.carrilOcupado('cast') && queue.getQueueLength('cast') === 0, 'el cast termina');
    const cast = tareas.listar({ sujeto: 'agente:lector' }).at(-1);
    assert.strictEqual(opcionesCast[0].stream, true, 'el bot pide stream al castear');
    assert.deepStrictEqual(cast.actividad.map((a) => a.texto), ['read_file → bot.js', 'grep_search → botRef.api']);
    assert.strictEqual(cast.workspaceId, 'cd34', 'el cast guarda el id del proyecto');
    assert(JSON.parse(fs.readFileSync(ruta, 'utf8')).tareas.find((x) => x.id === cast.id).actividad.length === 2, 'y su actividad queda en disco');

    await bot.handleUpdate(comandoDe('/run correr tests', 9601));
    await esperar(() => !botMod.carrilOcupado('principal') && queue.getQueueLength('principal') === 0, 'el run termina');
    const run = tareas.listar().filter((x) => x.carril === 'principal').at(-1);
    assert.deepStrictEqual(run.actividad.map((a) => a.texto), ['run_command → npm test'], 'el trabajo también deja actividad');
  } finally {
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
  }
}
console.log('✔ Test 96 [FEAT-054]: actividad en vivo en el registro');

// Test 97 [FEAT-054]: cancelar y reintentar UNA tarea desde la web, y la lista
// completa para el tablero.
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  try { fs.rmSync(tareas.rutaTareas(), { force: true }); } catch {}

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-iter3-'));
  const home = path.join(raiz, 'home');
  const proyecto = path.join(raiz, 'proyecto');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(proyecto);
  fs.writeFileSync(path.join(home, '.claude', 'antigravity-agents.json'), JSON.stringify({
    agents: { lector: { skill: 's', read_only: true }, escritor: { skill: 's', read_only: false } }
  }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [proyecto]: { hasTrustDialogAccepted: true } } }));
  const previo = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, LAGRANGE_ALMAS_DIR: process.env.LAGRANGE_ALMAS_DIR,
    TELEGRAM_BRIDGE_DATA_DIR: process.env.TELEGRAM_BRIDGE_DATA_DIR };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
  process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'bridge-data');
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });

  const enCurso = [];
  const casts = [];
  botMod.usarEjecutoresDePrueba({
    charlar: ({ clave, texto, opciones }) => new Promise((resolve) => {
      opciones.onSpawn(() => { resolve({ ok: false, cancelled: true }); return true; });
      enCurso.push({ texto, terminar: () => resolve({ ok: true, clave, respuesta: 'ok', aplicadas: [], rechazadas: [] }) });
    }),
    castear: async (op) => { casts.push(op); return { ok: true, respuesta: 'hecho', memoria: { usada: false } }; }
  });
  const esperar = async (cond, motivo) => {
    const limite = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > limite) throw new Error(`Test 97: no se cumplió a tiempo: ${motivo}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const libre = (c) => () => !botMod.carrilOcupado(c) && queue.getQueueLength(c) === 0;
  let web = null;

  try {
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const puerto = web.servidor.address().port;
    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const get = (ruta) => pedirWeb(puerto, { ruta, headers: cookie });
    const post = (ruta, headers = {}) => pedirWeb(puerto, { metodo: 'POST', ruta, headers: { ...cookie, 'content-type': 'application/json', ...headers }, cuerpo: '{}' });

    assert.strictEqual((await get('/tablero')).status, 200, 'el tablero es una ruta de la interfaz');

    // Dos charlas: una corre, otra espera. Cancelar la que espera no toca la otra.
    await pedirWeb(puerto, { metodo: 'POST', ruta: '/api/almas/alya/mensaje', headers: { ...cookie, 'content-type': 'application/json' }, cuerpo: JSON.stringify({ texto: 'primera' }) });
    await esperar(() => enCurso.length === 1, 'la primera corre');
    await pedirWeb(puerto, { metodo: 'POST', ruta: '/api/almas/alya/mensaje', headers: { ...cookie, 'content-type': 'application/json' }, cuerpo: JSON.stringify({ texto: 'segunda '.repeat(40) }) });
    const [primera, segunda] = tareas.listar({ sujeto: 'alma:alya' });
    assert.deepStrictEqual([primera.estado, segunda.estado], ['en_curso', 'en_cola']);

    // Lista completa para el tablero: resumen, sin textos largos.
    const todas = (await get('/api/tareas')).json().tareas;
    assert.strictEqual(todas.length, 2);
    assert(todas.every((t) => !('resultado' in t) && !('resultadoHtml' in t)), 'sin resultados');
    assert(todas[1].pedido.length <= tareas.TOPE_PEDIDO_RESUMEN + 1, 'con el pedido recortado');

    assert.strictEqual((await post(`/api/tareas/${segunda.id}/cancelar`, { origin: 'http://evil.example' })).status, 403, 'mutación con origen ajeno');
    const quitada = await post(`/api/tareas/${segunda.id}/cancelar`);
    assert.deepStrictEqual([quitada.status, quitada.json().accion], [200, 'quitada']);
    assert.strictEqual(tareas.obtener(segunda.id).estado, 'cancelada');
    assert.strictEqual(queue.getQueueLength('alma'), 0, 'la cola quedó vacía');
    assert.strictEqual(tareas.obtener(primera.id).estado, 'en_curso', 'la que corría sigue');

    // Cancelar la que corre.
    const abortada = await post(`/api/tareas/${primera.id}/cancelar`);
    assert.deepStrictEqual([abortada.status, abortada.json().accion], [200, 'abortada']);
    await esperar(libre('alma'), 'el carril se libera');
    assert.strictEqual(tareas.obtener(primera.id).estado, 'cancelada');

    // Errores.
    assert.strictEqual((await post(`/api/tareas/${primera.id}/cancelar`)).status, 409, 'ya terminada');
    assert.strictEqual((await post('/api/tareas/t_noexiste/cancelar')).status, 404);
    assert.strictEqual((await post('/api/tareas/..%2Fx/cancelar')).status, 400, 'id inválido');
    const trabajo = tareas.crear({ carril: 'principal', origen: 'telegram', sujeto: { tipo: 'trabajo', modo: 'plan' }, pedido: 'x' });
    assert.strictEqual((await post(`/api/tareas/${trabajo.id}/cancelar`)).status, 400, 'el carril principal no se cancela desde la web');
    tareas.actualizar(trabajo.id, { estado: 'error', error: 'x' });

    // Reintentar una charla cancelada: se relanza con el mismo pedido.
    const reintento = await post(`/api/tareas/${primera.id}/reintentar`);
    assert.strictEqual(reintento.status, 200);
    await esperar(() => enCurso.length === 2, 'el reintento corre');
    assert.strictEqual(enCurso[1].texto, 'primera', 'mismo pedido');
    assert.strictEqual((await post(`/api/tareas/${tareas.listar({ sujeto: 'alma:alya' }).at(-1).id}/reintentar`)).status, 409, 'lo abierto no se reintenta');
    enCurso[1].terminar();
    await esperar(libre('alma'), 'el reintento termina');
    const hecha = tareas.listar({ sujeto: 'alma:alya' }).at(-1);
    assert.strictEqual(hecha.estado, 'ok');
    assert.strictEqual((await post(`/api/tareas/${hecha.id}/reintentar`)).status, 409, 'lo que salió bien no se reintenta');

    // Reintentar un cast: con proyecto por id; sin él, o con un agente que ya no es de lectura, no.
    const wsId = (await get('/api/workspaces')).json().workspaces[0].id;
    const castFallido = tareas.crear({ carril: 'cast', origen: 'web', sujeto: { tipo: 'agente', nombre: 'lector' }, pedido: 'revisá', proyecto: 'proyecto', workspaceId: wsId });
    tareas.actualizar(castFallido.id, { estado: 'interrumpida' });
    assert.strictEqual((await post(`/api/tareas/${castFallido.id}/reintentar`)).status, 200);
    await esperar(() => casts.length === 1 && libre('cast')(), 'el cast reintentado corre');
    assert.strictEqual(casts[0].prompt, 'revisá');
    assert.strictEqual(path.resolve(casts[0].cwd).toLowerCase(), fs.realpathSync.native(proyecto).toLowerCase(), 'en el proyecto resuelto por id');
    assert.strictEqual(tareas.listar({ sujeto: 'agente:lector' }).at(-1).workspaceId, wsId, 'y el reintento conserva el id');

    const sinProyecto = tareas.crear({ carril: 'cast', origen: 'telegram', sujeto: { tipo: 'agente', nombre: 'lector' }, pedido: 'x' });
    tareas.actualizar(sinProyecto.id, { estado: 'error' });
    assert.strictEqual((await post(`/api/tareas/${sinProyecto.id}/reintentar`)).status, 400, 'sin proyecto no se adivina');
    const escritor = tareas.crear({ carril: 'cast', origen: 'telegram', sujeto: { tipo: 'agente', nombre: 'escritor' }, pedido: 'x', workspaceId: wsId });
    tareas.actualizar(escritor.id, { estado: 'error' });
    assert.strictEqual((await post(`/api/tareas/${escritor.id}/reintentar`)).status, 400, 'un agente con escritura no se relanza');
    const reaccion = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' }, pedido: 'reaccionó con 👍', motivo: 'reaccion' });
    tareas.actualizar(reaccion.id, { estado: 'error' });
    assert.strictEqual((await post(`/api/tareas/${reaccion.id}/reintentar`)).status, 400, 'una reacción no se reintenta');
    assert.strictEqual((await post(`/api/tareas/${trabajo.id}/reintentar`)).status, 400, 'el trabajo no se reintenta desde la web');
    assert.strictEqual(casts.length, 1, 'ninguno de esos lanzó nada');
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 97 [FEAT-054]: cancelar y reintentar una tarea desde la web');

// Test 98 [FEAT-055]: respuesta parcial en vivo. El filtro nunca muestra el
// bloque de memoria (ni partido entre pedazos), el acumulador respeta su ritmo y
// su tope, el canal no guarda los parciales y la charla los publica.
{
  const parcial = await import('../parcial.js');
  const { textoVisibleEnVivo, crearAcumuladorParcial, MARCADOR_ALMA, MARCADOR_CAST } = parcial;
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // Filtro.
  assert.strictEqual(textoVisibleEnVivo('Hola.\n<alma>\nrecordar: x', MARCADOR_ALMA), 'Hola.\n');
  assert.strictEqual(textoVisibleEnVivo('a <alma> b <alma> c', MARCADOR_ALMA), 'a ', 'corta en el primero');
  for (const cola of ['<', '<a', '<al', '<alm', '<alma']) {
    assert.strictEqual(textoVisibleEnVivo(`Hola ${cola}`, MARCADOR_ALMA), 'Hola ', `retiene ${cola}`);
  }
  assert.strictEqual(textoVisibleEnVivo('uso <b', MARCADOR_ALMA), 'uso <b', 'un < que no es el marcador no se retiene');
  assert.strictEqual(textoVisibleEnVivo('Listo <memo', MARCADOR_CAST), 'Listo ', 'retiene el prefijo de <memoria>');
  assert.strictEqual(textoVisibleEnVivo('Listo <alma>', MARCADOR_CAST), 'Listo <alma>', 'cada tarea con su marcador');
  assert.strictEqual(textoVisibleEnVivo('sin marcador', MARCADOR_ALMA), 'sin marcador');

  // Acumulador, con reloj falso.
  let reloj = 0;
  const publicados = [];
  const acc = crearAcumuladorParcial({
    marcador: MARCADOR_ALMA,
    publicar: (t) => publicados.push(t),
    intervaloCortoMs: 40,
    intervaloLargoMs: 120,
    umbralLargo: 50,
    tope: 200,
    ahora: () => reloj
  });
  acc.agregar('Hola');
  assert.deepStrictEqual(publicados, ['Hola'], 'el primer pedazo sale enseguida');
  acc.agregar(', qué tal <al');
  acc.agregar('ma>\nrecordar: secreto');
  assert.strictEqual(publicados.length, 1, 'dentro del intervalo no publica');
  reloj = 40;
  await dormir(80);
  assert.deepStrictEqual(publicados, ['Hola', 'Hola, qué tal '], 'lo pendiente sale con el temporizador y sin el bloque');
  acc.agregar(' más texto');
  reloj = 80;
  await dormir(80);
  assert.strictEqual(publicados.length, 2, 'lo que queda detrás del marcador no cambia lo visible: no se republica');
  assert(!publicados.some((t) => t.includes('<al') || t.includes('secreto')), 'el bloque nunca se publica');
  acc.cerrar();

  const conToken = [];
  const acc2 = crearAcumuladorParcial({ marcador: MARCADOR_CAST, publicar: (t) => conToken.push(t), intervaloCortoMs: 0 });
  acc2.agregar(`clave ${FAKE_TOKEN}`);
  assert(conToken.length === 1 && !conToken[0].includes(FAKE_TOKEN), 'se redacta antes de publicar');
  acc2.cerrar();
  acc2.agregar(' tarde');
  assert.strictEqual(conToken.length, 1, 'cerrado no publica');

  const largos = [];
  let reloj3 = 0;
  const acc3 = crearAcumuladorParcial({ marcador: MARCADOR_ALMA, publicar: (t) => largos.push(t), intervaloCortoMs: 10, intervaloLargoMs: 1000, umbralLargo: 20, tope: 60, ahora: () => reloj3 });
  acc3.agregar('x'.repeat(25));
  reloj3 = 15;
  acc3.agregar('y');
  await dormir(40);
  assert.strictEqual(largos.length, 1, 'pasado el umbral el intervalo se alarga');
  acc3.agregar('z'.repeat(60));
  assert.strictEqual(acc3.excedido, true, 'pasado el tope se apaga');
  reloj3 = 5000;
  acc3.agregar('w');
  await dormir(20);
  assert.strictEqual(largos.length, 1, 'y ya no publica');
  acc3.cerrar();

  // Canal: el efímero llega pero no se guarda.
  const { crearCanalWeb, CHAT_WEB_LOCAL } = await import('../web/canal.js');
  const canal = crearCanalWeb();
  const recibidos = [];
  const baja = canal.suscribir(CHAT_WEB_LOCAL, (e) => recibidos.push(e));
  canal.publicar(CHAT_WEB_LOCAL, { tipo: 'parcial', tareaId: 't_x', texto: 'a' }, { efimero: true });
  canal.publicar(CHAT_WEB_LOCAL, { tipo: 'tarea', tarea: {} });
  baja();
  assert.deepStrictEqual(recibidos.map((e) => e.tipo), ['parcial', 'tarea'], 'los dos llegan al suscriptor');
  assert.deepStrictEqual(canal.pendientes(CHAT_WEB_LOCAL).map((e) => e.tipo), ['tarea'], 'el parcial no entra al buffer');

  // Enganche: la charla pide stream y publica sus parciales sin el bloque.
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  const canalBot = crearCanalWeb();
  botMod.conectarCanalWeb(canalBot);
  const eventos = [];
  const bajaBot = canalBot.suscribir(CHAT_WEB_LOCAL, (e) => eventos.push(e));
  const bajaTareas = tareas.suscribir((t) => canalBot.publicar(CHAT_WEB_LOCAL, { tipo: 'tarea', tarea: tareas.resumen(t) }));
  const opcionesCharla = [];
  try {
    botMod.usarEjecutoresDePrueba({
      charlar: async ({ opciones }) => {
        opcionesCharla.push(opciones);
        opciones.onTexto('Hola, ');
        await dormir(parcial.INTERVALO_CORTO_MS + 50);
        opciones.onTexto('todo bien.\n<al');
        await dormir(parcial.INTERVALO_CORTO_MS + 50);
        opciones.onTexto('ma>\nrecordar: el mate\n</alma>');
        opciones.onTexto(' pendiente que nunca sale');
        return { ok: true, clave: 'alya', respuesta: 'Hola, todo bien.', aplicadas: [], rechazadas: [] };
      }
    });
    const ctxWeb = { chat: { id: CHAT_WEB_LOCAL, type: 'private' }, reply: async () => ({ message_id: 1 }) };
    await botMod.dispatchCharla(ctxWeb, { clave: 'alya', voz: 'Alya', texto: 'hola' });
    const limite = Date.now() + 4000;
    while (opcionesCharla.length === 0 || ((botMod.carrilOcupado('alma') || queue.getQueueLength('alma') > 0) && Date.now() < limite)) await dormir(5);
    await dormir(parcial.INTERVALO_CORTO_MS + 50);
    assert.strictEqual(opcionesCharla[0].stream, true, 'el bot pide stream a la charla');
    const parciales = eventos.filter((e) => e.tipo === 'parcial');
    const tarea = tareas.listar({ sujeto: 'alma:alya' }).at(-1);
    assert.deepStrictEqual(parciales.map((e) => e.texto), ['Hola, ', 'Hola, todo bien.\n'], `parciales: ${JSON.stringify(parciales.map((e) => e.texto))}`);
    assert(parciales.every((e) => e.tareaId === tarea.id), 'cada parcial lleva el id de su tarea');
    const ultimoParcial = eventos.lastIndexOf(parciales.at(-1));
    const cierre = eventos.findIndex((e) => e.tipo === 'tarea' && e.tarea.id === tarea.id && e.tarea.estado === 'ok');
    assert(cierre > ultimoParcial, 'ningún parcial llega después del cierre');
    assert(!canalBot.pendientes(CHAT_WEB_LOCAL).some((e) => e.tipo === 'parcial'), 'y ninguno queda en el buffer');
  } finally {
    bajaTareas();
    bajaBot();
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
  }
}
console.log('✔ Test 98 [FEAT-055]: respuesta parcial en vivo');

// Test 99 [FEAT-055]: agregar un recuerdo desde la web. Pasa por el mismo
// `aplicar` que el bloque del alma: escaneo, duplicados y tope.
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  const recuerdos = (await import('../../mcp-server/almas/recuerdos.js')).default;
  const rutas = (await import('../../mcp-server/almas/rutas.js')).default;
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-iter4-'));
  const previo = { LAGRANGE_ALMAS_DIR: process.env.LAGRANGE_ALMAS_DIR };
  process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });
  let web = null;
  try {
    // Módulo.
    const ok = botMod.agregarRecuerdo('alya', 'alma', '  le gusta el mate amargo  ');
    assert(ok.ok && /^m\d+$/.test(ok.id) && ok.texto === 'le gusta el mate amargo', `agrega con id: ${JSON.stringify(ok)}`);
    assert(recuerdos.entradas(recuerdos.leer(rutas.rutasDe('alya').memoria, 'm')).some((e) => e.id === ok.id), 'queda en memoria.md');
    const usuario = botMod.agregarRecuerdo('alya', 'usuario', 'trabaja de noche');
    assert(usuario.ok && usuario.id.startsWith('u'), 'sobre el usuario va con prefijo u');
    assert(recuerdos.entradas(recuerdos.leer(rutas.rutaUsuario(), 'u')).some((e) => e.id === usuario.id), 'y queda en usuario.md');
    assert.strictEqual(botMod.agregarRecuerdo('alya', 'otro', 'x').motivo, 'sobre');
    assert.strictEqual(botMod.agregarRecuerdo('alya', 'alma', '   ').motivo, 'texto');
    assert.strictEqual(botMod.agregarRecuerdo('alya', 'alma', 'x'.repeat(botMod.TOPE_RECUERDO + 1)).motivo, 'texto');
    assert.strictEqual(botMod.agregarRecuerdo('alya', 'alma', 'Le gusta el mate amargo').motivo, 'duplicado');
    const url = botMod.agregarRecuerdo('alya', 'alma', 'mirá https://ejemplo.com');
    assert(url.motivo === 'escaneo' && /URL/.test(url.mensaje), `el escaneo rechaza con motivo: ${JSON.stringify(url)}`);
    for (let i = 0; i < 20; i++) botMod.agregarRecuerdo('alya', 'alma', `recuerdo largo número ${i} ${'y'.repeat(150)}`);
    assert.strictEqual(botMod.agregarRecuerdo('alya', 'alma', `uno más que no entra ${'z'.repeat(200)}`).motivo, 'lleno', 'tope lleno');

    // API.
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const puerto = web.servidor.address().port;
    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const recordar = (clave, cuerpo, headers = {}) => pedirWeb(puerto, {
      metodo: 'POST', ruta: `/api/almas/${clave}/recordar`,
      headers: { ...cookie, 'content-type': 'application/json', ...headers }, cuerpo: JSON.stringify(cuerpo)
    });
    const creado = await recordar('alya', { texto: 'prefiere respuestas cortas', sobre: 'usuario' });
    assert.strictEqual(creado.status, 200, creado.texto);
    assert(creado.json().id.startsWith('u'), 'la API devuelve el id');
    assert.strictEqual((await recordar('alya', { texto: 'prefiere respuestas cortas', sobre: 'usuario' })).status, 409, 'duplicado → 409');
    assert.strictEqual((await recordar('alya', { texto: `otro más ${'w'.repeat(200)}`, sobre: 'alma' })).status, 409, 'lleno → 409');
    assert.strictEqual((await recordar('alya', { texto: '', sobre: 'usuario' })).status, 400, 'vacío → 400');
    assert.strictEqual((await recordar('alya', { texto: 'x', sobre: 'nadie' })).status, 400, 'sobre inválido → 400');
    assert.strictEqual((await recordar('nadie', { texto: 'x', sobre: 'alma' })).status, 404, 'alma inexistente → 404');
    assert.strictEqual((await recordar('alya', { texto: 'x', sobre: 'usuario' }, { origin: 'http://evil.example' })).status, 403, 'origen ajeno → 403');
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 99 [FEAT-055]: agregar un recuerdo desde la web');

// Test 100 [FEAT-055]: fan-out en el tablero. Lectura asíncrona con ventana y
// lista cerrada de campos; en el núcleo, un tiempo máximo por workspace, una
// sola lectura en vuelo por workspace y la lista de workspaces en caché; en la
// API, sin rutas.
{
  const fanoutEstado = (await import('../../mcp-server/fanout-estado.js')).default;
  const { crearNucleoWeb } = await import('../web/nucleo.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-fanout-'));
  const repo = path.join(raiz, 'repo');
  const dirEstado = path.join(repo, '.claude', 'worktrees');
  fs.mkdirSync(dirEstado, { recursive: true });
  const ahora = Date.parse('2026-09-16T12:00:00Z');
  const hace = (h) => new Date(ahora - h * 3600 * 1000).toISOString();
  const lote = (slug, datos) => fs.writeFileSync(path.join(dirEstado, `.fanout-status-${slug}.json`), JSON.stringify({ slug, ...datos }));
  lote('reciente', {
    iniciado: hace(2), actualizado: hace(1), terminado: hace(1),
    tareas: { a: { estado: 'ok', intentos: 1, error: 'C:\\secreto\\ruta.js explotó' }, b: { estado: 'error', detenido: true, porCuota: false }, c: { estado: 'raro' } }
  });
  lote('viejo', { iniciado: hace(50), actualizado: hace(48), terminado: hace(48), tareas: { a: { estado: 'ok' } } });
  lote('colgado', { iniciado: hace(50), actualizado: hace(49), terminado: null, tareas: { a: { estado: 'corriendo', inicio: hace(49) } } });
  fs.writeFileSync(path.join(dirEstado, '.fanout-status-roto.json'), '{no es json');

  try {
    const r = await fanoutEstado.detalleLotes(repo, { ahora });
    assert.deepStrictEqual(r.lotes.map((l) => l.slug), ['reciente', 'colgado'], `ventana de 24 h salvo los activos: ${JSON.stringify(r.lotes.map((l) => l.slug))}`);
    assert.strictEqual(r.ilegibles, 1, 'un archivo roto se cuenta y no rompe');
    const reciente = r.lotes[0];
    assert.deepStrictEqual(reciente.tareas.map((t) => t.estado), ['ok', 'error', 'desconocido'], 'estados de una lista cerrada');
    assert.strictEqual(reciente.tareas[1].detenido, true);
    assert(!JSON.stringify(r).includes('secreto') && !JSON.stringify(r).includes('porCuota'), 'ni el error ni campos ajenos');
    assert.strictEqual(r.lotes[1].estado, 'activo');
    assert.strictEqual((await fanoutEstado.detalleLotes(repo, { ahora, maximo: 1 })).lotes.length, 1, 'respeta el máximo');
    assert.deepStrictEqual(await fanoutEstado.detalleLotes(path.join(raiz, 'no-existe'), { ahora }), { lotes: [], ilegibles: 0 }, 'sin carpeta, vacío');

    // Núcleo con lectores falsos.
    let listados = 0;
    let reloj = 0;
    const lecturas = { rapido: 0, colgado: 0, roto: 0 };
    const nucleo = crearNucleoWeb({
      canal: crearCanalWeb(),
      bot: {},
      almas: {},
      workspaces: () => {
        listados++;
        return [
          { id: 'w1', name: 'rapido', path: 'R:/rapido' },
          { id: 'w2', name: 'colgado', displayName: 'Disco dormido', path: 'N:/colgado' },
          { id: 'w3', name: 'roto', path: 'R:/roto' }
        ];
      },
      fanout: {
        limiteMs: 60,
        ttlWorkspacesMs: 1000,
        ahora: () => reloj,
        leerLotes: (ruta) => {
          const nombre = path.basename(ruta);
          lecturas[nombre]++;
          if (nombre === 'colgado') return new Promise(() => {});
          if (nombre === 'roto') return Promise.reject(new Error('EIO'));
          return Promise.resolve({ lotes: [{ slug: 'l1', actualizado: hace(1), tareas: [] }] });
        }
      }
    });
    const inicio = Date.now();
    const primera = await nucleo.fanout();
    assert(Date.now() - inicio < 1000, 'un workspace colgado no demora la respuesta más que el límite');
    assert.deepStrictEqual(primera.lentos, ['Disco dormido'], 'el colgado queda como lento');
    assert.deepStrictEqual(primera.lotes.map((l) => l.workspace), [{ id: 'w1', nombre: 'rapido' }], 'el lote lleva el workspace sin ruta');
    assert(!JSON.stringify(primera).includes('R:/'), 'ninguna ruta en la respuesta');
    await nucleo.fanout();
    await nucleo.fanout();
    assert.strictEqual(lecturas.colgado, 1, 'con una lectura en vuelo no se lanza otra');
    assert.strictEqual(lecturas.rapido, 3, 'los demás se leen en cada sondeo');
    assert.strictEqual(lecturas.roto, 3, 'una lectura que falla no queda en vuelo');
    assert.strictEqual(listados, 1, 'la lista de workspaces sale de la caché');
    reloj = 1000;
    await nucleo.fanout();
    assert.strictEqual(listados, 2, 'y se renueva al vencer');

    // API: la ruta existe y no expone rutas.
    const botMod = await import('../bot.js');
    const home = path.join(raiz, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
    const previo = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    lote('ahora', { iniciado: new Date().toISOString(), actualizado: new Date().toISOString(), terminado: null, tareas: { x: { estado: 'corriendo' } } });
    let web = null;
    try {
      botMod.resetRuntimeState();
      web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
      const puerto = web.servidor.address().port;
      const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
      const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
      const res = await pedirWeb(puerto, { ruta: '/api/fanout', headers: cookie });
      assert.strictEqual(res.status, 200, res.texto);
      const cuerpo = res.json();
      assert(cuerpo.lotes.some((l) => l.slug === 'ahora' && l.workspace.nombre), `el lote activo aparece: ${res.texto.slice(0, 300)}`);
      assert(!res.texto.includes(raiz.replace(/\\/g, '\\\\')) && !res.texto.includes('repo\\\\') && !res.texto.includes('"path"'), 'la API no devuelve rutas');
      assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/fanout' })).status, 401, 'sin sesión no hay datos');
    } finally {
      if (web) await new Promise((r) => web.servidor.close(r));
      botMod.resetRuntimeState();
      for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 100 [FEAT-055]: fan-out en el tablero, sin rutas y sin congelar el daemon');

// Test 101 [FEAT-055]: escuchar la respuesta de una tarea. Solo charlas y casts
// terminados, una síntesis por vez, el archivo se borra y la API devuelve el
// audio con las cabeceras de siempre.
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const { CSP } = await import('../web/servidor.js');
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-voz-'));
  const WAV = Buffer.from('RIFF....WAVEfmt prueba');
  const pedidos = [];
  let pendiente = null;
  let respuesta = null;
  botMod.usarEjecutoresDePrueba({
    sintetizar: async (op) => {
      pedidos.push(op);
      if (pendiente) await pendiente;
      if (respuesta) return respuesta;
      const ruta = path.join(raiz, `voz-${pedidos.length}.wav`);
      fs.writeFileSync(ruta, WAV);
      return { ok: true, wavPath: ruta, perfil: 'Alya' };
    }
  });
  const cerrada = (datos, cambios) => {
    const t = tareas.crear({ origen: 'web', pedido: 'p', ...datos });
    tareas.actualizar(t.id, cambios);
    return t.id;
  };
  const alma = { carril: 'alma', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' } };
  const agente = { carril: 'cast', sujeto: { tipo: 'agente', nombre: 'lector' } };
  let web = null;
  try {
    assert(CSP.includes("media-src 'self' blob:"), 'la CSP admite audio desde un Blob');

    const deAlma = cerrada(alma, { estado: 'ok', resultado: '**Hola**, todo bien.' });
    const r = await botMod.escucharTarea(deAlma);
    assert(r.ok && r.audio.equals(WAV), `devuelve el audio: ${JSON.stringify(r).slice(0, 200)}`);
    assert.strictEqual(pedidos[0].voz, 'Alya', 'con la voz del alma');
    assert.strictEqual(pedidos[0].texto, '**Hola**, todo bien.', 'el saneado lo hace sintetizar');
    assert(!fs.existsSync(path.join(raiz, 'voz-1.wav')), 'el archivo se borra');

    const deCast = cerrada(agente, { estado: 'ok', resultado: 'Revisé todo.' });
    assert((await botMod.escucharTarea(deCast)).ok && pedidos[1].voz === null, 'un cast usa la voz por defecto');

    assert.strictEqual((await botMod.escucharTarea('t_noexiste')).codigo, 404);
    assert.strictEqual((await botMod.escucharTarea(cerrada({ carril: 'principal', sujeto: { tipo: 'trabajo' } }, { estado: 'ok' }))).codigo, 400, 'el trabajo no se escucha');
    assert.strictEqual((await botMod.escucharTarea(cerrada(alma, { estado: 'error', error: 'x' }))).codigo, 400, 'una tarea fallida no se escucha');
    assert.strictEqual((await botMod.escucharTarea(tareas.crear({ origen: 'web', pedido: 'p', ...alma }).id)).codigo, 400, 'una abierta tampoco');
    assert.strictEqual(pedidos.length, 2, 'ninguno de esos sintetizó');

    // Una por vez: la segunda recibe 409 mientras la primera sigue.
    let soltar;
    pendiente = new Promise((res) => { soltar = res; });
    const primera = botMod.escucharTarea(deAlma);
    await new Promise((res) => setImmediate(res));
    assert.strictEqual((await botMod.escucharTarea(deCast)).codigo, 409, 'una síntesis por vez');
    soltar();
    pendiente = null;
    assert((await primera).ok, 'la primera termina bien');

    // Pasado el límite: 504, y el cerrojo sigue tomado hasta que termine de verdad.
    let soltarLenta;
    pendiente = new Promise((res) => { soltarLenta = res; });
    const lenta = await botMod.escucharTarea(deAlma, { limiteMs: 30 });
    assert.strictEqual(lenta.codigo, 504, 'vencida');
    assert.strictEqual((await botMod.escucharTarea(deAlma)).codigo, 409, 'el cerrojo espera a la síntesis real');
    const antes = fs.readdirSync(raiz).length;
    soltarLenta();
    pendiente = null;
    const limite = Date.now() + 2000;
    while ((await botMod.escucharTarea(deCast)).codigo === 409 && Date.now() < limite) await new Promise((res) => setTimeout(res, 10));
    assert.strictEqual(fs.readdirSync(raiz).length, antes, 'y el archivo de la vencida también se borra');

    respuesta = { ok: false, motivo: 'provider_unavailable', detalle: `sin Voicebox ${FAKE_TOKEN}` };
    const sinVoz = await botMod.escucharTarea(deAlma);
    assert(sinVoz.codigo === 503 && /voz disponible/.test(sinVoz.error) && !sinVoz.error.includes(FAKE_TOKEN), `sin voz: 503 redactado: ${sinVoz.error}`);
    respuesta = { ok: false, motivo: 'texto_vacio' };
    assert.strictEqual((await botMod.escucharTarea(deAlma)).codigo, 400, 'nada que leer');
    respuesta = { ok: false, motivo: 'sin_archivo' };
    assert.strictEqual((await botMod.escucharTarea(deAlma)).codigo, 502, 'la voz no entregó');
    respuesta = null;

    // API.
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const puerto = web.servidor.address().port;
    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const escuchar = (id, headers = {}) => pedirWeb(puerto, {
      metodo: 'POST', ruta: `/api/tareas/${id}/escuchar`,
      headers: { ...cookie, 'content-type': 'application/json', ...headers }, cuerpo: '{}'
    });
    const ok = await escuchar(deAlma);
    assert.strictEqual(ok.status, 200, ok.texto);
    assert.strictEqual(ok.headers['content-type'], 'audio/wav');
    assert(ok.headers['x-content-type-options'] === 'nosniff' && ok.headers['cache-control'] === 'no-store', 'con las cabeceras base');
    assert.strictEqual(Buffer.from(ok.texto, 'utf8').length > 0, true);
    assert.strictEqual((await escuchar('t_noexiste')).status, 404);
    assert.strictEqual((await escuchar('../x')).status, 404, 'un id raro no llega a la ruta');
    assert.strictEqual((await escuchar('T-MAL')).status, 400, 'id inválido');
    const pedidosAntes = pedidos.length;
    assert.strictEqual((await escuchar(deAlma, { origin: 'http://evil.example' })).status, 403, 'origen ajeno');
    assert.strictEqual(pedidos.length, pedidosAntes, 'y no sintetizó');
    assert.strictEqual((await pedirWeb(puerto, { metodo: 'GET', ruta: `/api/tareas/${deAlma}/escuchar`, headers: cookie })).status, 405, 'GET no');
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 101 [FEAT-055]: escuchar la respuesta de una tarea');

// Test 102 [FEAT-056]: preparar la voz. Voz del alma o la de siempre, el
// cerrojo compartido con escuchar, el límite y la API.
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-prep-'));
  const previo = { LAGRANGE_ALMAS_DIR: process.env.LAGRANGE_ALMAS_DIR };
  process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });
  const pedidos = [];
  let pendiente = null;
  let respuesta = null;
  botMod.usarEjecutoresDePrueba({
    prepararVoz: async (op) => {
      pedidos.push(op);
      if (pendiente) await pendiente;
      return respuesta || { ok: true, perfil: op.voz || 'Diego', proveedor: 'omnivoice', precargado: true };
    },
    sintetizar: async () => {
      const ruta = path.join(raiz, `voz-${Date.now()}.wav`);
      fs.writeFileSync(ruta, 'RIFF');
      return { ok: true, wavPath: ruta };
    }
  });
  let web = null;
  try {
    const r = await botMod.prepararVoz({ voz: 'Alya' });
    assert(r.ok && r.perfil === 'Alya' && r.precargado === true, `prepara: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(pedidos[0], { voz: 'Alya' });

    // Cerrojo compartido, en los dos sentidos.
    let soltar;
    pendiente = new Promise((res) => { soltar = res; });
    const enCurso = botMod.prepararVoz({});
    await new Promise((res) => setImmediate(res));
    assert.strictEqual((await botMod.prepararVoz({})).codigo, 409, 'dos preparaciones a la vez no');
    const tarea = tareas.crear({ origen: 'web', pedido: 'p', carril: 'alma', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' } });
    tareas.actualizar(tarea.id, { estado: 'ok', resultado: 'Hola.' });
    assert.strictEqual((await botMod.escucharTarea(tarea.id)).codigo, 409, 'ni escuchar mientras se prepara');
    soltar();
    pendiente = null;
    assert((await enCurso).ok);
    let soltarLectura;
    botMod.usarEjecutoresDePrueba({
      prepararVoz: async () => ({ ok: true }),
      sintetizar: async () => { await new Promise((res) => { soltarLectura = res; }); return { ok: false, motivo: 'generacion' }; }
    });
    const lectura = botMod.escucharTarea(tarea.id);
    await new Promise((res) => setImmediate(res));
    assert.strictEqual((await botMod.prepararVoz({})).codigo, 409, 'ni preparar mientras se escucha');
    soltarLectura();
    await lectura;

    // Límite: 504 y el cerrojo espera a que termine.
    let soltarLenta;
    botMod.usarEjecutoresDePrueba({ prepararVoz: async () => { await new Promise((res) => { soltarLenta = res; }); return { ok: true }; } });
    assert.strictEqual((await botMod.prepararVoz({}, { limiteMs: 30 })).codigo, 504, 'vencida');
    assert.strictEqual((await botMod.prepararVoz({})).codigo, 409, 'el cerrojo sigue tomado');
    soltarLenta();
    await new Promise((res) => setTimeout(res, 20));

    botMod.usarEjecutoresDePrueba({
      prepararVoz: async (op) => { pedidos.push(op); return respuesta || { ok: true, perfil: op.voz || 'Diego', proveedor: 'voicebox', precargado: false }; }
    });
    respuesta = { ok: false, motivo: 'vram_blocked', detalle: `sin VRAM ${FAKE_TOKEN}` };
    const sinVram = await botMod.prepararVoz({});
    assert(sinVram.codigo === 503 && /VRAM/.test(sinVram.error) && !sinVram.error.includes(FAKE_TOKEN), `sin VRAM: ${sinVram.error}`);
    respuesta = { ok: false, motivo: 'carga', detalle: 'HTTP 500' };
    assert.strictEqual((await botMod.prepararVoz({})).codigo, 502, 'la carga falló');
    respuesta = null;

    // API.
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const puerto = web.servidor.address().port;
    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const preparar = (cuerpo, headers = {}) => pedirWeb(puerto, {
      metodo: 'POST', ruta: '/api/voz/preparar',
      headers: { ...cookie, 'content-type': 'application/json', ...headers }, cuerpo: JSON.stringify(cuerpo)
    });
    const antes = pedidos.length;
    const conAlma = await preparar({ clave: 'alya' });
    assert.strictEqual(conAlma.status, 200, conAlma.texto);
    assert.deepStrictEqual(conAlma.json(), { ok: true, perfil: 'Alya', proveedor: 'voicebox', precargado: false });
    assert.strictEqual(pedidos.at(-1).voz, 'Alya', 'la clave se traduce a la voz del alma');
    const sinClave = await preparar({});
    assert(sinClave.status === 200 && pedidos.at(-1).voz === null, 'sin clave, la voz de siempre');
    assert.strictEqual((await preparar({ clave: '../x' })).status, 400, 'clave inválida');
    assert.strictEqual((await preparar({ clave: 'nadie' })).status, 404, 'alma inexistente');
    assert.strictEqual((await preparar({}, { origin: 'http://evil.example' })).status, 403, 'origen ajeno');
    assert.strictEqual(pedidos.length, antes + 2, 'solo las dos válidas prepararon');
    assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/voz/preparar', headers: cookie })).status, 405, 'GET no');
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 102 [FEAT-056]: preparar la voz');

// Test 103 [FEAT-057]: el registro v2. Migración por campo (sin pisar), una
// versión futura en solo lectura, topes separados, tarjetas de Por hacer,
// notas, "volver a Por hacer", eventos y búsqueda.
{
  const tareas = await import('../tareas.js');
  const ruta = tareas.rutaTareas();
  const leerDisco = () => JSON.parse(fs.readFileSync(ruta, 'utf8'));
  const silenciar = (fn) => {
    const original = console.error;
    console.error = () => {};
    try { return fn(); } finally { console.error = original; }
  };
  const alma = { tipo: 'alma', clave: 'alya', voz: 'Alya' };
  const agente = { tipo: 'agente', nombre: 'lector' };
  tareas.reiniciarParaTests();

  try {
    // Migración: una v1 sin campos nuevos y otra que un daemon viejo reescribió
    // conservando los campos de la v2.
    fs.writeFileSync(ruta, JSON.stringify({
      version: 1,
      tareas: [
        { id: 't_viejo1', carril: 'alma', origen: 'telegram', sujeto: alma, pedido: 'hola', estado: 'ok', creada: '2026-09-01T10:00:00.000Z', iniciada: '2026-09-01T10:00:01.000Z', terminada: '2026-09-01T10:00:09.000Z' },
        { id: 't_viejo2', carril: 'cast', origen: 'web', sujeto: agente, pedido: 'x', estado: 'error', creada: '2026-09-02T10:00:00.000Z', terminada: '2026-09-02T10:01:00.000Z', titulo: 'Con título', creadaPor: 'usuario', madre: 't_otra', notas: [{ id: 'n_1', t: '2026-09-02T11:00:00.000Z', autor: 'usuario', texto: 'nota vieja' }], eventos: [{ t: '2026-09-02T10:00:00.000Z', tipo: 'creada' }], actualizada: '2026-09-02T11:00:00.000Z' }
      ]
    }));
    const [v1, rescatada] = tareas.listar();
    assert.deepStrictEqual([v1.titulo, v1.creadaPor, v1.madre, v1.notas, v1.actualizada], [null, 'cola', null, [], '2026-09-01T10:00:09.000Z'], 'campos nuevos con sus valores por defecto');
    assert.deepStrictEqual(v1.eventos.map((e) => e.tipo), ['creada', 'en_curso', 'ok'], 'eventos reconstruidos');
    assert.strictEqual(v1.propuesta, false, 'FEAT-058: propuesta se completa en false');
    assert.deepStrictEqual(
      [rescatada.titulo, rescatada.creadaPor, rescatada.madre, rescatada.notas.length, rescatada.eventos.length, rescatada.actualizada],
      ['Con título', 'usuario', 't_otra', 1, 1, '2026-09-02T11:00:00.000Z'],
      'lo que ya estaba no se pisa, aunque el archivo diga versión 1');
    tareas.agregarNota('t_viejo1', 'dispara una escritura');
    const disco = leerDisco();
    assert.strictEqual(disco.version, tareas.VERSION, 'se guarda como v2');
    assert.strictEqual(disco.tareas[1].notas[0].texto, 'nota vieja');

    // Versión futura: se lee, no se escribe.
    fs.writeFileSync(ruta, JSON.stringify({ version: 3, tareas: [{ id: 't_futuro', estado: 'por_hacer', pedido: 'del futuro', campoNuevo: 1 }] }));
    const crudo = fs.readFileSync(ruta, 'utf8');
    tareas.reiniciarParaTests();
    silenciar(() => {
      assert.strictEqual(tareas.listar()[0].pedido, 'del futuro', 'se lee');
      assert.strictEqual(tareas.crearTarjeta({ pedido: 'nueva' }).codigo, 503, 'no se crean tarjetas');
      assert.strictEqual(tareas.agregarNota('t_futuro', 'x').codigo, 503);
      assert.strictEqual(tareas.lanzarTarjeta('t_futuro', { carril: 'alma', sujeto: alma }), null);
      tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: 'de la cola' });
    });
    assert.strictEqual(fs.readFileSync(ruta, 'utf8'), crudo, 'el archivo no se tocó');

    // Topes: las cerradas por su lado, Por hacer por el suyo.
    fs.rmSync(ruta, { force: true });
    tareas.reiniciarParaTests();
    for (let i = 0; i < 5; i++) assert(tareas.crearTarjeta({ pedido: `tarjeta ${i}`, sujeto: alma }).ok);
    const abierta = tareas.crear({ carril: 'cast', origen: 'web', sujeto: agente, pedido: 'abierta' });
    for (let i = 0; i < 250; i++) {
      const t = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: `c${i}` });
      tareas.actualizar(t.id, { estado: 'ok' });
    }
    let todas = tareas.listar();
    assert.strictEqual(todas.filter((t) => t.estado === 'ok').length, tareas.TOPE_TAREAS, 'quedan 200 cerradas');
    assert.strictEqual(todas.filter((t) => t.estado === tareas.POR_HACER).length, 5, 'y las 5 de Por hacer');
    assert(todas.some((t) => t.id === abierta.id), 'y la abierta');
    assert.strictEqual(todas.find((t) => t.estado === 'ok').pedido, 'c50', 'se fueron las más viejas');
    for (let i = 5; i < tareas.TOPE_POR_HACER; i++) tareas.crearTarjeta({ pedido: `relleno ${i}` });
    assert.strictEqual(tareas.crearTarjeta({ pedido: 'la 101' }).codigo, 409, 'la 101 no entra');
    const fallida = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: 'falló' });
    tareas.actualizar(fallida.id, { estado: 'error', error: 'x' });
    assert.strictEqual(tareas.devolver(fallida.id).codigo, 409, 'devolver tampoco supera el tope');

    // Tarjetas.
    fs.rmSync(ruta, { force: true });
    tareas.reiniciarParaTests();
    const avisos = [];
    const baja = tareas.suscribir((t, info) => avisos.push([t.id, t.estado, Boolean(info?.borrada)]));
    for (const [datos, motivo] of [
      [{}, 'sin pedido'],
      [{ pedido: '   ' }, 'pedido vacío'],
      [{ pedido: 'x'.repeat(tareas.TOPE_TEXTO + 1) }, 'pedido largo'],
      [{ pedido: 'x', titulo: 't'.repeat(tareas.TOPE_TITULO + 1) }, 'título largo'],
      [{ pedido: 'x', titulo: 5 }, 'título que no es texto'],
      [{ pedido: 'x', sujeto: { tipo: 'trabajo' } }, 'el trabajo no se asigna'],
      [{ pedido: 'x', sujeto: { tipo: 'alma' } }, 'alma sin clave']
    ]) {
      assert.strictEqual(tareas.crearTarjeta(datos).codigo, 400, motivo);
    }
    const sinAsignar = tareas.crearTarjeta({ titulo: '  Idea  ', pedido: `pensá ${FAKE_TOKEN}` }).tarea;
    assert.deepStrictEqual(
      [sinAsignar.estado, sinAsignar.titulo, sinAsignar.sujeto, sinAsignar.carril, sinAsignar.origen, sinAsignar.creadaPor, sinAsignar.madre],
      ['por_hacer', 'Idea', null, null, 'web', 'usuario', null]);
    assert(!sinAsignar.pedido.includes(FAKE_TOKEN), 'redactada');
    const paraAlma = tareas.crearTarjeta({ pedido: 'charlá', sujeto: alma, proyecto: 'app', workspaceId: 'w1' }).tarea;
    assert.deepStrictEqual([paraAlma.proyecto, paraAlma.workspaceId], [null, null], 'una tarjeta de alma no guarda proyecto');
    const paraAgente = tareas.crearTarjeta({ pedido: 'revisá', sujeto: agente, proyecto: 'app', workspaceId: 'w1' }).tarea;
    assert.deepStrictEqual([paraAgente.proyecto, paraAgente.workspaceId], ['app', 'w1'], 'la de agente guarda el id del proyecto');
    assert.strictEqual(leerDisco().tareas.length, 3, 'se escribe en el acto');

    // Editar: solo lo permitido, con evento.
    const editada = tareas.editarTarjeta(sinAsignar.id, { titulo: '', pedido: 'pensá mejor', sujeto: agente, workspaceId: 'w2', proyecto: 'otro', estado: 'ok', carril: 'x' });
    assert(editada.ok);
    assert.deepStrictEqual(
      [editada.tarea.titulo, editada.tarea.pedido, editada.tarea.sujeto, editada.tarea.workspaceId, editada.tarea.estado, editada.tarea.carril],
      [null, 'pensá mejor', agente, 'w2', 'por_hacer', null]);
    assert.deepStrictEqual(editada.tarea.eventos.map((e) => e.tipo), ['creada', 'editada']);
    assert.strictEqual(tareas.editarTarjeta(sinAsignar.id, { pedido: '' }).codigo, 400);
    assert.strictEqual(tareas.editarTarjeta(sinAsignar.id, { sujeto: alma }).tarea.workspaceId, null, 'pasar a un alma suelta el proyecto');
    assert.strictEqual(tareas.editarTarjeta('t_nadie', {}).codigo, 404);
    assert.strictEqual(tareas.actualizar(paraAlma.id, { estado: 'ok' }), null, 'actualizar no mueve una tarjeta');
    assert.strictEqual(tareas.recuperarAlArrancar(), 0, 'un reinicio no toca Por hacer');
    assert.strictEqual(tareas.obtener(paraAlma.id).estado, 'por_hacer');

    // Lanzar: una sola vez, con el sujeto de la tarjeta, nunca al carril principal.
    assert.strictEqual(tareas.lanzarTarjeta(paraAlma.id, { carril: 'alma', sujeto: agente }), null, 'otro sujeto');
    assert.strictEqual(tareas.lanzarTarjeta(paraAlma.id, { carril: 'principal', sujeto: alma }), null, 'el carril principal no');
    assert.strictEqual(tareas.lanzarTarjeta(paraAlma.id, { carril: 'alma', sujeto: null }), null, 'sin sujeto');
    const lanzada = tareas.lanzarTarjeta(paraAlma.id, { carril: 'alma', sujeto: alma });
    assert.deepStrictEqual([lanzada.estado, lanzada.carril, lanzada.eventos.at(-1).tipo], ['en_cola', 'alma', 'lanzada']);
    assert.strictEqual(tareas.lanzarTarjeta(paraAlma.id, { carril: 'alma', sujeto: alma }), null, 'el segundo lanzamiento falla');
    assert.strictEqual(tareas.editarTarjeta(paraAlma.id, { pedido: 'tarde' }).codigo, 409, 'lanzada ya no se edita');
    assert.strictEqual(tareas.borrarTarjeta(paraAlma.id).codigo, 409, 'ni se borra');
    const sinSujeto = tareas.crearTarjeta({ pedido: 'nadie' }).tarea;
    assert.strictEqual(tareas.lanzarTarjeta(sinSujeto.id, { carril: 'alma', sujeto: alma }), null, 'una sin asignar no se lanza');

    // Borrar.
    assert.deepStrictEqual(tareas.borrarTarjeta(sinSujeto.id), { ok: true });
    assert.strictEqual(tareas.obtener(sinSujeto.id), null);
    assert.deepStrictEqual(avisos.at(-1), [sinSujeto.id, 'por_hacer', true], 'la baja se avisa');
    assert(!leerDisco().tareas.some((t) => t.id === sinSujeto.id), 'y sale del disco');
    assert.strictEqual(tareas.borrarTarjeta(sinSujeto.id).codigo, 404);
    baja();

    // Ciclo de eventos completo.
    tareas.actualizar(paraAlma.id, { estado: 'en_curso' });
    tareas.actualizar(paraAlma.id, { estado: 'en_curso' });
    tareas.actualizar(paraAlma.id, { estado: 'ok', resultado: 'listo' });
    assert.deepStrictEqual(tareas.obtener(paraAlma.id).eventos.map((e) => e.tipo), ['creada', 'lanzada', 'en_curso', 'ok'], 'un evento por cambio de estado');

    // Notas: en cualquier estado, redactadas, con tope.
    assert.strictEqual(tareas.agregarNota(paraAlma.id, '').codigo, 400);
    assert.strictEqual(tareas.agregarNota(paraAlma.id, 'n'.repeat(tareas.TOPE_NOTA + 1)).codigo, 400);
    assert.strictEqual(tareas.agregarNota(paraAlma.id, 7).codigo, 400);
    assert.strictEqual(tareas.agregarNota('t_nadie', 'x').codigo, 404);
    const conNota = tareas.agregarNota(paraAlma.id, ` revisar el token ${FAKE_TOKEN} `);
    assert(conNota.ok && conNota.nota.id.startsWith('n_') && conNota.nota.autor === 'usuario');
    assert(!conNota.nota.texto.includes(FAKE_TOKEN), 'nota redactada');
    for (let i = 0; i < tareas.TOPE_NOTAS + 5; i++) tareas.agregarNota(paraAlma.id, `nota ${i}`);
    const anotada = tareas.obtener(paraAlma.id);
    assert.strictEqual(anotada.notas.length, tareas.TOPE_NOTAS, 'tope de notas');
    assert.strictEqual(anotada.notas[0].texto, 'nota 5', 'se van las más viejas');
    assert.strictEqual(anotada.eventos.length, tareas.TOPE_EVENTOS, 'tope de eventos');
    assert.strictEqual(anotada.eventos.at(-1).tipo, 'nota');
    tareas.agregarNota(paraAgente.id, 'una nota en Por hacer');

    // Resumen: los campos nuevos, sin notas ni historial.
    const r = tareas.resumen(anotada);
    assert(!('notas' in r) && !('eventos' in r) && !('resultado' in r), 'sin textos largos');
    assert.deepStrictEqual([r.cantidadNotas, r.ultimoEvento.tipo, r.titulo, r.creadaPor, r.madre], [tareas.TOPE_NOTAS, 'nota', null, 'usuario', null]);

    // Volver a Por hacer.
    const cast = tareas.crear({ carril: 'cast', origen: 'telegram', sujeto: agente, pedido: 'revisá el módulo', proyecto: 'app', workspaceId: 'w9' });
    tareas.actualizar(cast.id, { estado: 'error', error: 'falló' });
    const antes = JSON.parse(JSON.stringify(tareas.obtener(cast.id)));
    const devuelta = tareas.devolver(cast.id);
    assert(devuelta.ok);
    const hija = devuelta.tarea;
    assert.deepStrictEqual(
      [hija.estado, hija.pedido, hija.sujeto, hija.workspaceId, hija.proyecto, hija.madre, hija.creadaPor, hija.origen],
      ['por_hacer', 'revisá el módulo', agente, 'w9', 'app', cast.id, 'usuario', 'web']);
    assert.deepStrictEqual(hija.eventos.map((e) => [e.tipo, e.detalle || null]), [['creada', null], ['devuelta', cast.id]]);
    const despues = tareas.obtener(cast.id);
    assert.deepStrictEqual(despues.eventos.at(-1).detalle, hija.id, 'la original anota a dónde volvió');
    assert.deepStrictEqual({ ...despues, eventos: null }, { ...antes, eventos: null }, 'y no cambia nada más');
    const deAlma = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: 'hola' });
    tareas.actualizar(deAlma.id, { estado: 'cancelada' });
    assert.deepStrictEqual(tareas.devolver(deAlma.id).tarea.sujeto, alma, 'un alma conserva clave y voz');
    const bien = tareas.crear({ carril: 'alma', origen: 'web', sujeto: alma, pedido: 'ok' });
    tareas.actualizar(bien.id, { estado: 'ok' });
    assert.strictEqual(tareas.devolver(bien.id).codigo, 409, 'lo que salió bien no vuelve');
    assert.strictEqual(tareas.devolver(hija.id).codigo, 409, 'una tarjeta de Por hacer tampoco');
    const trabajo = tareas.crear({ carril: 'principal', origen: 'telegram', sujeto: { tipo: 'trabajo', modo: 'plan' }, pedido: 'x' });
    tareas.actualizar(trabajo.id, { estado: 'error' });
    assert.strictEqual(tareas.devolver(trabajo.id).codigo, 400, 'el trabajo no');
    const reaccion = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: alma, pedido: 'reaccionó con 👍', motivo: 'reaccion' });
    tareas.actualizar(reaccion.id, { estado: 'error' });
    assert.strictEqual(tareas.devolver(reaccion.id).codigo, 400, 'una reacción no');
    assert.strictEqual(tareas.devolver('t_nadie').codigo, 404);

    // Búsqueda: título, pedido completo y notas, sin tildes ni mayúsculas.
    const larga = tareas.crearTarjeta({ titulo: 'Migración', pedido: `${'x'.repeat(400)} AGUJA escondida` }).tarea;
    const ids = (q) => tareas.buscar(q).map((t) => t.id);
    assert.deepStrictEqual(ids('aguja'), [larga.id], 'encuentra en el pedido completo');
    assert.deepStrictEqual(ids('MIGRACION'), [larga.id], 'sin tildes ni mayúsculas');
    assert.deepStrictEqual(ids('en por hacér'), [paraAgente.id], 'encuentra por nota');
    assert.strictEqual(ids('   ').length, tareas.listar().length, 'sin consulta, todas');
    assert.deepStrictEqual(ids('no aparece en ningún lado'), []);
  } finally {
    tareas.reiniciarParaTests();
    fs.rmSync(ruta, { force: true });
  }
}
console.log('✔ Test 103 [FEAT-057]: registro v2, tarjetas, notas y eventos');

// Test 104 [FEAT-057]: lanzar una tarjeta por la cola de siempre (una sola vez
// aunque lleguen dos clics), validando al lanzar; y la API de tarjetas, detalle,
// notas, búsqueda y "volver a Por hacer".
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  const { crearCtxWeb, crearCanalWeb } = await import('../web/canal.js');
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  try { fs.rmSync(tareas.rutaTareas(), { force: true }); } catch {}

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-tablero-'));
  const home = path.join(raiz, 'home');
  const proyecto = path.join(raiz, 'proyecto');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(proyecto);
  const registro = path.join(home, '.claude', 'antigravity-agents.json');
  const agentes = (lectorSoloLectura) => fs.writeFileSync(registro, JSON.stringify({
    agents: { lector: { skill: 's', read_only: lectorSoloLectura }, escritor: { skill: 's', read_only: false } }
  }));
  agentes(true);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [proyecto]: { hasTrustDialogAccepted: true } } }));
  const previo = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, LAGRANGE_ALMAS_DIR: process.env.LAGRANGE_ALMAS_DIR,
    TELEGRAM_BRIDGE_DATA_DIR: process.env.TELEGRAM_BRIDGE_DATA_DIR };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
  process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'bridge-data');
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });

  const charlas = [];
  const casts = [];
  botMod.usarEjecutoresDePrueba({
    charlar: ({ clave, texto, opciones }) => new Promise((resolve) => {
      opciones.onSpawn(() => { resolve({ ok: false, cancelled: true }); return true; });
      charlas.push({ texto, terminar: () => resolve({ ok: true, clave, respuesta: 'hecho', aplicadas: [], rechazadas: [] }) });
    }),
    castear: async (op) => { casts.push(op); return { ok: false, error: 'el cast falló' }; }
  });
  const esperar = async (cond, motivo) => {
    const limite = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > limite) throw new Error(`Test 104: no se cumplió a tiempo: ${motivo}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const libre = (c) => () => !botMod.carrilOcupado(c) && queue.getQueueLength(c) === 0;
  const enCola = (c, id) => queue.getQueueSnapshot(c).filter((t) => t.tareaId === id).length;
  let web = null;

  try {
    // Lanzar desde el bot, sin HTTP.
    const ctx = crearCtxWeb(crearCanalWeb());
    const alya = { tipo: 'alma', clave: 'alya', voz: 'Alya' };
    const larga = `${'pedido largo '.repeat(400)}FIN`;
    const deAlma = tareas.crearTarjeta({ pedido: larga, sujeto: alya }).tarea;
    assert.deepStrictEqual(await botMod.lanzarTarjetaWeb(deAlma.id, ctx), { ok: true });
    await esperar(() => charlas.length === 1, 'la charla arranca');
    assert.strictEqual(charlas[0].texto, larga, 'la charla recibe el pedido completo');
    assert.deepStrictEqual([tareas.obtener(deAlma.id).estado, tareas.obtener(deAlma.id).carril], ['en_curso', 'alma'], 'la tarjeta es la tarea');
    assert.strictEqual(tareas.listar().length, 1, 'no se creó otra tarea');

    // Dos lanzamientos seguidos: uno solo llega a la cola.
    const doble = tareas.crearTarjeta({ pedido: 'una vez', sujeto: alya }).tarea;
    const [r1, r2] = await Promise.all([botMod.lanzarTarjetaWeb(doble.id, ctx), botMod.lanzarTarjetaWeb(doble.id, ctx)]);
    assert.deepStrictEqual([r1.ok, r2.ok, r2.codigo], [true, false, 409], 'el segundo falla');
    assert.strictEqual(enCola('alma', doble.id), 1, 'una sola tarea en la cola');
    assert.deepStrictEqual((await botMod.dispatchCharla(ctx, { clave: 'alya', voz: 'Alya', texto: 'x', tarjetaId: doble.id })), { ok: false }, 'dispatchCharla con una tarjeta ya lanzada no encola');
    assert.deepStrictEqual((await botMod.dispatchCast(ctx, { agent: 'lector', prompt: 'x', cwd: proyecto, workspaceName: 'p', tarjetaId: doble.id })), { ok: false }, 'dispatchCast tampoco');
    assert.strictEqual(enCola('alma', doble.id) + enCola('cast', doble.id), 1, 'sigue habiendo una sola');
    assert.strictEqual(queue.getQueueLength('cast'), 0);

    // Cancelar y reintentar sobre lo lanzado.
    assert.strictEqual(botMod.cancelarTarea(doble.id).accion, 'quitada');
    assert.strictEqual(tareas.obtener(doble.id).estado, 'cancelada');
    assert.strictEqual(botMod.cancelarTarea(deAlma.id).accion, 'abortada');
    await esperar(libre('alma'), 'el carril se libera');
    assert.strictEqual(tareas.obtener(deAlma.id).estado, 'cancelada');
    assert((await botMod.reintentarTarea(doble.id, ctx)).ok, 'reintentar una tarjeta lanzada');
    await esperar(() => charlas.length === 2, 'el reintento corre');
    assert.strictEqual(charlas[1].texto, 'una vez');
    charlas[1].terminar();
    await esperar(libre('alma'), 'el reintento termina');

    // Validar al lanzar.
    const sinAsignar = tareas.crearTarjeta({ pedido: 'de nadie' }).tarea;
    assert.strictEqual((await botMod.lanzarTarjetaWeb(sinAsignar.id, ctx)).codigo, 400, 'sin asignar');
    const sinProyecto = tareas.crearTarjeta({ pedido: 'revisá', sujeto: { tipo: 'agente', nombre: 'lector' } }).tarea;
    assert.strictEqual((await botMod.lanzarTarjetaWeb(sinProyecto.id, ctx)).codigo, 400, 'un agente sin proyecto');
    const proyectoIdo = tareas.crearTarjeta({ pedido: 'revisá', sujeto: { tipo: 'agente', nombre: 'lector' }, workspaceId: 'ya-no-existe' }).tarea;
    assert.strictEqual((await botMod.lanzarTarjetaWeb(proyectoIdo.id, ctx)).codigo, 400, 'un proyecto que ya no existe');
    const almaIda = tareas.crearTarjeta({ pedido: 'hola', sujeto: { tipo: 'alma', clave: 'nadie' } }).tarea;
    assert.strictEqual((await botMod.lanzarTarjetaWeb(almaIda.id, ctx)).codigo, 400, 'un alma que ya no existe');
    assert.strictEqual((await botMod.lanzarTarjetaWeb('t_nadie', ctx)).codigo, 404);
    assert.strictEqual((await botMod.lanzarTarjetaWeb(doble.id, ctx)).codigo, 409, 'lo ya lanzado');
    assert.strictEqual(botMod.cancelarTarea(sinAsignar.id).codigo, 409, 'una tarjeta sin lanzar no se cancela');

    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const puerto = web.servidor.address().port;
    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const get = (ruta) => pedirWeb(puerto, { ruta, headers: cookie });
    const post = (ruta, cuerpo = {}, headers = {}) => pedirWeb(puerto, {
      metodo: 'POST', ruta, headers: { ...cookie, 'content-type': 'application/json', ...headers }, cuerpo: JSON.stringify(cuerpo)
    });
    const { id: wsId, nombre: wsNombre } = (await get('/api/workspaces')).json().workspaces[0];

    // Un agente que dejó de ser castable: 400 y la tarjeta sigue en Por hacer.
    const deLector = (await post('/api/tarjetas', { titulo: 'Revisión', pedido: 'revisá el módulo', sujeto: 'agente:lector', workspaceId: wsId })).json().tarea;
    assert.deepStrictEqual([deLector.estado, deLector.proyecto, deLector.workspaceId, deLector.titulo, deLector.creadaPor], ['por_hacer', wsNombre, wsId, 'Revisión', 'usuario']);
    agentes(false);
    assert.strictEqual((await post(`/api/tarjetas/${deLector.id}/lanzar`)).status, 400, 'ya no es de lectura');
    assert.strictEqual(tareas.obtener(deLector.id).estado, 'por_hacer', 'y sigue en Por hacer');
    agentes(true);

    // Lanzar un agente por la API: castear con el cwd resuelto por id.
    assert.strictEqual((await post(`/api/tarjetas/${deLector.id}/lanzar`, {}, { origin: 'http://evil.example' })).status, 403, 'origen ajeno');
    const lanzado = await post(`/api/tarjetas/${deLector.id}/lanzar`);
    assert.deepStrictEqual([lanzado.status, lanzado.json().encolado], [200, true], lanzado.texto);
    await esperar(() => casts.length === 1 && libre('cast')(), 'el cast corre');
    assert.strictEqual(casts[0].prompt, 'revisá el módulo');
    assert.strictEqual(path.resolve(casts[0].cwd).toLowerCase(), fs.realpathSync.native(proyecto).toLowerCase(), 'en el proyecto resuelto por id');
    const fallida = tareas.obtener(deLector.id);
    assert.deepStrictEqual([fallida.estado, fallida.workspaceId, fallida.eventos.map((e) => e.tipo)], ['error', wsId, ['creada', 'lanzada', 'en_curso', 'error']]);
    assert.strictEqual((await post(`/api/tarjetas/${deLector.id}/lanzar`)).status, 409, 'lanzar dos veces por la API');

    // Crear: validaciones de asignación.
    for (const [cuerpo, motivo] of [
      [{ pedido: 'x', sujeto: 'alma:nadie' }, 'alma inexistente'],
      [{ pedido: 'x', sujeto: 'agente:escritor' }, 'agente con escritura'],
      [{ pedido: 'x', sujeto: 'trabajo' }, 'el trabajo no se asigna'],
      [{ pedido: 'x', sujeto: 'alma:../x' }, 'clave inválida'],
      [{ pedido: 'x', sujeto: 'agente:lector', workspaceId: 'nope' }, 'proyecto desconocido'],
      [{ pedido: '', sujeto: 'alma:alya' }, 'pedido vacío'],
      [{ pedido: 'x', titulo: 't'.repeat(121) }, 'título largo']
    ]) {
      const r = await post('/api/tarjetas', cuerpo);
      assert.strictEqual(r.status, 400, `${motivo}: ${r.texto}`);
    }
    assert.strictEqual((await post('/api/tarjetas', { pedido: 'x' }, { origin: 'http://evil.example' })).status, 403, 'crear con origen ajeno');
    const antes = tareas.listar().length;
    const paraAlya = (await post('/api/tarjetas', { pedido: 'charlá', sujeto: 'alma:alya', workspaceId: wsId })).json().tarea;
    assert.deepStrictEqual([paraAlya.sujeto, paraAlya.workspaceId], [alya, null], 'un alma no guarda proyecto');
    assert.strictEqual(tareas.listar().length, antes + 1);

    // Guardar y lanzar.
    const yLanzar = await post('/api/tarjetas', { pedido: 'ahora mismo', sujeto: 'alma:alya', lanzar: true });
    assert.deepStrictEqual([yLanzar.status, yLanzar.json().lanzada], [200, true], yLanzar.texto);
    await esperar(() => charlas.length === 3, 'guardar y lanzar corre');
    charlas[2].terminar();
    await esperar(libre('alma'), 'termina');
    const sinWs = await post('/api/tarjetas', { pedido: 'sin proyecto', sujeto: 'agente:lector', lanzar: true });
    assert.strictEqual(sinWs.status, 400, 'no se pudo lanzar');
    assert.strictEqual(sinWs.json().tarea.estado, 'por_hacer', 'pero la tarjeta quedó guardada');

    // Editar y borrar.
    const sse = esperarSse(puerto, cookie, (t) => t.includes('"tipo":"tarea_borrada"'), { ms: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    const editada = await post(`/api/tarjetas/${paraAlya.id}/editar`, { titulo: 'Para el lector', sujeto: 'agente:lector', workspaceId: wsId, estado: 'ok' });
    assert.strictEqual(editada.status, 200, editada.texto);
    assert.deepStrictEqual([editada.json().tarea.sujeto, editada.json().tarea.workspaceId, editada.json().tarea.estado], [{ tipo: 'agente', nombre: 'lector' }, wsId, 'por_hacer']);
    assert.strictEqual((await post(`/api/tarjetas/${paraAlya.id}/editar`, { titulo: 'solo el título' })).json().tarea.workspaceId, wsId, 'editar el título conserva el proyecto');
    assert.strictEqual((await post(`/api/tarjetas/${paraAlya.id}/editar`, { sujeto: 'agente:escritor' })).status, 400, 'la edición también valida');
    assert.strictEqual((await post(`/api/tarjetas/${paraAlya.id}/editar`, { sujeto: null })).json().tarea.sujeto, null, 'se puede dejar sin asignar');
    assert.strictEqual((await post(`/api/tarjetas/${deLector.id}/editar`, { titulo: 'x' })).status, 409, 'lo lanzado no se edita');
    assert.strictEqual((await post(`/api/tarjetas/${deLector.id}/borrar`)).status, 409, 'ni se borra');
    assert.strictEqual((await post(`/api/tarjetas/${paraAlya.id}/borrar`)).status, 200);
    assert.strictEqual(tareas.obtener(paraAlya.id), null);
    assert((await sse).texto.includes(`"id":"${paraAlya.id}"`), 'la baja llega por SSE');

    // Detalle y resumen.
    await post(`/api/tareas/${deLector.id}/notas`, { texto: 'Revisar la migración otra vez' });
    const detalle = (await get(`/api/tareas/${deLector.id}`)).json().tarea;
    assert.deepStrictEqual([detalle.notas.length, detalle.notas[0].autor, detalle.eventos.at(-1).tipo, detalle.error], [1, 'usuario', 'nota', 'el cast falló']);
    assert.strictEqual((await get('/api/tareas/t_nadie')).status, 404);
    const tablero = (await get('/api/tareas')).json().tareas;
    const enTablero = tablero.find((t) => t.id === deLector.id);
    assert.deepStrictEqual([enTablero.titulo, enTablero.creadaPor, enTablero.madre, enTablero.cantidadNotas, enTablero.ultimoEvento.tipo], ['Revisión', 'usuario', null, 1, 'nota']);
    assert(tablero.every((t) => !('resultado' in t) && !('notas' in t) && !('eventos' in t)), 'el tablero va en resumen');
    const deAlmaResumen = tablero.find((t) => t.id === deAlma.id);
    assert(deAlmaResumen.pedido.length <= tareas.TOPE_PEDIDO_RESUMEN + 1, 'con el pedido recortado');

    // Notas.
    assert.strictEqual((await post(`/api/tareas/${deLector.id}/notas`, { texto: '  ' })).status, 400);
    assert.strictEqual((await post(`/api/tareas/${deLector.id}/notas`, { texto: 'n'.repeat(1001) })).status, 400);
    assert.strictEqual((await post('/api/tareas/t_nadie/notas', { texto: 'x' })).status, 404);
    assert.strictEqual((await post(`/api/tareas/${deLector.id}/notas`, { texto: 'x' }, { origin: 'http://evil.example' })).status, 403);

    // Búsqueda.
    const buscar = async (q) => (await get(`/api/tareas?q=${encodeURIComponent(q)}`)).json().tareas.map((t) => t.id);
    assert.deepStrictEqual(await buscar('MIGRACION'), [deLector.id], 'por nota, sin tildes');
    assert.deepStrictEqual(await buscar('pedido largo pedido largo FIN'), [deAlma.id], 'por el pedido completo');
    assert.strictEqual((await get(`/api/tareas?q=${'x'.repeat(201)}`)).status, 400, 'consulta demasiado larga');
    assert.strictEqual((await get('/api/tareas?q=')).json().tareas.length, tareas.listar().length, 'vacía: todas');

    // Volver a Por hacer.
    assert.strictEqual((await post(`/api/tareas/${deLector.id}/devolver`, {}, { origin: 'http://evil.example' })).status, 403);
    const devuelta = await post(`/api/tareas/${deLector.id}/devolver`);
    assert.strictEqual(devuelta.status, 200, devuelta.texto);
    assert.deepStrictEqual([devuelta.json().tarea.estado, devuelta.json().tarea.madre, devuelta.json().tarea.workspaceId], ['por_hacer', deLector.id, wsId]);
    const ok = tareas.listar().find((t) => t.estado === 'ok');
    assert.strictEqual((await post(`/api/tareas/${ok.id}/devolver`)).status, 409, 'desde ok no');

    // El historial de la conversación no muestra lo que no corrió.
    tareas.crearTarjeta({ pedido: 'todavía no', sujeto: alya });
    const hist = (await get('/api/tareas?sujeto=alma:alya')).json().tareas;
    assert(hist.length > 0 && hist.every((t) => t.estado !== 'por_hacer'), 'sin tarjetas de Por hacer');

    // Ids inválidos en todas las rutas nuevas.
    for (const ruta of ['/api/tarjetas/..%2Fx/editar', '/api/tarjetas/x/lanzar', '/api/tarjetas/T_MAL/borrar', '/api/tareas/t_a%20b/notas', '/api/tareas/nada/devolver']) {
      assert.strictEqual((await post(ruta, { texto: 'x' })).status, 400, `id inválido: ${ruta}`);
    }
    assert.strictEqual((await get('/api/tareas/..%2Fx')).status, 400);
    assert.strictEqual((await get('/api/tarjetas')).status, 405, 'crear es solo POST');

    // FEAT-061 fase 4: las cinco rutas de lotes heredan sesión/origen/tope y
    // validan ids antes de tocar Docker. El lanzamiento feliz se prueba con el
    // servicio inyectado en test/lotes-web.test.js; acá importa el HTTP real.
    const lotesVacios = await get('/api/lotes');
    assert.strictEqual(lotesVacios.status, 200, lotesVacios.texto);
    assert(Array.isArray(lotesVacios.json().lotes), 'lista de lotes con forma estable');
    assert.strictEqual((await post('/api/tarjetas/x/lote', {}, { origin: 'http://evil.example' })).status, 403, 'lanzar lote rechaza Origin ajeno');
    assert.strictEqual((await post('/api/tarjetas/x/lote')).status, 400, 'lanzar lote valida id de tarjeta');
    assert.strictEqual((await post('/api/tarjetas/x/lote', { relleno: 'x'.repeat(70 * 1024) })).status, 413, 'lanzar lote conserva el tope de cuerpo');
    assert.strictEqual((await get('/api/lotes/..%2Fx')).status, 400, 'detalle valida id de lote');
    assert.strictEqual((await get('/api/lotes/lote-inexistente')).status, 404, 'detalle inexistente');
    assert.strictEqual((await get('/api/lotes/lote/tareas/..%2Fx/diff')).status, 400, 'diff valida id de tarea');
    assert.strictEqual((await post('/api/lotes/lote/descartar', { confirmacion: 'lote' }, { origin: 'http://evil.example' })).status, 403, 'descarte rechaza Origin ajeno');
    assert.strictEqual((await post('/api/lotes/lote/descartar', { confirmacion: 'otro' })).status, 400, 'descarte exige confirmación exacta');
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    tareas.reiniciarParaTests();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 104 [FEAT-057]: lanzar tarjetas y API del tablero');

// Test 104b [FEAT-160 F0]: la matriz estado × acción del tablero por HTTP (04-pruebas T2) y
// `/mover` con recarga desde disco (O2). Los caminos felices de lanzar, cancelar y reintentar
// ya los cubren los Tests 97 y 104; acá, que cada acción rechace lo que no le corresponde.
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  try { fs.rmSync(tareas.rutaTareas(), { force: true }); } catch {}
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-matriz-'));
  let web = null;
  try {
    const alya = { tipo: 'alma', clave: 'alya', voz: 'Alya' };
    const ESTADOS = ['por_hacer', 'en_cola', 'en_curso', 'ok', 'error', 'cancelada', 'interrumpida'];
    const ids = {};
    for (const e of ESTADOS) ids[e] = tareas.crearTarjeta({ titulo: e, pedido: `pedido ${e}`, sujeto: alya }).tarea.id;
    const extra = {
      principal: tareas.crearTarjeta({ titulo: 'principal', pedido: 'p', sujeto: alya }).tarea.id,
      reaccion: tareas.crearTarjeta({ titulo: 'reaccion', pedido: 'r', sujeto: alya }).tarea.id,
      orquestar: tareas.crearTarjeta({ titulo: 'orquestar', pedido: 'o', sujeto: alya }).tarea.id
    };
    // Los estados se escriben en el registro y se recargan: sin colas ni ejecutores de por medio.
    const ruta = tareas.rutaTareas();
    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    for (const t of datos.tareas) {
      const e = Object.keys(ids).find((k) => ids[k] === t.id);
      if (e && e !== 'por_hacer') { t.estado = e; t.carril = 'alma'; delete t.posicion; }
      if (t.id === extra.principal) { t.estado = 'en_cola'; t.carril = 'principal'; delete t.posicion; }
      if (t.id === extra.reaccion) { t.estado = 'error'; t.carril = 'alma'; t.motivo = 'reaccion'; delete t.posicion; }
      if (t.id === extra.orquestar) { t.estado = 'error'; t.carril = 'alma'; t.motivo = 'orquestar'; delete t.posicion; }
    }
    fs.writeFileSync(ruta, JSON.stringify(datos));
    tareas.reiniciarParaTests();
    assert.strictEqual(tareas.obtener(ids.interrumpida).estado, 'interrumpida', 'los estados se cargaron');

    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const puerto = web.servidor.address().port;
    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const post = (r, cuerpo = {}) => pedirWeb(puerto, {
      metodo: 'POST', ruta: r, headers: { ...cookie, 'content-type': 'application/json' }, cuerpo: JSON.stringify(cuerpo)
    });
    const RUTAS = {
      lanzar: (id) => `/api/tarjetas/${id}/lanzar`, cancelar: (id) => `/api/tareas/${id}/cancelar`,
      reintentar: (id) => `/api/tareas/${id}/reintentar`, devolver: (id) => `/api/tareas/${id}/devolver`,
      mover: (id) => `/api/tarjetas/${id}/mover`
    };
    // [acción, id, código esperado, por qué]
    const casos = [
      ...['en_cola', 'en_curso', 'ok', 'error', 'cancelada', 'interrumpida'].map((e) => ['lanzar', ids[e], 409, `lanzar desde ${e}`]),
      ...['por_hacer', 'ok', 'error', 'cancelada', 'interrumpida'].map((e) => ['cancelar', ids[e], 409, `cancelar desde ${e}`]),
      ['cancelar', extra.principal, 400, 'cancelar el carril principal'],
      ...['por_hacer', 'en_cola', 'en_curso', 'ok'].map((e) => ['reintentar', ids[e], 409, `reintentar desde ${e}`]),
      ['reintentar', extra.reaccion, 400, 'reintentar una reacción'],
      ['reintentar', extra.orquestar, 400, 'reintentar una orquestación'],
      ...['por_hacer', 'en_cola', 'en_curso', 'ok'].map((e) => ['devolver', ids[e], 409, `devolver desde ${e}`]),
      ['devolver', extra.reaccion, 400, 'devolver una reacción'],
      ...['en_cola', 'en_curso', 'ok', 'error', 'cancelada', 'interrumpida'].map((e) => ['mover', ids[e], 409, `mover desde ${e}`]),
      ...Object.keys(RUTAS).map((a) => [a, 't_nadie', 404, `${a} de una tarea que no existe`])
    ];
    const antes = JSON.stringify(tareas.listar().map((t) => [t.id, t.estado, t.posicion ?? null]));
    for (const [accion, id, codigo, motivo] of casos) {
      const r = await post(RUTAS[accion](id));
      assert.strictEqual(r.status, codigo, `${motivo}: ${r.status} ${r.texto}`);
    }
    assert.strictEqual(JSON.stringify(tareas.listar().map((t) => [t.id, t.estado, t.posicion ?? null])), antes, 'ningún rechazo cambió el tablero');

    // `/mover`: vecinas inválidas y un movimiento real que sobrevive a recargar desde disco.
    const a = tareas.crearTarjeta({ titulo: 'a', pedido: 'a', sujeto: alya }).tarea.id;
    const b = tareas.crearTarjeta({ titulo: 'b', pedido: 'b', sujeto: alya }).tarea.id;
    const c = tareas.crearTarjeta({ titulo: 'c', pedido: 'c', sujeto: alya }).tarea.id;
    const columna = () => tareas.listar().filter((t) => t.estado === 'por_hacer').sort(tareas.porPosicion).map((t) => t.id);
    assert.strictEqual((await post(RUTAS.mover(a), { antes: a })).status, 400, 'vecina de sí misma');
    assert.strictEqual((await post(RUTAS.mover(a), { antes: ids.ok })).status, 409, 'vecina fuera de Por hacer');
    const orden = columna();
    const ultima = orden.at(-1);
    const r = await post(RUTAS.mover(ultima), { antes: null, despues: orden[0] });
    assert.strictEqual(r.status, 200, r.texto);
    const esperado = [ultima, ...orden.filter((x) => x !== ultima)];
    assert.deepStrictEqual(columna(), esperado, 'quedó arriba de todo');
    tareas.reiniciarParaTests();
    assert.deepStrictEqual(columna(), esperado, 'el orden sobrevive a recargar desde disco');
    const posiciones = tareas.listar().filter((t) => t.estado === 'por_hacer').sort(tareas.porPosicion).map((t) => t.posicion);
    assert.deepStrictEqual(posiciones, posiciones.map((_, i) => i + 1), 'posiciones 1..n');
    assert([a, b, c].every((x) => esperado.includes(x)));
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    try { fs.rmSync(tareas.rutaTareas(), { force: true }); } catch {}
    tareas.reiniciarParaTests();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 104b [FEAT-160 F0]: matriz estado × acción del tablero por HTTP y /mover');

// Test 105 [FEAT-057]: detener una subtarea de fan-out desde el tablero. Solo
// sobre una subtarea que la lectura confirma en curso, con el centinela de
// siempre, sin rutas en la respuesta y con 503 si el proyecto no responde.
{
  const fanoutEstado = (await import('../../mcp-server/fanout-estado.js')).default;
  const { crearNucleoWeb } = await import('../web/nucleo.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const botMod = await import('../bot.js');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-detener-'));
  const repo = path.join(raiz, 'repo');
  const dirEstado = path.join(repo, '.claude', 'worktrees');
  fs.mkdirSync(dirEstado, { recursive: true });
  const lote = (slug, datos) => fs.writeFileSync(path.join(dirEstado, `.fanout-status-${slug}.json`), JSON.stringify({ slug, ...datos }));
  const ahora = Date.now();
  const hace = (min) => new Date(ahora - min * 60 * 1000).toISOString();
  // El lote a detener es el más viejo de doce activos: la lectura del tablero
  // (máximo 10) no lo vería.
  lote('objetivo', { iniciado: hace(90), actualizado: hace(80), terminado: null, tareas: { x: { estado: 'corriendo' }, y: { estado: 'ok' }, z: { estado: 'reintentando' } } });
  for (let i = 0; i < 11; i++) lote(`otro-${i}`, { iniciado: hace(20), actualizado: hace(10 - i / 2), terminado: null, tareas: { a: { estado: 'corriendo' } } });
  const centinela = (slug, tarea) => fanoutEstado.rutaControl(repo, slug, tarea);

  const home = path.join(raiz, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
  const previo = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  let web = null;

  try {
    botMod.resetRuntimeState();
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const puerto = web.servidor.address().port;
    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const workspaceId = (await pedirWeb(puerto, { ruta: '/api/workspaces', headers: cookie })).json().workspaces[0].id;
    const detener = (cuerpo, headers = {}) => pedirWeb(puerto, {
      metodo: 'POST', ruta: '/api/fanout/detener',
      headers: { ...cookie, 'content-type': 'application/json', ...headers }, cuerpo: JSON.stringify(cuerpo)
    });

    assert.strictEqual((await detener({ workspaceId, lote: 'objetivo', tarea: 'x' }, { origin: 'http://evil.example' })).status, 403, 'origen ajeno');
    assert(!fs.existsSync(centinela('objetivo', 'x')), 'sin escribir');

    const ok = await detener({ workspaceId, lote: 'objetivo', tarea: 'x' });
    assert.strictEqual(ok.status, 200, ok.texto);
    assert.deepStrictEqual(ok.json(), { ok: true, lote: 'objetivo', tarea: 'x' });
    assert(!ok.texto.includes('repo') && !ok.texto.includes(':\\\\'), 'la respuesta no lleva rutas');
    assert(fs.existsSync(centinela('objetivo', 'x')), 'el centinela quedó en el repo del lote');
    const pedido = fanoutEstado.crearLectorDeControl(repo, 'objetivo').consumirDetencion('x');
    assert.strictEqual(pedido.motivo, 'detenida desde la consola web', 'el orquestador lo lee');
    assert.strictEqual((await detener({ workspaceId, lote: 'objetivo', tarea: 'z' })).status, 200, 'también una que se reintenta');

    for (const [cuerpo, codigo, motivo] of [
      [{ workspaceId, lote: 'objetivo', tarea: 'y' }, 400, 'subtarea terminada'],
      [{ workspaceId, lote: 'objetivo', tarea: 'w' }, 404, 'subtarea inexistente'],
      [{ workspaceId, lote: 'no-existe', tarea: 'x' }, 404, 'lote inexistente'],
      [{ workspaceId: 'zzz', lote: 'objetivo', tarea: 'x' }, 404, 'workspace desconocido'],
      [{ lote: 'objetivo', tarea: 'x' }, 400, 'sin workspace'],
      [{ workspaceId, lote: 'objetivo', tarea: 7 }, 400, 'tarea que no es texto'],
      [{ workspaceId, lote: 'o'.repeat(80), tarea: 'x' }, 400, 'slug que pudo venir recortado']
    ]) {
      const r = await detener(cuerpo);
      assert.strictEqual(r.status, codigo, `${motivo}: ${r.texto}`);
    }
    assert(!fs.existsSync(centinela('objetivo', 'y')) && !fs.existsSync(centinela('no-existe', 'x')), 'ninguno de esos escribió');
    assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/fanout/detener', headers: cookie })).status, 405, 'GET no');
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }

  // Núcleo: un proyecto que no responde da 503 y no escribe.
  try {
    const escritos = [];
    let colgar = true;
    let lecturas = 0;
    const nucleo = crearNucleoWeb({
      canal: crearCanalWeb(),
      bot: {},
      almas: {},
      workspaces: () => [{ id: 'w1', name: 'lento', path: 'N:/lento' }],
      fanout: {
        limiteMs: 40,
        leerLotes: (ruta, opciones) => {
          lecturas++;
          assert.strictEqual(opciones?.maximo, Infinity, 'para detener se leen todos los lotes');
          if (colgar) return new Promise(() => {});
          return Promise.resolve({ lotes: [{ slug: 'l', tareas: [{ id: 't', estado: 'corriendo' }] }] });
        },
        detener: (...args) => escritos.push(args)
      }
    });
    const cuerpo = { workspaceId: 'w1', lote: 'l', tarea: 't' };
    assert.strictEqual((await nucleo.detenerFanout(cuerpo)).codigo, 503, 'no respondió a tiempo');
    colgar = false;
    assert.strictEqual((await nucleo.detenerFanout(cuerpo)).codigo, 503, 'con la lectura anterior en vuelo, tampoco');
    assert.strictEqual(lecturas, 1, 'y no se lanza otra');
    assert.deepStrictEqual(escritos, [], 'nada se escribió');

    const rapido = crearNucleoWeb({
      canal: crearCanalWeb(),
      bot: {},
      almas: {},
      workspaces: () => [{ id: 'w1', name: 'rapido', path: 'R:/rapido' }],
      fanout: {
        leerLotes: async () => ({ lotes: [{ slug: 'l', tareas: [{ id: 't', estado: 'corriendo' }] }] }),
        detener: () => { throw new Error('EACCES R:/rapido/.claude'); }
      }
    });
    const fallo = await rapido.detenerFanout(cuerpo);
    assert(fallo.codigo === 500 && !fallo.error.includes('R:/'), 'un fallo al escribir no filtra la ruta');
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 105 [FEAT-057]: detener una subtarea de fan-out desde el tablero');

// Test 106 [FEAT-057]: el cliente del tablero v2, de forma estática. Usa las
// rutas nuevas, no inyecta HTML, lee `?t=` con URLSearchParams y la búsqueda
// espera y descarta respuestas viejas.
{
  const js = fs.readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/public/app.css', import.meta.url), 'utf8');
  const vm = await import('node:vm');
  assertModuloValido(js, 'app.js');
  assert(!/\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|document\.write|eval\(|new Function/.test(js), 'sin HTML inyectado ni código dinámico');
  const perfJs = fs.readFileSync(new URL('../web/public/rendimiento-vista.js', import.meta.url), 'utf8');
  new vm.Script(perfJs);
  assert(!/\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|document\.write|eval\(|new Function/.test(perfJs), 'rendimiento seguro');
  // FEAT-136 F3 — El tablero vive en ui/vista-tablero.js: el resto se mira en todo el cliente.
  const cliente = codigoCliente();
  for (const ruta of ["'/api/tarjetas'", '/api/tarjetas/${enc(', '/editar`', '/lanzar`', '/borrar`', '/notas`', '/devolver`', "'/api/fanout/detener'", '/api/tareas?q=${enc(q)}', '/api/tareas/${enc(d.id)}`']) {
    assert(cliente.includes(ruta), `el cliente usa ${ruta}`);
  }
  assert(/new URLSearchParams\(location\.search\)\.get\('t'\)/.test(cliente), '?t= se lee con URLSearchParams');
  assert(/history\.replaceState\(null, '', `\/tablero\?t=\$\{enc\(id\)\}`\)/.test(cliente), 'la tarjeta abierta va en la URL, codificada');
  assert(/const ESPERA_BUSQUEDA_MS = 250;/.test(cliente) && /if \(seq !== (b|busqueda\.value)\.seq\) return;/.test(cliente), 'la búsqueda espera 250 ms y descarta respuestas viejas');
  assert(/e\.tipo === 'tarea_borrada'/.test(js), 'escucha la baja de una tarjeta');
  assert(/if \(t\.estado === 'por_hacer'\) return;/.test(js), 'una tarjeta sin lanzar no entra a la conversación');
  assert(!/api\([^)]*\/api\/(run|plan)\b/.test(js), 'el tablero no lanza el carril principal');
  assert(/\.app\.vista-tablero/.test(css) && /\.detalle \{/.test(css), 'estilos del tablero v2');
}
console.log('✔ Test 106 [FEAT-057]: cliente del tablero v2');

