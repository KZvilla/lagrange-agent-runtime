/**
 * FEAT-201 F2 S0 — Lo que la API v2 suma para Claude remoto en la terminal: la ruta y el wsId de cada sesión, el
 * diálogo «Nueva sesión» (`/claude/proyectos`), el log, detener todas, la configuración (`/claude/config`), las
 * formas `parada` y `purga`, los errores por lista blanca y Claude en la terminal (`/claude/local`, que no lanza
 * nada). Cada respuesta nueva se valida contra contrato-v2.json, con un caso inválido por agregado.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');
const ajustesLib = require('../mcp-server/lib/ajustes.js');

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2s0-'));

const WS = [
  { id: 'aaaaaaaa', path: path.join(dir, 'uno'), name: 'uno', displayName: 'uno', trustedAccounts: ['principal'] },
  { id: 'bbbbbbbb', path: path.join(dir, 'dos'), name: 'dos', displayName: 'dos', trustedAccounts: ['principal', 'trabajo'] },
  { id: 'cccccccc', path: path.join(dir, 'tres'), name: 'tres', displayName: 'tres', trustedAccounts: ['principal', 'trabajo'], preferredAccount: 'trabajo' },
  { id: 'dddddddd', path: path.join(dir, 'manual'), name: 'manual', displayName: 'manual', trustedAccounts: [], manual: true }
];
const CUENTAS = [
  { account: 'principal', label: 'Spica', configDir: null },
  { account: 'trabajo', label: 'Epikouros', configDir: path.join(dir, '.claude-work') }
];
const SECRETO_RESUELTO = 'valor-resuelto-de-keepass-123';

function homeNuevo(contenido) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'f2s0-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify(contenido, null, 2));
  return home;
}

async function main() {
  const esq = await importar('telegram-bridge/web/v2/esquema.js');
  const lect = await importar('telegram-bridge/web/v2/lecturas.js');
  const mut = await importar('telegram-bridge/web/v2/mutaciones.js');
  const { crearAtenderV2 } = await importar('telegram-bridge/web/v2/rutas.js');
  const web = await importar('telegram-bridge/sesiones-claude-web.js');
  const launcher = await importar('telegram-bridge/claude-launcher.js');
  const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
  const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js');
  const tareasMod = await importar('telegram-bridge/tareas.js');
  const contrato = esq.cargarContrato();
  const valida = (n, v) => esq.validar(contrato, n, v);

  // ---------------------------------------------------------------- armado
  const espias = { lanzar: 0, leerLog: [], logClaude: [] };
  let activas = [{ key: 'trabajo:bbbbbbbb', account: 'trabajo', pid: 7, projectPath: WS[1].path, sessionName: 'Mobile-dos', startedAt: '2026-11-18T10:00:00.000Z' }];
  let inspeccionFalla = false;
  const depsBase = {
    workspaces: () => WS,
    config: () => ({ sesionesClaude: { cuentaPorDefecto: null, maxSesiones: 3 } }),
    cuentas: () => CUENTAS,
    activas: () => activas,
    lanzar: (o) => { espias.lanzar++; return { success: true, key: 'principal:aaaaaaaa', account: 'principal', pid: 42, projectPath: o.workspacePath, sessionName: 'Mobile-uno' }; },
    detener: (o) => ({ success: true, stopped: o.all ? [{ key: 'principal:aaaaaaaa', account: 'principal', pid: 42, projectPath: WS[0].path }, { key: 'trabajo:bbbbbbbb', account: 'trabajo', pid: 43, projectPath: WS[1].path }] : [{ key: o.key, account: 'principal', pid: 42, projectPath: WS[0].path }] }),
    inspeccionar: (p) => { if (inspeccionFalla) throw new Error('git roto'); return p === WS[0].path ? { cleanWorktrees: [{ branch: 'a' }], dirtyWorktrees: [{ branch: 'b', reason: '1 commit' }] } : { cleanWorktrees: [], dirtyWorktrees: [] }; },
    purgar: () => ({ removedCount: 2, preservedWorktrees: [{ branch: 'b', reason: 'cambios' }] }),
    leerLog: (key, n) => { espias.leerLog.push([key, n]); return key === 'trabajo:bbbbbbbb' ? ['hola', 'clave sk-ant-abcdefghijklmnopqrstuv', `y ${SECRETO_RESUELTO}`] : null; },
    pidVivo: () => true,
    esperar: async () => {},
    redactar: (t) => t.replace(/sk-ant-\w+/g, '[REDACTED]')
  };
  const sc = web.crearSesionesClaudeWeb(depsBase);
  const home = homeNuevo({ x_otra: 1, motores: { cuentas: { trabajo: { configDir: 'C:/x/.claude-work' } } } });
  const ajustes = {
    leer: () => ajustesLib.leerAjustes({ homeDir: home }),
    guardar: (p, o) => ajustesLib.guardarAjustes(p, { ...o, homeDir: home })
  };
  const nucleo = crearNucleoWeb({
    canal: crearCanalWeb(), bot: { almasDisponibles: () => [], agentesCasteables: () => [] }, almas: {}, tareas: tareasMod.crearRegistroTareas ? tareasMod.crearRegistroTareas() : {},
    workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({}), estadoDaemon: () => ({}),
    estadoAgente: () => ({}), nombreAgenteValido: () => true, claude: sc, ajustes
  });
  const logOriginal = nucleo.logClaude.bind(nucleo);
  nucleo.logClaude = (key, n) => { espias.logClaude.push(n); return logOriginal(key, n); };
  const redactarV2 = (t) => t.split(SECRETO_RESUELTO).join('[REDACTED]');
  const rutas = [
    ...lect.rutasLecturaV2({ nucleo, estadoDeCarriles: () => [], recorte: tareasMod.RECORTE, arranque: 'arr', redactar: redactarV2 }),
    ...mut.rutasMutacionV2({ nucleo, cola: {}, ctx: {}, chatTerminal: 'web:terminal', registro: { obtener: () => null }, idem: {}, recorte: tareasMod.RECORTE, redactar: redactarV2 })
  ];
  const llamar = async (metodo, ruta, cuerpo = {}) => {
    const url = new URL(`http://x${ruta}`);
    const coinciden = rutas.filter((x) => x.patron.test(url.pathname));
    const r = coinciden.find((x) => x.metodo === metodo);
    if (!r) return { sinRuta: true, coinciden: coinciden.length };
    const p = r.patron.exec(url.pathname).slice(1).filter((x) => x !== undefined).map(decodeURIComponent);
    return r.fn({ p, url, cuerpo });
  };
  const cuerpoDe = ({ codigo, ...datos }) => datos;

  // ---------------------------------------------------------------- contrato
  await group('F2 S0 · el contrato', () => {
    check('sigue en 2.0', contrato.version === '2.0');
    for (const n of ['proyectoClaude', 'proyectosClaude', 'parada', 'purga', 'logClaude', 'configClaude', 'claudeLocal', 'errorClaude']) {
      check(`${n} es un agregado cerrado`, contrato.agregados[n]?.additionalProperties === false);
    }
    check('sesionRemota suma ruta y wsId opcionales', Boolean(contrato.agregados.sesionRemota.properties.ruta) && !contrato.agregados.sesionRemota.required.includes('ruta'));
    check('directorios es un mapa abierto', contrato.agregados.configClaude.properties.sesiones.properties.directorios.additionalProperties === undefined);
  });

  // ---------------------------------------------------------------- sesiones
  await group('F2 S0 · sesiones con ruta y wsId', async () => {
    const r = await llamar('GET', '/api/v2/claude/sesiones');
    const s = r.sesiones[0];
    check('la sesión trae su ruta y su wsId', s.ruta === WS[1].path && s.wsId === 'bbbbbbbb', JSON.stringify(s));
    check('valida como sesionRemota', valida('sesionRemota', s).length === 0, valida('sesionRemota', s).join('; '));
    const larga = lect.sesionRemotaV2({ key: 'k', ruta: `C:\\${'x'.repeat(1100)}`, wsId: 'nohex!!!' });
    check('una ruta de más de 1024 sale null (no recortada), y un wsId raro también', larga.ruta === null && larga.wsId === null);
    check('inválido: sesionRemota con una ruta de 2000', valida('sesionRemota', { ...s, ruta: 'x'.repeat(2000) }).length > 0);
    // v1: lo mismo que antes de extraer proyectos(), con la única adición de `ruta` en la sesión.
    const esperado = {
      ok: true,
      cuentas: [{ cuenta: 'principal', etiqueta: 'Spica' }, { cuenta: 'trabajo', etiqueta: 'Epikouros' }],
      cuentaPorDefecto: null, maxSesiones: 3,
      proyectos: WS.map((w) => ({ id: w.id, nombre: w.displayName, ruta: w.path, cuentas: w.trustedAccounts, cuentaSugerida: w.preferredAccount || w.trustedAccounts[0] || null, modo: null })),
      sesiones: [{ key: 'trabajo:bbbbbbbb', cuenta: 'trabajo', proyecto: 'dos', ruta: WS[1].path, wsId: 'bbbbbbbb', sessionName: 'Mobile-dos', pid: 7, modo: null, desde: '2026-11-18T10:00:00.000Z', url: null }]
    };
    check('v1: vista() igual a la de antes más la ruta (comparación entera)', JSON.stringify(sc.vista()) === JSON.stringify(esperado), JSON.stringify(sc.vista()));
  });

  await group('F2 S0 · proyectos', async () => {
    espias.leerLog.length = 0;
    const r = await llamar('GET', '/api/v2/claude/proyectos');
    check('valida como proyectosClaude', valida('proyectosClaude', cuerpoDe(r)).length === 0, valida('proyectosClaude', cuerpoDe(r)).join('; '));
    check('no trae sesiones ni lee logs', !('sesiones' in r) && espias.leerLog.length === 0);
    check('cuentas con etiqueta', r.cuentas[1].etiqueta === 'Epikouros' && r.maxSesiones === 3);
    const v1 = await nucleo.proyectosClaude();
    check('equivalencia con nucleo.proyectosClaude', JSON.stringify(v1.proyectos.map((p) => p.id)) === JSON.stringify(r.proyectos.map((p) => p.id)));
    check('inválido: un proyecto con una clave de más', valida('proyectoClaude', { ...r.proyectos[0], extra: 1 }).length > 0);
    check('inválido: proyectosClaude con una clave de más', valida('proyectosClaude', { ...cuerpoDe(r), extra: 1 }).length > 0);
  });

  // ---------------------------------------------------------------- log
  await group('F2 S0 · log', async () => {
    espias.leerLog.length = 0;
    const malo = await llamar('GET', '/api/v2/claude/sesiones/..%2Fx/log');
    check('una key inválida → 400 sin leer', malo.codigo === 400 && espias.leerLog.length === 0);
    const r = await llamar('GET', '/api/v2/claude/sesiones/trabajo%3Abbbbbbbb/log');
    check('sin n: el núcleo recibe 300', espias.logClaude.at(-1) === 300 && espias.leerLog.at(-1)[1] === 300);
    await llamar('GET', '/api/v2/claude/sesiones/trabajo:bbbbbbbb/log?n=17');
    check('n fuera de la lista: 300; n=100 pasa', espias.logClaude.at(-1) === 300 && (await llamar('GET', '/api/v2/claude/sesiones/trabajo:bbbbbbbb/log?n=100'), espias.logClaude.at(-1) === 100));
    check('v1 sigue cayendo a 30', (sc.log('trabajo:bbbbbbbb', 'x'), espias.leerLog.at(-1)[1] === 30));
    check('redactado: sk-… (v1) y el valor resuelto (v2)', !r.contenido.includes('sk-ant-') && !r.contenido.includes(SECRETO_RESUELTO) && r.contenido.includes('hola'));
    check('valida como logClaude', valida('logClaude', cuerpoDe(r)).length === 0);
    const sin = await llamar('GET', '/api/v2/claude/sesiones/principal:aaaaaaaa/log');
    check('sin log: contenido null y aviso', sin.contenido === null && sin.aviso && valida('logClaude', cuerpoDe(sin)).length === 0);
    check('inválido: logClaude con contenido numérico', valida('logClaude', { ok: true, contenido: 3 }).length > 0);
  });

  // ---------------------------------------------------------------- detener y purgar
  await group('F2 S0 · detener y purgar', async () => {
    check('la colección y la sesión no chocan', (await llamar('DELETE', '/api/v2/claude/sesiones')).detenidas.length === 2);
    const una = await llamar('DELETE', '/api/v2/claude/sesiones/principal%3Aaaaaaaaa');
    check('detener una: forma parada sin pid', una.detenidas.length === 1 && !('pid' in una.detenidas[0]) && valida('parada', cuerpoDe(una)).length === 0, valida('parada', cuerpoDe(una)).join('; '));
    check('conCambios con rama y motivo; limpios contados', una.proyectos[0].limpios === 1 && una.proyectos[0].conCambios[0].motivo === '1 commit');
    inspeccionFalla = true;
    const fallida = await llamar('DELETE', '/api/v2/claude/sesiones/principal:aaaaaaaa');
    inspeccionFalla = false;
    check('si no se pudo inspeccionar: inspeccionFallida', fallida.inspeccionFallida[0] === 'uno' && fallida.proyectos.length === 0 && valida('parada', cuerpoDe(fallida)).length === 0);
    const p = await llamar('POST', '/api/v2/claude:purgar', { wsId: 'aaaaaaaa' });
    check('purgar: forma purga', p.borrados === 2 && p.conservados[0].rama === 'b' && valida('purga', cuerpoDe(p)).length === 0);
    check('inválido: parada con pid', valida('parada', { ...cuerpoDe(una), detenidas: [{ ...una.detenidas[0], pid: 1 }] }).length > 0);
    check('inválido: purga con borrados negativos', valida('purga', { ok: true, proyecto: 'x', borrados: -1, conservados: [] }).length > 0);
  });

  // ---------------------------------------------------------------- lanzar
  await group('F2 S0 · lanzar con sus errores', async () => {
    const amb = await llamar('POST', '/api/v2/claude/sesiones', { wsId: 'bbbbbbbb' });
    check('409 elegirCuenta con cuentas, valida como errorClaude', amb.codigo === 409 && amb.elegirCuenta && amb.cuentas.length === 2 && valida('errorClaude', amb).length === 0);
    const bien = await llamar('POST', '/api/v2/claude/sesiones', { wsId: 'aaaaaaaa' });
    check('la sesión sale como sesionRemota (sin pid ni sessionName)', bien.ok && !('pid' in bien.sesion) && valida('sesionRemota', bien.sesion).length === 0, JSON.stringify(bien));
    const e502 = mut.errorClaudeV2({ codigo: 502, error: 'murió', log: `sk-ant-abcdefghijklmnopqrstuv ${SECRETO_RESUELTO}`, pid: 3, otro: 'x' }, { redactar: (t) => redactarV2(t.replace(/sk-ant-\w+/g, '[REDACTED]')) });
    check('502: log redactado y nada fuera de la lista blanca', !e502.log.includes(SECRETO_RESUELTO) && !('pid' in e502) && !('otro' in e502) && valida('errorClaude', e502).length === 0);
    check('502 con log null', valida('errorClaude', mut.errorClaudeV2({ codigo: 502, error: 'x', log: null })).length === 0);
    check('inválido: errorClaude con ok true', valida('errorClaude', { ok: true, error: 'x' }).length > 0);
  });

  // ---------------------------------------------------------------- local
  await group('F2 S0 · Claude en la terminal (/claude/local)', async () => {
    const antes = espias.lanzar;
    const activasAntes = JSON.stringify(activas);
    const uno = await llamar('POST', '/api/v2/claude/local', { wsId: 'aaaaaaaa' });
    check('una sola confiable: esa, con configDir null (la principal por defecto)', uno.ok && uno.cuenta === 'principal' && uno.configDir === null && uno.ruta === WS[0].path && valida('claudeLocal', cuerpoDe(uno)).length === 0);
    const fija = await llamar('POST', '/api/v2/claude/local', { wsId: 'cccccccc' });
    check('con preferredAccount: esa, con su configDir', fija.cuenta === 'trabajo' && fija.configDir === CUENTAS[1].configDir);
    check('varias sin elegir → 409 elegirCuenta', (await llamar('POST', '/api/v2/claude/local', { wsId: 'bbbbbbbb' })).codigo === 409);
    check('elegida y confiable → esa', (await llamar('POST', '/api/v2/claude/local', { wsId: 'bbbbbbbb', cuenta: 'trabajo' })).cuenta === 'trabajo');
    check('una cuenta que no confía → 400', (await llamar('POST', '/api/v2/claude/local', { wsId: 'aaaaaaaa', cuenta: 'trabajo' })).codigo === 400);
    const manual = await llamar('POST', '/api/v2/claude/local', { wsId: 'dddddddd' });
    check('carpeta manual sin confianza → 400', manual.codigo === 400 && /ninguna cuenta/.test(manual.error));
    check('un proyecto que no está → 404; wsId inválido → 400', (await llamar('POST', '/api/v2/claude/local', { wsId: 'ffffffff' })).codigo === 404 && (await llamar('POST', '/api/v2/claude/local', { wsId: '../x' })).codigo === 400);
    check('no lanza ni registra nada', espias.lanzar === antes && JSON.stringify(activas) === activasAntes);
    check('GET /claude/sesiones da lo mismo', (await llamar('GET', '/api/v2/claude/sesiones')).sesiones.length === 1);
    check('inválido: claudeLocal sin configDir', valida('claudeLocal', { ok: true, ruta: 'x', cuenta: 'p' }).length > 0);
    // Un proyecto oculto no está en la allowlist (getProjectAllowlist lo saca): para local es como uno que no existe.
    const ocultos = new Set(['bbbbbbbb']);
    const scOculto = web.crearSesionesClaudeWeb({ ...depsBase, workspaces: () => WS.filter((w) => !ocultos.has(w.id)) });
    check('un proyecto oculto → 404', scOculto.local({ wsId: 'bbbbbbbb', cuenta: 'principal' }).codigo === 404);
    // El daemon con su propio CLAUDE_CONFIG_DIR: la principal lo trae, como una sesión desacoplada.
    const conDir = path.join(dir, '.claude-daemon');
    const cuentasAlt = launcher.getConfiguredClaudeAccounts({ config: { motores: { cuentas: {} } }, homeDir: dir, env: { CLAUDE_CONFIG_DIR: conDir } });
    const scAlt = web.crearSesionesClaudeWeb({ ...depsBase, cuentas: () => cuentasAlt });
    const alt = scAlt.local({ wsId: 'aaaaaaaa' });
    check('principal con el CLAUDE_CONFIG_DIR del daemon: ese configDir', alt.ok && alt.cuenta === 'principal' && alt.configDir === conDir && cuentasAlt[0].configDir === conDir, JSON.stringify(alt));
  });

  // ---------------------------------------------------------------- config
  await group('F2 S0 · configuración', async () => {
    const g = await llamar('GET', '/api/v2/claude/config');
    check('GET valida como configClaude', valida('configClaude', cuerpoDe(g)).length === 0, valida('configClaude', cuerpoDe(g)).join('; '));
    check('sin configDir ni otras secciones', !JSON.stringify(g).includes('configDir') && !('voz' in g) && g.cuentas.some((c) => c.cuenta === 'trabajo'));
    check('otra clave arriba → 400', (await llamar('POST', '/api/v2/claude/config', { version: g.version, sesiones: {}, voz: {} })).codigo === 400);
    check('versionSeccion adentro → 400 (no salta el 409)', (await llamar('POST', '/api/v2/claude/config', { version: 'vieja', sesiones: { versionSeccion: g.version } })).codigo === 400);
    const rel = await llamar('POST', '/api/v2/claude/config', { version: g.version, sesiones: { directorios: { relativa: {} } } });
    check('una ruta relativa → 400 con campo', rel.codigo === 400 && rel.campo === 'sesiones.directorios' && valida('errorClaude', rel).length === 0, JSON.stringify(rel));
    const vieja = await llamar('POST', '/api/v2/claude/config', { version: '0000000000000000', sesiones: { max_sesiones: 4 } });
    check('versión vieja → 409 con estado (forma del GET), sin conflictos', vieja.codigo === 409 && vieja.estado.version === g.version && !('conflictos' in vieja) && valida('errorClaude', vieja).length === 0, JSON.stringify(vieja).slice(0, 300));
    const absoluta = path.join(dir, 'agregada');
    const bien = await llamar('POST', '/api/v2/claude/config', { version: g.version, sesiones: { max_sesiones: 4, directorios: { [absoluta]: { modo: 'worktree' } }, ocultos: [] } });
    check('bueno: valida como configClaude, sin guardado', bien.ok && bien.sesiones.max_sesiones === 4 && !('guardado' in bien) && valida('configClaude', cuerpoDe(bien)).length === 0, JSON.stringify(bien).slice(0, 300));
    const d = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'antigravity.json'), 'utf8'));
    check('escribe solo sesiones_claude', d.x_otra === 1 && d.sesiones_claude.max_sesiones === 4 && d.motores.cuentas.trabajo.configDir === 'C:/x/.claude-work');
    check('inválido: configClaude sin version', valida('configClaude', { ...cuerpoDe(bien), version: undefined }).length > 0);
  });

  // ---------------------------------------------------------------- la puerta de v2
  await group('F2 S0 · las rutas nuevas heredan la puerta de v2', async () => {
    const TOKEN = 'a'.repeat(48);
    const atender = crearAtenderV2({ token: TOKEN, tokenCoincide: (a, b) => a === b, capacidades: () => ({ ok: true }), rutasExtra: rutas });
    const pedir = async (metodo, ruta, headers = {}, { tailnet = false } = {}) => {
      const req = Readable.from([]);
      req.method = metodo; req.headers = headers; req.socket = { remotePort: 1 };
      let out;
      await atender(req, new URL(`http://127.0.0.1${ruta}`), { json: (status, body) => { out = { status, body }; }, esTailnet: tailnet });
      return out;
    };
    const bearer = { authorization: `Bearer ${TOKEN}` };
    for (const [m, r] of [['GET', '/api/v2/claude/proyectos'], ['GET', '/api/v2/claude/config'], ['GET', '/api/v2/claude/sesiones/trabajo:bbbbbbbb/log'], ['DELETE', '/api/v2/claude/sesiones'],
      ['POST', '/api/v2/claude/local'], ['POST', '/api/v2/claude/config'], ['POST', '/api/v2/claude/sesiones'], ['POST', '/api/v2/claude:purgar']]) {
      check(`${m} ${r}: sin Bearer → 401`, (await pedir(m, r)).status === 401);
      check(`${m} ${r}: con cookie → 403`, (await pedir(m, r, { ...bearer, cookie: 'x=1' })).status === 403);
      check(`${m} ${r}: con Origin → 403`, (await pedir(m, r, { ...bearer, origin: 'http://x' })).status === 403);
      check(`${m} ${r}: orquestador → 403`, (await pedir(m, r, { ...bearer, 'x-lagrange-orquestador': '1' })).status === 403);
      check(`${m} ${r}: tailnet → 404`, (await pedir(m, r, bearer, { tailnet: true })).status === 404);
    }
    const ok = await pedir('GET', '/api/v2/claude/sesiones/trabajo%3Abbbbbbbb/log', bearer);
    check('con Bearer y la key codificada → 200', ok.status === 200 && typeof ok.body.contenido === 'string');
  });

  // ---------------------------------------------------------------- fuente
  await group('F2 S0 · bot.js pasa redactarV2 a las dos fábricas', () => {
    const bot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8');
    const i = bot.indexOf('...rutasLecturaV2({');
    const tramo = bot.slice(i, bot.indexOf('];', i));
    check('rutasLecturaV2 y rutasMutacionV2 reciben redactar: redactarV2', (tramo.match(/redactar: redactarV2/g) || []).length === 2);
  });
}

main().then(() => report()).catch((err) => { console.error(err); process.exit(1); });
