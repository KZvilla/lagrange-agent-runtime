/**
 * FEAT-204 S3 — Los efectos de Voicebox en la pestaña Voz, del lado del plugin:
 *
 *   - la lectura de los efectos de un perfil (`efectosDe`, `huellaDe`) y los presets en `perfilesAjustes`;
 *   - `guardarEfectos` contra un Voicebox falso: el PUT de efectos, el 409 por huella, la verificación, la cola;
 *   - el carácter: un guardado de efectos en el medio ya no es un 502;
 *   - la API v2: `efectos` y `presets` con lista blanca, `POST /api/v2/voz/efectos` y `?forzar=1`;
 *   - Telegram: con efectos, la nota es `<id>_processed.wav`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat204s3-'));
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(raiz, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });

const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const ajustes = require(path.join(MCP, 'lib', 'ajustes.js'));
const caracter = require(path.join(MCP, 'lib', 'caracter-voz.js'));
const efectos = require(path.join(MCP, 'lib', 'efectos-voz.js'));

const RADIO = [
  { type: 'highpass', enabled: true, params: { cutoff_frequency_hz: 300.0 } },
  { type: 'lowpass', enabled: true, params: { cutoff_frequency_hz: 3400.0 } },
  { type: 'compressor', enabled: true, params: { threshold_db: -15.0, ratio: 6.0 } }
];
const DEEP = [{ type: 'pitch_shift', enabled: true, params: { semitones: -3.0 } }];
const PRESETS = () => [
  { id: 'p-robotic', name: 'Robotic', description: 'Metálico.', effects_chain: [{ type: 'chorus', enabled: true, params: { rate_hz: 5 } }], is_builtin: true, created_at: 'c' },
  { id: 'p-radio', name: 'Radio', description: 'Como por radio.', effects_chain: RADIO, is_builtin: true, created_at: 'c' },
  { id: 'p-deep', name: 'Deep Voice', description: 'Grave.', effects_chain: DEEP, is_builtin: true, created_at: 'c' },
  { id: 'p-mio', name: 'Mío', description: null, effects_chain: [{ type: 'reverb', enabled: true, params: { room_size: 0.5 } }], is_builtin: false, created_at: 'c' }
];

// ── Un Voicebox falso con los efectos de la 0.5.0 ──────────────────────────
function voiceboxFalso({ version = '0.5.0', perfiles, presets = PRESETS(), caido = false, presetsFalla = false, alLeer = null, alPutEfectos = null } = {}) {
  const db = new Map(perfiles.map((p) => [p.id, { ...p }]));
  const puts = [];
  const lecturas = { detalle: 0 };
  const resp = (status, cuerpo) => ({ status, body: cuerpo === undefined ? '' : JSON.stringify(cuerpo) });
  const pedir = async (url, { method = 'GET', body = null } = {}) => {
    if (caido) throw new Error('ECONNREFUSED');
    const ruta = new URL(url).pathname;
    if (ruta === '/' && method === 'GET') return resp(200, { message: 'voicebox API', version });
    if (ruta === '/health') return resp(200, { status: 'healthy' });
    if (ruta === '/effects/presets') return presetsFalla ? resp(500, { detail: 'boom' }) : resp(200, presets);
    if (ruta === '/profiles' && method === 'GET') return resp(200, [...db.values()]);
    let m = /^\/profiles\/([^/]+)\/effects$/.exec(ruta);
    if (m && method === 'PUT') {
      const p = db.get(decodeURIComponent(m[1]));
      if (!p) return resp(404, { detail: 'Profile not found' });
      puts.push({ tipo: 'efectos', body });
      p.effects_chain = body.effects_chain === null ? null : body.effects_chain;
      p.updated_at = `e${puts.length}`;
      if (alPutEfectos) alPutEfectos(p, db);
      return resp(200, { ...p });
    }
    m = /^\/profiles\/([^/]+)$/.exec(ruta);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const p = db.get(id);
      if (!p) return resp(404, { detail: 'Profile not found' });
      if (method === 'GET') {
        lecturas.detalle += 1;
        if (alLeer) alLeer(p, lecturas.detalle, db);
        const actual = db.get(id);
        if (!actual) return resp(404, { detail: 'Profile not found' });
        return resp(200, { ...actual, sample_count: 0, generation_count: 0 });
      }
      if (method === 'PUT') {
        // El PUT del carácter de la 0.5.0: cinco campos, sin tocar effects_chain.
        puts.push({ tipo: 'caracter', body });
        for (const k of ['name', 'description', 'language', 'personality']) p[k] = body[k] === undefined ? (k === 'language' ? 'en' : null) : body[k];
        if (body.default_engine !== null && body.default_engine !== undefined) p.default_engine = body.default_engine || null;
        p.updated_at = `t${puts.length}`;
        return resp(200, { ...p, sample_count: 0 });
      }
    }
    return resp(404, { detail: 'Not found' });
  };
  return { pedir, db, puts, lecturas };
}

const MARIE = (extra = {}) => ({
  id: 'id-1', name: 'Marie', description: 'Suave.', language: 'es', avatar_path: null, effects_chain: null, voice_type: 'cloned',
  preset_engine: null, preset_voice_id: null, design_prompt: null, default_engine: 'qwen', personality: 'Cálida.',
  generation_count: 3, sample_count: 1, created_at: 'c', updated_at: 't0', ...extra
});
const ONO = (extra = {}) => ({ ...MARIE(), id: 'id-2', name: 'Ono Añá', default_engine: null, ...extra });
const deps = (vb, extra = {}) => ({ url: 'http://vb', pedir: vb.pedir, guardarCache: (l) => { (extra.caches || []).push(l); }, log: (l) => { (extra.logs || []).push(l); } });
const HUELLA_NULL = efectos.huellaDe(null);

async function main() {
  const warnOriginal = console.warn;
  console.warn = () => {};

  await group('la lectura de los efectos de un perfil', () => {
    const presets = PRESETS();
    const ninguno = efectos.efectosDe(MARIE(), presets);
    check('sin cadena: ninguno, 0', ninguno.estado === 'ninguno' && ninguno.cantidad === 0 && ninguno.preset === null, JSON.stringify(ninguno));
    check('null y [] dan la misma huella', efectos.huellaDe(null) === efectos.huellaDe([]) && efectos.efectosDe(MARIE({ effects_chain: [] }), presets).estado === 'ninguno');
    const radio = efectos.efectosDe(MARIE({ effects_chain: RADIO }), presets);
    check('igual a Radio: preset, con id y nombre', radio.estado === 'preset' && radio.preset === 'p-radio' && radio.nombre === 'Radio' && radio.cantidad === 3, JSON.stringify(radio));
    // La comparación es semántica: sin `enabled`, -3 por -3.0 y las claves en otro orden.
    const deep = efectos.efectosDe(MARIE({ effects_chain: [{ params: { semitones: -3 }, type: 'pitch_shift' }] }), presets);
    check('Deep Voice sin enabled y con -3: el preset', deep.estado === 'preset' && deep.preset === 'p-deep', JSON.stringify(deep));
    const mio = efectos.efectosDe(MARIE({ effects_chain: [{ type: 'reverb', enabled: true, params: { room_size: 0.5 } }] }), presets);
    check('un preset del usuario también se reconoce', mio.estado === 'preset' && mio.nombre === 'Mío');
    const otra = efectos.efectosDe(MARIE({ effects_chain: [{ type: 'delay', enabled: true, params: { delay_seconds: 0.3 } }] }), presets);
    check('otra cadena: personalizado', otra.estado === 'personalizado' && otra.cantidad === 1, JSON.stringify(otra));
    const apagada = efectos.efectosDe(MARIE({ effects_chain: RADIO.map((e) => ({ ...e, enabled: false })) }), presets);
    check('toda apagada: personalizado con cantidad 0', apagada.estado === 'personalizado' && apagada.cantidad === 0, JSON.stringify(apagada));
    const sinLista = efectos.efectosDe(MARIE({ effects_chain: RADIO }), null);
    check('sin lista de presets: desconocido, nunca personalizado', sinLista.estado === 'desconocido' && sinLista.cantidad === 3);
    check('con una lista vacía, también desconocido', efectos.efectosDe(MARIE({ effects_chain: RADIO }), []).estado === 'desconocido');
    const sinListaApagada = efectos.efectosDe(MARIE({ effects_chain: [{ type: 'chorus', enabled: false }] }), null);
    check('toda apagada y sin lista: desconocido', sinListaApagada.estado === 'desconocido' && sinListaApagada.cantidad === 0);
    const larga = Array.from({ length: 20 }, (_, i) => ({ type: 'gain', enabled: true, params: { gain_db: i } }));
    check('más de 16 efectos: la huella es de la cadena entera', efectos.efectosDe(MARIE({ effects_chain: larga }), presets).huella === efectos.huellaDe(larga)
      && efectos.huellaDe(larga) !== efectos.huellaDe(larga.slice(0, 16)));
  });

  await group('perfilesAjustes: presets y efectos', async () => {
    const snap = (ok, perfiles) => async () => ({ health: { ok }, desdeCache: !ok, snapshot: { profiles: perfiles, samples: {} } });
    const encendido = await ajustes.perfilesAjustes({ config: {}, construir: snap(true, [MARIE({ effects_chain: RADIO }), ONO()]), versionDe: async () => '0.5.0', leerPresets: async () => PRESETS() });
    check('encendido: presets públicos, sin cadena', encendido.presets.length === 4 && encendido.presets[3].nombre === 'Mío' && !('effects_chain' in encendido.presets[0]) && encendido.presetsError === null, JSON.stringify(encendido.presets));
    check('encendido: Marie con Radio, Ono sin efectos', encendido.perfiles[0].efectos.estado === 'preset' && encendido.perfiles[0].efectos.nombre === 'Radio' && encendido.perfiles[1].efectos.estado === 'ninguno');
    const falla = await ajustes.perfilesAjustes({ config: {}, construir: snap(true, [MARIE({ effects_chain: RADIO })]), versionDe: async () => '0.5.0', leerPresets: async () => { throw new Error('HTTP 500'); } });
    check('/effects/presets falla: presets [] y presetsError, la lista sigue', falla.ok && falla.presets.length === 0 && /presets de efectos.*HTTP 500/.test(falla.presetsError) && falla.perfiles[0].efectos.estado === 'desconocido', JSON.stringify(falla).slice(0, 300));
    let pedidos = 0;
    const apagado = await ajustes.perfilesAjustes({ config: {}, construir: snap(false, [MARIE({ effects_chain: RADIO })]), leerPresets: async () => { pedidos += 1; return PRESETS(); } });
    check('apagado: no pide presets y sale desconocido', pedidos === 0 && apagado.presets.length === 0 && apagado.presetsError === null && apagado.perfiles[0].efectos.estado === 'desconocido');
  });

  await group('guardarEfectos: guardar', async () => {
    const vb = voiceboxFalso({ perfiles: [MARIE(), ONO({ effects_chain: RADIO })] });
    const caches = [];
    let r = await efectos.guardarEfectos({ nombre: 'Marie', preset: 'p-radio', base: HUELLA_NULL }, deps(vb, { caches }));
    check('un preset: ok y el PUT manda su cadena', r.ok === true && vb.puts.length === 1 && vb.puts[0].tipo === 'efectos' && JSON.stringify(vb.puts[0].body) === JSON.stringify({ effects_chain: RADIO }), JSON.stringify(r));
    check('Voicebox quedó con Radio', JSON.stringify(vb.db.get('id-1').effects_chain) === JSON.stringify(RADIO));
    check('la respuesta trae el perfil con efectos y la huella nueva', r.perfil.nombre === 'Marie' && r.perfil.efectos.estado === 'preset' && r.perfil.efectos.preset === 'p-radio' && r.perfil.efectos.huella === efectos.huellaDe(RADIO));
    check('la caché se escribe con la lista de después', caches.length === 1 && JSON.stringify(caches[0].find((p) => p.id === 'id-1').effects_chain) === JSON.stringify(RADIO));
    check('el carácter no cambió', vb.db.get('id-1').description === 'Suave.' && vb.db.get('id-1').personality === 'Cálida.');

    r = await efectos.guardarEfectos({ nombre: 'marie', preset: 'p-radio', base: efectos.huellaDe(RADIO) }, deps(vb));
    check('lo mismo: sinCambios, sin PUT (y el nombre sin distinguir mayúsculas)', r.ok && r.sinCambios === true && vb.puts.length === 1, JSON.stringify(r));

    r = await efectos.guardarEfectos({ nombre: 'Ono Añá', preset: null, base: efectos.huellaDe(RADIO) }, deps(vb));
    check('Ninguno: manda effects_chain null', r.ok && vb.puts.at(-1).body.effects_chain === null && vb.db.get('id-2').effects_chain === null && r.perfil.efectos.estado === 'ninguno', JSON.stringify(r));

    const larga = Array.from({ length: 20 }, (_, i) => ({ type: 'gain', enabled: true, params: { gain_db: i } }));
    vb.db.get('id-2').effects_chain = larga;
    r = await efectos.guardarEfectos({ nombre: 'Ono Añá', preset: 'p-deep', base: efectos.huellaDe(larga) }, deps(vb));
    check('una cadena de 20 efectos se reemplaza con su huella', r.ok && JSON.stringify(vb.db.get('id-2').effects_chain) === JSON.stringify(DEEP), JSON.stringify(r));
  });

  await group('guardarEfectos: errores', async () => {
    const vb = voiceboxFalso({ perfiles: [MARIE({ effects_chain: RADIO })] });
    let r = await efectos.guardarEfectos({ nombre: 'Marie', preset: 'p-deep', base: HUELLA_NULL }, deps(vb));
    check('huella vieja: 409 con actuales que reconoce Radio', r.codigo === 409 && r.actuales.estado === 'preset' && r.actuales.nombre === 'Radio' && r.actuales.huella === efectos.huellaDe(RADIO) && vb.puts.length === 0, JSON.stringify(r));
    r = await efectos.guardarEfectos({ nombre: 'Nadie', preset: null, base: HUELLA_NULL }, deps(vb));
    check('voz que no existe: 404', r.codigo === 404);
    r = await efectos.guardarEfectos({ nombre: 'Marie', preset: 'p-borrado', base: efectos.huellaDe(RADIO) }, deps(vb));
    check('preset desconocido: 400 «releé la lista»', r.codigo === 400 && /releé la lista/.test(r.error) && vb.puts.length === 0, JSON.stringify(r));
    for (const [nombre, pedido] of [
      ['clave de más', { nombre: 'Marie', preset: null, base: HUELLA_NULL, effects_chain: [] }],
      ['nombre con control', { nombre: 'Ma\nrie', preset: null, base: HUELLA_NULL }],
      ['preset no texto', { nombre: 'Marie', preset: 3, base: HUELLA_NULL }],
      ['base que no es hex de 64', { nombre: 'Marie', preset: null, base: 'abc' }],
      ['base como cadena', { nombre: 'Marie', preset: null, base: RADIO }],
      ['no es un objeto', null]
    ]) {
      r = await efectos.guardarEfectos(pedido, deps(vb));
      check(`400: ${nombre}`, r.codigo === 400, JSON.stringify(r));
    }
    r = await efectos.guardarEfectos({ nombre: 'Marie', preset: null, base: efectos.huellaDe(RADIO) }, deps(voiceboxFalso({ perfiles: [MARIE()], caido: true })));
    check('apagado: 503 apagado que habla de los efectos', r.codigo === 503 && r.motivo === 'apagado' && /los efectos se editan/.test(r.error), JSON.stringify(r));
    r = await efectos.guardarEfectos({ nombre: 'Marie', preset: null, base: HUELLA_NULL }, deps(voiceboxFalso({ perfiles: [MARIE()], version: '0.6.0' })));
    check('otra versión: 503 version que habla de los efectos', r.codigo === 503 && r.motivo === 'version' && /0\.6\.0: los efectos se editan con la 0\.5/.test(r.error), JSON.stringify(r));
    r = await efectos.guardarEfectos({ nombre: 'Marie', preset: null, base: HUELLA_NULL }, deps(voiceboxFalso({ perfiles: [MARIE()], presetsFalla: true })));
    check('presets que fallan al guardar: 503 presets, no «apagado»', r.codigo === 503 && r.motivo === 'presets' && /lista de presets/.test(r.error) && !/apagado/.test(r.error), JSON.stringify(r));

    // La voz se borra entre la lista y el detalle: 404, no 503.
    const borra = voiceboxFalso({ perfiles: [MARIE()], alLeer: (p, n, db) => { if (n === 1) db.delete(p.id); } });
    r = await efectos.guardarEfectos({ nombre: 'Marie', preset: null, base: HUELLA_NULL }, deps(borra));
    check('borrada entre la lista y el detalle: 404', r.codigo === 404, JSON.stringify(r));

    // Otro cambia los efectos después del PUT: la verificación da 502.
    const pisa = voiceboxFalso({ perfiles: [MARIE()], alPutEfectos: (p) => { p.effects_chain = DEEP; } });
    r = await efectos.guardarEfectos({ nombre: 'Marie', preset: 'p-radio', base: HUELLA_NULL }, deps(pisa));
    check('la huella verificada no es la mandada: 502 effects_chain', r.codigo === 502 && r.diferencias.length === 1 && r.diferencias[0].campo === 'effects_chain', JSON.stringify(r));

    // Otro cambia el carácter en el medio: no es un error, queda en el log.
    const logs = [];
    const car = voiceboxFalso({ perfiles: [MARIE()], alPutEfectos: (p) => { p.description = 'Cambiada en la app.'; } });
    r = await efectos.guardarEfectos({ nombre: 'Marie', preset: 'p-radio', base: HUELLA_NULL }, deps(car, { logs }));
    check('el carácter cambió en el medio: ok y log', r.ok === true && logs.some((l) => /el carácter cambió en el medio \(description\)/.test(l)), JSON.stringify({ r, logs }));
  });

  await group('el carácter con efectos en el medio', async () => {
    const MAR = MARIE();
    // Un guardado de efectos entre las dos lecturas del carácter (en la 2.ª lectura del detalle).
    const vb = voiceboxFalso({ perfiles: [MAR], alLeer: (p, n) => { if (n === 2) p.effects_chain = RADIO; } });
    const r = await caracter.guardarCaracter({ nombre: 'Marie', description: 'Nueva.', personality: 'Cálida.', base: caracter.baseDe(MAR) }, deps(vb));
    check('un PUT de efectos entre las dos lecturas: ok, no 502', r.ok === true, JSON.stringify(r));
    check('el PUT del carácter no lleva effects_chain', vb.puts.every((x) => x.tipo !== 'caracter' || !('effects_chain' in x.body)));

    // Algo cambia de verdad (el idioma) y, entre la restauración y su relectura, otro guarda efectos.
    const MAR2 = MARIE();
    const vb2 = voiceboxFalso({ perfiles: [MAR2], alLeer: (p, n) => { if (n === 2) p.language = 'fr'; if (n === 3) p.effects_chain = DEEP; } });
    const r2 = await caracter.guardarCaracter({ nombre: 'Marie', description: 'Nueva.', personality: 'Cálida.', base: caracter.baseDe(MAR2) }, deps(vb2));
    check('efectos en el medio de la restauración: «restaurado»', r2.codigo === 502 && r2.restauracion === 'restaurado', JSON.stringify(r2));
    check('motivoSoloLectura del carácter sigue igual', /el carácter se edita con la 0\.5/.test(caracter.motivoSoloLectura('0.6.0')));
  });

  await group('la cola compartida', async () => {
    const vb = voiceboxFalso({ perfiles: [MARIE()] });
    const [a, b] = await Promise.all([
      efectos.guardarEfectos({ nombre: 'Marie', preset: 'p-radio', base: HUELLA_NULL }, deps(vb)),
      efectos.guardarEfectos({ nombre: 'Marie', preset: 'p-deep', base: HUELLA_NULL }, deps(vb))
    ]);
    check('dos guardados con la misma base: el primero ok, el segundo 409', a.ok === true && b.codigo === 409 && b.actuales.nombre === 'Radio', JSON.stringify({ a, b }));
    check('un solo PUT de efectos', vb.puts.filter((x) => x.tipo === 'efectos').length === 1);

    const vb2 = voiceboxFalso({ perfiles: [MARIE()] });
    const caches = [];
    // El orden de los pedidos: con la cola, los efectos no leen nada hasta que el carácter terminó (PUT y caché).
    const orden = [];
    const conOrden = (quien) => ({ ...deps(vb2, { caches }), pedir: async (u, o = {}) => { orden.push(`${quien}:${o.method || 'GET'}:${new URL(u).pathname}`); return vb2.pedir(u, o); }, guardarCache: (l) => { orden.push(`${quien}:cache`); caches.push(l); } });
    const [c, e] = await Promise.all([
      caracter.guardarCaracter({ nombre: 'Marie', description: 'Otra.', personality: 'Cálida.', base: caracter.baseDe(MARIE()) }, conOrden('car')),
      efectos.guardarEfectos({ nombre: 'Marie', preset: 'p-radio', base: HUELLA_NULL }, conOrden('efx'))
    ]);
    const finCar = orden.indexOf('car:cache');
    const inicioEfx = orden.findIndex((x) => x.startsWith('efx:'));
    check('la cola: los efectos empiezan después de la caché del carácter', finCar >= 0 && inicioEfx > finCar, orden.join(' '));
    const ultima = caches.at(-1).find((p) => p.id === 'id-1');
    check('carácter y efectos a la vez: los dos ok', c.ok === true && e.ok === true, JSON.stringify({ c, e }));
    check('la última caché tiene los dos cambios', ultima.description === 'Otra.' && JSON.stringify(ultima.effects_chain) === JSON.stringify(RADIO), JSON.stringify(ultima));
  });

  await group('API v2: perfiles y efectos', async () => {
    const vb = voiceboxFalso({ perfiles: [MARIE({ effects_chain: RADIO }), ONO()] });
    const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
    const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js');
    let lecturasDePerfiles = 0;
    const nucleo = crearNucleoWeb({
      canal: crearCanalWeb(),
      bot: { almasDisponibles: () => [], agentesCasteables: () => [] },
      almas: {}, workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({}),
      ajustes: {
        leer: () => ({ ok: true }),
        perfiles: async () => {
          lecturasDePerfiles += 1;
          return ajustes.perfilesAjustes({
            config: {}, versionDe: async () => '0.5.0',
            construir: async () => ({ health: { ok: true }, snapshot: { profiles: JSON.parse((await vb.pedir('http://vb/profiles')).body).map((p) => ({ ...p, ruta: 'C:/x' })), samples: {} } }),
            leerPresets: async () => efectos.leerPresets({ url: 'http://vb', pedir: vb.pedir })
          });
        },
        efectos: (c) => efectos.guardarEfectos(c, deps(vb))
      }
    });
    const lect = await importar('telegram-bridge/web/v2/lecturas.js');
    const mut = await importar('telegram-bridge/web/v2/mutaciones.js');
    const tareasMod = await importar('telegram-bridge/tareas.js');
    const todas = [
      ...lect.rutasLecturaV2({ nucleo, estadoDeCarriles: () => [], recorte: tareasMod.RECORTE, arranque: 'arr' }),
      ...mut.rutasMutacionV2({ nucleo, cola: {}, ctx: { chat: { id: 'web:terminal' } }, chatTerminal: 'web:terminal', registro: { obtener: () => null }, idem: null, almacen: { publicar: () => {} }, recorte: tareasMod.RECORTE })
    ];
    const llamar = (metodo, ruta, cuerpo = {}) => {
      const u = new URL(`http://x${ruta}`);
      const r = todas.find((x) => x.metodo === metodo && x.patron.test(u.pathname));
      return r ? r.fn({ p: [], cuerpo, url: u }) : { codigo: 404 };
    };

    const perf = await llamar('GET', '/api/v2/voz/perfiles');
    const marie = perf.perfiles.find((p) => p.nombre === 'Marie');
    const ono = perf.perfiles.find((p) => p.nombre === 'Ono Añá');
    check('perfiles: presets con id, nombre y descripción, sin cadena', perf.presets.length === 4 && JSON.stringify(Object.keys(perf.presets[0]).sort()) === '["descripcion","id","nombre"]' && perf.presetsError === null, JSON.stringify(perf.presets));
    check('perfiles: efectos con lista blanca', JSON.stringify(Object.keys(marie.efectos).sort()) === '["cantidad","estado","huella","nombre","preset"]' && marie.efectos.nombre === 'Radio', JSON.stringify(marie.efectos));
    check('perfiles: ni id ni ruta ni la cadena', !/id-1|C:\/x|cutoff_frequency_hz/.test(JSON.stringify(perf)));
    check('un perfil sin default_engine llega con motor null', ono.motor === null, JSON.stringify(ono.motor));

    const antes = lecturasDePerfiles;
    await llamar('GET', '/api/v2/voz/perfiles');
    check('sin forzar: la caché de 10 s', lecturasDePerfiles === antes);
    await llamar('GET', '/api/v2/voz/perfiles?forzar=1');
    check('?forzar=1: va al núcleo', lecturasDePerfiles === antes + 1);

    const g = await llamar('POST', '/api/v2/voz/efectos', { nombre: 'Ono Añá', preset: 'p-deep', base: ono.efectos.huella });
    check('POST voz/efectos con espacio y tilde: ok, perfil con efectos y sin avisos', g.ok === true && g.perfil.nombre === 'Ono Añá' && g.perfil.efectos.preset === 'p-deep' && g.perfil.avisos === undefined, JSON.stringify(g));
    const despues = lecturasDePerfiles;
    await llamar('GET', '/api/v2/voz/perfiles');
    check('un guardado invalida la caché', lecturasDePerfiles === despues + 1);
    const c409 = await llamar('POST', '/api/v2/voz/efectos', { nombre: 'Ono Añá', preset: null, base: ono.efectos.huella });
    check('POST con huella vieja: 409 con actuales proyectados', c409.codigo === 409 && c409.actuales.nombre === 'Deep Voice' && c409.actuales.huella.length === 64, JSON.stringify(c409));
    const c400 = await llamar('POST', '/api/v2/voz/efectos', { nombre: 'Ono Añá', preset: null, base: 'x' });
    check('POST malformado: 400', c400.codigo === 400 && c400.ok === false);

    const { efectosVozV2, perfilesVozV2 } = await importar('telegram-bridge/web/v2/ajustes.js');
    const viejo = await efectosVozV2({}, {});
    check('un daemon sin guardarEfectos: 503', viejo.codigo === 503);
    const fuga = await efectosVozV2({ guardarEfectos: async () => ({ ok: false, codigo: 502, error: 'x', diferencias: [{ campo: 'effects_chain', antes: [1], despues: 'secreto' }] }) }, {});
    check('502: solo el campo de cada diferencia', fuga.codigo === 502 && JSON.stringify(fuga.diferencias) === '[{"campo":"effects_chain"}]');
    const raro = await perfilesVozV2({ perfilesAjustes: async () => ({ ok: true, perfiles: [{ nombre: 'X', efectos: { estado: 'otro', huella: 'no' } }], presets: [{ id: 'a' }, { id: 'b', nombre: 'B', effects_chain: [1] }], presetsError: 'falló' }) });
    check('lista blanca: un estado desconocido da efectos null; un preset sin nombre se cae', raro.perfiles[0].efectos === null && raro.presets.length === 1 && !('effects_chain' in raro.presets[0]) && raro.presetsError === 'falló', JSON.stringify(raro));
  });

  await group('Telegram: la nota con efectos', () => {
    const dir = fs.mkdtempSync(path.join(raiz, 'vbdir-'));
    const gen = path.join(dir, 'generations');
    fs.mkdirSync(gen, { recursive: true });
    const NOTIFY = pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'notify.js')).href;
    // El hijo: `fetch` stubeado, nada sale a la red. Con efectos, Voicebox escribe el limpio y después el procesado.
    const hijo = `
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { sendTelegramVoice, waitForVoiceboxGeneration } = await import(${JSON.stringify(NOTIFY)});
      const nombres = [];
      globalThis.fetch = async (url, opts) => { const f = opts.body.get('voice') || opts.body.get('audio'); nombres.push(f && f.name); return { json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 1 } } }) }; };
      const gen = process.env.GEN;
      const escribir = (n) => fs.writeFileSync(path.join(gen, n), Buffer.alloc(4096));
      escribir('g1.wav'); setTimeout(() => escribir('g1_processed.wav'), 300);
      await sendTelegramVoice({ generationId: 'g1', beforeFiles: [], timeoutMs: 10000, efectos: true, targetChatId: '1', caption: 'a' });
      escribir('g2.wav');
      await sendTelegramVoice({ generationId: 'g2', beforeFiles: ['g1.wav', 'g1_processed.wav'], timeoutMs: 10000, efectos: false, targetChatId: '1', caption: 'b' });
      escribir('g3.wav');
      const t0 = Date.now();
      const sinProcesado = await waitForVoiceboxGeneration({ generationId: 'g3', beforeFiles: [], timeoutMs: 10000, efectos: true, margenProcesadoMs: 800 });
      console.log('RESULTADO ' + JSON.stringify({ nombres, sinProcesado: path.basename(sinProcesado), espero: Date.now() - t0 }));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', hijo], {
      encoding: 'utf8', timeout: 30000,
      env: {
        ...process.env, GEN: gen, VOICEBOX_DIR: dir,
        TELEGRAM_BOT_TOKEN: '1234567890:AAFakeTokenForTestingOnly_DoNotUse',
        TELEGRAM_BRIDGE_STATE_FILE: path.join(dir, 'state.json'), TELEGRAM_BRIDGE_DATA_DIR: dir
      }
    });
    const linea = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RESULTADO '));
    const d = linea ? JSON.parse(linea.slice('RESULTADO '.length)) : null;
    check('el hijo corrió', Boolean(d), (r.stderr || '').slice(0, 500));
    if (!d) return;
    check('con efectos: sendTelegramVoice manda el procesado', d.nombres[0] === 'g1_processed.wav', JSON.stringify(d.nombres));
    check('sin efectos: el limpio', d.nombres[1] === 'g2.wav', JSON.stringify(d.nombres));
    // Sin `efectos` devolvería el limpio a los 400 ms; esperando el margen de 800 ms tarda al menos 800.
    check('con efectos y sin procesado en el margen: el limpio, tras esperarlo', d.sinProcesado === 'g3.wav' && d.espero >= 750, JSON.stringify(d));
  });

  console.warn = warnOriginal;
  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
