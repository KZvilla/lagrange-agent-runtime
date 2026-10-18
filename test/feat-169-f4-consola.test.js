/**
 * FEAT-169 F4 — Las sesiones /claude desde la consola: el módulo de la web
 * (lanzar, detener, purgar, log) con dependencias falsas, la sección
 * `sesiones` de Ajustes, y que las rutas sean locales y vedadas al orquestador.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat169f4-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(dir, 'datos');
const TOKEN = 'a'.repeat(48);
const TOKEN_ORQ = 'b'.repeat(48);

const ajustes = require('../mcp-server/lib/ajustes.js');

function homeNuevo(contenido) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat169f4-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify(contenido, null, 2));
  return home;
}
const leer = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'antigravity.json'), 'utf8'));

const WS = [
  { id: 'aaaaaaaa', path: path.join(dir, 'uno'), name: 'uno', displayName: 'uno', trustedAccounts: ['principal'] },
  { id: 'bbbbbbbb', path: path.join(dir, 'dos'), name: 'dos', displayName: 'dos', trustedAccounts: ['principal', 'trabajo'] },
  { id: 'cccccccc', path: path.join(dir, 'tres'), name: 'tres', displayName: 'tres', trustedAccounts: ['principal', 'trabajo'], preferredAccount: 'trabajo' }
];
const CUENTAS = [{ account: 'principal', label: 'Spica' }, { account: 'trabajo', label: 'Epikouros' }];

(async () => {
  const web = await import('../telegram-bridge/sesiones-claude-web.js');
  const launcher = await import('../telegram-bridge/claude-launcher.js');

  function armar({ lanzar, vivo = true, activas = [], log = {} } = {}) {
    const llamadas = { lanzar: [], detener: [], purgar: [] };
    const sc = web.crearSesionesClaudeWeb({
      workspaces: () => WS,
      config: () => ({ sesionesClaude: { cuentaPorDefecto: 'trabajo', maxSesiones: 4 } }),
      cuentas: () => CUENTAS,
      activas: () => activas,
      lanzar: (o) => { llamadas.lanzar.push(o); return lanzar ? lanzar(o) : { success: true, key: `${o.account || 'principal'}:aaaaaaaa`, account: o.account || 'principal', pid: 42, projectPath: o.workspacePath, sessionName: 'Mobile-uno' }; },
      detener: (o) => { llamadas.detener.push(o); return { success: true, stopped: [{ key: 'principal:aaaaaaaa', account: 'principal', pid: 42, projectPath: WS[0].path }, { key: 'trabajo:bbbbbbbb', account: 'trabajo', pid: 43, projectPath: WS[1].path }] }; },
      inspeccionar: (p) => (p === WS[0].path ? { cleanWorktrees: [{ branch: 'a' }, { branch: 'b' }], dirtyWorktrees: [] } : { cleanWorktrees: [], dirtyWorktrees: [{ branch: 'c', reason: '1 commit' }] }),
      purgar: (p) => { llamadas.purgar.push(p); return { removedCount: 2, preservedWorktrees: [] }; },
      leerLog: (key) => (key in log ? log[key] : null),
      pidVivo: () => vivo,
      esperar: async () => {},
      redactar: (t) => t.replace(/sk-\w+/g, '[redactado]')
    });
    return { sc, llamadas };
  }

  await group('vista', () => {
    const { sc } = armar({ activas: [{ key: 'trabajo:bbbbbbbb', account: 'trabajo', pid: 7, projectPath: WS[1].path, sessionName: 'Mobile-dos', startedAt: 'x' }],
      log: { 'trabajo:bbbbbbbb': ['arrancando', 'https://claude.ai/code?environment=env_viejo', 'https://claude.ai/code?environment=env_Nuevo_1'] } });
    const v = sc.vista();
    check('cuentas con apodo', v.cuentas.length === 2 && v.cuentas[1].etiqueta === 'Epikouros');
    check('tope y cuenta por defecto de la config', v.maxSesiones === 4 && v.cuentaPorDefecto === 'trabajo');
    check('cuenta sugerida: la única confiable, la por defecto, o la fija', v.proyectos[0].cuentaSugerida === 'principal' && v.proyectos[1].cuentaSugerida === 'trabajo' && v.proyectos[2].cuentaSugerida === 'trabajo');
    const s = v.sesiones[0];
    check('la sesión con su proyecto y wsId', s.proyecto === 'dos' && s.wsId === 'bbbbbbbb' && s.cuenta === 'trabajo');
    check('el enlace: el último del log', s.url === 'https://claude.ai/code?environment=env_Nuevo_1', s.url);
  });

  await group('lanzar', async () => {
    let { sc, llamadas } = armar();
    check('wsId inválido → 400 sin lanzar', (await sc.lanzar({ wsId: '../x' })).codigo === 400 && !llamadas.lanzar.length);
    check('proyecto que ya no está → 404', (await sc.lanzar({ wsId: 'ffffffff' })).codigo === 404);
    const amb = await sc.lanzar({ wsId: 'bbbbbbbb' });
    check('varias confiables sin cuenta → 409 elegirCuenta', amb.codigo === 409 && amb.elegirCuenta === true && amb.cuentas.length === 2 && !llamadas.lanzar.length);
    check('cuenta no confiable → 400 sin lanzar', (await sc.lanzar({ wsId: 'aaaaaaaa', cuenta: 'trabajo' })).codigo === 400 && !llamadas.lanzar.length);
    check('cuenta desconocida → 400', (await sc.lanzar({ wsId: 'aaaaaaaa', cuenta: 'nadie' })).codigo === 400);
    const ok = await sc.lanzar({ wsId: 'bbbbbbbb', cuenta: 'trabajo' });
    check('con cuenta: lanza con ella, la ruta del workspace, las cuentas y la config', ok.ok && llamadas.lanzar[0].account === 'trabajo' && llamadas.lanzar[0].workspacePath === WS[1].path && llamadas.lanzar[0].config && llamadas.lanzar[0].accounts === CUENTAS);
    const fija = await sc.lanzar({ wsId: 'cccccccc' });
    check('con cuenta fija, sin preguntar (la resuelve el launcher)', fija.ok && llamadas.lanzar[1].account === null);
    ({ sc } = armar({ vivo: false, log: { 'principal:aaaaaaaa': ['Error: trust sk-abc123'] } }));
    const muerto = await sc.lanzar({ wsId: 'aaaaaaaa' });
    check('si muere al arrancar → 502 con el log redactado', muerto.codigo === 502 && /trust \[redactado\]/.test(muerto.log), JSON.stringify(muerto));
    ({ sc } = armar({ lanzar: () => ({ success: false, limitReached: true, error: 'Tope de 3', activeSessions: [] }) }));
    check('tope → 409', (await sc.lanzar({ wsId: 'aaaaaaaa' })).codigo === 409);
    ({ sc } = armar({ lanzar: () => ({ success: false, error: 'Workspace no confiable' }) }));
    check('error del launcher → 400 con su texto', /no confiable/.test((await sc.lanzar({ wsId: 'aaaaaaaa' })).error));
    ({ sc } = armar({ lanzar: () => ({ success: true, alreadyRunning: true, key: 'principal:aaaaaaaa', account: 'principal', pid: 9, projectPath: WS[0].path }) }));
    const ya = await sc.lanzar({ wsId: 'aaaaaaaa' });
    check('ya activa → ok con yaActiva', ya.ok && ya.yaActiva === true && ya.sesion.pid === 9);
  });

  await group('detener y limpiar', () => {
    const { sc, llamadas } = armar();
    check('sin key ni all → 400 (la web siempre dice cuál)', sc.detener({}).codigo === 400 && !llamadas.detener.length);
    check('key mal formada → 400', sc.detener({ key: 'principal:../../x' }).codigo === 400);
    const r = sc.detener({ all: true });
    check('all → detener({ all: true })', llamadas.detener[0].all === true);
    check('una entrada por sesión detenida', r.detenidas.length === 2 && r.detenidas[1].cuenta === 'trabajo');
    const uno = r.proyectos.find((p) => p.proyecto === 'uno');
    const dos = r.proyectos.find((p) => p.proyecto === 'dos');
    check('inspección por proyecto: limpios y con cambios', uno.limpios === 2 && uno.wsId === 'aaaaaaaa' && dos.limpios === 0 && dos.conCambios[0].rama === 'c');
    sc.detener({ key: 'trabajo:bbbbbbbb' });
    check('key → detener({ key })', llamadas.detener[1].key === 'trabajo:bbbbbbbb' && !llamadas.detener[1].all);
    check('limpiar con wsId desconocido → 404', sc.limpiar({ wsId: 'ffffffff' }).codigo === 404 && !llamadas.purgar.length);
    const l = sc.limpiar({ wsId: 'aaaaaaaa' });
    check('limpiar purga la ruta del workspace', l.ok && l.borrados === 2 && llamadas.purgar[0] === WS[0].path);
  });

  await group('log', () => {
    const { sc } = armar({ log: { 'principal:aaaaaaaa': ['hola sk-zzz'] } });
    check('key inválida → 400', sc.log('../../etc', 30).codigo === 400);
    check('redactado', sc.log('principal:aaaaaaaa', 30).contenido === 'hola [redactado]');
    check('sin log → contenido null con aviso', sc.log('trabajo:aaaaaaaa', 30).contenido === null);
    check('rutaLogDeSesion no arma rutas con una clave rara', launcher.rutaLogDeSesion('principal:../x') === null && launcher.rutaLogDeSesion('a/b:aaaaaaaa') === null);
    check('rutaLogDeSesion con una clave válida, en la carpeta de datos', path.basename(launcher.rutaLogDeSesion('trabajo:0123abcd')) === 'claude-session-trabajo-0123abcd.log');
  });

  await group('inspeccionarParada (compartida con Telegram)', () => {
    const r = web.inspeccionarParada({ success: true, pid: 1, projectPath: WS[0].path }, WS, () => ({ cleanWorktrees: [1], dirtyWorktrees: [] }));
    check('una sola sesión (sin stopped)', r.length === 1 && r[0].wsId === 'aaaaaaaa');
    let fallos = 0;
    const r2 = web.inspeccionarParada({ success: true, stopped: [{ projectPath: WS[0].path }, { projectPath: WS[0].path.toUpperCase() }, { projectPath: WS[1].path }] }, WS,
      (p) => { if (p === WS[1].path) throw new Error('x'); return { cleanWorktrees: [], dirtyWorktrees: [] }; }, () => { fallos++; });
    check('un proyecto una vez, y el que falla se salta', r2.length === 1 && fallos === 1);
  });

  await group('Ajustes: sección sesiones', () => {
    const base = { x_otra: 1, motores: { cuentas: { trabajo: { configDir: 'C:/x/.claude-work' } } } };
    const home = homeNuevo(base);
    const e = ajustes.leerAjustes({ homeDir: home });
    check('sin clave: vacía, con modos y tope', e.sesiones.cuenta_por_defecto === null && e.sesiones.max_sesiones === null && Object.keys(e.sesiones.directorios).length === 0 && e.sesiones.tope === 10 && e.sesiones.modos.includes('worktree'));
    check('versión propia', /^[0-9a-f]{16}$/.test(e.versiones.sesiones));
    const v = e.versiones.sesiones;
    const guardar = (s, version = v) => ajustes.guardarAjustes({ sesiones: { versionSeccion: version, ...s } }, { homeDir: home });
    const absoluta = path.join(dir, 'manual');
    const r = guardar({ cuenta_por_defecto: 'trabajo', max_sesiones: 5, directorios: { [absoluta]: { modo: 'worktree', cuenta: 'trabajo' }, '~/otro': {} }, ocultos: ['~/viejo', '~/viejo'] });
    check('guarda', r.ok, JSON.stringify(r));
    const d = leer(home);
    check('en sesiones_claude, sin tocar lo demás', d.x_otra === 1 && d.sesiones_claude.cuenta_por_defecto === 'trabajo' && d.sesiones_claude.max_sesiones === 5 && d.sesiones_claude.directorios[absoluta].modo === 'worktree' && JSON.stringify(d.sesiones_claude.directorios['~/otro']) === '{}');
    check('ocultos sin repetidos', JSON.stringify(d.sesiones_claude.ocultos) === '["~/viejo"]');
    check('versión vieja → 409', guardar({}, v).codigo === 409);
    const v2 = r.versiones.sesiones;
    for (const [nombre, s] of [
      ['cuenta inexistente', { cuenta_por_defecto: 'nadie' }],
      ['max fuera de rango', { max_sesiones: 11 }],
      ['max no entero', { max_sesiones: 2.5 }],
      ['ruta relativa', { directorios: { 'relativa/x': {} } }],
      ['modo inválido', { directorios: { [absoluta]: { modo: 'otro' } } }],
      ['cuenta de carpeta inexistente', { directorios: { [absoluta]: { cuenta: 'nadie' } } }],
      ['clave desconocida en carpeta', { directorios: { [absoluta]: { x: 1 } } }],
      ['clave desconocida en la sección', { otra: 1 }],
      ['oculto relativo', { ocultos: ['x'] }]
    ]) {
      const x = guardar(s, v2);
      check(`rechaza: ${nombre}`, x.ok === false && x.codigo === 400 && /^sesiones/.test(x.campo || ''), JSON.stringify(x));
    }
    check('lo rechazado no tocó el archivo', leer(home).sesiones_claude.max_sesiones === 5);
    const vacio = guardar({ cuenta_por_defecto: null, max_sesiones: null, directorios: {}, ocultos: [] }, v2);
    check('vaciar todo borra la clave', vacio.ok && !('sesiones_claude' in leer(home)));
    const roto = homeNuevo({ ...base, sesiones_claude: { max_sesiones: 99, directorios: { 'rel': {} } } });
    const er = ajustes.leerAjustes({ homeDir: roto });
    check('lo que el daemon ignora sale como aviso', er.avisos.sesiones.length === 2, JSON.stringify(er.avisos.sesiones));
  });

  await group('Servidor: rutas locales y vedadas al orquestador', async () => {
    const srv = await import('../telegram-bridge/web/servidor.js');
    const { crearCanalWeb } = await import('../telegram-bridge/web/canal.js');
    const { crearNucleoWeb } = await import('../telegram-bridge/web/nucleo.js');
    const tareas = await import('../telegram-bridge/tareas.js');
    check('ningún método de /claude se ejecuta por RPC en un nodo', ![...srv.metodosPermitidos()].some((m) => /claude/i.test(m)) && ![...srv.metodosDeMutacion()].some((m) => /claude/i.test(m)));
    const { sc } = armar();
    const sinClaude = crearNucleoWeb({ canal: crearCanalWeb(), bot: {}, almas: {}, tareas, workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({}), estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true });
    check('sin la dep: 503', (await sinClaude.claude()).codigo === 503);
    const nucleo = crearNucleoWeb({ canal: crearCanalWeb(), bot: {}, almas: {}, tareas, workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({}), estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true, claude: sc });
    const servidor = srv.crearServidorWeb({ nucleo, token: TOKEN, orquestador: { token: TOKEN_ORQ, modo: () => 'yolo' } });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${servidor.address().port}`;
    try {
      const conToken = async (metodo, ruta, cuerpo) => {
        const r = await fetch(base + ruta, { method: metodo, headers: { 'x-lagrange-token': TOKEN, origin: base, 'content-type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
        return { status: r.status, datos: await r.json() };
      };
      const v = await conToken('GET', '/api/claude');
      check('GET /api/claude con la sesión del usuario', v.status === 200 && v.datos.proyectos.length === 3);
      const l = await conToken('POST', '/api/claude/lanzar', { wsId: 'aaaaaaaa' });
      check('POST /api/claude/lanzar', l.status === 200 && l.datos.sesion.pid === 42, JSON.stringify(l));
      check('un error del módulo sale con su código', (await conToken('POST', '/api/claude/detener', {})).status === 400);
      check('GET /api/claude/log', (await conToken('GET', '/api/claude/log?key=principal:aaaaaaaa&n=30')).status === 200);
      for (const [metodo, ruta] of [['GET', '/api/claude'], ['POST', '/api/claude/lanzar'], ['POST', '/api/claude/detener']]) {
        const r = await fetch(base + ruta, { method: metodo, headers: { 'x-lagrange-orquestador': TOKEN_ORQ, 'x-lagrange-quien': 'Spica', 'content-type': 'application/json' }, body: metodo === 'POST' ? '{}' : undefined });
        check(`orquestador: ${metodo} ${ruta} → 403`, r.status === 403);
      }
      check('las demás rutas locales también se atienden (el saldo de DeepSeek daba 404)', (await conToken('GET', '/api/deepseek/saldo')).status === 503);
      check('en un nodo remoto no existe (/api/n/<nodo>/claude)', (await conToken('GET', '/api/n/otro/claude')).status >= 400);
    } finally {
      await new Promise((r) => servidor.close(r));
    }
  });

  await group('UI', () => {
    const ui = (f) => fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui', f), 'utf8');
    check('/api/claude es local en el cliente (nunca a un nodo)', /RUTAS_LOCALES = \/\^\\\/api\\\/\(ajustes\|claude\)/.test(ui('nucleo.js')));
    check('la vista Sesiones usa el componente, con los agentes en la red adentro del panel En vivo',
      /<\$\{SesionesClaude\}>\s*<\$\{Tabla\} titulo="Agentes en la red"/.test(ui('vista-sesiones.js')));
    check('el historial va en pestañas, y la elegida se recuerda por dispositivo', ui('vista-sesiones.js').includes("persistente('sesiones.historial'") && ui('vista-sesiones.js').includes('role="tablist"'));
    check('los UUID se ven cortos (8) y se copian', ui('vista-sesiones.js').includes('v.slice(0, 8)') && ui('vista-sesiones.js').includes('clipboard'));
    check('la configuración abre en un diálogo (no desplegada en la página)', ui('sesiones-claude-config.js').includes('<${Dialogo}') && !ui('sesiones-claude-config.js').includes('<details'));
    check('el panel En vivo la abre con «Configurar»', ui('sesiones-claude.js').includes("setDialogo({ tipo: 'config' })"));
    for (const f of ['sesiones-claude.js', 'sesiones-claude-config.js', 'vista-sesiones.js']) {
      check(`${f} bajo el tope de 210 líneas`, ui(f).split('\n').length <= 210);
    }
  });

  report();
})().catch((err) => { console.error(err); process.exit(1); });
