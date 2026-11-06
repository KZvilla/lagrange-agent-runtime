/**
 * BE-178 — `agy_run` rechaza un hilo nacido en el contenedor de solo lectura,
 * porque ese hilo vive en un volumen Docker y la tool corre en el host. El
 * footer de `agy_plan` deja de invitar a `agy_run` en ese caso. Además, el
 * label `(thread total)` también aplica a `continue_session`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const hilosAgy = require('../mcp-server/lib/hilos-agy.js');

const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
const esError = (r) => Boolean(r.result && r.result.isError);
const lanzamientos = (capture) => fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);

async function conServidor(env, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-hilos-'));
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-hilos-cap-'));
  const capture = path.join(captureDir, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const server = startServer({ cwd, captureFile: capture, env });
  try {
    await server.initialize();
    await fn({ server, capture, cwd });
  } finally {
    await server.stop();
    removeFixture(cwd);
    removeFixture(captureDir);
  }
}

async function main() {
  await group('BE-178: footer de agy_plan según aislamiento', () => {
    const host = hilosAgy.lineaDeHiloDePlan({ conversationId: 'abc', pie: 'Isolation: host — warning' });
    const cont = hilosAgy.lineaDeHiloDePlan({ conversationId: 'abc', pie: 'Isolation: container `ro-1` (snapshot)' });
    const cons = hilosAgy.lineaDeHiloDePlan({ conversationId: 'abc', pie: 'Isolation: container `ro-1`', modoConsulta: true });
    check('host invita a agy_run', /to `agy_run` to begin execution/.test(host), host);
    check('contenedor no invita a agy_run', /start a new `agy_run` with the plan text/.test(cont) && !/begin execution/.test(cont), cont);
    check('consulta pide follow-up', /ask a follow-up/.test(cons), cons);
    check('sin id no hay línea', hilosAgy.lineaDeHiloDePlan({ conversationId: null }) === '');
  });

  await group('BE-178: un hilo de contenedor se rechaza antes de lanzar', async () => {
    const soloDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-solo-'));
    fs.writeFileSync(path.join(soloDir, 'hilos.json'), JSON.stringify({
      hilos: {
        'ro-test': { volumen: 'vol-test', expira: Math.floor(Date.now() / 1000) + 3600, herramienta: 'plan' }
      }
    }));
    try {
      await conServidor({ LAGRANGE_SOLO_LECTURA_DIR: soloDir }, async ({ server, capture }) => {
        const r = await server.callTool('agy_run', { prompt: 'x', conversation_id: 'ro-test' });
        check('isError', esError(r), texto(r).slice(0, 300));
        check('nombra el contenedor', /contenedor de solo lectura/.test(texto(r)), texto(r).slice(0, 500));
        check('no lanzó', lanzamientos(capture).length === 0, String(lanzamientos(capture).length));
      });
    } finally {
      removeFixture(soloDir);
    }
  });

  await group('BE-178: continue_session marca los tokens como del hilo', async () => {
    const uso = path.join(os.tmpdir(), `agy-run-hilos-uso-${process.pid}.json`);
    fs.writeFileSync(uso, '{}');
    try {
      await conServidor({ STUB_USAGE: '1', LAGRANGE_USAGE_FILE: uso }, async ({ server }) => {
        const r = await server.callTool('agy_run', { prompt: 'x', continue_session: true });
        check('corre', !esError(r), texto(r).slice(0, 300));
        check('label thread total', /\(thread total\)/.test(texto(r)), texto(r).slice(-700));
      });
    } finally {
      try { fs.rmSync(uso, { force: true }); } catch {}
    }
  });

  await group('BE-178: la documentación no repite el default high', () => {
    const agente = fs.readFileSync(path.join(__dirname, '..', 'agents', 'agy.md'), 'utf8');
    const opencode = fs.readFileSync(path.join(__dirname, '..', '.opencode', 'agents', 'lagrange.md'), 'utf8');
    check('agents/agy.md', !/usually\s+`"?high"?`/.test(agente));
    check('.opencode/agents/lagrange.md', !/usually\s+`"?high"?`/.test(opencode));
  });

  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
