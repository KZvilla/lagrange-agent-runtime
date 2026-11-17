/**
 * FEAT-198 F1 — Secretos de Lagrange en KeePassXC: el cliente del protocolo, la
 * resolución de referencias (`keepassxc:<entrada>`) y quién la usa.
 *
 * El cliente se prueba contra un KeePassXC falso que cifra con NaCl de verdad
 * (`keepassxc-falso.js`), con el comportamiento medido en E0 contra KeePassXC 2.7.12.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');
const { crearKeepassFalso, asociacionDePrueba } = require('./keepassxc-falso.js');

const RAIZ = path.join(__dirname, '..');
const kp = require('../mcp-server/lib/keepassxc.js');
const secretos = require('../mcp-server/lib/secretos.js');
const ejecutor = require('../mcp-server/motores/deepseek-ejecutar.js');

const VALOR = 'VALOR-SECRETO-no-debe-salir-9f3a';
// Un trozo de base64 largo en un error sería un payload del protocolo.
const RE_PAYLOAD = /[A-Za-z0-9+/]{24,}={0,2}/;

const sinRastro = (texto) => !String(texto).includes(VALOR) && !RE_PAYLOAD.test(String(texto));

async function conFalso(opciones, fn) {
  const falso = await crearKeepassFalso(opciones);
  const env = { ...process.env, LAGRANGE_KEEPASSXC_SOCKET: falso.ruta };
  try { return await fn(falso, env); } finally { await falso.cerrar(); }
}

async function codigoDe(promesa) {
  try { await promesa; return 'sin-error'; } catch (err) { return err; }
}

async function main() {
  await group('vendor: tweetnacl 1.0.3 fijo', () => {
    const archivo = path.join(RAIZ, 'mcp-server', 'lib', 'vendor', 'tweetnacl.js');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(archivo)).digest('hex');
    check('SHA-256 de nacl-fast.js 1.0.3', sha === '6bcd37a3b20dce913f82d4b23e4e2b661058b4b953df8a3f8c45d56ac4f72447', sha);
    check('la licencia está al lado', fs.existsSync(path.join(RAIZ, 'mcp-server', 'lib', 'vendor', 'tweetnacl.LICENSE')));
    check('sin dependencias nuevas en mcp-server', !fs.existsSync(path.join(RAIZ, 'mcp-server', 'package.json'))
      || !JSON.parse(fs.readFileSync(path.join(RAIZ, 'mcp-server', 'package.json'), 'utf8')).dependencies);
  });

  await group('piezas del protocolo', () => {
    check('nonce incrementado little-endian', Buffer.from(kp.incrementarNonce(Uint8Array.from([255, 255, 1]))).equals(Buffer.from([0, 0, 2])));
    check('nonce: todo 0xff da la vuelta', Buffer.from(kp.incrementarNonce(Uint8Array.from([255, 255]))).equals(Buffer.from([0, 0])));
    const { mensajes, resto } = kp.separarJson('{"a":"}{"}{"action":"database-unlocked"}{"b":');
    check('separa JSON pegados, con llaves dentro de cadenas', mensajes.length === 2 && JSON.parse(mensajes[0]).a === '}{' && resto === '{"b":');
    check('Windows: el pipe de E0', kp.rutasDelSocket({ USERNAME: 'Ana' }, 'win32')[0] === '\\\\.\\pipe\\org.keepassxc.KeePassXC.BrowserServer_Ana');
    check('la variable de entorno manda', kp.rutasDelSocket({ LAGRANGE_KEEPASSXC_SOCKET: '/x/y' }, 'linux')[0] === '/x/y');
    check('Linux: primero XDG_RUNTIME_DIR', kp.rutasDelSocket({ XDG_RUNTIME_DIR: '/run/user/1' }, 'linux')[0].startsWith(path.join('/run/user/1')));
  });

  await group('leer: asociado, la entrada existe', async () => {
    const asoc = asociacionDePrueba();
    await conFalso({ asociaciones: { [asoc.id]: asoc.idKey }, entradas: { 'lagrange://deepseek': [{ password: VALOR }] } }, async (falso, env) => {
      const v = await kp.leerSecreto('deepseek', { env, asociacion: asoc });
      check('devuelve el valor', v === VALOR);
      check('hizo test-associate en la misma conexión antes de get-logins',
        JSON.stringify(falso.estado.pedidos) === JSON.stringify(['change-public-keys', 'test-associate', 'get-logins']));
    });
  });

  await group('errores con motivo, sin valores ni payloads', async () => {
    const asoc = asociacionDePrueba();
    const entradas = { 'lagrange://doble': [{ password: VALOR }, { password: VALOR }], 'lagrange://negada': [{ password: VALOR }] };
    await conFalso({ asociaciones: { [asoc.id]: asoc.idKey }, entradas, rechazar: new Set(['lagrange://negada']) }, async (falso, env) => {
      const sinEntrada = await codigoDe(kp.leerSecreto('no-existe', { env, asociacion: asoc }));
      check('entrada ausente → sin-entrada', sinEntrada.codigo === 'sin-entrada' && sinEntrada.message.includes('no-existe'), sinEntrada.message);
      const negada = await codigoDe(kp.leerSecreto('negada', { env, asociacion: asoc }));
      check('acceso negado → rechazado', negada.codigo === 'rechazado', negada.codigo);
      const doble = await codigoDe(kp.leerSecreto('doble', { env, asociacion: asoc }));
      check('dos entradas para la misma URL → ambigua', doble.codigo === 'ambigua', doble.codigo);
      const otra = await codigoDe(kp.leerSecreto('deepseek', { env, asociacion: asociacionDePrueba('otra') }));
      check('asociación desconocida → sin-asociacion', otra.codigo === 'sin-asociacion', otra.codigo);
      const invalida = await codigoDe(kp.leerSecreto('../Mal', { env, asociacion: asoc }));
      check('nombre de entrada inválido → entrada-invalida, sin conectar', invalida.codigo === 'entrada-invalida');
      check('ningún error lleva el valor ni un payload', [sinEntrada, negada, doble, otra, invalida].every((e) => sinRastro(e.message)));
    });
    const asoc2 = asociacionDePrueba();
    await conFalso({ asociaciones: { [asoc2.id]: asoc2.idKey }, bloqueada: true }, async (falso, env) => {
      const r = await codigoDe(kp.leerSecreto('deepseek', { env, asociacion: asoc2 }));
      check('base bloqueada → bloqueada', r.codigo === 'bloqueada', r.codigo);
    });
    await conFalso({ nonceMalo: true }, async (falso, env) => {
      const r = await codigoDe(kp.leerSecreto('deepseek', { env, asociacion: asoc }));
      check('nonce sin incrementar → protocolo', r.codigo === 'protocolo', r.codigo);
    });
    const sinPipe = await codigoDe(kp.leerSecreto('deepseek', { env: { LAGRANGE_KEEPASSXC_SOCKET: path.join(os.tmpdir(), 'no-hay-keepassxc.sock') }, asociacion: asoc }));
    check('sin KeePassXC → sin-keepassxc', sinPipe.codigo === 'sin-keepassxc', sinPipe.codigo);
  });

  await group('esperar el desbloqueo (D7)', async () => {
    const asoc = asociacionDePrueba();
    await conFalso({ asociaciones: { [asoc.id]: asoc.idKey }, bloqueada: true }, async (falso, env) => {
      setTimeout(() => falso.desbloquear(), 150);
      const ok = await kp.esperarDesbloqueo({ env, asociacion: asoc, timeoutMs: 5000 });
      check('llega database-unlocked → true', ok === true);
      check('pidió el desbloqueo una sola vez (triggerUnlock)', falso.estado.pidieronDesbloqueo === 1, String(falso.estado.pidieronDesbloqueo));
    });
    await conFalso({ asociaciones: { [asoc.id]: asoc.idKey }, bloqueada: true }, async (falso, env) => {
      const ok = await kp.esperarDesbloqueo({ env, asociacion: asoc, timeoutMs: 200 });
      check('sin desbloqueo, vence → false', ok === false);
    });
    await conFalso({ asociaciones: { [asoc.id]: asoc.idKey }, bloqueada: true }, async (falso, env) => {
      setTimeout(() => { for (const s of falso.estado.conexiones) s.destroy(); }, 150);
      const desde = Date.now();
      const ok = await kp.esperarDesbloqueo({ env, asociacion: asoc, timeoutMs: 5000 });
      const ms = Date.now() - desde;
      check('KeePassXC cierra la conexión → false enseguida, sin esperar el timeout (audit fc6b4b F1)', ok === false && ms < 2000, `${ok} ${ms}ms`);
    });
  });

  await group('aviso cuando KeePassXC tarda (diálogo que no se ve)', async () => {
    const asoc = asociacionDePrueba();
    await conFalso({ asociaciones: { [asoc.id]: asoc.idKey }, entradas: { 'lagrange://lenta': [{ password: VALOR }] }, demoraMs: kp.AVISO_ESPERA_MS + 400 }, async (falso, env) => {
      const avisos = [];
      const v = await kp.leerSecreto('lenta', { env, asociacion: asoc, alEsperar: (a) => avisos.push(a) });
      check('avisa una vez, con la entrada y sin valor', avisos.length === 1 && avisos[0].entrada === 'lenta' && sinRastro(JSON.stringify(avisos)));
      check('y después devuelve el valor', v === VALOR);
    });
    await conFalso({ asociaciones: { [asoc.id]: asoc.idKey }, entradas: { 'lagrange://rapida': [{ password: VALOR }] } }, async (falso, env) => {
      const avisos = [];
      await kp.leerSecreto('rapida', { env, asociacion: asoc, alEsperar: (a) => avisos.push(a) });
      check('si responde enseguida no avisa', avisos.length === 0);
    });
  });

  await group('asociar y guardar (para F3)', async () => {
    await conFalso({}, async (falso, env) => {
      const asoc = await kp.asociar({ env });
      check('asociar devuelve id e idKey', asoc.id === 'lagrange-test' && Buffer.from(asoc.idKey, 'base64').length === 32);
      await kp.guardarSecreto('telegram', VALOR, { env, asociacion: asoc });
      check('crea el grupo Lagrange y la entrada lagrange://telegram en él',
        falso.estado.grupos.includes('Lagrange') && falso.estado.ultimoSetLogin.url === 'lagrange://telegram'
        && falso.estado.ultimoSetLogin.groupUuid === 'uuid-Lagrange');
      check('relee para confirmar', await kp.leerSecreto('telegram', { env, asociacion: asoc }) === VALOR);
      await kp.guardarSecreto('memoria', 'otro', { env, asociacion: asoc });
      check('el grupo no se duplica', falso.estado.grupos.filter((g) => g === 'Lagrange').length === 1);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpxc-asoc-'));
    try {
      const env = { TELEGRAM_BRIDGE_DATA_DIR: dir };
      check('sin archivo, sin asociación', kp.leerAsociacion(env) === null);
      const a = asociacionDePrueba('x');
      kp.guardarAsociacion(a, env);
      check('guarda y relee la asociación en <dataDir>/keepassxc.json',
        JSON.stringify(kp.leerAsociacion(env)) === JSON.stringify(a) && fs.existsSync(path.join(dir, 'keepassxc.json')));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await group('secretos.resolver: literal, referencia y caché', async () => {
    secretos._reiniciar();
    let llamadas = 0;
    let ahora = 1000;
    let falla = false;
    const cliente = { leerSecreto: async (entrada) => { llamadas++; if (falla) throw new kp.ErrorKeepassxc('bloqueada', { entrada }); return `${VALOR}-${entrada}`; } };
    const lit = await secretos.resolver('  sk-literal ', { cliente });
    check('literal tal cual, sin KeePassXC', lit.valor === 'sk-literal' && llamadas === 0);
    check('vacío → falta', (await secretos.resolver('', { cliente })).codigo === 'falta');
    const r1 = await secretos.resolver('keepassxc:deepseek', { variable: 'DEEPSEEK_API_KEY', cliente, ahora: () => ahora });
    const r2 = await secretos.resolver('keepassxc:deepseek', { variable: 'DEEPSEEK_API_KEY', cliente, ahora: () => ahora + 60_000 });
    check('referencia → valor de KeePassXC', r1.valor === `${VALOR}-deepseek`);
    check('dentro de los 5 minutos, del caché', r2.valor === r1.valor && llamadas === 1, String(llamadas));
    ahora += secretos.CACHE_MS + 1;
    await secretos.resolver('keepassxc:deepseek', { variable: 'DEEPSEEK_API_KEY', cliente, ahora: () => ahora });
    check('pasados los 5 minutos, vuelve a pedir', llamadas === 2);
    check('última resolución: ok', secretos.ultimaResolucion('deepseek_api_key').estado === 'ok');
    falla = true;
    ahora += secretos.CACHE_MS + 1;
    const r3 = await secretos.resolver('keepassxc:deepseek', { variable: 'DEEPSEEK_API_KEY', cliente, ahora: () => ahora });
    check('un fallo da motivo, sin valor', r3.valor === null && r3.codigo === 'bloqueada' && sinRastro(r3.motivo) && r3.motivo.includes('desbloqueala'));
    falla = false;
    await secretos.resolver('keepassxc:deepseek', { variable: 'DEEPSEEK_API_KEY', cliente, ahora: () => ahora });
    check('un fallo no se cachea: el pedido siguiente vuelve a preguntar', llamadas === 4, String(llamadas));
    const inval = await secretos.resolver('keepassxc:Con Espacios', { variable: 'X', cliente });
    check('referencia con nombre inválido → entrada-invalida', inval.codigo === 'entrada-invalida');
    check('esCredencial: los IDs no', !secretos.esCredencial('ALLOWED_USER_IDS') && !secretos.esCredencial('TELEGRAM_NOTIFY_CHAT_ID')
      && secretos.esCredencial('TELEGRAM_BOT_ALYA_TOKEN') && secretos.esCredencial('lagrange_memory_token'));
    secretos._reiniciar();
  });

  await group('resolverArranque: tokens sí, keys de motores no (D6)', async () => {
    const pedidas = [];
    const cliente = { leerSecreto: async (entrada) => { pedidas.push(entrada); return `${VALOR}-${entrada}`; } };
    const env = {
      TELEGRAM_BOT_TOKEN: 'keepassxc:telegram',
      TELEGRAM_BOT_ALYA_TOKEN: 'keepassxc:telegram-alya',
      LAGRANGE_MEMORY_TOKEN: 'keepassxc:memoria',
      DEEPSEEK_API_KEY: 'keepassxc:deepseek',
      OPENCODE_GO_API_KEY: 'keepassxc:opencode-go',
      ALLOWED_USER_IDS: 'keepassxc:ids',
      OTRA: 'keepassxc:otra'
    };
    const r = await secretos.resolverArranque(env, { cliente });
    check('resuelve los tokens de Telegram y la memoria', env.TELEGRAM_BOT_TOKEN === `${VALOR}-telegram`
      && env.TELEGRAM_BOT_ALYA_TOKEN === `${VALOR}-telegram-alya` && env.LAGRANGE_MEMORY_TOKEN === `${VALOR}-memoria` && r.resueltas.length === 3);
    check('no pide las keys de motores al arrancar', !pedidas.includes('deepseek') && !pedidas.includes('opencode-go')
      && env.DEEPSEEK_API_KEY === 'keepassxc:deepseek');
    check('no toca IDs ni variables ajenas', env.ALLOWED_USER_IDS === 'keepassxc:ids' && env.OTRA === 'keepassxc:otra');
    const env2 = { TELEGRAM_BOT_TOKEN: 'keepassxc:telegram', LAGRANGE_MEMORY_TOKEN: 'keepassxc:memoria' };
    await secretos.resolverArranque(env2, { cliente, omitir: (n) => /^TELEGRAM_/.test(n) });
    check('omitir: en un nodo, los tokens de Telegram quedan sin pedir', env2.TELEGRAM_BOT_TOKEN === 'keepassxc:telegram');
  });

  await group('resolverArranqueEsperando (D7)', async () => {
    let bloqueada = true;
    let caido = 0;
    const esperas = [];
    const avisos = [];
    const cliente = {
      leerSecreto: async (entrada) => {
        if (caido > 0) { caido--; throw new kp.ErrorKeepassxc('sin-keepassxc', { entrada }); }
        if (bloqueada) throw new kp.ErrorKeepassxc('bloqueada', { entrada });
        return VALOR;
      },
      esperarDesbloqueo: async () => { bloqueada = false; return true; }
    };
    const env = { TELEGRAM_BOT_TOKEN: 'keepassxc:telegram' };
    const r = await secretos.resolverArranqueEsperando(env, { cliente, esperar: async (ms) => esperas.push(ms), alEsperar: (a) => avisos.push(a) });
    check('bloqueada: espera el desbloqueo y resuelve', r.fallidas.length === 0 && env.TELEGRAM_BOT_TOKEN === VALOR && esperas.length === 0);
    check('avisó que espera, sin valores', avisos.length === 1 && avisos[0].codigo === 'bloqueada' && sinRastro(avisos[0].motivo));
    caido = 2;
    const env2 = { TELEGRAM_BOT_TOKEN: 'keepassxc:telegram' };
    await secretos.resolverArranqueEsperando(env2, { cliente, esperar: async (ms) => esperas.push(ms) });
    check('KeePassXC cerrado: reintenta con espera creciente', env2.TELEGRAM_BOT_TOKEN === VALOR && esperas.length === 2 && esperas[1] > esperas[0]);
    const sinEntrada = { leerSecreto: async (entrada) => { throw new kp.ErrorKeepassxc('sin-entrada', { entrada }); } };
    const env3 = { TELEGRAM_BOT_TOKEN: 'keepassxc:telegram' };
    const r3 = await secretos.resolverArranqueEsperando(env3, { cliente: sinEntrada, esperar: async () => { throw new Error('no debía esperar'); } });
    check('sin la entrada: vuelve enseguida con la variable y el motivo', r3.fallidas.length === 1
      && r3.fallidas[0].variable === 'TELEGRAM_BOT_TOKEN' && r3.fallidas[0].codigo === 'sin-entrada' && env3.TELEGRAM_BOT_TOKEN === 'keepassxc:telegram');
  });

  await group('motores: la key en KeePassXC, el motivo en el error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpxc-env-'));
    try {
      const archivo = path.join(dir, '.env');
      fs.writeFileSync(archivo, 'DEEPSEEK_API_KEY=keepassxc:deepseek\nOPENCODE_GO_API_KEY=sk-literal-go\n');
      const resolverOk = async (valor) => (valor === 'keepassxc:deepseek' ? { valor: VALOR } : { valor: valor.trim() });
      const ok = await ejecutor.leerKeyConMotivo({ candidatos: [archivo], resolver: resolverOk });
      check('leerKeyConMotivo resuelve la referencia', ok.key === VALOR && ok.motivo === null);
      check('leerKey sigue devolviendo string', await ejecutor.leerKey({ candidatos: [archivo], resolver: resolverOk }) === VALOR);
      const resolverMal = async () => ({ valor: null, motivo: 'la base de KeePassXC está bloqueada: desbloqueala (entrada deepseek)' });
      const mal = await ejecutor.leerKeyConMotivo({ candidatos: [archivo], resolver: resolverMal });
      check('sin key, el motivo', mal.key === null && mal.motivo.includes('bloqueada'));
      let llamado = false;
      const r = await ejecutor.ejecutarDeepseek({ url: 'http://x', cuerpo: {} }, {
        leer: async () => mal, fetchImpl: async () => { llamado = true; throw new Error('no'); }
      });
      check('ejecutarDeepseek: «falta DEEPSEEK_API_KEY» con el motivo, sin llamar a la API',
        !llamado && r.error.startsWith('falta DEEPSEEK_API_KEY: ') && r.error.includes('bloqueada') && sinRastro(r.error), r.error);
      const r2 = await ejecutor.ejecutarDeepseek({ url: 'http://x', cuerpo: {} }, { leer: async () => null, fetchImpl: async () => { throw new Error('no'); } });
      check('un leer viejo (string|null) sigue andando', r2.error === 'falta DEEPSEEK_API_KEY en el .env unificado', r2.error);
      const go = require('../mcp-server/motores/opencode-go-ejecutar.js');
      const r3 = await go.ejecutarOpencodeGo({ url: 'http://x', cuerpo: {} }, { leer: async () => mal, fetchImpl: async () => { throw new Error('no'); } });
      check('opencode-go: también con el motivo', r3.error.startsWith('falta OPENCODE_GO_API_KEY: '), r3.error);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await group('notify.js: el token se resuelve al enviar, no al importar', async () => {
    const asoc = asociacionDePrueba();
    const TOKEN = '123456789:AAFalsoFalsoFalsoFalsoFalsoFalso';
    await conFalso({ asociaciones: { [asoc.id]: asoc.idKey }, entradas: { 'lagrange://telegram': [{ password: TOKEN }] } }, async (falso, env) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpxc-notify-'));
      try {
        kp.guardarAsociacion(asoc, { TELEGRAM_BRIDGE_DATA_DIR: dir });
        fs.writeFileSync(path.join(dir, '.env'), '');
        const notify = pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'notify.js')).href;
        const codigo = `const n = await import(${JSON.stringify(notify)});
          const s = await n.salidaResuelta('', '42');
          process.stdout.write(JSON.stringify({ ok: s.token === ${JSON.stringify(TOKEN)}, botId: s.botId }));`;
        const hijo = new Promise((resolve) => {
          const { spawn } = require('node:child_process');
          const p = spawn(process.execPath, ['--input-type=module', '-e', codigo], {
            env: { ...env, TELEGRAM_BRIDGE_DATA_DIR: dir, TELEGRAM_BRIDGE_ENV_FILE: path.join(dir, '.env'), TELEGRAM_BOT_TOKEN: 'keepassxc:telegram', ALLOWED_USER_IDS: '42' }
          });
          let out = '';
          let err = '';
          p.stdout.on('data', (d) => { out += d; });
          p.stderr.on('data', (d) => { err += d; });
          p.on('close', (status) => resolve({ status, out, err }));
        });
        const r = await hijo;
        let j = {};
        try { j = JSON.parse(r.out); } catch {}
        check('salidaResuelta: token de KeePassXC y botId del token real', r.status === 0 && j.ok === true && j.botId === '123456789', `${r.status} ${r.out} ${r.err.slice(0, 300)}`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    // Audit fc6b4b F2 — un alma sin bot propio y el general sin entrada: un solo pedido, con el motivo.
    await conFalso({ asociaciones: { [asoc.id]: asoc.idKey }, entradas: {} }, async (falso, env) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpxc-notify-'));
      try {
        kp.guardarAsociacion(asoc, { TELEGRAM_BRIDGE_DATA_DIR: dir });
        fs.writeFileSync(path.join(dir, '.env'), '');
        const notify = pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'notify.js')).href;
        const codigo = `const n = await import(${JSON.stringify(notify)});
          try { await n.salidaResuelta('mediador', '42'); process.stdout.write('sin-error'); }
          catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); }`;
        const r = await new Promise((resolve) => {
          const { spawn } = require('node:child_process');
          const p = spawn(process.execPath, ['--input-type=module', '-e', codigo], {
            env: { ...env, TELEGRAM_BRIDGE_DATA_DIR: dir, TELEGRAM_BRIDGE_ENV_FILE: path.join(dir, '.env'), TELEGRAM_BOT_TOKEN: 'keepassxc:telegram', ALLOWED_USER_IDS: '42' }
          });
          let out = '';
          let err = '';
          p.stdout.on('data', (d) => { out += d; });
          p.stderr.on('data', (d) => { err += d; });
          p.on('close', (status) => resolve({ status, out, err }));
        });
        let j = {};
        try { j = JSON.parse(r.out); } catch {}
        const lecturas = falso.estado.pedidos.filter((a) => a === 'get-logins').length;
        check('alma sin bot propio y general sin entrada: error con el motivo, el general pedido una sola vez',
          /TELEGRAM_BOT_TOKEN/.test(j.error || '') && lecturas === 1, `${lecturas} ${r.out} ${r.err.slice(0, 300)}`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });

  await group('bot.js: la resolución está en main(), no al importar', () => {
    const bot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8');
    const main = bot.indexOf('async function main()');
    const resolver = bot.indexOf('await resolverSecretosDeArranque();');
    const plan = bot.indexOf('const plan = planDeArranque(process.env);');
    check('main es async y resuelve antes de planDeArranque', main > 0 && resolver > main && plan > resolver);
    check('sigue borrando las keys de motores al importar', /delete process\.env\.DEEPSEEK_API_KEY;\s*\ndelete process\.env\.OPENCODE_GO_API_KEY;/.test(bot));
    check('el aviso por Telegram se configura al final de main', bot.includes('secretosKeepass.configurarAviso(avisarEsperaKeepass);'));
    check('arranque.json se escribe al esperar y se borra al resolver o al salir (D7)',
      bot.includes("path.join(bridgeDataDirPath(), 'arranque.json')") && bot.includes("estado: 'esperando-keepassxc'")
      && bot.includes("process.once('exit', borrarArranque)") && /finally \{\s*borrarArranque\(\);/.test(bot));
    const cuerpo = bot.slice(bot.indexOf('async function resolverSecretosDeArranque()'), bot.indexOf('const avisosKeepass'));
    check('SIGINT y SIGTERM durante la espera borran arranque.json y se retiran al terminar (audit fc6b4b F4)',
      cuerpo.includes("process.once('SIGINT', alSenal)") && cuerpo.includes("process.once('SIGTERM', alSenal)")
      && cuerpo.includes("process.removeListener('SIGINT', alSenal)") && cuerpo.includes("process.removeListener('SIGTERM', alSenal)"));
  });

  // ---------------------------------------------------------------- F2

  await group('F2 · estadoDeVariable (D9): literal, en KeePassXC o falta, sin el valor', async () => {
    secretos._reiniciar();
    check('falta', JSON.stringify(secretos.estadoDeVariable('', 'DEEPSEEK_API_KEY')) === JSON.stringify({ key: false, origen: null, lectura: null }));
    check('literal', secretos.estadoDeVariable(VALOR, 'DEEPSEEK_API_KEY').origen === 'literal'
      && !JSON.stringify(secretos.estadoDeVariable(VALOR, 'DEEPSEEK_API_KEY')).includes(VALOR));
    const sinLeer = secretos.estadoDeVariable('keepassxc:deepseek', 'DEEPSEEK_API_KEY');
    check('referencia sin leer todavía', sinLeer.key === true && sinLeer.origen === 'keepassxc' && sinLeer.lectura === null);
    const cliente = { leerSecreto: async (entrada) => { throw new kp.ErrorKeepassxc('bloqueada', { entrada }); } };
    await secretos.resolver('keepassxc:deepseek', { variable: 'DEEPSEEK_API_KEY', cliente });
    const fallo = secretos.estadoDeVariable('keepassxc:deepseek', 'DEEPSEEK_API_KEY');
    check('referencia con la última lectura fallida y su motivo', fallo.lectura.estado === 'fallo' && fallo.lectura.motivo.includes('bloqueada'));
    secretos._reiniciar();
  });

  await group('F2 · leerBots y resolverTokensDeBots: un token en KeePassXC no es «forma inválida»', async () => {
    const bots = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'bots.js')).href);
    const env = {
      TELEGRAM_BOT_TOKEN: 'keepassxc:telegram', ALLOWED_USER_IDS: '42',
      TELEGRAM_BOTS: 'alya', TELEGRAM_BOT_ALYA_TOKEN: 'keepassxc:telegram-alya', TELEGRAM_BOT_ALYA_VINCULO: 'alma:alya'
    };
    const sinResolver = bots.leerBots(env);
    check('sin resolver: lo dice, no «falta o no tiene la forma»', sinResolver.bots.length === 0
      && sinResolver.errores.every((e) => e.includes('está en KeePassXC y no se resolvió')) && sinResolver.errores.length === 2, sinResolver.errores.join(' | '));
    const cliente = { leerSecreto: async (entrada) => {
      if (entrada === 'telegram') return '111:AAprincipal';
      throw new kp.ErrorKeepassxc('sin-entrada', { entrada });
    } };
    const r = await secretos.resolverTokensDeBots(env, { cliente });
    check('resuelve los que puede, en una copia', r.env.TELEGRAM_BOT_TOKEN === '111:AAprincipal' && env.TELEGRAM_BOT_TOKEN === 'keepassxc:telegram');
    check('el que no, afuera de la copia y con su motivo', !('TELEGRAM_BOT_ALYA_TOKEN' in r.env)
      && r.noVerificables.length === 1 && r.noVerificables[0].variable === 'TELEGRAM_BOT_ALYA_TOKEN' && sinRastro(r.noVerificables[0].motivo));
    const leidos = bots.leerBots(r.env);
    check('leerBots con la copia: el general anda', leidos.bots.length === 1 && leidos.bots[0].botId === '111');
    secretos._reiniciar();
  });

  await group('F2 · bridge-status: «no verificable», texto plano y arranque.json', async () => {
    const { manejarEstadoBridge, leerArranque } = require('../mcp-server/tools/bridge-status.js');
    const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kpxc-status-')));
    try {
      const bridge = path.join(raiz, 'telegram-bridge');
      const data = path.join(raiz, 'data');
      fs.mkdirSync(path.join(bridge, 'web'), { recursive: true });
      fs.mkdirSync(path.join(bridge, 'red'), { recursive: true });
      fs.mkdirSync(data, { recursive: true });
      const fake = { bridgeDir: bridge, dataDir: data, daemon: { vivo: false, pid: null, rol: null }, env: { rol: 'solo' }, envCandidates: [path.join(data, '.env')] };
      fs.writeFileSync(path.join(raiz, 'package.json'), JSON.stringify({ version: require('../package.json').version }));
      fs.writeFileSync(path.join(bridge, 'package.json'), JSON.stringify({ type: 'module' }));
      fs.writeFileSync(path.join(bridge, 'fake.json'), JSON.stringify(fake));
      fs.writeFileSync(path.join(bridge, 'paths.js'), `import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const f = () => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake.json'), 'utf8'));
export function bridgeDataDirPath() { return f().dataDir; }
export function estadoDaemon() { return f().daemon; }
export function informeEnv() { return f().env; }
export function bridgeEnvCandidates(dir) { return dir === f().bridgeDir ? f().envCandidates : []; }\n`);
      fs.writeFileSync(path.join(bridge, 'web', 'acceso.js'), 'export function leerAccesoWeb() { return null; }\n');
      fs.writeFileSync(path.join(bridge, 'red', 'admin.js'), 'export function estado() { return { emparejado: false }; }\n');
      // El bots.js real.
      fs.writeFileSync(path.join(bridge, 'bots.js'), `export * from ${JSON.stringify(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'bots.js')).href)};\n`);
      fs.writeFileSync(path.join(data, '.env'), [
        'TELEGRAM_BOT_TOKEN=keepassxc:telegram', 'ALLOWED_USER_IDS=42',
        'TELEGRAM_BOTS=alya', 'TELEGRAM_BOT_ALYA_TOKEN=keepassxc:telegram-alya', 'TELEGRAM_BOT_ALYA_VINCULO=alma:alya',
        'DEEPSEEK_API_KEY=keepassxc:deepseek', `OPENCODE_GO_API_KEY=${VALOR}`, ''
      ].join('\n'));
      const pedidas = [];
      const falsoSecretos = { ...secretos, resolverTokensDeBots: (env, o) => secretos.resolverTokensDeBots(env, { ...o, cliente: { leerSecreto: async (entrada) => {
        pedidas.push(entrada);
        if (entrada === 'telegram') return '111:AAprincipal';
        throw new kp.ErrorKeepassxc('bloqueada', { entrada });
      } } }) };
      const deps = {
        config: { motores: { cuentas: {} } },
        loadConfig: () => ({ motores: { roles: { 'alma': { motor: 'opencode-go' } } }, fallbackAgy: null }),
        recall: { fuentes: () => ({ todas: [], actual: null }) },
        instalaciones: { versionesInstaladas: () => [], avisosDeDeriva: () => [], sinDeriva: () => true, todoComparable: () => true },
        bridgeDir: bridge, propiaDir: raiz, platform: 'linux', execFileSync: () => { throw new Error('sin systemd'); },
        secretos: falsoSecretos
      };
      const texto = (await manejarEstadoBridge({}, deps)).content[0].text;
      check('el bot general, resuelto y marcado «token en KeePassXC»', /general \(111\).*\(token en KeePassXC\)/.test(texto), texto.split('\n').filter((l) => /general|111/.test(l)).join(' | '));
      check('el extra que no se pudo leer: «no verificable» con el motivo', texto.includes('🔐 TELEGRAM_BOT_ALYA_TOKEN: token en KeePassXC, no verificable (la base de KeePassXC está bloqueada'));
      check('y no se lo descarta como «forma inválida»', !/ALYA_TOKEN (falta|está en KeePassXC y no se resolvió)/.test(texto));
      check('nunca pide las keys de motores', !pedidas.includes('deepseek'));
      check('DeepSeek: key en KeePassXC', texto.includes('DeepSeek (motor de almas, FEAT-166): key en KeePassXC'));
      check('literal → aviso de texto plano, con el nombre y sin el valor',
        texto.includes('Secreto en texto plano en el `.env`: `OPENCODE_GO_API_KEY`') && !texto.includes(VALOR) && !texto.includes('AAprincipal'));
      check('sin arranque.json no dice que espera', !texto.includes('espera KeePassXC'));
      fs.writeFileSync(path.join(data, 'arranque.json'), JSON.stringify({ estado: 'esperando-keepassxc', pid: process.pid, desde: '2026-11-17T10:00:00Z', motivo: 'la base de KeePassXC está bloqueada: desbloqueala' }));
      const texto2 = (await manejarEstadoBridge({}, deps)).content[0].text;
      check('con arranque.json de un PID vivo: «espera KeePassXC» y el motivo', texto2.includes(`El daemon (PID ${process.pid}) espera KeePassXC`) && texto2.includes('desbloqueala'));
      fs.writeFileSync(path.join(data, 'arranque.json'), JSON.stringify({ estado: 'esperando-keepassxc', pid: 999999999, motivo: 'x' }));
      check('de un PID muerto se descarta', leerArranque(data) === null);
    } finally {
      secretos._reiniciar();
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------- F3

  await group('F3 · secretos.mjs: nombres de entrada y reemplazo de líneas', async () => {
    const s = await import(pathToFileURL(path.join(RAIZ, 'scripts', 'secretos.mjs')).href);
    check('entradas cortas por variable', s.entradaPara('TELEGRAM_BOT_TOKEN') === 'telegram' && s.entradaPara('DEEPSEEK_API_KEY') === 'deepseek'
      && s.entradaPara('OPENCODE_GO_API_KEY') === 'opencode-go' && s.entradaPara('LAGRANGE_MEMORY_TOKEN') === 'memoria'
      && s.entradaPara('TELEGRAM_BOT_CASA_WSL_TOKEN') === 'telegram-casa-wsl');
    check('los IDs y lo ajeno no se migran', s.entradaPara('ALLOWED_USER_IDS') === null && s.entradaPara('TELEGRAM_NOTIFY_CHAT_ID') === null
      && s.entradaPara('GEMINI_API_KEY') === null && s.entradaPara('TELEGRAM_BOT_ALYA_VINCULO') === null);
    const texto = '# comentario\nA=1\nexport DEEPSEEK_API_KEY="sk-x"\nDEEPSEEK_API_KEY_OTRA=2\n';
    const nuevo = s.reemplazarLinea(texto, 'DEEPSEEK_API_KEY', 'keepassxc:deepseek');
    check('reemplaza solo esa variable y conserva el resto', nuevo === '# comentario\nA=1\nexport DEEPSEEK_API_KEY=keepassxc:deepseek\nDEEPSEEK_API_KEY_OTRA=2\n', JSON.stringify(nuevo));
  });

  await group('F3 · secretos.mjs asociar, migrar y probar (contra el KeePassXC falso)', async () => {
    const { spawn } = require('node:child_process');
    const SCRIPT = path.join(RAIZ, 'scripts', 'secretos.mjs');
    const correr = (env, ...args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [SCRIPT, ...args], { env });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.on('close', (status) => resolve({ status, out }));
    });
    const OTRO = 'OTRO-VALOR-que-tampoco-sale-77';
    await conFalso({ entradas: { 'lagrange://memoria': [{ password: 'distinto-en-keepassxc' }] } }, async (falso, envBase) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpxc-script-'));
      try {
        const archivo = path.join(dir, '.env');
        fs.writeFileSync(archivo, [
          '# mi .env', 'ALLOWED_USER_IDS=42', `TELEGRAM_BOT_TOKEN=${VALOR}`, `DEEPSEEK_API_KEY=${OTRO}`,
          'OPENCODE_GO_API_KEY=keepassxc:opencode-go', 'LAGRANGE_MEMORY_TOKEN=mem-local', ''
        ].join('\n'));
        const env = { ...envBase, TELEGRAM_BRIDGE_DATA_DIR: dir };
        const sim = await correr(env, 'migrar', '--env', archivo, '--simular');
        check('--simular lista y no toca nada', sim.status === 0 && sim.out.includes('TELEGRAM_BOT_TOKEN → keepassxc:telegram')
          && !sim.out.includes('ALLOWED_USER_IDS →') && !sim.out.includes('OPENCODE_GO_API_KEY →') && fs.readFileSync(archivo, 'utf8').includes(VALOR));
        const sinAsoc = await correr(env, 'migrar', '--env', archivo);
        check('sin asociar, lo pide y sale con error', sinAsoc.status === 1 && sinAsoc.out.includes('corré primero'));
        const a = await correr(env, 'asociar');
        check('asociar guarda la asociación', a.status === 0 && kp.leerAsociacion(env) !== null, a.out);
        const a2 = await correr(env, 'asociar');
        check('asociar de nuevo: ya está asociado', a2.status === 0 && a2.out.includes('Ya está asociado'));
        const m = await correr(env, 'migrar', '--env', archivo);
        const despues = fs.readFileSync(archivo, 'utf8');
        check('migra las que puede', despues.includes('TELEGRAM_BOT_TOKEN=keepassxc:telegram') && despues.includes('DEEPSEEK_API_KEY=keepassxc:deepseek'));
        check('las entradas quedan en KeePassXC con el valor', falso.estado.entradas['lagrange://telegram'][0].password === VALOR
          && falso.estado.entradas['lagrange://deepseek'][0].password === OTRO && falso.estado.grupos.includes('Lagrange'));
        check('una entrada existente con otro valor no se pisa y la línea queda', despues.includes('LAGRANGE_MEMORY_TOKEN=mem-local')
          && falso.estado.entradas['lagrange://memoria'][0].password === 'distinto-en-keepassxc' && m.status === 1 && m.out.includes('otro valor'));
        check('el resto del .env intacto', despues.startsWith('# mi .env\nALLOWED_USER_IDS=42\n') && despues.includes('OPENCODE_GO_API_KEY=keepassxc:opencode-go'));
        check('sin copia del original en la carpeta', fs.readdirSync(dir).filter((f) => f.startsWith('.env')).length === 1);
        check('la salida no lleva valores', !m.out.includes(VALOR) && !m.out.includes(OTRO) && !m.out.includes('mem-local'), m.out);
        const p = await correr(env, 'probar', '--env', archivo);
        check('probar: sí o no por secreto, sin valores', p.out.includes('✓ TELEGRAM_BOT_TOKEN') && p.out.includes('✓ DEEPSEEK_API_KEY')
          && p.out.includes('✗ OPENCODE_GO_API_KEY') && p.out.includes('⚠ LAGRANGE_MEMORY_TOKEN: en texto plano') && p.status === 1
          && !p.out.includes(VALOR) && !p.out.includes(OTRO), p.out);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });

  await group('F2 · consola web: el origen de la key llega a Ajustes, sin el valor', () => {
    const nucleo = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'web', 'nucleo.js'), 'utf8');
    check('nucleo pasa { key, origen, lectura } y acepta el booleano de antes',
      nucleo.includes("return { key: Boolean(e.key), origen: e.origen || null, lectura: e.lectura || null };") && nucleo.includes('return { key: Boolean(e) };'));
    const vista = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'web', 'public', 'ui', 'vista-ajustes.js'), 'utf8');
    check('Ajustes: «Key en KeePassXC» y la lectura fallida', vista.includes("'Key en KeePassXC'") && vista.includes('la última lectura falló'));
    const bot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8');
    check('hayKey del daemon usa estadoDeVariable para las dos keys',
      bot.includes("secretosKeepass.estadoDeVariable(parseEnv(fs.readFileSync(archivo, 'utf8')).DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY')")
      && bot.includes("secretosKeepass.estadoDeVariable(parseEnv(fs.readFileSync(archivo, 'utf8')).OPENCODE_GO_API_KEY, 'OPENCODE_GO_API_KEY')"));
  });

  await group('F2 · consola web en ejecución: nucleo.ajustes() y textoDeKey (audit fc6b4b F5)', async () => {
    const { crearNucleoWeb } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'web', 'nucleo.js')).href);
    const { crearCanalWeb } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'web', 'canal.js')).href);
    const fallo = { estado: 'fallo', motivo: 'la base de KeePassXC está bloqueada' };
    const nucleo = crearNucleoWeb({
      canal: crearCanalWeb(),
      bot: { almasDisponibles: () => [], agentesCasteables: () => [] },
      almas: {}, workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({}),
      ajustes: { leer: () => ({ ok: true }), guardar: () => ({ ok: true }), pisadoPorProyecto: () => [] },
      deepseek: { hayKey: () => ({ key: true, origen: 'keepassxc', lectura: fallo, valor: VALOR }) },
      opencodeGo: { hayKey: () => true }
    });
    const a = await nucleo.ajustes();
    check('deepseek: key, origen y lectura; nada más', a.deepseek && a.deepseek.key === true && a.deepseek.origen === 'keepassxc'
      && a.deepseek.lectura.motivo === fallo.motivo && sinRastro(JSON.stringify(a.deepseek)), JSON.stringify(a.deepseek));
    check('opencode-go: el booleano de antes sigue valiendo', a.opencodeGo && a.opencodeGo.key === true && !a.opencodeGo.origen, JSON.stringify(a.opencodeGo));

    const vista = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'web', 'public', 'ui', 'vista-ajustes.js'), 'utf8');
    const m = /function textoDeKey\(estado\) \{[\s\S]*?\n\}/.exec(vista);
    // eslint-disable-next-line no-new-func
    const textoDeKey = m ? new Function(`${m[0]}; return textoDeKey;`)() : () => '';
    check('textoDeKey: literal → «Key configurada»', textoDeKey({ key: true, origen: 'literal' }) === 'Key configurada');
    check('textoDeKey: en KeePassXC, sin leer', textoDeKey({ key: true, origen: 'keepassxc', lectura: null }).includes('todavía sin leer'));
    check('textoDeKey: lectura ok → «Key en KeePassXC»', textoDeKey({ key: true, origen: 'keepassxc', lectura: { estado: 'ok' } }) === 'Key en KeePassXC');
    check('textoDeKey: lectura fallida, con el motivo', textoDeKey({ key: true, origen: 'keepassxc', lectura: fallo }) === `Key en KeePassXC: la última lectura falló (${fallo.motivo})`);
  });

  process.exit(report() ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
