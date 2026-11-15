/**
 * FEAT-194 — Contrato determinista y detección sin polling para pedidos manuales de agy.
 *
 * Cubre Parte 1 (schemas host-neutral, salida de crearPedidoManual/recogerPedidoManual,
 * skills y comandos en Claude Code y OpenCode CLI) y Parte 2 (cursor único por sesión,
 * informeEstable, panel.js avisos con --pid, buzon.js espera sin daemon y con modVivo,
 * mod-pedido-estado y limpieza en buzones.limpiarViejos).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');

const RAIZ = path.join(__dirname, '..');
const pedidosAgy = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-agy.js'));
const pedidosSesion = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-sesion.js'));
const buzones = require(path.join(RAIZ, 'mcp-server', 'lib', 'buzones.js'));
const panel = require(path.join(RAIZ, 'hooks', 'panel.js'));

function crearRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat194-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const x = 1;\n');
  git('add', 'index.js');
  git('commit', '-qm', 'init');
  return dir;
}

function correrHook(args, { env = {}, stdin = '{}', timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(RAIZ, 'hooks', 'buzon.js'), ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, timedOut: false, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

async function pidMuerto() {
  const p = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  const pid = p.pid;
  await new Promise((r) => p.on('close', r));
  return pid;
}

async function main() {
  const dir = crearRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat194-data-'));
  const globalCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat194-cfg-'));
  const globalCfg = path.join(globalCfgDir, 'antigravity.json');
  fs.writeFileSync(globalCfg, JSON.stringify({ agy_modo: 'manual', agy_auto_recoger: false }));

  try {
    await group('Parte 1: skills y comandos documentan flujo determinista (Claude y OpenCode)', () => {
      for (const rel of ['skills/agy-cli/SKILL.md', '.opencode/skills/agy-cli/SKILL.md']) {
        const s = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
        check(`${rel} documenta Manual mode`, /### Manual mode/.test(s));
        check(`${rel} ordena cerrar turno y prohíbe watchers`, /end the turn/i.test(s) && /Never invent watchers/i.test(s));
        check(`${rel} indica esperar_segundos: 0`, /esperar_segundos: 0/.test(s));
      }
      for (const rel of ['skills/adversarial-review/SKILL.md', '.opencode/skills/adversarial-review/SKILL.md']) {
        const s = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
        check(`${rel} agrega guía manual bajo Delegated audits`, /## Delegated audits[\s\S]*manual mode/i.test(s));
      }
      for (const cmd of ['audit', 'review', 'plan']) {
        const cc = fs.readFileSync(path.join(RAIZ, 'commands', `${cmd}.md`), 'utf8');
        const oc = fs.readFileSync(path.join(RAIZ, '.opencode', 'commands', 'lagrange', `${cmd}.md`), 'utf8');
        check(`commands/${cmd}.md incluye cierre de turno`, /pedido: "<id>"/.test(cc) && /end the turn/i.test(cc));
        check(`.opencode/.../${cmd}.md usa tool lagrange_agy_${cmd} y cierra turno`, oc.includes(`lagrange_agy_${cmd}`) && /end the turn/i.test(oc));
      }
    });

    await group('Parte 1 + cursor MCP: registro solo bajo Claude Code real, nunca en OpenCode/Codex', async () => {
      const envBase = {
        LAGRANGE_AGY_MODO: 'manual',
        LAGRANGE_AGY_MODO_CONFIG: globalCfg,
        TELEGRAM_BRIDGE_DATA_DIR: dataDir,
        HOME: globalCfgDir,
        USERPROFILE: globalCfgDir
      };

      // Aislado en OpenCode: no crea pedidos-*.json
      const srvOpenCode = startServer({
        cwd: dir,
        env: { ...envBase, CLAUDECODE: '1', CLAUDE_PID: String(process.pid), LAGRANGE_HOST: 'opencode' }
      });
      try {
        await srvOpenCode.initialize();
        const res = await srvOpenCode.callTool('agy_audit', { target: 'git diff', cwd: dir });
        const txt = (res.result?.content || []).map((c) => c.text).join('\n');
        const id = (/pedido `([0-9a-f]{6})` listo/.exec(txt) || [])[1];
        check('OpenCode crea pedido y emite pasos obligatorios FEAT-194', Boolean(id) && txt.includes('Pasos obligatorios (FEAT-194)') && txt.includes('esperar_segundos: 0'));
        check('OpenCode NUNCA escribe pedidos-<pid>.json', !fs.existsSync(buzones.rutaPedidos(dataDir, process.pid)));
        if (id) fs.rmSync(path.join(dir, '.lagrange', 'agy', 'pedidos', `${id}.md`), { force: true });
      } finally {
        await srvOpenCode.stop();
      }

      // Bajo Claude Code real: registra pedido y transiciona a recogido al recoger informe
      const pidFake = 424242;
      const srvClaude = startServer({
        cwd: dir,
        env: { ...envBase, CLAUDECODE: '1', CLAUDE_PID: String(pidFake) }
      });
      let idClaude;
      try {
        await srvClaude.initialize();
        const res = await srvClaude.callTool('agy_audit', { target: 'git diff', plan: 'P', cwd: dir });
        const txt = (res.result?.content || []).map((c) => c.text).join('\n');
        idClaude = (/pedido `([0-9a-f]{6})` listo/.exec(txt) || [])[1];
        const cur = pedidosSesion.leerPedidos(dataDir, pidFake);
        check('Claude Code registra en pedidos-<pid>.json como pendiente', Boolean(idClaude) && cur.some((p) => p.id === idClaude && p.estado === 'pendiente'));

        const pend = await srvClaude.callTool('agy_audit', { pedido: idClaude, cwd: dir });
        const pendTxt = (pend.result?.content || []).map((c) => c.text).join('\n');
        check('recoger pendiente recuerda no hacer polling en loop', pendTxt.includes('no hagas polling en loop'));

        fs.writeFileSync(path.join(dir, '.lagrange', 'agy', 'informes', `${idClaude}.md`), `---\nid: ${idClaude}\n---\n\n## Verdict: PASS\n\nOk.\n`);
        const listo = await srvClaude.callTool('agy_audit', { pedido: idClaude, cwd: dir });
        check('recoger listo no es error', !listo.result?.isError);
        const cur2 = pedidosSesion.leerPedidos(dataDir, pidFake);
        check('recoger listo marca estado recogido', cur2.find((p) => p.id === idClaude)?.estado === 'recogido');
      } finally {
        await srvClaude.stop();
      }

      // Codex cache / PLUGIN_ROOT no registra ni modifica cursor
      const rCodexEnv = pedidosSesion.registrarPedido({
        dataDir,
        env: { CLAUDECODE: '1', CLAUDE_PID: String(pidFake), PLUGIN_ROOT: 'C:\\codex\\p', CLAUDE_PLUGIN_ROOT: '' },
        id: 'abcdef', tipo: 'audit', tool: 'agy_audit', raiz: dir
      });
      const rCodexCache = pedidosSesion.registrarPedido({
        dataDir,
        env: { CLAUDECODE: '1', CLAUDE_PID: String(pidFake) },
        raizPlugin: path.join('C:', 'Users', 'x', '.codex', 'plugins', 'lagrange'),
        id: 'abcdef', tipo: 'audit', tool: 'agy_audit', raiz: dir
      });
      check('Codex (PLUGIN_ROOT o cache .codex) queda excluido', !rCodexEnv.ok && !rCodexCache.ok && !pedidosSesion.leerPedidos(dataDir, pidFake).some((p) => p.id === 'abcdef'));
    });

    await group('Parte 2A: informeEstable, listarPendientes tolerante, JSON corrupto y limpiarViejos', () => {
      const p = pedidosAgy.crearPedido({ cwd: dir, tipo: 'review', prompt: 'Revisar' });
      const infPath = path.join(dir, p.informe);
      fs.writeFileSync(infPath, `---\nid: ${p.id}\n---\n\nHallazgo.\n`);
      const st = fs.statSync(infPath);
      check('informeEstable rechaza archivo recién escrito (< 5 s)', pedidosAgy.informeEstable(dir, p.id, { ahora: st.mtimeMs + 1000 }) === false);
      check('informeEstable acepta archivo estable (>= 5 s)', pedidosAgy.informeEstable(dir, p.id, { ahora: st.mtimeMs + 6000 }) === true);

      // Corrupto en pedidos/ no tumba listarPendientes
      const p2 = pedidosAgy.crearPedido({ cwd: dir, tipo: 'plan', prompt: 'Plan' });
      const pCorruptoDir = path.join(dir, '.lagrange', 'agy', 'pedidos', 'fffffe.md');
      fs.mkdirSync(pCorruptoDir); // directorio con .md rompe readFileSync
      const list = pedidosAgy.listarPendientes(dir);
      check('listarPendientes tolera entrada ilegible y devuelve p2', list.some((x) => x.id === p2.id));
      fs.rmSync(pCorruptoDir, { recursive: true, force: true });

      // Cursor con JSON corrupto degrada limpio y asegurarDir crea buzones
      const pidRot = 515151;
      buzones.asegurarDir(dataDir);
      fs.writeFileSync(buzones.rutaPedidos(dataDir, pidRot), '{corrupto');
      check('JSON corrupto degrada a lista vacía', pedidosSesion.leerPedidos(dataDir, pidRot).length === 0);

      // limpiarViejos separa sesiones de archivos por PID
      const dirBuz = buzones.dirBuzones(dataDir);
      const viejos = ['pedidos-999.json', 'pedidos-999.json.lock', 'espera-999.pid', 'pid-999.json'];
      const hace8d = new Date(Date.now() - 8 * 86400000);
      for (const f of viejos) {
        const full = path.join(dirBuz, f);
        fs.writeFileSync(full, 'x');
        fs.utimesSync(full, hace8d, hace8d);
      }
      const vivoSes = path.join(dirBuz, 'pedidos.jsonl'); // trampa: nombre de sesión 'pedidos' en vivas
      fs.writeFileSync(vivoSes, '[]');
      fs.utimesSync(vivoSes, hace8d, hace8d);
      const n = buzones.limpiarViejos(dataDir, new Set(['pedidos', 'espera']));
      check('limpiarViejos purga pedidos-*, .lock y espera-* aunque vivas tenga "pedidos"/"espera"', n >= 4 && viejos.every((f) => !fs.existsSync(path.join(dirBuz, f))));
      check('limpiarViejos respeta sesión viva homónima', fs.existsSync(vivoSes));
    });

    await group('Parte 2A: hooks/panel.js avisos distingue propio solo con --pid / --pid-padre y no expone rutas', () => {
      const pPropio = pedidosAgy.crearPedido({ cwd: dir, tipo: 'audit', modo: 'plan', prompt: 'X' });
      const pAjeno = pedidosAgy.crearPedido({ cwd: dir, tipo: 'review', prompt: 'Y' });
      const pidPanel = 616161;
      pedidosSesion.registrarPedido({
        dataDir,
        env: { CLAUDECODE: '1', CLAUDE_PID: String(pidPanel) },
        id: pPropio.id, tipo: 'audit', modo: 'plan', tool: 'agy_audit', raiz: dir
      });

      const infPropio = path.join(dir, pPropio.informe);
      const infAjeno = path.join(dir, pAjeno.informe);
      fs.writeFileSync(infPropio, `---\nid: ${pPropio.id}\n---\n\n## Verdict: FAIL\n\nSECRETO_CONTENIDO\n`);
      fs.writeFileSync(infAjeno, `---\nid: ${pAjeno.id}\n---\n\nAjeno.\n`);
      const hace10s = new Date(Date.now() - 10_000);
      fs.utimesSync(infAjeno, hace10s, hace10s);
      // Todavía fresco pPropio -> aún no sale en informesAviso
      const fresco = panel.informesAviso(dir, { TELEGRAM_BRIDGE_DATA_DIR: dataDir }, pidPanel);
      check('informe < 5 s no se incluye todavía', !fresco.some((i) => i.id === pPropio.id) && fresco.some((i) => i.id === pAjeno.id));

      fs.utimesSync(infPropio, hace10s, hace10s);
      const sinFlag = panel.informesAviso(dir, { TELEGRAM_BRIDGE_DATA_DIR: dataDir }, panel.pidDeArgs([], process.ppid));
      check('sin flag --pid/--pid-padre todos salen con propio: false', sinFlag.every((i) => i.propio === false));

      const conFlag = panel.informesAviso(dir, { TELEGRAM_BRIDGE_DATA_DIR: dataDir }, panel.pidDeArgs(['--pid', String(pidPanel)], process.ppid));
      const itemP = conFlag.find((i) => i.id === pPropio.id);
      const itemA = conFlag.find((i) => i.id === pAjeno.id);
      check('con --pid distingue propio: true vs false sin cuerpo ni rutas',
        itemP?.propio === true && itemP?.veredicto === 'FAIL' && itemA?.propio === false && !JSON.stringify(conFlag).includes('SECRETO_CONTENIDO') && !JSON.stringify(conFlag).includes(dir.replace(/\\/g, '/')));
    });

    await group('Parte 2B: hooks/buzon.js espera (sin daemon, con modVivo, Codex y mod-pedido-estado)', async () => {
      const pAuto = pedidosAgy.crearPedido({ cwd: dir, tipo: 'audit', modo: 'implementation', prompt: 'Z' });
      const infAuto = path.join(dir, pAuto.informe);
      fs.writeFileSync(infAuto, `---\nid: ${pAuto.id}\n---\n\n## Verdict: PASS\n\nListo.\n`);
      const hace10s = new Date(Date.now() - 10_000);
      fs.utimesSync(infAuto, hace10s, hace10s);

      const pidVivoTest = process.pid;
      pedidosSesion.registrarPedido({
        dataDir,
        env: { CLAUDECODE: '1', CLAUDE_PID: String(pidVivoTest) },
        id: pAuto.id, tipo: 'audit', modo: 'implementation', tool: 'agy_audit', raiz: dir
      });

      // Guardas tempranas y auto_recoger=false salen inmediato en 0
      const envHook = {
        TELEGRAM_BRIDGE_DATA_DIR: dataDir,
        LAGRANGE_AGY_MODO_CONFIG: globalCfg,
        HOME: globalCfgDir,
        USERPROFILE: globalCfgDir,
        CLAUDECODE: '1',
        CLAUDE_PID: String(pidVivoTest)
      };
      const rCodex = await correrHook(['espera'], { env: { ...envHook, PLUGIN_ROOT: 'C:\\codex\\p', CLAUDE_PLUGIN_ROOT: '' } });
      check('Codex hook sale en 0 inmediato', rCodex.code === 0 && !rCodex.timedOut);

      const rOff = await correrHook(['espera'], { env: envHook });
      check('agy_auto_recoger=false (default) sale en 0 inmediato sin daemon', rOff.code === 0 && !rOff.timedOut);

      // Activar opt-in agy_auto_recoger: true SIN daemon -> despierta con exit 2
      fs.writeFileSync(globalCfg, JSON.stringify({ agy_modo: 'manual', agy_auto_recoger: true }));
      const rWake = await correrHook(['espera'], { env: envHook, timeoutMs: 8000 });
      check('sin daemon + agy_auto_recoger=true despierta con exit 2 e instrucción',
        rWake.code === 2 && rWake.stderr.includes(`pedido: "${pAuto.id}"`) && rWake.stderr.includes('agy_audit'),
        `code=${rWake.code} stderr=${rWake.stderr}`);
      check('despertar marca estado recogido y borra espera-<pid>.pid',
        pedidosSesion.leerPedidos(dataDir, pidVivoTest).find((x) => x.id === pAuto.id)?.estado === 'recogido'
        && !fs.existsSync(path.join(buzones.dirBuzones(dataDir), `espera-${pidVivoTest}.pid`)));

      // Segunda corrida ya marcado recogido: sale en 0 sin duplicar
      const rDup = await correrHook(['espera'], { env: envHook });
      check('no repite despertar si ya está recogido', rDup.code === 0 && !rDup.timedOut);

      // PID muerto sin daemon sale en 0 antes de esperar
      const deadPid = await pidMuerto();
      pedidosSesion.registrarPedido({
        dataDir,
        env: { CLAUDECODE: '1', CLAUDE_PID: String(deadPid) },
        id: pAuto.id, tipo: 'audit', modo: 'implementation', tool: 'agy_audit', raiz: dir
      });
      const rDead = await correrHook(['espera'], { env: { ...envHook, CLAUDE_PID: String(deadPid) }, timeoutMs: 6000 });
      check('sin daemon + CLAUDE_PID muerto sale en 0', rDead.code === 0 && !rDead.timedOut);

      // Con sesion viva + modVivo=true: pedidos siguen despertando igualmente
      const ses = 'ses-feat194-modvivo';
      const pMod = pedidosAgy.crearPedido({ cwd: dir, tipo: 'plan', modo: 'plan', prompt: 'P' });
      const infMod = path.join(dir, pMod.informe);
      fs.writeFileSync(infMod, `---\nid: ${pMod.id}\n---\n\nPlan.\n`);
      fs.utimesSync(infMod, hace10s, hace10s);
      buzones.escribirPunteros(dataDir, { sesion: ses, claudePid: pidVivoTest, mcpPid: process.pid, cwd: dir });
      fs.writeFileSync(buzones.rutas(dataDir, ses).mod, JSON.stringify({ ts: Date.now() }));
      pedidosSesion.registrarPedido({
        dataDir,
        env: { CLAUDECODE: '1', CLAUDE_PID: String(pidVivoTest) },
        id: pMod.id, tipo: 'plan', modo: 'plan', tool: 'agy_plan', raiz: dir
      });
      const rModVivo = await correrHook(['espera'], { env: envHook, stdin: JSON.stringify({ session_id: ses }), timeoutMs: 8000 });
      check('con sesion y modVivo=true, pedidos auto-recoger NO queda silenciado',
        rModVivo.code === 2 && rModVivo.stderr.includes(`pedido: "${pMod.id}"`) && rModVivo.stderr.includes('agy_plan'),
        `code=${rModVivo.code} stderr=${rModVivo.stderr}`);
      buzones.borrarPunteros(dataDir, ses, process.pid);

      // Submodo mod-pedido-estado marca descartado usando ppid (= pid del test runner) incluso con CLAUDE_PID ajeno en env
      const pDesc = pedidosAgy.crearPedido({ cwd: dir, tipo: 'review', prompt: 'R' });
      pedidosSesion.registrarPedido({
        dataDir,
        env: { CLAUDECODE: '1', CLAUDE_PID: String(process.pid) },
        id: pDesc.id, tipo: 'review', tool: 'agy_review', raiz: dir
      });
      const rDesc = await correrHook(['mod-pedido-estado', pDesc.id, 'descartado'], { env: { TELEGRAM_BRIDGE_DATA_DIR: dataDir, CLAUDE_PID: '999999' } });
      check('mod-pedido-estado marca descartado con ppid ignorando CLAUDE_PID ajeno',
        rDesc.code === 0 && pedidosSesion.leerPedidos(dataDir, process.pid).find((x) => x.id === pDesc.id)?.estado === 'descartado');
    });
  } finally {
    removeFixture(dir);
    removeFixture(dataDir);
    removeFixture(globalCfgDir);
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
