/**
 * FEAT-204 S0 — La pestaña Voz de la terminal, del lado del plugin:
 *
 *   - el núcleo de Ajustes: `voz_por_alma` y los dos tiempos de Voicebox en la sección `voz` (validación, hash, 409);
 *   - `leerVozPorAlma`, leída en cada llamada, y `perfilDeVozDeAlma` en los cinco caminos de síntesis de un alma;
 *   - `caracter-voz.js` contra un Voicebox falso: el PUT de cinco campos, el 409 con `base`, la verificación posterior y
 *     la restauración;
 *   - la API v2: `identidades` y `voz` con lista blanca, el guardado de las cuatro secciones y las rutas nuevas.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat204-'));
// Antes de cargar bot.js: el estado del bridge y las almas van a la carpeta temporal.
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(raiz, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });
for (const [clave, titulo] of [['alya', 'Alya'], ['dora', 'Dora']]) {
  fs.mkdirSync(path.join(raiz, 'almas', clave), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'almas', clave, 'alma.md'), `# ${titulo}\n\nUn alma de prueba.\n`);
}
// La config global de `leerVozPorAlma` (sin homeDir) sale de HOME/USERPROFILE.
const HOME = path.join(raiz, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const ajustes = require(path.join(MCP, 'lib', 'ajustes.js'));
const caracter = require(path.join(MCP, 'lib', 'caracter-voz.js'));

const archivo = (home) => path.join(home, '.claude', 'antigravity.json');
const escribir = (home, datos) => fs.writeFileSync(archivo(home), JSON.stringify(datos, null, 2));
const leer = (home) => JSON.parse(fs.readFileSync(archivo(home), 'utf8'));
function homeNuevo(datos) {
  const home = fs.mkdtempSync(path.join(raiz, 'h-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (datos !== undefined) escribir(home, datos);
  return home;
}
const ALMAS = ['alya', 'dora'];

const SETUP = {
  version: 3, status: 'configured', languages: ['es', 'en'], default_language: 'es',
  defaults: {
    es: { identity: { mode: 'neutral' }, audio: { profile: 'Priscilla', provider: 'omnivoice' } },
    en: { identity: { mode: 'soul', soul: 'alya' }, audio: { profile: 'Emily', provider: 'voicebox', engine: 'qwen', model_size: '1.7B' } }
  },
  fallbacks: { es: [{ profile: 'Priscilla', provider: 'voicebox', engine: 'qwen', model_size: '1.7B' }], en: [] }
};

// ── Un Voicebox falso para caracter-voz.js ──────────────────────────────────

function voiceboxFalso({ version = '0.5.0', perfiles, alPut = null, caido = false, putFalla = false } = {}) {
  const db = new Map(perfiles.map((p) => [p.id, { ...p }]));
  const puts = [];
  const resp = (status, cuerpo) => ({ status, body: cuerpo === undefined ? '' : JSON.stringify(cuerpo) });
  const pedir = async (url, { method = 'GET', body = null } = {}) => {
    if (caido) throw new Error('ECONNREFUSED');
    const ruta = new URL(url).pathname;
    if (ruta === '/' && method === 'GET') return version === null ? resp(200, { message: 'voicebox API' }) : resp(200, { message: 'voicebox API', version });
    if (ruta === '/health') return resp(200, { status: 'healthy' });
    if (ruta === '/profiles' && method === 'GET') return resp(200, [...db.values()]);
    const m = /^\/profiles\/([^/]+)$/.exec(ruta);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const p = db.get(id);
      if (!p) return resp(404, { detail: 'Profile not found' });
      // El detalle trae los conteos en 0, como la 0.5.0.
      if (method === 'GET') return resp(200, { ...p, sample_count: 0, generation_count: 0 });
      if (method === 'PUT') {
        puts.push(body);
        if (putFalla) return resp(400, { detail: 'rechazado' });
        for (const k of ['name', 'description', 'language', 'personality']) p[k] = body[k] === undefined ? (k === 'language' ? 'en' : null) : body[k];
        if (body.default_engine !== null && body.default_engine !== undefined) p.default_engine = body.default_engine || null;
        p.updated_at = `t${puts.length}`;
        if (alPut) alPut(p, puts.length);
        return resp(200, { ...p, sample_count: 0 });
      }
    }
    return resp(404, { detail: 'Not found' });
  };
  return { pedir, db, puts };
}

const MARIE = () => ({
  id: 'id-1', name: 'Marie', description: 'Suave.', language: 'es', avatar_path: null, effects_chain: null, voice_type: 'cloned',
  preset_engine: null, preset_voice_id: null, design_prompt: null, default_engine: null, personality: 'Cálida.',
  generation_count: 3, sample_count: 1, created_at: 'c', updated_at: 't0', campo_futuro: 'no se manda'
});
const ONO = () => ({ ...MARIE(), id: 'id-2', name: 'Ono Añá', default_engine: 'qwen', language: 'ja' });
const deps = (vb, extra = {}) => ({ url: 'http://vb', pedir: vb.pedir, guardarCache: (l) => { (extra.caches || []).push(l); }, log: () => {} });

async function main() {
  const bot = await importar('telegram-bridge/bot.js');
  const warnOriginal = console.warn;
  const logOriginal = console.log;
  console.warn = () => {};

  await group('S2: Probar una voz sin frase para su idioma', async () => {
    const r = await bot.probarVoz({ voz: 'Ono Anna', idioma: 'ja' });
    check('400 que lo dice, sin sintetizar', r.ok === false && r.codigo === 400 && /español y en inglés; esta voz es en ja/.test(r.error), JSON.stringify(r));
  });

  await group('núcleo: voz_por_alma', () => {
    const home = homeNuevo({ voz_por_perfil: { Marie: 'voicebox' } });
    const v = ajustes.leerAjustes({ homeDir: home, almas: ALMAS });
    check('voz trae las cinco claves', JSON.stringify(Object.keys(v.voz)) === JSON.stringify(ajustes.CLAVES_VOZ), Object.keys(v.voz).join(','));
    const g = (voz, version = ajustes.leerAjustes({ homeDir: home, almas: ALMAS }).versiones.voz) => ajustes.guardarAjustes({ voz: { versionSeccion: version, ...voz } }, { homeDir: home, almas: ALMAS });
    let r = g({ voz_por_alma: { alya: 'Marie' } });
    check('guarda la voz de un alma', r.ok === true && leer(home).voz_por_alma.alya === 'Marie', JSON.stringify(r));
    check('no toca voz_por_perfil', leer(home).voz_por_perfil.Marie === 'voicebox');
    r = g({ voz_por_alma: { alya: 'Marie', fantasma: 'Marie' } });
    check('un alma que no existe: 400 con su campo', r.ok === false && r.codigo === 400 && r.campo === 'voz.voz_por_alma.fantasma', JSON.stringify(r));
    r = g({ voz_por_alma: { alya: 'con\ncontrol' } });
    check('perfil mal formado: 400', r.codigo === 400 && r.campo === 'voz.voz_por_alma.alya', JSON.stringify(r));
    r = g({ voz_por_alma: { alya: 'x'.repeat(129) } });
    check('perfil de más de 128: 400', r.codigo === 400);
    r = g({ voz_por_alma: { alya: null, dora: 'Spica' } });
    check('una entrada null se quita', r.ok && JSON.stringify(leer(home).voz_por_alma) === '{"dora":"Spica"}', JSON.stringify(leer(home).voz_por_alma));
    r = g({ voz_por_alma: null });
    check('el mapa null borra la clave', r.ok && !('voz_por_alma' in leer(home)));

    // Un alma borrada: se avisa y no se toca.
    escribir(home, { voz_por_alma: { alya: 'Marie', borrada: 'Glados' } });
    const conBorrada = ajustes.leerAjustes({ homeDir: home, almas: ALMAS });
    check('al leer: aviso del alma que no existe', conBorrada.avisos.voz.some((a) => a.includes('"borrada"')), JSON.stringify(conBorrada.avisos.voz));
    check('al leer: la entrada sigue en voz (cruda)', conBorrada.voz.voz_por_alma.borrada === 'Glados');
    r = g({ voz_por_alma: { alya: 'Spica', borrada: 'Glados' } });
    check('guardar otra alma con la borrada igual: se conserva', r.ok && leer(home).voz_por_alma.borrada === 'Glados' && leer(home).voz_por_alma.alya === 'Spica', JSON.stringify(r));
    r = g({ voz_por_alma: { alya: 'Spica', borrada: 'Otra' } });
    check('cambiar la de un alma borrada: 400', r.codigo === 400 && r.campo === 'voz.voz_por_alma.borrada');
  });

  await group('núcleo: los dos tiempos de Voicebox', () => {
    const home = homeNuevo({});
    const version = () => ajustes.leerAjustes({ homeDir: home, almas: ALMAS }).versiones.voz;
    const g = (voz) => ajustes.guardarAjustes({ voz: { versionSeccion: version(), ...voz } }, { homeDir: home, almas: ALMAS });
    check('enteros no negativos: se guardan', g({ voicebox_idle_unload_minutes: 0, voicebox_idle_shutdown_minutes: 999 }).ok && leer(home).voicebox_idle_shutdown_minutes === 999);
    for (const malo of [-1, 1.5, '10', Infinity]) {
      const r = g({ voicebox_idle_unload_minutes: malo });
      check(`${JSON.stringify(malo)}: 400`, r.codigo === 400 && r.campo === 'voz.voicebox_idle_unload_minutes', JSON.stringify(r));
    }
    check('null borra la clave', g({ voicebox_idle_unload_minutes: null }).ok && !('voicebox_idle_unload_minutes' in leer(home)));
    escribir(home, { voicebox_idle_unload_minutes: -3, voicebox_idle_shutdown_minutes: 999 });
    const v = ajustes.leerAjustes({ homeDir: home, almas: ALMAS });
    check('un valor a mano que no valida: aviso, y la lectura no se rompe', v.ok && v.avisos.voz.some((a) => a.includes('voicebox_idle_unload_minutes')) && v.voz.voicebox_idle_shutdown_minutes === 999);
    const vb = require(path.join(MCP, 'voicebox-server.js'));
    const cfg = vb.aplicarClavesVoicebox({}, leer(home));
    check('el guardián lee el 999 escrito a mano', cfg.voiceboxIdleShutdownMinutes === 999);
  });

  await group('núcleo: hash y 409 de la sección voz', () => {
    const home = homeNuevo({ voice_setup: SETUP });
    const antes = ajustes.leerAjustes({ homeDir: home, almas: ALMAS }).versiones;
    const otro = JSON.parse(fs.readFileSync(archivo(home), 'utf8'));
    otro.voicebox_idle_unload_minutes = 5;
    escribir(home, otro);
    const despues = ajustes.leerAjustes({ homeDir: home, almas: ALMAS }).versiones;
    check('un tiempo escrito a mano cambia la versión de voz', antes.voz !== despues.voz);
    check('y no la de las otras secciones', antes.identidades === despues.identidades && antes.general === despues.general && antes.motores === despues.motores);
    const r = ajustes.guardarAjustes({ voz: { versionSeccion: antes.voz, voz_por_alma: { alya: 'Marie' } } }, { homeDir: home, almas: ALMAS });
    check('guardar con la versión vieja: 409 de voz', r.codigo === 409 && JSON.stringify(r.conflictos) === '["voz"]' && r.estado.ok);
    check('sin escribir', !('voz_por_alma' in leer(home)));
    const sinClaves = ajustes.versionesDe({ voice_setup: SETUP, voz_por_perfil: null });
    const conNull = ajustes.versionesDe({ voice_setup: SETUP, voz_por_alma: null, voicebox_idle_unload_minutes: null });
    check('una clave en null pesa igual que una que falta', sinClaves.voz === conNull.voz);
  });

  await group('leerVozPorAlma y perfilDeVozDeAlma: sin caché', () => {
    escribir(HOME, { voz_por_alma: { alya: 'Marie', MALO: 'x', dora: '' } });
    check('lee el mapa válido (no estricto)', JSON.stringify(ajustes.leerVozPorAlma()) === '{"alya":"Marie"}', JSON.stringify(ajustes.leerVozPorAlma()));
    check('alya suena con Marie', bot.perfilDeVozDeAlma('alya') === 'Marie');
    check('dora, sin entrada válida: el perfil de su nombre', bot.perfilDeVozDeAlma('dora') === 'Dora');
    escribir(HOME, { voz_por_alma: { alya: 'Spica' } });
    check('un cambio en el archivo vale para la llamada siguiente', bot.perfilDeVozDeAlma('alya') === 'Spica');
    fs.writeFileSync(archivo(HOME), '{ roto');
    check('archivo ilegible: el de su nombre', bot.perfilDeVozDeAlma('alya') === 'Alya');
    check('sin clave: null', bot.perfilDeVozDeAlma('') === null);
  });

  await group('los cinco caminos de síntesis de un alma', async () => {
    escribir(HOME, { voz_por_alma: { alya: 'Marie' } });
    const wav = path.join(raiz, 'a.wav');
    const pedidos = [];
    bot.usarEjecutoresDePrueba({ sintetizar: async (o) => { pedidos.push(o); fs.writeFileSync(wav, 'RIFF'); return { ok: true, wavPath: wav, perfil: o.voz }; } });

    // 1. escucharTarea
    const tareas = await importar('telegram-bridge/tareas.js');
    const t = tareas.crear({ carril: 'alma', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' }, pedido: 'hola' });
    tareas.actualizar(t.id, { estado: 'ok', resultado: 'Hola, soy Alya.' });
    const e = await bot.escucharTarea(t.id);
    check('escucharTarea: sintetiza con Marie', e.ok && pedidos.at(-1).voz === 'Marie', JSON.stringify(pedidos.at(-1)));
    check('la tarea sigue mostrándose con su nombre', tareas.obtener(t.id).sujeto.voz === 'Alya');

    // 2. escucharPrestado (en el servidor, con la clave de la tarea del nodo)
    const llamadas = [];
    const prestado = bot.escucharPrestado({
      rpc: async () => ({ ok: true, tarea: { sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' }, estado: 'ok', resultado: 'hola' } }),
      escuchar: async (o) => { llamadas.push(o); return { ok: true }; }
    });
    await prestado('nodo-1', 't1');
    check('escucharPrestado: resuelve Marie en el servidor', llamadas[0].voz === 'Marie', JSON.stringify(llamadas[0]));

    // 3. responderConVoz (Telegram), con task.clave
    const enviados = [];
    const ctx = { replyWithVoice: async () => { enviados.push('voz'); return { message_id: 77 }; }, replyWithAudio: async () => ({ message_id: 78 }), chat: { id: 1 }, me: { id: 42 } };
    const rv = await bot.responderConVoz(ctx, { clave: 'alya', voz: 'Alya' }, { respuesta: 'hola' });
    check('responderConVoz: sintetiza con Marie', rv && rv.ok !== false && pedidos.at(-1).voz === 'Marie', JSON.stringify({ rv, p: pedidos.at(-1) }));

    // 4. nucleo.prepararVoz
    let preparada = null;
    const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
    const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js');
    const nucleo = crearNucleoWeb({
      canal: crearCanalWeb(),
      bot: { almasDisponibles: () => [{ clave: 'alya', voz: 'Alya' }], agentesCasteables: () => [], perfilDeVozDeAlma: bot.perfilDeVozDeAlma, prepararVoz: async ({ voz }) => { preparada = voz; return { ok: true, perfil: voz }; } },
      almas: { rutas: require(path.join(MCP, 'almas', 'rutas.js')) }, workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({})
    });
    const pv = await nucleo.prepararVoz({ clave: 'alya' });
    check('prepararVoz: prepara Marie', pv.ok && preparada === 'Marie', JSON.stringify(pv));

    // 5. vozParaNodos: el nodo manda el nombre; con `reaccionable.alma`, el servidor resuelve el perfil.
    const sint = [];
    console.log = () => {};
    const narrar = bot.vozParaNodos({ telegram: { voz: async () => {} }, sintetizar: async (o) => { sint.push(o); fs.writeFileSync(wav, 'RIFF'); return { ok: true, wavPath: wav }; }, log: () => {} });
    await narrar({ nodo: 'n', nombre: 'n', texto: 'hola', voz: 'Alya', reaccionable: { alma: 'alya' } });
    await narrar({ nodo: 'n', nombre: 'n', texto: 'hola', voz: 'Priscilla', reaccionable: null });
    console.log = logOriginal;
    check('vozParaNodos: un alma suena con Marie', sint[0].voz === 'Marie', JSON.stringify(sint[0]));
    check('vozParaNodos: sin alma, la voz del nodo', sint[1].voz === 'Priscilla');

    // Sin entrada: como en 2.13.2, el perfil de su nombre.
    escribir(HOME, {});
    await bot.escucharTarea(t.id);
    check('sin voz_por_alma: suena con el perfil de su nombre', pedidos.at(-1).voz === 'Alya');
    bot.resetRuntimeState();
  });

  await group('caracter-voz: el PUT de cinco campos', async () => {
    const vb = voiceboxFalso({ perfiles: [MARIE(), ONO()] });
    const caches = [];
    const base = caracter.baseDe(MARIE());
    const r = await caracter.guardarCaracter({ nombre: 'marie', description: 'Nueva.', personality: 'Con\nsaltos.', base }, deps(vb, { caches }));
    check('ok, con el perfil proyectado', r.ok && r.perfil.description === 'Nueva.' && r.perfil.personality === 'Con\nsaltos.', JSON.stringify(r));
    check('el PUT lleva exactamente los cinco campos', JSON.stringify(Object.keys(vb.puts[0]).sort()) === JSON.stringify([...caracter.ESCRITOS].sort()), JSON.stringify(vb.puts[0]));
    check('el idioma y el nombre, copiados del GET', vb.puts[0].language === 'es' && vb.puts[0].name === 'Marie' && vb.puts[0].default_engine === null);
    check('un campo que no se conoce no se manda, y Voicebox lo conserva', !('campo_futuro' in vb.puts[0]) && vb.db.get('id-1').campo_futuro === 'no se manda');
    check('la caché en disco con la lista completa', caches.length === 1 && caches[0].length === 2);
    check('la respuesta no trae el id', !JSON.stringify(r).includes('id-1'));

    const ono = await caracter.guardarCaracter({ nombre: 'Ono Añá', description: 'x', personality: 'y', base: caracter.baseDe(ONO()) }, deps(vb));
    check('un nombre con espacio y tilde', ono.ok && vb.puts[1].name === 'Ono Añá' && vb.puts[1].default_engine === 'qwen', JSON.stringify(ono));

    const igual = await caracter.guardarCaracter({ nombre: 'Marie', description: 'Nueva.', personality: 'Con\nsaltos.', base: caracter.baseDe(vb.db.get('id-1')) }, deps(vb));
    check('sin cambios: no escribe', igual.ok && igual.sinCambios && vb.puts.length === 2);
  });

  await group('caracter-voz: 409, 400, 404 y 503', async () => {
    for (const k of caracter.ESCRITOS) {
      const vb = voiceboxFalso({ perfiles: [MARIE()] });
      const base = { ...caracter.baseDe(MARIE()), [k]: k === 'default_engine' ? 'qwen' : 'otro' };
      const r = await caracter.guardarCaracter({ nombre: 'Marie', description: 'a', personality: 'b', base }, deps(vb));
      check(`base distinta en ${k}: 409 con los actuales, sin escribir`, r.codigo === 409 && r.conflictos.includes(k) && r.actuales.language === 'es' && vb.puts.length === 0, JSON.stringify(r));
    }
    const vb = voiceboxFalso({ perfiles: [MARIE()] });
    const base = caracter.baseDe(MARIE());
    const malos = [
      { nombre: 'Marie', description: 'x'.repeat(501), personality: '', base },
      { nombre: 'Marie', description: '', personality: 'x'.repeat(2001), base },
      { nombre: 'Marie', description: 'a\u0007', personality: '', base },
      { nombre: 'Marie', description: '', personality: '', base: { ...base, voice_type: 'cloned' } },
      { nombre: '', description: '', personality: '', base },
      { nombre: 'Marie', description: null, personality: '', base }
    ];
    for (const p of malos) check(`400: ${JSON.stringify(p).slice(0, 60)}`, (await caracter.guardarCaracter(p, deps(vb))).codigo === 400);
    check('404 si la voz no existe', (await caracter.guardarCaracter({ nombre: 'Nadie', description: '', personality: '', base }, deps(vb))).codigo === 404);
    const apagado = await caracter.guardarCaracter({ nombre: 'Marie', description: '', personality: '', base }, deps(voiceboxFalso({ perfiles: [MARIE()], caido: true })));
    check('503 apagado', apagado.codigo === 503 && apagado.motivo === 'apagado', JSON.stringify(apagado));
    const otra = await caracter.guardarCaracter({ nombre: 'Marie', description: '', personality: '', base }, deps(voiceboxFalso({ perfiles: [MARIE()], version: '0.6.0' })));
    check('503 con otra versión', otra.codigo === 503 && otra.motivo === 'version' && /0\.6\.0/.test(otra.error), JSON.stringify(otra));
    const sinVersion = await caracter.guardarCaracter({ nombre: 'Marie', description: '', personality: '', base }, deps(voiceboxFalso({ perfiles: [MARIE()], version: null })));
    check('503 sin versión', sinVersion.codigo === 503 && sinVersion.motivo === 'version' && /No se pudo saber/.test(sinVersion.error));
    check('motivoSoloLectura: 0.5.3 escribe', caracter.motivoSoloLectura('0.5.3') === null && caracter.motivoSoloLectura('1.0.0') !== null);
    const rechazo = await caracter.guardarCaracter({ nombre: 'Marie', description: 'z', personality: 'z', base }, deps(voiceboxFalso({ perfiles: [MARIE()], putFalla: true })));
    check('Voicebox rechaza el PUT: 502 sin cambios', rechazo.codigo === 502 && rechazo.restauracion === 'sin cambios', JSON.stringify(rechazo));
  });

  await group('caracter-voz: la verificación posterior', async () => {
    const pedido = (b) => ({ nombre: 'Marie', description: 'Nueva.', personality: 'Otra.', base: b });
    // Cambia el idioma en el primer PUT: está en los cinco, se restaura.
    let vb = voiceboxFalso({ perfiles: [MARIE()], alPut: (p, n) => { if (n === 1) p.language = 'en'; } });
    let r = await caracter.guardarCaracter(pedido(caracter.baseDe(MARIE())), deps(vb));
    check('language cambiado: 502 «restaurado»', r.codigo === 502 && r.restauracion === 'restaurado' && r.diferencias.some((d) => d.campo === 'language'), JSON.stringify(r));
    check('el segundo PUT trae los valores de antes', vb.puts[1].description === 'Suave.' && vb.puts[1].language === 'es' && vb.db.get('id-1').language === 'es');

    // Cambia voice_type: el PUT no lo escribe, no se puede deshacer.
    vb = voiceboxFalso({ perfiles: [MARIE()], alPut: (p) => { p.voice_type = 'preset'; } });
    r = await caracter.guardarCaracter(pedido(caracter.baseDe(MARIE())), deps(vb));
    check('voice_type cambiado: «no restaurable», nunca «restaurado»', r.codigo === 502 && r.restauracion === 'no restaurable' && vb.puts.length === 1, JSON.stringify(r));

    // Pierde una muestra (solo la lista trae los conteos).
    vb = voiceboxFalso({ perfiles: [MARIE()], alPut: (p) => { p.sample_count = 0; } });
    r = await caracter.guardarCaracter(pedido(caracter.baseDe(MARIE())), deps(vb));
    check('una muestra menos en la lista: 502 «no restaurable»', r.codigo === 502 && r.restauracion === 'no restaurable' && r.diferencias.some((d) => d.campo === 'sample_count'), JSON.stringify(r));

    // Pone un default_engine que era null: se restaura con "".
    vb = voiceboxFalso({ perfiles: [MARIE()], alPut: (p, n) => { if (n === 1) p.default_engine = 'qwen'; } });
    r = await caracter.guardarCaracter(pedido(caracter.baseDe(MARIE())), deps(vb));
    check('default_engine de null a qwen: se restaura mandando ""', r.restauracion === 'restaurado' && vb.puts[1].default_engine === '' && vb.db.get('id-1').default_engine === null, JSON.stringify({ r, put: vb.puts[1] }));

    // El segundo PUT también falla.
    vb = voiceboxFalso({ perfiles: [MARIE()], alPut: (p) => { p.language = 'en'; } });
    r = await caracter.guardarCaracter(pedido(caracter.baseDe(MARIE())), deps(vb));
    check('si la restauración no deja todo igual: «no restaurado»', r.codigo === 502 && r.restauracion === 'no restaurado', JSON.stringify(r));

    // Un generation_count que sube no es una diferencia.
    vb = voiceboxFalso({ perfiles: [MARIE()], alPut: (p) => { p.generation_count += 1; } });
    r = await caracter.guardarCaracter(pedido(caracter.baseDe(MARIE())), deps(vb));
    check('generation_count que sube: ok', r.ok === true, JSON.stringify(r));
  });

  await group('API v2: identidades y voz con lista blanca', async () => {
    const v2 = await importar('telegram-bridge/web/v2/ajustes.js');
    const veneno = {
      ...SETUP,
      defaults: { ...SETUP.defaults, en: { identity: { mode: 'soul', soul: '../../etc' }, audio: { profile: 'Emily', provider: 'voicebox', engine: 'qwen', model_size: '1.7B', ruta: 'C:/x' } } },
      extra: 'C:/secreto'
    };
    const vista = {
      ok: true, ruta: 'C:/Users/x/.claude/antigravity.json',
      versiones: { identidades: 'a', voz: 'b', motores: 'c', general: 'd', sesiones: 'e' },
      cuentas: [{ cuenta: 'principal', configDir: '~/.claude' }, { cuenta: 'trabajo', configDir: '~/.claude-work' }],
      identidades: { principal: { nombre: 'Spica', emblema: '✦', color: 'cian', voz: { es: 'Spica', en: 'EN Spica', idioma: 'es' }, secreto: 1 }, trabajo: null },
      voz: { voice_setup: veneno, voz_por_perfil: { Marie: 'voicebox', Otra: 'x' }, voz_por_alma: { alya: 'Marie', '../x': 'y' }, voicebox_idle_unload_minutes: 10, voicebox_idle_shutdown_minutes: null },
      colores: { nombres: ['cian', 'magenta'], css: { cian: '#39c5cf' } },
      avisos: { identidades: [], voz: [], motores: ['no sale'] },
      general: {}, motores: {}, limites: {}
    };
    const p = v2.ajustesV2(vista);
    const json = JSON.stringify(p);
    check('sin configDir, ruta, css ni avisos de motores', !/configDir|claude-work|antigravity\.json|#39c5cf|no sale|secreto/.test(json), json.slice(0, 300));
    check('identidades: una fila por cuenta, solo el nombre', p.identidades.length === 2 && p.identidades[0].identidad.nombre === 'Spica' && p.identidades[1].identidad === null && !('secreto' in p.identidades[0].identidad));
    check('voice_setup: sin claves de más ni el identity.soul envenenado', !/\.\.\/|C:\/x|C:\/secreto/.test(JSON.stringify(p.voz.voice_setup)) && !('extra' in p.voz.voice_setup) && !('en' in p.voz.voice_setup.defaults), JSON.stringify(p.voz.voice_setup));
    check('voz_por_perfil y voz_por_alma: solo las entradas válidas', JSON.stringify(p.voz.voz_por_perfil) === '{"Marie":"voicebox"}' && JSON.stringify(p.voz.voz_por_alma) === '{"alya":"Marie"}');
    check('los tiempos', p.voz.voicebox_idle_unload_minutes === 10 && p.voz.voicebox_idle_shutdown_minutes === null);
    const pis = v2.ajustesV2({ ...vista, pisadoPorProyecto: [{ ruta: 'C:/proyecto/.claude/antigravity.json', claves: ['voice_setup', 'voicebox_idle_unload_minutes'] }] });
    check('S2: proyectoFija, dos booleanos y sin la ruta', JSON.stringify(pis.proyectoFija) === '{"voicebox_idle_unload_minutes":true,"voicebox_idle_shutdown_minutes":false}' && !/proyecto/.test(JSON.stringify(pis.proyectoFija)) && !('pisadoPorProyecto' in pis), JSON.stringify(pis.proyectoFija));
    check('S2: sin proyecto, los dos en false', JSON.stringify(p.proyectoFija) === '{"voicebox_idle_unload_minutes":false,"voicebox_idle_shutdown_minutes":false}');
    check('las versiones de v2 (FEAT-210: también imagenes), sin sesiones', JSON.stringify(Object.keys(p.versiones).sort()) === '["general","identidades","imagenes","motores","voz"]');
    const inval = v2.ajustesV2({ ...vista, voz: { voice_setup: SETUP }, avisos: { voz: ['voice_setup no valida (x); arreglalo a mano o reemplazalo desde acá'] } });
    check('un voice_setup que no valida no sale', inval.voz.voice_setup === null && inval.avisos.voz.length === 1);

    // Ida y vuelta: el voice_setup real proyectado pasa aplicarVoz y queda igual.
    const home = homeNuevo({ voice_setup: SETUP });
    const leido = ajustes.leerAjustes({ homeDir: home, almas: ALMAS });
    const proyectado = v2.ajustesV2(leido).voz.voice_setup;
    check('ida y vuelta: igual a lo guardado', ajustes.canonico(proyectado) === ajustes.canonico(SETUP), JSON.stringify(proyectado));
    const r = ajustes.guardarAjustes({ voz: { versionSeccion: leido.versiones.voz, voice_setup: proyectado } }, { homeDir: home, almas: ALMAS });
    check('mandado tal cual pasa aplicarVoz', r.ok === true, JSON.stringify(r));
  });

  await group('API v2: rutas', async () => {
    const home = homeNuevo({ voice_setup: SETUP, identidad_sesion: { principal: { nombre: 'Spica' } } });
    const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
    const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js');
    const vb = voiceboxFalso({ perfiles: [MARIE(), ONO()] });
    let lecturasDePerfiles = 0;
    const probados = [];
    const nucleo = crearNucleoWeb({
      canal: crearCanalWeb(),
      bot: {
        almasDisponibles: () => ALMAS.map((clave) => ({ clave, voz: clave })), agentesCasteables: () => [],
        probarVoz: async (a) => { probados.push(a); return { ok: true, audio: Buffer.from('RIFFwav'), perfil: 'Marie', proveedor: 'voicebox' }; }
      },
      almas: {}, workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({}),
      ajustes: {
        leer: () => ajustes.leerAjustes({ homeDir: home, almas: ALMAS }),
        guardar: (c, o) => ajustes.guardarAjustes(c, { ...o, homeDir: home, almas: ALMAS }),
        perfiles: async () => {
          lecturasDePerfiles += 1;
          const lista = JSON.parse((await vb.pedir('http://vb/profiles')).body);
          return { ok: true, voicebox: true, desdeCache: false, version: '0.5.0', perfiles: lista.map((p) => ({ nombre: p.name, idioma: 'es', tipo: p.voice_type, motor: p.default_engine, description: p.description, personality: p.personality, base: caracter.baseDe(p), avisos: [], id: p.id, ruta: 'C:/x' })) };
        },
        caracter: (c) => caracter.guardarCaracter(c, deps(vb)),
        validarVozPorPerfil: ajustes.validarVozPorPerfil
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
      const r = todas.find((x) => x.metodo === metodo && x.patron.test(ruta));
      return r ? r.fn({ p: [], cuerpo, url: new URL(`http://x${ruta}`) }) : { codigo: 404 };
    };

    const v = await llamar('GET', '/api/v2/ajustes');
    const g = await llamar('POST', '/api/v2/ajustes', { voz: { versionSeccion: v.versiones.voz, voz_por_alma: { alya: 'Marie' } } });
    check('POST voz.voz_por_alma: guardado', g.ok === true && g.guardado === true && g.voz.voz_por_alma.alya === 'Marie', JSON.stringify(g).slice(0, 300));
    const v2 = await llamar('GET', '/api/v2/ajustes');
    check('GET: el mapa y una versión de voz nueva', v2.voz.voz_por_alma.alya === 'Marie' && v2.versiones.voz !== v.versiones.voz && v2.versiones.general === v.versiones.general);
    const gi = await llamar('POST', '/api/v2/ajustes', { identidades: { versionSeccion: v2.versiones.identidades, cuentas: { principal: { nombre: 'Spica', emblema: '★', color: 'verde' } } } });
    check('POST identidades: guardado', gi.ok === true && leer(home).identidad_sesion.principal.emblema === '★', JSON.stringify(gi).slice(0, 300));
    const viejo = await llamar('POST', '/api/v2/ajustes', { voz: { versionSeccion: v.versiones.voz, voicebox_idle_unload_minutes: 3 } });
    check('409 de voz con el estado proyectado', viejo.codigo === 409 && viejo.estado && viejo.estado.voz.voz_por_alma.alya === 'Marie' && !/configDir/.test(JSON.stringify(viejo)));
    const negativo = await llamar('POST', '/api/v2/ajustes', { voz: { versionSeccion: v2.versiones.voz, voicebox_idle_unload_minutes: -1 } });
    check('-1: 400 con campo', negativo.codigo === 400 && negativo.campo === 'voz.voicebox_idle_unload_minutes', JSON.stringify(negativo));

    const perf = await llamar('GET', '/api/v2/voz/perfiles');
    check('GET voz/perfiles: forma y versión', perf.ok && perf.voicebox && perf.version === '0.5.0' && perf.perfiles.length === 2, JSON.stringify(perf).slice(0, 200));
    check('sin id ni ruta; con base', !/id-1|C:\/x/.test(JSON.stringify(perf)) && perf.perfiles[0].base.language === 'es' && JSON.stringify(Object.keys(perf.perfiles[0].base).sort()) === JSON.stringify([...caracter.ESCRITOS].sort()));

    const ono = perf.perfiles.find((p) => p.nombre === 'Ono Añá');
    const antes = lecturasDePerfiles;
    const c = await llamar('POST', '/api/v2/voz/caracter', { nombre: ono.nombre, description: 'Nueva.', personality: 'Otra.', base: ono.base });
    check('POST voz/caracter con espacio y tilde: ok', c.ok === true && c.perfil.nombre === 'Ono Añá' && c.perfil.description === 'Nueva.', JSON.stringify(c));
    await llamar('GET', '/api/v2/voz/perfiles');
    check('invalidarPerfiles: la lectura siguiente va al núcleo', lecturasDePerfiles === antes + 1);
    const c409 = await llamar('POST', '/api/v2/voz/caracter', { nombre: ono.nombre, description: 'a', personality: 'b', base: ono.base });
    check('POST voz/caracter con base vieja: 409 con actuales', c409.codigo === 409 && c409.actuales.description === 'Nueva.' && c409.conflictos.includes('description'), JSON.stringify(c409));

    const audio = await llamar('POST', '/api/v2/voz:probar', { voz: 'Ono Anna', idioma: 'ja' });
    check('S2: voz:probar pasa el idioma del perfil tal cual', probados.length === 1 && probados[0].idioma === 'ja', JSON.stringify(probados));
    check('POST voz:probar: el WAV, sin cabeceras x-lagrange', Buffer.isBuffer(audio.binario) && audio.tipo === 'audio/wav' && !('cabeceras' in audio));
    const sinVoz = await llamar('POST', '/api/v2/voz:probar', { voz: '' });
    check('voz:probar sin voz: 400', sinVoz.codigo === 400 && sinVoz.ok === false);

    const { perfilesVozV2 } = await importar('telegram-bridge/web/v2/ajustes.js');
    const caido = await perfilesVozV2({ perfilesAjustes: async () => ({ ok: false, codigo: 503, error: 'x' }) });
    check('voz/perfiles si el núcleo falla: 503', caido.codigo === 503 && caido.ok === false);
  });

  console.warn = warnOriginal;
  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
