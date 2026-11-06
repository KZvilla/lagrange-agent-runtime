/**
 * FEAT-185 fase 1 — `agy_run` negocia el protocolo MCP y, solo con
 * 2025-06-18, declara `outputSchema` y devuelve `structuredContent`. Con
 * 2024-11-05 el contrato sigue siendo texto.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
const esError = (r) => Boolean(r.result && r.result.isError);

async function conServidor(protocolVersion, fn, env = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-estr-'));
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-estr-cap-'));
  const capture = path.join(captureDir, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const server = startServer({ cwd, captureFile: capture, env: { STUB_USAGE: '1', ...env } });
  try {
    const init = await server.initialize(undefined, protocolVersion);
    await fn({ server, init, capture });
  } finally {
    await server.stop();
    removeFixture(cwd);
    removeFixture(captureDir);
  }
}

async function main() {
  await group('FEAT-185: 2025-06-18 declara outputSchema y devuelve structuredContent', async () => {
    await conServidor('2025-06-18', async ({ server, init }) => {
      check('negocia la versión', init.result.protocolVersion === '2025-06-18', JSON.stringify(init.result));
      const listado = await server.listTools();
      const tools = (listado.result || {}).tools || [];
      const run = tools.find((t) => t.name === 'agy_run');
      const plan = tools.find((t) => t.name === 'agy_plan');
      check('agy_run tiene outputSchema', Boolean(run && run.outputSchema), JSON.stringify(run && Object.keys(run)));
      check('las demás no', Boolean(plan && !plan.outputSchema), JSON.stringify(plan && Object.keys(plan || {})));
      check('el schema exige agent_tools', Boolean(run && run.outputSchema && Array.isArray(run.outputSchema.required) && run.outputSchema.required.includes('agent_tools')));

      const r = await server.callTool('agy_run', { prompt: 'x' });
      check('corre', !esError(r), texto(r).slice(0, 300));
      const sc = (r.result || {}).structuredContent;
      check('structuredContent existe', Boolean(sc), JSON.stringify(r.result || {}).slice(0, 400));
      const campos = ['conversation_id', 'model', 'effort', 'agent', 'agent_tools', 'mode', 'permissions',
        'cwd', 'duration_seconds', 'usage', 'changed_files', 'working_tree', 'isolation', 'success', 'error'];
      check('trae todos los campos', sc && campos.every((c) => c in sc), JSON.stringify(sc));
      check('conversation_id', sc.conversation_id === 'stub-conversation-id', sc.conversation_id);
      check('isolation host', sc.isolation === 'host', sc.isolation);
      check('agent_tools enum', ['read-only', 'read/write', 'unknown'].includes(sc.agent_tools), sc.agent_tools);
      check('working_tree enum', ['changed', 'clean', 'not_checked'].includes(sc.working_tree), sc.working_tree);
      check('usage presente', sc.usage && sc.usage.input_tokens === 10, JSON.stringify(sc.usage));
      check('success', sc.success === true, String(sc.success));
      check('sin output_schema, output null', sc.output === null && sc.output_error === null, JSON.stringify({ output: sc.output, output_error: sc.output_error }));
      check('el texto sigue', texto(r).includes('STUBBED RESPONSE'), texto(r).slice(0, 200));
    });
  });

  await group('FEAT-185: 2024-11-05 conserva el contrato viejo', async () => {
    await conServidor('2024-11-05', async ({ server, init }) => {
      check('negocia la versión vieja', init.result.protocolVersion === '2024-11-05', JSON.stringify(init.result));
      const listado = await server.listTools();
      const run = ((listado.result || {}).tools || []).find((t) => t.name === 'agy_run');
      check('sin outputSchema', Boolean(run && !run.outputSchema), JSON.stringify(run && Object.keys(run || {})));
      const r = await server.callTool('agy_run', { prompt: 'x' });
      check('sin structuredContent', !(r.result || {}).structuredContent, JSON.stringify(r.result || {}).slice(0, 300));
      check('el texto sigue', texto(r).includes('STUBBED RESPONSE'), texto(r).slice(0, 200));
    });
  });

  await conServidor('2099-01-01', async ({ init }) => {
    await group('FEAT-185: una versión desconocida cae a 2024-11-05', () => {
      check('protocolVersion vieja', init.result.protocolVersion === '2024-11-05', JSON.stringify(init.result));
    });
  });

  await group('FEAT-185 fase 2: output_schema válido se pasa por temporal y se parsea', async () => {
    const schemaCapture = path.join(os.tmpdir(), `agy-run-schema-${process.pid}.json`);
    try {
      await conServidor('2025-06-18', async ({ server, capture }) => {
        const r = await server.callTool('agy_run', {
          prompt: 'x',
          output_schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] }
        });
        check('corre', !esError(r), texto(r).slice(0, 400));
        const calls = fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);
        const args = calls[0].args;
        const i = args.indexOf('--json-schema');
        check('--json-schema con ruta', i >= 0 && typeof args[i + 1] === 'string', JSON.stringify(args));
        const schema = JSON.parse(fs.readFileSync(schemaCapture, 'utf8'));
        check('el temporal tiene el schema', schema.required && schema.required.includes('answer'), JSON.stringify(schema));
        const sc = (r.result || {}).structuredContent;
        check('output parseado', sc && sc.output && sc.output.answer === 42, JSON.stringify(sc && sc.output));
        check('sin output_error', sc && sc.output_error === null, String(sc && sc.output_error));
        check('el texto lo dice', /Structured output: parsed/.test(texto(r)), texto(r).slice(-700));
      }, { STUB_RESPONSE: '{"answer":42}', STUB_CAPTURE_SCHEMA: schemaCapture });
    } finally {
      try { fs.rmSync(schemaCapture, { force: true }); } catch {}
    }
  });

  await group('FEAT-185 fase 2: prefiere structured_output', async () => {
    await conServidor('2025-06-18', async ({ server }) => {
      const r = await server.callTool('agy_run', {
        prompt: 'x',
        output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
      });
      const sc = (r.result || {}).structuredContent;
      check('output desde structured_output', sc && sc.output && sc.output.ok === true, JSON.stringify(sc && sc.output));
      check('sin output_error', sc && sc.output_error === null, String(sc && sc.output_error));
    }, { STUB_RESPONSE: '{"ok":true}\n{"ok":true}\n', STUB_STRUCTURED_OUTPUT: '{"ok":true}' });
  });

  await group('FEAT-185 fase 2: tolera response con varios JSON', async () => {
    await conServidor('2025-06-18', async ({ server }) => {
      const r = await server.callTool('agy_run', {
        prompt: 'x',
        output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
      });
      const sc = (r.result || {}).structuredContent;
      check('output desde la última línea', sc && sc.output && sc.output.ok === true, JSON.stringify(sc && sc.output));
      check('sin output_error', sc && sc.output_error === null, String(sc && sc.output_error));
    }, { STUB_RESPONSE: '{"ok":true}\n{"ok":true}\n' });
  });

  await group('FEAT-185 fase 2: JSON inválido no falla el turno', async () => {
    await conServidor('2025-06-18', async ({ server }) => {
      const r = await server.callTool('agy_run', {
        prompt: 'x',
        output_schema: { type: 'object', properties: { answer: { type: 'number' } } }
      });
      check('no es isError', !esError(r), texto(r).slice(0, 400));
      const sc = (r.result || {}).structuredContent;
      check('output null', sc && sc.output === null, JSON.stringify(sc && sc.output));
      check('output_error', sc && /valid JSON/.test(sc.output_error || ''), String(sc && sc.output_error));
      check('el texto lo dice', /Structured output: not parsed/.test(texto(r)), texto(r).slice(-700));
    }, { STUB_RESPONSE: 'not json' });
  });

  await group('FEAT-185 fase 2: un schema demasiado grande falla antes de lanzar', async () => {
    await conServidor('2025-06-18', async ({ server, capture }) => {
      const enorme = { type: 'object', properties: { x: { type: 'string', description: 'x'.repeat(17 * 1024) } } };
      const r = await server.callTool('agy_run', { prompt: 'x', output_schema: enorme });
      check('isError', esError(r), texto(r).slice(0, 300));
      check('explica el límite', /excede el límite/.test(texto(r)), texto(r).slice(0, 400));
      const calls = fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);
      check('no lanzó', calls.length === 0, String(calls.length));
    });
  });

  await group('FEAT-185: el error conserva structuredContent con 2025-06-18', async () => {
    await conServidor('2025-06-18', async ({ server }) => {
      const r = await server.callTool('agy_run', { prompt: 'x' });
      check('isError', esError(r), texto(r).slice(0, 300));
      const sc = (r.result || {}).structuredContent;
      check('structuredContent existe', Boolean(sc), JSON.stringify(r.result || {}).slice(0, 400));
      check('success false', sc && sc.success === false, String(sc && sc.success));
      check('error poblado', sc && typeof sc.error === 'string' && sc.error.length > 0, String(sc && sc.error));
      check('el texto sigue', /Error executing Antigravity subagent/.test(texto(r)), texto(r).slice(0, 300));
    }, { STUB_FAIL_STDERR: 'fallo controlado' });
  });

  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
