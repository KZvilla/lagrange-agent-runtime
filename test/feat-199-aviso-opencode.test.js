/**
 * FEAT-199 — Aviso de "informe listo" para opencode: al entregarse un informe de la cola, la sesión de opencode que lo
 * pidió recibe una nota en su inbox (`opencode api session.synthetic`, `delivery: "queue"`, `resume: true`: la despierta).
 * Unitarios con `runProcess` y `resolveBin` falsos, más un recorrido por MCP con `OPENCODE_BIN` apuntando a node.exe
 * (falla determinística: nunca se toca el opencode real).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');

const RAIZ = path.join(__dirname, '..');
const aviso = require(path.join(RAIZ, 'mcp-server', 'lib', 'aviso-opencode.js'));
const cola = require(path.join(RAIZ, 'mcp-server', 'lib', 'cola-auditorias.js'));

const texto = (r) => ((r && r.result && r.result.content) || []).map((c) => c.text || '').join('\n');
const esError = (r) => Boolean(r && r.result && r.result.isError);
const idDe = (t) => (/pedido `([0-9a-f]{6})` en la cola/.exec(t) || [])[1];

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'inicio');
  return dir;
}

async function conServidor(env, fn) {
  const s = startServer({ env });
  try { await s.initialize(); return await fn(s); } finally { await s.stop(); }
}

/** Un `runProcess` falso que anota cada llamada y devuelve `salida` (o lanza `error`). */
function falso({ salida = { code: 0, stdout: '{"data":{"type":"synthetic"}}', stderr: '' }, error = null } = {}) {
  const llamadas = [];
  const runProcess = async (bin, args, opts) => {
    llamadas.push({ bin, args, opts });
    if (error) throw error;
    return salida;
  };
  return { llamadas, runProcess, resolveBin: () => 'C:\\fake\\opencode.exe' };
}

async function main() {
  await group('a quién se avisa', async () => {
    check('opencode con ses_…', aviso.sesionDeSolicitante('opencode:ses_e18aa89f4ffeUu80') === 'ses_e18aa89f4ffeUu80');
    check('claude y agy: no', aviso.sesionDeSolicitante('claude:aaaa-bbbb') === null && aviso.sesionDeSolicitante('agy:15b94a2d') === null);
    check('opencode:anonimo: no es un session id', aviso.sesionDeSolicitante('opencode:anonimo') === null);

    for (const solicitante of ['claude:aaaaaaaa-0000-4000-8000-00000000000a', 'agy:15b94a2d-676a-4394', null, undefined]) {
      const f = falso();
      const r = await aviso.avisarOpencode({ solicitante, id: 'abc123', veredicto: 'PASS', ...f });
      check(`${solicitante}: ni spawn ni línea`, r === null && f.llamadas.length === 0 && aviso.lineaAviso(r) === '');
    }
    const f = falso();
    const r = await aviso.avisarOpencode({ solicitante: 'opencode:anonimo', id: 'abc123', veredicto: 'PASS', ...f });
    check('opencode sin session id válido: no lanza nada y lo dice', f.llamadas.length === 0 && r.avisado === false
      && /No se pudo avisar/.test(aviso.lineaAviso(r)));
  });

  await group('el llamado a opencode', async () => {
    const f = falso();
    const r = await aviso.avisarOpencode({ solicitante: 'opencode:ses_Popencode1', id: 'abc123', veredicto: 'PASS WITH RESERVATIONS', cwd: 'C:\\repo', ...f });
    check('avisado', r && r.avisado === true);
    check('un solo spawn', f.llamadas.length === 1);
    const { bin, args, opts } = f.llamadas[0];
    check('con el binario resuelto', bin === 'C:\\fake\\opencode.exe');
    check('api session.synthetic con el session id', JSON.stringify(args.slice(0, 4)) === JSON.stringify(['api', 'session.synthetic', '--param', 'sessionID=ses_Popencode1']) && args[4] === '-d');
    const cuerpo = JSON.parse(args[5]);
    check('queue y despierta la sesión (P2, v1.78.1)', cuerpo.delivery === 'queue' && cuerpo.resume === true);
    check('el texto nombra id, veredicto y la tool de opencode', cuerpo.text.includes('abc123') && cuerpo.text.includes('Verdict: PASS WITH RESERVATIONS')
      && cuerpo.text.includes('lagrange_audit_queue') && cuerpo.text.includes('"collect"') && cuerpo.text.includes('wait_seconds: 0'));
    check('metadata de Lagrange', cuerpo.metadata.lagrange.feat === 'FEAT-199' && cuerpo.metadata.lagrange.id === 'abc123');
    check('cwd y tope de 10 s', opts.cwd === 'C:\\repo' && opts.timeoutMs === 10_000);
    check('no pasa entorno propio (runProcess lo sanea)', !('env' in opts));
    check('línea de éxito', /inbox de la sesión de opencode/.test(aviso.lineaAviso(r)));
  });

  await group('los fallos no rompen y se explican en una línea', async () => {
    const r404 = await aviso.avisarOpencode({ solicitante: 'opencode:ses_Popencode1', id: 'abc123', veredicto: 'FAIL', ...falso({ salida: {
      code: 1, stdout: '{"_tag":"SessionNotFoundError","sessionID":"ses_Popencode1","message":"Session not found: ses_Popencode1"}', stderr: 'HTTP 404 Not Found\n'
    } }) });
    check('404: motivo del JSON de opencode', r404.avisado === false && r404.motivo === 'SessionNotFoundError: Session not found: ses_Popencode1', r404.motivo);
    const rErr = await aviso.avisarOpencode({ solicitante: 'opencode:ses_Popencode1', id: 'abc123', ...falso({ salida: { code: 2, stdout: '', stderr: '\n  connect ECONNREFUSED 127.0.0.1:10005\nmás\n' } }) });
    check('sin JSON: la primera línea de stderr', rErr.motivo === 'connect ECONNREFUSED 127.0.0.1:10005', rErr.motivo);
    const rMudo = await aviso.avisarOpencode({ solicitante: 'opencode:ses_Popencode1', id: 'abc123', ...falso({ salida: { code: 3, stdout: '', stderr: '' } }) });
    check('sin nada: el exit code', rMudo.motivo === 'opencode api salió con 3');
    const rTimeout = await aviso.avisarOpencode({ solicitante: 'opencode:ses_Popencode1', id: 'abc123', ...falso({ error: new Error('opencode timed out after 10000ms') }) });
    check('timeout: no lanza', rTimeout.avisado === false && /timed out/.test(rTimeout.motivo));
    const rSinBin = await aviso.avisarOpencode({ solicitante: 'opencode:ses_Popencode1', id: 'abc123', resolveBin: () => { throw new Error('opencode is not installed'); }, runProcess: async () => { throw new Error('no debería correr'); } });
    check('sin opencode instalado', rSinBin.avisado === false && /^sin opencode/.test(rSinBin.motivo));
    const largo = aviso.motivoDeSalida({ code: 1, stdout: '', stderr: 'x'.repeat(500) });
    check('motivo recortado', largo.length === 200);
  });

  const dir = repo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-data-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-cfg-'));
  try {
    await group('entregar devuelve el solicitante', () => {
      const p = cola.pedir({ cwd: dir, modo: 'plan', prompt: 'P', solicitante: 'opencode:ses_Qopencode2' });
      cola.tomar({ cwd: dir, id: p.id, yo: 'claude:auditor-x' });
      const e = cola.entregar({ cwd: dir, id: p.id, yo: 'claude:auditor-x', informe: '## Verdict: PASS\n\nBien.\n' });
      check('solicitante en el resultado', e.ok && e.solicitante === 'opencode:ses_Qopencode2', JSON.stringify(e));
    });

    const base = {
      LAGRANGE_AGY_MODO: 'manual',
      LAGRANGE_AGY_MODO_CONFIG: path.join(cfgDir, 'antigravity.json'),
      TELEGRAM_BRIDGE_DATA_DIR: dataDir,
      HOME: cfgDir,
      USERPROFILE: cfgDir,
      // node.exe en lugar de opencode: `node api …` sale con error y nunca se toca el opencode real.
      OPENCODE_BIN: process.execPath
    };
    const opencode = { ...base, LAGRANGE_HOST: 'opencode', CLAUDECODE: null, CLAUDE_PID: null };
    const auditor = { ...base, CLAUDECODE: '1', CLAUDE_PID: '535353', CLAUDE_CODE_SESSION_ID: 'dddddddd-0000-4000-8000-00000000000d' };
    const spica = { ...base, CLAUDECODE: '1', CLAUDE_PID: '545454', CLAUDE_CODE_SESSION_ID: 'eeeeeeee-0000-4000-8000-00000000000e' };

    let idO;
    let idC;
    await group('por MCP: pide opencode, entrega Claude', async () => {
      await conServidor(opencode, async (s) => {
        const r = await s.callTool('auditoria', { accion: 'pedir', target: 'diff', plan: 'P', session_id: 'ses_Popencode1', cwd: dir });
        idO = idDe(texto(r));
        check('pedido de opencode', Boolean(idO), texto(r).slice(0, 200));
      });
      await conServidor(spica, async (s) => {
        idC = idDe(texto(await s.callTool('auditoria', { accion: 'pedir', target: 'diff', plan: 'P', cwd: dir })));
        check('pedido de Claude', Boolean(idC));
      });
      await conServidor(auditor, async (s) => {
        await s.callTool('auditoria', { accion: 'tomar', id: idO, cwd: dir });
        const e = await s.callTool('auditoria', { accion: 'entregar', id: idO, informe: '## Verdict: PASS\n\nBien.\n', cwd: dir });
        check('la entrega sale bien aunque el aviso falle', !esError(e) && texto(e).includes('entregado'), texto(e).slice(0, 300));
        check('y dice que no pudo avisar a opencode', texto(e).includes('No se pudo avisar a opencode'), texto(e));
        check('el motivo no filtra el entorno', !texto(e).includes(dataDir) && !texto(e).includes('TELEGRAM'));

        await s.callTool('auditoria', { accion: 'tomar', id: idC, cwd: dir });
        const c = await s.callTool('auditoria', { accion: 'entregar', id: idC, informe: '## Verdict: PASS\n\nBien.\n', cwd: dir });
        check('pedido de Claude: sin línea de opencode', !esError(c) && !/opencode/.test(texto(c)), texto(c));
      });
    });
  } finally {
    removeFixture(dir);
    removeFixture(dataDir);
    removeFixture(cfgDir);
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
