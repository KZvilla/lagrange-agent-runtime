/**
 * BE-177 — `agy_run` valida `timeout_minutes` (entero 1..120) antes de lanzar,
 * pasa `--disable-slash-commands` cuando la versión de agy lo soporta, y no
 * reintenta solo: un error transitorio produce un único spawn.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
const esError = (r) => Boolean(r.result && r.result.isError);
const lanzamientos = (capture) => fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);
const valorDe = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };

async function conServidor(env, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-ejec-'));
  const capture = path.join(cwd, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const server = startServer({ cwd, captureFile: capture, env });
  try {
    await server.initialize();
    await fn({ server, capture });
  } finally {
    await server.stop();
    removeFixture(cwd);
  }
}

async function main() {
  await group('BE-177: timeout_minutes se valida antes de lanzar', async () => {
    await conServidor({}, async ({ server, capture }) => {
      for (const valor of [0, -5, 1.5, '15', 121, null]) {
        const r = await server.callTool('agy_run', { prompt: 'x', timeout_minutes: valor });
        check(`rechaza ${JSON.stringify(valor)}`, esError(r) && /timeout_minutes/.test(texto(r)), texto(r).slice(0, 300));
      }
      check('ninguno lanzó agy', lanzamientos(capture).length === 0, JSON.stringify(lanzamientos(capture)));

      const ok = await server.callTool('agy_run', { prompt: 'x', timeout_minutes: 1 });
      check('1 es válido', !esError(ok), texto(ok).slice(0, 300));
      const call = lanzamientos(capture)[0];
      check('--print-timeout 1m', valorDe(call.args, '--print-timeout') === '1m', JSON.stringify(call.args));
    });
  });

  await group('BE-177: --disable-slash-commands se pasa si agy lo soporta', async () => {
    await conServidor({}, async ({ server, capture }) => {
      await server.callTool('agy_run', { prompt: 'x' });
      const call = lanzamientos(capture)[0];
      check('flag presente', call.args.includes('--disable-slash-commands'), JSON.stringify(call.args));
    });
  });

  await group('BE-177: sin soporte, no se pasa y el footer lo avisa', async () => {
    await conServidor({ STUB_AGY_HELP: '' }, async ({ server, capture }) => {
      const r = await server.callTool('agy_run', { prompt: 'x' });
      const call = lanzamientos(capture)[0];
      check('flag ausente', !call.args.includes('--disable-slash-commands'), JSON.stringify(call.args));
      check('el footer lo dice', /does not support .*--disable-slash-commands/.test(texto(r)), texto(r).slice(-500));
    });
  });

  await group('BE-177: no hay reintento automático', async () => {
    await conServidor({ STUB_FAIL_STDERR: 'transient 503' }, async ({ server, capture }) => {
      const r = await server.callTool('agy_run', { prompt: 'x' });
      check('falla', esError(r), texto(r).slice(0, 300));
      check('un solo spawn', lanzamientos(capture).length === 1, String(lanzamientos(capture).length));
    });
  });

  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
