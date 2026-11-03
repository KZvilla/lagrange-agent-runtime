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
// Test 87 [FEAT-052]: el canal web es un sustituto de `bot.api` acotado: buffer
// con tope, reenvío desde un `seq`, baja de suscriptores y un ctx que solo
// acepta chats `web:`.
{
  const { crearCanalWeb, crearCtxWeb, esChatWeb, CHAT_WEB_LOCAL } = await import('../web/canal.js');
  assert.strictEqual(esChatWeb(CHAT_WEB_LOCAL), true);
  assert.strictEqual(esChatWeb(Number(USUARIO_OK)), false, 'un id de Telegram no es chat web');
  assert.throws(() => crearCtxWeb(crearCanalWeb(), Number(USUARIO_OK)), /chatId web inválido/);

  const canal = crearCanalWeb({ bufferMax: 3 });
  const vistos = [];
  const baja = canal.suscribir(CHAT_WEB_LOCAL, (e) => vistos.push(e));
  const ctx = crearCtxWeb(canal);
  const enviado = await ctx.reply('<b>hola</b>', { parse_mode: 'HTML' });
  assert.strictEqual(vistos[0].formato, 'html', 'el HTML de sendSafeChunk se marca como tal');
  assert.strictEqual(enviado.message_id, vistos[0].seq, 'reply devuelve un message_id usable por editMessageText');
  await canal.editMessageText(CHAT_WEB_LOCAL, enviado.message_id, 'progreso');
  assert.strictEqual(vistos[1].ref, enviado.message_id, 'la edición apunta al mensaje de estado');

  const avisos = [];
  const warnOriginal = console.warn;
  console.warn = (m) => avisos.push(m);
  try {
    await canal.sendMessage(CHAT_WEB_LOCAL, 'con teclado', { reply_markup: { inline_keyboard: [] } });
  } finally {
    console.warn = warnOriginal;
  }
  assert(avisos.some((m) => m.includes('reply_markup')), 'un teclado ignorado se avisa en el log');

  await canal.sendChatAction(CHAT_WEB_LOCAL, 'typing');
  assert.strictEqual(canal.pendientes(CHAT_WEB_LOCAL).length, 3, 'el buffer respeta su tope');
  assert.deepStrictEqual(canal.pendientes(CHAT_WEB_LOCAL, vistos[2].seq).map((e) => e.tipo), ['accion'], 'reenvía solo lo posterior al seq');
  assert.strictEqual(canal.pendientes('web:otro').length, 0, 'cada chat tiene su buffer');

  baja();
  assert.strictEqual(canal.suscriptoresDe(CHAT_WEB_LOCAL), 0, 'la baja limpia el suscriptor');
  await canal.sendMessage(CHAT_WEB_LOCAL, 'nadie escucha');
  assert.strictEqual(vistos.length, 4, 'después de la baja no llegan eventos');
}
console.log('✔ Test 87 [FEAT-052]: canal web con buffer, reenvío y ctx acotado');

// Test 88 [FEAT-052]: una charla o un cast despachados desde la web salen por el
// canal web y NUNCA por la API de Telegram. Los de Telegram siguen como antes.
{
  const botMod = await import('../bot.js');
  const { crearCanalWeb, crearCtxWeb, CHAT_WEB_LOCAL } = await import('../web/canal.js');
  const { llamadas } = botDePrueba();
  botMod.resetRuntimeState();
  const esperar = async (cond, motivo) => {
    const limite = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > limite) throw new Error(`Test 88: no se cumplió a tiempo: ${motivo}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const canal = crearCanalWeb();
  botMod.conectarCanalWeb(canal);
  const eventos = [];
  const baja = canal.suscribir(CHAT_WEB_LOCAL, (e) => eventos.push(e));
  botMod.usarEjecutoresDePrueba({
    charlar: async ({ clave }) => ({ ok: true, clave, respuesta: 'Hola desde la web.', aplicadas: [{ tipo: 'agregar' }], rechazadas: [] }),
    castear: async () => ({ ok: false, error: 'agente roto' })
  });
  const cast = { agent: 'lector', prompt: 'revisá', cwd: os.tmpdir(), workspaceName: 'tmp' };

  try {
    const ctxWeb = crearCtxWeb(canal);

    // 1. Charla web: aviso, progreso y respuesta por el canal.
    await botMod.dispatchCharla(ctxWeb, { clave: 'alya', voz: 'Alya', texto: 'hola' });
    await esperar(() => eventos.some((e) => e.tipo === 'mensaje' && e.texto.includes('Hola desde la web')), 'llega la respuesta');
    await esperar(() => !botMod.carrilOcupado('alma'), 'el carril alma se libera');
    const aviso = eventos.find((e) => e.tipo === 'mensaje');
    assert(eventos.some((e) => e.tipo === 'progreso' && e.ref === aviso.seq), 'el progreso edita el aviso inicial');
    assert(eventos.some((e) => e.tipo === 'mensaje' && e.texto.includes('recordó 1')), 'con el pie de memoria');
    const respuesta = eventos.find((e) => e.texto?.includes('Hola desde la web'));
    assert.strictEqual(state.getReaccionable(respuesta.seq, CHAT_WEB_LOCAL), null, 'la web no registra reaccionables');

    // 2. Cast web que falla: el error sale por notifyChat, también al canal.
    await botMod.dispatchCast(ctxWeb, cast);
    await esperar(() => eventos.some((e) => e.texto?.includes('agente roto')), 'llega el error del cast');
    await esperar(() => !botMod.carrilOcupado('cast'), 'el carril cast se libera');
    assert.strictEqual(llamadas.length, 0, 'nada de lo web tocó la API de Telegram');

    // 3. Web apagada: lo que no pasa por ctx se descarta, no se desvía a Telegram.
    botMod.conectarCanalWeb(null);
    await botMod.dispatchCast(ctxWeb, cast);
    await esperar(() => !botMod.carrilOcupado('cast') && queue.getQueueLength('cast') === 0, 'el cast termina');
    assert.strictEqual(llamadas.length, 0, 'sin canal web, tampoco se usa la API de Telegram');

    // 4. Un chat de Telegram sigue saliendo por su API aunque la web esté conectada.
    botMod.conectarCanalWeb(canal);
    const antes = eventos.length;
    const ctxTg = {
      chat: { id: Number(USUARIO_OK), type: 'private' },
      reply: async () => ({ message_id: 7001 })
    };
    await botMod.dispatchCharla(ctxTg, { clave: 'alya', voz: 'Alya', texto: 'hola' });
    await esperar(() => !botMod.carrilOcupado('alma') && llamadas.some((l) => l.method === 'editMessageText'), 'la charla de Telegram termina');
    assert(llamadas.every((l) => String(l.payload.chat_id) === USUARIO_OK), 'las llamadas van al chat de Telegram');
    assert.strictEqual(eventos.length, antes, 'y el canal web no recibe nada');
  } finally {
    baja();
    botMod.resetRuntimeState();
  }
}
console.log('✔ Test 88 [FEAT-052]: la cola enruta la salida por chat, sin fugas a Telegram');

// Test 89 [FEAT-052]: las piezas que Telegram y la web comparten. Cancelar por
// carril, la vista de la cola (con la voz de una charla encolada, que /queue
// mostraba como `undefined`), agentes castables y workspace por id.
{
  const botMod = await import('../bot.js');
  botMod.resetRuntimeState();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'antigravity-agents.json'), JSON.stringify({
    agents: {
      lector: { skill: 's', read_only: true, description: 'Lee y opina' },
      escritor: { skill: 's', read_only: false }
    }
  }));
  const esperar = async (cond, motivo) => {
    const limite = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > limite) throw new Error(`Test 89: no se cumplió a tiempo: ${motivo}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  let cancelados = 0;
  botMod.usarEjecutoresDePrueba({
    charlar: async ({ opciones }) => new Promise((resolve) => {
      opciones.onSpawn(() => { cancelados++; resolve({ ok: false, cancelled: true }); return true; });
    })
  });
  const ctx = { chat: { id: 'web:local', type: 'private' }, reply: async () => ({ message_id: 1 }) };

  try {
    assert.deepStrictEqual(botMod.agentesCasteables(home), [{ nombre: 'lector', descripcion: 'Lee y opina' }], 'solo los read-only');
    assert.strictEqual(botMod.resolverWorkspaceDeCast('web:local', 'no-existe'), null, 'un id desconocido no resuelve');

    await botMod.dispatchCharla(ctx, { clave: 'alya', voz: 'Alya', texto: 'primero' });
    await esperar(() => botMod.carrilOcupado('alma'), 'la charla arranca');
    await botMod.dispatchCharla(ctx, { clave: 'alya', voz: 'Alya', texto: 'segundo' });

    const alma = botMod.estadoDeCarriles().find((c) => c.carril === 'alma');
    assert.strictEqual(alma.enCurso.voz, 'Alya');
    assert.strictEqual(alma.enCurso.extracto, 'primero');
    assert.strictEqual(alma.pendientes[0].voz, 'Alya', 'la charla encolada conserva su voz');
    assert(!('ctx' in alma.enCurso) && !('prompt' in alma.enCurso), 'sin handles vivos ni prompt completo');

    assert.deepStrictEqual(botMod.cancelarCarriles(['cast']), { abortados: [], descartadas: 0 }, 'otro carril no toca la charla');
    assert.deepStrictEqual(botMod.cancelarCarriles(['alma', 'inventado'], 'web:local'), { abortados: ['alma'], descartadas: 1 });
    assert.strictEqual(cancelados, 1);
    assert.strictEqual(state.getModoCharla('web:local'), null, 'cancelar la charla apaga el modo de quien canceló');
    await esperar(() => !botMod.carrilOcupado('alma'), 'el carril se libera');
  } finally {
    botMod.resetRuntimeState();
    fs.rmSync(home, { recursive: true, force: true });
  }
}
console.log('✔ Test 89 [FEAT-052]: cancelar, cola, agentes y workspace compartidos');

// Cliente HTTP mínimo para los tests de la consola web. `fetch` no deja fijar
// `Host`, y los tests de rebinding lo necesitan.
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

// Test 90 [FEAT-052]: el servidor web con un núcleo falso. Sesión por cookie,
// Host de loopback, sin preflight, origen en mutaciones, límites del cuerpo,
// errores sin filtrar detalles, CSP sin inline y SSE con reenvío.
{
  const { crearServidorWeb, cookieWeb } = await import('../web/servidor.js');
  const { crearCanalWeb, CHAT_WEB_LOCAL } = await import('../web/canal.js');
  const token = 'a'.repeat(24) + 'b'.repeat(24);
  assert.throws(() => crearServidorWeb({ nucleo: {}, token: 'corto' }), /token/);

  const canal = crearCanalWeb();
  const vistos = [];
  const nucleo = {
    canal,
    chatId: CHAT_WEB_LOCAL,
    almas: () => ({ ok: true, almas: [{ clave: 'alya', voz: 'Alya' }] }),
    memoria: (clave) => { vistos.push(['memoria', clave]); return { codigo: 404, ok: false, error: 'No existe esa alma.' }; },
    mensaje: (clave, texto) => { vistos.push(['mensaje', clave, texto]); return { ok: true }; },
    castear: () => { throw new Error('detalle interno con /ruta/secreta'); },
    cancelar: () => ({ ok: true })
  };
  const servidor = crearServidorWeb({ nucleo, token, latidoMs: 60_000 });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  const cookie = { cookie: `otra=1; ${cookieWeb(puerto)}=${token}` };
  const json = { 'content-type': 'application/json' };
  const errorOriginal = console.error;
  const errores = [];

  try {
    assert.strictEqual((await pedirWeb(puerto)).status, 401, 'sin sesión, la página no se sirve');
    assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/almas' })).status, 401, 'ni la API');
    assert.strictEqual((await pedirWeb(puerto, { ruta: `/api/almas`, headers: { cookie: `${cookieWeb(puerto)}=${'c'.repeat(48)}` } })).status, 401, 'una cookie de otro arranque no sirve');
    assert.strictEqual((await pedirWeb(puerto, { ruta: '/login?t=malo' })).status, 403, 'login con token inválido');

    const login = await pedirWeb(puerto, { ruta: `/login?t=${token}` });
    assert.strictEqual(login.status, 303);
    assert.strictEqual(login.headers.location, '/', 'redirige a la URL limpia');
    const setCookie = String(login.headers['set-cookie']);
    assert(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict') && setCookie.includes(`${cookieWeb(puerto)}=${token}`), `cookie con sus flags: ${setCookie}`);

    const pagina = await pedirWeb(puerto, { headers: cookie });
    assert.strictEqual(pagina.status, 200);
    // FEAT-053: la interfaz son archivos estáticos; la CSP no admite nada inline.
    // Se verifica la política que emite el servidor: un filtro local (AdGuard,
    // por ejemplo) puede reescribir la cabecera en el camino.
    const { CSP } = await import('../web/servidor.js');
    assert(CSP.includes("script-src 'self'") && CSP.includes("style-src 'self'") && !CSP.includes('unsafe-inline') && !CSP.includes('nonce'), `CSP sin inline: ${CSP}`);
    assert(pagina.headers['content-security-policy'].includes("frame-ancestors 'none'"), 'la página lleva la CSP');
    assert(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(pagina.texto), 'la página no trae scripts inline');
    assert(!/\sstyle=|\son[a-z]+=/i.test(pagina.texto), 'ni estilos ni handlers inline');
    assert.strictEqual(pagina.headers['x-frame-options'], 'DENY');
    assert.strictEqual(pagina.headers['cache-control'], 'no-store');

    assert.strictEqual((await pedirWeb(puerto, { headers: { ...cookie, host: 'evil.example:4518' } })).status, 403, 'Host ajeno (rebinding)');
    assert.strictEqual((await pedirWeb(puerto, { metodo: 'OPTIONS', ruta: '/api/cast', headers: cookie })).status, 405, 'sin preflight');

    const cuerpo = JSON.stringify({ texto: 'hola' });
    const post = (headers, c = cuerpo, ruta = '/api/almas/alya/mensaje') => pedirWeb(puerto, { metodo: 'POST', ruta, headers: { ...cookie, ...headers }, cuerpo: c });
    assert.strictEqual((await post({ ...json, origin: 'http://evil.example' })).status, 403, 'Origin ajeno');
    assert.strictEqual((await post({ ...json, 'sec-fetch-site': 'cross-site' })).status, 403, 'Sec-Fetch-Site cruzado');
    assert.strictEqual((await post({ 'content-type': 'text/plain' })).status, 415, 'un form simple no pasa');
    assert.strictEqual((await post(json, 'x'.repeat(70 * 1024))).status, 413, 'cuerpo con tope');
    assert.strictEqual((await post(json, '{roto')).status, 400, 'JSON inválido');
    assert.strictEqual((await post(json, '[1]')).status, 400, 'el cuerpo tiene que ser un objeto');
    assert.strictEqual(vistos.length, 0, 'ninguna de esas llegó al núcleo');

    const ok = await post({ ...json, origin: `http://127.0.0.1:${puerto}`, 'sec-fetch-site': 'same-origin' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(vistos.pop(), ['mensaje', 'alya', 'hola']);
    await post(json, cuerpo, '/api/almas/..%2F..%2Fetc/mensaje');
    assert.deepStrictEqual(vistos.pop(), ['mensaje', '../../etc', 'hola'], 'la clave llega decodificada: validarla es del núcleo');
    assert.strictEqual((await post(json, cuerpo, '/api/almas/%E0%A4%A/mensaje')).status, 400, 'ruta mal codificada');

    const porHeader = await pedirWeb(puerto, { ruta: '/api/almas', headers: { 'x-lagrange-token': token } });
    assert.strictEqual(porHeader.json().almas[0].clave, 'alya', 'un cliente sin navegador usa la cabecera');
    const memoria = await pedirWeb(puerto, { ruta: '/api/almas/nadie/memoria', headers: cookie });
    assert.strictEqual(memoria.status, 404, 'el `codigo` del núcleo es el estado HTTP');
    assert(!('codigo' in memoria.json()), 'y no viaja en el cuerpo');

    console.error = (m) => errores.push(String(m));
    const roto = await post(json, JSON.stringify({ agente: 'x' }), '/api/cast');
    console.error = errorOriginal;
    assert.strictEqual(roto.status, 500);
    assert(!roto.texto.includes('secreta'), 'el error interno no se filtra al cliente');
    assert(errores.some((m) => m.includes('secreta')), 'pero queda en el log');

    assert.strictEqual((await pedirWeb(puerto, { metodo: 'DELETE', ruta: '/api/almas', headers: cookie })).status, 405);
    assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/nada', headers: cookie })).status, 404);

    // SSE: lo guardado antes de conectar llega, y lo nuevo también.
    await canal.sendMessage(CHAT_WEB_LOCAL, 'antes de conectar');
    const primero = await esperarSse(puerto, cookie, (t) => t.includes('antes de conectar'));
    assert.strictEqual(primero.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert(/^id: \d+$/m.test(primero.texto), 'cada evento lleva id para Last-Event-ID');
    const seqPrimero = Number(/^id: (\d+)$/m.exec(primero.texto)[1]);
    const vivo = esperarSse(puerto, { ...cookie, 'last-event-id': String(seqPrimero) }, (t) => t.includes('en vivo'));
    await new Promise((r) => setTimeout(r, 50));
    await canal.sendMessage(CHAT_WEB_LOCAL, 'en vivo');
    const segundo = await vivo;
    assert(!segundo.texto.includes('antes de conectar'), 'Last-Event-ID no repite lo ya visto');
    assert.strictEqual((await pedirWeb(puerto, { ruta: '/api/eventos' })).status, 401, 'el SSE también exige sesión');

    // Un cliente que se va libera su suscripción. El aviso del sistema operativo
    // no es inmediato (en Windows, unos cientos de ms): se espera la condición.
    const esperarSubs = async (n) => {
      const limite = Date.now() + 5000;
      while (canal.suscriptoresDe(CHAT_WEB_LOCAL) !== n) {
        if (Date.now() > limite) throw new Error(`Test 90: quedaron ${canal.suscriptoresDe(CHAT_WEB_LOCAL)} suscriptores, se esperaban ${n}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await esperarSubs(0);

    // Un SSE abierto no impide cerrar el servidor.
    const colgado = esperarSse(puerto, cookie, () => false, { ms: 5000 }).catch(() => null);
    await esperarSubs(1);
    await new Promise((r) => servidor.close(r));
    assert.strictEqual(canal.suscriptoresDe(CHAT_WEB_LOCAL), 0, 'cerrar corta los SSE');
    await colgado;
  } finally {
    console.error = errorOriginal;
    if (servidor.listening) servidor.close();
  }
}
console.log('✔ Test 90 [FEAT-052]: servidor web con sesión, anti-rebinding, límites y SSE');

// Test 91 [FEAT-052]: la consola completa sobre el núcleo real. Almas, memoria,
// cast con validación de agente y de proyecto, cola, cancelar, sesiones, logs
// redactados, y el arranque: apagada por defecto, solo loopback, puerto ocupado.
{
  const botMod = await import('../bot.js');
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  const recuerdos = (await import('../../mcp-server/almas/recuerdos.js')).default;
  const rutasAlmas = (await import('../../mcp-server/almas/rutas.js')).default;
  const { cookieWeb } = await import('../web/servidor.js');
  botMod.resetRuntimeState();

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-e2e-'));
  const home = path.join(raiz, 'home');
  const proyecto = path.join(raiz, 'proyecto');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(proyecto);
  fs.writeFileSync(path.join(home, '.claude', 'antigravity-agents.json'), JSON.stringify({
    agents: { lector: { skill: 's', read_only: true }, escritor: { skill: 's', read_only: false } }
  }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    projects: { [proyecto]: { hasTrustDialogAccepted: true } }
  }));
  const entornoPrevio = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, LAGRANGE_ALMAS_DIR: process.env.LAGRANGE_ALMAS_DIR };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });
  recuerdos.aplicar(rutasAlmas.rutasDe('alya').memoria, 'm', [{ tipo: 'agregar', texto: 'le gusta el mate' }], recuerdos.TOPE_MEMORIA);

  const logFile = path.join(raiz, 'daemon.log');
  fs.writeFileSync(logFile, `arranque\ntoken filtrado ${FAKE_TOKEN}\n`);
  const tokenFile = path.join(raiz, 'web-token.json');
  const casts = [];
  botMod.usarEjecutoresDePrueba({
    charlar: async ({ clave, texto }) => ({ ok: true, clave, respuesta: `eco: ${texto}`, aplicadas: [], rechazadas: [] }),
    castear: async (op) => { casts.push(op); return { ok: true, respuesta: 'todo en orden', memoria: { usada: false } }; }
  });
  const errorOriginal = console.error;
  const errores = [];
  let web = null;

  try {
    console.error = (m) => errores.push(String(m));
    assert.strictEqual(await botMod.arrancarWeb({ env: {} }), null, 'apagada si no hay BRIDGE_WEB=1');
    assert.strictEqual(await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_HOST: '0.0.0.0' } }), null, 'no escucha fuera de loopback');
    assert.strictEqual(await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: 'abc' } }), null, 'puerto inválido');
    console.error = errorOriginal;
    assert(errores.some((m) => m.includes('0.0.0.0')) && errores.some((m) => m.includes('abc')), 'cada rechazo se explica en el log');

    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, logFile, tokenFile });
    assert(web, 'la consola arranca');
    const puerto = web.servidor.address().port;
    const guardado = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    assert.strictEqual(guardado.login, web.login, 'el link de acceso queda en el archivo del token');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(tokenFile).mode & 0o777, 0o600, 'solo lo lee el dueño');

    const login = await pedirWeb(puerto, { ruta: new URL(web.login).pathname + new URL(web.login).search });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    assert(cookie.cookie.startsWith(`${cookieWeb(puerto)}=`));
    const get = async (ruta) => (await pedirWeb(puerto, { ruta, headers: cookie }));
    const post = async (ruta, datos) => (await pedirWeb(puerto, { metodo: 'POST', ruta, headers: { ...cookie, 'content-type': 'application/json' }, cuerpo: JSON.stringify(datos) }));

    // Almas y charla.
    assert.deepStrictEqual((await get('/api/almas')).json().almas, [{ clave: 'alya', voz: 'Alya' }]);
    assert.strictEqual((await post('/api/almas/nadie/mensaje', { texto: 'hola' })).status, 404);
    assert.strictEqual((await post('/api/almas/..%2Falya/mensaje', { texto: 'hola' })).status, 404, 'una clave con path traversal no es un alma');
    assert.strictEqual((await post('/api/almas/alya/mensaje', { texto: '   ' })).status, 400);
    assert.strictEqual((await post('/api/almas/alya/mensaje', { texto: 'x'.repeat(4097) })).status, 400);
    assert.strictEqual((await post('/api/almas/alya/mensaje', { texto: 42 })).status, 400);
    const respuesta = esperarSse(puerto, cookie, (t) => t.includes('eco: hola alya'));
    assert.strictEqual((await post('/api/almas/alya/mensaje', { texto: 'hola alya' })).status, 200);
    await respuesta;
    await new Promise((r) => { const i = setInterval(() => { if (!botMod.carrilOcupado('alma')) { clearInterval(i); r(); } }, 5); });
    assert.strictEqual((await post('/api/almas/alya/nuevo', {})).status, 200);

    // Memoria.
    const memoria = (await get('/api/almas/alya/memoria')).json();
    assert.deepStrictEqual(memoria.memoria.entradas.map((e) => e.id), ['m1']);
    assert(!JSON.stringify(memoria).includes(raiz), 'la vista de memoria no expone rutas del disco');
    assert.strictEqual((await post('/api/almas/alya/olvidar', { id: 'rm -rf' })).status, 400);
    assert.strictEqual((await post('/api/almas/alya/olvidar', { id: 'm9' })).status, 404);
    const olvidado = await post('/api/almas/alya/olvidar', { id: 'M1' });
    assert.strictEqual(olvidado.json().olvidado, 'le gusta el mate');
    assert.strictEqual((await get('/api/almas/alya/memoria')).json().memoria.entradas.length, 0);

    // Cast.
    assert.deepStrictEqual((await get('/api/agentes')).json().agentes.map((a) => a.nombre), ['lector']);
    const workspaces = (await get('/api/workspaces')).json().workspaces;
    assert.strictEqual(workspaces.length, 1, 'el proyecto de ~/.claude.json');
    assert(!JSON.stringify(workspaces).includes(raiz), 'los proyectos van por id, sin ruta');
    const wsId = workspaces[0].id;
    assert.strictEqual((await post('/api/cast', { agente: 'escritor', workspaceId: wsId, pedido: 'x' })).status, 400, 'un agente con escritura no se castea');
    assert.strictEqual((await post('/api/cast', { agente: 'lector', workspaceId: 'otro', pedido: 'x' })).status, 400, 'proyecto desconocido');
    assert.strictEqual((await post('/api/cast', { agente: 'lector', workspaceId: wsId, pedido: '' })).status, 400);
    assert.strictEqual(casts.length, 0);
    const castOk = esperarSse(puerto, cookie, (t) => t.includes('todo en orden'));
    assert.strictEqual((await post('/api/cast', { agente: 'lector', workspaceId: wsId, pedido: 'revisá' })).status, 200);
    await castOk;
    assert.strictEqual(casts.length, 1);
    assert.strictEqual(path.resolve(casts[0].cwd).toLowerCase(), fs.realpathSync.native(proyecto).toLowerCase(), 'el cast corre en la ruta resuelta por id');
    assert.strictEqual(casts[0].opciones.soloLectura, true);
    assert.strictEqual((await get('/api/workspaces')).json().workspaces[0].favorito, true, 'y queda como favorito');

    // Cola, cancelar, sesiones, logs.
    // FEAT-060: el carril del reloj se suma a los tres de siempre.
    assert.deepStrictEqual((await get('/api/cola')).json().carriles.map((c) => c.carril), ['principal', 'cast', 'alma', 'programado']);
    assert.strictEqual((await post('/api/cancelar', { carril: 'principal' })).status, 400, 'la web no corta el carril principal');
    assert.deepStrictEqual((await post('/api/cancelar', {})).json(), { ok: true, abortados: [], descartadas: 0 });
    // El `charlar` falso no anota turnos; el real sí.
    (await import('../../mcp-server/almas/hilos.js')).default.registrarTurno('alya', { conversationId: 'hilo-web' });
    const sesiones = (await get('/api/sesiones')).json();
    assert(sesiones.almas.some((a) => a.clave === 'alya' && a.conversationId === 'hilo-web'), 'el hilo del alma aparece');
    assert(sesiones.agentes.every((a) => !String(a.proyecto || '').includes(path.sep)), 'los agentes muestran solo el nombre del proyecto');
    const logs = (await get('/api/logs?n=5')).json();
    assert.strictEqual(logs.ok, true);
    if (process.platform === 'win32') {
      assert(logs.contenido.includes('arranque'), 'lee daemon.log');
      assert(!logs.contenido.includes(FAKE_TOKEN), 'con los secretos redactados');
    }

    // Páginas.
    for (const ruta of ['/', '/sesiones', '/logs', '/alma/alya', '/agente/lector']) {
      assert.strictEqual((await get(ruta)).status, 200, `página ${ruta}`);
    }
    for (const ruta of ['/cast', '/cola', '/memoria']) {
      const vieja = await get(ruta);
      assert.deepStrictEqual([vieja.status, vieja.headers.location], [302, '/'], `la ruta vieja ${ruta} lleva al inicio`);
    }

    // Puerto ocupado: no tumba nada, solo no arranca otra.
    console.error = (m) => errores.push(String(m));
    assert.strictEqual(await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: String(puerto) }, logFile, tokenFile: path.join(raiz, 'otro.json') }), null);
    console.error = errorOriginal;
    assert(errores.some((m) => m.includes('sigue solo por Telegram')));
    assert(fs.existsSync(tokenFile), 'el intento fallido no toca el token de la consola viva');

    await new Promise((r) => web.servidor.close(r));
    assert(!fs.existsSync(tokenFile), 'al cerrar se borra el link');
    web = null;
  } finally {
    console.error = errorOriginal;
    if (web) web.servidor.close();
    botMod.resetRuntimeState();
    for (const [k, v] of Object.entries(entornoPrevio)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 91 [FEAT-052]: consola web de punta a punta sobre el núcleo real');

// Test 92 [FEAT-052]: cómo se consigue el link. `/web` en Telegram (apagada y
// prendida, sin vista previa) y el archivo de acceso que leen `bridge:web` y el
// diagnóstico, que distingue un daemon vivo de uno muerto.
{
  const botMod = await import('../bot.js');
  const { leerAccesoWeb } = await import('../web/acceso.js');
  const { bot, llamadas } = botDePrueba();
  botMod.resetRuntimeState();
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-link-'));
  let web = null;
  try {
    await bot.handleUpdate(comandoDe('/web', 9201));
    assert(textosEnviados(llamadas).includes('apagada'), '/web avisa que la consola está apagada');

    assert.strictEqual(leerAccesoWeb({ dataDir: raiz }), null, 'sin archivo no hay acceso');
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const acceso = leerAccesoWeb({ dataDir: raiz });
    assert.deepStrictEqual([acceso.url, acceso.login, acceso.vivo], [web.url, web.login, true], 'el archivo describe la consola viva');
    assert.strictEqual(leerAccesoWeb({ dataDir: raiz, estaVivo: () => false }).vivo, false, 'y detecta un daemon muerto');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/web', 9202));
    const envio = llamadas.find((l) => l.method === 'sendMessage');
    assert(envio.payload.text.includes(web.login), '/web manda el link con token');
    assert.strictEqual(envio.payload.link_preview_options?.is_disabled, true, 'sin vista previa del link');

    await new Promise((r) => web.servidor.close(r));
    web = null;
    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/web', 9203));
    assert(textosEnviados(llamadas).includes('apagada'), 'al cerrar la consola, /web deja de dar el link');
  } finally {
    if (web) web.servidor.close();
    botMod.resetRuntimeState();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 92 [FEAT-052]: /web y el archivo de acceso');

// Test 92b [FEAT-170]: la consola del teléfono por Tailscale Serve. La configuración (y que un error apague solo la
// del teléfono), el archivo de acceso, `/web` con el link de un solo uso (sin el token local) y el aviso al arrancar.
{
  const botMod = await import('../bot.js');
  const { leerAccesoWeb } = await import('../web/acceso.js');
  const http = await import('node:http');
  const { configTailnet } = botMod;

  const c0 = configTailnet({}, { puertoLocal: 4518 });
  assert.deepStrictEqual(c0, { config: null, motivo: null }, 'sin variables: no configurada');
  assert.deepStrictEqual(configTailnet({ BRIDGE_WEB_TAILSCALE: 'Pc.Tail1.ts.net', BRIDGE_WEB_TAILSCALE_USUARIO: 'yo@x.com' }, { puertoLocal: 4518 }).config,
    { nombre: 'pc.tail1.ts.net', usuario: 'yo@x.com', puerto: 4528 }, 'por defecto, el puerto configurado + 10');
  assert.strictEqual(configTailnet({ BRIDGE_WEB_TAILSCALE: 'pc.tail1.ts.net', BRIDGE_WEB_TAILSCALE_USUARIO: 'yo@x.com' }, { puertoLocal: 0 }).config.puerto, 0, 'con el local en 0, el del teléfono también');
  for (const [env, que] of [
    [{ BRIDGE_WEB_TAILSCALE: 'pc.tail1.ts.net' }, 'falta el usuario'],
    [{ BRIDGE_WEB_TAILSCALE_USUARIO: 'yo@x.com' }, 'falta el nombre'],
    [{ BRIDGE_WEB_TAILSCALE: 'https://pc.tail1.ts.net', BRIDGE_WEB_TAILSCALE_USUARIO: 'yo@x.com' }, 'nombre con esquema'],
    [{ BRIDGE_WEB_TAILSCALE: 'pc.tail1.ts.net:443', BRIDGE_WEB_TAILSCALE_USUARIO: 'yo@x.com' }, 'nombre con puerto'],
    [{ BRIDGE_WEB_TAILSCALE: 'pc.tail1.ts.net.', BRIDGE_WEB_TAILSCALE_USUARIO: 'yo@x.com' }, 'nombre con punto final'],
    [{ BRIDGE_WEB_TAILSCALE: 'pc.tail1.ts.net', BRIDGE_WEB_TAILSCALE_USUARIO: 'yo @x.com' }, 'usuario con espacio'],
    [{ BRIDGE_WEB_TAILSCALE: 'pc.tail1.ts.net', BRIDGE_WEB_TAILSCALE_USUARIO: 'yo@x.com', BRIDGE_WEB_TAILSCALE_PORT: '4518' }, 'mismo puerto que la consola'],
    [{ BRIDGE_WEB_TAILSCALE: 'pc.tail1.ts.net', BRIDGE_WEB_TAILSCALE_USUARIO: 'yo@x.com', BRIDGE_WEB_TAILSCALE_PORT: 'x' }, 'puerto inválido']
  ]) {
    const r = configTailnet(env, { puertoLocal: 4518 });
    assert(r.config === null && /teléfono no arrancó/.test(r.motivo || ''), `${que}: apagada con motivo`);
  }

  const { bot, llamadas } = botDePrueba();
  botMod.resetRuntimeState();
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-tailnet-'));
  const tokenFile = path.join(raiz, 'web-token.json');
  const NOMBRE = 'pc.tail1.ts.net';
  const envTs = { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0', BRIDGE_WEB_TAILSCALE: NOMBRE, BRIDGE_WEB_TAILSCALE_USUARIO: 'yo@x.com' };
  const antes = { token: process.env.TELEGRAM_BOT_TOKEN, ids: process.env.ALLOWED_USER_IDS };
  let web = null;
  let ocupado = null;
  try {
    llamadas.length = 0;
    web = await botMod.arrancarWeb({ env: envTs, tokenFile });
    assert.strictEqual(llamadas.length, 0, 'arrancarWeb no manda el aviso por su cuenta (lo hace el arranque del daemon)');
    const acceso = leerAccesoWeb({ dataDir: raiz });
    assert(acceso.tailnet?.url === `https://${NOMBRE}` && acceso.tailnet.usuario === 'yo@x.com' && acceso.tailnet.puerto > 0, 'web-token.json describe la del teléfono (puerto real)');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).tailnet).sort(), ['puerto', 'url', 'usuario'], 'sin secretos del teléfono en el archivo');
    const escrito = fs.readFileSync(tokenFile, 'utf8');

    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/web', 9211));
    const envio = llamadas.find((l) => l.method === 'sendMessage');
    const link = /https:\/\/\S+\/login\?c=(\S+)/.exec(envio.payload.text);
    assert(link, '/web manda el link del teléfono');
    assert(!envio.payload.text.includes(web.login) && !envio.payload.text.includes('/login?t='), 'y no el link con el token local');
    assert.strictEqual(envio.payload.link_preview_options?.is_disabled, true, 'sin vista previa (consumiría el código)');
    const codigo = decodeURIComponent(link[1]);
    const r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: acceso.tailnet.puerto, path: `/login?c=${encodeURIComponent(codigo)}`, headers: { host: NOMBRE, 'tailscale-user-login': 'yo@x.com' } }, (res) => { res.resume(); resolve(res); }));
    assert.strictEqual(r.statusCode, 303, 'el código de /web abre la consola del teléfono');
    assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), escrito, 'web-token.json no cambia después del arranque');

    // El aviso al arrancar: por el bot principal, al chat del dueño, con un link nuevo y sin vista previa.
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    process.env.ALLOWED_USER_IDS = String(USUARIO_OK);
    llamadas.length = 0;
    assert.strictEqual(await botMod.avisarConsolaTelefono({ env: { BRIDGE_WEB_TAILSCALE_AVISO: '0' } }), false, 'BRIDGE_WEB_TAILSCALE_AVISO=0 lo apaga');
    assert.strictEqual(llamadas.length, 0);
    assert.strictEqual(await botMod.avisarConsolaTelefono({ env: {} }), true, 'por defecto avisa');
    const aviso = llamadas.find((l) => l.method === 'sendMessage');
    assert(aviso && String(aviso.payload.chat_id) === String(USUARIO_OK) && /https:\/\/pc\.tail1\.ts\.net\/login\?c=/.test(aviso.payload.text), 'al dueño, con el link del teléfono');
    assert.strictEqual(aviso.payload.link_preview_options?.is_disabled, true, 'el aviso también sin vista previa');
    botMod.usarRedParaTests({ rol: 'nodo' });
    llamadas.length = 0;
    assert.strictEqual(await botMod.avisarConsolaTelefono({ env: {} }), false, 'en un nodo no avisa');
    assert.strictEqual(llamadas.length, 0);
    botMod.usarRedParaTests({ rol: 'solo' });

    await new Promise((res) => web.servidor.close(res));
    web = null;
    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/web', 9212));
    assert(textosEnviados(llamadas).includes('apagada'), 'al cerrar, /web dice apagada aunque antes hubiera teléfono');
    assert.strictEqual(await botMod.avisarConsolaTelefono({ env: {} }), false, 'sin consola del teléfono no avisa');

    // Puerto del teléfono ocupado: la local arriba, la del teléfono apagada con motivo en /web y en el archivo.
    ocupado = http.createServer();
    await new Promise((res) => ocupado.listen(0, '127.0.0.1', res));
    web = await botMod.arrancarWeb({ env: { ...envTs, BRIDGE_WEB_TAILSCALE_PORT: String(ocupado.address().port) }, tokenFile });
    assert(web && web.servidor.listening, 'la consola local arranca igual');
    assert(/teléfono no pudo escuchar/.test(leerAccesoWeb({ dataDir: raiz }).tailnet?.apagado || ''), 'web-token.json con tailnet.apagado');
    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/web', 9213));
    const conMotivo = llamadas.find((l) => l.method === 'sendMessage').payload.text;
    assert(conMotivo.includes(web.login) && /teléfono no pudo escuchar/.test(conMotivo), '/web da el link local y el motivo');
    await new Promise((res) => web.servidor.close(res));
    web = null;

    // Configuración inválida: local arriba, motivo en el archivo.
    web = await botMod.arrancarWeb({ env: { ...envTs, BRIDGE_WEB_TAILSCALE_USUARIO: '' }, tokenFile });
    assert(web && /hacen falta/.test(leerAccesoWeb({ dataDir: raiz }).tailnet?.apagado || ''), 'configuración a medias: local arriba, motivo en el archivo');
    await new Promise((res) => web.servidor.close(res));
    web = null;

    // Sin configurar: el archivo no lleva tailnet.
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile });
    assert.strictEqual(leerAccesoWeb({ dataDir: raiz }).tailnet, null, 'sin configurar, sin tailnet en el archivo');
  } finally {
    if (web) web.servidor.close();
    if (ocupado) ocupado.close();
    if (antes.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = antes.token;
    if (antes.ids === undefined) delete process.env.ALLOWED_USER_IDS; else process.env.ALLOWED_USER_IDS = antes.ids;
    botMod.resetRuntimeState();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 92b [FEAT-170]: la consola del teléfono por Tailscale');

