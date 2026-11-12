/**
 * FEAT-192 — Flujo manual de agy: pedido → informe.
 *
 * En modo manual (FEAT-191) agy_audit / agy_review / agy_plan escriben un pedido en `.lagrange/agy/` del proyecto,
 * el usuario lo corre en su agy y Lagrange recoge el informe con `pedido: "<id>"`. Acá: el módulo (`pedidos-agy.js`),
 * el plugin de agy (`agy-plugin/`) y las tres tools de punta a punta por MCP, con el stub de spawn para probar que no
 * se lanza agy.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');

const RAIZ = path.join(__dirname, '..');
const pedidos = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-agy.js'));

function repoDePrueba() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat192-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'SECRETO=1\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'inicio');
  git('checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\ndos\n');
  return dir;
}

const informe = (dir, id, cuerpo) => fs.writeFileSync(path.join(dir, '.lagrange', 'agy', 'informes', `${id}.md`), cuerpo);
const texto = (r) => ((r && r.result && r.result.content) || (r && r.content) || []).map((c) => c.text || '').join('\n');
const esError = (r) => Boolean((r && r.result && r.result.isError) || (r && r.isError));

async function main() {
  const dir = repoDePrueba();
  const otro = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat192-otro-')));
  try {
    await group('crear el pedido', () => {
      const p = pedidos.crearPedido({ cwd: dir, tipo: 'audit', modo: 'implementation', prompt: 'PROCESO DE AUDITORÍA', denyPaths: ['.env*'] });
      check('id de 6 hex', /^[0-9a-f]{6}$/.test(p.id), p.id);
      const cuerpo = fs.readFileSync(path.join(dir, p.pedido), 'utf8');
      const fm = pedidos.frontmatter(cuerpo).campos;
      check('frontmatter con id, tipo, modo, rama, cwd e informe',
        fm.id === p.id && fm.tipo === 'audit' && fm.modo === 'implementation' && fm.rama === 'feat/x'
        && fm.cwd === dir.replace(/\\/g, '/') && fm.informe === `.lagrange/agy/informes/${p.id}.md`, JSON.stringify(fm));
      check('lleva el proceso', cuerpo.includes('PROCESO DE AUDITORÍA'));
      check('pide el veredicto', cuerpo.includes('## Verdict: PASS | PASS WITH RESERVATIONS | FAIL'));
      check('el .gitignore va en .lagrange/agy/, no en .lagrange/', fs.readFileSync(path.join(dir, '.lagrange', 'agy', '.gitignore'), 'utf8').includes('*')
        && !fs.existsSync(path.join(dir, '.lagrange', '.gitignore')));
      const status = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
      check('git no ve la carpeta de pedidos', !status.includes('.lagrange'), status);
      const adj = path.join(dir, p.adjuntos);
      check('contexto de git: estado, log y diffs', ['estado.txt', 'log.txt', 'diff-sin-commitear.patch', 'diff-rama.patch'].every((a) => fs.existsSync(path.join(adj, a))));
      check('el diff trae el cambio', fs.readFileSync(path.join(adj, 'diff-sin-commitear.patch'), 'utf8').includes('+dos'));
      check('deny_paths no aparece en el estado', !fs.readFileSync(path.join(adj, 'estado.txt'), 'utf8').includes('.env.local'));
      check('pendiente al crearlo', pedidos.recogerInforme({ cwd: dir, id: p.id }).estado === 'pendiente');
      check('aparece en pendientes', pedidos.listarPendientes(dir).some((x) => x.id === p.id));
    });

    await group('ids inválidos (sin path traversal)', () => {
      for (const id of ['../../x', 'ABCDEF', '12345', 'a1b2c3d', '', null]) {
        let lanzo = false;
        try { pedidos.recogerInforme({ cwd: dir, id }); } catch { lanzo = true; }
        check(`rechaza ${JSON.stringify(id)}`, lanzo);
      }
      let lanzo = false;
      try { pedidos.recogerInforme({ cwd: dir, id: 'abcdef' }); } catch (err) { lanzo = /no hay pedido/.test(err.message); }
      check('un id bien formado sin pedido da error claro', lanzo);
    });

    await group('recoger el informe', () => {
      const p = pedidos.crearPedido({ cwd: dir, tipo: 'audit', modo: 'plan', prompt: 'X' });
      informe(dir, p.id, `---\nid: ${p.id}\n---\n\n## Verdict: FAIL\n\nF1 algo.\n`);
      const r = pedidos.recogerInforme({ cwd: dir, id: p.id });
      check('listo con veredicto', r.estado === 'listo' && r.veredicto === 'FAIL', JSON.stringify(r));
      check('sin el frontmatter en el texto', !r.texto.startsWith('---') && r.texto.includes('F1 algo.'));
      check('lleva el modo del pedido', r.modo === 'plan');

      const q = pedidos.crearPedido({ cwd: dir, tipo: 'audit', prompt: 'X' });
      informe(dir, q.id, '---\nid: 000000\n---\n\n## Verdict: PASS\n');
      check('id distinto: inválido', pedidos.recogerInforme({ cwd: dir, id: q.id }).estado === 'invalido');
      informe(dir, q.id, `---\nid: ${q.id}\n---\n\nTodo bien.\n`);
      const sinV = pedidos.recogerInforme({ cwd: dir, id: q.id });
      check('auditoría sin veredicto: inválido', sinV.estado === 'invalido' && sinV.problemas.some((x) => x.includes('Verdict')));

      const rv = pedidos.crearPedido({ cwd: dir, tipo: 'review', prompt: 'X' });
      informe(dir, rv.id, `---\nid: ${rv.id}\n---\n\nHallazgos.\n`);
      check('una revisión no necesita veredicto', pedidos.recogerInforme({ cwd: dir, id: rv.id }).estado === 'listo');
    });

    await group('el cwd del pedido manda', () => {
      const p = pedidos.crearPedido({ cwd: dir, tipo: 'review', prompt: 'X' });
      const ajeno = path.join(otro, '.lagrange', 'agy', 'pedidos');
      fs.mkdirSync(ajeno, { recursive: true });
      fs.copyFileSync(path.join(dir, p.pedido), path.join(ajeno, `${p.id}.md`));
      let msg = '';
      try { pedidos.recogerInforme({ cwd: otro, id: p.id }); } catch (err) { msg = err.message; }
      check('pedido de otro proyecto: error', /es de .*recogelo con ese cwd/.test(msg), msg);
    });

    await group('esperar y barrer', async () => {
      const p = pedidos.crearPedido({ cwd: dir, tipo: 'plan', prompt: 'X' });
      setTimeout(() => informe(dir, p.id, `---\nid: ${p.id}\n---\n\nEl plan.\n`), 300);
      const r = await pedidos.esperarInforme({ cwd: dir, id: p.id, segundos: 5, intervaloMs: 100 });
      check('esperar lo encuentra cuando aparece', r.estado === 'listo');
      const t0 = Date.now();
      const q = pedidos.crearPedido({ cwd: dir, tipo: 'plan', prompt: 'X' });
      const r2 = await pedidos.esperarInforme({ cwd: dir, id: q.id, segundos: 0 });
      check('sin espera vuelve al toque', r2.estado === 'pendiente' && Date.now() - t0 < 3000);

      const viejo = path.join(dir, q.pedido);
      const hace = new Date(Date.now() - 40 * 86400000);
      fs.utimesSync(viejo, hace, hace);
      const borrados = pedidos.barrer(dir);
      check('barre los de más de 30 días', borrados.includes(q.id) && !fs.existsSync(viejo) && !fs.existsSync(path.join(dir, '.lagrange', 'agy', 'pedidos', q.id)));
      check('no barre los nuevos', fs.existsSync(path.join(dir, p.pedido)));
    });

    await group('el plugin de agy', async () => {
      const { validarPlugin, instalar, NOMBRE } = await import('../scripts/agy-plugin.mjs');
      check('agy-plugin/ es válido', validarPlugin().length === 0, validarPlugin().join('; '));
      const skills = fs.readdirSync(path.join(RAIZ, 'agy-plugin', 'skills'));
      check('las tres skills del pedido', ['auditar', 'revisar', 'planear'].every((s) => skills.includes(`lagrange-${s}`)));
      for (const [tipo, t] of Object.entries(pedidos.TIPOS)) check(`la skill de ${tipo} existe`, skills.includes(t.skill));
      const sinHooks = !fs.existsSync(path.join(RAIZ, 'agy-plugin', 'hooks.json')) && !fs.existsSync(path.join(RAIZ, 'agy-plugin', 'agents'));
      check('sin hooks ni subagentes (decisión del usuario)', sinHooks);
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat192-home-'));
      const destino = path.join(home, '.gemini', 'config', 'plugins', NOMBRE);
      instalar({ destino });
      check('instalar copia la carpeta', fs.existsSync(path.join(destino, 'plugin.json')) && fs.existsSync(path.join(destino, 'skills', 'lagrange-auditar', 'SKILL.md')));
      instalar({ destino });
      check('reinstalar pisa su propia carpeta', fs.existsSync(path.join(destino, 'plugin.json')));
      const ajeno = path.join(home, 'ajeno');
      fs.mkdirSync(ajeno);
      fs.writeFileSync(path.join(ajeno, 'plugin.json'), '{"name":"otro"}');
      let lanzo = false;
      try { instalar({ destino: ajeno }); } catch { lanzo = true; }
      check('no pisa un plugin ajeno', lanzo && fs.readFileSync(path.join(ajeno, 'plugin.json'), 'utf8').includes('otro'));
      removeFixture(home);
    });

    await group('las tools por MCP, en modo manual, sin lanzar agy', async () => {
      const capture = path.join(otro, 'capture.jsonl');
      fs.writeFileSync(capture, '');
      const server = startServer({ cwd: dir, captureFile: capture, env: { LAGRANGE_AGY_MODO: 'manual' } });
      try {
        await server.initialize();
        const a = await server.callTool('agy_audit', { target: 'la rama feat/x', plan: 'EL PLAN', cwd: dir });
        const ta = texto(a);
        const id = (/pedido `([0-9a-f]{6})` listo/.exec(ta) || [])[1];
        check('agy_audit crea el pedido y no es error', id && !esError(a), ta.slice(0, 300));
        check('el aviso dice Manual mode is on', ta.includes('AGY Audit — Manual mode is on'));
        check('dice cómo correrlo y recogerlo', ta.includes('/lagrange-auditar') && ta.includes(`pedido: "${id}"`));
        const cuerpo = fs.readFileSync(path.join(dir, '.lagrange', 'agy', 'pedidos', `${id}.md`), 'utf8');
        check('el pedido lleva el plan y la skill adversarial', cuerpo.includes('EL PLAN') && cuerpo.includes('[AUDIT TASK]'));

        const pend = await server.callTool('agy_audit', { pedido: id, cwd: dir });
        check('recoger pendiente: no es error', !esError(pend) && texto(pend).includes('pendiente'), texto(pend));
        informe(dir, id, `---\nid: ${id}\n---\n\n## Verdict: PASS WITH RESERVATIONS\n\nNota.\n`);
        const lista = await server.callTool('agy_audit', { pedido: id, cwd: dir, esperar_segundos: 2 });
        const tl = texto(lista);
        check('recoger listo: el informe con su veredicto', !esError(lista) && tl.includes('Adversarial Audit') && tl.includes('Verdict: PASS WITH RESERVATIONS') && tl.includes('Nota.'), tl.slice(0, 400));
        const cruzado = await server.callTool('agy_review', { pedido: id, cwd: dir });
        check('recoger con la tool equivocada: error', esError(cruzado) && texto(cruzado).includes('agy_audit'));

        const rv = await server.callTool('agy_review', { review_target: 'git diff', cwd: dir });
        check('agy_review crea pedido', /AGY Review — Manual mode is on: pedido/.test(texto(rv)) && !esError(rv), texto(rv).slice(0, 200));
        const pl = await server.callTool('agy_plan', { task: 'algo', mode: 'consultation', cwd: dir });
        check('agy_plan crea pedido', /AGY Plan — Manual mode is on: pedido/.test(texto(pl)) && !esError(pl));
        const hilo = await server.callTool('agy_plan', { task: 'algo', conversation_id: 'abc', cwd: dir });
        check('conversation_id en manual: rechazado', esError(hilo));
        const sinTarget = await server.callTool('agy_audit', { cwd: dir });
        check('sin target ni pedido: error', esError(sinTarget) && texto(sinTarget).includes('target es obligatorio'));

        const run = await server.callTool('agy_run', { prompt: 'x', cwd: dir });
        check('agy_run: aviso sin isError', !esError(run) && texto(run).includes('AGY Run — Manual mode is on') && texto(run).includes('Nothing was launched'), texto(run).slice(0, 200));
      } finally {
        await server.stop();
      }
      const lanzados = fs.readFileSync(capture, 'utf8').trim();
      check('ninguna llamada lanzó agy', lanzados === '', lanzados.slice(0, 300));
    });
  } finally {
    removeFixture(dir);
    removeFixture(otro);
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
