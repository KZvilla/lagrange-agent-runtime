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
// Test 140 [BE-049]: agy corta por --print-timeout con exit 0 y SUCCESS
{
  const executor = await import('../executor.js');
  const { spawn: spawnReal } = await import('node:child_process');
  // runAgyTask pide stream-json y el cast (runAgyArgs) json: el falso responde
  // en el formato que piden los args, como agy.
  const script = (conAviso) => [
    'const final={status:"SUCCESS",response:"mitad de la respuesta",conversation_id:"cid-corte"};',
    'process.stdout.write(process.argv.includes("stream-json") ? JSON.stringify({event:"result",result:final})+"\\n" : JSON.stringify(final));',
    conAviso ? 'process.stderr.write("[agy] print timeout after 15m0s with turn in progress; returning partial output\\n");' : ''
  ].join('');
  const conAviso = (bin, args) => spawnReal(process.execPath, ['-e', script(true), '--', ...args]);
  const sinAviso = (bin, args) => spawnReal(process.execPath, ['-e', script(false), '--', ...args]);

  const r = await executor.runAgyTask({ prompt: 'x', model: 'gemini-3.8-flash-low', spawnFn: conAviso });
  assert.strictEqual(r.success, true, 'en el chat la parte cortada se entrega');
  assert.strictEqual(r.parcial, true, 'marcada como parcial');
  assert(r.responseText.startsWith('⚠️ Respuesta incompleta: agy cortó por tiempo (15m0s).'), r.responseText);
  assert(r.responseText.endsWith('mitad de la respuesta'), 'con la parte producida después del aviso');
  assert.strictEqual(r.conversationId, 'cid-corte', 'y el hilo para seguir');

  const rCast = await executor.runAgyArgs(['--model', 'gemini-3.8-flash-low', '-p', 'x'], { spawnFn: conAviso });
  // Casts y almas: mismo contrato que executeAgy del MCP (el motor interpreta los dos).
  assert.strictEqual(rCast.success, false, 'un cast cortado es un fallo: no entra a la memoria del alma');
  assert.strictEqual(rCast.parcial, true);
  assert(rCast.error.startsWith('⚠️ Respuesta incompleta') && rCast.error.endsWith('mitad de la respuesta'), rCast.error);
  const { createRequire } = await import('node:module');
  const motorAgy = createRequire(import.meta.url)('../../mcp-server/motores/antigravity.js');
  const neutro = motorAgy.interpretar(rCast, { modelo: 'gemini-3.8-flash-low' });
  assert(!neutro.ok && neutro.error.includes('mitad de la respuesta') && neutro.hilo === 'cid-corte', 'el motor lo ve como fallo con la parte y el hilo');

  const control = await executor.runAgyTask({ prompt: 'x', model: 'gemini-3.8-flash-low', spawnFn: sinAviso });
  assert(control.success && control.parcial === false && control.responseText === 'mitad de la respuesta', 'sin el aviso, igual que siempre');

  // agy 1.5.0: exit 3 + status ERROR + finished_reason. `silent` no escribe
  // stderr, para probar que el campo estructurado alcanza.
  const scriptV15 = (conAviso) => `
    const final = { status: 'ERROR', response: 'mitad de la respuesta', conversation_id: 'cid-corte', error: 'print timeout after 15m0s with the turn still in progress; the response is partial', finished_reason: 'print_timeout' };
    const datos = process.argv.includes('stream-json')
      ? JSON.stringify({ event: 'result', result: final }) + '\\n'
      : JSON.stringify(final);
    process.stdout.write(datos, () => {
      ${conAviso
        ? "process.stderr.write('error: print timeout after 15m0s with the turn still in progress; the response is partial\\n', () => process.exit(3));"
        : 'process.exit(3);'}
    });
  `;
  const conV15 = (bin, args) => spawnReal(process.execPath, ['-e', scriptV15(true), '--', ...args]);
  const conV15Silencioso = (bin, args) => spawnReal(process.execPath, ['-e', scriptV15(false), '--', ...args]);

  const rV15 = await executor.runAgyTask({ prompt: 'x', model: 'gemini-3.8-flash-low', spawnFn: conV15 });
  assert.strictEqual(rV15.success, true, '1.5.0 con stderr: el chat entrega la parte cortada');
  assert.strictEqual(rV15.parcial, true, '1.5.0 con stderr: marcada como parcial');
  assert(rV15.responseText.startsWith('⚠️ Respuesta incompleta: agy cortó por tiempo (15m0s).'), rV15.responseText);
  assert(rV15.responseText.endsWith('mitad de la respuesta'), '1.5.0 con stderr: con la parte producida');
  assert.strictEqual(rV15.conversationId, 'cid-corte');

  const rV15Silencioso = await executor.runAgyTask({ prompt: 'x', model: 'gemini-3.8-flash-low', spawnFn: conV15Silencioso });
  assert.strictEqual(rV15Silencioso.success, true, '1.5.0 sin stderr: finished_reason alcanza');
  assert.strictEqual(rV15Silencioso.parcial, true, '1.5.0 sin stderr: marcada como parcial');
  assert(rV15Silencioso.responseText.startsWith('⚠️ Respuesta incompleta: agy cortó por tiempo (15m0s).'), rV15Silencioso.responseText);
  assert(rV15Silencioso.responseText.endsWith('mitad de la respuesta'));

  const rCastV15 = await executor.runAgyArgs(['--model', 'gemini-3.8-flash-low', '-p', 'x'], { spawnFn: conV15 });
  assert.strictEqual(rCastV15.success, false, '1.5.0 en un cast: un corte es un fallo');
  assert.strictEqual(rCastV15.parcial, true);
  assert(rCastV15.error.startsWith('⚠️ Respuesta incompleta') && rCastV15.error.endsWith('mitad de la respuesta'), rCastV15.error);
}
console.log('✔ Test 140 [BE-049]: el bridge avisa cuando agy corta por --print-timeout');

// Test 141 [BE-050]: EPERM transitorio de Windows en el lock de state.json
{
  const stateMod = await import('../state.js');
  const lock = `${stateMod.getStateFilePath()}.lock`;
  const openReal = fs.openSync;
  const errorReal = console.error;
  const conFallos = (veces, fn) => {
    let quedan = veces;
    let intentos = 0;
    const logs = [];
    fs.openSync = function (p, flags, ...resto) {
      if (path.resolve(String(p)) === path.resolve(lock) && flags === 'wx') {
        intentos++;
        if (quedan > 0) {
          quedan--;
          const err = new Error(`EPERM: simulado, open '${p}'`);
          err.code = 'EPERM';
          throw err;
        }
      }
      return openReal.call(fs, p, flags, ...resto);
    };
    console.error = (...a) => logs.push(a.join(' '));
    try { fn(); } finally { fs.openSync = openReal; console.error = errorReal; }
    return { intentos, logs };
  };

  // En Windows el EPERM llega sin archivo de lock visible (delete pending).
  const r = conFallos(2, () => stateMod.setConversationId(tg(141001), 'conv-be-050'));
  assert.strictEqual(r.intentos, 3, `reintenta hasta tomar el lock (${r.intentos})`);
  assert(!r.logs.some(l => /sin exclusión/.test(l)), `no escribe sin exclusión: ${r.logs.join(' | ')}`);
  assert.strictEqual(stateMod.getConversationId(tg(141001)), 'conv-be-050', 'el cambio persiste');
  assert(!fs.existsSync(lock), 'suelta el lock');

  // Un EPERM permanente (permiso real) no gira sin límite: termina en el deadline y lo avisa.
  const inicio = Date.now();
  const p = conFallos(Infinity, () => stateMod.setConversationId(tg(141002), 'conv-permanente'));
  const duro = Date.now() - inicio;
  assert(duro < 5000, `termina cerca del deadline (${duro} ms)`);
  assert(p.logs.some(l => /sin exclusión/.test(l)), 'y avisa que escribió sin exclusión');
}
console.log('✔ Test 141 [BE-050]: el lock de state.json espera un EPERM transitorio en vez de escribir sin exclusión');

// Test 142 [BE-052]: dos consolas en la misma PC (Windows + WSL mirrored).
// Puerto por defecto según dónde corre, respaldo solo sin BRIDGE_WEB_PORT,
// `/web` con el motivo, cookie por el puerto del Host y Origin con puerto.
{
  const botMod = await import('../bot.js');
  const { esWsl } = await import('../paths.js');
  const { crearServidorWeb, cookieWeb, puertoDelHost, puertoWebPorDefecto } = await import('../web/servidor.js');
  const { crearCanalWeb } = await import('../web/canal.js');
  const netMod = await import('node:net');

  // esWsl: solo Linux con el kernel de Microsoft.
  assert.strictEqual(esWsl({ plataforma: 'linux', leer: () => 'Linux version 5.15.167.4-microsoft-standard-WSL2 (root@host)' }), true, 'WSL2');
  assert.strictEqual(esWsl({ plataforma: 'linux', leer: () => 'Linux version 6.8.0-45-generic (buildd@lcy02)' }), false, 'Linux nativo');
  assert.strictEqual(esWsl({ plataforma: 'win32', leer: () => 'microsoft' }), false, 'Windows no es WSL');
  assert.strictEqual(esWsl({ plataforma: 'linux', leer: () => { throw new Error('ENOENT'); } }), false, 'sin /proc/version');
  assert.deepStrictEqual([puertoWebPorDefecto({ wsl: true }), puertoWebPorDefecto({ wsl: false }), puertoWebPorDefecto()], [4519, 4518, 4518]);

  // Puerto del Host, no del socket; `URL` entiende IPv6.
  assert.strictEqual(puertoDelHost({ headers: { host: '127.0.0.1:4519' } }), 4519);
  assert.strictEqual(puertoDelHost({ headers: { host: '[::1]:4519' } }), 4519, 'IPv6 con puerto');
  assert.strictEqual(puertoDelHost({ headers: { host: 'localhost' } }), 80, 'sin puerto, el del esquema');
  assert.strictEqual(puertoDelHost({ headers: { host: '127.0.0.1:99999' } }), null, 'puerto imposible');
  assert.strictEqual(cookieWeb(4519), 'lg_web_4519');

  const ocupar = (p) => new Promise((res) => {
    const s = netMod.createServer();
    s.once('error', () => res(null));
    s.listen(p, '127.0.0.1', () => res(s));
  });
  const cerrar = (s) => new Promise((r) => (s ? s.close(() => r()) : r()));
  // `n` puertos seguidos, ocupados por el test.
  async function rangoOcupado(n) {
    for (let intento = 0; intento < 30; intento++) {
      const base = 20000 + Math.floor(Math.random() * 30000);
      const servs = [];
      for (let i = 0; i < n; i++) {
        const s = await ocupar(base + i);
        if (!s) break;
        servs.push(s);
      }
      if (servs.length === n) return { base, servs };
      await Promise.all(servs.map(cerrar));
    }
    throw new Error('no se encontró un rango de puertos libre');
  }
  const libre = async (p) => { const s = await ocupar(p); await cerrar(s); return !!s; };

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-be052-'));
  const tokenFile = path.join(raiz, 'web-token.json');
  const { bot, llamadas } = botDePrueba();
  const errorOriginal = console.error;
  const errores = [];
  const ocupados = [];
  let web = null;
  botMod.resetRuntimeState();
  try {
    // Sin BRIDGE_WEB_PORT: 4519 en WSL y 4518 fuera, con `wsl` inyectado. Si
    // esta máquina ya usa ese puerto (una consola viva), vale el respaldo.
    for (const [wsl, esperado] of [[true, 4519], [false, 4518]]) {
      const estaLibre = await libre(esperado);
      console.error = (m) => errores.push(String(m));
      web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1' }, wsl, tokenFile });
      console.error = errorOriginal;
      assert(web, `arranca con wsl=${wsl}`);
      const tomado = web.servidor.address().port;
      if (estaLibre) assert.strictEqual(tomado, esperado, `wsl=${wsl} → ${esperado}`);
      else assert(tomado > esperado && tomado <= esperado + 9, `wsl=${wsl}: ${esperado} ocupado, respaldo en ${tomado}`);
      await new Promise((r) => web.servidor.close(r));
      web = null;
    }

    // Puerto por defecto ocupado: toma el siguiente, lo dice y el link lo lleva.
    const uno = await rangoOcupado(1);
    ocupados.push(...uno.servs);
    errores.length = 0;
    console.error = (m) => errores.push(String(m));
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_PERF: '1' }, puertoPorDefecto: uno.base, tokenFile });
    console.error = errorOriginal;
    assert(web, 'con el puerto ocupado arranca en otro');
    const tomado = web.servidor.address().port;
    assert(tomado > uno.base && tomado <= uno.base + 9, `respaldo dentro de los 9 siguientes: ${tomado}`);
    assert(errores.some((m) => m.includes(`${uno.base} ocupado`) && m.includes(String(tomado)) && m.includes('BRIDGE_WEB_PORT')), `el log dice dónde quedó: ${errores.join(' | ')}`);
    assert.strictEqual(new URL(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).url).port, String(tomado), 'web-token.json lleva el puerto real');
    const perfRespaldo = await pedirWeb(tomado, { ruta: '/api/rendimiento', headers: { 'x-lagrange-token': new URL(web.login).searchParams.get('t') } });
    assert.strictEqual(perfRespaldo.json().enabled, true, 'FEAT-096: inicia tras EADDRINUSE seguido de listen exitoso');
    assert.strictEqual(perfRespaldo.json().muestras.length, 1, 'un único arranque, no uno por puerto intentado');
    await new Promise((r) => web.servidor.close(r));
    web = null;

    // Con BRIDGE_WEB_PORT ocupado falla sin probar otros: el motivo nombra un
    // solo puerto, no un rango.
    errores.length = 0;
    console.error = (m) => errores.push(String(m));
    assert.strictEqual(await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: String(uno.base) }, tokenFile }), null, 'puerto fijado y ocupado: no arranca');
    console.error = errorOriginal;
    assert(errores.some((m) => m.includes(`127.0.0.1:${uno.base}:`) && m.includes('sigue solo por Telegram')), `falla con el mensaje de siempre: ${errores.join(' | ')}`);
    assert(!errores.some((m) => m.includes('ocupado; la consola quedó')), 'no tomó otro puerto');
    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/web', 9301));
    assert(textosEnviados(llamadas).includes(`no pudo escuchar en ${uno.base}:`), `/web dice el puerto fijado: ${textosEnviados(llamadas)}`);

    // Los 10 ocupados: no arranca y /web da el motivo, no "apagada".
    const diez = await rangoOcupado(10);
    ocupados.push(...diez.servs);
    console.error = () => {};
    assert.strictEqual(await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1' }, puertoPorDefecto: diez.base, tokenFile }), null, 'sin puerto libre no arranca');
    console.error = errorOriginal;
    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/web', 9302));
    const texto = textosEnviados(llamadas);
    assert(texto.includes(`no pudo escuchar en ${diez.base}-${diez.base + 9}`) && texto.includes('BRIDGE_WEB_PORT'), `/web da el motivo: ${texto}`);
    assert(!texto.includes('apagada'), '/web no dice que está apagada');

    // Apagada de verdad: vuelve el mensaje de siempre.
    await botMod.arrancarWeb({ env: {} });
    llamadas.length = 0;
    await bot.handleUpdate(comandoDe('/web', 9303));
    assert(textosEnviados(llamadas).includes('apagada'), 'sin BRIDGE_WEB=1 sí está apagada');

    // Cookie: dos consolas en el mismo host no se cierran la sesión.
    const vistos = [];
    const nucleo = () => ({
      canal: crearCanalWeb(),
      chatId: 'web',
      almas: () => ({ ok: true, almas: [] }),
      mensaje: (clave, t) => { vistos.push(t); return { ok: true }; }
    });
    const tokenA = 'a'.repeat(48);
    const tokenB = 'b'.repeat(48);
    const a = crearServidorWeb({ nucleo: nucleo(), token: tokenA, latidoMs: 60_000 });
    const b = crearServidorWeb({ nucleo: nucleo(), token: tokenB, latidoMs: 60_000 });
    await new Promise((r) => a.listen(0, '127.0.0.1', r));
    await new Promise((r) => b.listen(0, '127.0.0.1', r));
    const pA = a.address().port;
    const pB = b.address().port;
    try {
      const loginA = await pedirWeb(pA, { ruta: `/login?t=${tokenA}` });
      const loginB = await pedirWeb(pB, { ruta: `/login?t=${tokenB}` });
      for (const [login, p, t] of [[loginA, pA, tokenA], [loginB, pB, tokenB]]) {
        const sc = String(login.headers['set-cookie']);
        assert(sc.startsWith(`lg_web_${p}=${t};`) && sc.includes('HttpOnly') && sc.includes('SameSite=Strict') && sc.includes('Path=/'), `Set-Cookie por puerto: ${sc}`);
      }
      // El navegador guarda las dos para 127.0.0.1 y manda las dos a cada puerto.
      const frasco = { cookie: `${cookieWeb(pA)}=${tokenA}; ${cookieWeb(pB)}=${tokenB}` };
      assert.strictEqual((await pedirWeb(pA, { ruta: '/api/almas', headers: frasco })).status, 200, 'A sigue con sesión tras entrar a B');
      assert.strictEqual((await pedirWeb(pB, { ruta: '/api/almas', headers: frasco })).status, 200, 'B también');
      assert.strictEqual((await pedirWeb(pB, { ruta: '/api/almas', headers: { cookie: `${cookieWeb(pB)}=${tokenA}` } })).status, 401, 'el token de A no abre B');
      assert.strictEqual((await pedirWeb(pA, { ruta: '/api/almas', headers: { cookie: `${cookieWeb(pB)}=${tokenA}` } })).status, 401, 'la cookie de otro puerto no autoriza');
      assert.strictEqual((await pedirWeb(pA, { ruta: '/api/almas', headers: { cookie: `lg_web=${tokenA}` } })).status, 401, 'la cookie vieja lg_web no autoriza');

      // Detrás de un túnel: el Host dice 9000 aunque el socket sea otro.
      const tunel = { host: '127.0.0.1:9000' };
      const loginTunel = await pedirWeb(pA, { ruta: `/login?t=${tokenA}`, headers: tunel });
      assert(String(loginTunel.headers['set-cookie']).startsWith(`lg_web_9000=${tokenA};`), 'la cookie sale del puerto del Host');
      assert.strictEqual((await pedirWeb(pA, { ruta: '/api/almas', headers: { ...tunel, cookie: `lg_web_9000=${tokenA}` } })).status, 200, 'y con ese Host autoriza');
      assert.strictEqual((await pedirWeb(pA, { ruta: '/api/almas', headers: { cookie: `lg_web_9000=${tokenA}` } })).status, 401, 'con el Host del socket, no');

      // Origin con puerto en las mutaciones.
      const cA = { cookie: `${cookieWeb(pA)}=${tokenA}`, 'content-type': 'application/json' };
      const mutar = (h) => pedirWeb(pA, { metodo: 'POST', ruta: '/api/almas/alya/mensaje', headers: { ...cA, ...h }, cuerpo: JSON.stringify({ texto: 'hola' }) });
      assert.strictEqual((await mutar({ origin: `http://127.0.0.1:${pB}` })).status, 403, 'Origin de otro puerto de loopback, sin Sec-Fetch-Site');
      assert.strictEqual((await mutar({ origin: `http://localhost:${pA}` })).status, 403, 'otro nombre, mismo puerto: otro origen');
      assert.strictEqual((await mutar({ origin: `https://127.0.0.1:${pA}` })).status, 403, 'otro esquema');
      assert.strictEqual((await mutar({ origin: `http://127.0.0.1:${pB}`, 'sec-fetch-site': 'same-site' })).status, 403, 'same-site como hoy');
      assert.strictEqual(vistos.length, 0, 'ningún rechazo llegó al núcleo');
      assert.strictEqual((await mutar({ origin: `http://127.0.0.1:${pA}` })).status, 200, 'mismo host:puerto pasa');
      assert.strictEqual((await mutar({})).status, 200, 'sin Origin pasa (cliente sin navegador)');
      assert.strictEqual(vistos.length, 2);
    } finally {
      await new Promise((r) => a.close(r));
      await new Promise((r) => b.close(r));
    }
  } finally {
    console.error = errorOriginal;
    if (web) web.servidor.close();
    await Promise.all(ocupados.map(cerrar));
    botMod.resetRuntimeState();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ Test 142 [BE-052]: dos consolas en la misma PC: puerto por lado, respaldo, /web con motivo, cookie y Origin por puerto');

// Test 143 [BE-051]: identidad de bot. Referencia de chat, aislamiento entre
// dos bots con el mismo chat, migración de chats, convivencia con un notify.js
// anterior, reacciones y preguntas por bot, y la tarea encolada con su `ref`.
{
  const botMod = await import('../bot.js');
  const A = BOT_ID_PRUEBA; // principal: el de TELEGRAM_BOT_TOKEN
  const B = '222333444';
  const chat = 71000;
  const deA = { bot: A, chat };
  const deB = { bot: B, chat };
  const leerCrudo = () => JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
  const escribirCrudo = (d) => fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(d, null, 2));

  // 1. botIdDeToken / botPrincipal.
  assert.strictEqual(state.botIdDeToken('123:ABC'), '123');
  for (const malo of ['', null, undefined, 'sin-dos-puntos', 'abc:DEF', '123:', ' :x']) {
    assert.strictEqual(state.botIdDeToken(malo), null, `token inválido: ${JSON.stringify(malo)}`);
  }
  assert.strictEqual(state.botPrincipal({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN }), A, 'el principal sale de TELEGRAM_BOT_TOKEN');
  assert.strictEqual(state.botPrincipal({}), null, 'sin token no hay principal');
  assert(!JSON.stringify(state.botIdDeToken(FAKE_TOKEN)).includes('AAFake'), 'el secreto no sale');
  assert.strictEqual(state.botPrincipal(), A, 'en esta suite el principal es el del token de prueba');

  // 2. Referencia de chat: un número suelto (o su cadena) se rechaza.
  for (const malo of [chat, String(chat), null, undefined, { chat }, { bot: A }, { bot: 'x', chat }]) {
    assert.throws(() => state.getConversationId(malo), /Referencia de chat inválida/, `rechaza ${JSON.stringify(malo)}`);
  }
  assert.throws(() => state.registrarReaccionable(1, { alma: 'alya', extracto: 'x' }, chat), /Referencia de chat inválida/);
  assert.doesNotThrow(() => state.getConversationId('web:local'));
  assert.doesNotThrow(() => state.getConversationId(deA));

  // 3. Aislamiento: mismo chat, dos bots.
  state.setConversationId(deA, 'conv-A');
  state.setModoCharla(deA, 'alya');
  state.setUltimoWorkspaceCast(deA, 'aaaaaaaa');
  assert.strictEqual(state.getConversationId(deB), null, 'B no ve el hilo de A');
  assert.strictEqual(state.getModoCharla(deB), null, 'ni su modo charla');
  assert.strictEqual(state.getUltimoWorkspaceCast(deB), null, 'ni su último workspace');
  state.setConversationId(deB, 'conv-B');
  state.clearConversationId(deB);
  state.limpiarModoCharla(deB);
  assert.deepStrictEqual([state.getConversationId(deA), state.getModoCharla(deA), state.getUltimoWorkspaceCast(deA)],
    ['conv-A', 'alya', 'aaaaaaaa'], 'lo que hace B no toca a A');
  state.limpiarModoCharla(deA);

  // 4. Migración de chats: de una vez, idempotente, gana la clave nueva.
  const crudo = leerCrudo();
  crudo.chats = {
    '555': { lastConversationId: 'viejo-555' },
    '-100777': { lastConversationId: 'grupo' },
    '666': { lastConversationId: 'viejo-666' },
    [`${A}:666`]: { lastConversationId: 'nuevo-666' },
    'web:local': { lastConversationId: 'web' }
  };
  escribirCrudo(crudo);
  assert.strictEqual(state.migrarChats(A), 3, 'migra las tres claves de número');
  const migrado = leerCrudo().chats;
  assert.deepStrictEqual(Object.keys(migrado).sort(), [`${A}:-100777`, `${A}:555`, `${A}:666`, 'web:local'].sort());
  assert.strictEqual(migrado[`${A}:666`].lastConversationId, 'nuevo-666', 'si ya existía la clave nueva, gana la nueva');
  assert.strictEqual(migrado['web:local'].lastConversationId, 'web', 'la web no cambia');
  assert.strictEqual(state.getConversationId({ bot: A, chat: 555 }), 'viejo-555', 'el hilo sigue después de migrar');
  const antes = fs.readFileSync(TEST_STATE_FILE, 'utf8');
  assert.strictEqual(state.migrarChats(A), 0, 'correrla otra vez no migra nada');
  assert.strictEqual(fs.readFileSync(TEST_STATE_FILE, 'utf8'), antes, 'ni escribe');
  assert.strictEqual(state.migrarChats(null), 0, 'sin bot principal no hace nada');

  // 5. Un notify.js anterior: su parseState solo conserva estos cuatro campos y
  // escribe reacciones como `<chat>:<messageId>` y preguntas sin `botId`.
  const escrituraVieja = (mutar) => {
    const p = leerCrudo();
    const viejo = { chats: p.chats || {}, pendingAsks: p.pendingAsks || {}, claudeSession: p.claudeSession || null, reaccionables: p.reaccionables || {} };
    mutar(viejo);
    escribirCrudo(viejo);
  };
  escrituraVieja((v) => {
    v.reaccionables[`${chat}:9001`] = { alma: 'alya', superficie: 'telegram', modalidad: 'voz', extracto: 'de notify viejo', ts: new Date().toISOString(), respondido: false };
    v.pendingAsks['ask-viejo'] = { askId: 'ask-viejo', question: '¿sí?', options: ['sí'], chatId: chat, messageId: 5, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), timeoutSeconds: 60, status: 'pending', answer: null };
  });
  assert.strictEqual(leerCrudo().chats[`${A}:555`].lastConversationId, 'viejo-555', 'la escritura vieja conserva las claves nuevas de chats');
  assert.strictEqual(state.getReaccionable(9001, deA)?.extracto, 'de notify viejo', 'el principal lee la reacción vieja');
  assert.strictEqual(state.getReaccionable(9001, deB), null, 'otro bot nunca ve la forma vieja');
  assert.strictEqual(state.tomarReaccionable(9001, deB), null, 'ni la puede reclamar');
  assert(state.tomarReaccionable(9001, deA), 'el principal sí');
  assert.strictEqual(state.resolvePendingAsk('ask-viejo', 'sí', 1)?.answer, 'sí', 'un ask sin botId se resuelve');
  assert.strictEqual(state.getPendingAsk('ask-viejo').botId, undefined, 'y sigue sin botId: es del principal');

  // 6. Reacciones: el mismo message_id en A y en B son dos entradas.
  state.registrarReaccionable(9100, { alma: 'alya', extracto: 'de A' }, deA);
  state.registrarReaccionable(9100, { alma: 'diego', extracto: 'de B' }, deB);
  const mapa = leerCrudo().reaccionables;
  assert(mapa[`${A}:${chat}:9100`] && mapa[`${B}:${chat}:9100`], 'dos claves, una por bot');
  assert(!mapa[`${chat}:9100`] && !mapa['9100'], 'la escritura siempre va en la forma nueva');
  assert.strictEqual(state.tomarReaccionable(9100, deB)?.alma, 'diego', 'B reclama la suya');
  assert.strictEqual(state.tomarReaccionable(9100, deB), null, 'una sola vez');
  assert.strictEqual(state.getReaccionable(9100, deA).respondido, false, 'reaccionar en B no toca la de A');
  assert.strictEqual(state.getReaccionable(9100, 'web:local'), null, 'la web tiene su propia clave');

  // 7. Preguntas: se guarda de qué bot son.
  state.registerPendingAsk('ask-nuevo', { question: '¿?', options: ['a'], chatId: chat, messageId: 6, timeoutSeconds: 60 });
  assert.strictEqual(state.getPendingAsk('ask-nuevo').botId, A, 'por defecto, el principal');
  state.registerPendingAsk('ask-de-b', { question: '¿?', options: ['a'], chatId: chat, messageId: 7, timeoutSeconds: 60, botId: B });
  assert.strictEqual(state.getPendingAsk('ask-de-b').botId, B);
  assert(state.expirePendingAsk('ask-nuevo'), 'vence igual');

  // 8. Fuente: ninguna llamada de bot.js a una función de chat recibe el id suelto.
  const fuente = fs.readFileSync(new URL('../bot.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const sueltas = fuente.match(/\b(getConversationId|setConversationId|clearConversationId|setModoCharla|getModoCharla|limpiarModoCharla|getUltimoWorkspaceCast|setUltimoWorkspaceCast|resolverWorkspaceDeCast)\((ctx\.chat\.id|chatId)\b/g)
    || [];
  const reaccSueltas = fuente.match(/\b(registrarReaccionable|getReaccionable|tomarReaccionable)\([^;]*?,\s*(ctx\.chat\.id|chatId)\)/g) || [];
  assert.deepStrictEqual([...sueltas, ...reaccSueltas], [], 'bot.js no pasa ctx.chat.id ni chatId a state.js');

  // 9. Tarea encolada: guarda su `ref` y el consumidor escribe con ella aunque
  // haya esperado en la cola. Dos bots, mismo chat, el de B espera al de A.
  botMod.resetRuntimeState();
  const { bot: botA } = botDePrueba();
  const { bot: botB } = botDePrueba();
  botB.botInfo = { ...botB.botInfo, id: Number(B) };
  let liberarA;
  const esperaA = new Promise((r) => { liberarA = r; });
  const corridas = [];
  botMod.usarEjecutoresDePrueba({
    runAgyTask: async ({ prompt }) => {
      corridas.push(prompt);
      if (prompt.includes('uno')) await esperaA;
      return { success: true, data: {}, durationSeconds: 1, conversationId: prompt.includes('uno') ? 'hilo-A' : 'hilo-B' };
    }
  });
  const chatVivo = { bot: A, chat: Number(USUARIO_OK) };
  const chatVivoB = { bot: B, chat: Number(USUARIO_OK) };
  try {
    await botA.handleUpdate(comandoDe('/run uno', 14301));
    await botB.handleUpdate(comandoDe('/run dos', 14302));
    assert.deepStrictEqual(corridas, ['uno'], 'la de B espera en la cola mientras corre la de A');
    liberarA();
    const limite = Date.now() + 3000;
    while (state.getConversationId(chatVivoB) !== 'hilo-B' && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
    assert.deepStrictEqual(corridas.length, 2, 'corrieron las dos');
    assert.strictEqual(state.getConversationId(chatVivo), 'hilo-A', 'el hilo de A quedó en A');
    assert.strictEqual(state.getConversationId(chatVivoB), 'hilo-B', 'y el de B, que esperó en la cola, en B');
  } finally {
    botMod.resetRuntimeState();
  }
}
console.log('✔ Test 143 [BE-051]: estado de Telegram por (bot, chat), migración y convivencia con un notify.js anterior');

// Test 144 [FEAT-091]: varios bots en solo (pasos 1-4). leerBots y su tabla de
// validación, salida por el bot del pedido, perfil del bot de alma, destino de
// las programaciones, aviso de la consola por el bot del alma y el arranque de
// un bot extra que se cae.
{
  const botMod = await import('../bot.js');
  const bots = await import('../bots.js');
  const prog = await import('../programaciones.js');
  const tareas = await import('../tareas.js');
  const cola = await import('../queue.js');
  const ALMA_TOKEN = '2223334445:AAalmaFakeTokenForTestingOnly';
  const ALMA_ID = '2223334445';
  const permitidos = `${USUARIO_OK},${USUARIO_AJENO}`;

  // 1. leerBots: cada fila del §3.3.
  const base = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, ALLOWED_USER_IDS: permitidos };
  const leer = (extra, opciones) => bots.leerBots({ ...base, ...extra }, opciones);
  const solo = leer({});
  assert.deepStrictEqual(solo.bots.map((b) => [b.nombre, b.botId, b.general]), [['general', BOT_ID_PRUEBA, true]], 'sin TELEGRAM_BOTS, solo el general');
  assert.deepStrictEqual(solo.errores, []);
  const bien = leer({ TELEGRAM_BOTS: 'alya, casa-wsl', TELEGRAM_BOT_ALYA_TOKEN: ALMA_TOKEN, TELEGRAM_BOT_ALYA_VINCULO: 'alma:alya', TELEGRAM_BOT_ALYA_USUARIOS: USUARIO_OK,
    TELEGRAM_BOT_CASA_WSL_TOKEN: '3334445556:AAnodo', TELEGRAM_BOT_CASA_WSL_VINCULO: 'nodo:casa-wsl' }, { rol: 'servidor' });
  const alya = bien.bots.find((b) => b.nombre === 'alya');
  assert.deepStrictEqual([alya.botId, alya.vinculo, [...alya.usuarios]], [ALMA_ID, { tipo: 'alma', ref: 'alya' }, [USUARIO_OK]]);
  assert(bien.bots.some((b) => b.nombre === 'casa-wsl' && b.vinculo.tipo === 'nodo'), 'casa-wsl lee TELEGRAM_BOT_CASA_WSL_* (en rol servidor)');
  const casos = [
    [{ TELEGRAM_BOTS: 'Alya_1' }, /nombre inválido/],
    [{ TELEGRAM_BOTS: 'alya' }, /TOKEN falta/],
    [{ TELEGRAM_BOTS: 'alya', TELEGRAM_BOT_ALYA_TOKEN: 'sin-forma' }, /TOKEN falta o no tiene la forma/],
    [{ TELEGRAM_BOTS: 'alya', TELEGRAM_BOT_ALYA_TOKEN: ALMA_TOKEN, TELEGRAM_BOT_ALYA_VINCULO: 'alya' }, /VINCULO tiene que ser/],
    [{ TELEGRAM_BOTS: 'alya', TELEGRAM_BOT_ALYA_TOKEN: ALMA_TOKEN, TELEGRAM_BOT_ALYA_VINCULO: 'agente:revisor' }, /agente reservado, sin implementar/],
    [{ TELEGRAM_BOTS: 'alya', TELEGRAM_BOT_ALYA_TOKEN: ALMA_TOKEN, TELEGRAM_BOT_ALYA_VINCULO: 'servidor:x' }, /solo del bot general/],
    [{ TELEGRAM_BOTS: 'wsl', TELEGRAM_BOT_WSL_TOKEN: ALMA_TOKEN, TELEGRAM_BOT_WSL_VINCULO: 'nodo:casa' }, /necesitan rol servidor/],
    [{ TELEGRAM_BOTS: 'alya', TELEGRAM_BOT_ALYA_TOKEN: FAKE_TOKEN, TELEGRAM_BOT_ALYA_VINCULO: 'alma:alya' }, /mismo bot .* que general/],
    [{ TELEGRAM_BOTS: 'alya,otra', TELEGRAM_BOT_ALYA_TOKEN: ALMA_TOKEN, TELEGRAM_BOT_ALYA_VINCULO: 'alma:alya', TELEGRAM_BOT_OTRA_TOKEN: '5556667778:AAx', TELEGRAM_BOT_OTRA_VINCULO: 'alma:alya' }, /ya es de alya/, 'otra'],
    [{ TELEGRAM_BOTS: 'alya', TELEGRAM_BOT_ALYA_TOKEN: ALMA_TOKEN, TELEGRAM_BOT_ALYA_VINCULO: 'alma:alya', TELEGRAM_BOT_ALYA_USUARIOS: '424242' }, /fuera de ALLOWED_USER_IDS/]
  ];
  for (const [extra, motivo, descartado = null] of casos) {
    const r = leer(extra);
    assert(r.bots[0]?.general, `el general sigue: ${JSON.stringify(extra)}`);
    if (descartado) assert(!r.bots.some((b) => b.nombre === descartado) && r.bots.length === 2, `se queda el primero y sale ${descartado}`);
    else assert.strictEqual(r.bots.length, 1, `descarta el bot: ${JSON.stringify(extra)}`);
    assert(r.errores.some((e) => motivo.test(e)), `motivo ${motivo}: ${r.errores.join(' | ')}`);
    assert(!r.errores.join(' ').includes('AA'), 'el secreto no aparece en los errores');
  }
  const nodoEnNodo = leer({ TELEGRAM_BOTS: 'alya', TELEGRAM_BOT_ALYA_TOKEN: ALMA_TOKEN, TELEGRAM_BOT_ALYA_VINCULO: 'alma:alya' }, { rol: 'nodo' });
  assert(nodoEnNodo.bots.length === 0 && /se ignora en rol nodo/.test(nodoEnNodo.errores[0]), 'en rol nodo no se lee ningún token');

  // 2. botParaSalida / chatPorDefecto.
  const lista = bien.bots;
  assert.strictEqual(bots.botParaSalida(lista, { alma: 'alya' }).nombre, 'alya');
  assert.strictEqual(bots.botParaSalida(lista, { alma: 'diego' }).nombre, 'general', 'sin bot de esa alma, el general');
  assert.strictEqual(bots.botParaSalida(lista, { alma: 'diego', nodo: 'casa-wsl' }).nombre, 'casa-wsl', 'sin bot de alma, el del nodo');
  assert.strictEqual(bots.botParaSalida(lista.map((b) => (b.nombre === 'alya' ? { ...b, caido: '401' } : b)), { alma: 'alya' }).nombre, 'general', 'un bot caído se salta');
  assert.strictEqual(bots.chatPorDefecto(alya, { TELEGRAM_NOTIFY_CHAT_ID: USUARIO_AJENO }), USUARIO_OK, 'TELEGRAM_NOTIFY_CHAT_ID solo si es usuario del bot');
  assert.strictEqual(bots.chatPorDefecto(bien.bots[0], { TELEGRAM_NOTIFY_CHAT_ID: USUARIO_AJENO }), USUARIO_AJENO);

  // 3. Ningún bot atiende antes de tener botInfo (lo da getMe en bot.start).
  const crudo = createBot({ token: '9998887776:AAsinIniciar', allowedUserIds: new Set([USUARIO_OK]) });
  await assert.rejects(crudo.handleUpdate(comandoDe('/status', 14400)), /not initialized|botInfo/i, 'sin init no atiende');

  // Dos bots en el mismo proceso: el general (botDePrueba) y el de Alya.
  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-bots-'));
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });
  semilla.sembrar('diego', { name: 'Diego', personality: 'Calmo', language: 'es' });
  const envPrevio = Object.fromEntries(['ALLOWED_USER_IDS', 'TELEGRAM_BOTS', 'TELEGRAM_BOT_ALYA_TOKEN', 'TELEGRAM_BOT_ALYA_VINCULO'].map((k) => [k, process.env[k]]));
  process.env.ALLOWED_USER_IDS = USUARIO_OK;
  const { bot: general, llamadas: deGeneral } = botDePrueba();
  const almaBot = createBot({ token: ALMA_TOKEN, allowedUserIds: new Set([USUARIO_OK]), vinculo: { tipo: 'alma', ref: 'alya' }, nombre: 'alya' });
  const deAlma = [];
  almaBot.api.config.use(async (prev, method, payload) => {
    deAlma.push({ method, payload });
    if (method === 'sendMessage') return { ok: true, result: { message_id: 5000 + deAlma.length, date: 0, chat: { id: Number(payload.chat_id) }, text: payload.text } };
    return { ok: true, result: true };
  });
  almaBot.botInfo = { ...general.botInfo, id: Number(ALMA_ID), username: 'alya_bot' };
  const textos = (ll) => ll.filter((x) => x.method === 'sendMessage').map((x) => String(x.payload.text)).join('\n');
  const charlas = [];
  botMod.resetRuntimeState();
  botMod.usarEjecutoresDePrueba({
    charlar: async ({ clave, texto }) => { charlas.push({ clave, texto }); return { ok: true, clave, respuesta: `soy ${clave}`, aplicadas: [], rechazadas: [] }; }
  });
  const esperar = async (cond) => {
    const limite = Date.now() + 3000;
    while (!cond() && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
  };
  let id = 14410;
  const aAlma = async (texto) => { await almaBot.handleUpdate(comandoDe(texto, id++)); };
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bots-'));
  let web = null;
  prog.reiniciarParaTests();
  for (const p of prog.listar()) prog.borrar(p.id);
  try {
    // 4-6. Perfil del bot de alma: texto libre → su alma, sin /charla previo.
    await aAlma('hola, ¿cómo estás?');
    await esperar(() => charlas.length === 1 && textos(deAlma).includes('soy alya'));
    assert.deepStrictEqual(charlas[0], { clave: 'alya', texto: 'hola, ¿cómo estás?' }, 'el texto libre charla con su alma');
    assert(textos(deAlma).includes('soy alya'), 'y la respuesta sale por el bot del alma');
    assert(!textos(deGeneral).includes('soy alya'), 'no por el general');
    assert(state.getModoCharla({ bot: BOT_ID_PRUEBA, chat: Number(USUARIO_OK) }) === null, 'el modo charla del general no se toca');

    deAlma.length = 0;
    await aAlma('/nodo');
    assert(textos(deAlma).includes('Este bot es de alma:alya'), `/nodo dice el vínculo: ${textos(deAlma)}`);
    for (const cmd of ['/run algo', '/cast lector revisá', '/plan x', '/cron']) {
      deAlma.length = 0;
      await aAlma(cmd);
      assert(textos(deAlma).includes('Este bot es de Alya. Para trabajar, usá el bot general.'), `${cmd} responde el perfil: ${textos(deAlma)}`);
    }
    deAlma.length = 0;
    await almaBot.handleUpdate({ update_id: id++, message: { message_id: 77, date: 0, chat: { id: Number(USUARIO_OK), type: 'private' }, from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'T' }, document: { file_id: 'f', file_unique_id: 'u', file_name: 'a.txt' } } });
    assert(textos(deAlma).includes('Para trabajar, usá el bot general'), 'un adjunto también');

    deAlma.length = 0;
    await aAlma('/charla diego contame algo');
    assert(textos(deAlma).includes('habla solo con Alya'), '/charla con otra alma se rechaza');
    await aAlma('/alma diego');
    assert(textos(deAlma).includes('acá solo se ve su memoria'), '/alma de otra alma se rechaza');
    deAlma.length = 0;
    await aAlma('/alma');
    assert(textos(deAlma).includes('Alya') && textos(deAlma).includes('Su memoria'), '/alma muestra la suya');
    deAlma.length = 0;
    await aAlma('/charla nuevo');
    assert(/Hilo nuevo con .*Alya/.test(textos(deAlma)), '/charla nuevo con su alma');
    await aAlma('/charla alya seguimos');
    await esperar(() => charlas.length === 2);
    assert.deepStrictEqual(charlas[1], { clave: 'alya', texto: 'seguimos' }, 'nombrar a la propia alma vale');
    await esperar(() => !botMod.carrilOcupado('alma'));
    deAlma.length = 0;
    await aAlma('/cancel');
    assert(textos(deAlma).includes('No hay ninguna charla en curso'), '/cancel solo mira el carril alma');
    deAlma.length = 0;
    await aAlma('/help');
    assert(textos(deAlma).includes('solo para charlar con Alya'), '/help es el del perfil');

    // Un bot de un alma que ya no existe: avisa y no manda a trabajo.
    const huerfano = createBot({ token: '7778889990:AAhuerfano', allowedUserIds: new Set([USUARIO_OK]), vinculo: { tipo: 'alma', ref: 'fantasma' }, nombre: 'fantasma' });
    const deHuerfano = [];
    huerfano.api.config.use(async (prev, method, payload) => { deHuerfano.push({ method, payload }); return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1 }, text: '' } }; });
    huerfano.botInfo = { ...general.botInfo, id: 7778889990 };
    await huerfano.handleUpdate(comandoDe('hola', id++));
    assert(textos(deHuerfano).includes('Ya no tengo un alma llamada «fantasma»'), 'alma borrada: se avisa');
    assert.strictEqual(charlas.length, 2, 'y no se charla ni se trabaja');

    // 11-12. Programaciones: /cron nueva guarda destino; se dispara por ese bot.
    const f = (h) => new Date(2026, 8, 18, h, 0, 0, 0);
    const esperarVacio = async () => {
      const limite = Date.now() + 3000;
      while (Date.now() < limite && (cola.getQueueLength('programado') > 0 || botMod.carrilOcupado('programado'))) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 30));
    };
    await general.handleUpdate(comandoDe('/cron nueva cada 2h | alya | ¿algo raro?', id++));
    const creada = prog.listar().find((p) => p.pedido === '¿algo raro?');
    assert.deepStrictEqual(creada?.destino, { bot: BOT_ID_PRUEBA, chat: Number(USUARIO_OK) }, '/cron nueva guarda el bot y el chat donde se pidió');
    prog.borrar(creada.id);

    const sujeto = { tipo: 'alma', clave: 'alya', voz: 'Alya' };
    const conDestino = prog.crear({ titulo: 'por alya', pedido: 'p1', sujeto, horario: 'cada 1h', origen: 'telegram', destino: { bot: ALMA_ID, chat: USUARIO_OK }, ahora: () => f(1) }).programacion;
    assert.deepStrictEqual(conDestino.destino, { bot: ALMA_ID, chat: Number(USUARIO_OK) });
    assert.strictEqual(prog.crear({ titulo: 'x', pedido: 'p', sujeto, horario: 'cada 1h', origen: 'web', destino: { bot: ALMA_ID, chat: 1 }, ahora: () => f(1) }).programacion.destino, undefined, 'destino solo en las de Telegram');
    for (const p of prog.listar()) if (p.id !== conDestino.id) prog.borrar(p.id);
    deAlma.length = 0; deGeneral.length = 0;
    await botMod.pasoDelReloj({ ahora: () => f(2) });
    await esperarVacio();
    assert(textos(deAlma).includes('soy alya'), `con destino, el resultado sale por ese bot: ${textos(deAlma)}`);
    assert(!textos(deGeneral).includes('soy alya'), 'y no por el general');
    prog.borrar(conDestino.id);

    const sinDestino = prog.crear({ titulo: 'vieja', pedido: 'p2', sujeto, horario: 'cada 1h', origen: 'telegram', ahora: () => f(3) }).programacion;
    deAlma.length = 0; deGeneral.length = 0;
    await botMod.pasoDelReloj({ ahora: () => f(4) });
    await esperarVacio();
    assert(textos(deGeneral).includes('soy alya') && !textos(deAlma).includes('soy alya'), 'sin destino, por el general, como antes');
    prog.borrar(sinDestino.id);

    // 11. La copia al teléfono de una programación de la consola sale por el bot del alma.
    process.env.TELEGRAM_BOTS = 'alya';
    process.env.TELEGRAM_BOT_ALYA_TOKEN = ALMA_TOKEN;
    process.env.TELEGRAM_BOT_ALYA_VINCULO = 'alma:alya';
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile: path.join(raiz, 'web-token.json') });
    const deConsola = prog.crear({ titulo: 'guardia', pedido: 'p3', sujeto, horario: 'cada 1h', avisarTelegram: true, ahora: () => f(5) }).programacion;
    deAlma.length = 0; deGeneral.length = 0;
    await botMod.pasoDelReloj({ ahora: () => f(6) });
    await esperarVacio();
    await esperar(() => textos(deAlma).includes('guardia'));
    assert(textos(deAlma).includes('guardia') && textos(deAlma).includes('programada en la consola'), `la copia sale por el bot de Alya: ${textos(deAlma)}`);
    assert(!textos(deGeneral).includes('guardia'), 'y no por el general');
    prog.borrar(deConsola.id);

    // 4.2. Un bot extra que no arranca queda caído y se reintenta.
    let intentos = 0;
    await botMod.arrancarBotExtra({ nombre: 'alya', botId: ALMA_ID }, {
      reintentoMs: 10,
      iniciar: (b, onStart) => {
        intentos++;
        if (intentos === 1) return Promise.reject(Object.assign(new Error('x'), { error: { error_code: 401, description: 'Unauthorized' } }));
        onStart({ username: 'alya_bot' });
        return new Promise(() => {});
      }
    });
    await esperar(() => intentos >= 2);
    assert.strictEqual(intentos, 2, 'se reintentó después de caer');
  } finally {
    if (web) await new Promise((r) => web.servidor.close(r));
    botMod.resetRuntimeState();
    for (const p of prog.listar()) prog.borrar(p.id);
    prog.reiniciarParaTests();
    tareas.reiniciarParaTests();
    for (const [k, v] of Object.entries(envPrevio)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.LAGRANGE_ALMAS_DIR;
    for (const d of [raiz, almasDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}
console.log('✔ Test 144 [FEAT-091]: varios bots en solo: tabla de leerBots, perfil de alma, destino de programaciones y aviso por el bot del alma');

// Test 145 [FEAT-089]: lo de servidor y nodo que vive en bot.js. El plan de
// arranque con rol servidor, el núcleo sin HTTP (§6.1), la salida remota de un
// nodo para lo que produce el propio daemon (§5.5), el Telegram acotado del
// servidor para sus nodos (§5.2) y el reenvío de la respuesta de un ask (§5.3).
{
  const botMod = await import('../bot.js');
  const prog = await import('../programaciones.js');
  const tareas = await import('../tareas.js');
  const cola = await import('../queue.js');
  const stateMod = await import('../state.js');
  const { CHAT_WEB_LOCAL } = await import('../web/canal.js');

  // 1. Plan de arranque.
  const T = FAKE_TOKEN;
  assert(/BRIDGE_WEB=1/.test(botMod.planDeArranque({ BRIDGE_ROL: 'servidor', TELEGRAM_BOT_TOKEN: T }).fatal || ''), 'servidor sin consola → fatal');
  const srv = botMod.planDeArranque({ BRIDGE_ROL: 'servidor', TELEGRAM_BOT_TOKEN: T, ALLOWED_USER_IDS: USUARIO_OK, BRIDGE_WEB: '1', BRIDGE_NOMBRE_NODO: 'casa' });
  assert(!srv.fatal && srv.polling && srv.web && srv.red === 'servidor' && srv.nombre === 'casa', `servidor con consola: ${JSON.stringify(srv)}`);
  assert.strictEqual(botMod.planDeArranque({ BRIDGE_ROL: 'nodo' }).red, 'nodo');
  assert(/BRIDGE_NOMBRE_NODO/.test(botMod.planDeArranque({ BRIDGE_ROL: 'nodo', BRIDGE_NOMBRE_NODO: 'A]b' }).fatal || ''), 'un nombre inválido es fatal');
  assert.strictEqual(botMod.planDeArranque({ TELEGRAM_BOT_TOKEN: T }).red, null, 'solo no tiene red');

  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-red-'));
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  const semilla = (await import('../../mcp-server/almas/semilla.js')).default;
  semilla.sembrar('alya', { name: 'Alya', personality: 'Tsundere', language: 'es' });
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-red-'));
  const logFile = path.join(raiz, 'daemon.log');
  botMod.resetRuntimeState();
  prog.reiniciarParaTests();
  for (const p of prog.listar()) prog.borrar(p.id);
  let armado = null;
  try {
    // 2. armarNucleo sin HTTP publica los cambios en el canal.
    armado = botMod.armarNucleo({ logFile });
    const eventos = [];
    armado.canal.suscribir(CHAT_WEB_LOCAL, (e) => eventos.push(e));
    const f = (h) => new Date(2026, 8, 26, h, 0, 0, 0);
    const sujeto = { tipo: 'alma', clave: 'alya', voz: 'Alya' };
    const p1 = prog.crear({ titulo: 'guardia', pedido: '¿algo?', sujeto, horario: 'cada 1h', avisarTelegram: true, ahora: () => f(1) }).programacion;
    assert(eventos.some((e) => e.tipo === 'programacion' && e.programacion.id === p1.id), 'armarNucleo publica programacion sin servir HTTP');
    const tarjeta = tareas.crearTarjeta({ titulo: 'x', pedido: 'y', sujeto });
    assert(eventos.some((e) => e.tipo === 'tarea' && e.tarea.id === (tarjeta.tarea?.id ?? tarjeta.id)), 'y tarea');
    if (tarjeta.tarea?.id ?? tarjeta.id) tareas.borrar?.(tarjeta.tarea?.id ?? tarjeta.id);

    // 3. §5.5 — En un nodo, lo que produce el propio daemon sale por el chat
    // centinela `nodo:servidor`: `sendMessage` va por la operación `mensaje`, y
    // el progreso (`editMessageText`, `sendChatAction`) no cruza.
    // FEAT-090 §3.6 — Y una programación de alma en un nodo se pospone: las
    // almas corren en el servidor.
    const enviados = [];
    botMod.usarRedParaTests({ rol: 'nodo', cliente: { mensaje: async (m) => { enviados.push(m); return { ok: true }; } } });
    const remota = botMod.salidaParaTests('nodo:servidor');
    await remota.sendMessage('nodo:servidor', 'resultado <b>final</b>', { parse_mode: 'HTML' });
    await remota.editMessageText('nodo:servidor', 1, 'progreso');
    await remota.sendChatAction('nodo:servidor', 'typing');
    assert.deepStrictEqual(enviados, [{ texto: 'resultado <b>final</b>', html: true }], `solo el resultado cruza, con su formato: ${JSON.stringify(enviados)}`);
    const p2 = prog.crear({ titulo: 'de telegram', pedido: 'p', sujeto, horario: 'cada 1h', origen: 'telegram', destino: { bot: BOT_ID_PRUEBA, chat: USUARIO_OK }, ahora: () => f(3) }).programacion;
    const disparo = await botMod.dispararProgramacion(p2, { ahora: () => f(4) });
    const pospuesta = prog.obtener(p2.id);
    assert(disparo.ok === false && JSON.stringify(pospuesta).includes('las almas viven en el servidor') && !(pospuesta.fallosSeguidos > 0), `una de alma en un nodo se pospone sin fallar: ${JSON.stringify(disparo)}`);
    prog.borrar(p1.id);
    prog.borrar(p2.id);
    botMod.resetRuntimeState();

    // 4. §5.2 — El Telegram del servidor para sus nodos.
    const llamadasApi = [];
    const apiFalsa = new Proxy({}, {
      get: (_, metodo) => async (...args) => { llamadasApi.push({ metodo, args }); return { message_id: 900 + llamadasApi.length }; }
    });
    const tg = botMod.telegramParaNodos({ api: () => apiFalsa, chat: () => Number(USUARIO_OK) });
    await tg.mensaje({ nombre: 'casa-wsl', texto: 'hola <b>' });
    const m0 = llamadasApi[0];
    assert(m0.metodo === 'sendMessage' && m0.args[0] === Number(USUARIO_OK) && m0.args[1].startsWith('<b>[casa-wsl]</b> ') && !m0.args[1].includes('hola <b>'), `mensaje con prefijo y escapado: ${m0.args[1]}`);
    await tg.archivo({ nombre: 'casa-wsl', buffer: Buffer.from('x'), pie: 'informe', archivo: '../../etc/pass<wd>' });
    const doc = llamadasApi.find((l) => l.metodo === 'sendDocument');
    assert(doc && doc.args[1].filename === 'pass<wd>', `el nombre del adjunto es solo el último tramo: ${doc?.args[1].filename}`);
    const askId = `ask_${'d'.repeat(16)}`;
    const preg = await tg.preguntar({ nodo: 'n1', nombre: 'casa-wsl', askId, pregunta: '¿Sigo?', opciones: ['Sí', 'No'], timeoutSeconds: 60 });
    const pendiente = stateMod.getPendingAsk(askId);
    assert(preg.messageId && pendiente?.nodo === 'n1' && pendiente.chatId === Number(USUARIO_OK), `el ask queda registrado con su nodo: ${JSON.stringify(pendiente)}`);
    await assert.rejects(tg.preguntar({ nodo: 'n2', nombre: 'otro', askId, pregunta: 'x', opciones: ['a'], timeoutSeconds: 60 }), /ya existe/, 'un askId repetido no pisa la pregunta de otro nodo');
    assert.strictEqual((await tg.quitarBotones({ nodo: 'n2', askId })).ok, false, 'otro nodo no puede quitarle los botones');

    // 5. §5.3 — Al tocar el botón, la respuesta vuelve al nodo como texto.
    const reenviados = [];
    botMod.usarRedParaTests({ rol: 'servidor', servidorNodos: { askRespondido: (nodo, datos) => reenviados.push({ nodo, ...datos }) } });
    const { bot: general } = botDePrueba();
    await general.handleUpdate({
      update_id: 14501,
      callback_query: {
        id: '14501', from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' }, chat_instance: 'ci', data: `ask:${askId}:1`,
        message: { message_id: preg.messageId, date: 0, chat: { id: Number(USUARIO_OK), type: 'private' }, from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'bot' }, text: 'q' }
      }
    });
    assert.deepStrictEqual(reenviados.map((r) => [r.nodo, r.askId, r.respuesta, r.indice]), [['n1', askId, 'No', 1]], `se reenvía el texto elegido al nodo: ${JSON.stringify(reenviados)}`);
    assert.strictEqual(stateMod.getPendingAsk(askId).status, 'answered', 'y el ask queda resuelto en el servidor');
  } finally {
    armado?.cerrar();
    botMod.resetRuntimeState();
    for (const p of prog.listar()) prog.borrar(p.id);
    prog.reiniciarParaTests();
    tareas.reiniciarParaTests();
    delete process.env.LAGRANGE_ALMAS_DIR;
    for (const d of [raiz, almasDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}
console.log('✔ Test 145 [FEAT-089]: rol servidor, núcleo sin HTTP, salida remota del nodo, Telegram acotado para nodos y reenvío de asks');

// Test 146 [BE-072]: el plan corre con el agente de solo lectura y sin skip, y
// «Ejecutar cambios» abre un hilo nuevo con el texto del plan. Medido en agy
// 1.2.13: `--mode plan` con skip escribe y corre comandos, y sin skip
// `write_to_file` escribe igual; lo único que frena es un agente sin tools de
// escritura, y agy lo fija en el primer turno del hilo.
{
  const executor = await import('../executor.js');
  const botMod = await import('../bot.js');
  const agentePlan = (await import('../../mcp-server/agents/agente-plan.js')).default;
  const registro = (await import('../../mcp-server/agents/registry.js')).default;
  const { spawn: spawnReal } = await import('node:child_process');

  // 1. El agent.md: exactamente las tools de lectura, ninguna de escritura.
  const md = agentePlan.contenidoAgente();
  const tools = md.split('---')[1].split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2));
  assert.deepStrictEqual(tools, registro.TOOLS_LECTURA, 'lagrange-plan lleva TOOLS_LECTURA tal cual');
  for (const t of registro.TOOLS_ESCRITURA) assert(!md.includes(t), `lagrange-plan no lleva ${t}`);

  // 2. Flags: plan sin skip y con --agent; accept-edits con skip y sin --agent.
  let capturados = null;
  const respuesta = (texto) => (bin, args) => {
    capturados = args;
    const linea = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: texto } });
    return spawnReal(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(linea + '\n')})`]);
  };
  let verificaciones = 0;
  const listo = {
    asegurarAgentePlan: () => ({ cambiado: false }),
    verificarAgentePlan: async () => { verificaciones++; return { ok: true }; },
    marcaAgy: () => 'marca-1'
  };
  executor.olvidarVerificacionPlanParaTests();
  const rPlan = await executor.runAgyTask({ prompt: 'p', mode: 'plan', spawnFn: respuesta('el plan'), ...listo });
  assert.strictEqual(capturados[capturados.indexOf('--mode') + 1], 'plan', 'va --mode plan');
  assert(!capturados.includes('--dangerously-skip-permissions'), 'el plan va SIN skip');
  assert.strictEqual(capturados[capturados.indexOf('--agent') + 1], 'lagrange-plan', 'y con --agent lagrange-plan');
  assert.strictEqual(rPlan.sinRespuesta, false, 'un plan con texto no es sinRespuesta');
  await executor.runAgyTask({ prompt: 'p', mode: 'accept-edits', spawnFn: respuesta('ok'), ...listo });
  assert(capturados.includes('--dangerously-skip-permissions'), 'accept-edits sigue con skip');
  assert(!capturados.includes('--agent'), 'y sin --agent');

  // 3. La verificación se cachea por binario; un fallo no lanza y no se cachea.
  await executor.runAgyTask({ prompt: 'p', mode: 'plan', spawnFn: respuesta('x'), ...listo });
  assert.strictEqual(verificaciones, 1, 'con la misma marca del binario no se vuelve a preguntar a agy');
  executor.olvidarVerificacionPlanParaTests();
  capturados = null;
  const rFalla = await executor.runAgyTask({
    prompt: 'p', mode: 'plan', spawnFn: respuesta('x'),
    ...listo, verificarAgentePlan: async () => ({ ok: false, motivo: 'agy no resuelve lagrange-plan' })
  });
  assert.strictEqual(capturados, null, 'sin agente verificado no hay spawn (--agent falla abierto)');
  assert(!rFalla.success && rFalla.error.includes('no resuelve'), `y se explica: ${rFalla.error}`);
  const rTira = await executor.runAgyTask({ prompt: 'p', mode: 'plan', spawnFn: respuesta('x'), ...listo, asegurarAgentePlan: () => { throw new Error('EACCES'); } });
  assert(!rTira.success && capturados === null, 'si no se puede escribir el agent.md, tampoco');
  const rVacio = await executor.runAgyTask({ prompt: 'p', mode: 'plan', spawnFn: respuesta(''), ...listo });
  assert.strictEqual(rVacio.sinRespuesta, true, 'una respuesta vacía se marca: el relleno no es un plan');

  // 4. Registro de hilos de plan: recorte, tope y vencimiento.
  state.registrarPlan('plan-grande', { texto: 'x'.repeat(40 * 1024) });
  assert(state.getPlan('plan-grande').texto.length < 33 * 1024, 'el texto se recorta');
  for (let i = 0; i < 12; i++) state.registrarPlan(`plan-n${i}`, { texto: `t${i}` });
  assert(!state.esHiloDePlan('plan-n0') && state.esHiloDePlan('plan-n11'), 'se guardan los 10 más recientes');
  const crudo = state.loadState();
  crudo.planes['plan-n11'].ts = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  state.saveState(crudo);
  assert(!state.esHiloDePlan('plan-n11'), 'un plan de más de 7 días vence');

  // 5. El flujo del bot.
  const { bot, llamadas } = botDePrueba();
  botMod.resetRuntimeState();
  const corridas = [];
  let proxima = { success: true, conversationId: 'plan-1', responseText: 'PLAN: tocar a.js', sinRespuesta: false, data: {}, durationSeconds: 1 };
  botMod.usarEjecutoresDePrueba({
    runAgyTask: async (opts) => { corridas.push(opts); return proxima; }
  });
  const esperar = async (n) => {
    const limite = Date.now() + 3000;
    while (corridas.length < n && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 30));
  };
  const chat = tg(Number(USUARIO_OK));
  const callback = (data, updateId) => ({
    update_id: updateId,
    callback_query: {
      id: String(updateId), from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' }, chat_instance: 'ci', data,
      message: { message_id: 1000 + updateId, date: 0, chat: { id: Number(USUARIO_OK), type: 'private' }, from: { id: Number(BOT_ID_PRUEBA), is_bot: true, first_name: 'bot' }, text: 'plan' }
    }
  });
  try {
    // Un plan sobre la sesión de un /run no la retoma: abre su hilo de lectura.
    state.setConversationId(chat, 'hilo-run');
    await bot.handleUpdate(updateDeTexto({ userId: USUARIO_OK, text: 'planeá el cambio', updateId: 14601 }));
    await esperar(1);
    assert.strictEqual(corridas[0].mode, 'plan', 'el texto libre va en plan');
    assert.strictEqual(corridas[0].conversationId, null, 'y NO retoma el hilo del /run (ahí --agent se ignora)');
    assert(llamadas.some((c) => c.method === 'sendMessage' && String(c.payload.text).includes('solo lectura')), 'se avisa que es una sesión nueva');
    assert(state.esHiloDePlan('plan-1'), 'el hilo del plan queda registrado');
    const conBoton = llamadas.filter((c) => c.method === 'sendMessage' && c.payload.reply_markup).at(-1);
    assert(JSON.stringify(conBoton.payload.reply_markup).includes('exec_plan:plan-1'), 'y se ofrece el botón');

    // Ajustar el plan (FEAT-027) sí retoma su hilo: nació de lectura.
    proxima = { ...proxima, responseText: 'PLAN v2: tocar a.js y b.js' };
    await bot.handleUpdate(updateDeTexto({ userId: USUARIO_OK, text: 'sumá b.js', updateId: 14602 }));
    await esperar(2);
    assert.strictEqual(corridas[1].conversationId, 'plan-1', 'el ajuste sigue sobre el hilo del plan');
    assert(state.getPlan('plan-1').texto.includes('v2'), 'y el texto guardado es el último');

    // El botón: hilo nuevo, con el plan como material.
    proxima = { success: true, conversationId: 'hilo-exec', responseText: 'hecho', data: {}, durationSeconds: 1 };
    await bot.handleUpdate(callback('exec_plan:plan-1', 14603));
    await esperar(3);
    assert.strictEqual(corridas[2].mode, 'accept-edits', 'ejecutar escribe');
    assert.strictEqual(corridas[2].conversationId, null, 'en un hilo NUEVO: el del plan no puede escribir');
    assert(corridas[2].prompt.includes('PLAN v2'), 'que recibe el último texto del plan');
    assert.strictEqual(state.getConversationId(chat), 'hilo-exec', 'y queda como sesión del chat para /resume');

    // Un botón de antes de BE-072 (hilo no registrado) no ejecuta nada.
    const antes = llamadas.length;
    await bot.handleUpdate(callback('exec_plan:hilo-viejo', 14604));
    await new Promise((r) => setTimeout(r, 30));
    assert(llamadas.slice(antes).some((c) => c.method === 'answerCallbackQuery' && c.payload.text.includes('anterior')), 'un plan no registrado se rechaza');
    assert.strictEqual(corridas.length, 3, 'sin lanzar agy');

    // /resume con un plan como sesión: igual que el botón.
    state.setConversationId(chat, 'plan-1');
    await bot.handleUpdate(comandoDe('/resume solo la parte de a.js', 14605));
    await esperar(4);
    assert.strictEqual(corridas[3].mode, 'accept-edits', '/resume escribe');
    assert.strictEqual(corridas[3].conversationId, null, 'en un hilo nuevo');
    assert(corridas[3].prompt.startsWith('solo la parte de a.js') && corridas[3].prompt.includes('PLAN v2'), 'con la instrucción y el plan');

    // Un plan vacío no se registra ni ofrece el botón.
    state.clearConversationId(chat);
    proxima = { success: true, conversationId: 'plan-vacio', responseText: '(Sin respuesta generada)', sinRespuesta: true, data: {}, durationSeconds: 1 };
    const antesVacio = llamadas.length;
    await bot.handleUpdate(comandoDe('/plan algo', 14606));
    await esperar(5);
    assert.strictEqual(corridas[4].mode, 'plan', '/plan va en plan');
    assert(!state.esHiloDePlan('plan-vacio'), 'un plan vacío no se registra');
    assert(!llamadas.slice(antesVacio).some((c) => c.method === 'sendMessage' && c.payload.reply_markup), 'ni ofrece ejecutar');
  } finally {
    botMod.resetRuntimeState();
  }
}
console.log('✔ Test 146 [BE-072]: el plan corre como lagrange-plan sin skip, y ejecutarlo abre un hilo nuevo con el plan');

// Test 147 [BE-081]: a 375 px el selector de nodo cede. Con `flex: 0 0 auto` el
// encabezado medía 486 px y estado, tema y cancelar quedaban fuera de pantalla.
{
  const css = fs.readFileSync(new URL('../web/public/app.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const base = css.match(/\n\.selector-nodo \{([^}]*)\}/);
  assert(base, 'falta la regla base de .selector-nodo');
  assert(/flex: 0 1 auto/.test(base[1]) && /min-width: 0/.test(base[1]) && /text-overflow: ellipsis/.test(base[1]), `la regla base cede: ${base[1]}`);
  const iTel = css.indexOf('@media (max-width: 800px) { .selector-nodo { max-width: 110px; } }');
  assert(iTel > css.indexOf(base[0]), 'el tope del teléfono va DESPUÉS de la regla base (si no, la base lo pisa)');
}
console.log('✔ Test 147 [BE-081]: el selector de nodo cede en el teléfono');

// Test 148 [BE-079]: agy informa los tokens acumulados del hilo; al retomar
// uno, el pie lo dice en vez de presentarlos como de este turno.
{
  const { formatExecutionMeta } = await import('../formatter.js');
  const datos = { usage: { input_tokens: 32175, output_tokens: 4, thinking_tokens: 0 } };
  assert(formatExecutionMeta(datos, 5, 'c1', 'plan', 0, { hiloRetomado: true }).includes('• Tokens (acumulado del hilo): '), 'un hilo retomado lo aclara');
  assert(formatExecutionMeta(datos, 5, 'c1', 'plan').includes('• Tokens: '), 'un hilo nuevo, como siempre');
}
console.log('✔ Test 148 [BE-079]: el pie del bridge aclara que los tokens son del hilo');

// Test 149 [BE-105]: una madre con hijas actuales (en Por hacer, en cola o en
// curso) o partiéndose no se lanza como tarea común, ni por el registro ni por
// la web; una hija terminada ya no la frena. Al cargar, una hija en Por hacer de
// una madre cerrada sin lote se desvincula. El cliente ofrece «Preparar lote…».
{
  const botMod = await import('../bot.js');
  const tareas = await import('../tareas.js');
  botMod.resetRuntimeState();
  tareas.reiniciarParaTests();
  const ruta = tareas.rutaTareas();
  try { fs.rmSync(ruta, { force: true }); } catch {}
  const lector = { tipo: 'agente', nombre: 'lector' };
  const lanzar = (id) => tareas.lanzarTarjeta(id, { carril: 'cast', sujeto: lector, workspaceId: 'w1' });
  try {
    const madre = tareas.crearTarjeta({ titulo: 'Madre', pedido: 'partime', sujeto: lector, workspaceId: 'w1' }).tarea;
    const orq = tareas.crear({ carril: 'cast', origen: 'web', sujeto: { tipo: 'agente', nombre: 'architect' }, pedido: 'orquestá', motivo: 'orquestar', madre: madre.id });
    assert.strictEqual(tareas.motivoMadre(madre.id), 'Se está partiendo en hijas.');
    assert.strictEqual(lanzar(madre.id), null, 'partiéndose no se lanza');
    tareas.actualizar(orq.id, { estado: 'ok' });
    assert.strictEqual(tareas.motivoMadre(madre.id), null, 'sin hijas ni orquestación abierta, se puede');

    const hija = tareas.proponerTarjeta({ autor: 'agente:architect', madre: madre.id, titulo: 'Hija', pedido: 'p', sujeto: lector, workspaceId: 'w1' }).tarea;
    assert(/Es madre de 1 hija/.test(tareas.motivoMadre(madre.id)));
    assert.strictEqual(lanzar(madre.id), null, 'con la hija en Por hacer, no');
    // Por la web: 409 con el motivo y nada encolado.
    const web = await botMod.lanzarTarjetaWeb(madre.id, { chat: { id: 'web:local', type: 'private' }, reply: async () => ({}) });
    assert.deepStrictEqual([web.ok, web.codigo, /Es madre de 1 hija/.test(web.error)], [false, 409, true], JSON.stringify(web));
    assert.strictEqual(queue.getQueueLength('cast'), 0, 'nada encolado');
    assert.strictEqual(tareas.lanzarTarjeta(hija.id, { carril: 'cast', sujeto: lector, workspaceId: 'w1' }).estado, 'en_cola');
    assert.strictEqual(lanzar(madre.id), null, 'con la hija en cola, tampoco');
    tareas.actualizar(hija.id, { estado: 'en_curso' });
    assert.strictEqual(lanzar(madre.id), null, 'con la hija en curso, tampoco');
    tareas.actualizar(hija.id, { estado: 'ok' });
    assert(lanzar(madre.id), 'con la única hija terminada, la madre se lanza');

    // Carga: familias que ya quedaron rotas.
    const ahora = new Date().toISOString();
    const t = (id, extra) => ({ id, titulo: id, pedido: 'p', estado: 'por_hacer', motivo: 'mensaje', madre: null, loteId: null, sujeto: null, creada: ahora, eventos: [], notas: [], ...extra });
    const datos = { version: tareas.VERSION, tareas: [
      t('t_madreok', { estado: 'ok', terminada: ahora }),
      t('t_huerfana', { motivo: 'hija', madre: 't_madreok' }),
      t('t_sinmadre', { motivo: 'hija', madre: 't_noexiste' }),
      t('t_lanzada', { motivo: 'hija', madre: 't_madreok', estado: 'ok', terminada: ahora }),
      t('t_madrelote', { estado: 'ok', terminada: ahora, loteId: 'l1' }),
      t('t_delote', { motivo: 'hija', madre: 't_madrelote', loteId: 'l1' }),
      t('t_madreviva', {}),
      t('t_viva', { motivo: 'hija', madre: 't_madreviva' })
    ] };
    fs.writeFileSync(ruta, JSON.stringify(datos));
    tareas.reiniciarParaTests();
    const h = tareas.obtener('t_huerfana');
    assert.deepStrictEqual([h.madre, h.motivo, h.eventos.at(-1).tipo, h.eventos.at(-1).detalle], [null, 'mensaje', 'madre_cerrada', 't_madreok']);
    assert.deepStrictEqual([tareas.obtener('t_sinmadre').madre, tareas.obtener('t_sinmadre').motivo], [null, 'mensaje'], 'madre que ya no existe');
    for (const id of ['t_lanzada', 't_delote', 't_viva']) assert.strictEqual(tareas.obtener(id).motivo, 'hija', `${id} no se toca`);
    assert.strictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')).tareas.find((x) => x.id === 't_huerfana').madre, null, 'se guardó');

    // Solo lectura: no se escribe.
    fs.writeFileSync(ruta, JSON.stringify({ ...datos, version: tareas.VERSION + 1 }));
    tareas.reiniciarParaTests();
    assert.strictEqual(tareas.obtener('t_huerfana').madre, null, 'en memoria se desvincula');
    assert.strictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')).tareas.find((x) => x.id === 't_huerfana').madre, 't_madreok', 'el archivo de solo lectura no cambia');

    // Cliente.
    const js = codigoCliente();
    // FEAT-160 F0 — La regla vive en reglas-tablero.js con su `ctx`; el comportamiento lo prueba feat-160-f0-reglas.
    assert(/function motivoMadre\(id, ctx\)/.test(js) && /const deMadre = motivoMadre\(t\.id, ctx\);/.test(js), 'motivoNoLanzable usa la regla de la madre');
    // FEAT-136 F3 — La tarjeta es un componente (TarjetaPorHacer): el botón de una madre es una línea.
    assert(/const madre = motivoMadre\(t\.id\);/.test(js), 'la tarjeta mira si es madre');
    const boton = js.split('\n').find((l) => l.includes('title=${madre}') && l.includes('>Preparar batch…</button>'));
    assert(boton, 'la tarjeta de una madre ofrece «Preparar batch…»');
    assert(boton.includes('abrirDetalle(t.id)') && !boton.includes('data-nivel') && !boton.includes('disabled'), `«Preparar batch…» es navegación: ${boton}`);
    // FEAT-138 — El detalle de una madre ofrece borrar y reordenar, nunca «Lanzar».
    assert(/if \(motivoMadre\(t\.id\)\) return html`\$\{borrar\}\$\{mover\}`;/.test(js), 'el detalle de una madre no dibuja «Lanzar»');
  } finally {
    botMod.resetRuntimeState();
    try { fs.rmSync(ruta, { force: true }); } catch {}
    tareas.reiniciarParaTests();
  }
}
console.log('✔ Test 149 [BE-105]: una madre con hijas no se lanza como tarea común');

// FEAT-096 — La composición real propaga el opt-in explícito, conserva
// identidad del proceso y mantiene el esquema del acceso sin añadir secretos.
{
  const botMod = await import('../bot.js');
  const { cookieWeb } = await import('../web/servidor.js');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-rendimiento-web-'));
  registrarTemporal(raiz);
  const previoPerf = process.env.BRIDGE_PERF;
  const previoError = console.error;
  let web = null;
  botMod.resetRuntimeState();
  try {
    process.env.BRIDGE_PERF = '1';
    const tokenFile = path.join(raiz, 'web-token.json');
    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0' }, tokenFile });
    const viejoLogin = web.login;
    const get = async (w, headers = null) => pedirWeb(w.servidor.address().port, { ruta: '/api/rendimiento',
      headers: headers || { 'x-lagrange-token': new URL(w.login).searchParams.get('t') } });
    const apagado = (await get(web)).json();
    assert.strictEqual(apagado.enabled, false, 'env literal sin PERF no hereda el opt-in global');
    assert.deepStrictEqual(apagado.muestras, []);
    assert.strictEqual(apagado.versiones.lagrange, JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
    assert.strictEqual(apagado.rol, 'solo');
    await new Promise((r) => web.servidor.close(r)); web = null;

    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0', BRIDGE_PERF: ' 1 ' }, tokenFile });
    const encendido = (await get(web)).json();
    assert.strictEqual(encendido.enabled, true); assert.strictEqual(encendido.muestras.length, 1);
    assert.strictEqual(encendido.instanciaId, apagado.instanciaId, 'identidad del proceso estable, no del servidor');
    assert.strictEqual(encendido.daemon.desde, apagado.daemon.desde);
    assert.strictEqual(encendido.muestras[0].secuencia, 1, 'anillo nuevo al construir otro servidor');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(tokenFile, 'utf8'))).sort(), ['creado', 'login', 'pid', 'url']);
    assert.strictEqual((await get(web, { cookie: `${cookieWeb(web.servidor.address().port)}=${new URL(viejoLogin).searchParams.get('t')}` })).status, 401, 'cookie anterior rechazada');
    const estado = await pedirWeb(web.servidor.address().port, { ruta: '/api/estado', headers: { 'x-lagrange-token': new URL(web.login).searchParams.get('t') } });
    assert.strictEqual(encendido.daemon.desde, estado.json().daemon.desde, 'misma fecha que el estado del núcleo');

    console.error = () => {};
    assert.strictEqual(await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: String(web.servidor.address().port), BRIDGE_PERF: '1' }, tokenFile: path.join(raiz, 'fallido.json') }), null);
    console.error = previoError;
    assert.strictEqual((await get(web)).status, 200, 'fallo del segundo listen no altera la consola viva');
    assert(!fs.existsSync(path.join(raiz, 'fallido.json')));
    await new Promise((r) => web.servidor.close(r)); web = null;
    assert(!fs.existsSync(tokenFile));

    web = await botMod.arrancarWeb({ env: { BRIDGE_WEB: '1', BRIDGE_WEB_PORT: '0', BRIDGE_PERF: 'true' }, tokenFile });
    assert.strictEqual((await get(web)).json().enabled, false, 'solo el literal 1 habilita');
  } finally {
    console.error = previoError;
    if (web) await new Promise((r) => web.servidor.close(r));
    if (previoPerf === undefined) delete process.env.BRIDGE_PERF; else process.env.BRIDGE_PERF = previoPerf;
    botMod.resetRuntimeState();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}
console.log('✔ FEAT-096: opt-in web, identidad, sesiones y cleanup del recolector');

// Limpieza: solo el directorio temporal de test
try {
  fs.rmSync(path.dirname(TEST_STATE_FILE), { recursive: true, force: true });
} catch {}

console.log('--- ✅ Todos los tests pasaron exitosamente ---');


