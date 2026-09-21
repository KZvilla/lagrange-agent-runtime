/** BE-036 / BE-037 — cancellation, traces and fixed audit sandbox policy. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-audit-lifecycle-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'antigravity.json'), JSON.stringify({
    permissions: { allow: ['read', 'commands'], deny: [], sandbox: true }
  }));
  const capture = path.join(dir, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  return { dir, capture };
}

function captures(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

async function main() {
  await group('BE-037: agy_audit no expone ni ejecuta sandbox', async () => {
    const f = fixture();
    const server = startServer({ cwd: f.dir, captureFile: f.capture });
    try {
      await server.initialize();
      const listed = await server.listTools();
      const tools = listed.result.tools;
      const audit = tools.find(t => t.name === 'agy_audit');
      const plan = tools.find(t => t.name === 'agy_plan');
      check('el schema de audit no contiene sandbox', !Object.hasOwn(audit.inputSchema.properties.permissions.properties, 'sandbox'));
      check('el schema compartido de plan conserva sandbox', Object.hasOwn(plan.inputSchema.properties.permissions.properties, 'sandbox'));

      const response = await server.callTool('agy_audit', {
        target: 'git diff',
        permissions: { sandbox: true }
      });
      const call = captures(f.capture).find(x => Array.isArray(x.args));
      const text = response.result.content[0].text;
      check('la llamada no pasa --sandbox aunque call y config pidan true', !call.args.includes('--sandbox'), JSON.stringify(call.args));
      check('el pie declara la política efectiva', text.includes('sandbox=false'), text.slice(-200));
    } finally {
      await server.stop();
      removeFixture(f.dir);
    }
  });

  await group('BE-036: timeout local silencioso no se inventa como cancelación', async () => {
    const anterior = process.env.STUB_HOLD_MS;
    process.env.STUB_HOLD_MS = '250';
    const f = fixture();
    const server = startServer({ cwd: f.dir, captureFile: f.capture });
    try {
      await server.initialize();
      const started = server.beginCallTool('agy_audit', { target: 'plan corto' }, 30);
      let vencio = false;
      try { await started.promise; } catch { vencio = true; }
      await wait(80);
      const temprano = captures(f.capture);
      check('el cliente vence localmente', vencio);
      check('sin notificación no se mata el proceso', !temprano.some(x => x.event === 'kill'), JSON.stringify(temprano));
      check('sin notificación no aparece cancel_requested', !server.stderr().includes('event=cancel_requested'), server.stderr());
      await wait(250);
      check('el runner termina y deja close/cleanup correlacionados',
        /trace=agy_audit:2:\d+ event=close/.test(server.stderr()) && /trace=agy_audit:2:\d+ event=cleanup/.test(server.stderr()),
        server.stderr());
    } finally {
      await server.stop();
      removeFixture(f.dir);
      if (anterior === undefined) delete process.env.STUB_HOLD_MS; else process.env.STUB_HOLD_MS = anterior;
    }
  });

  await group('BE-036: notifications/cancelled termina y no responde tarde', async () => {
    const anterior = process.env.STUB_HOLD_MS;
    process.env.STUB_HOLD_MS = '1000';
    const f = fixture();
    const server = startServer({ cwd: f.dir, captureFile: f.capture });
    try {
      await server.initialize();
      const started = server.beginCallTool('agy_audit', { target: 'plan largo' }, 180);
      await wait(30);
      server.notify('notifications/cancelled', { requestId: started.id, reason: 'test' });
      let sinRespuesta = false;
      try { await started.promise; } catch { sinRespuesta = true; }
      await wait(80);
      const eventos = captures(f.capture);
      const logs = server.stderr();
      check('el request cancelado no recibe respuesta tardía', sinRespuesta);
      check('terminateTree alcanza al hijo', eventos.some(x => x.event === 'kill'), JSON.stringify(eventos));
      check('la cancelación y cleanup comparten trace',
        /trace=agy_audit:2:\d+ event=cancel_requested/.test(logs) && /trace=agy_audit:2:\d+ event=cleanup/.test(logs), logs);
      check('el envelope registra el origen MCP', logs.includes('request=2 event=cancel_requested origin=mcp_notification'), logs);
    } finally {
      await server.stop();
      removeFixture(f.dir);
      if (anterior === undefined) delete process.env.STUB_HOLD_MS; else process.env.STUB_HOLD_MS = anterior;
    }
  });

  await group('BE-036: cerrar stdin cancela antes de dejar salir al servidor', async () => {
    const anterior = process.env.STUB_HOLD_MS;
    process.env.STUB_HOLD_MS = '1000';
    const f = fixture();
    const server = startServer({ cwd: f.dir, captureFile: f.capture });
    try {
      await server.initialize();
      const started = server.beginCallTool('agy_audit', { target: 'plan al perder transporte' }, 180);
      await wait(30);
      server.closeInput();
      let sinRespuesta = false;
      try { await started.promise; } catch { sinRespuesta = true; }
      await wait(80);
      const eventos = captures(f.capture);
      const logs = server.stderr();
      check('el cierre de transporte tampoco entrega respuesta', sinRespuesta);
      check('el cierre de stdin termina el hijo activo', eventos.some(x => x.event === 'kill'), JSON.stringify(eventos));
      check('la traza distingue transport_closed', logs.includes('event=cancel_requested origin=transport_closed'), logs);
      check('el runner registra cierre y cleanup', /event=close/.test(logs) && /event=cleanup/.test(logs), logs);
    } finally {
      await server.stop();
      removeFixture(f.dir);
      if (anterior === undefined) delete process.env.STUB_HOLD_MS; else process.env.STUB_HOLD_MS = anterior;
    }
  });

  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
