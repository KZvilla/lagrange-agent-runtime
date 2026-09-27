/**
 * BE-065 — En el servidor, la lista de bots para los nodos (`listaDeBots`) se
 * leía sin rol: `leerBots` asumía `solo` y descartaba los bots de nodo. El bot
 * `wsl` no aparecía y la API acotada respondía "Ese bot no es de este nodo".
 *
 * Sin inyectar `lista`: es la lista por defecto la que estaba mal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'be-065-'));
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(raiz, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });

const BRIDGE = path.join(__dirname, '..', 'telegram-bridge');
const imp = (f) => import(pathToFileURL(path.join(BRIDGE, f)).href);

const USUARIO = '7833493849';
const GENERAL = '1111111111';
const WSL = '2222222222';

async function main() {
  const bot = await imp('bot.js');
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: `${GENERAL}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    ALLOWED_USER_IDS: USUARIO,
    TELEGRAM_BOTS: 'wsl',
    TELEGRAM_BOT_WSL_TOKEN: `${WSL}:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`,
    TELEGRAM_BOT_WSL_VINCULO: 'nodo:casa-wsl'
  });

  // Una API de Telegram de mentira por bot: registra qué bot mandó qué.
  const enviados = [];
  const apiFalsa = (botId) => ({
    sendMessage: async (chat, texto) => { enviados.push({ botId, chat: String(chat), texto }); return { message_id: enviados.length, chat: { id: chat } }; },
    raw: new Proxy({}, { get: (_, metodo) => async (payload) => { enviados.push({ botId, metodo, payload }); return { message_id: enviados.length }; } })
  });

  try {
    await group('BE-065 — en un servidor, el bot de nodo está en la lista', async () => {
      bot.usarRedParaTests({ rol: 'servidor' });
      const t = bot.telegramParaNodos({ apiDeBot: apiFalsa, origenes: () => null });
      const r = await t.api({ nodo: 'n1', nombre: 'casa-wsl', alias: 'a1', bot: WSL, metodo: 'sendMessage', payload: { chat_id: Number(USUARIO), text: '/status de WSL' } });
      check('la API acotada acepta el bot wsl para casa-wsl', r.ok === true, JSON.stringify(r));
      check('y lo manda por ese bot', enviados.some((e) => e.botId === WSL && e.metodo === 'sendMessage'), JSON.stringify(enviados));
      const ajeno = await t.api({ nodo: 'n2', nombre: 'otro-nodo', alias: 'a2', bot: WSL, metodo: 'sendMessage', payload: { chat_id: Number(USUARIO), text: 'x' } });
      check('otro nodo sigue sin poder usarlo', ajeno.ok === false && ajeno.error_code === 403 && /no es de este nodo/.test(ajeno.description), JSON.stringify(ajeno));

      enviados.length = 0;
      await t.mensaje({ nombre: 'casa-wsl', texto: 'Aviso desde WSL' });
      check('un aviso de casa-wsl sale por el bot wsl', enviados.length === 1 && enviados[0].botId === WSL && enviados[0].chat === USUARIO, JSON.stringify(enviados));
      check('sin prefijo [casa-wsl]', !enviados[0].texto.includes('[casa-wsl]'), enviados[0].texto);
      enviados.length = 0;
      await t.mensaje({ nombre: 'otro-nodo', texto: 'Aviso' });
      check('otro nodo sale por el general, con prefijo', enviados[0]?.botId === GENERAL && enviados[0].texto.includes('[otro-nodo]'), JSON.stringify(enviados));
    });

    await group('BE-065 — la consola nombra el chat del bot de nodo', async () => {
      const estado = { chats: { [`${WSL}:${USUARIO}`]: { lastConversationId: 'c1' } } };
      fs.writeFileSync(process.env.TELEGRAM_BRIDGE_STATE_FILE, JSON.stringify(estado));
      const s = bot.sesionesWeb({ homeDir: raiz });
      const txt = JSON.stringify(s);
      check('"telegram · wsl" y no el id del bot', txt.includes('telegram · wsl') && !txt.includes(`telegram · ${WSL}`), txt.slice(0, 400));
    });

    await group('BE-065 — en solo, un bot de nodo sigue descartado', async () => {
      bot.usarRedParaTests({ rol: 'solo' });
      enviados.length = 0;
      const t = bot.telegramParaNodos({ apiDeBot: apiFalsa, origenes: () => null });
      const r = await t.api({ nodo: 'n1', nombre: 'casa-wsl', alias: 'a1', bot: WSL, metodo: 'sendMessage', payload: { chat_id: Number(USUARIO), text: 'x' } });
      check('sin rol servidor, 403', r.ok === false && r.error_code === 403, JSON.stringify(r));
    });

    const fuente = fs.readFileSync(path.join(BRIDGE, 'bot.js'), 'utf8');
    check('ningún leerBots(process.env) sin rol en bot.js', !/leerBots\(process\.env\)/.test(fuente));
    const mcp = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'index.js'), 'utf8');
    check('telegram_bridge_status lee los bots con el rol del daemon', /leerBots\(require\('node:util'\)\.parseEnv\(fs\.readFileSync\(envBots, 'utf8'\)\), \{ rol: rolDaemon \}\)/.test(mcp));
  } finally {
    bot.usarRedParaTests({ rol: 'solo' });
  }
  report();
  fs.rmSync(raiz, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
