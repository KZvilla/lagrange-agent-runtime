/**
 * FEAT-195 Fase 2 — La tool MCP `auditoria` de punta a punta: dos sesiones de Claude Code (Spica pide, Epikouros
 * audita), opencode con su `session_id`, el modo auto (I4b), un host fuera de alcance y el legado de agy_audit.
 * Verifica I2 (nadie audita lo propio), I3 (solo el solicitante registra y marca su cursor) y que el despertar de
 * FEAT-194 ve los informes de la cola nueva.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');

const RAIZ = path.join(__dirname, '..');
const pedidosSesion = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-sesion.js'));
const pedidosAgy = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-agy.js'));
const buzones = require(path.join(RAIZ, 'mcp-server', 'lib', 'buzones.js'));

const texto = (r) => ((r && r.result && r.result.content) || []).map((c) => c.text || '').join('\n');
const esError = (r) => Boolean(r && r.result && r.result.isError);
const idDe = (t) => (/pedido `([0-9a-f]{6})` en la cola/.exec(t) || [])[1];

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat195t-')));
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

async function main() {
  const dir = repo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat195t-data-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat195t-cfg-'));
  const base = {
    LAGRANGE_AGY_MODO: 'manual',
    LAGRANGE_AGY_MODO_CONFIG: path.join(cfgDir, 'antigravity.json'),
    TELEGRAM_BRIDGE_DATA_DIR: dataDir,
    HOME: cfgDir,
    USERPROFILE: cfgDir
  };
  const PID_A = 515151;
  const PID_C = 525252;
  const spica = { ...base, CLAUDECODE: '1', CLAUDE_PID: String(PID_A), CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-0000-4000-8000-00000000000a' };
  const epikouros = { ...base, CLAUDECODE: '1', CLAUDE_PID: String(PID_C), CLAUDE_CODE_SESSION_ID: 'cccccccc-0000-4000-8000-00000000000c' };
  const opencode = { ...base, LAGRANGE_HOST: 'opencode', CLAUDECODE: null, CLAUDE_PID: null };
  try {
    await group('tools/list: auditoria, host-neutral', () => conServidor(spica, async (s) => {
      const tools = (((await s.listTools()).result || {}).tools) || [];
      const t = tools.find((x) => x.name === 'audit_queue');
      check('la tool existe', Boolean(t));
      const crudo = JSON.stringify(t || {});
      check('no nombra al host (I7)', !/Claude Code|Codex|codex/.test(crudo));
      check('acciones', JSON.stringify(t.inputSchema.properties.action.enum) === JSON.stringify(['request', 'list', 'take', 'release', 'submit', 'collect']));
      check('declara session_id (r1 F4)', Boolean(t.inputSchema.properties.session_id));
    }));

    await group('I4b: en auto, pedir no escribe en la cola', () => conServidor({ ...spica, LAGRANGE_AGY_MODO: 'auto' }, async (s) => {
      const r = await s.callTool('auditoria', { accion: 'pedir', target: 'x', cwd: dir });
      check('rechazado y manda a audit', esError(r) && texto(r).includes('usá `audit`'), texto(r).slice(0, 200));
      check('no creó la cola', !fs.existsSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos')));
    }));

    let id;
    await group('Spica pide (Claude Code)', () => conServidor(spica, async (s) => {
      const r = await s.callTool('auditoria', { accion: 'pedir', audit_mode: 'plan', target: 'EL PLAN X', nombre: 'Spica', cwd: dir });
      id = idDe(texto(r));
      check('devuelve el id y el cierre de turno', Boolean(id) && texto(r).includes('terminá este turno') && texto(r).includes('No** crees watchers'), texto(r).slice(0, 300));
      check('explica cómo auditarlo en cada harness', texto(r).includes(`/lagrange:audit ${id}`) && texto(r).includes(`.lagrange/auditorias/pedidos/${id}.md`));
      const pedido = fs.readFileSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos', `${id}.md`), 'utf8');
      const fm = pedidosAgy.frontmatter(pedido).campos;
      check('solicitante = claude:<CLAUDE_CODE_SESSION_ID>', fm.solicitante === `claude:${spica.CLAUDE_CODE_SESSION_ID}` && fm.nombre === 'Spica', JSON.stringify(fm));
      check('el pedido trae el proceso Modo 2 y la tarea', pedido.includes('Mode 2') && pedido.includes('EL PLAN X'));
      check('regla de escritura con la carpeta de la cola (r1 F3)', pedido.includes('under `.lagrange/auditorias/informes/`') && pedido.includes('`submit`') && !pedido.includes('.lagrange/agy/informes'));
      const cur = pedidosSesion.leerPedidos(dataDir, PID_A);
      check('registra el id en SU cursor, con tool auditoria', cur.some((p) => p.id === id && p.estado === 'pendiente' && p.tool === 'auditoria'));
      const propio = await s.callTool('auditoria', { accion: 'tomar', id, cwd: dir });
      check('I2: no puede tomar su propio pedido', esError(propio) && texto(propio).includes('es tuyo'));
      const lista = await s.callTool('auditoria', { accion: 'listar', cwd: dir });
      check('no lo ve para auditar', !texto(lista).includes(id));
      const mios = await s.callTool('auditoria', { accion: 'listar', que: 'mios', cwd: dir });
      check('lo ve en "mios"', texto(mios).includes(id) && texto(mios).includes('pendiente'));
    }));

    await group('Epikouros audita (otra sesión de Claude Code)', () => conServidor(epikouros, async (s) => {
      const lista = await s.callTool('auditoria', { accion: 'listar', cwd: dir });
      check('lo ve para auditar, con quién lo pidió', texto(lista).includes(id) && texto(lista).includes('Spica'));
      const pend = await s.callTool('auditoria', { accion: 'recoger', id, cwd: dir });
      check('recoger un pedido ajeno sin informe: dice que no es suyo y cómo tomarlo', texto(pend).includes('No es tuyo') && texto(pend).includes('"take"'), texto(pend).slice(0, 300));
      const t = await s.callTool('auditoria', { accion: 'tomar', id, nombre: 'Epikouros', cwd: dir });
      check('tomar devuelve el pedido completo y cómo entregar', !esError(t) && texto(t).includes('EL PLAN X') && texto(t).includes('"submit"'));
      const malo = await s.callTool('auditoria', { accion: 'entregar', id, informe: 'sin veredicto', cwd: dir });
      check('entregar inválido: error con los problemas', esError(malo) && texto(malo).includes('falta una de las líneas'));
      const bueno = await s.callTool('auditoria', { accion: 'entregar', id, informe: '## Verdict: FAIL\n\nF1 grave.\n', cwd: dir });
      check('entregar válido', !esError(bueno) && texto(bueno).includes('Verdict: FAIL'), texto(bueno).slice(0, 200));
      const suyo = await s.callTool('auditoria', { accion: 'recoger', id, cwd: dir });
      check('el auditor puede leerlo, con quién lo pidió', !esError(suyo) && texto(suyo).includes('F1 grave.') && texto(suyo).includes('Lo pidió'));
      check('I3: el auditor no tiene cursor', !fs.existsSync(path.join(dataDir, 'buzones', `pedidos-${PID_C}.json`)) || !pedidosSesion.leerPedidos(dataDir, PID_C).some((p) => p.id === id));
      check('I3: el cursor del solicitante sigue pendiente', pedidosSesion.leerPedidos(dataDir, PID_A).find((p) => p.id === id)?.estado === 'pendiente');
    }));

    await group('despertar de FEAT-194 con la cola nueva', () => {
      const toma = pedidosSesion.tomarListoParaDespertar({ dataDir, claudePid: PID_A });
      check('ve el informe listo del pedido de la cola (sin umbral: lo escribió entregar)', toma.listo && toma.listo.id === id && toma.listo.tool === 'auditoria', JSON.stringify(toma));
      pedidosSesion.marcarEstado({ dataDir, claudePid: PID_A, id, estado: 'pendiente' });
    });

    await group('Spica recoge', () => conServidor(spica, async (s) => {
      // Como llega el aviso de despertar de FEAT-194 hasta la Fase 4: (desde FEAT-197 el alias `pedido` no existe: `action: "collect"` e `id`).
      const r = await s.callTool('auditoria', { accion: 'recoger', id, cwd: dir });
      check('informe con quién auditó', !esError(r) && texto(r).includes('## Verdict: FAIL') && texto(r).includes(`claude:${epikouros.CLAUDE_CODE_SESSION_ID}`) && texto(r).includes('Epikouros'));
      check('marca recogido en su cursor', pedidosSesion.leerPedidos(dataDir, PID_A).find((p) => p.id === id)?.estado === 'recogido');
    }));

    await group('opencode: identidad por session_id', () => conServidor(opencode, async (s) => {
      const r = await s.callTool('auditoria', { accion: 'pedir', target: 'diff', plan: 'P', session_id: 'ses_Bopencode', cwd: dir });
      const idB = idDe(texto(r));
      const fm = pedidosAgy.frontmatter(fs.readFileSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos', `${idB}.md`), 'utf8')).campos;
      check('solicitante opencode:<session_id>', fm.solicitante === 'opencode:ses_Bopencode', JSON.stringify(fm));
      check('opencode no escribe cursor', !pedidosSesion.leerPedidos(dataDir, process.pid).some((p) => p.id === idB));
      const propio = await s.callTool('auditoria', { accion: 'tomar', id: idB, session_id: 'ses_Bopencode', cwd: dir });
      check('la misma sesión no lo toma', esError(propio));
      const otra = await s.callTool('auditoria', { accion: 'tomar', id: idB, session_id: 'ses_otra', cwd: dir });
      check('otra sesión de opencode sí', !esError(otra), texto(otra).slice(0, 200));
      const sinSesion = await s.callTool('auditoria', { accion: 'listar', cwd: dir });
      check('sin session_id: opencode:anonimo', texto(sinSesion).includes('opencode:anonimo'));
      // FEAT-195 F3 (prueba en vivo: 2e2768 salió opencode:anonimo) — audit manual también toma el session_id.
      const ra = await s.callTool('agy_audit', { target: 'diff', plan: 'P', session_id: 'ses_Copencode', cwd: dir });
      const idA = idDe(texto(ra));
      const fmA = idA ? pedidosAgy.frontmatter(fs.readFileSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos', `${idA}.md`), 'utf8')).campos : {};
      check('audit manual desde opencode: solicitante opencode:<session_id>', fmA.solicitante === 'opencode:ses_Copencode', texto(ra).slice(0, 200));
      check('audit declara session_id en su schema', Boolean(((((await s.listTools()).result || {}).tools) || []).find((t) => t.name === 'audit')?.inputSchema?.properties?.session_id));
    }));

    await group('BE-066 (auditoría 41cdbc F1): un MCP a mano que hereda la sesión de otro va como anónimo', () => {
      const ajena = 'dddddddd-0000-4000-8000-00000000000d';
      const r = buzones.rutas(dataDir, ajena);
      fs.mkdirSync(path.dirname(r.mcp), { recursive: true });
      // El alta de la sesión de verdad: otro Claude (claudePid ≠ el padre de este MCP) con un MCP vivo (este test).
      fs.writeFileSync(r.mcp, JSON.stringify({ sesion: ajena, claudePid: 999999, mcpPid: process.pid, inicio: 0, cwd: dir }));
      return conServidor({ ...spica, CLAUDE_CODE_SESSION_ID: ajena }, async (s) => {
        const p = await s.callTool('auditoria', { accion: 'pedir', target: 'x', plan: 'P', cwd: dir });
        const idX = idDe(texto(p));
        const fm = pedidosAgy.frontmatter(fs.readFileSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos', `${idX}.md`), 'utf8')).campos;
        check('solicitante claude:anonimo, no la sesión ajena', fm.solicitante === 'claude:anonimo', JSON.stringify(fm));
      }).finally(() => fs.rmSync(r.mcp, { force: true }));
    });

    await group('esHostClaudeReal (auditoría 41cdbc F2): agy no es Claude aunque herede CLAUDECODE', () => {
      check('LAGRANGE_HOST=agy', pedidosSesion.esHostClaudeReal({ CLAUDECODE: '1', LAGRANGE_HOST: 'agy' }) === false);
      check('LAGRANGE_HOST=opencode', pedidosSesion.esHostClaudeReal({ CLAUDECODE: '1', LAGRANGE_HOST: 'opencode' }) === false);
    });

    await group('host fuera de alcance', () => conServidor({ ...base, CLAUDECODE: null, CLAUDE_PID: null, LAGRANGE_HOST: null }, async (s) => {
      const r = await s.callTool('auditoria', { accion: 'pedir', target: 'x', cwd: dir });
      check('pedir: rechazado', esError(r) && texto(r).includes('alcance'), texto(r).slice(0, 200));
    }));

    await group('F3: audit manual escribe en la cola nueva y se recoge con request_id', () => conServidor(spica, async (s) => {
      const r = await s.callTool('agy_audit', { target: 'git diff', plan: 'EL PLAN F3', cwd: dir });
      const idN = idDe(texto(r));
      check('audit manual: pedido en .lagrange/auditorias/ (no en .lagrange/agy/)', Boolean(idN) && fs.existsSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos', `${idN}.md`)) && !fs.existsSync(path.join(dir, '.lagrange', 'agy', 'pedidos', `${idN}.md`)), texto(r).slice(0, 300));
      const cuerpo = idN ? fs.readFileSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos', `${idN}.md`), 'utf8') : '';
      check('el pedido trae el plan y la solicitante es la sesión', cuerpo.includes('[AUDIT TASK]') && cuerpo.includes('EL PLAN F3') && cuerpo.includes(`solicitante: claude:${spica.CLAUDE_CODE_SESSION_ID}`));
      check('registrado en el cursor con la tool de la cola', pedidosSesion.leerPedidos(dataDir, PID_A).find((p) => p.id === idN)?.tool === 'auditoria');
      const pend = await s.callTool('agy_audit', { pedido: idN, cwd: dir });
      check('request_id pendiente: no es error y dice pendiente', !esError(pend) && texto(pend).includes('pendiente'), texto(pend).slice(0, 200));
      const hilo = await s.callTool('agy_audit', { target: 'x', conversation_id: 'abc', cwd: dir });
      check('conversation_id en manual: rechazado', esError(hilo) && texto(hilo).includes('conversation_id'));
    }));

    await group('F3: un host fuera de la cola nueva sigue con .lagrange/agy/', () => conServidor({ ...base, CLAUDECODE: null, CLAUDE_PID: null, LAGRANGE_HOST: null }, async (s) => {
      const r = await s.callTool('agy_audit', { target: 'git diff', cwd: dir });
      const idR = (/pedido `([0-9a-f]{6})` listo/.exec(texto(r)) || [])[1];
      check('respaldo: pedido en la cola de agy', Boolean(idR) && fs.existsSync(path.join(dir, '.lagrange', 'agy', 'pedidos', `${idR}.md`)), texto(r).slice(0, 200));
    }));

    await group('legado: un pedido de .lagrange/agy/ se sigue recogiendo, con audit_queue y con audit', () => conServidor(spica, async (s) => {
      const idV = pedidosAgy.crearPedido({ cwd: dir, tipo: 'audit', modo: 'implementation', prompt: 'X' }).id;
      pedidosSesion.registrarPedido({ dataDir, env: { CLAUDECODE: '1', CLAUDE_PID: String(PID_A) }, id: idV, tipo: 'audit', tool: 'agy_audit', raiz: dir });
      const p0 = await s.callTool('auditoria', { accion: 'recoger', id: idV, cwd: dir });
      check('pendiente: apunta a /lagrange-audit', texto(p0).includes(`/lagrange-audit ${idV}`));
      fs.writeFileSync(path.join(dir, '.lagrange', 'agy', 'informes', `${idV}.md`), `---\nid: ${idV}\n---\n\n## Verdict: PASS\n\nOk.\n`);
      const p1 = await s.callTool('auditoria', { accion: 'recoger', id: idV, cwd: dir });
      check('listo: lo recoge y lo marca en el cursor', !esError(p1) && texto(p1).includes('Engine: agy') && pedidosSesion.leerPedidos(dataDir, PID_A).find((p) => p.id === idV)?.estado === 'recogido');
      const p2 = await s.callTool('agy_audit', { pedido: idV, cwd: dir });
      check('audit con request_id también lo recoge', !esError(p2) && texto(p2).includes('Verdict: PASS'), texto(p2).slice(0, 200));
    }));
  } finally {
    removeFixture(dir);
    removeFixture(dataDir);
    removeFixture(cfgDir);
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
