/**
 * BE-173 — Tercera rebanada: `narrate_voices` y `voice_model` viven en
 * `mcp-server/tools/voice-management.js`.
 *
 * Se prueban los handlers directo, con dobles de `vb`, `om`, `vr`, perfiles y
 * snapshot: sin Voicebox, sin OmniVoice y sin red. Los textos son el contrato
 * que ya cubre `voicebox.test.js` de punta a punta.
 */
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { manejarGestionVoz } = require(path.join(__dirname, '..', 'mcp-server', 'tools', 'voice-management.js'));

const PERFILES = [
  { id: '1', name: 'Alya', language: 'es', voice_type: 'cloned', personality: 'Tsundere' },
  { id: '2', name: 'Diego Alvarez', language: 'es', voice_type: 'preset' },
  { id: '3', name: 'Emily', language: 'en', voice_type: 'cloned' }
];

function config(extra = {}) {
  return {
    voiceboxAutostart: true,
    voiceboxIdleUnloadMinutes: 10,
    voiceboxIdleShutdownMinutes: 60,
    voiceSetup: {
      status: 'configured',
      languages: ['es'],
      defaults: { es: { audio: { profile: 'Alya', provider: 'voicebox', model_size: '1.7B' } } },
      fallbacks: { es: [{ profile: 'Diego Alvarez' }] }
    },
    ...extra
  };
}

function fakeVb(extra = {}) {
  const llamadas = [];
  return {
    llamadas,
    MODELO_OMNI: 'omnivoice',
    SIZE_MB_OMNI: 900,
    salud: async () => ({ ok: true, info: { backend_variant: 'cuda', gpu_type: 'RTX 4090', model_size: '1.7B', model_loaded: true } }),
    leerKeeper: () => ({ vivo: true, ownsServer: true, pid: 111 }),
    leerPin: () => null,
    vramNvidia: () => ({ libreMb: 4096, totalMb: 8192 }),
    estadoModelos: async () => [{ model_name: 'qwen', loaded: true, size_mb: 1024 }],
    leerUsos: () => ({}),
    dirEstado: () => 'C:/estado-voz',
    esModeloTts: (nombre) => nombre === 'qwen',
    escribirPin: (valor) => llamadas.push(['pin', valor]),
    ensureVoicebox: async () => ({ ok: true, started: true, variante: 'cuda', exe: 'C:/voicebox.exe' }),
    aplicarModeloActivo: async (servidores, opciones) => {
      llamadas.push(['activar', opciones]);
      return { ok: true, objetivo: opciones.voz || opciones.engine || 'qwen', descargados: [], postergados: [], guarda: 'ok' };
    },
    resolverMotor: () => ({ engine: 'qwen', modelSize: '1.7B' }),
    estadoOmniServidor: async () => ({ models: [{ loaded: false }], generando: false }),
    descargarOmniServidor: async () => {},
    descargarModelo: async () => {},
    ...extra
  };
}

function fakeOm(extra = {}) {
  return {
    urlOmni: () => 'http://127.0.0.1:17494',
    omniInstalado: () => false,
    ensureOmniVoice: async () => ({ ok: true, started: true }),
    ...extra
  };
}

function deps(extra = {}) {
  return {
    config: config(),
    vb: fakeVb(),
    om: fakeOm(),
    vr: { setupState: () => 'configured' },
    servidoresVoz: (url, cfg) => ({ voicebox: url, config: cfg }),
    getVoiceboxProfiles: async () => PERFILES,
    buildVoiceSnapshot: async () => ({
      health: { ok: true, info: { backend_variant: 'cuda', gpu_type: 'RTX 4090', model_size: '1.7B', model_loaded: true } },
      snapshot: { profiles: PERFILES },
      desdeCache: false
    }),
    resolveVoiceboxUrl: () => 'http://127.0.0.1:17493',
    ...extra
  };
}

async function main() {
  await group('BE-173: despacho de gestion de voz', async () => {
    check('un nombre ajeno devuelve null', (await manejarGestionVoz('agy_run', {}, deps())) === null, '');
    check('voice_model se despacha', manejarGestionVoz('voice_model', { action: 'status' }, deps()) instanceof Promise);
    check('narrate_voices se despacha', manejarGestionVoz('narrate_voices', {}, deps()) instanceof Promise);
  });

  await group('BE-173: narrate_voices', async () => {
    const texto = (await manejarGestionVoz('narrate_voices', {}, deps())).content[0].text;
    check('muestra el encabezado y el endpoint', /Perfiles de Voz en Voicebox/.test(texto) && /http:\/\/127\.0\.0\.1:17493/.test(texto), texto);
    check('cuenta todos los perfiles', texto.includes('Total de perfiles instalados**: 3'), texto);
    check('marca el default del idioma', /⭐ Default es/.test(texto), texto);
    check('marca el fallback con su posición', /🔄 Fallback es \(P1\)/.test(texto), texto);
    check('muestra idioma, tipo y personalidad', /Emily/.test(texto) && /\| `en` \| cloned \|/.test(texto) && /✅ Sí/.test(texto), texto);
    check('dice de dónde salieron los perfiles', /servicio activo/.test(texto), texto);

    const filtrado = (await manejarGestionVoz('narrate_voices', { language: 'en' }, deps())).content[0].text;
    check('filtra por idioma', /mostrando filtro: `en`/.test(filtrado) && /Emily/.test(filtrado) && !/Alya/.test(filtrado), filtrado);

    const cache = deps({
      buildVoiceSnapshot: async () => ({
        health: { ok: false },
        snapshot: { profiles: PERFILES },
        desdeCache: true
      })
    });
    const textoCache = (await manejarGestionVoz('narrate_voices', {}, cache)).content[0].text;
    check('lee de la caché sin servicio', /caché local/.test(textoCache) && /detenido\/no accesible/.test(textoCache), textoCache);

    const vacio = deps({
      buildVoiceSnapshot: async () => ({ health: { ok: false }, snapshot: { profiles: [] }, desdeCache: false })
    });
    const textoVacio = (await manejarGestionVoz('narrate_voices', {}, vacio)).content[0].text;
    check('sin datos lo dice', textoVacio.includes('Fuente de perfiles**: sin datos') && textoVacio.includes('Total de perfiles instalados**: 0'), textoVacio);
  });

  await group('BE-173: voice_model status', async () => {
    const texto = (await manejarGestionVoz('voice_model', { action: 'status' }, deps())).content[0].text;
    check('muestra servidor, keeper y VRAM', /Servidor/.test(texto) && texto.includes('el plugin (keeper 111)') && texto.includes('4.0 GB libres de 8.0 GB'), texto);
    check('muestra modelos cargados y pin', texto.includes('Modelos cargados**: `qwen` (1024 MB)') && texto.includes('Fijado**: nada'), texto);
    check('muestra inactividad y estado', texto.includes('Inactividad**: descarga a los 10 min') && texto.includes('C:/estado-voz'), texto);
    check('dice que OmniVoice no está instalado', texto.includes('OmniVoice**: no instalado'), texto);

    const apagado = deps({ vb: fakeVb({ salud: async () => ({ ok: false, error: 'sin servicio' }) }) });
    const textoApagado = (await manejarGestionVoz('voice_model', { action: 'status' }, apagado)).content[0].text;
    check('servidor apagado se explica sin arrancarlo', /Servidor\*\*: apagado \(sin servicio\)/.test(textoApagado) && /se levanta solo/.test(textoApagado), textoApagado);
  });

  await group('BE-173: voice_model release y acciones inválidas', async () => {
    const sinPin = await manejarGestionVoz('voice_model', { action: 'release' }, deps());
    check('release sin pin', /No había ningún modelo fijado/.test(sinPin.content[0].text), sinPin.content[0].text);

    const vb = fakeVb({ leerPin: () => ({ model: 'qwen', since: '2026-11-03' }) });
    const conPin = await manejarGestionVoz('voice_model', { action: 'release' }, deps({ vb }));
    check('release libera y lo dice', /Pin liberado \(`qwen`\)\. Se descarga tras 10 min sin uso/.test(conPin.content[0].text), conPin.content[0].text);
    check('release escribe el pin vacío', JSON.stringify(vb.llamadas[0]) === JSON.stringify(['pin', null]), JSON.stringify(vb.llamadas));

    const rara = await manejarGestionVoz('voice_model', { action: 'volar' }, deps());
    check('acción desconocida es error', rara.isError === true && /Acción desconocida: `volar`/.test(rara.content[0].text), rara.content[0].text);
  });

  await group('BE-173: voice_model unload', async () => {
    const vb = fakeVb({ estadoOmniServidor: async () => ({ models: [{ loaded: true }], generando: false }) });
    const om = fakeOm({ omniInstalado: () => true, estadoOmniServidor: async () => ({ models: [{ loaded: true }], generando: false }) });
    const r = await manejarGestionVoz('voice_model', { action: 'unload', engine: 'omnivoice' }, deps({ vb, om }));
    check('descarga OmniVoice', /Descargado: `omnivoice` \(900 MB\)/.test(r.content[0].text), r.content[0].text);

    const ajeno = deps({ vb: fakeVb({ leerKeeper: () => ({ vivo: true, ownsServer: false, pid: 222 }) }) });
    const rAjeno = await manejarGestionVoz('voice_model', { action: 'unload' }, ajeno);
    check('no descarga un Voicebox ajeno sin force', rAjeno.isError === true && /no lo levantó el plugin/.test(rAjeno.content[0].text), rAjeno.content[0].text);

    const forzado = deps();
    const rForzado = await manejarGestionVoz('voice_model', { action: 'unload', force: true }, forzado);
    check('con force descarga los TTS', /Descargados: `qwen` \(1024 MB\)\. Pin liberado/.test(rForzado.content[0].text), rForzado.content[0].text);
  });

  await group('BE-173: voice_model start', async () => {
    const vb = fakeVb();
    const r = await manejarGestionVoz('voice_model', { action: 'start' }, deps({ vb }));
    check('levanta Voicebox sin GUI', /Voicebox levantado sin GUI \(cuda, `C:\/voicebox\.exe`\)/.test(r.content[0].text), r.content[0].text);

    const om = fakeOm({ omniInstalado: () => true, ensureOmniVoice: async () => ({ ok: true, started: true }) });
    const rOmni = await manejarGestionVoz('voice_model', { action: 'start', engine: 'omnivoice' }, deps({ om }));
    check('levanta OmniVoice', /OmniVoice levantado en `http:\/\/127\.0\.0\.1:17494`/.test(rOmni.content[0].text), rOmni.content[0].text);
  });

  await group('BE-173: voice_model activate y pin', async () => {
    const vb = fakeVb();
    const r = await manejarGestionVoz('voice_model', { action: 'activate', voice: 'Alya' }, deps({ vb }));
    check('activa la voz pedida', /Modelo activo: `Alya` \(voz Alya\)/.test(r.content[0].text), r.content[0].text);
    check('pasa la voz y no fija el pin', vb.llamadas[0][1].voz === 'Alya' && vb.llamadas[0][1].fijar === false, JSON.stringify(vb.llamadas[0]));

    const vbPin = fakeVb();
    const rPin = await manejarGestionVoz('voice_model', { action: 'pin', voice: 'Alya' }, deps({ vb: vbPin }));
    check('pin fija el modelo', /fijado \(voz Alya\)/.test(rPin.content[0].text) && vbPin.llamadas[0][1].fijar === true, JSON.stringify(vbPin.llamadas[0]));

    const sinNada = await manejarGestionVoz('voice_model', { action: 'activate' }, deps());
    check('sin voice ni engine pide uno', sinNada.isError === true && /Indicá `voice` o `engine`/.test(sinNada.content[0].text), sinNada.content[0].text);

    const sinMotor = deps({ vb: fakeVb({ resolverMotor: () => ({ unavailable: true, reason: 'modelo no descargado' }) }) });
    const rSinMotor = await manejarGestionVoz('voice_model', { action: 'activate', voice: 'Alya' }, sinMotor);
    check('motor no disponible se explica', rSinMotor.isError === true && /No se activó ningún modelo: modelo no descargado/.test(rSinMotor.content[0].text), rSinMotor.content[0].text);

    const om = fakeOm({ omniInstalado: () => true, ensureOmniVoice: async () => ({ ok: true, started: false }) });
    const vbOmni = fakeVb();
    const rOmni = await manejarGestionVoz('voice_model', { action: 'activate', engine: 'omnivoice', voice: 'Alya' }, deps({ vb: vbOmni, om }));
    check('OmniVoice informa la activación', /Modelo activo: `Alya`/.test(rOmni.content[0].text) && vbOmni.llamadas[0][1].proveedor === 'omnivoice', rOmni.content[0].text);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
