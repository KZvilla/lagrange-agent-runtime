/**
 * FEAT-055 — `voz-sintesis.js`: la síntesis que comparten el servidor MCP y el
 * daemon de Telegram. La resolución de voz y la VRAM ya tienen sus propios
 * tests (voice-resolution, voicebox, omnivoice-narracion); acá se prueba el
 * contrato de `sintetizar` con `preparar`, `generar` y `esperarArchivo`
 * inyectados, y que `loadConfig` sigue leyendo el archivo de configuración
 * desde su nuevo lugar.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { check, group, report } = require('./lib/assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voz-sintesis-'));
// Los toques de uso del modelo van al directorio de estado: nunca al real.
process.env.LAGRANGE_VOICEBOX_DIR = path.join(tmp, 'estado');
process.env.APPDATA = path.join(tmp, 'appdata');

const voz = require('../mcp-server/voz-sintesis.js');
const { loadConfig } = require('../mcp-server/lib/config.js');

const destinoAudio = (extra = {}) => ({
  status: 'audio',
  voiceboxUrl: 'http://127.0.0.1:1',
  profile: { id: 'p1', name: 'Alya' },
  language: 'es',
  motor: { engine: 'qwen', modelSize: '1.7B' },
  proveedor: 'voicebox',
  muestra: null,
  omniUrl: null,
  classTemperature: null,
  ...extra
});

async function main() {
  await group('sintetizar', async () => {
    const vacio = await voz.sintetizar({ texto: '```js\nconst x = 1;\n```', config: {}, preparar: async () => { throw new Error('no debería'); } });
    check('solo código: texto_vacio, sin preparar la voz', !vacio.ok && vacio.motivo === 'texto_vacio');

    const pedidos = [];
    const sinVoz = await voz.sintetizar({
      texto: 'Hola',
      voz: 'Alya',
      config: {},
      preparar: async (args) => { pedidos.push(args); return { status: 'text-only', reason: 'provider_unavailable' }; }
    });
    check('sin audio devuelve el motivo de la resolución', !sinVoz.ok && sinVoz.motivo === 'provider_unavailable');
    check('pide la voz del alma en modo inmediato', pedidos[0].voice === 'Alya' && pedidos[0].modo === 'inmediato');

    const bloqueada = await voz.sintetizar({
      texto: 'Hola', config: {},
      preparar: async () => ({ status: 'blocked', reason: 'vram_blocked', error: 'sin VRAM' })
    });
    check('VRAM bloqueada', !bloqueada.ok && bloqueada.motivo === 'vram_blocked' && bloqueada.detalle === 'sin VRAM');

    const explota = await voz.sintetizar({ texto: 'Hola', config: {}, preparar: async () => { throw new Error('boom'); } });
    check('un fallo al preparar no lanza', !explota.ok && explota.motivo === 'provider_unavailable');

    const generados = [];
    const omni = await voz.sintetizar({
      texto: '**Listo**: revisé `bot.js` en C:\\repo\\src\\bot.js',
      config: {},
      preparar: async () => destinoAudio({ proveedor: 'omnivoice', motor: { engine: 'omnivoice', modelSize: null } }),
      generar: async (op) => { generados.push(op); return { ok: true, speakRes: { id: 'g1' }, generatedWavPath: 'C:/tmp/omni.wav' }; },
      esperarArchivo: async () => { throw new Error('OmniVoice no espera'); }
    });
    check('OmniVoice devuelve su ruta sin esperar', omni.ok && omni.wavPath === 'C:/tmp/omni.wav' && omni.proveedor === 'omnivoice');
    check('el texto pasa saneado', generados[0].spokenText === 'Listo: revisé bot.js en bot.js', JSON.stringify(generados[0].spokenText));
    check('y con el perfil resuelto', omni.perfil === 'Alya');
    const usos = path.join(process.env.LAGRANGE_VOICEBOX_DIR, 'uso');
    check('el modelo quedó marcado en uso (en el directorio de prueba)', fs.existsSync(usos) && fs.readdirSync(usos).length > 0);

    const esperas = [];
    const vbx = await voz.sintetizar({
      texto: 'Hola',
      config: {},
      preparar: async () => destinoAudio(),
      generar: async () => ({ ok: true, speakRes: { id: 'gen-7' }, generatedWavPath: null }),
      esperarArchivo: async (dir, id) => { esperas.push({ dir, id }); return path.join(dir, `${id}.wav`); }
    });
    check('Voicebox espera el archivo de su id', vbx.ok && esperas[0].id === 'gen-7' && vbx.wavPath.endsWith('gen-7.wav'));
    check('en el directorio de generaciones', esperas[0].dir === voz.dirGeneracionesVoicebox());

    const sinArchivo = await voz.sintetizar({
      texto: 'Hola', config: {},
      preparar: async () => destinoAudio(),
      generar: async () => ({ ok: true, speakRes: { id: 'x' }, generatedWavPath: null }),
      esperarArchivo: async () => null
    });
    check('sin archivo a tiempo', !sinArchivo.ok && sinArchivo.motivo === 'sin_archivo');

    const falla = await voz.sintetizar({
      texto: 'Hola', config: {},
      preparar: async () => destinoAudio(),
      generar: async () => ({ ok: false, error: 'Voicebox /generate returned HTTP 500' })
    });
    check('un fallo de generación', !falla.ok && falla.motivo === 'generacion' && /500/.test(falla.detalle));
  });

  await group('generarAudio', async () => {
    const r = await voz.generarAudio({ spokenText: 'x', voiceboxUrl: 'http://127.0.0.1:9', profile: { id: 'p' }, language: 'es', motor: { engine: 'qwen', modelSize: '1.7B' } });
    check('Voicebox inalcanzable: ok false con el error, sin lanzar', r.ok === false && typeof r.error === 'string');
  });

  await group('loadConfig desde lib/config.js', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ model: 'gemini-x', voicebox_port: 18000 }));
    const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const c = loadConfig(path.join(tmp, 'sin-proyecto'));
      check('lee el archivo global', c.defaultModel === 'gemini-x' && c.voiceboxPort === 18000);
      check('y recuerda de dónde', c.configFile === path.join(home, '.claude', 'antigravity.json'));
      check('con los valores por defecto de Voicebox', 'voiceboxAutostart' in c);
    } finally {
      for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
