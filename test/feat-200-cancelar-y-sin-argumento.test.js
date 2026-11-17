/**
 * FEAT-200 — `cancel` en la cola de auditorías (`anular`), la carrera con `tomar` (audit 7babf5 F1), el cursor del
 * solicitante (F3), el informe a medio escribir (F4), y que `/lagrange:audit` sin argumento vaya primero a la cola
 * (con `which: "mine"`, F2/F5) en Claude y en opencode.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');

const RAIZ = path.join(__dirname, '..');
const RUTA_COLA = path.join(RAIZ, 'mcp-server', 'lib', 'cola-auditorias.js');
const cola = require(RUTA_COLA);
const pedidosSesion = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-sesion.js'));

const A = 'claude:11111111-aaaa-bbbb-cccc-000000000001';
const B = 'opencode:ses_auditorB';
const BIEN = '## Verdict: PASS\n\nTodo en orden.\n';
const texto = (r) => ((r && r.result && r.result.content) || []).map((c) => c.text || '').join('\n');
const esError = (r) => Boolean(r && r.result && r.result.isError);
const idDe = (t) => (/pedido `([0-9a-f]{6})` en la cola/.exec(t) || [])[1];
const lanza = (fn) => { try { fn(); return null; } catch (err) { return err; } };
// Los .md del repo pueden venir con CRLF en un worktree de Windows.
const leerMd = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\r\n/g, '\n');

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'inicio');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\ndos\n');
  return dir;
}

const pedir = (dir) => cola.pedir({ cwd: dir, modo: 'plan', prompt: 'PROCESO + TAREA', solicitante: A });
const rutas = (dir, id) => cola.rutas(dir, id);

/** `anular` (A) y `tomar` (B) del mismo pedido a la vez, en dos procesos. */
function cancelarYTomarEnParalelo(dir, id) {
  const largada = Date.now() + 600;
  const codigo = (accion, yo) => `
    const cola = require(${JSON.stringify(RUTA_COLA)});
    while (Date.now() < ${largada}) {}
    try { cola.${accion}({ cwd: ${JSON.stringify(dir)}, id: ${JSON.stringify(id)}, yo: ${JSON.stringify(yo)} }); console.log('OK'); }
    catch (e) { console.log('ERR ' + e.code); }`;
  const correr = (c) => new Promise((ok) => {
    const p = spawn(process.execPath, ['-e', c], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => ok(out.trim()));
  });
  return Promise.all([correr(codigo('anular', A)), correr(codigo('tomar', B))]);
}

async function conServidor(env, fn) {
  const s = startServer({ env });
  try { await s.initialize(); return await fn(s); } finally { await s.stop(); }
}

async function main() {
  const dir = repo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-data-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-cfg-'));
  try {
    await group('anular: el solicitante retira un pedido pendiente', () => {
      const p = pedir(dir);
      const r = rutas(dir, p.id);
      check('el pedido trae su contexto de git', fs.existsSync(r.adjuntos));
      const res = cola.anular({ cwd: dir, id: p.id, yo: A });
      check('devuelve cancelado', res.cancelado === true && res.id === p.id && res.informeInvalido === false);
      check('borra el pedido, el contexto y el reclamo', !fs.existsSync(r.pedido) && !fs.existsSync(r.adjuntos) && !fs.existsSync(r.tomado));
      check('ya no aparece en listar (de nadie)', !cola.listar({ cwd: dir, yo: B }).some((x) => x.id === p.id) && !cola.listar({ cwd: dir, yo: A, que: 'mios' }).some((x) => x.id === p.id));
      check('tomar después: ENOPEDIDO', lanza(() => cola.tomar({ cwd: dir, id: p.id, yo: B }))?.code === 'ENOPEDIDO');
      check('cancelar dos veces: ENOPEDIDO', lanza(() => cola.anular({ cwd: dir, id: p.id, yo: A }))?.code === 'ENOPEDIDO');
    });

    await group('anular: rechazos', () => {
      const p = pedir(dir);
      check('otra identidad: ENOESTUYO', lanza(() => cola.anular({ cwd: dir, id: p.id, yo: B }))?.code === 'ENOESTUYO');
      check('un anónimo: ENOESTUYO', lanza(() => cola.anular({ cwd: dir, id: p.id, yo: 'claude:anonimo' }))?.code === 'ENOESTUYO');
      cola.tomar({ cwd: dir, id: p.id, yo: B });
      const e = lanza(() => cola.anular({ cwd: dir, id: p.id, yo: A }));
      check('tomado por otro: ETOMADO (sin forzar, F7)', e?.code === 'ETOMADO' && /force/.test(e.message), e && e.message);
      check('sigue en pie', fs.existsSync(rutas(dir, p.id).pedido));
      cola.entregar({ cwd: dir, id: p.id, yo: B, informe: BIEN });
      check('con informe listo: EAUDITADO', lanza(() => cola.anular({ cwd: dir, id: p.id, yo: A }))?.code === 'EAUDITADO');

      // F4 — Un informe escrito a mano, válido y reciente, está "escribiendo": tampoco se cancela.
      const q = pedir(dir);
      const rq = rutas(dir, q.id);
      fs.mkdirSync(path.dirname(rq.informe), { recursive: true });
      fs.writeFileSync(rq.informe, `---\nid: ${q.id}\n---\n\n${BIEN}`);
      check('informe a medio escribir: EAUDITADO', lanza(() => cola.anular({ cwd: dir, id: q.id, yo: A }))?.code === 'EAUDITADO');
      check('el informe sigue ahí', fs.existsSync(rq.informe) && fs.existsSync(rq.pedido));

      // Un informe inválido se va con el pedido: no queda huérfano.
      const v = pedir(dir);
      const rv = rutas(dir, v.id);
      fs.writeFileSync(rv.informe, `---\nid: ${v.id}\n---\n\nsin veredicto\n`);
      const res = cola.anular({ cwd: dir, id: v.id, yo: A });
      check('informe inválido: se cancela y se borra', res.informeInvalido === true && !fs.existsSync(rv.informe) && !fs.existsSync(rv.pedido));
    });

    await group('F1: el lock vuelve a mirar que el pedido existe', () => {
      // `tomar`, `soltar` y `entregar` leen el pedido antes del lock: simulo un `anular` en ese hueco borrándolo.
      const p = pedir(dir);
      const r = rutas(dir, p.id);
      const leer = fs.readFileSync;
      let borrado = false;
      fs.readFileSync = function (ruta, ...resto) {
        const salida = leer.call(fs, ruta, ...resto);
        if (!borrado && ruta === r.pedido) { borrado = true; fs.rmSync(r.pedido); }
        return salida;
      };
      let e;
      try { e = lanza(() => cola.tomar({ cwd: dir, id: p.id, yo: B })); } finally { fs.readFileSync = leer; }
      check('tomar: ENOPEDIDO', e?.code === 'ENOPEDIDO', e && e.message);
      check('no deja tomados/<id>.json huérfano', !fs.existsSync(r.tomado));
    });

    await group('F1: cancel y take a la vez, en dos procesos', async () => {
      let limpias = 0;
      const vueltas = 4;
      for (let i = 0; i < vueltas; i++) {
        const p = pedir(dir);
        const r = rutas(dir, p.id);
        const [anular, tomar] = await cancelarYTomarEnParalelo(dir, p.id);
        const existe = fs.existsSync(r.pedido);
        const tomado = fs.existsSync(r.tomado);
        // Gana uno de los dos, y el estado queda coherente: cancelado sin reclamo, o tomado y en pie.
        const canceloPrimero = anular === 'OK' && tomar === 'ERR ENOPEDIDO' && !existe && !tomado;
        const tomoPrimero = tomar === 'OK' && anular === 'ERR ETOMADO' && existe && tomado;
        if (canceloPrimero || tomoPrimero) limpias++;
        else check(`vuelta ${i}: estado coherente`, false, JSON.stringify({ anular, tomar, existe, tomado }));
      }
      check(`las ${vueltas} vueltas quedan coherentes`, limpias === vueltas);
    });

    const base = {
      LAGRANGE_AGY_MODO: 'manual',
      LAGRANGE_AGY_MODO_CONFIG: path.join(cfgDir, 'antigravity.json'),
      TELEGRAM_BRIDGE_DATA_DIR: dataDir,
      HOME: cfgDir,
      USERPROFILE: cfgDir
    };
    const PID = 616161;
    const spica = { ...base, CLAUDECODE: '1', CLAUDE_PID: String(PID), CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-0000-4000-8000-0000000000a2' };
    const opencode = { ...base, LAGRANGE_HOST: 'opencode', CLAUDECODE: null, CLAUDE_PID: null };

    await group('MCP: cancel por la interfaz en inglés, y el cursor queda descartado (F3)', () => conServidor(spica, async (s) => {
      const pedido = await s.callTool('audit_queue', { action: 'request', audit_mode: 'plan', target: 'EL PLAN', cwd: dir });
      const id = idDe(texto(pedido));
      check('pidió', Boolean(id), texto(pedido).slice(0, 200));
      check('el cursor lo tiene pendiente', pedidosSesion.leerPedidos(dataDir, PID).some((p) => p.id === id && p.estado === 'pendiente'));
      const r = await s.callTool('audit_queue', { action: 'cancel', id, cwd: dir });
      check('responde cancelado', !esError(r) && texto(r).includes(`Pedido \`${id}\` cancelado`), texto(r));
      check('el cursor queda descartado', pedidosSesion.leerPedidos(dataDir, PID).some((p) => p.id === id && p.estado === 'descartado'));
      const mal = await s.callTool('audit_queue', { action: 'cancelar', cwd: dir });
      check('una acción inválida nombra cancel', esError(mal) && texto(mal).includes('cancel'), texto(mal));
    }));

    await group('MCP: opencode no cancela lo de Claude', async () => {
      const id = await conServidor(spica, async (s) => idDe(texto(await s.callTool('audit_queue', { action: 'request', audit_mode: 'plan', target: 'OTRO', cwd: dir }))));
      await conServidor(opencode, async (s) => {
        const r = await s.callTool('audit_queue', { action: 'cancel', id, cwd: dir, session_id: 'ses_ajena' });
        check('rechazado: no es suyo', esError(r) && texto(r).includes('solo quien lo pidió'), texto(r));
      });
      check('el pedido sigue', fs.existsSync(rutas(dir, id).pedido));
    });

    await group('comandos: sin argumento va a la cola (D1, F2, F5)', () => {
      for (const rel of ['commands/audit.md', '.opencode/commands/lagrange/audit.md']) {
        const t = leerMd(rel);
        check(`${rel}: sin default git diff HEAD~1 para el vacío`, !t.includes('If nothing was given, default `target`') && !t.includes('**Anything else, or nothing**'));
        check(`${rel}: nada → list primero`, /\*\*Nothing\*\*[\s\S]{0,200}`action: "list"`/.test(t));
        check(`${rel}: retoma el tomado por mí o el más nuevo`, t.includes('tomado por vos') && t.includes('the newest'));
        check(`${rel}: cola vacía → mira los propios y no crea nada`, t.includes('`which: "mine"`') && t.includes('Create\n        nothing'));
        check(`${rel}: ya no usa que: "mios" (FEAT-197)`, !t.includes('que: "mios"'));
        check(`${rel}: ofrece cancel`, t.includes('`action: "cancel"`'));
      }
      const agy = leerMd('agy-plugin/skills/lagrange-audit/SKILL.md');
      check('agy: sin id toma el más nuevo, con y sin MCP (D2)', !agy.includes('ask which one') && agy.includes('the newest') && agy.includes('newest\n   `creado`'));
    });
  } finally {
    removeFixture(dir);
    removeFixture(dataDir);
    removeFixture(cfgDir);
  }
  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
