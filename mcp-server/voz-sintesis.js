/**
 * FEAT-055 — Resolución de voz y síntesis, compartidas por el servidor MCP
 * (`agy_say`, `agy_narrate`, `agy_session_summary`) y el daemon de Telegram
 * (el botón "escuchar" de la consola web).
 *
 * Vivía en `index.js`, que no se puede importar. Se movió sin cambios: la
 * resolución de voz, la preparación de la VRAM (`aplicarModeloActivo`) y la
 * generación son las mismas para los dos procesos. Lo que no está acá es lo
 * que depende del canal: la entrega a Telegram y la reproducción local siguen
 * en `index.js`.
 *
 * `prepareNarrationTarget` no guarda estado en memoria: los perfiles van a la
 * caché en disco y las fijaciones de modelo las resuelve el servidor de voz,
 * así que llamarla desde otro proceso es seguro (auditoría de FEAT-055).
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vb = require('./voicebox-server.js');
const om = require('./omnivoice.js');
const vr = require('./voice-resolution.js');
const almas = require('./almas/index.js');
const { normalizeSpokenText } = require('./spoken-text.js');
const { loadConfig } = require('./lib/config.js');

// Voicebox HTTP Client & Checkpoint Helpers
function httpRequest(urlStr, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: options.method || (postData ? 'POST' : 'GET'),
      headers: {
        'X-Voicebox-Client-Id': 'claude-code',
        ...(options.headers || {})
      },
      timeout: options.timeout || 3500
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Connection timed out after ${options.timeout || 3500}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (postData) {
      const payload = typeof postData === 'string' ? postData : JSON.stringify(postData);
      req.write(payload);
    }
    req.end();
  });
}

const resolveVoiceboxUrl = (args = {}, config = {}) => vb.resolverUrlVoicebox(args, config);

const getVoiceboxProfiles = (baseUrl, { timeoutMs = 4000 } = {}) =>
  vb.listarPerfiles(baseUrl, { timeout: timeoutMs });

function servidoresVoz(voiceboxUrl, config) {
  return { voicebox: voiceboxUrl, omnivoice: om.omniInstalado({ config }) ? om.urlOmni(config) : null };
}

/**
 * Resuelve Voicebox, la voz, el proveedor (OmniVoice o Voicebox) y deja la
 * VRAM lista, o devuelve el error ya formateado para el cliente.
 *
 * Proveedor: motor explícito → voz fijada en `voz_por_perfil` → modo
 * (inmediato → OmniVoice, diferido → Voicebox). Si OmniVoice no se puede usar
 * (no instalado, voz sin muestra, muestra borrada, no arranca) se cae a
 * Voicebox diciendo por qué. Si Voicebox no levanta pero la voz sale por
 * OmniVoice, perfiles y muestra vienen de la caché de voces.
 */
async function buildVoiceSnapshot(args, config, { allowStart = false } = {}) {
  const voiceboxUrl = resolveVoiceboxUrl(args, config);
  let health = await vb.salud(voiceboxUrl);
  let profiles = null;
  let desdeCache = false;
  if (health.ok) {
    try {
      profiles = await getVoiceboxProfiles(voiceboxUrl);
      om.guardarCacheVoces({ perfiles: profiles });
    } catch {}
  }
  if (!profiles) {
    const cache = om.leerCacheVoces();
    if (cache && Array.isArray(cache.perfiles) && cache.perfiles.length) {
      profiles = cache.perfiles;
      desdeCache = true;
    }
  }
  // Solo una emisión ya autorizada puede arrancar Voicebox para completar el
  // snapshot. Discovery y una instalación sin setup no pasan allowStart.
  if ((!profiles || !health.ok) && allowStart) {
    const started = await vb.ensureVoicebox(voiceboxUrl, { config });
    if (started.ok) {
      health = started;
      try {
        profiles = await getVoiceboxProfiles(voiceboxUrl);
        om.guardarCacheVoces({ perfiles: profiles });
        desdeCache = false;
      } catch {}
    }
  }
  profiles = profiles || [];
  let models = [];
  if (health.ok) {
    try { models = await vb.estadoModelos(voiceboxUrl); } catch {}
  }
  const samples = {};
  for (const profile of profiles) {
    try {
      const sample = await om.muestraDePerfil(health.ok ? voiceboxUrl : null, profile);
      if (sample) {
        samples[String(profile.id || profile.name).toLowerCase()] = {
          sample_exists: fs.existsSync(sample.audioPath),
          sample_path_token: sample.audioPath,
          ref_text_present: Boolean(sample.refText),
          sample
        };
      }
    } catch {}
  }
  const omniInstalled = om.omniInstalado({ config });
  const omniUrl = om.urlOmni(config);
  const omniHealth = omniInstalled ? await vb.salud(omniUrl, 1500) : { ok: false };
  const souls = {};
  for (const key of almas.rutas.listarClaves()) souls[key] = true;
  return {
    voiceboxUrl,
    health,
    omniUrl,
    desdeCache,
    snapshot: {
      profiles,
      voicebox: {
        reachable: Boolean(health.ok),
        installed: Boolean(vb.resolverEjecutable().exe),
        startable: Boolean(health.ok || vb.resolverEjecutable().exe),
        models
      },
      omnivoice: {
        reachable: Boolean(omniHealth.ok),
        installed: omniInstalled,
        startable: omniInstalled,
        weights_downloaded: omniInstalled,
        loaded: false
      },
      samples,
      souls
    }
  };
}

function textOnlyTarget(decision, built, modo) {
  return {
    status: 'text-only',
    decision,
    reason: decision.reason || 'provider_unavailable',
    reasons: decision.reasons || [],
    profile: decision.profile || null,
    language: decision.language || 'es',
    voiceboxUrl: built.voiceboxUrl,
    health: built.health,
    modo,
    desdeCache: built.desdeCache,
    voiceResolution: { isFallback: false, reason: decision.reason || 'text_only' }
  };
}

async function prepareNarrationTarget(args, config, opciones = {}) {
  const modo = args.modo === 'diferido' || args.modo === 'inmediato' ? args.modo : (opciones.modoPorDefecto || 'inmediato');
  const explicitVoice = Boolean(args.voice || args.profile);
  const state = vr.setupState(config, args.language);
  const authorized = explicitVoice || state === 'configured';

  if (!authorized) {
    const built = { voiceboxUrl: resolveVoiceboxUrl(args, config), health: { ok: false }, desdeCache: false };
    return textOnlyTarget(vr.resolveVoice({ args: { ...args, modo }, config, snapshot: { souls: {} } }), built, modo);
  }

  const built = await buildVoiceSnapshot(args, config, { allowStart: true });
  let decision = vr.resolveVoice({ args: { ...args, modo }, config, snapshot: built.snapshot });
  if (decision.status !== 'audio') return textOnlyTarget(decision, built, modo);

  const perfil = decision.profile;
  const proveedor = decision.audio.provider;
  let muestra = null;
  let omniUrl = null;
  if (proveedor === 'omnivoice') {
    const entry = built.snapshot.samples[String(perfil.id || perfil.name).toLowerCase()];
    muestra = entry && entry.sample;
    const started = await om.ensureOmniVoice(built.omniUrl, { config });
    if (!started.ok) {
      decision = { ...decision, status: 'text-only', reason: 'provider_unavailable', reasons: ['provider_unavailable'] };
      return textOnlyTarget(decision, built, modo);
    }
    omniUrl = built.omniUrl;
  }

  const motor = proveedor === 'omnivoice'
    ? { engine: vb.MODELO_OMNI, modelSize: null }
    : { engine: decision.audio.engine, modelSize: decision.audio.model_size };
  let activacion;
  try {
    activacion = await vb.aplicarModeloActivo(servidoresVoz(built.health.ok ? built.voiceboxUrl : null, config), {
      proveedor,
      ...motor,
      voz: perfil.name,
      fijar: Boolean(args.keep_model)
    });
  } catch (err) {
    return { ...textOnlyTarget({ ...decision, status: 'blocked', reason: 'vram_blocked' }, built, modo), status: 'blocked', error: err.message };
  }
  if (!activacion.ok) {
    return { ...textOnlyTarget({ ...decision, status: 'blocked', reason: activacion.conflicto ? 'pin_conflict' : 'vram_blocked' }, built, modo), status: 'blocked', error: activacion.error };
  }

  return {
    status: 'audio',
    decision,
    voiceboxUrl: built.voiceboxUrl,
    voiceResolution: { isFallback: decision.fallback, reason: decision.fallback ? 'declared_fallback' : 'selected' },
    profile: perfil,
    language: decision.language,
    motor,
    activacion,
    health: built.health,
    proveedor,
    motivoProveedor: decision.fallback ? `fallback declarado tras: ${decision.reasons.join(', ')}` : 'ruta seleccionada',
    fallback: decision.fallback,
    modo,
    muestra,
    omniUrl,
    desdeCache: built.desdeCache,
    classTemperature: config.omnivoiceClassTemperature,
    avisoMuestra: proveedor === 'omnivoice' ? om.avisoMuestraLarga(muestra, perfil) : null
  };
}

// NOTE: there is deliberately no /speak helper here. Voicebox's POST /speak makes
// Voicebox itself play the audio, which triggers its double-playback bug; every path
// in this server uses POST /generate (synthesize silently to a .wav) and then plays
// the file with the native OS player. See playLocalAudio() and the agy_narrate case.
async function sendVoiceboxGenerate(baseUrl, text, profileId, language, options = {}) {
  const postData = {
    profile_id: profileId,
    text,
    language: language || 'es',
    // null es válido en el schema de Voicebox: los motores no-Qwen no versionan por tamaño.
    model_size: options.modelSize !== undefined ? options.modelSize : '1.7B',
    engine: options.engine || 'qwen',
    // La persona la aplica agy antes (reescribirEnPersona o el prompt del
    // guion): el LLM de Voicebox (Qwen3 0.6B) reescribía otra vez, y peor.
    personality: false,
    normalize: true
  };
  const res = await httpRequest(`${baseUrl}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  }, postData);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    try {
      return JSON.parse(res.body);
    } catch {
      return { status: 'generating', raw: res.body };
    }
  }
  throw new Error(`Voicebox /generate returned HTTP ${res.statusCode}: ${res.body}`);
}

async function waitForGenerationFile(genDir, generationId, beforeFiles = [], timeoutMs = 90000) {
  const beforeSet = new Set(beforeFiles);
  const startTime = Date.now();
  const targetFileById = generationId ? path.join(genDir, `${generationId}.wav`) : null;

  while (Date.now() - startTime < timeoutMs) {
    if (targetFileById && fs.existsSync(targetFileById)) {
      try {
        const stat = fs.statSync(targetFileById);
        if (stat.size > 2000) {
          await new Promise(r => setTimeout(r, 400));
          return targetFileById;
        }
      } catch {}
    }

    if (fs.existsSync(genDir)) {
      try {
        const currentFiles = fs.readdirSync(genDir);
        for (const file of currentFiles) {
          if ((file.endsWith('.wav') || file.endsWith('.ogg') || file.endsWith('.mp3')) && !beforeSet.has(file)) {
            const fullPath = path.join(genDir, file);
            const stat = fs.statSync(fullPath);
            if (stat.size > 2000) {
              await new Promise(r => setTimeout(r, 400));
              return fullPath;
            }
          }
        }
      } catch {}
    }

    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

/** Donde Voicebox deja sus generaciones (la misma ruta que usaba `index.js`). */
function dirGeneracionesVoicebox() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, 'sh.voicebox.app', 'generations');
}

/**
 * Marca el modelo en uso durante toda la emisión: al empezar, cada 10 s y al
 * terminar. Así otro proceso nunca lo descarga a mitad de una síntesis (plan
 * C.2).
 */
async function conModeloEnUso(motor, fn) {
  const modelo = vb.ttsModelName(motor.engine, motor.modelSize);
  vb.tocarUso(modelo);
  const parar = vb.iniciarToquesPeriodicos(modelo);
  try {
    return await fn();
  } finally {
    parar();
    vb.tocarUso(modelo);
  }
}

/**
 * Genera el audio con el proveedor ya resuelto. OmniVoice es síncrono y
 * devuelve la ruta; Voicebox devuelve un id y el .wav aparece después en
 * `dirGeneracionesVoicebox()`.
 */
async function generarAudio({
  spokenText,
  voiceboxUrl,
  profile,
  language,
  motor,
  proveedor = 'voicebox',
  muestra = null,
  omniUrl = null,
  classTemperature = null
}) {
  if (proveedor === 'omnivoice') {
    try {
      const r = await om.sintetizarOmni(omniUrl, {
        texto: spokenText,
        refAudio: muestra.audioPath,
        refText: muestra.refText,
        classTemperature
      });
      return { ok: true, speakRes: { id: r.id, segundos: r.segundos, proveedor: 'omnivoice' }, generatedWavPath: r.audioPath };
    } catch (err) {
      return { ok: false, error: `OmniVoice: ${err.message}` };
    }
  }
  try {
    const speakRes = await sendVoiceboxGenerate(voiceboxUrl, spokenText, profile.id, language, {
      engine: motor.engine,
      modelSize: motor.modelSize
    });
    return { ok: true, speakRes, generatedWavPath: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Sintetiza un texto y devuelve la ruta del .wav, sin entregarlo a ningún
 * canal. Quien la llama es dueño del archivo y lo borra.
 *
 * `texto` pasa por `normalizeSpokenText` (sin markdown, código, rutas ni URLs,
 * redactado y cortado en un límite de oración). `voz` es un perfil de Voicebox
 * (el nombre de un alma resuelve a su voz, igual que en `agy_say`).
 *
 * Nunca lanza: `{ ok: false, motivo, detalle }` con `motivo` en
 * `texto_vacio`, `provider_unavailable`, `vram_blocked`, `pin_conflict`,
 * `generacion` o `sin_archivo`.
 */
async function sintetizar({ texto, voz = null, modo = 'inmediato', config = null, preparar = prepareNarrationTarget, generar = generarAudio, esperarArchivo = waitForGenerationFile, timeoutMs = 90000 } = {}) {
  const { text: spokenText } = normalizeSpokenText(texto);
  if (!spokenText) return { ok: false, motivo: 'texto_vacio', detalle: 'No quedó nada que leer en voz alta.' };

  let destino;
  try {
    destino = await preparar({ ...(voz ? { voice: voz } : {}), modo }, config || loadConfig());
  } catch (err) {
    return { ok: false, motivo: 'provider_unavailable', detalle: err.message };
  }
  if (destino.status !== 'audio') {
    return { ok: false, motivo: destino.reason || 'provider_unavailable', detalle: destino.error || null };
  }

  const genDir = dirGeneracionesVoicebox();
  const antes = fs.existsSync(genDir) ? fs.readdirSync(genDir) : [];
  return conModeloEnUso(destino.motor, async () => {
    const g = await generar({
      spokenText,
      voiceboxUrl: destino.voiceboxUrl,
      profile: destino.profile,
      language: destino.language,
      motor: destino.motor,
      proveedor: destino.proveedor,
      muestra: destino.muestra,
      omniUrl: destino.omniUrl,
      classTemperature: destino.classTemperature
    });
    if (!g.ok) return { ok: false, motivo: 'generacion', detalle: g.error };
    const wavPath = g.generatedWavPath
      || await esperarArchivo(genDir, g.speakRes && g.speakRes.id ? g.speakRes.id : null, antes, timeoutMs);
    if (!wavPath) return { ok: false, motivo: 'sin_archivo', detalle: 'Voicebox no escribió el audio a tiempo.' };
    return {
      ok: true,
      wavPath,
      texto: spokenText,
      perfil: destino.profile ? destino.profile.name : null,
      proveedor: destino.proveedor
    };
  });
}

/**
 * FEAT-056 — Deja la voz lista sin generar audio (el botón "Preparar voz" de
 * la consola web). No fija el modelo: lo libera la inactividad, como siempre.
 *
 * `prepareNarrationTarget` levanta el servidor y activa el modelo, pero no
 * carga los pesos: OmniVoice los carga en la primera generación y Voicebox
 * solo precarga Qwen al fijar. Por eso se cargan acá a mano. Cargar OmniVoice
 * reinicia su reloj de inactividad, que mide el propio servidor; `tocarUso`
 * es para el keeper de Voicebox.
 *
 * Nunca lanza: los mismos motivos que `sintetizar`, más `carga`.
 */
async function preparar({
  voz = null,
  modo = 'inmediato',
  config = null,
  prepararDestino = prepareNarrationTarget,
  cargarOmni = vb.cargarOmniServidor,
  cargarQwen = vb.cargarQwen
} = {}) {
  let destino;
  try {
    destino = await prepararDestino({ ...(voz ? { voice: voz } : {}), modo }, config || loadConfig());
  } catch (err) {
    return { ok: false, motivo: 'provider_unavailable', detalle: err.message };
  }
  if (destino.status !== 'audio') {
    return { ok: false, motivo: destino.reason || 'provider_unavailable', detalle: destino.error || null };
  }

  let precargado = false;
  try {
    if (destino.proveedor === 'omnivoice') {
      await cargarOmni(destino.omniUrl);
      precargado = true;
    } else if (destino.motor && destino.motor.engine === 'qwen') {
      await cargarQwen(destino.voiceboxUrl, destino.motor.modelSize);
      precargado = true;
    }
  } catch (err) {
    return { ok: false, motivo: 'carga', detalle: err.message };
  }
  vb.tocarUso(vb.ttsModelName(destino.motor.engine, destino.motor.modelSize));
  return {
    ok: true,
    perfil: destino.profile ? destino.profile.name : null,
    proveedor: destino.proveedor,
    precargado
  };
}

module.exports = {
  preparar,
  httpRequest,
  resolveVoiceboxUrl,
  getVoiceboxProfiles,
  servidoresVoz,
  buildVoiceSnapshot,
  textOnlyTarget,
  prepareNarrationTarget,
  sendVoiceboxGenerate,
  waitForGenerationFile,
  dirGeneracionesVoicebox,
  conModeloEnUso,
  generarAudio,
  sintetizar
};
