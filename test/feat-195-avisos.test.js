/**
 * FEAT-195 Fase 4 — Los avisos de Claude Code sobre la cola de auditorías:
 * - `pedidosSesion.textoRecoger` es el único armador del texto de recogida (cola nueva: `auditoria` + `accion`;
 *   cola de agy: su tool + `pedido:`), y una `tool` desconocida en el cursor no llega al texto;
 * - `hooks/panel.js` (`informesAviso`) lee las dos colas, de la nueva solo los informes que pidió esta sesión, y cada
 *   uno lleva `recoger` ya armado, sin rutas absolutas ni cuerpo;
 * - `hooks/buzon.js` despierta con el texto de la cola nueva (sin `.lagrange/agy/` ni `pedido:`).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { removeFixture } = require('./lib/mcp-client');

const RAIZ = path.join(__dirname, '..');
const pedidosSesion = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-sesion.js'));
const pedidosAgy = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-agy.js'));
const cola = require(path.join(RAIZ, 'mcp-server', 'lib', 'cola-auditorias.js'));
const panel = require(path.join(RAIZ, 'hooks', 'panel.js'));

const SPICA = 'claude:aaaaaaaa-0000-4000-8000-00000000000a';
const EPI = 'claude:cccccccc-0000-4000-8000-00000000000c';

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat195a-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'inicio');
  return dir;
}

/** Pide (solicitante), toma y entrega (auditor) un pedido de la cola nueva; devuelve el id. */
function auditado(dir, solicitante, auditor, veredicto = 'PASS') {
  const p = cola.pedir({ cwd: dir, modo: 'plan', prompt: 'Auditá el plan.', solicitante });
  cola.tomar({ cwd: dir, id: p.id, yo: auditor });
  const e = cola.entregar({ cwd: dir, id: p.id, yo: auditor, informe: `## Verdict: ${veredicto}\n\nSECRETO_CUERPO\n` });
  if (!e.ok) throw new Error(`entregar falló: ${JSON.stringify(e)}`);
  return p.id;
}

function correr(args, env, ms = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdin.end('{}');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { child.kill(); resolve({ code: null, timedOut: true, stdout, stderr }); }, ms);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, timedOut: false, stdout, stderr }); });
  });
}

async function main() {
  const dir = repo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat195a-data-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat195a-cfg-'));
  const PID_A = 535353;
  const PID_C = 545454;
  const envClaude = (pid) => ({ CLAUDECODE: '1', CLAUDE_PID: String(pid) });
  try {
    await group('textoRecoger: un solo armador para las dos colas', () => {
      const nuevo = pedidosSesion.textoRecoger({ id: 'a1b2c3', tool: 'auditoria' });
      check('cola nueva: audit_queue + action collect + id', nuevo.includes('`audit_queue`') && nuevo.includes('action: "collect"') && nuevo.includes('id: "a1b2c3"') && !nuevo.includes('request_id:'), nuevo);
      check('cola nueva: ruta en .lagrange/auditorias/', pedidosSesion.rutaInforme({ id: 'a1b2c3', tool: 'auditoria' }) === '.lagrange/auditorias/informes/a1b2c3.md');
      const viejo = pedidosSesion.textoRecoger({ id: 'a1b2c3', tipo: 'review', tool: 'agy_review' });
      check('cola de agy: su tool + request_id:', viejo.includes('`review`') && viejo.includes('request_id: "a1b2c3"'), viejo);
      check('cola de agy: ruta en .lagrange/agy/', pedidosSesion.rutaInforme({ id: 'a1b2c3', tool: 'agy_audit' }) === '.lagrange/agy/informes/a1b2c3.md');
      const raro = pedidosSesion.textoRecoger({ id: 'a1b2c3', tipo: 'plan', tool: 'rm -rf / `x`' });
      check('una tool desconocida cae a la de su tipo', raro.includes('`plan`') && !raro.includes('rm -rf'), raro);
      check('un id inválido no arma nada', pedidosSesion.textoRecoger({ id: '../x', tool: 'auditoria' }) === null && pedidosSesion.rutaInforme({ id: 'ZZ' }) === null);
    });

    let idMio; let idAjeno; let idLegado;
    await group('panel.js: las dos colas, de la nueva solo lo propio', () => {
      // Spica pidió idMio (y lo registró en su cursor); Epikouros pidió idAjeno y Spica lo auditó.
      idMio = auditado(dir, SPICA, EPI, 'FAIL');
      pedidosSesion.registrarPedido({ dataDir, env: envClaude(PID_A), id: idMio, tipo: 'audit', modo: 'plan', tool: 'auditoria', raiz: dir });
      idAjeno = auditado(dir, EPI, SPICA);
      pedidosSesion.registrarPedido({ dataDir, env: envClaude(PID_C), id: idAjeno, tipo: 'audit', modo: 'plan', tool: 'auditoria', raiz: dir });
      // Un pedido de la cola de agy (legado) con su informe estable.
      const pl = pedidosAgy.crearPedido({ cwd: dir, tipo: 'review', prompt: 'Revisar' });
      idLegado = pl.id;
      const infL = path.join(dir, pl.informe);
      fs.writeFileSync(infL, `---\nid: ${pl.id}\n---\n\nHallazgo.\n`);
      const hace10s = new Date(Date.now() - 10_000);
      fs.utimesSync(infL, hace10s, hace10s);

      const env = { TELEGRAM_BRIDGE_DATA_DIR: dataDir };
      const deSpica = panel.informesAviso(dir, env, PID_A);
      const mio = deSpica.find((i) => i.id === idMio);
      check('el propio de la cola nueva sale, propio y con veredicto', mio?.propio === true && mio?.veredicto === 'FAIL' && mio?.tipo === 'audit', JSON.stringify(deSpica));
      check('su recoger es el de la cola nueva', mio?.recoger === pedidosSesion.textoRecoger({ id: idMio, tool: 'auditoria' }));
      check('el que Spica entregó como auditora no le avisa', !deSpica.some((i) => i.id === idAjeno));
      const leg = deSpica.find((i) => i.id === idLegado);
      check('el legado de agy sigue saliendo, con su tool y request_id:', leg?.propio === false && /`review`/.test(leg?.recoger || '') && (leg?.recoger || '').includes(`request_id: "${idLegado}"`), JSON.stringify(leg));
      check('sin cuerpo ni rutas absolutas', !JSON.stringify(deSpica).includes('SECRETO_CUERPO') && !JSON.stringify(deSpica).includes(dir.replace(/\\/g, '/')) && !JSON.stringify(deSpica).includes(dir));

      const deEpi = panel.informesAviso(dir, env, PID_C);
      check('a Epikouros le avisa el suyo y no el de Spica', deEpi.some((i) => i.id === idAjeno && i.propio) && !deEpi.some((i) => i.id === idMio));
      const sinPid = panel.informesAviso(dir, env, null);
      check('sin pid no muestra nada de la cola nueva', !sinPid.some((i) => i.id === idMio || i.id === idAjeno) && sinPid.some((i) => i.id === idLegado));

      pedidosSesion.marcarEstado({ dataDir, claudePid: PID_A, id: idMio, estado: 'recogido' });
      check('ya recogido, deja de salir', !panel.informesAviso(dir, env, PID_A).some((i) => i.id === idMio));
    });

    await group('buzon.js: despierta con el texto de la cola nueva', async () => {
      const idWake = auditado(dir, SPICA, EPI);
      const pidVivo = process.pid;
      pedidosSesion.registrarPedido({ dataDir, env: envClaude(pidVivo), id: idWake, tipo: 'audit', modo: 'plan', tool: 'auditoria', raiz: dir });
      const cfg = path.join(cfgDir, 'antigravity.json');
      fs.writeFileSync(cfg, JSON.stringify({ agy_auto_recoger: true }));
      const r = await correr([path.join(RAIZ, 'hooks', 'buzon.js'), 'espera'], {
        TELEGRAM_BRIDGE_DATA_DIR: dataDir, LAGRANGE_AGY_MODO_CONFIG: cfg, HOME: cfgDir, USERPROFILE: cfgDir,
        CLAUDECODE: '1', CLAUDE_PID: String(pidVivo)
      });
      check('código 2 con audit_queue + action collect',
        r.code === 2 && r.stderr.includes(`id: "${idWake}"`) && r.stderr.includes('`audit_queue`') && r.stderr.includes('action: "collect"'),
        `code=${r.code} stderr=${r.stderr}`);
      check('no nombra la cola de agy ni pedido:', !r.stderr.includes('.lagrange/agy/') && !r.stderr.includes('pedido:') && r.stderr.includes(`.lagrange/auditorias/informes/${idWake}.md`), r.stderr);
      check('lo marcó recogido en el cursor', pedidosSesion.leerPedidos(dataDir, pidVivo).find((p) => p.id === idWake)?.estado === 'recogido');
    });
  } finally {
    removeFixture(dir);
    removeFixture(dataDir);
    removeFixture(cfgDir);
  }
  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
