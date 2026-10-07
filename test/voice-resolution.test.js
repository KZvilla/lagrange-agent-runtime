const vr = require('../mcp-server/voice-resolution.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`); }
}
function rejects(name, value) {
  try { vr.validateVoiceSetup(value); check(name, false); }
  catch (err) { check(name, err.code === 'INVALID_VOICE_SETUP', err.message); }
}

const setup = {
  version: 3,
  status: 'configured',
  languages: ['es'],
  default_language: 'es',
  defaults: { es: { identity: { mode: 'soul', soul: 'alya' }, audio: { profile: 'Priscilla', provider: 'omnivoice' } } },
  fallbacks: { es: [{ profile: 'Alya', provider: 'voicebox', engine: 'qwen', model_size: '0.6B' }] }
};
const snapshot = {
  profiles: [
    { id: 'p1', name: 'Priscilla', language: 'es', default_engine: 'qwen' },
    { id: 'p2', name: 'Alya', language: 'es', default_engine: 'qwen' },
    { id: 'p3', name: 'Emily', language: 'en', default_engine: 'kokoro' }
  ],
  voicebox: { reachable: true, startable: true, models: [
    { model_name: 'qwen-tts-0.6B', downloaded: true, loaded: false },
    { model_name: 'kokoro', downloaded: true, loaded: true }
  ] },
  omnivoice: { reachable: false, startable: true, weights_downloaded: true },
  samples: { p1: { sample_exists: true }, p2: { sample_exists: false } },
  souls: { alya: true }
};

vr.validateVoiceSetup(setup);
check('setup v3 válido', true);
rejects('rechaza default_language ausente', { ...setup, default_language: undefined });
rejects('rechaza Qwen sin model_size', { ...setup, defaults: { es: { identity: { mode: 'neutral' }, audio: { profile: 'Alya', provider: 'voicebox', engine: 'qwen' } } } });
rejects('rechaza engine en OmniVoice', { ...setup, defaults: { es: { identity: { mode: 'neutral' }, audio: { profile: 'Alya', provider: 'omnivoice', engine: 'qwen' } } } });
check('ausencia de setup = unconfigured', vr.setupState({}) === 'unconfigured');
check('voz_por_perfil = legacy', vr.setupState({ vozPorPerfil: { Alya: 'voicebox' } }) === 'legacy');
check('setup manual inválido no autoriza audio', vr.setupState({ voiceSetup: { version: 3, status: 'configured', languages: ['es'] } }) === 'invalid');

let r = vr.resolveVoice({ config: { voiceSetup: setup }, snapshot });
check('default conserva Soul y usa OmniVoice', r.status === 'audio' && r.audio.profile_name === 'Priscilla' && r.identity.soul === 'alya');
r = vr.resolveVoice({ args: { voice: 'Alya', personality: true }, config: {}, snapshot });
check('voice-only sigue funcionando', r.status === 'audio' && r.audio.provider === 'voicebox' && r.audio.model_size === '0.6B' && r.identity.mode === 'profile', JSON.stringify(r));
r = vr.resolveVoice({ args: { voice: 'Emily', language: 'es' }, config: {}, snapshot });
check('idioma contradictorio no cambia perfil', r.status === 'text-only' && r.reason === 'language_mismatch');
r = vr.resolveVoice({ args: { voice: 'Alya', motor: 'omnivoice' }, config: {}, snapshot });
check('OmniVoice sin muestra cae a texto, no a otra voz', r.status === 'text-only' && r.reason === 'sample_missing');
r = vr.resolveVoice({ args: { provider: 'voicebox', motor: 'omnivoice', voice: 'Alya' }, config: {}, snapshot });
check('aliases contradictorios fallan', r.reason === 'ambiguous_explicit_route');
r = vr.resolveVoice({ args: { voice: 'Priscilla', engine: 'qwen', model_size: '0.6B' }, config: {}, snapshot });
check('engine puntual implica Voicebox, no se pierde en OmniVoice', r.status === 'audio' && r.audio.provider === 'voicebox');
r = vr.resolveVoice({ args: { provider: 'voicebox' }, config: { voiceSetup: setup }, snapshot });
check('override de provider aplica sobre el default configurado', r.status === 'audio' && r.audio.provider === 'voicebox');
// BE-114 — voz_por_perfil es una preferencia de proveedor para la voz explícita,
// también con voice_setup configurado; nunca toca las rutas declaradas.
r = vr.resolveVoice({ args: { voice: 'Priscilla' }, config: { voiceSetup: setup, vozPorPerfil: { Priscilla: 'voicebox' } }, snapshot });
check('BE-114: con voice_setup, voz_por_perfil ordena la voz explícita', r.status === 'audio' && r.audio.provider === 'voicebox'
  && r.preferencia && r.preferencia.proveedor === 'voicebox' && r.preferencia.cumplida === true, JSON.stringify(r.preferencia));
r = vr.resolveVoice({ args: { voice: 'Prisc' }, config: { voiceSetup: setup, vozPorPerfil: { priscilla: 'voicebox' } }, snapshot });
check('BE-114: la clave va contra el perfil resuelto, sin mayúsculas (voz parcial)', r.status === 'audio' && r.audio.provider === 'voicebox');
const sinQwen = { ...snapshot, voicebox: { ...snapshot.voicebox, models: [{ model_name: 'kokoro', downloaded: true, loaded: true }] } };
r = vr.resolveVoice({ args: { voice: 'Priscilla' }, config: { voiceSetup: setup, vozPorPerfil: { Priscilla: 'voicebox' } }, snapshot: sinQwen });
check('BE-114: preferencia no cumplida → el otro proveedor, mismo perfil, y lo dice', r.status === 'audio' && r.audio.provider === 'omnivoice'
  && r.profile.name === 'Priscilla' && r.preferencia && r.preferencia.cumplida === false && r.preferencia.motivo === 'model_not_downloaded', JSON.stringify(r.preferencia));
r = vr.resolveVoice({ args: { voice: 'Priscilla', provider: 'omnivoice' }, config: { voiceSetup: setup, vozPorPerfil: { Priscilla: 'voicebox' } }, snapshot });
check('BE-114: provider en la llamada gana y no hay preferencia', r.status === 'audio' && r.audio.provider === 'omnivoice' && !r.preferencia);
r = vr.resolveVoice({ args: { voice: 'Priscilla', engine: 'qwen', model_size: '0.6B' }, config: { vozPorPerfil: { Priscilla: 'omnivoice' } }, snapshot });
check('BE-114: engine/model_size en la llamada fuerzan Voicebox, estricto', r.status === 'audio' && r.audio.provider === 'voicebox' && !r.preferencia);
r = vr.resolveVoice({ args: { voice: 'Priscilla', modo: 'diferido' }, config: { vozPorPerfil: { Priscilla: 'omnivoice' } }, snapshot });
check('BE-114: la preferencia gana al modo', r.status === 'audio' && r.audio.provider === 'omnivoice');
r = vr.resolveVoice({ args: { voice: 'Priscilla' }, config: { vozPorPerfil: { Priscilla: 'kokoro' } }, snapshot });
check('BE-114: un valor inválido se ignora (orden por modo)', r.status === 'audio' && r.audio.provider === 'omnivoice' && !r.preferencia);
r = vr.resolveVoice({ config: { voiceSetup: setup, vozPorPerfil: { Priscilla: 'voicebox' } }, snapshot });
check('BE-114: la ruta declarada de voice_setup no cambia', r.status === 'audio' && r.audio.provider === 'omnivoice' && !r.preferencia);
r = vr.resolveVoice({ args: { voice: 'Alya' }, config: { vozPorPerfil: { Alya: 'omnivoice' } }, snapshot });
check('BE-114: sin voice_setup ya no es estricto (Alya sin muestra → Voicebox)', r.status === 'audio' && r.audio.provider === 'voicebox'
  && r.preferencia && r.preferencia.cumplida === false && r.preferencia.motivo === 'sample_missing', JSON.stringify(r.preferencia));
// El orden por modo (antes en omnivoice.test.js, sobre preferenciaProveedor, que se borró).
const por = (modo) => vr.resolveVoice({ args: { voice: 'Priscilla', ...(modo ? { modo } : {}) }, config: {}, snapshot }).audio.provider;
check('modo inmediato → OmniVoice', por('inmediato') === 'omnivoice');
check('modo diferido → Voicebox', por('diferido') === 'voicebox');
check('sin modo → inmediato', por(null) === 'omnivoice');
r = vr.resolveVoice({ config: { voiceSetup: setup }, snapshot: { ...snapshot, omnivoice: {}, samples: {} } });
check('fallback acústico conserva Soul', r.status === 'audio' && r.fallback && r.audio.profile_name === 'Alya' && r.identity.soul === 'alya');
r = vr.resolveVoice({ config: { voiceSetup: setup }, snapshot: { ...snapshot, souls: {} } });
check('Soul ausente degrada visible a neutral', r.status === 'audio' && r.identity.mode === 'neutral' && r.identity.reason === 'identity_unavailable');
r = vr.resolveVoice({ config: {}, snapshot });
check('sin setup ni voz = setup_required', r.status === 'text-only' && r.reason === 'setup_required');
r = vr.resolveVoice({ config: { voiceSetup: { version: 3, status: 'configured', languages: ['es'] } }, snapshot });
check('setup manual inválido falla cerrado', r.status === 'text-only' && r.reason === 'invalid_setup');

// BE-029 — Desempate de tamaño de Qwen. Con los dos descargados (lo normal en
// una instalación real) antes devolvía compatibility_unknown y la ruta Qwen
// quedaba inservible para TODAS las voces, no solo para las que no declaran
// motor.
const conAmbos = {
  ...snapshot,
  voicebox: { reachable: true, startable: true, models: [
    { model_name: 'qwen-tts-0.6B', downloaded: true, loaded: false },
    { model_name: 'qwen-tts-1.7B', downloaded: true, loaded: false },
    { model_name: 'kokoro', downloaded: true, loaded: true }
  ] }
};
r = vr.resolveVoice({ args: { voice: 'Priscilla', engine: 'qwen' }, config: {}, snapshot: conAmbos });
check('con los dos tamaños elige 1.7B', r.status === 'audio' && r.audio.model_size === '1.7B', JSON.stringify(r));
r = vr.resolveVoice({ args: { voice: 'Priscilla', engine: 'qwen', model_size: '0.6B' }, config: {}, snapshot: conAmbos });
check('un tamaño pedido a mano sigue mandando', r.status === 'audio' && r.audio.model_size === '0.6B');
r = vr.resolveVoice({
  args: { voice: 'Priscilla', engine: 'qwen' },
  config: {},
  snapshot: { ...snapshot, voicebox: { reachable: true, startable: true, models: [{ model_name: 'kokoro', downloaded: true }] } }
});
check('sin ningún tamaño descargado → model_not_downloaded', r.status === 'text-only' && r.reason === 'model_not_downloaded', JSON.stringify(r));

// En Node la lista es una sola: el servidor la importa de este módulo.
const prioridadDelServidor = require('../mcp-server/voicebox-server.js').PRIORIDAD_TAMANO_QWEN;
check('el servidor usa la misma lista, no una copia', prioridadDelServidor === vr.PRIORIDAD_TAMANO_QWEN);

// Python no puede importarla: common.py la espeja. Que no se separen en
// silencio, y que el test no pase en verde por no encontrar la línea.
const commonPy = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'voice-chat', 'common.py'), 'utf8');
const m = commonPy.match(/^_QWEN_SIZE_PRIORITY\s*=\s*(\[[^\]]*\])/m);
check('common.py declara _QWEN_SIZE_PRIORITY', !!m);
check('la prioridad de Python no se desincroniza de la de Node',
  !!m && JSON.stringify(JSON.parse(m[1])) === JSON.stringify(vr.PRIORIDAD_TAMANO_QWEN),
  m ? `${m[1]} vs ${JSON.stringify(vr.PRIORIDAD_TAMANO_QWEN)}` : 'sin coincidencia');

// BE-114 — Python espeja la regla: preferencia sin el gate de voice_setup, y el
// código muerto que la ignoraba ya no está.
check('common.py tiene proveedor_preferido (espejo de BE-114)', /^def proveedor_preferido\(/m.test(commonPy));
check('common.py ya no apaga voz_por_perfil con voice_setup configurado', !/voz_por_perfil"\) if not isinstance\(setup, dict\)/.test(commonPy));
check('common.py ya no tiene activar_motor_chat (código muerto)', !/def activar_motor_chat\(/.test(commonPy));
check('common.py: engine/model_size implican Voicebox estricto, como en Node',
  commonPy.includes('pedido = provider or ("voicebox" if (engine or model_size) else None)'));
// Comportamiento real de Python, no solo el texto: si no hay Python en la máquina, se informa y no se falla.
{
  const { spawnSync } = require('node:child_process');
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const codigo = [
    'import sys, io, contextlib', 'sys.path.insert(0, sys.argv[1])',
    'from common import proveedor_preferido as p, avisar_preferencia as a',
    'r = [p({"priscilla": "voicebox"}, {"name": "Priscilla"}), p({"X": "kokoro"}, {"name": "X"}), p(None, {"name": "X"}), p({"X": "omnivoice"}, None)]',
    'f = io.StringIO()', 'with contextlib.redirect_stdout(f): a("voicebox", "omnivoice", ["model_not_downloaded"]); a("voicebox", "voicebox", []); a(None, "omnivoice", [])',
    'print(repr(r)); print(f.getvalue().strip())'
  ].join('\n');
  const res = spawnSync(py, ['-I', '-c', codigo, require('node:path').join(__dirname, '..', 'voice-chat')], { encoding: 'utf8', timeout: 30000 });
  if (res.error || res.status === null) {
    console.log(`  · Python no disponible (${res.error ? res.error.code : 'sin salida'}): se omite el test de comportamiento de common.py`);
  } else {
    const salida = (res.stdout || '').trim().split(/\r?\n/);
    check('Python: proveedor_preferido (sin mayúsculas, inválido, None)', salida[0] === "['voicebox', None, None, None]", `${salida[0]} ${res.stderr || ''}`);
    check('Python: avisa solo la preferencia no cumplida', salida.length === 2 && salida[1] === '[voice] voz_por_perfil preferia voicebox (model_not_downloaded): se uso omnivoice.', JSON.stringify(salida));
  }
}
const indexJs = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'mcp-server', 'index.js'), 'utf8');
check('set_config describe voz_por_perfil como preferencia (BE-114)', indexJs.includes('Provider preference per voice') && !indexJs.includes('Wins over modo.'));
check('la salida avisa una preferencia no cumplida (BE-114)', indexJs.includes('voz_por_perfil prefería ${nombreProv(pref.proveedor)}')
  && require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'mcp-server', 'voz-sintesis.js'), 'utf8').includes('preferencia: decision.preferencia || null'));

console.log(`\nvoice-resolution: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
