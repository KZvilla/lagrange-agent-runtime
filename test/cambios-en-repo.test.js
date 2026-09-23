/**
 * SEC-020 — Las tools "de solo lectura" (plan/review/audit/research) no pueden
 * impedir que agy escriba: corren con `--mode plan --dangerously-skip-permissions`
 * y sus `deny_*` son texto en el prompt. Lo que sí hacen es decirlo y mostrar qué
 * cambió en el repo mientras corrían.
 *
 * 1. El módulo de fotos de `git status` contra un repo temporal real.
 * 2. El servidor con agy stubbeado: la salida informa lo que el "agy" escribió.
 * 3. El catálogo ya no promete lo que no cumple.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const { fotoDelRepo, compararFotos, formatearCambios } = require('../mcp-server/lib/cambios-en-repo.js');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function repoTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec020-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'limpio.txt'), 'uno\n');
  fs.writeFileSync(path.join(dir, 'a borrar.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, 'sucio.txt'), 'uno\n');
  fs.writeFileSync(path.join(dir, 'viejo.txt'), 'renombrar\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'hondo.txt'), 'h\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'inicial');
  // Sucio desde antes de la primera foto, y un sin trackear que después se borra.
  fs.writeFileSync(path.join(dir, 'sucio.txt'), 'dos\n');
  fs.writeFileSync(path.join(dir, 'efimero.txt'), 'e\n');
  return dir;
}

const porRuta = (dif) => Object.fromEntries(dif.cambios.map((c) => [c.ruta, c]));

async function main() {
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'sec020-nogit-'));
  const repo = repoTemporal();
  try {
    await group('fuera de un repo no se inventa nada', () => {
      check('fotoDelRepo da null', fotoDelRepo(noGit) === null);
      check('compararFotos da null', compararFotos(null, null) === null);
      const texto = formatearCambios(null, { cwd: noGit });
      check('la salida dice que no se revisó', texto.includes('not checked') && texto.includes(noGit), texto);
    });

    await group('sin cambios', () => {
      const a = fotoDelRepo(repo);
      const b = fotoDelRepo(repo);
      check('hay foto', !!a && a.entradas.size > 0);
      check('la rama es main y hay HEAD', a.rama === 'main' && /^[0-9a-f]{40}$/.test(a.head), JSON.stringify({ rama: a.rama, head: a.head }));
      const dif = compararFotos(a, b);
      check('ningún cambio', dif.cambios.length === 0, JSON.stringify(dif.cambios));
      check('la salida lo dice', formatearCambios(dif).includes('no changes detected'));
    });

    await group('cada transición se reporta como tal', () => {
      const antes = fotoDelRepo(repo);
      fs.writeFileSync(path.join(repo, 'nuevo.txt'), 'n\n');
      fs.writeFileSync(path.join(repo, 'limpio.txt'), 'uno y más\n');
      fs.rmSync(path.join(repo, 'a borrar.txt'));
      fs.writeFileSync(path.join(repo, 'sucio.txt'), 'tres, más largo\n');
      fs.rmSync(path.join(repo, 'efimero.txt'));
      git(repo, 'mv', 'viejo.txt', 'nuevo nombre.txt');
      const dif = compararFotos(antes, fotoDelRepo(repo));
      const c = porRuta(dif);
      check('sin trackear nuevo: clean → ??', c['nuevo.txt'] && c['nuevo.txt'].antes === null && c['nuevo.txt'].despues === '??', JSON.stringify(c['nuevo.txt']));
      check('trackeado limpio modificado: clean → .M', c['limpio.txt'] && c['limpio.txt'].antes === null && c['limpio.txt'].despues === '.M', JSON.stringify(c['limpio.txt']));
      check('trackeado limpio borrado (ruta con espacio): clean → .D', c['a borrar.txt'] && c['a borrar.txt'].despues === '.D', JSON.stringify(c['a borrar.txt']));
      check('ya sucio y vuelto a tocar: .M → .M', c['sucio.txt'] && c['sucio.txt'].antes === '.M' && c['sucio.txt'].despues === '.M', JSON.stringify(c['sucio.txt']));
      check('sin trackear borrado: ?? → gone', c['efimero.txt'] && c['efimero.txt'].antes === '??' && c['efimero.txt'].despues === null, JSON.stringify(c['efimero.txt']));
      check('renombre: aparece la ruta nueva con R', c['nuevo nombre.txt'] && c['nuevo nombre.txt'].despues === 'R.', JSON.stringify(c['nuevo nombre.txt']));
      check('renombre: el origen no es un registro propio', !c['viejo.txt'], JSON.stringify(c['viejo.txt']));
      const texto = formatearCambios(dif, { etiqueta: 'agy_audit' });
      check('la salida avisa', texto.includes('The working tree changed while agy_audit ran'), texto);
      check('con las transiciones', texto.includes('`efimero.txt`: ?? → gone') && texto.includes('`sucio.txt`: .M → .M (content changed)')
        && texto.includes('`limpio.txt`: clean → .M'), texto);
      check('y sin tocar nada', texto.includes('Nothing was reverted or deleted'));
    });

    await group('commit, subdirectorio y HEAD detached', () => {
      const antes = fotoDelRepo(path.join(repo, 'sub'));
      check('desde un subdirectorio, rutas relativas a la raíz', antes && antes.entradas.has('sucio.txt'), antes && [...antes.entradas.keys()].join(','));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'segundo');
      const dif = compararFotos(antes, fotoDelRepo(path.join(repo, 'sub')));
      check('el commit cambia HEAD', dif.headAntes !== dif.headDespues && !!dif.headDespues);
      check('y la salida lo muestra', formatearCambios(dif).includes('- HEAD:'));
      git(repo, 'checkout', '-q', '--detach');
      const detached = fotoDelRepo(repo);
      check('detached: hay foto', detached !== null);
      check('detached: sin rama', detached && detached.rama === '');
    });

    await group('el servidor lo informa (agy stubbeado que escribe)', async () => {
      const capture = path.join(noGit, 'capture.jsonl');
      fs.writeFileSync(capture, '');
      process.env.STUB_ESCRIBIR = 'diff.diff';
      const server = startServer({ cwd: repo, captureFile: capture });
      try {
        await server.initialize();
        for (const [tool, args] of [
          ['agy_audit', { target: 'git diff', cwd: repo }],
          ['agy_plan', { task: 'x', cwd: repo }],
          ['agy_review', { review_target: 'git diff', cwd: repo }]
        ]) {
          fs.rmSync(path.join(repo, 'diff.diff'), { force: true });
          const r = await server.callTool(tool, args);
          const texto = (((r.result || {}).content || [])[0] || {}).text || '';
          check(`${tool}: informa el archivo escrito`, texto.includes('`diff.diff`: clean → ??'), texto.slice(-600));
          check(`${tool}: no dice read-only ni Enforced`, !/read-only|Permissions Enforced/.test(texto), texto.slice(-400));
        }
        const r = await server.callTool('agy_plan', { task: 'x', cwd: noGit });
        const texto = (((r.result || {}).content || [])[0] || {}).text || '';
        check('fuera de un repo: not checked', texto.includes('not checked'), texto.slice(-300));
      } finally {
        delete process.env.STUB_ESCRIBIR;
        await server.stop();
      }
    });

    await group('el catálogo no promete lo que no cumple', async () => {
      const server = startServer({ cwd: noGit });
      try {
        await server.initialize();
        const tools = (((await server.listTools()).result || {}).tools || []);
        const porNombre = Object.fromEntries(tools.map((t) => [t.name, t]));
        // "not enforced" es justo lo que tiene que decir; lo falso es afirmar que algo se hace cumplir.
        const falsas = /\b(?:are|is) enforced\b|\benforces\b|impossible|guaranteed|read-only mode|never edits/i;
        for (const nombre of ['agy_plan', 'agy_review', 'agy_audit', 'agy_research', 'agy_session_summary']) {
          const t = porNombre[nombre];
          const json = JSON.stringify(t);
          check(`${nombre}: sin promesas falsas`, !!t && !falsas.test(json), (json.match(falsas) || [])[0]);
        }
        for (const nombre of ['agy_plan', 'agy_review', 'agy_audit', 'agy_research']) {
          check(`${nombre}: sin anotaciones de solo lectura`, porNombre[nombre] && porNombre[nombre].annotations === undefined,
            JSON.stringify(porNombre[nombre] && porNombre[nombre].annotations));
        }
      } finally {
        await server.stop();
      }
    });

    await group('los cuatro handlers sacan la foto antes y después', () => {
      const fuente = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'index.js'), 'utf8');
      for (const tool of ['agy_plan', 'agy_audit', 'agy_review', 'agy_research']) {
        const desde = fuente.indexOf(`case '${tool}': {`);
        const hasta = fuente.indexOf("\n    case '", desde + 10);
        const cuerpo = fuente.slice(desde, hasta);
        const iAntes = cuerpo.indexOf('fotoDelRepo(');
        const iExec = cuerpo.indexOf('await executeAgy(');
        const iDespues = cuerpo.indexOf('fotoDelRepo(', iExec);
        check(`${tool}: foto, executeAgy, foto`, desde >= 0 && iAntes >= 0 && iAntes < iExec && iDespues > iExec);
      }
    });
  } finally {
    removeFixture(noGit);
    removeFixture(repo);
  }

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
