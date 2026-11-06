/**
 * SEC-029 — `agy_run` no puede honrar `dangerously_skip_permissions: false`:
 * sin skip agy igual no bloquea las tools de escritura, y `agy_run` usa JSON
 * (no eventos), así que no puede reportar negaciones ni escrituras. La tool
 * rechaza el pedido antes de lanzar. `true` y el default siguen pasando skip.
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

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-skip-'));
  const capture = path.join(cwd, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const server = startServer({ cwd, captureFile: capture });

  try {
    await server.initialize();

    await group('SEC-029: false se rechaza antes de lanzar', async () => {
      const r = await server.callTool('agy_run', { prompt: 'x', dangerously_skip_permissions: false });
      check('isError', esError(r), texto(r).slice(0, 300));
      check('explica el motivo', /no soporta dangerously_skip_permissions: false/.test(texto(r)), texto(r).slice(0, 500));
      check('menciona agent', /agent/.test(texto(r)), texto(r).slice(0, 500));
      check('no se lanzó agy', lanzamientos(capture).length === 0, JSON.stringify(lanzamientos(capture)));
    });

    await group('SEC-029: true y el default siguen pasando skip', async () => {
      const r1 = await server.callTool('agy_run', { prompt: 'x', dangerously_skip_permissions: true });
      const r2 = await server.callTool('agy_run', { prompt: 'y' });
      check('las dos corren', !esError(r1) && !esError(r2), `${texto(r1).slice(0, 200)} | ${texto(r2).slice(0, 200)}`);
      const calls = lanzamientos(capture);
      check('dos spawns', calls.length === 2, String(calls.length));
      check('los dos pasan skip', calls.every((c) => c.args.includes('--dangerously-skip-permissions')), JSON.stringify(calls.map((c) => c.args)));
    });
  } finally {
    await server.stop();
    removeFixture(cwd);
  }

  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
