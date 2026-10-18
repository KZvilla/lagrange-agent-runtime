/**
 * FEAT-169 — Sesiones remotas de Claude configurables: `sesiones_claude` en la
 * config global, la lista de proyectos de todas las cuentas, la cuenta de cada
 * sesión y varias sesiones a la vez.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat169-'));
const home = path.join(raiz, 'home');
const cfgTrabajo = path.join(raiz, 'cuenta-trabajo');
const datos = path.join(raiz, 'datos');
for (const d of [home, cfgTrabajo, datos, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });

// state.js y paths.js leen el entorno al cargarse: antes de importar nada del bridge.
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(datos, 'state.json');
process.env.TELEGRAM_BRIDGE_DATA_DIR = datos;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.ALLOWED_CLAUDE_WORKSPACES;
delete process.env.ALLOWED_WORKSPACES;

const proyecto = (nombre) => {
  const p = path.join(raiz, 'repos', nombre);
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync.native(p);
};
const compartido = proyecto('compartido');
const soloPrincipal = proyecto('solo-principal');
const soloTrabajo = proyecto('solo-trabajo');
const manual = proyecto('manual');
const oculto = proyecto('oculto');
const hash8 = (p) => crypto.createHash('sha256').update(p.toLowerCase()).digest('hex').slice(0, 8);

fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {
  [compartido]: { hasTrustDialogAccepted: true, remoteControlSpawnMode: 'worktree' },
  [soloPrincipal]: { hasTrustDialogAccepted: true },
  [oculto]: { hasTrustDialogAccepted: true },
  [soloTrabajo]: { hasTrustDialogAccepted: false }
} }));
fs.writeFileSync(path.join(cfgTrabajo, '.claude.json'), JSON.stringify({ projects: {
  [compartido]: { hasTrustDialogAccepted: true },
  [soloTrabajo]: { hasTrustDialogAccepted: true }
} }));

const cuentas = [
  { account: 'principal', configDir: null, claudeHome: path.join(home, '.claude'), claudeJsonPath: path.join(home, '.claude.json'), label: 'Spica' },
  { account: 'trabajo', configDir: cfgTrabajo, claudeHome: cfgTrabajo, claudeJsonPath: path.join(cfgTrabajo, '.claude.json'), label: 'Epikouros' }
];
const sesionesClaude = { cuentaPorDefecto: null, maxSesiones: 3, directorios: { [manual]: { modo: 'worktree', cuenta: 'trabajo' } }, ocultos: [oculto] };

/** Hijo falso: guarda los listeners para dispararlos a mano. */
function hijoFalso(pid) {
  const listeners = {};
  return { pid, unref() {}, on(ev, fn) { listeners[ev] = fn; }, listeners };
}

(async () => {
  const launcher = await import(pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'claude-launcher.js')).href);
  const state = await import(pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'state.js')).href);

  try {
    await group('F1: sesiones_claude en la config global', () => {
      const { loadConfig } = require('../mcp-server/lib/config.js');
      const homeCfg = path.join(raiz, 'home-cfg');
      const cwd = path.join(raiz, 'cwd-cfg');
      fs.mkdirSync(path.join(homeCfg, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(homeCfg, '.claude', 'antigravity.json'), JSON.stringify({
        motores: { cuentas: { trabajo: { configDir: cfgTrabajo } } },
        sesiones_claude: {
          cuenta_por_defecto: 'trabajo',
          max_sesiones: 2,
          directorios: { '~/repo-a': { modo: 'worktree', cuenta: 'principal' }, 'relativa/b': {}, [manual]: { cuenta: 'fantasma' } },
          ocultos: ['~/viejo', 42]
        }
      }));
      fs.writeFileSync(path.join(cwd, '.claude', 'antigravity.json'), JSON.stringify({ sesiones_claude: { max_sesiones: 9 } }));
      const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      process.env.HOME = homeCfg;
      process.env.USERPROFILE = homeCfg;
      let c;
      try { c = loadConfig(cwd); } finally {
        for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
      const s = c.sesionesClaude;
      check('cuenta_por_defecto de motores.cuentas', s.cuentaPorDefecto === 'trabajo');
      check('max_sesiones del global; el del proyecto no pisa', s.maxSesiones === 2);
      check('~ se expande en directorios', JSON.stringify(Object.keys(s.directorios)) === JSON.stringify([path.join(homeCfg, 'repo-a')]), JSON.stringify(s.directorios));
      check('la entrada válida conserva modo y cuenta', s.directorios[path.join(homeCfg, 'repo-a')].modo === 'worktree' && s.directorios[path.join(homeCfg, 'repo-a')].cuenta === 'principal');
      check('una ruta relativa y una cuenta inexistente se descartan con aviso',
        c.avisos.some((a) => a.includes('relativa/b')) && c.avisos.some((a) => a.includes('fantasma')), JSON.stringify(c.avisos));
      check('ocultos expande ~ y descarta lo que no es ruta', JSON.stringify(s.ocultos) === JSON.stringify([path.join(homeCfg, 'viejo')]));
      check('del proyecto se ignora con aviso', c.avisos.some((a) => a.startsWith('sesiones_claude solo se lee de la configuración global')));
    });

    await group('F1: la lista junta todas las cuentas, suma y oculta', () => {
      const lista = launcher.getProjectAllowlist({ accounts: cuentas, sesionesClaude, allowedWorkspacesSet: null });
      const por = (p) => lista.find((w) => w.path.toLowerCase() === p.toLowerCase());
      check('el compartido es confiable en las dos', JSON.stringify(por(compartido)?.trustedAccounts) === '["principal","trabajo"]', JSON.stringify(por(compartido)));
      check('el modo explícito de principal gana', por(compartido)?.spawnMode === 'worktree');
      check('solo-trabajo: false en principal, confiable en trabajo', JSON.stringify(por(soloTrabajo)?.trustedAccounts) === '["trabajo"]');
      check('el agregado a mano aparece sin confianza, con su modo y cuenta',
        por(manual)?.manual === true && por(manual).trustedAccounts.length === 0 && por(manual).spawnMode === 'worktree' && por(manual).preferredAccount === 'trabajo');
      check('el oculto no aparece', !por(oculto));
      check('el id sigue siendo el hash de la ruta', por(soloPrincipal)?.id === hash8(por(soloPrincipal).path));
      const acotada = launcher.getProjectAllowlist({ accounts: cuentas, sesionesClaude, allowedWorkspacesSet: new Set(['compartido']) });
      check('ALLOWED_CLAUDE_WORKSPACES acota también lo agregado a mano', acotada.length === 1 && acotada[0].path.toLowerCase() === compartido.toLowerCase());
      const denegada = launcher.getProjectAllowlist({ accounts: cuentas, sesionesClaude, allowedWorkspacesSet: null, denyPaths: ['**/manual'] });
      check('deny_paths vale para lo agregado a mano', !denegada.some((w) => w.manual));
    });

    await group('F2: la cuenta de cada sesión', () => {
      const lista = launcher.getProjectAllowlist({ accounts: cuentas, sesionesClaude, allowedWorkspacesSet: null });
      const ws = (p) => lista.find((w) => w.path.toLowerCase() === p.toLowerCase());
      const r = (w, o = {}) => launcher.resolveTargetAccount(w, { accounts: cuentas, ...o });
      check('la pedida gana', r(ws(compartido), { requestedAccount: 'trabajo' }).account === 'trabajo');
      check('una pedida que no existe falla', r(ws(compartido), { requestedAccount: 'nadie' }).ok === false);
      check('la única confiable', r(ws(soloTrabajo)).account === 'trabajo');
      check('con varias, la por defecto si es confiable ahí', r(ws(compartido), { defaultAccount: 'trabajo' }).account === 'trabajo');
      check('con varias y sin por defecto, la primera', r(ws(compartido)).account === 'principal');
      check('la fija del directorio', r(ws(manual)).account === 'trabajo');

      process.env.TELEGRAM_BOT_TOKEN = '123:secreto';
      process.env.CLAUDE_CONFIG_DIR = path.join(raiz, 'heredada');
      process.env.CLAUDECODE = '1';
      const llamadas = [];
      const spawnFn = (bin, args, opts) => { llamadas.push({ args, opts }); return hijoFalso(process.pid); };
      try {
        const lanzada = launcher.launchClaudeRemoteSession({ workspacePath: soloTrabajo, accounts: cuentas, spawnFn, stdio: 'ignore', findExistingFn: () => null });
        const env = llamadas[0]?.opts.env || {};
        check('lanza con la cuenta trabajo', lanzada.success && lanzada.account === 'trabajo', JSON.stringify(lanzada));
        check('el hijo lleva el CLAUDE_CONFIG_DIR de la cuenta', env.CLAUDE_CONFIG_DIR === cfgTrabajo);
        check('sin secretos de Telegram ni la sesión padre', env.TELEGRAM_BOT_TOKEN === undefined && env.CLAUDECODE === undefined);
        check('con dos cuentas, el nombre lleva el apodo', lanzada.sessionName === 'Mobile-solo-trabajo-Epikouros', lanzada.sessionName);
        state.clearActiveClaudeSession();

        const enPrincipal = launcher.launchClaudeRemoteSession({ workspacePath: soloPrincipal, accounts: cuentas, spawnFn, stdio: 'ignore', findExistingFn: () => null });
        check('principal quita la CLAUDE_CONFIG_DIR heredada (BE-047)', enPrincipal.success && !('CLAUDE_CONFIG_DIR' in llamadas[1].opts.env));
        state.clearActiveClaudeSession();

        const antes = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
        const sinConfianza = launcher.launchClaudeRemoteSession({ workspacePath: soloTrabajo, account: 'principal', accounts: cuentas, spawnFn, stdio: 'ignore', findExistingFn: () => null });
        check('sin confianza en la cuenta elegida no lanza', sinConfianza.success === false && sinConfianza.untrustedAccount === 'principal' && llamadas.length === 2, JSON.stringify(sinConfianza));
        check('y dice dónde ya es confiable', sinConfianza.error.includes('trabajo'));
        check('el .claude.json no se toca', fs.readFileSync(path.join(home, '.claude.json'), 'utf8') === antes);
      } finally {
        delete process.env.TELEGRAM_BOT_TOKEN;
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CLAUDECODE;
        state.clearActiveClaudeSession();
      }

      const PID = 515151;
      const slug = path.resolve(compartido).replace(/[^a-zA-Z0-9]/g, '-');
      fs.mkdirSync(path.join(cfgTrabajo, 'projects', slug), { recursive: true });
      fs.writeFileSync(path.join(cfgTrabajo, 'projects', slug, 'bridge-pointer.json'), JSON.stringify({ pid: PID, sessionId: 's-trabajo' }));
      const vivo = { isPidAliveFn: (pid) => pid === PID, tmuxCheckerFn: () => null };
      check('el puntero de trabajo se busca en su carpeta',
        launcher.findExistingClaudeSession(compartido, { ...vivo, account: 'trabajo', claudeHome: cfgTrabajo })?.sessionId === 's-trabajo');
      check('y no aparece como sesión de principal',
        launcher.findExistingClaudeSession(compartido, { ...vivo, account: 'principal', claudeHome: path.join(home, '.claude') }) === null);

      // Sin cuentas inyectadas: salen de ~/.claude/antigravity.json del home falso.
      fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: { cuentas: { trabajo: { configDir: cfgTrabajo } } } }));
      const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        check('sin claudeHome, el puntero se busca en la carpeta de la cuenta',
          launcher.findExistingClaudeSession(compartido, { ...vivo, account: 'trabajo' })?.sessionId === 's-trabajo');

        process.env.CLAUDE_CONFIG_DIR = cfgTrabajo;
        const declarada = launcher.getConfiguredClaudeAccounts();
        check('daemon en una cuenta declarada: principal es ~/.claude',
          declarada[0].configDir === null && declarada[0].claudeJsonPath === path.join(home, '.claude.json') && declarada[1].configDir === cfgTrabajo, JSON.stringify(declarada));
        const llamadas = [];
        const lanzada = launcher.launchClaudeRemoteSession({
          workspacePath: soloPrincipal, stdio: 'ignore', findExistingFn: () => null,
          spawnFn: (bin, args, opts) => { llamadas.push(opts); return hijoFalso(process.pid); }
        });
        check('y una sesión de principal no hereda la CLAUDE_CONFIG_DIR del daemon (BE-047)',
          lanzada.success && lanzada.account === 'principal' && !('CLAUDE_CONFIG_DIR' in llamadas[0].env), JSON.stringify(lanzada));
        state.clearActiveClaudeSession();

        const suelta = path.join(raiz, 'cuenta-suelta');
        process.env.CLAUDE_CONFIG_DIR = suelta;
        const noDeclarada = launcher.getConfiguredClaudeAccounts();
        check('daemon en una carpeta no declarada: esa carpeta hace de principal (BE-044, la lista y el hijo coinciden)',
          noDeclarada[0].configDir === path.resolve(suelta) && noDeclarada[0].claudeJsonPath === path.join(path.resolve(suelta), '.claude.json'), JSON.stringify(noDeclarada));
      } finally {
        for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        fs.rmSync(path.join(home, '.claude', 'antigravity.json'), { force: true });
        state.clearActiveClaudeSession();
      }
    });

    await group('F3: varias sesiones a la vez', async () => {
      state.clearActiveClaudeSession();
      const legado = { chats: {}, pendingAsks: {}, claudeSession: { pid: process.pid, projectPath: soloPrincipal, sessionName: 'Mobile-viejo', startedAt: '2026-01-01T00:00:00.000Z' } };
      fs.writeFileSync(process.env.TELEGRAM_BRIDGE_STATE_FILE, JSON.stringify(legado));
      const migradas = state.getActiveClaudeSessions();
      check('el claudeSession viejo se lee como sesión de principal',
        migradas.length === 1 && migradas[0].key === `principal:${hash8(soloPrincipal)}` && migradas[0].sessionName === 'Mobile-viejo', JSON.stringify(migradas));
      state.clearActiveClaudeSession();

      const hijos = [];
      const spawnFn = () => { const h = hijoFalso(process.pid); hijos.push(h); return h; };
      const base = { accounts: cuentas, spawnFn, stdio: 'ignore', findExistingFn: () => null };
      const a = launcher.launchClaudeRemoteSession({ ...base, workspacePath: soloPrincipal });
      const b = launcher.launchClaudeRemoteSession({ ...base, workspacePath: compartido, account: 'trabajo' });
      check('dos sesiones conviven', a.success && b.success && state.getActiveClaudeSessions().length === 2);
      check('cada una con su clave', a.key === `principal:${hash8(soloPrincipal)}` && b.key === `trabajo:${hash8(compartido)}`);

      // M1 — Relanzar la clave de A con otro PID: el `exit` del hijo viejo no la borra.
      state.setActiveClaudeSession({ pid: process.ppid, projectPath: soloPrincipal, sessionName: 'nueva', account: 'principal' });
      hijos[0].listeners.exit(0, null);
      check('el exit de un hijo reemplazado no borra la sesión nueva', state.getActiveClaudeSession({ key: a.key })?.pid === process.ppid);
      hijos[1].listeners.exit(0, null);
      check('el exit de B borra solo B', !state.getActiveClaudeSession({ key: b.key }) && !!state.getActiveClaudeSession({ key: a.key }));

      const c = launcher.launchClaudeRemoteSession({ ...base, workspacePath: compartido, account: 'trabajo' });
      const tope = launcher.launchClaudeRemoteSession({ ...base, workspacePath: soloTrabajo, maxSessions: 2 });
      check('el tope rechaza sin lanzar', tope.success === false && tope.limitReached === true && hijos.length === 3, JSON.stringify(tope));

      const kills = [];
      const opcionesKill = { platform: 'win32', execFileSyncFn: (cmd, args) => kills.push(args[1]) };
      const ambigua = launcher.stopClaudeRemoteSession(opcionesKill);
      check('stop sin clave con dos sesiones no mata nada', ambigua.ambiguous === true && ambigua.sessions.length === 2 && kills.length === 0);
      const una = launcher.stopClaudeRemoteSession({ ...opcionesKill, key: c.key });
      check('stop con clave detiene solo esa', una.success && una.stopped.length === 1 && state.getActiveClaudeSessions().length === 1);
      launcher.launchClaudeRemoteSession({ ...base, workspacePath: soloTrabajo });
      const todas = launcher.stopClaudeRemoteSession({ ...opcionesKill, all: true });
      check('stop all detiene todas', todas.success && todas.stopped.length === 2 && state.getActiveClaudeSessions().length === 0, JSON.stringify(todas));
      check('cada log es de su sesión', /claude-session-principal-[0-9a-f]{8}\.log$/.test(launcher.launchClaudeRemoteSession({ ...base, workspacePath: soloPrincipal, stdio: null }).logFile || ''));
      state.clearActiveClaudeSession();
    });

    await group('F3: los mensajes y botones de Telegram', async () => {
      const bot = await import(pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'bot.js')).href);
      const ws = { id: 'abcdef12', path: compartido, displayName: 'compartido (repos)', trustedAccounts: ['principal', 'trabajo'] };
      const largo = 'c'.repeat(32);
      const teclado = bot.buildAccountSelectionKeyboard({ ...ws, trustedAccounts: ['principal', largo] }, cuentas, 'principal');
      const datosBoton = teclado.inline_keyboard.flat().map((b) => b.callback_data);
      check('rc_acct entra en 64 bytes con la cuenta más larga', datosBoton.every((d) => Buffer.byteLength(d) <= 64), JSON.stringify(datosBoton));
      check('la por defecto va primero y marcada', teclado.inline_keyboard[0][0].text.includes('★') && teclado.inline_keyboard[0][0].callback_data === 'rc_acct:abcdef12:principal');

      const conCuentas = bot.buildWorkspacesKeyboard([ws], { accounts: cuentas });
      check('con dos cuentas, el botón dice en cuántas es confiable', conCuentas.inline_keyboard[0][0].text === '📁 compartido (repos) (2 cuentas)');
      const sinCuentas = bot.buildWorkspacesKeyboard([{ id: 'abcdef12', displayName: 'x (y)' }]);
      check('sin cuentas ni trustedAccounts, el texto de siempre', sinCuentas.inline_keyboard[0][0].text === '📁 x (y)');
      const conSesion = bot.buildWorkspacesKeyboard([ws], { accounts: cuentas, activeSessions: [{ projectPath: compartido }] });
      check('🟢 marca el proyecto que ya tiene sesión', conSesion.inline_keyboard[0][0].text.startsWith('🟢 📁'));

      const sesiones = [
        { key: `principal:${hash8(soloPrincipal)}`, account: 'principal', pid: 11, projectPath: soloPrincipal, sessionName: 'a' },
        { key: `trabajo:${hash8(compartido)}`, account: 'trabajo', pid: 22, projectPath: compartido, sessionName: 'b' }
      ];
      const tSesiones = bot.buildSessionsKeyboard(sesiones);
      check('un botón por sesión y uno para todas',
        JSON.stringify(tSesiones.inline_keyboard.flat().map((b) => b.callback_data)) === JSON.stringify([`rc_stop:${sesiones[0].key}`, `rc_stop:${sesiones[1].key}`, 'rc_stop:all', 'rc_list']));
      check('en el tope no se ofrece abrir otra',
        !bot.buildSessionsKeyboard(sesiones, { abrirOtra: false }).inline_keyboard.flat().some((b) => b.callback_data === 'rc_list'));

      const inspecciones = [];
      const inspect = (p) => { inspecciones.push(p); return { cleanWorktrees: [{}], dirtyWorktrees: [] }; };
      const wsLista = [{ id: hash8(soloPrincipal), path: soloPrincipal }, { id: hash8(compartido), path: compartido }];
      const varias = bot.buildStopMessageAndKeyboard({ success: true, pid: 11, projectPath: soloPrincipal, stopped: sesiones }, wsLista, inspect);
      check('stop all nombra los dos PID', varias.text.includes('PID: 11') && varias.text.includes('PID: 22'));
      check('e inspecciona los dos proyectos', inspecciones.length === 2);
      check('con un botón de purga por proyecto', varias.keyboard.inline_keyboard.flat().filter((b) => b.callback_data.startsWith('rc_clean:')).length === 2);
      const una = bot.buildStopMessageAndKeyboard({ success: true, pid: 11, projectPath: soloPrincipal, stopped: [sesiones[0]] }, wsLista, () => ({ cleanWorktrees: [], dirtyWorktrees: [] }));
      check('con una sola, el mensaje de siempre', una.text === '🛑 *Sesión de Claude Code finalizada* (PID: 11).\nEl túnel de Remote Control ha sido cerrado.');
    });
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  report();
})();
