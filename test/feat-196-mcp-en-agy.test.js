/**
 * FEAT-196 — El MCP de Lagrange dentro de agy (`LAGRANGE_HOST=agy`):
 * - lista blanca de tools (auditoria, agy_status, agy_usage) en tools/list y en tools/call;
 * - identidad desde `params._meta` con las claves de la sonda S4 (`antigravity.google/…`), nunca desde `session_id`;
 * - `pedir` va a la cola en cualquier modo; `recoger` no espera; I2 entre conversaciones; I3 sin cursor de Claude;
 * - `agy_usage` sin reset ni refresh; arranque sin alta en el daemon;
 * - `scripts/agy-plugin.mjs --mcp / --mcp-off` (preflight, respaldo, entrada ajena, Windows, combinaciones).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { temporalQueSeBorra } = require('./lib/temporales');

const RAIZ = path.join(__dirname, '..');
const porHost = require(path.join(RAIZ, 'mcp-server', 'lib', 'herramientas-por-host.js'));
const pedidosSesion = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-sesion.js'));
const pedidosAgy = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-agy.js'));
const SCRIPT_INSTALL = path.join(RAIZ, 'scripts', 'agy-plugin.mjs');

const texto = (r) => ((r && r.result && r.result.content) || []).map((c) => c.text || '').join('\n');
const esError = (r) => Boolean(r && r.result && r.result.isError);
const idDe = (t) => (/pedido `([0-9a-f]{6})` en la cola/.exec(t) || [])[1];

// El `_meta` tal cual lo mandó agy en la sonda S4 (sonda-s4.log, conversación 1), y otra conversación.
const META_UNO = {
  'antigravity.google/artifacts_dir': 'C:\\Users\\x\\.gemini\\antigravity-cli\\brain\\ffbe21a3-409a-426f-8ebc-252ecf280a8e',
  'antigravity.google/conversation_id': 'ffbe21a3-409a-426f-8ebc-252ecf280a8e',
  'antigravity.google/root_conversation_id': 'ffbe21a3-409a-426f-8ebc-252ecf280a8e',
  progressToken: '5526a7d7-a10b-4e3e-8498-af7ce11b6935:4'
};
const META_DOS = {
  'antigravity.google/conversation_id': '96b517ec-4515-439d-9cb5-e26c60af4bcd',
  'antigravity.google/root_conversation_id': '96b517ec-4515-439d-9cb5-e26c60af4bcd'
};

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat196-')));
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
  try { await s.initialize({ name: 'antigravity-client', version: 'v1.0.0' }, '2025-11-25'); return await fn(s); } finally { await s.stop(); }
}

const llamar = (s, name, args, meta) => s.request('tools/call', meta ? { name, arguments: args, _meta: meta } : { name, arguments: args });

async function main() {
  await group('herramientas-por-host (puro)', () => {
    const todas = ['run', 'audit_queue', 'message', 'status', 'usage', 'una_nueva'].map((name) => ({ name }));
    check('agy ve exactamente las tres', JSON.stringify(porHost.visibles('agy', todas).map((t) => t.name)) === JSON.stringify(['audit_queue', 'status', 'usage']));
    check('sin host y opencode ven todas', porHost.visibles(null, todas).length === todas.length && porHost.visibles('opencode', todas).length === todas.length);
    check('una tool nueva no entra a agy', !porHost.permitida('agy', 'una_nueva') && porHost.permitida(null, 'una_nueva'));
    check('sesionDeAgy: la raíz del _meta de S4', porHost.sesionDeAgy(META_UNO) === 'ffbe21a3-409a-426f-8ebc-252ecf280a8e');
    check('sesionDeAgy: sin raíz, la conversación', porHost.sesionDeAgy({ 'antigravity.google/conversation_id': 'zzz-1' }) === 'zzz-1');
    check('sesionDeAgy: la raíz gana a la conversación (subagente)', porHost.sesionDeAgy({ 'antigravity.google/conversation_id': 'hijo', 'antigravity.google/root_conversation_id': 'padre' }) === 'padre');
    check('sesionDeAgy: claves sin namespace no cuentan (r1 F1)', porHost.sesionDeAgy({ root_conversation_id: 'x', conversation_id: 'y' }) === null);
    check('sesionDeAgy: valores raros o ausentes → null', porHost.sesionDeAgy(null) === null && porHost.sesionDeAgy({ 'antigravity.google/root_conversation_id': '../../x y' }) === null);
  });

  const dir = repo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat196-data-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat196-cfg-'));
  const cfg = path.join(cfgDir, 'antigravity.json');
  // `auto` a propósito: dentro de agy `pedir` igual va a la cola. CLAUDECODE/CLAUDE_PID heredados no lo vuelven Claude.
  const enAgy = {
    LAGRANGE_HOST: 'agy', LAGRANGE_AGY_MODO: 'auto', LAGRANGE_AGY_MODO_CONFIG: cfg, TELEGRAM_BRIDGE_DATA_DIR: dataDir,
    HOME: cfgDir, USERPROFILE: cfgDir, CLAUDECODE: '1', CLAUDE_PID: '565656', CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-0000-4000-8000-00000000000a'
  };
  try {
    let id;
    await group('servidor con LAGRANGE_HOST=agy', () => conServidor(enAgy, async (s) => {
      const tools = (((await s.listTools()).result || {}).tools) || [];
      check('tools/list: solo las tres', JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(['audit_queue', 'status', 'usage']), tools.map((t) => t.name).join(','));
      const aud = tools.find((t) => t.name === 'audit_queue');
      check('auditoria no remite a agy_audit ni a "Only in manual mode" (r1 F2)', aud && !aud.description.includes('Only in manual mode') && aud.description.includes('always uses the queue here'));
      check('sigue host-neutral (I7)', !/Claude Code|Codex/.test(JSON.stringify(tools)));

      const run = await llamar(s, 'agy_run', { prompt: 'x' });
      check('agy_run rechazado con el texto de FEAT-196', esError(run) && texto(run).includes('FEAT-196') && texto(run).includes('«run»'), texto(run));
      const msg = await llamar(s, 'mensaje', { accion: 'leer' });
      check('mensaje rechazado', esError(msg));

      const reset = await llamar(s, 'agy_usage', { reset: true });
      check('agy_usage reset rechazado', esError(reset) && texto(reset).includes('reset'));
      const refresh = await llamar(s, 'agy_usage', { refresh_quota: true });
      check('agy_usage refresh_quota rechazado', esError(refresh) && texto(refresh).includes('refresh_quota'));
      const uso = await llamar(s, 'agy_usage', {});
      check('agy_usage lee y no sugiere reset (r1 F4)', !esError(uso) && !texto(uso).includes('reset: true'), texto(uso).slice(0, 200));

      const r = await llamar(s, 'auditoria', { accion: 'pedir', audit_mode: 'plan', target: 'EL PLAN', cwd: dir }, META_UNO);
      id = idDe(texto(r));
      check('pedir en auto va igual a la cola', !esError(r) && Boolean(id), texto(r).slice(0, 300));
      check('el texto no dice "modo manual" en agy (impl F2)', !texto(r).includes('modo manual') && texto(r).includes('desde agy'));
      const fm = pedidosAgy.frontmatter(fs.readFileSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos', `${id}.md`), 'utf8')).campos;
      check('solicitante desde _meta (raíz)', fm.solicitante === 'agy:ffbe21a3-409a-426f-8ebc-252ecf280a8e', fm.solicitante);
      check('I3: no escribió cursor de Claude', !fs.existsSync(path.join(dataDir, 'buzones', 'pedidos-565656.json')) || !pedidosSesion.leerPedidos(dataDir, 565656).some((p) => p.id === id));

      const propio = await llamar(s, 'auditoria', { accion: 'tomar', id, cwd: dir }, META_UNO);
      check('I2: la misma conversación no toma lo suyo', esError(propio) && /tuyo/.test(texto(propio)), texto(propio));
      const suplantar = await llamar(s, 'auditoria', { accion: 'tomar', id, cwd: dir, session_id: 'otra' }, META_UNO);
      check('session_id no cambia la identidad en agy', esError(suplantar));
      const otra = await llamar(s, 'auditoria', { accion: 'tomar', id, cwd: dir }, META_DOS);
      check('I2: otra conversación sí lo toma', !esError(otra), texto(otra).slice(0, 200));

      const sinMeta = await llamar(s, 'auditoria', { accion: 'listar', cwd: dir, session_id: 'falsa' });
      check('sin _meta: agy:anonimo, no el session_id', texto(sinMeta).includes('agy:anonimo') && !texto(sinMeta).includes('agy:falsa'), texto(sinMeta).slice(0, 300));
      const sinNs = await llamar(s, 'auditoria', { accion: 'listar', cwd: dir }, { root_conversation_id: 'x1' });
      check('_meta sin namespace: agy:anonimo (r1 F1)', texto(sinNs).includes('agy:anonimo') && !texto(sinNs).includes('agy:x1'));

      const t0 = Date.now();
      const rec = await llamar(s, 'auditoria', { accion: 'recoger', id, cwd: dir, esperar_segundos: 30 }, META_UNO);
      check('recoger no espera en agy y lo dice (r1 F6)', Date.now() - t0 < 10000 && texto(rec).includes('wait_seconds') && texto(rec).includes('una sola mirada'), texto(rec).slice(0, 300));

    }));

    // El arnés de tests ya aísla el daemon (BE-066), así que la alta no deja rastro observable en ningún host: se
    // verifica en el fuente que la alta y el servicio de conocimiento estén bajo la guarda de agy.
    await group('arranque sin alta ni conocimiento en agy (fuente)', () => {
      const fuente = fs.readFileSync(path.join(RAIZ, 'mcp-server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
      const guarda = fuente.indexOf("if (HOST_MARCADO !== 'agy') {\n  // FEAT-092 — Alta en el daemon al arrancar");
      const alta = fuente.indexOf('clienteMensajes().asegurar()', guarda);
      const conocimiento = fuente.indexOf('servicioConocimiento().arrancar()', guarda);
      const cierre = fuente.indexOf('\n}\n', conocimiento);
      check('la guarda envuelve la alta y el conocimiento', guarda > 0 && alta > guarda && conocimiento > alta && cierre > conocimiento);
      check('no quedan otras llamadas de arranque fuera de la guarda',
        fuente.split('clienteMensajes().asegurar()').length === 2 && fuente.split('servicioConocimiento().arrancar()').length === 2);
    });

    await group('sin host marcado nada cambia', () => conServidor({ ...enAgy, LAGRANGE_HOST: null, LAGRANGE_AGY_MODO: 'manual' }, async (s) => {
      const tools = (((await s.listTools()).result || {}).tools) || [];
      check('ve todas (más de 20)', tools.length > 20 && tools.some((t) => t.name === 'run'));
      check('auditoria conserva la frase de I4b', tools.find((t) => t.name === 'audit_queue').description.includes('Only in manual mode'));
    }));
  } finally {
    removeFixture(dir);
    removeFixture(dataDir);
    removeFixture(cfgDir);
  }

  const inst = await import(pathToFileURL(SCRIPT_INSTALL).href);
  const correr = (home, args) => spawnSync(process.execPath, [SCRIPT_INSTALL, '--home', home, ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home }
  });

  await group('agy-plugin.mjs: parseo de --mcp / --mcp-off', () => {
    for (const malos of [['--mcp', '--mcp-off'], ['--mcp-off', '--statusline'], ['--mcp', '--statusline-off'], ['--validar', '--mcp'], ['--mcp-off', '--force']]) {
      let fallo = false;
      try { inst.parsearArgs(malos); } catch { fallo = true; }
      check(`rechaza ${malos.join(' ')}`, fallo);
    }
    let ok = true;
    try { inst.parsearArgs(['--mcp', '--force']); inst.parsearArgs(['--mcp', '--statusline']); inst.parsearArgs(['--mcp-off', '--statusline-off']); } catch { ok = false; }
    check('acepta --mcp --force, --mcp --statusline y --mcp-off --statusline-off (r1 F3)', ok);
  });

  await group('agy-plugin.mjs: registro, respaldo, ajena y --mcp-off', () => {
    const home = temporalQueSeBorra('feat196-home-');
    const mcpPath = inst.rutaMcpConfig(home);
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    const otros = { mcpServers: { voicebox: { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer SECRETO' } } } };
    fs.writeFileSync(mcpPath, JSON.stringify(otros, null, 2));

    const r1 = correr(home, ['--mcp']);
    const j1 = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    check('--mcp registra lagrange con la forma de S4', r1.status === 0 && j1.mcpServers.lagrange?.command === 'node'
      && j1.mcpServers.lagrange?.env?.LAGRANGE_HOST === 'agy' && /\/mcp-server\/index\.js$/.test(j1.mcpServers.lagrange?.args?.[0] || ''), `${r1.status} ${r1.stderr}`);
    check('no toca los otros servidores', j1.mcpServers.voicebox.headers.Authorization === 'Bearer SECRETO');
    check('nunca imprime el contenido', !r1.stdout.includes('SECRETO') && !r1.stderr.includes('SECRETO'));
    const backups = path.join(path.dirname(mcpPath), '.backups');
    check('dejó respaldo del original', fs.readdirSync(backups).filter((f) => f.startsWith('mcp_config-')).length === 1);
    check('instaló el plugin de agy', fs.existsSync(path.join(inst.destinoPorDefecto(home), 'plugin.json')));

    const r2 = correr(home, ['--mcp']);
    check('repetir --mcp es idempotente', r2.status === 0 && JSON.stringify(JSON.parse(fs.readFileSync(mcpPath, 'utf8'))) === JSON.stringify(j1));

    const propiaWin = { command: 'node', args: ['C:\\Users\\X\\.claude\\plugins\\cache\\m\\lagrange\\1.0.0\\MCP-SERVER\\index.js'], env: { LAGRANGE_HOST: 'agy' } };
    check('entrada propia con \\ de Windows se reconoce', inst.esEntradaMcpPropia(propiaWin, { platform: 'win32' }));
    check('sin LAGRANGE_HOST=agy es ajena', !inst.esEntradaMcpPropia({ command: 'node', args: ['/x/mcp-server/index.js'] }));

    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { lagrange: { command: 'otro', args: ['x.js'] } } }));
    const r3 = correr(home, ['--mcp']);
    check('lagrange ajeno sin --force falla y no escribe', r3.status !== 0 && JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers.lagrange.command === 'otro');
    const r4 = correr(home, ['--mcp', '--force']);
    check('con --force lo reemplaza', r4.status === 0 && JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers.lagrange.env.LAGRANGE_HOST === 'agy');

    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { lagrange: { command: 'otro', args: ['x.js'] } } }));
    const r5 = correr(home, ['--mcp-off']);
    check('--mcp-off no quita uno ajeno', r5.status !== 0 && Boolean(JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers.lagrange));
    correr(home, ['--mcp', '--force']);
    const r6 = correr(home, ['--mcp-off']);
    const j6 = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    check('--mcp-off quita el propio', r6.status === 0 && !j6.mcpServers.lagrange);
    const r7 = correr(home, ['--mcp-off']);
    check('--mcp-off sin entrada no hace nada', r7.status === 0 && /no había/.test(r7.stdout));
  });

  await group('agy-plugin.mjs: preflight antes de escribir nada (r1 F3)', () => {
    const home = temporalQueSeBorra('feat196-pre-');
    const mcpPath = inst.rutaMcpConfig(home);
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: [] }));
    const r1 = correr(home, ['--mcp', '--statusline']);
    check('mcpServers array: falla y no se toca', r1.status !== 0 && fs.readFileSync(mcpPath, 'utf8') === JSON.stringify({ mcpServers: [] }));
    check('no copió el plugin ni escribió settings.json', !fs.existsSync(inst.destinoPorDefecto(home)) && !fs.existsSync(inst.rutaSettings(home)));
    fs.writeFileSync(mcpPath, '{corrupto');
    const r2 = correr(home, ['--mcp']);
    check('JSON inválido: falla y no se toca', r2.status !== 0 && fs.readFileSync(mcpPath, 'utf8') === '{corrupto' && !fs.existsSync(inst.destinoPorDefecto(home)));
    let sinServidor = false;
    try { inst.preflightMcp({ mcpPath: path.join(home, 'nada.json'), servidor: path.join(home, 'no', 'index.js') }); } catch { sinServidor = true; }
    check('sin mcp-server/index.js bajo la raíz: falla (r1 F5)', sinServidor);
  });

  await group('agy-plugin.mjs: copia-vieja mira la caché de --home (r1 F5)', async () => {
    const home = temporalQueSeBorra('feat196-cache-');
    const claudeDir = path.join(home, '.claude');
    check('sin caché: sin aviso', (await inst.copiaVieja({ claudeDir })) === null);
    fs.mkdirSync(path.join(claudeDir, 'plugins', 'cache', 'mercado', 'lagrange', '999.0.0'), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, 'plugins', 'cache', 'mercado', 'lagrange', '1000.0.0-beta.1'), { recursive: true });
    const v = await inst.copiaVieja({ claudeDir });
    check('una estable más nueva: avisa con esa versión', v && v.ultima === '999.0.0');
    const r = correr(home, ['--mcp']);
    check('el CLI lo avisa con --home', r.status === 0 && /copia-vieja/.test(r.stdout) && r.stdout.includes('999.0.0'), r.stdout);
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
