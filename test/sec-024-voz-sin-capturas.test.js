/**
 * SEC-024 — `telegram_send_voice` sin `audio_path` mandó una grabación del
 * micrófono (Voicebox `captures/`, del atajo de transcribir) de hacía días:
 * la voz se había generado con OmniVoice, fuera de `generations/`, y el
 * fallback tomaba el archivo más nuevo de `captures/`, `generations/` o
 * `profiles/` sin mirar su edad.
 *
 * Ahora: solo `generations/`, solo de los últimos 2 minutos; si no hay, el
 * envío falla antes de tocar la red.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec024-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
process.env.VOICEBOX_DIR = tmp;

function audio(rel, haceMs) {
  const ruta = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, 'RIFF');
  const t = (Date.now() - haceMs) / 1000;
  fs.utimesSync(ruta, t, t);
  return ruta;
}

async function main() {
  const notify = await import(pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'notify.js')).href);

  await group('el fallback no toca capturas ni muestras de voz', () => {
    audio('captures/grabacion-privada.wav', 1000);
    audio('profiles/alya/muestra.wav', 500);
    audio('generations/vieja.wav', 10 * 60 * 1000);
    check('captura reciente, muestra y generación vieja: nada', notify.findLatestVoiceboxAudio() === null);
    const fresca = audio('generations/fresca.wav', 30 * 1000);
    audio('generations/notas.txt', 0);
    check('una generación de hace 30 s: esa', notify.findLatestVoiceboxAudio() === fresca);
    const masNueva = audio('generations/mas-nueva.ogg', 5 * 1000);
    check('entre dos frescas, la más nueva', notify.findLatestVoiceboxAudio() === masNueva);
    check('la frescura se respeta', notify.findLatestVoiceboxAudio({ ahora: Date.now() + 3 * 60 * 1000 }) === null);
    check('2 minutos', notify.FRESCURA_GENERACION_MS === 120000);
  });

  await group('sin audio_path y sin generación fresca: error antes de la red', async () => {
    for (const f of fs.readdirSync(path.join(tmp, 'generations'))) fs.rmSync(path.join(tmp, 'generations', f));
    let error = null;
    try { await notify.sendTelegramVoice({ caption: 'x' }); } catch (e) { error = e; }
    check('falla', error instanceof Error);
    check('dice qué hacer', error && /audio_path/.test(error.message) && /say/.test(error.message), error && error.message);
    check('no nombra la captura', error && !/grabacion-privada/.test(error.message));
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
