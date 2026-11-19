/**
 * FEAT-202 S1 — El respaldo en un módulo (`motores/respaldo.js`) y el modo manual decidido en un solo lugar
 * (`motores/manual.js`). Sin cambios de comportamiento: los tests de siempre (fallback-agy, feat-167, 173, 175, 191,
 * be-180) siguen pasando; acá se fija la forma nueva.
 */
const fs = require('node:fs');
const path = require('node:path');

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');
const respaldo = require(path.join(MCP, 'motores', 'respaldo.js'));
const { destinoManual } = require(path.join(MCP, 'motores', 'manual.js'));

/** Reemplaza los caminos del módulo por espías mientras corre `fn`. */
async function conEspias(fn) {
  const nombres = ['conFallback', 'conFallbackLectura', 'conFallbackDeRol', 'conRespaldoEnAgy'];
  const originales = Object.fromEntries(nombres.map((n) => [n, respaldo[n]]));
  const llamadas = [];
  for (const n of nombres) respaldo[n] = async (...args) => { llamadas.push({ n, args }); return { n }; };
  try { await fn(llamadas); } finally { Object.assign(respaldo, originales); }
}

async function main() {
  await group('un solo módulo', async () => {
    check('lib/fallback-agy.js es el mismo objeto (reexport)', require(path.join(MCP, 'lib', 'fallback-agy.js')) === respaldo);
    const usos = [];
    const recorrer = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) { if (!['node_modules', 'vendor', 'test'].includes(f.name)) recorrer(p); } else if (/\.(js|mjs)$/.test(f.name) && /fallback-agy\.js['"]\)/.test(fs.readFileSync(p, 'utf8'))) usos.push(path.relative(RAIZ, p));
      }
    };
    recorrer(path.join(RAIZ, 'mcp-server'));
    recorrer(path.join(RAIZ, 'telegram-bridge'));
    check('el código del plugin ya no carga lib/fallback-agy.js', usos.length === 0, usos.join(', '));
    const llamadores = ['mcp-server/index.js', 'mcp-server/almas/charla.js', 'mcp-server/almas/consolidar.js', 'mcp-server/agents/cast.js']
      .map((r) => [r, fs.readFileSync(path.join(RAIZ, r), 'utf8')]);
    const directos = llamadores.filter(([, s]) => /\.(conFallback|conFallbackLectura|conFallbackDeRol|conRespaldoEnAgy)\(/.test(s)).map(([r]) => r);
    check('los llamadores entran por conRespaldo', directos.length === 0, directos.join(', '));
  });

  await group('conRespaldo: cada tipo, su camino', async () => {
    await conEspias(async (llamadas) => {
      const agy = { motor: { id: 'antigravity' } };
      const go = { motor: { id: 'opencode-go' } };
      await respaldo.conRespaldo('textos', { prompt: 'x' });
      await respaldo.conRespaldo('lectura', { modelo: 'm' });
      await respaldo.conRespaldo('alma', { eleccion: agy });
      await respaldo.conRespaldo('consolidar', { eleccion: agy });
      await respaldo.conRespaldo('cast', { eleccion: agy, permitido: true });
      const caminos = llamadas.map((l) => l.n).join();
      check('textos, lectura, alma, consolidar, cast', caminos === 'conFallback,conFallbackLectura,conFallbackDeRol,conFallbackDeRol,conFallbackDeRol', caminos);
      check('los de rol reciben su tipo', llamadas.slice(2).map((l) => l.args[0].tipo).join() === 'alma,consolidar,cast');
      check('las opciones pasan tal cual', llamadas[0].args[0].prompt === 'x' && llamadas[1].args[0].modelo === 'm' && llamadas[4].args[0].permitido === true);
      llamadas.length = 0;
      const intentar = async () => ({});
      await respaldo.conRespaldo('alma', { eleccion: go, intentar });
      await respaldo.conRespaldo('consolidar', { eleccion: go, intentar });
      await respaldo.conRespaldo('cast', { eleccion: go, intentar });
      const go3 = llamadas.map((l) => l.n).join();
      check('FEAT-173/175: alma y consolidar en opencode-go reintentan en agy; cast no', go3 === 'conRespaldoEnAgy,conRespaldoEnAgy,conFallbackDeRol', go3);
      check('conRespaldoEnAgy recibe la elección y el intento', llamadas[0].args[0] === go && llamadas[0].args[1] === intentar);
    });
    let lanzo = false;
    try { respaldo.conRespaldo('voz', {}); } catch { lanzo = true; }
    check('un tipo desconocido lanza', lanzo);
  });

  await group('conRespaldoEnAgy en modo manual: no lanza agy', async () => {
    const previo = process.env.LAGRANGE_AGY_MODO;
    process.env.LAGRANGE_AGY_MODO = 'manual';
    try {
      const vistos = [];
      const intentar = async (e) => { vistos.push(e.motor.id); return { resultado: { ok: false, error: 'Go caído' } }; };
      const r = await respaldo.conRespaldo('alma', { eleccion: { motor: { id: 'opencode-go' } }, intentar });
      check('un solo intento, en Go', vistos.join() === 'opencode-go', vistos.join());
      check('el error dice que no hay respaldo', /modo manual/.test(r.resultado.error));
    } finally {
      if (previo === undefined) delete process.env.LAGRANGE_AGY_MODO; else process.env.LAGRANGE_AGY_MODO = previo;
    }
  });

  await group('destinoManual (D8)', async () => {
    const d = (herramienta, args = {}, extra = {}) => destinoManual({ herramienta, args, manual: true, ...extra });
    check('sin modo manual, todo normal', ['agy_run', 'agy_plan', 'agy_image'].every((h) => destinoManual({ herramienta: h, args: {}, manual: false }) === 'normal'));
    check('plan, review y audit sin engine: cola', ['agy_plan', 'agy_review', 'agy_audit'].every((h) => d(h) === 'cola'));
    check('con engine agy: cola', d('agy_audit', { engine: 'agy' }) === 'cola');
    check('con engine opencode-go o deepseek: normal', d('agy_audit', { engine: 'opencode-go' }) === 'normal' && d('agy_plan', { engine: 'deepseek' }) === 'normal');
    check('con una elección resuelta a otro motor: normal (S3)', d('agy_review', {}, { eleccion: { motor: { id: 'opencode-go' } } }) === 'normal');
    check('con una elección resuelta a antigravity: cola', d('agy_review', {}, { eleccion: { motor: 'antigravity' } }) === 'cola');
    check('run, research, image y fanout: rechazo', ['agy_run', 'agy_research', 'agy_image', 'agy_fanout'].every((h) => d(h) === 'rechazo'));
    check('voice_stream: start, send y confirm se frenan; status no', d('agy_voice_stream') === 'rechazo' && d('agy_voice_stream', { action: 'send' }) === 'rechazo' && d('agy_voice_stream', { action: 'status' }) === 'normal');
    check('cast_agent: list y register se frenan; cast va por el respaldo', d('cast_agent', { action: 'list' }) === 'rechazo' && d('cast_agent', { action: 'cast' }) === 'normal');
    check('alma agente se frena', d('alma', { action: 'agente' }) === 'rechazo' && d('alma', { action: 'listar' }) === 'normal');
    check('batch: con agy se frena; con claude@ o estado, no', d('agy_lote', { accion: 'lanzar' }) === 'rechazo' && d('agy_lote', { accion: 'lanzar', motor: 'claude@trabajo' }) === 'normal' && d('agy_lote', { accion: 'estado' }) === 'normal');
    check('los textos van por su respaldo', d('agy_session_summary') === 'normal' && d('narrate') === 'normal');
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
