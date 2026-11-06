/**
 * BE-179 — Tope de concurrencia en proceso para `agy_run`. El semáforo es FIFO,
 * libera el slot en error y una cancelación mientras espera no lanza el trabajo.
 * `agy_fanout` conserva su propio tope por lote.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const { crearLimite, maxDeEntorno } = require('../mcp-server/lib/limite-agy.js');

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lanzamientos = (capture) => fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);

async function main() {
  await group('BE-179: max=1 serializa y respeta el orden', async () => {
    const limite = crearLimite({ max: 1 });
    const orden = [];
    const uno = limite.ejecutar(async () => { orden.push('uno'); await dormir(40); orden.push('uno-fin'); });
    const dos = limite.ejecutar(async () => { orden.push('dos'); });
    await Promise.resolve();
    check('uno corre', orden[0] === 'uno', JSON.stringify(orden));
    check('dos espera', limite.estado().esperando === 1, JSON.stringify(limite.estado()));
    await Promise.all([uno, dos]);
    check('orden FIFO', orden.join(',') === 'uno,uno-fin,dos', JSON.stringify(orden));
    check('vuelve a cero', limite.estado().activos === 0 && limite.estado().esperando === 0, JSON.stringify(limite.estado()));
  });

  await group('BE-179: una cancelación en cola no lanza el trabajo', async () => {
    const limite = crearLimite({ max: 1 });
    const control = new AbortController();
    let corrio = false;
    const uno = limite.ejecutar(async () => { await dormir(40); });
    const dos = limite.ejecutar(async () => { corrio = true; }, { signal: control.signal });
    await Promise.resolve();
    control.abort();
    let error = null;
    try { await dos; } catch (err) { error = err; }
    await uno;
    check('AbortError', error && error.name === 'AbortError', String(error && error.name));
    check('no corrió', corrio === false);
    check('cola vacía', limite.estado().esperando === 0, JSON.stringify(limite.estado()));
  });

  await group('BE-179: un error libera el slot', async () => {
    const limite = crearLimite({ max: 1 });
    let error = null;
    try { await limite.ejecutar(async () => { throw new Error('falló'); }); } catch (err) { error = err; }
    check('propaga el error', error && error.message === 'falló', String(error && error.message));
    check('slot libre', limite.estado().activos === 0, JSON.stringify(limite.estado()));
    const siguiente = await limite.ejecutar(async () => 'ok');
    check('el siguiente corre', siguiente === 'ok');
  });

  await group('BE-179: AGY_RUN_MAX_CONCURRENT válido e inválido', () => {
    check('default 2', maxDeEntorno({}).max === 2 && maxDeEntorno({}).aviso === null);
    check('1 válido', maxDeEntorno({ AGY_RUN_MAX_CONCURRENT: '1' }).max === 1);
    const malo = maxDeEntorno({ AGY_RUN_MAX_CONCURRENT: '9' });
    check('9 cae a 2', malo.max === 2 && /se ignora/.test(malo.aviso || ''), JSON.stringify(malo));
    const texto = maxDeEntorno({ AGY_RUN_MAX_CONCURRENT: 'abc' });
    check('abc cae a 2', texto.max === 2 && /se ignora/.test(texto.aviso || ''), JSON.stringify(texto));
  });

  await group('BE-179: integración con agy_run (max=1)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-limite-'));
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-limite-cap-'));
    const capture = path.join(captureDir, 'capture.jsonl');
    fs.writeFileSync(capture, '');
    const server = startServer({
      cwd,
      captureFile: capture,
      env: { AGY_RUN_MAX_CONCURRENT: '1', STUB_HOLD_MS: '250' }
    });
    try {
      await server.initialize();
      const uno = server.beginCallTool('agy_run', { prompt: 'uno' });
      const dos = server.beginCallTool('agy_run', { prompt: 'dos' });
      await dormir(100);
      check('solo uno lanzado', lanzamientos(capture).length === 1, String(lanzamientos(capture).length));
      const [r1, r2] = await Promise.all([uno.promise, dos.promise]);
      check('los dos terminan', !r1.result?.isError && !r2.result?.isError, `${JSON.stringify(r1.result?.isError)} ${JSON.stringify(r2.result?.isError)}`);
      check('dos lanzados al final', lanzamientos(capture).length === 2, String(lanzamientos(capture).length));
    } finally {
      await server.stop();
      removeFixture(cwd);
      removeFixture(captureDir);
    }
  });

  await group('BE-179: no envuelve plan/review/audit', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-limite-otros-'));
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-limite-otros-cap-'));
    const capture = path.join(captureDir, 'capture.jsonl');
    fs.writeFileSync(capture, '');
    const server = startServer({
      cwd,
      captureFile: capture,
      env: { AGY_RUN_MAX_CONCURRENT: '1', STUB_HOLD_MS: '800' }
    });
    try {
      await server.initialize();
      const run = server.beginCallTool('agy_run', { prompt: 'run' });
      await dormir(50);
      const plan = server.beginCallTool('agy_plan', { task: 'plan' });
      const review = server.beginCallTool('agy_review', { review_target: 'diff' });
      const audit = server.beginCallTool('agy_audit', { target: 'diff' });
      await dormir(200);
      check('los cuatro lanzados aunque el slot esté ocupado', lanzamientos(capture).length === 4, String(lanzamientos(capture).length));
      const [rRun, rPlan, rReview, rAudit] = await Promise.all([run.promise, plan.promise, review.promise, audit.promise]);
      check('los cuatro terminan', [rRun, rPlan, rReview, rAudit].every((r) => !r.result?.isError), JSON.stringify([rRun.result?.isError, rPlan.result?.isError, rReview.result?.isError, rAudit.result?.isError]));
    } finally {
      await server.stop();
      removeFixture(cwd);
      removeFixture(captureDir);
    }
  });

  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
