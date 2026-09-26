/**
 * FEAT-091 — `notify.js` con varios bots.
 *
 * Lo de un alma (voz o texto con `reaccionable.alma`) sale por el bot de esa
 * alma si el `.env` tiene uno, a su chat, y el reaccionable queda con el
 * `botId` de ese bot (BE-051). Sin bot de alma, o sin alma, sale por el
 * general como siempre.
 *
 * Corre notify.js en un proceso hijo: los tokens se leen al importar. `fetch`
 * está stubeado y el directorio de datos es temporal, así no se carga el `.env`
 * real de la máquina.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const REPO_ROOT = path.join(__dirname, '..');
const NOTIFY = pathToFileURL(path.join(REPO_ROOT, 'telegram-bridge', 'notify.js')).href;

const GENERAL = '1234567890';
const ALYA = '2223334445';

const HIJO = `
const { sendTelegramVoice, sendTelegramNotification, salidaDeAlma } = await import(${JSON.stringify(NOTIFY)});
const envios = [];
let siguiente = 100;
globalThis.fetch = async (url, opts) => {
  const [, bot, metodo] = /\\/bot(\\d+):[^/]+\\/(\\w+)$/.exec(String(url));
  const b = opts.body;
  const chat = typeof b === 'string' ? JSON.parse(b).chat_id : b.get('chat_id');
  envios.push({ bot, metodo, chat: String(chat) });
  return { json: async () => ({ ok: true, result: { message_id: siguiente++, chat: { id: Number(chat) } } }) };
};
await sendTelegramVoice({ audioPath: process.env.AUDIO, caption: 'a', reaccionable: { alma: 'alya', extracto: 'voz de alya' } });
await sendTelegramVoice({ audioPath: process.env.AUDIO, caption: 'b', reaccionable: { alma: 'diego', extracto: 'voz de diego' } });
await sendTelegramNotification({ message: 'hola', reaccionable: { alma: 'alya', extracto: 'texto de alya' } });
await sendTelegramNotification({ message: 'aviso sin alma' });
await sendTelegramVoice({ audioPath: process.env.AUDIO, caption: 'c', targetChatId: '555', reaccionable: { alma: 'alya', extracto: 'chat pedido' } });
const estado = JSON.parse((await import('node:fs')).readFileSync(process.env.TELEGRAM_BRIDGE_STATE_FILE, 'utf8'));
console.log('RESULTADO ' + JSON.stringify({
  envios,
  reaccionables: estado.reaccionables,
  sinAlma: salidaDeAlma('', null).botId
}));
`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-alma-'));
  try {
    const audio = path.join(dir, 'nota.wav');
    fs.writeFileSync(audio, Buffer.alloc(1024));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', HIJO], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        AUDIO: audio,
        TELEGRAM_BRIDGE_DATA_DIR: dir,
        TELEGRAM_BRIDGE_ENV_FILE: path.join(dir, 'no-existe.env'),
        TELEGRAM_BRIDGE_STATE_FILE: path.join(dir, 'state.json'),
        TELEGRAM_BOT_TOKEN: `${GENERAL}:AAFakeTokenForTestingOnly_DoNotUse`,
        ALLOWED_USER_IDS: '555,666',
        TELEGRAM_NOTIFY_CHAT_ID: '555',
        TELEGRAM_BOTS: 'alya',
        TELEGRAM_BOT_ALYA_TOKEN: `${ALYA}:AAalmaFakeTokenForTesting`,
        TELEGRAM_BOT_ALYA_VINCULO: 'alma:alya',
        TELEGRAM_BOT_ALYA_USUARIOS: '666'
      }
    });
    const linea = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULTADO '));
    const d = linea ? JSON.parse(linea.slice('RESULTADO '.length)) : null;

    await group('FEAT-091: notify.js elige el bot del alma', () => {
      check('el hijo corrió', !!d, r.stderr);
      if (!d) return;
      const [vozAlya, vozDiego, textoAlya, sinAlma, pedido] = d.envios;
      check('la voz de alya sale por su bot, a su usuario', vozAlya && vozAlya.bot === ALYA && vozAlya.metodo === 'sendVoice' && vozAlya.chat === '666', JSON.stringify(vozAlya));
      check('la de un alma sin bot sale por el general, al chat de siempre', vozDiego && vozDiego.bot === GENERAL && vozDiego.chat === '555', JSON.stringify(vozDiego));
      check('el texto de alya también sale por su bot', textoAlya && textoAlya.bot === ALYA && textoAlya.metodo === 'sendMessage', JSON.stringify(textoAlya));
      check('lo que no es de un alma sale por el general', sinAlma && sinAlma.bot === GENERAL && sinAlma.chat === '555', JSON.stringify(sinAlma));
      check('un chat pedido explícitamente se respeta', pedido && pedido.bot === ALYA && pedido.chat === '555', JSON.stringify(pedido));
      check('la reacción de alya queda con su botId', d.reaccionables[`${ALYA}:666:100`]?.alma === 'alya', JSON.stringify(Object.keys(d.reaccionables)));
      check('la de diego, con el general', d.reaccionables[`${GENERAL}:555:101`]?.alma === 'diego', JSON.stringify(Object.keys(d.reaccionables)));
      check('el texto de alya también', d.reaccionables[`${ALYA}:666:102`]?.alma === 'alya', JSON.stringify(Object.keys(d.reaccionables)));
      check('sin alma, el general', d.sinAlma === GENERAL);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  report();
}

main();
