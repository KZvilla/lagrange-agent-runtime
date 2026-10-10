/**
 * BE-124 — El aviso de espera humana se marca solo cuando Telegram devolvió el mensaje; lo que no salió se
 * reintenta en el próximo barrido, hasta tres veces por clave. Antes se marcaba al disparar el envío.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'be-124-'));
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(raiz, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });

const BRIDGE = path.join(__dirname, '..', 'telegram-bridge');
const silencio = { log() {}, error() {} };

(async () => {
  const { avisarPendientes } = await import(pathToFileURL(path.join(BRIDGE, 'bot.js')).href);
  const archivo = path.join(raiz, 'avisos.json');
  const pendiente = (id) => ({ clave: `lote/${id}/2026-10-10T00:00:00.000Z`, lote: { id: 'lote' }, t: { id } });
  const leer = () => JSON.parse(fs.readFileSync(archivo, 'utf8'));

  await group('un envío que no devolvió mensaje no se marca', async () => {
    let llamadas = 0;
    await avisarPendientes({ archivo, nuevos: [pendiente('t1')], log: silencio, enviar: async () => { llamadas++; return [null]; } });
    check('se intentó una vez', llamadas === 1);
    check('no quedó como visto', !leer().vistos.includes('lote/t1/2026-10-10T00:00:00.000Z'));
    check('cuenta el intento', leer().intentos['lote/t1/2026-10-10T00:00:00.000Z'] === 1);
  });

  await group('el barrido siguiente lo reintenta y, si sale, lo marca', async () => {
    let texto = '';
    await avisarPendientes({ archivo, nuevos: [pendiente('t1')], log: silencio, enviar: async (t) => { texto = t; return [{ message_id: 7 }]; } });
    check('quedó como visto', leer().vistos.includes('lote/t1/2026-10-10T00:00:00.000Z'));
    check('sin intentos pendientes', !('lote/t1/2026-10-10T00:00:00.000Z' in leer().intentos));
    check('el texto nombra la tarea', texto.includes('t1'));
    let otra = 0;
    await avisarPendientes({ archivo, nuevos: [pendiente('t1')], log: silencio, enviar: async () => { otra++; return [{ message_id: 8 }]; } });
    check('una vez visto, no se repite', otra === 0);
  });

  await group('un error al enviar cuenta como intento, y a los tres se deja', async () => {
    let llamadas = 0;
    const falla = async () => { llamadas++; throw new Error('red caída'); };
    for (let i = 0; i < 4; i++) await avisarPendientes({ archivo, nuevos: [pendiente('t2')], log: silencio, enviar: falla });
    check('se intentó tres veces, no cuatro', llamadas === 3);
    check('no quedó como visto', !leer().vistos.includes('lote/t2/2026-10-10T00:00:00.000Z'));
  });

  await group('lee el formato anterior (una lista de claves)', async () => {
    fs.writeFileSync(archivo, JSON.stringify(['lote/t3/2026-10-10T00:00:00.000Z']));
    let llamadas = 0;
    await avisarPendientes({ archivo, nuevos: [pendiente('t3')], log: silencio, enviar: async () => { llamadas++; return [{ message_id: 1 }]; } });
    check('lo ya avisado no se repite', llamadas === 0);
    check('guarda el formato nuevo', Array.isArray(leer().vistos));
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  report();
})().catch((err) => { console.error(err); process.exit(1); });
