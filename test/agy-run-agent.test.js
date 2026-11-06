/**
 * FEAT-183 — `agy_run` puede pedir un agente de agy. El nombre se verifica con
 * `agy agents` antes de lanzar (fail-closed), el agente se registra en el hilo
 * y al retomar se compara con el registrado. `-c` + agent se rechaza porque el
 * hilo es desconocido.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const registry = require('../mcp-server/agents/registry.js');

const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
const esError = (r) => Boolean(r.result && r.result.isError);
const lanzamientos = (capture) => fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);
const valorDe = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const leerUso = (ruta) => { try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return {}; } };

async function main() {
  await group('FEAT-183: clasifica el tools: del agent.md', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-agente-home-'));
    const escribir = (nombre, tools) => {
      const dir = path.join(home, '.gemini', 'config', 'agents', nombre);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'agent.md'), `---\nname: ${nombre}\ntools:\n${tools.map(t => `    - ${t}`).join('\n')}\n---\n\n# Agente\n`);
    };
    try {
      escribir('solo-lectura', ['view_file', 'list_dir']);
      escribir('con-shell', ['view_file', 'run_command']);
      escribir('sin-tools', []);
      check('read-only', registry.clasificarAgente('solo-lectura', home) === 'read-only');
      check('run_command cuenta como escritura', registry.clasificarAgente('con-shell', home) === 'read/write');
      check('tools vacío es read-only', registry.clasificarAgente('sin-tools', home) === 'read-only');
      check('agente inexistente es unknown', registry.clasificarAgente('no-existe', home) === 'unknown');
    } finally {
      removeFixture(home);
    }
  });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-agent-'));
  const capture = path.join(cwd, 'capture.jsonl');
  const usageFile = path.join(cwd, 'uso', 'antigravity-usage.json');
  fs.writeFileSync(capture, '');
  const server = startServer({
    cwd,
    captureFile: capture,
    env: { STUB_AGENTS: 'lagrange-plan\nlagrange-alma\n', STUB_USAGE: '1', LAGRANGE_USAGE_FILE: usageFile }
  });

  try {
    await server.initialize();

    await group('FEAT-183: agente conocido y registro del hilo', async () => {
      const r = await server.callTool('agy_run', { prompt: 'x', agent: 'lagrange-plan' });
      check('corre', !esError(r), texto(r).slice(0, 400));
      const calls = lanzamientos(capture);
      check('un spawn', calls.length === 1, String(calls.length));
      check('--agent lagrange-plan', valorDe(calls[0].args, '--agent') === 'lagrange-plan', JSON.stringify(calls[0].args));
      const uso = leerUso(usageFile);
      const hilo = (uso.uso_por_hilo || {})['stub-conversation-id'];
      check('el hilo registra el agente', hilo && hilo.agente === 'lagrange-plan', JSON.stringify(hilo));
      check('el footer muestra el agente', /Agent: `lagrange-plan`/.test(texto(r)), texto(r).slice(-700));
      check('el footer muestra Agent tools', /Agent tools: `(read-only|read\/write|unknown)`/.test(texto(r)), texto(r).slice(-700));
    });

    await group('FEAT-183: retomar con el mismo agente no pasa --agent', async () => {
      const r = await server.callTool('agy_run', { prompt: 'y', conversation_id: 'stub-conversation-id', agent: 'lagrange-plan' });
      check('corre', !esError(r), texto(r).slice(0, 300));
      const calls = lanzamientos(capture);
      const ultimo = calls[calls.length - 1];
      check('--conversation', valorDe(ultimo.args, '--conversation') === 'stub-conversation-id', JSON.stringify(ultimo.args));
      check('sin --agent al retomar', !ultimo.args.includes('--agent'), JSON.stringify(ultimo.args));
      check('footer de hilo', /Thread agent: `lagrange-plan`/.test(texto(r)), texto(r).slice(-500));
    });

    await group('FEAT-183: retomar con otro agente falla antes de lanzar', async () => {
      const antes = lanzamientos(capture).length;
      const r = await server.callTool('agy_run', { prompt: 'z', conversation_id: 'stub-conversation-id', agent: 'lagrange-alma' });
      check('isError', esError(r), texto(r).slice(0, 300));
      check('explica el hilo', /nació con el agente/.test(texto(r)), texto(r).slice(0, 500));
      check('no lanzó', lanzamientos(capture).length === antes, String(lanzamientos(capture).length));
    });

    await group('FEAT-183: agente desconocido falla antes de lanzar', async () => {
      const antes = lanzamientos(capture).length;
      const r = await server.callTool('agy_run', { prompt: 'w', agent: 'no-existe' });
      check('isError', esError(r), texto(r).slice(0, 300));
      check('nombra el agente', /no resuelve el agente "no-existe"/.test(texto(r)), texto(r).slice(0, 500));
      check('no lanzó', lanzamientos(capture).length === antes, String(lanzamientos(capture).length));
    });

    await group('FEAT-183: -c + agent falla antes de lanzar', async () => {
      const antes = lanzamientos(capture).length;
      const r = await server.callTool('agy_run', { prompt: 'v', continue_session: true, agent: 'lagrange-plan' });
      check('isError', esError(r), texto(r).slice(0, 300));
      check('explica -c', /continue_session no puede cambiar el agente/.test(texto(r)), texto(r).slice(0, 500));
      check('no lanzó', lanzamientos(capture).length === antes, String(lanzamientos(capture).length));
    });

    await group('FEAT-183: hilo sin agente registrado + agent falla cerrado', async () => {
      const otroUso = path.join(cwd, 'uso2', 'antigravity-usage.json');
      fs.mkdirSync(path.dirname(otroUso), { recursive: true });
      fs.writeFileSync(otroUso, JSON.stringify({ uso_por_hilo: { 'viejo': { modelo: 'gemini-3.8-flash' } } }));
      const otro = startServer({
        cwd,
        captureFile: capture,
        env: { STUB_AGENTS: 'lagrange-plan\n', STUB_USAGE: '1', LAGRANGE_USAGE_FILE: otroUso }
      });
      try {
        await otro.initialize();
        const antes = lanzamientos(capture).length;
        const r = await otro.callTool('agy_run', { prompt: 'u', conversation_id: 'viejo', agent: 'lagrange-plan' });
        check('isError', esError(r), texto(r).slice(0, 300));
        check('no tiene agente registrado', /no tiene un agente registrado/.test(texto(r)), texto(r).slice(0, 500));
        check('no lanzó', lanzamientos(capture).length === antes, String(lanzamientos(capture).length));
      } finally {
        await otro.stop();
      }
    });

    await group('FEAT-183: agy agents falla → no lanza', async () => {
      const cwdFalla = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-agent-falla-'));
      const capFalla = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-agent-falla-cap-'));
      const captureFalla = path.join(capFalla, 'capture.jsonl');
      fs.writeFileSync(captureFalla, '');
      const s = startServer({ cwd: cwdFalla, captureFile: captureFalla, env: { STUB_AGENTS_ERROR: '1' } });
      try {
        await s.initialize();
        const r = await s.callTool('agy_run', { prompt: 'x', agent: 'lagrange-plan' });
        check('isError', esError(r), texto(r).slice(0, 300));
        check('explica la consulta', /no se pudo consultar `agy agents`/.test(texto(r)), texto(r).slice(0, 500));
        check('no filtró la salida cruda', !/ENOENT.*at /.test(texto(r)), texto(r).slice(0, 500));
        check('no lanzó', lanzamientos(captureFalla).length === 0, String(lanzamientos(captureFalla).length));
      } finally {
        await s.stop();
        removeFixture(cwdFalla);
        removeFixture(capFalla);
      }
    });

    await group('FEAT-183: agy agents cuelga → no lanza', async () => {
      const cwdHang = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-agent-hang-'));
      const capHang = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-agent-hang-cap-'));
      const captureHang = path.join(capHang, 'capture.jsonl');
      fs.writeFileSync(captureHang, '');
      const s = startServer({ cwd: cwdHang, captureFile: captureHang, env: { STUB_AGENTS_HANG_MS: '50' } });
      try {
        await s.initialize();
        const r = await s.callTool('agy_run', { prompt: 'x', agent: 'lagrange-plan' });
        check('isError', esError(r), texto(r).slice(0, 300));
        check('explica la consulta', /no se pudo consultar `agy agents`/.test(texto(r)), texto(r).slice(0, 500));
        check('no lanzó', lanzamientos(captureHang).length === 0, String(lanzamientos(captureHang).length));
      } finally {
        await s.stop();
        removeFixture(cwdHang);
        removeFixture(capHang);
      }
    });

    await group('FEAT-183: agentesResueltos propaga signal', async () => {
      const original = cp.execFile;
      let vistas = null;
      cp.execFile = function (file, args, opciones, cb) {
        vistas = opciones;
        const em = new EventEmitter();
        const timer = setTimeout(() => { if (cb) cb(new Error('timeout'), '', ''); }, 5000);
        if (opciones && opciones.signal) {
          opciones.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('aborted');
            err.name = 'AbortError';
            if (cb) cb(err, '', '');
          }, { once: true });
        }
        return em;
      };
      const ruta = require.resolve('../mcp-server/agents/registry.js');
      delete require.cache[ruta];
      try {
        const fresco = require(ruta);
        const control = new AbortController();
        const p = fresco.agentesResueltos('agy', { signal: control.signal });
        setTimeout(() => control.abort(), 10);
        const r = await p;
        check('signal llega a execFile', Boolean(vistas && vistas.signal === control.signal), String(Boolean(vistas && vistas.signal)));
        check('aborta la consulta', r.ok === false && /abort/i.test(r.motivo), JSON.stringify(r));
      } finally {
        cp.execFile = original;
        delete require.cache[ruta];
      }
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
