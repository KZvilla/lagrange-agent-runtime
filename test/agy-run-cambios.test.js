/**
 * FEAT-184 — `agy_run` toma una foto de `git status` antes y después, y la
 * informa en el texto y en `structuredContent` cuando el cliente negoció
 * 2025-06-18. No revierte nada.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
const esError = (r) => Boolean(r.result && r.result.isError);
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

function repoFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-cambios-'));
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 'test@example.invalid']);
  git(cwd, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(cwd, 'base.txt'), 'base\n');
  git(cwd, ['add', 'base.txt']);
  git(cwd, ['commit', '-m', 'init']);
  return cwd;
}

async function conServidor({ cwd, env = {}, protocolVersion = '2025-06-18' }, fn) {
  // El capture no puede vivir dentro del repo: `git status` lo vería como
  // untracked y ensuciaría todas las fotos.
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-cambios-cap-'));
  const capture = path.join(captureDir, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const server = startServer({ cwd, captureFile: capture, env });
  try {
    await server.initialize(undefined, protocolVersion);
    await fn({ server, capture });
  } finally {
    await server.stop();
    removeFixture(captureDir);
  }
}

async function main() {
  const repo = repoFixture();
  try {
    await group('FEAT-184: informa el archivo que escribió agy', async () => {
      await conServidor({ cwd: repo, env: { STUB_ESCRIBIR: 'nuevo.txt' } }, async ({ server }) => {
        const r = await server.callTool('agy_run', { prompt: 'x', cwd: repo });
        check('corre', !esError(r), texto(r).slice(0, 300));
        const t = texto(r);
        check('nombra el archivo', /nuevo\.txt/.test(t), t.slice(-900));
        check('dice que cambió', /working tree changed while agy_run ran/i.test(t), t.slice(-900));
        check('no revierte', fs.existsSync(path.join(repo, 'nuevo.txt')));
        const sc = (r.result || {}).structuredContent;
        check('structuredContent existe', Boolean(sc), JSON.stringify(r.result || {}).slice(0, 300));
        check('changed_files incluye el archivo', Array.isArray(sc.changed_files) && sc.changed_files.includes('nuevo.txt'), JSON.stringify(sc.changed_files));
        check('working_tree changed', sc.working_tree === 'changed', sc.working_tree);
      });
    });

    await group('FEAT-184: sin cambios informa clean', async () => {
      await conServidor({ cwd: repo }, async ({ server }) => {
        const r = await server.callTool('agy_run', { prompt: 'x', cwd: repo });
        const t = texto(r);
        check('dice que no cambió', /no changes detected/i.test(t), t.slice(-900));
        const sc = (r.result || {}).structuredContent;
        check('working_tree clean', sc && sc.working_tree === 'clean', JSON.stringify(sc && sc.working_tree));
      });
    });

    await group('FEAT-184: fuera de git no rompe', async () => {
      const sinGit = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-nogit-'));
      try {
        await conServidor({ cwd: sinGit }, async ({ server }) => {
          const r = await server.callTool('agy_run', { prompt: 'x', cwd: sinGit });
          const t = texto(r);
          check('corre', !esError(r), t.slice(0, 300));
          check('dice not checked', /not checked .*not a git repository/i.test(t), t.slice(-900));
          const sc = (r.result || {}).structuredContent;
          check('working_tree not_checked', sc && sc.working_tree === 'not_checked', JSON.stringify(sc && sc.working_tree));
        });
      } finally {
        removeFixture(sinGit);
      }
    });

    await group('FEAT-184: el error también trae el informe', async () => {
      await conServidor({ cwd: repo, env: { STUB_ESCRIBIR: 'parcial.txt', STUB_FAIL_STDERR: 'fallo controlado' } }, async ({ server }) => {
        const r = await server.callTool('agy_run', { prompt: 'x', cwd: repo });
        check('isError', esError(r), texto(r).slice(0, 300));
        const t = texto(r);
        check('nombra el archivo parcial', /parcial\.txt/.test(t), t.slice(-900));
        check('incluye el bloque de cambios', /working tree changed while agy_run ran/i.test(t), t.slice(-900));
      });
    });
  } finally {
    removeFixture(repo);
  }

  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
