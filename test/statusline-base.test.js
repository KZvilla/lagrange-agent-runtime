/**
 * FEAT-104 — La statusline propia: la línea base (`lib/statusline-base.js`,
 * del stdin de Claude Code y `.git/HEAD`) y la línea de Lagrange
 * (`lib/statusline-lagrange.js`). Todo en temporales: HOME y USERPROFILE se
 * apuntan a una carpeta de prueba mientras corre cada grupo.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');
const { temporalQueSeBorra } = require('./lib/temporales');
const { armarBase, leerRama } = require('../mcp-server/lib/statusline-base.js');
const lagrange = require('../mcp-server/lib/statusline-lagrange.js');

const sinAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const STDIN = {
  cwd: 'C:/repo/sub',
  workspace: { project_dir: 'C:/repo/mi-proyecto' },
  model: { display_name: 'Opus 5.5' },
  effort: 'high',
  context_window: { used_percentage: 41 },
  rate_limits: { five_hour: { used_percentage: 14, resets_at: 1790200000 }, seven_day: { used_percentage: 60, resets_at: 1790500000 } },
  cost: { total_cost_usd: 3.4211, total_lines_added: 120, total_lines_removed: 30, total_duration_ms: 4320000 }
};

function conHome(home, fn) {
  const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function main() {
  await group('armarBase: los campos que usaba de claude-hud', () => {
    const l = sinAnsi(armarBase(STDIN, { rama: 'next/v1' }));
    check('modelo · esfuerzo', l.startsWith('Opus 5.5 · high │ '), l);
    check('proyecto de project_dir y rama', l.includes('mi-proyecto ⎇ next/v1'), l);
    check('contexto con barra', l.includes('ctx ████░░░░░░ 41%'), l);
    check('5 h sin hora bajo el 50 %', /5h 14%( │|$)/.test(l), l);
    check('7 d al 60 %: no aparece', !l.includes('7d'), l);
    check('costo, líneas y duración', l.includes('$3.42') && l.includes('+120 −30') && l.includes('1h12m'), l);
    check('con colores ANSI', armarBase(STDIN, {}).includes('\x1b['));
  });

  await group('armarBase: umbrales, formas y faltantes', () => {
    const alto = { ...STDIN, rate_limits: { five_hour: { used_percentage: 62, resets_at: 1790200000 }, seven_day: { used_percentage: 80, resets_at: 1790500000 } } };
    const l = sinAnsi(armarBase(alto, {}));
    const hora = new Date(1790200000 * 1000).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    check('5 h ≥ 50 %: hora de reinicio de resets_at * 1000', l.includes(`5h 62% ↻${hora}`), l);
    check('7 d ≥ 75 %: aparece con el día', /7d 80% ↻\S+/.test(l), l);
    check('effort como { level }', sinAnsi(armarBase({ ...STDIN, effort: { level: 'max' } }, {})).startsWith('Opus 5.5 · max'));
    check('sin effort, solo el modelo', sinAnsi(armarBase({ ...STDIN, effort: null }, {})).startsWith('Opus 5.5 │ '));
    const pelado = sinAnsi(armarBase({ model: STDIN.model, context_window: STDIN.context_window, cwd: 'C:/x/otro' }, {}));
    check('sin cost ni rate_limits esos campos no aparecen', !pelado.includes('$') && !pelado.includes('5h') && pelado.includes('otro'), pelado);
    check('sin rama no hay ⎇', !pelado.includes('⎇'));
    check('worktree: (wt)', sinAnsi(armarBase({ ...STDIN, workspace: { ...STDIN.workspace, git_worktree: 'x' } }, { rama: 'f' })).includes('⎇ f (wt)'));
    check('duración de 30 s: nada', !sinAnsi(armarBase({ ...STDIN, cost: { total_duration_ms: 30000 } }, {})).match(/\d+m( │|$)/));
    check('duración de 12 min: 12m', sinAnsi(armarBase({ ...STDIN, cost: { total_duration_ms: 12 * 60000 } }, {})).endsWith('12m'));
    check('stdin null o sin modelo ni contexto: vacío', armarBase(null) === '' && armarBase({ cwd: 'C:/x' }) === '');
  });

  await group('leerRama: HEAD, subcarpeta, worktree y fuera de un repo', () => {
    const raiz = temporalQueSeBorra('sl-rama-');
    const repo = path.join(raiz, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/next/v1\n');
    check('ref → nombre', leerRama(repo) === 'next/v1');
    check('desde una subcarpeta', leerRama(path.join(repo, 'a', 'b')) === 'next/v1');
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), '1b470abcdef0123456789\n');
    check('SHA → 7', leerRama(repo) === '1b470ab');
    const gitdirAbs = path.join(raiz, 'gd-abs');
    fs.mkdirSync(gitdirAbs);
    fs.writeFileSync(path.join(gitdirAbs, 'HEAD'), 'ref: refs/heads/feat/x\n');
    const wt1 = path.join(raiz, 'wt1');
    fs.mkdirSync(wt1);
    fs.writeFileSync(path.join(wt1, '.git'), `gitdir: ${gitdirAbs}\n`);
    check('worktree con gitdir absoluto', leerRama(wt1) === 'feat/x');
    const wt2 = path.join(raiz, 'wt2');
    fs.mkdirSync(wt2);
    fs.writeFileSync(path.join(wt2, '.git'), 'gitdir: ../gd-abs\n');
    check('worktree con gitdir relativo', leerRama(wt2) === 'feat/x');
    const suelta = temporalQueSeBorra('sl-sin-repo-');
    check('sin .git hasta la raíz: null', leerRama(suelta) === null);
  });

  await group('línea de Lagrange: agy y fallback', () => {
    const home = temporalQueSeBorra('sl-lg-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const cfg = path.join(home, '.claude', 'antigravity.json');
    const uso = path.join(home, '.claude', 'antigravity-usage.json');
    const ahora = Date.now();
    const base = { session: { total_calls: 0 } };
    conHome(home, () => {
      fs.writeFileSync(cfg, JSON.stringify({ motores: { cuentas: { trabajo: { configDir: path.join(home, '.otra') } } }, fallback_agy: 'claude@trabajo' }));
      fs.writeFileSync(uso, JSON.stringify({ ...base, fallback: { cuotaHasta: new Date(ahora + 3600e3).toISOString() } }));
      check('ventana de fallback futura: con la cuenta', /^agy sin cuota → claude@trabajo hasta \d{2}:\d{2}$/.test(lagrange.parteAgy({ cwd: home, ahora }) || ''), lagrange.parteAgy({ cwd: home, ahora }));
      fs.writeFileSync(cfg, JSON.stringify({}));
      check('sin fallback_agy: sin flecha', /^agy sin cuota hasta \d{2}:\d{2}$/.test(lagrange.parteAgy({ cwd: home, ahora }) || ''));
      const agy = (horas, gemini, claudeGpt) => ({ ...base, cuota: { antigravity: { visto_en: new Date(ahora - horas * 3600e3).toISOString(), grupos: { gemini: { ventana_5h: gemini }, claude_gpt: { ventana_5h: claudeGpt } } } } });
      fs.writeFileSync(uso, JSON.stringify({ ...agy(1, 0.82, 0.9), fallback: { cuotaHasta: new Date(ahora - 1000).toISOString() } }));
      check('ventana vencida y agy fresca: el grupo de mayor uso', lagrange.parteAgy({ cwd: home, ahora }) === 'agy claude_gpt 90%', lagrange.parteAgy({ cwd: home, ahora }));
      fs.writeFileSync(uso, JSON.stringify(agy(7, 0.82, 0.9)));
      check('cuota de agy de hace 7 h: nada', lagrange.parteAgy({ cwd: home, ahora }) === null);
      fs.writeFileSync(uso, JSON.stringify(agy(1, 0.4, 0.3)));
      check('agy al 40 %: nada', lagrange.parteAgy({ cwd: home, ahora }) === null);
    });
  });

  await group('línea de Lagrange: daemon, versión y cuarentena', () => {
    check('lock huérfano (pid-muerto): bridge caído', lagrange.parteDaemon({ daemon: { motivo: 'pid-muerto' } }) === 'bridge caído');
    check('otro arranque: bridge caído', lagrange.parteDaemon({ daemon: { motivo: 'otro-arranque' } }) === 'bridge caído');
    check('sin-lock, vivo o sin dato: nada', ['sin-lock', 'vivo', 'lock-ilegible'].every((m) => lagrange.parteDaemon({ daemon: { motivo: m } }) === null) && lagrange.parteDaemon({ daemon: null }) === null);

    const home = temporalQueSeBorra('sl-lg2-');
    const propia = require('../package.json').version;
    const plugins = (dir, version) => {
      fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'lagrange@kzvilla-lagrange': [{ scope: 'user', version, installPath: path.join(dir, 'x'), gitCommitSha: 'a'.repeat(40) }] } }));
    };
    conHome(home, () => {
      plugins(path.join(home, '.claude'), propia);
      check('todas con la misma versión: nada', lagrange.parteVersion({ cwd: home }) === null, lagrange.parteVersion({ cwd: home }));
      plugins(path.join(home, '.claude'), '99.0.0');
      check('otra cuenta más nueva: deriva', lagrange.parteVersion({ cwd: home }) === `⟳ lagrange ${propia} < 99.0.0`, lagrange.parteVersion({ cwd: home }));

      check('cuarentena vacía: nada', lagrange.parteCuarentena() === null);
      fs.writeFileSync(path.join(home, '.claude', 'lagrange-cuarentena.json'), JSON.stringify({ entradas: [{ id: 'q_x', agente: 'a', creada: new Date().toISOString() }] }));
      check('una entrada: 🧪 1', lagrange.parteCuarentena() === '🧪 1 en cuarentena', String(lagrange.parteCuarentena()));

      const todo = lagrange.segmentoLagrange({ cwd: home, daemon: { motivo: 'pid-muerto' } });
      check('segmento: une las partes con │', typeof todo === 'string' && todo.includes('bridge caído │ ⟳ lagrange') && todo.endsWith('🧪 1 en cuarentena'), todo);
    });
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
