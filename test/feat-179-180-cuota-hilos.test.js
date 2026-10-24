/**
 * FEAT-179 — Una tool de agy no espera 10–30 min para enterarse de que no hay
 * cuota: con el grupo agotado falla antes de lanzar, y el primer error de cuota
 * deja la ventana de su grupo para el siguiente pedido.
 * FEAT-180 — Al retomar un hilo no se pasa --model ni --effort (agy conserva
 * los del hilo), la salida muestra el modelo registrado o «unknown», y pedir
 * otro modelo para un hilo existente falla antes de lanzar.
 *
 * Servidor MCP real con agy stubbeado. El archivo de uso es un temporal
 * (LAGRANGE_USAGE_FILE): nunca el ~/.claude/antigravity-usage.json real.
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
const CUOTA = 'Individual quota reached. Resets in 2h0m0s';
const EN_UNA_HORA = () => new Date(Date.now() + 3600_000).toISOString();

async function conServidor({ uso = null, env = {} } = {}, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-179-'));
  const capture = path.join(cwd, 'capture.jsonl');
  const archivoUso = path.join(cwd, 'uso', 'antigravity-usage.json');
  fs.writeFileSync(capture, '');
  if (uso) {
    fs.mkdirSync(path.dirname(archivoUso), { recursive: true });
    fs.writeFileSync(archivoUso, JSON.stringify(uso));
  }
  const todo = { LAGRANGE_USAGE_FILE: archivoUso, ...env };
  const previo = {};
  for (const [k, v] of Object.entries(todo)) { previo[k] = process.env[k]; process.env[k] = v; }
  const server = startServer({ cwd, captureFile: capture });
  const leerUso = () => { try { return JSON.parse(fs.readFileSync(archivoUso, 'utf8')); } catch { return {}; } };
  try {
    await server.initialize();
    await fn({ server, capture, leerUso });
  } finally {
    await server.stop();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    removeFixture(cwd);
  }
}

async function main() {
  // Otra sesión puede usar agy mientras corre la suite: se mira solo lo que escribiría este test.
  const usoReal = path.join(os.userInfo().homedir, '.claude', 'antigravity-usage.json');
  const inicio = Date.now();
  const delTest = () => {
    try {
      const h = (JSON.parse(fs.readFileSync(usoReal, 'utf8')).uso_por_hilo || {})['stub-conversation-id'];
      return Boolean(h && h.visto_en && Date.parse(h.visto_en) >= inicio);
    } catch { return false; }
  };

  await group('FEAT-179: grupo agotado sin fallback → falla antes de lanzar', async () => {
    const uso = { fallback: { cuotaPorGrupo: { gemini: { hasta: EN_UNA_HORA(), visto_en: new Date().toISOString() } } } };
    await conServidor({ uso }, async ({ server, capture }) => {
      const run = await server.callTool('agy_run', { prompt: 'x', model: 'gemini-3.8-flash', effort: 'low' });
      check('agy_run: error con el grupo', esError(run) && /grupo gemini/.test(texto(run)), texto(run).slice(0, 300));
      check('agy_run: el pie dice que no se lanzó nada', texto(run).includes('Isolation: none (quota preflight; nothing was launched)'));
      const audit = await server.callTool('agy_audit', { target: 'git diff', model: 'gemini-3.8-flash', effort: 'high' });
      check('agy_audit: error rápido', esError(audit) && /grupo gemini/.test(texto(audit)), texto(audit).slice(0, 300));
      check('agy_audit: el pie no dice null', texto(audit).includes('Isolation: none (quota preflight; nothing was launched)') && !/Isolation: null/.test(texto(audit)), texto(audit).slice(-300));
      const research = await server.callTool('agy_research', { topic: 'x', model: 'gemini-3.8-flash', effort: 'low', permissions: { allow: ['read', 'network'], deny: [] } });
      check('agy_research: error rápido', esError(research) && /grupo gemini/.test(texto(research)), texto(research).slice(0, 300));
      check('nada se lanzó', lanzamientos(capture).length === 0, String(lanzamientos(capture).length));
      const otro = await server.callTool('agy_run', { prompt: 'x', model: 'claude-sonnet-5-5-medium' });
      check('un modelo de otro grupo corre', !esError(otro) && lanzamientos(capture).length === 1, texto(otro).slice(0, 300));
    });
  });

  await group('FEAT-179: el primer error de cuota deja la ventana del grupo', async () => {
    await conServidor({ env: { STUB_FAIL_STDERR: CUOTA } }, async ({ server, capture, leerUso }) => {
      const r1 = await server.callTool('agy_plan', { task: 'x', model: 'gemini-3.8-flash', effort: 'low' });
      check('la primera corrida lanza agy y falla', esError(r1) && lanzamientos(capture).length === 1, texto(r1).slice(0, 300));
      const f = leerUso().fallback || {};
      check('queda la ventana de gemini', f.cuotaPorGrupo && Date.parse(f.cuotaPorGrupo.gemini.hasta) > Date.now(), JSON.stringify(f));
      check('y no la global', !f.cuotaHasta, JSON.stringify(f));
      const r2 = await server.callTool('agy_review', { review_target: 'x', model: 'gemini-3.8-flash', effort: 'low' });
      check('la segunda no lanza agy', esError(r2) && lanzamientos(capture).length === 1, texto(r2).slice(0, 300));
    });
  });

  await group('FEAT-180: hilo nuevo sin usage deja el modelo; retomar no pasa --model ni --effort', async () => {
    await conServidor({}, async ({ server, capture, leerUso }) => {
      const nuevo = await server.callTool('agy_run', { prompt: 'x', model: 'gemini-3.8-flash', effort: 'low' });
      check('hilo nuevo corre', !esError(nuevo), texto(nuevo).slice(0, 300));
      const h = (leerUso().uso_por_hilo || {})['stub-conversation-id'] || {};
      check('el registro guarda modelo, esfuerzo y tool', h.modelo === 'gemini-3.8-flash' && h.esfuerzo === 'low' && h.herramienta === 'run', JSON.stringify(h));

      const sigue = await server.callTool('agy_run', { prompt: 'y', conversation_id: 'stub-conversation-id' });
      const argv = lanzamientos(capture)[1].args;
      check('retomar: sin --model ni --effort', !argv.includes('--model') && !argv.includes('--effort') && valorDe(argv, '--conversation') === 'stub-conversation-id', JSON.stringify(argv));
      check('la salida muestra el modelo del hilo', /Thread model: `gemini-3\.8-flash`/.test(texto(sigue)) && /Thread effort: `low`/.test(texto(sigue)), texto(sigue).slice(-500));

      const igual = await server.callTool('agy_audit', { target: 'x', conversation_id: 'stub-conversation-id', model: 'gemini-3.8-flash' });
      const argvIgual = lanzamientos(capture)[2].args;
      check('mismo modelo: corre sin --model', !esError(igual) && !argvIgual.includes('--model'), texto(igual).slice(0, 300));

      const antes = lanzamientos(capture).length;
      const distinto = await server.callTool('agy_review', { review_target: 'x', conversation_id: 'stub-conversation-id', model: 'claude-sonnet-5-5-medium' });
      check('otro modelo: error antes de lanzar con las dos salidas', esError(distinto) && /nació con gemini-3\.8-flash/.test(texto(distinto)) && /hilo nuevo/.test(texto(distinto)), texto(distinto).slice(0, 400));
      check('y no se lanzó', lanzamientos(capture).length === antes);

      const desconocido = await server.callTool('agy_plan', { task: 'x', conversation_id: 'hilo-que-nadie-registro' });
      check('hilo desconocido: no se inventa el modelo', /Thread model: `unknown \(created before Lagrange recorded it\)`/.test(texto(desconocido)), texto(desconocido).slice(-500));
    });
  });

  await group('FEAT-180: continue_session', async () => {
    await conServidor({ env: { STUB_USAGE: '1' } }, async ({ server, capture, leerUso }) => {
      await server.callTool('agy_run', { prompt: 'x', model: 'gemini-3.8-flash', effort: 'high' });
      check('con usage también se anota el modelo', ((leerUso().uso_por_hilo || {})['stub-conversation-id'] || {}).modelo === 'gemini-3.8-flash', JSON.stringify(leerUso().uso_por_hilo));
      const c = await server.callTool('agy_run', { prompt: 'y', continue_session: true });
      const argv = lanzamientos(capture)[1].args;
      check('-c sin --model ni --effort', argv.includes('-c') && !argv.includes('--model') && !argv.includes('--effort'), JSON.stringify(argv));
      check('muestra el modelo del hilo que volvió, sin null', /Thread model: `gemini-3\.8-flash`/.test(texto(c)) && !/null/.test(texto(c)), texto(c).slice(-500));
      const h = (leerUso().uso_por_hilo || {})['stub-conversation-id'] || {};
      check('el turno 2 no pisó el modelo ni el esfuerzo', h.modelo === 'gemini-3.8-flash' && h.esfuerzo === 'high', JSON.stringify(h));
      const antes = lanzamientos(capture).length;
      const conModelo = await server.callTool('agy_run', { prompt: 'z', continue_session: true, model: 'gemini-3.8-flash' });
      check('continue_session + model: error antes de lanzar', esError(conModelo) && /continue_session no puede cambiar el modelo/.test(texto(conModelo)) && lanzamientos(capture).length === antes, texto(conModelo).slice(0, 300));
    });
  });

  await group('FEAT-179: el archivo de uso real no cambia', () => {
    check('~/.claude/antigravity-usage.json sin el hilo del stub', !delTest());
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
