/**
 * BE-044 — Con `CLAUDE_CONFIG_DIR` (otra cuenta), lagrange lee los datos de
 * Claude Code (`projects/`, `sessions/`, `.claude.json`) de ese directorio; el
 * estado propio de lagrange sigue en `~/.claude`, compartido entre cuentas.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { claudeDataDir, resolveSessionSource } = require('../mcp-server/session-source.js');
const { loadConfig } = require('../mcp-server/lib/config.js');
const { dirAlmas } = require('../mcp-server/almas/rutas.js');
const parser = require('../bundles/claude-compact/scripts/parse_claude_session.js');
const { check, group, report } = require('./lib/assert');

const ID_HOME = 'aaaaaaaa-home-0001';
const ID_CFG = 'bbbbbbbb-cfg-0002';
const ID_CFG_CWD = 'cccccccc-cfg-0003';

/** Nombre de la carpeta de `projects/` que `getProjectLogDir` reconoce para `cwd`. */
const carpetaDe = (cwd) => cwd.replace(/\\/g, '/').replace(/^\//, '').replace(/:/g, '').replace(/\//g, '-');

function transcript(dir, id) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: id } }) + '\n');
}

/** Corre `fn` con variables de `process.env` cambiadas y las restaura siempre. */
async function conEnv(cambios, fn) {
  const previo = Object.fromEntries(Object.keys(cambios).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(cambios)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

(async () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-be044-'));
  const home = path.join(raiz, 'home');
  const cfg = path.join(raiz, 'cuenta-dos');
  const cwd = path.join(raiz, 'proyecto');
  fs.mkdirSync(cwd, { recursive: true });
  transcript(path.join(home, '.claude', 'projects', carpetaDe(cwd)), ID_HOME);
  transcript(path.join(cfg, 'projects', carpetaDe(cwd)), ID_CFG);
  const base = { HOME: home, USERPROFILE: home };

  try {
    await group('session-source: los transcripts salen de la cuenta de la sesión', () => {
      check('sin la variable, ~/.claude', claudeDataDir(base) === path.join(home, '.claude'));
      check('con la variable, ese directorio', claudeDataDir({ ...base, CLAUDE_CONFIG_DIR: cfg }) === path.resolve(cfg));
      check('vacía o con espacios cuenta como ausente', claudeDataDir({ ...base, CLAUDE_CONFIG_DIR: '   ' }) === path.join(home, '.claude'));

      const conCfg = resolveSessionSource({ cwd, env: { ...base, CLAUDE_CONFIG_DIR: cfg } });
      check('con CLAUDE_CONFIG_DIR encuentra el transcript de esa cuenta', conCfg.sessionId === ID_CFG, JSON.stringify(conCfg));
      const sinCfg = resolveSessionSource({ cwd, env: base });
      check('sin la variable, el de ~/.claude como antes', sinCfg.sessionId === ID_HOME, JSON.stringify(sinCfg));
      const blanca = resolveSessionSource({ cwd, env: { ...base, CLAUDE_CONFIG_DIR: '  ' } });
      check('con la variable en blanco, también el de ~/.claude', blanca.sessionId === ID_HOME, JSON.stringify(blanca));
    });

    await group('el estado de lagrange no se muda con la cuenta', async () => {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ model: 'modelo-compartido' }));
      fs.writeFileSync(path.join(cfg, 'antigravity.json'), JSON.stringify({ model: 'modelo-de-la-cuenta' }));
      await conEnv({ ...base, CLAUDE_CONFIG_DIR: cfg, AGY_MODEL: undefined }, () => {
        const config = loadConfig(cwd);
        check('antigravity.json se lee de ~/.claude', config.defaultModel === 'modelo-compartido', config.defaultModel);
      });
      check('las almas siguen en ~/.claude/lagrange-almas',
        dirAlmas({ ...base, CLAUDE_CONFIG_DIR: cfg }) === path.join(home, '.claude', 'lagrange-almas'));
    });

    await group('parse_claude_session (bundle): misma regla', async () => {
      await conEnv({ ...base, CLAUDE_CONFIG_DIR: cfg }, () => {
        check('getClaudeDir usa la variable', parser.getClaudeDir() === path.resolve(cfg));
        const ids = parser.listAllSessions().all.map(s => s.sessionId);
        check('lista los transcripts de esa cuenta y no los de ~/.claude',
          ids.includes(ID_CFG) && !ids.includes(ID_HOME), JSON.stringify(ids));
        // resolveSessionFile es lo que usa la CLI del bundle: por ID y por cwd.
        const porId = parser.resolveSessionFile(null, ID_CFG);
        check('resolveSessionFile encuentra por ID el transcript de esa cuenta', porId?.sessionId === ID_CFG, JSON.stringify(porId));
        check('y no el de ~/.claude', !parser.resolveSessionFile(null, ID_HOME)?.filePath?.startsWith(home));
        transcript(path.join(cfg, 'projects', parser.encodeProjectDir(cwd)), ID_CFG_CWD);
        const porCwd = parser.resolveSessionFile(cwd, null);
        check('resolveSessionFile encuentra por cwd el de esa cuenta', porCwd?.sessionId === ID_CFG_CWD, JSON.stringify(porCwd));
      });
      await conEnv({ ...base, CLAUDE_CONFIG_DIR: undefined }, () => {
        check('sin la variable, ~/.claude', parser.getClaudeDir() === path.join(home, '.claude'));
      });
    });

    await group('bridge: puntero de Remote Control y .claude.json de la cuenta', async () => {
      const launcher = await import(pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'claude-launcher.js')).href);
      const PID = 424242;
      const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
      fs.mkdirSync(path.join(cfg, 'projects', slug), { recursive: true });
      fs.writeFileSync(path.join(cfg, 'projects', slug, 'bridge-pointer.json'),
        JSON.stringify({ pid: PID, sessionId: 'sesion-cuenta-dos' }));
      const opciones = { isPidAliveFn: (pid) => pid === PID, tmuxCheckerFn: () => null };

      await conEnv({ CLAUDE_CONFIG_DIR: cfg }, () => {
        const hallada = launcher.findExistingClaudeSession(cwd, opciones);
        check('encuentra el puntero bajo CLAUDE_CONFIG_DIR sin pasar claudeHome',
          hallada?.source === 'claude-pointer' && hallada.sessionId === 'sesion-cuenta-dos', JSON.stringify(hallada));
        check('.claude.json dentro de CLAUDE_CONFIG_DIR',
          launcher.resolveClaudeJsonPath() === path.join(path.resolve(cfg), '.claude.json'));
        check('una ruta inyectada sigue mandando', launcher.resolveClaudeJsonPath('X:/a.json') === 'X:/a.json');
        fs.writeFileSync(path.join(cfg, '.claude.json'),
          JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
        const permitidos = launcher.getProjectAllowlist({ allowedWorkspacesSet: null });
        check('la allowlist por defecto sale del .claude.json de esa cuenta',
          permitidos.length === 1 && path.basename(permitidos[0].path) === 'proyecto', JSON.stringify(permitidos));
      });
      await conEnv({ CLAUDE_CONFIG_DIR: undefined }, () => {
        check('sin la variable, el puntero de esa cuenta no aparece',
          launcher.findExistingClaudeSession(cwd, { ...opciones, claudeHome: path.join(home, '.claude') }) === null);
        check('sin la variable, .claude.json como antes',
          launcher.resolveClaudeJsonPath() === path.join(process.env.USERPROFILE || os.homedir(), '.claude.json'));
        check('claudeConfigDir es null', launcher.claudeConfigDir() === null);
      });
    });
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }

  report();
})();
