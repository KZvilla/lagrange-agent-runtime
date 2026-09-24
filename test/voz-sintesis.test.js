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

  await group('preparar (FEAT-056)', async () => {
    const pedidos = [];
    const sinVoz = await voz.preparar({
      voz: 'Alya', config: {},
      prepararDestino: async (args) => { pedidos.push(args); return { status: 'text-only', reason: 'provider_unavailable' }; },
      cargarOmni: async () => { throw new Error('no debería'); }
    });
    check('sin audio: el motivo, sin cargar nada', !sinVoz.ok && sinVoz.motivo === 'provider_unavailable');
    check('pide la voz pedida en modo inmediato y sin fijar', pedidos[0].voice === 'Alya' && pedidos[0].modo === 'inmediato' && !('keep_model' in pedidos[0]));

    const cargas = [];
    const omni = await voz.preparar({
      config: {},
      prepararDestino: async () => destinoAudio({ proveedor: 'omnivoice', omniUrl: 'http://127.0.0.1:2', motor: { engine: 'omnivoice', modelSize: null } }),
      cargarOmni: async (url) => { cargas.push(['omni', url]); },
      cargarQwen: async () => { cargas.push(['qwen']); }
    });
    check('OmniVoice: carga sus pesos', omni.ok && omni.precargado && omni.proveedor === 'omnivoice' && omni.perfil === 'Alya');
    check('en su servidor, y solo ahí', cargas.length === 1 && cargas[0][0] === 'omni' && cargas[0][1] === 'http://127.0.0.1:2');

    const qwen = await voz.preparar({
      config: {},
      prepararDestino: async () => destinoAudio(),
      cargarOmni: async () => { cargas.push(['omni']); },
      cargarQwen: async (url, tam) => { cargas.push(['qwen', url, tam]); }
    });
    check('Voicebox con Qwen: precarga sin fijar', qwen.ok && qwen.precargado && cargas.at(-1)[0] === 'qwen' && cargas.at(-1)[2] === '1.7B');

    const otro = await voz.preparar({
      config: {},
      prepararDestino: async () => destinoAudio({ motor: { engine: 'kokoro', modelSize: null } }),
      cargarOmni: async () => { cargas.push(['omni']); },
      cargarQwen: async () => { cargas.push(['qwen']); }
    });
    check('otro motor: sin precarga, pero ok', otro.ok && otro.precargado === false && cargas.length === 2);

    const falla = await voz.preparar({
      config: {},
      prepararDestino: async () => destinoAudio({ proveedor: 'omnivoice', motor: { engine: 'omnivoice', modelSize: null } }),
      cargarOmni: async () => { throw new Error('HTTP 500'); }
    });
    check('si la carga falla: motivo carga', !falla.ok && falla.motivo === 'carga' && /500/.test(falla.detalle));

    const explota = await voz.preparar({ config: {}, prepararDestino: async () => { throw new Error('boom'); } });
    check('un fallo al preparar no lanza', !explota.ok && explota.motivo === 'provider_unavailable');
  });

  await group('generarAudio', async () => {
    // BE-043 — Un ECONNREFUSED ahora intenta relanzar: en los tests, nunca el Voicebox real.
    const sinRelanzar = { ensureVoicebox: async () => ({ ok: false, error: 'no en tests' }) };
    const r = await voz.generarAudio({ spokenText: 'x', voiceboxUrl: 'http://127.0.0.1:9', profile: { id: 'p' }, language: 'es', motor: { engine: 'qwen', modelSize: '1.7B' }, deps: sinRelanzar });
    check('Voicebox inalcanzable: ok false con el error, sin lanzar', r.ok === false && typeof r.error === 'string');
  });

  // BE-043 — Un reintento, solo si el pedido nunca se entregó.
  await group('generarAudio: reintento ante ECONNREFUSED (BE-043)', async () => {
    const errorDe = (code, msg = code) => Object.assign(new Error(msg), code ? { code } : {});
    const base = { spokenText: 'hola', voiceboxUrl: 'http://127.0.0.1:1', profile: { id: 'p1' }, language: 'es', motor: { engine: 'qwen', modelSize: '1.7B' } };
    const omni = { ...base, proveedor: 'omnivoice', omniUrl: 'http://127.0.0.1:2', muestra: { audioPath: 'm.wav', refText: null }, motor: { engine: 'omnivoice', modelSize: null } };
    const guion = (fallas) => {
      const llamadas = { generar: 0, asegurar: 0, config: null };
      const generar = async () => {
        llamadas.generar++;
        const f = fallas.shift();
        if (f) throw f;
        return { id: 'g1', audio_path: 'C:/tmp/a.wav', audioPath: 'C:/tmp/a.wav', segundos: 1 };
      };
      const asegurar = (resultado = { ok: true }) => async (_url, opts) => { llamadas.asegurar++; llamadas.config = opts && opts.config; return resultado; };
      return { llamadas, generar, asegurar };
    };

    let g = guion([errorDe('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:17494')]);
    let r = await voz.generarAudio({ ...omni, config: { omnivoiceDir: 'X' }, deps: { sintetizarOmni: g.generar, ensureOmniVoice: g.asegurar() } });
    check('OmniVoice: ECONNREFUSED → relanza y el segundo intento sale', r.ok && g.llamadas.generar === 2 && g.llamadas.asegurar === 1 && r.generatedWavPath === 'C:/tmp/a.wav', JSON.stringify({ r, l: g.llamadas }));
    check('con la config de quien llama', g.llamadas.config && g.llamadas.config.omnivoiceDir === 'X');

    for (const [nombre, err] of [['ECONNRESET', errorDe('ECONNRESET')], ['timeout', errorDe(null, 'timeout de 90000 ms')], ['HTTP 500', errorDe(null, 'OmniVoice respondió HTTP 500: boom')]]) {
      g = guion([err]);
      r = await voz.generarAudio({ ...omni, deps: { sintetizarOmni: g.generar, ensureOmniVoice: g.asegurar() } });
      check(`OmniVoice: ${nombre} → no reintenta (podría duplicar la nota)`, !r.ok && g.llamadas.generar === 1 && g.llamadas.asegurar === 0, JSON.stringify(g.llamadas));
    }
    check('el error de siempre conserva su prefijo', /^OmniVoice: OmniVoice respondió HTTP 500/.test(r.error), r.error);

    g = guion([errorDe('ECONNREFUSED'), errorDe('ECONNREFUSED', 'connect ECONNREFUSED otra vez')]);
    r = await voz.generarAudio({ ...omni, deps: { sintetizarOmni: g.generar, ensureOmniVoice: g.asegurar() } });
    check('OmniVoice: dos ECONNREFUSED → una sola vez, y el error lo dice', !r.ok && g.llamadas.generar === 2 && /^OmniVoice \(tras relanzarlo\): connect ECONNREFUSED otra vez/.test(r.error), r.error);

    g = guion([errorDe('ECONNREFUSED')]);
    r = await voz.generarAudio({ ...omni, deps: { sintetizarOmni: g.generar, ensureOmniVoice: g.asegurar({ ok: false, error: 'no está instalado' }) } });
    check('OmniVoice: si no se puede relanzar, el motivo', !r.ok && g.llamadas.generar === 1 && /no respondía y no se pudo relanzar: no está instalado/.test(r.error), r.error);

    g = guion([errorDe('ECONNREFUSED')]);
    r = await voz.generarAudio({ ...base, deps: { generarVoicebox: g.generar, ensureVoicebox: g.asegurar() } });
    check('Voicebox: ECONNREFUSED → relanza y reintenta', r.ok && g.llamadas.generar === 2 && g.llamadas.asegurar === 1, JSON.stringify(g.llamadas));
    g = guion([errorDe('ECONNRESET')]);
    r = await voz.generarAudio({ ...base, deps: { generarVoicebox: g.generar, ensureVoicebox: g.asegurar() } });
    check('Voicebox: ECONNRESET → no reintenta', !r.ok && g.llamadas.generar === 1 && g.llamadas.asegurar === 0);
    g = guion([errorDe('ECONNREFUSED'), errorDe('ECONNREFUSED', 'de nuevo')]);
    r = await voz.generarAudio({ ...base, deps: { generarVoicebox: g.generar, ensureVoicebox: g.asegurar() } });
    check('Voicebox: dos ECONNREFUSED → error "tras relanzarlo"', !r.ok && /^Voicebox \(tras relanzarlo\): de nuevo/.test(r.error), r.error);
  });

  // BE-043 — El uso de Voicebox se marca antes de coordinar la VRAM, no recién al generar.
  await group('prepareNarrationTarget: toca el uso antes de coordinar (BE-043)', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'voz-sintesis.js'), 'utf8').replace(/\r\n/g, '\n');
    const i = fuente.indexOf('async function prepareNarrationTarget(');
    const cuerpo = fuente.slice(i, fuente.indexOf('\n}\n', i));
    const toque = cuerpo.indexOf("if (proveedor !== 'omnivoice') vb.tocarUso(vb.ttsModelName(motor.engine, motor.modelSize));");
    check('toca el modelo de Voicebox', toque > 0);
    check('antes de aplicarModeloActivo', toque > 0 && toque < cuerpo.indexOf('vb.aplicarModeloActivo('));
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
