/**
 * FEAT-201 F3 S0 — Lo que la API v2 suma para el diálogo del daemon en la terminal: `GET /api/v2/daemon/log`
 * (`logDaemon`) y `GET /api/v2/telegram/chats` (`chatTelegram`), las capacidades `daemonLog` y `telegramChats`, y
 * `log.linea` redactada entera antes del corte de 4000. `GET /api/v2/logs` y `/telegram/hilos` no cambian.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const SECRETO = 'valor-resuelto-de-keepass-123';

// bot.js lee state.json de acá (la ruta se fija con el primer uso).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f3s0-'));
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(tmp, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(tmp, 'datos');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(tmp, 'state.json');
process.env.LAGRANGE_ALMAS_DIR = path.join(tmp, 'almas');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });

async function main() {
  const esq = await importar('telegram-bridge/web/v2/esquema.js');
  const lect = await importar('telegram-bridge/web/v2/lecturas.js');
  const prod = await importar('telegram-bridge/web/v2/productores.js');
  const { crearAlmacenEventos } = await importar('telegram-bridge/web/v2/almacen-eventos.js');
  const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
  const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js');
  const contrato = esq.cargarContrato();
  const valida = (n, v) => { const e = esq.validar(contrato, n, v); return { ok: e.length === 0, e }; };
  const redactar = (t) => String(t).split(SECRETO).join('[REDACTED]');
  const sinPrefijos = (texto) => {
    // Ningún prefijo del valor de 8 o más caracteres aparece en lo publicado.
    for (let i = 8; i <= SECRETO.length; i++) if (texto.includes(SECRETO.slice(0, i))) return false;
    return true;
  };

  // ---------------------------------------------------------------- armado
  let logV1 = { encabezado: 'x', contenido: 'uno\ndos' };
  let logV2 = { contenido: '' };
  let chats = { chats: [] };
  const pedidos = [];
  const nucleo = crearNucleoWeb({
    canal: crearCanalWeb(), bot: { almasDisponibles: () => [], agentesCasteables: () => [] }, almas: {}, tareas: {},
    workspaces: () => [], ultimoWorkspace: () => null,
    logs: () => logV1, sesiones: () => ({ chats: [{ canal: 'web', conversationId: 'c', actualizado: null }] }),
    logDaemon: (n) => { pedidos.push(n); return logV2; }, chatsTelegram: () => chats,
    estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true
  });
  const rutas = lect.rutasLecturaV2({ nucleo, estadoDeCarriles: () => [], recorte: 100, arranque: 'arr', redactar });
  const llamar = async (ruta) => {
    const url = new URL(`http://x${ruta}`);
    const r = rutas.find((x) => x.metodo === 'GET' && x.patron.test(url.pathname));
    if (!r) return { sinRuta: true };
    return r.fn({ p: r.patron.exec(url.pathname).slice(1), url, cuerpo: {} });
  };

  // ---------------------------------------------------------------- contrato
  await group('F3 S0 · el contrato', () => {
    check('sigue en 2.0', contrato.version === '2.0');
    check('el contrato se revisa sin problemas (revisarContrato lanza si no)', esq.revisarContrato(contrato) === contrato);
    for (const n of ['logDaemon', 'chatTelegram', 'chatsTelegram']) check(`agregado ${n}`, Boolean(contrato.agregados[n]));
    const base = { ok: true, version: '2.3.0', contrato: '2.0', arranque: 'a', capacidades: { voz: true, fotos: true, claudeRemoto: true, secretos: false, salud: { eventLoop: false }, motores: [] }, limites: { borrador: 1, texto: 1, fotoBytes: 1 } };
    check('capacidades de un 2.2.0 (sin las nuevas) siguen validando', valida('capacidades', base).ok);
    check('con daemonLog y telegramChats validan', valida('capacidades', { ...base, capacidades: { ...base.capacidades, daemonLog: true, telegramChats: true } }).ok);
    check('logDaemon: nivel fuera del enum no valida', !valida('logDaemon', { ok: true, lineas: [{ texto: 'x', nivel: 'grave' }], aviso: null }).ok);
    check('logDaemon: línea de más de 4000 no valida', !valida('logDaemon', { ok: true, lineas: [{ texto: 'x'.repeat(4001), nivel: 'info' }], aviso: null }).ok);
    check('chatTelegram: conversacion de 9 no valida', !valida('chatTelegram', { bot: 'b', conversacion: '123456789', actualizado: null }).ok);
    check('chatTelegram: sin chatId (campo de más) no valida', !valida('chatTelegram', { bot: 'b', conversacion: null, actualizado: null, chatId: 1 }).ok);
  });

  // ---------------------------------------------------------------- GET /daemon/log
  await group('F3 S0 · GET /api/v2/daemon/log', async () => {
    logV2 = { contenido: '[web] arrancó\n\n[x] ❌ falló algo\r\n⚠ aviso de algo\n' };
    const r = await llamar('/api/v2/daemon/log');
    check('valida contra logDaemon', valida('logDaemon', r).ok);
    check('parte en líneas y descarta las vacías', r.lineas.length === 3 && r.lineas[0].texto === '[web] arrancó');
    check('nivel por contenido', r.lineas.map((l) => l.nivel).join() === 'info,error,aviso');
    check('aviso null con contenido', r.aviso === null);
    check('sin encabezado', !('encabezado' in r));
    check('n por defecto 300', pedidos.at(-1) === 300);
    await llamar('/api/v2/daemon/log?n=100');
    check('n=100 pasa', pedidos.at(-1) === 100);
    await llamar('/api/v2/daemon/log?n=7');
    check('n inválido cae a 300', pedidos.at(-1) === 300);

    // Un valor partido entre dos líneas: redactar ve el contenido entero, antes de partirlo.
    const partido = `a ${SECRETO.slice(0, 12)}\n${SECRETO.slice(12)} b`;
    const vistosPorRedactar = [];
    const tapaPartido = (t) => { vistosPorRedactar.push(t); return String(t).split(`${SECRETO.slice(0, 12)}\n${SECRETO.slice(12)}`).join('[REDACTED]\n[REDACTED]'); };
    const rp = lect.logDaemonV2({ contenido: partido }, tapaPartido);
    check('redactar recibe el contenido entero, una vez', vistosPorRedactar.length === 1 && vistosPorRedactar[0] === partido);
    check('partido entre dos líneas: sale tapado', rp.lineas.length === 2 && rp.lineas.every((l) => !l.texto.includes(SECRETO.slice(0, 12)) && !l.texto.includes(SECRETO.slice(12))));
    logV2 = { contenido: `antes ${SECRETO} después\nfin` };
    const rs = await llamar('/api/v2/daemon/log');
    check('un valor resuelto sale tapado', rs.lineas[0].texto === 'antes [REDACTED] después');

    // Atravesando el corte de 4000: se redacta antes de cortar.
    const relleno = 'x'.repeat(3990);
    logV2 = { contenido: `${relleno}${SECRETO} con error` };
    const rc = await llamar('/api/v2/daemon/log');
    check('atravesando el corte: ningún prefijo del valor', rc.lineas.length === 1 && sinPrefijos(rc.lineas[0].texto) && rc.lineas[0].texto.length <= 4000);
    check('el nivel se calcula sobre la línea redactada entera', rc.lineas[0].nivel === 'error');
    const conError = 'x error-yy';
    check('nivelDe es la de productores', lect.logDaemonV2({ contenido: conError }).lineas[0].nivel === prod.nivelDe(conError));
    // Un valor resuelto que contiene «error» no cambia el nivel: se clasifica sobre la línea ya tapada.
    const secretoConError = 'clave-error-resuelta-999';
    const tapaError = (t) => String(t).split(secretoConError).join('[REDACTED]');
    check('un valor con «error» tapado no la marca como error', lect.logDaemonV2({ contenido: `token ${secretoConError}` }, tapaError).lineas[0].nivel === 'info');

    logV2 = { aviso: 'ℹ️ No hay `daemon.log`.' };
    const sin = await llamar('/api/v2/daemon/log');
    check('sin archivo: lineas [] y el aviso del v1', sin.lineas.length === 0 && sin.aviso === 'ℹ️ No hay `daemon.log`.' && valida('logDaemon', sin).ok);
  });

  // ---------------------------------------------------------------- log.linea en vivo
  await group('F3 S0 · log.linea redactada entera antes del corte', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3s0-'));
    try {
      const logFile = path.join(dir, 'daemon.log');
      fs.writeFileSync(logFile, '');
      const almacen = crearAlmacenEventos({ arranque: 'arr', redactar });
      const reg = { suscribir: () => () => {}, obtener: () => null };
      const p = prod.crearProductoresV2({ almacen, registro: reg, recorte: 100, logFile, intervaloLogMs: 60_000, redactar });
      const vistos = [];
      const baja = almacen.suscribir(['log'], (e) => vistos.push(e));
      fs.appendFileSync(logFile, `${'x'.repeat(3990)}${SECRETO} fin\nsecreto-con-error ${SECRETO}\n`);
      p.leerLogAhora();
      check('publica dos líneas', vistos.length === 2);
      check('atravesando el corte: ningún prefijo del valor', sinPrefijos(vistos[0].datos.texto) && vistos[0].datos.texto.length <= 4000);
      check('valida contra log.linea', valida('evento:log.linea', vistos[0].datos).ok);
      check('nivel sobre la línea redactada, igual que la lectura', vistos[1].datos.nivel === prod.nivelDe(redactar(`secreto-con-error ${SECRETO}`)));
      baja();
      p.cerrar();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------- GET /telegram/chats
  await group('F3 S0 · GET /api/v2/telegram/chats', async () => {
    chats = { chats: [
      { bot: 'Alya', conversationId: 'abcdefg', actualizado: '2026-11-18T10:00:00.000Z' },
      { bot: 'Alya', conversationId: 'z'.repeat(40), actualizado: Date.parse('2026-11-19T10:00:00.000Z') },
      { bot: 'b'.repeat(80), conversationId: '', actualizado: 'no es fecha' },
      { bot: '123', conversationId: null, actualizado: null }
    ] };
    const r = await llamar('/api/v2/telegram/chats');
    check('valida contra chatsTelegram', valida('chatsTelegram', r).ok);
    check('ordenados del más reciente al más viejo', r.chats[0].actualizado === '2026-11-19T10:00:00.000Z' && r.chats[1].actualizado === '2026-11-18T10:00:00.000Z');
    check('updatedAt numérico pasa a ISO', r.chats[0].conversacion === 'zzzzzzzz');
    check('id de 7 sale entero', r.chats[1].conversacion === 'abcdefg');
    check('id de 40 sale con 8', r.chats[0].conversacion.length === 8);
    check('updatedAt inválido sale null y va al final', r.chats[2].actualizado === null && r.chats[3].actualizado === null);
    check('bot hasta 64', r.chats.every((c) => c.bot.length <= 64));
    check('id vacío → conversacion null', r.chats.some((c) => c.bot.startsWith('bbb') && c.conversacion === null));
    chats = { chats: Array.from({ length: 250 }, (_, i) => ({ bot: 'a', conversationId: 'c', actualizado: i })) };
    check('hasta 200', (await llamar('/api/v2/telegram/chats')).chats.length === 200);
  });

  await group('F3 S0 · bot.js: chatsTelegram descarta los web y el nodo', async () => {
    fs.writeFileSync(process.env.TELEGRAM_BRIDGE_STATE_FILE, JSON.stringify({ chats: {
      '111:222': { lastConversationId: 'conv-telegram-1', updatedAt: '2026-11-19T00:00:00.000Z' },
      'web:terminal': { lastConversationId: 'conv-web', updatedAt: '2026-11-19T00:00:00.000Z' },
      'web:local': { lastConversationId: 'conv-web-2' },
      'nodo:servidor': { lastConversationId: 'conv-nodo' },
      '111:-333': { updatedAt: '2026-11-19T00:00:00.000Z' }
    }, asks: {} }));
    const bot = await importar('telegram-bridge/bot.js');
    const r = bot.chatsTelegram();
    check('solo el chat de Telegram con conversación', r.chats.length === 1 && r.chats[0].conversationId === 'conv-telegram-1', JSON.stringify(r));
    check('no sale el chatId', !JSON.stringify(r).includes('222'));
    check('bot: el id si no hay nombre', r.chats[0]?.bot === '111');
    const v = lect.chatsTelegramV2(r);
    check('con forma, valida', valida('chatsTelegram', v).ok && v.chats[0].conversacion === 'conv-tel');
  });

  // ---------------------------------------------------------------- sin cambios
  await group('F3 S0 · /logs y /telegram/hilos no cambian', async () => {
    logV1 = { encabezado: 'x', contenido: 'uno\ndos' };
    const l = await llamar('/api/v2/logs');
    check('/logs devuelve lo del v1', l.ok === true && l.encabezado === 'x' && l.contenido === 'uno\ndos');
    const h = await llamar('/api/v2/telegram/hilos');
    check('/telegram/hilos devuelve los chats crudos (con web)', h.ok === true && h.hilos.length === 1 && h.hilos[0].canal === 'web');
  });

  // ---------------------------------------------------------------- fuente
  await group('F3 S0 · bot.js', () => {
    const bot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8');
    const i = bot.indexOf('const productoresV2 = crearProductoresV2({');
    check('crearProductoresV2 recibe redactar: redactarV2', /redactar: redactarV2/.test(bot.slice(i, bot.indexOf('});', i))));
    check('capacidadesV2 anuncia daemonLog y telegramChats', /daemonLog: true, telegramChats: true/.test(bot));
  });
}

main().then(() => { fs.rmSync(tmp, { recursive: true, force: true }); report(); }).catch((err) => { console.error(err); process.exit(1); });
