/**
 * FEAT-201 F0.8 (S6) — El daemon como intermediario de secretos: caché de
 * sesión, single-flight, lista blanca por dominio, credencial propia, aviso con
 * la base bloqueada, y el cliente de secretos.js (con y sin daemon).
 */
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const CANARIO = 'CANARIO-key-7f31aa90';
const TOKEN = 'a'.repeat(48);
const TOKEN_V2 = 'c'.repeat(64);
const TOKEN_SEC = 'e'.repeat(64);
const RE_ENTRADA = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Un módulo secretos falso: resolver cuenta llamadas y tarda un poco. */
function secretosFalso({ falla = null } = {}) {
  const real = require('../mcp-server/lib/secretos.js');
  const llamadas = [];
  return {
    llamadas,
    PREFIJO: real.PREFIJO, KEYS_DE_MOTORES: real.KEYS_DE_MOTORES, RE_TOKEN_TELEGRAM: real.RE_TOKEN_TELEGRAM,
    esReferencia: real.esReferencia, entradaDe: real.entradaDe,
    async resolver(valor) {
      llamadas.push(valor);
      await esperar(20);
      if (falla) return { valor: null, motivo: 'la base de KeePassXC está bloqueada: desbloqueala', codigo: falla };
      return { valor: CANARIO, motivo: null, codigo: null };
    }
  };
}

function pedir(puerto, ruta, { headers = {}, method = 'POST', cuerpo = null } = {}) {
  return new Promise((resolve, reject) => {
    const datos = cuerpo === null ? null : Buffer.from(JSON.stringify(cuerpo));
    const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method, headers: { ...(datos ? { 'content-type': 'application/json', 'content-length': datos.length } : {}), ...headers } }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { texto += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(texto); } catch {} resolve({ status: res.statusCode, json, texto }); });
    });
    req.on('error', reject);
    if (datos) req.write(datos);
    req.end();
  });
}

async function main() {
  const sec = await importar('telegram-bridge/web/v2/secretos.js');
  const cred = await importar('telegram-bridge/web/v2/credencial.js');
  const esq = await importar('telegram-bridge/web/v2/esquema.js');
  const contrato = esq.cargarContrato();
  const ENV = { DEEPSEEK_API_KEY: 'keepassxc:deepseek', OPENCODE_GO_API_KEY: 'literal-no-cuenta', TELEGRAM_BOT_TOKEN: 'keepassxc:telegram', OTRA: 'keepassxc:otra' };

  await group('S6 · interruptor y TTL', () => {
    check('apagado por defecto', !sec.intermediarioEncendido({}) && sec.intermediarioEncendido({ LAGRANGE_SECRETOS_INTERMEDIARIO: '1' }));
    check('TTL por defecto 12 h', sec.ttlDesde(undefined) === 12 * 3_600_000);
    check('TTL 5m y 24h', sec.ttlDesde('5m') === 300_000 && sec.ttlDesde('24h') === 86_400_000);
    check('TTL daemon → toda la vida del proceso', sec.ttlDesde('daemon') === Infinity);
    check('TTL fuera de rango → 12 h', sec.ttlDesde('1m') === 12 * 3_600_000 && sec.ttlDesde('48h') === 12 * 3_600_000);
  });

  await group('S6 · caché, single-flight y lista blanca', async () => {
    let t = 1_000_000;
    const s = secretosFalso();
    const avisos = [];
    const i = sec.crearIntermediario({ env: () => ENV, secretos: s, reEntrada: RE_ENTRADA, ttlMs: 60_000, ahora: () => t, avisarBloqueada: (e) => avisos.push(e) });
    const [a, b] = await Promise.all([i.leer('motores', 'deepseek'), i.leer('motores', 'deepseek')]);
    check('dos pedidos simultáneos → una sola consulta a KeePassXC', s.llamadas.length === 1 && a.valor === CANARIO && b.valor === CANARIO);
    await i.leer('motores', 'deepseek');
    check('dentro del TTL sale de la caché', s.llamadas.length === 1);
    t += 61_000;
    await i.leer('motores', 'deepseek');
    check('vencido el TTL, vuelve a leer', s.llamadas.length === 2);
    check('una entrada que ninguna variable del dominio referencia → 403', (await i.leer('motores', 'otra')).codigo === 403);
    check('una entrada de bots no se pide como motores → 403', (await i.leer('motores', 'telegram')).codigo === 403);
    check('la de bots en su dominio → ok', (await i.leer('bots', 'telegram')).ok === true);
    check('un dominio inválido → 400', (await i.leer('otro', 'deepseek')).codigo === 400);
    i.olvidarTodo();
    await i.leer('motores', 'deepseek');
    check('«Olvidar todo» obliga a volver a leer', s.llamadas.length === 4);
    const e = i.estado();
    check('el estado no contiene el valor', !JSON.stringify(e).includes(CANARIO));
    check('contadores por entrada', e.entradas.find((x) => x.entrada === 'deepseek').lecturas === 5 && e.entradas.find((x) => x.entrada === 'deepseek').desdeCache === 1);
    const salud = { pid: 1, arranque: 'a', arribaSegundos: 1, memoria: { rss: 1, heapUsed: 1 }, eventLoop: null, secretos: e };
    check('el estado valida contra salud.secretos del contrato', esq.validar(contrato, 'salud', salud).length === 0, esq.validar(contrato, 'salud', salud).join('; '));
  });

  await group('S6 · base bloqueada', async () => {
    let t = 0;
    const avisos = [];
    const i = sec.crearIntermediario({ env: ENV, secretos: secretosFalso({ falla: 'bloqueada' }), reEntrada: RE_ENTRADA, ahora: () => t, avisarBloqueada: (e) => avisos.push(e) });
    const r = await i.leer('motores', 'deepseek');
    check('sin copia en caché → 503 con el motivo', r.codigo === 503 && /bloqueada/.test(r.error));
    await i.leer('motores', 'deepseek');
    check('el aviso sale una vez por hora', avisos.length === 1);
    t += 61 * 60_000;
    await i.leer('motores', 'deepseek');
    check('pasada la hora, otro aviso', avisos.length === 2);
    check('cuenta los fallos', i.estado().entradas[0].fallos === 3);
  });

  const { crearServidorWeb } = await importar('telegram-bridge/web/servidor.js');
  const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js');
  const nucleo = new Proxy({ canal: crearCanalWeb(), chatId: 'web:local' }, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && k !== 'then' ? async () => ({ ok: true }) : undefined)) });
  const intermediario = sec.crearIntermediario({ env: ENV, secretos: secretosFalso(), reEntrada: RE_ENTRADA });
  const servidor = crearServidorWeb({ nucleo, token: TOKEN, consola: false, v2: { token: TOKEN_V2, capacidades: () => ({ ok: true }), secretos: { token: TOKEN_SEC, leer: intermediario.leer, olvidarTodo: intermediario.olvidarTodo } } });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const p = servidor.address().port;
  const ruta = '/api/v2/secretos/deepseek:leer';

  await group('S6 · la ruta tiene su propia credencial', async () => {
    const ok = await pedir(p, ruta, { headers: { authorization: `Bearer ${TOKEN_SEC}` }, cuerpo: { dominio: 'motores' } });
    check('con la credencial de secretos → 200 y el valor', ok.status === 200 && ok.json.valor === CANARIO);
    check('con el Bearer de la interfaz → 403', (await pedir(p, ruta, { headers: { authorization: `Bearer ${TOKEN_V2}` }, cuerpo: { dominio: 'motores' } })).status === 403);
    check('con el token de la consola → 403', (await pedir(p, ruta, { headers: { authorization: `Bearer ${TOKEN}` }, cuerpo: { dominio: 'motores' } })).status === 403);
    check('sin credencial → 401', (await pedir(p, ruta, { cuerpo: { dominio: 'motores' } })).status === 401);
    check('con Origin (navegador) → 403', (await pedir(p, ruta, { headers: { authorization: `Bearer ${TOKEN_SEC}`, origin: 'http://127.0.0.1' }, cuerpo: { dominio: 'motores' } })).status === 403);
    check('olvidar con el Bearer de la interfaz → 200', (await pedir(p, '/api/v2/secretos:olvidar', { headers: { authorization: `Bearer ${TOKEN_V2}` } })).status === 200);
    const sinSec = crearServidorWeb({ nucleo, token: TOKEN, consola: false, v2: { token: TOKEN_V2, capacidades: () => ({ ok: true }) } });
    await new Promise((r) => sinSec.listen(0, '127.0.0.1', r));
    check('con el intermediario apagado → 404', (await pedir(sinSec.address().port, ruta, { headers: { authorization: `Bearer ${TOKEN_SEC}` }, cuerpo: { dominio: 'motores' } })).status === 404);
    await new Promise((r) => sinSec.close(r));
    let lanzo = false;
    try { crearServidorWeb({ nucleo, token: TOKEN, v2: { token: TOKEN_V2, capacidades: () => ({}), secretos: { token: TOKEN_V2, leer: () => ({}) } } }); } catch { lanzo = true; }
    check('el token de secretos no puede ser el de v2', lanzo);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-201-s6-'));
  try {
    await group('S6 · el cliente de secretos.js (MCP, notify.js)', async () => {
      const secretos = require('../mcp-server/lib/secretos.js');
      cred.escribirCredencial(path.join(dir, 'secretos.json'), { url: `http://127.0.0.1:${p}`, token: TOKEN_SEC, arranque: 'arr' });
      const env = { ...process.env, TELEGRAM_BRIDGE_DATA_DIR: dir, LAGRANGE_SECRETOS_INTERMEDIARIO: '1' };
      const directas = [];
      const cliente = { leerSecreto: async (entrada) => { directas.push(entrada); return 'VALOR-DIRECTO'; } };
      const r = await secretos.resolver('keepassxc:deepseek', { variable: 'DEEPSEEK_API_KEY', env, cliente, usarCache: false });
      check('con el intermediario encendido, la key llega del daemon', r.valor === CANARIO && directas.length === 0, JSON.stringify({ r, directas }));
      const apagado = await secretos.resolver('keepassxc:deepseek', { variable: 'DEEPSEEK_API_KEY', env: { ...env, LAGRANGE_SECRETOS_INTERMEDIARIO: '' }, cliente, usarCache: false });
      check('con el interruptor apagado, lectura directa como siempre', apagado.valor === 'VALOR-DIRECTO' && directas.length === 1);
      const otra = await secretos.resolver('keepassxc:otra', { variable: 'OTRA_COSA', env, cliente, usarCache: false });
      check('una variable que no es de motores ni de bots no pasa por el daemon', otra.valor === 'VALOR-DIRECTO' && directas.length === 2);
      await new Promise((res) => servidor.close(res));
      const caido = await secretos.resolver('keepassxc:deepseek', { variable: 'DEEPSEEK_API_KEY', env, cliente, usarCache: false });
      check('con el daemon caído, lectura directa (cada proceso con su diálogo)', caido.valor === 'VALOR-DIRECTO' && directas.length === 3);
      secretos.configurarComoDaemon();
      const d = await secretos.leerDelIntermediario('deepseek', 'DEEPSEEK_API_KEY', env, async () => { throw new Error('no debería llamarse'); });
      check('el daemon nunca se pide a sí mismo', d === null);
    });
  } finally {
    if (servidor.listening) await new Promise((r) => servidor.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await group('S6 · fuente', () => {
    const bot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8').replace(/\r\n/g, '\n');
    check('servirWeb marca este proceso como daemon', bot.includes('secretosKeepass.configurarComoDaemon();'));
    check('el intermediario se crea solo con el interruptor', /intermediarioEncendido\(\{ \.\.\.envDelArchivo\(\), \.\.\.process\.env \}\) \? crearIntermediario\(/.test(bot));
    check('secretos.json se escribe solo con el intermediario encendido', bot.includes('if (secretosV2) escribirCredencialV2(archivoSecretosV2,'));
    check('al cerrar: olvida la caché y borra secretos.json', bot.includes('if (secretosV2) { intermediarioV2.olvidarTodo(); borrarCredencialV2(archivoSecretosV2); }'));
    const ds = fs.readFileSync(path.join(RAIZ, 'mcp-server', 'motores', 'deepseek-ejecutar.js'), 'utf8');
    check('los motores leen el interruptor del mismo .env', ds.includes('delArchivo.LAGRANGE_SECRETOS_INTERMEDIARIO ?? process.env.LAGRANGE_SECRETOS_INTERMEDIARIO'));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
