/**
 * SEC-020 fase 2 — La instantánea del árbol de trabajo que monta el contenedor
 * de las tools de solo lectura. Contra un repo temporal real.
 *
 * Lo central: entra lo que hay en disco (incluido lo sin commitear), no entra lo
 * ignorado ni lo de `deny_paths` (ni en los diffs), y NADA se escribe en git.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { instantaneaDeTrabajo, filtrarPatch, rutasDelBloque, DIR_ARTEFACTOS } = require('../mcp-server/lotes/instantanea.js');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function contarObjetos(repo) {
  let n = 0;
  const dir = path.join(repo, '.git', 'objects');
  for (const d of fs.readdirSync(dir)) {
    if (/^[0-9a-f]{2}$/.test(d)) n += fs.readdirSync(path.join(dir, d)).length;
  }
  return n;
}
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function repoTemporal() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ro-inst-repo-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n*.log\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(dir, '.env'), 'CLAVE=commiteada-por-error\n');
  fs.mkdirSync(path.join(dir, 'cfg'));
  fs.writeFileSync(path.join(dir, 'cfg', 'server.key'), 'PRIVADA\n');
  fs.writeFileSync(path.join(dir, 'borrar.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'inicial');
  // Cambios sin commitear: modificado, nuevo, borrado, ignorado, secreto modificado.
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(2); // cambio sin commitear\n');
  fs.writeFileSync(path.join(dir, 'nuevo archivo.md'), '# nuevo\n');
  fs.rmSync(path.join(dir, 'borrar.txt'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'lib', 'x.js'), 'x\n');
  fs.writeFileSync(path.join(dir, 'debug.log'), 'ruido\n');
  fs.writeFileSync(path.join(dir, '.env'), 'CLAVE=otra-cosa-secreta\n');
  return dir;
}

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-inst-raiz-'));
  const repo = repoTemporal();
  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-inst-norepo-'));
  try {
    const indiceAntes = hash(path.join(repo, '.git', 'index'));
    const objetosAntes = contarObjetos(repo);
    const r = instantaneaDeTrabajo({ repo, destino: path.join(raiz, 'ro-x'), raizPermitida: raiz, denyPaths: ['.env*', '**/*.key', '**/*.pem'] });
    const en = (rel) => path.join(r.destino, rel);

    await group('lo que hay en disco entra, tal cual', () => {
      check('el modificado, con el contenido sin commitear', fs.readFileSync(en('app.js'), 'utf8').includes('cambio sin commitear'));
      check('el nuevo (con espacio en el nombre)', fs.existsSync(en('nuevo archivo.md')));
      check('el borrado no', !fs.existsSync(en('borrar.txt')));
      check('.gitignore sí (es del repo)', fs.existsSync(en('.gitignore')));
      check('el conteo', r.archivos === 3, `archivos=${r.archivos}`);
    });

    await group('lo que no entra', () => {
      check('lo ignorado', !fs.existsSync(en('node_modules')) && !fs.existsSync(en('debug.log')));
      check('deny_paths: .env commiteado', !fs.existsSync(en('.env')));
      check('deny_paths: **/*.key', !fs.existsSync(en('cfg/server.key')) && !fs.existsSync(en('cfg')));
      check('se cuentan', r.excluidos === 2, `excluidos=${r.excluidos}`);
      check('sin .git', !fs.existsSync(en('.git')));
    });

    await group('contexto de git sin .git', () => {
      const estado = fs.readFileSync(en(`${DIR_ARTEFACTOS}/estado.txt`), 'utf8');
      const diff = fs.readFileSync(en(`${DIR_ARTEFACTOS}/diff-sin-commitear.patch`), 'utf8');
      check('estado con rama y HEAD', estado.includes('rama: main') && /HEAD: [0-9a-f]{40}/.test(estado));
      check('estado lista el nuevo y el borrado', estado.includes('nuevo archivo.md') && estado.includes('borrar.txt'));
      check('estado no nombra los excluidos', !estado.includes('.env') && !estado.includes('server.key'), estado);
      check('el diff trae el cambio de app.js', diff.includes('cambio sin commitear'));
      check('el diff NO trae el .env (ni su contenido)', !diff.includes('.env') && !diff.includes('secreta'), diff);
      check('log', fs.readFileSync(en(`${DIR_ARTEFACTOS}/log.txt`), 'utf8').includes('inicial'));
    });

    await group('nada se escribió en git', () => {
      check('.git/index idéntico', hash(path.join(repo, '.git', 'index')) === indiceAntes);
      check('ningún objeto nuevo', contarObjetos(repo) === objetosAntes, `${objetosAntes} → ${contarObjetos(repo)}`);
      check('el árbol del usuario sigue igual', fs.readFileSync(path.join(repo, '.env'), 'utf8').includes('secreta'));
    });

    await group('guardas', () => {
      let err = null;
      try { instantaneaDeTrabajo({ repo: noRepo, destino: path.join(raiz, 'ro-y'), raizPermitida: raiz }); } catch (e) { err = e; }
      check('fuera de un repo, error claro', err && /no está dentro de un repositorio git/.test(err.message));
      err = null;
      try { instantaneaDeTrabajo({ repo, destino: path.join(os.tmpdir(), 'fuera-de-la-raiz'), raizPermitida: raiz }); } catch (e) { err = e; }
      check('destino fuera de la raíz permitida', err && /tiene que quedar dentro/.test(err.message));
      fs.mkdirSync(path.join(repo, DIR_ARTEFACTOS));
      fs.writeFileSync(path.join(repo, DIR_ARTEFACTOS, 'x'), 'x');
      err = null;
      try { instantaneaDeTrabajo({ repo, destino: path.join(raiz, 'ro-z'), raizPermitida: raiz }); } catch (e) { err = e; }
      check('el nombre reservado choca con el repo', err && err.message.includes(DIR_ARTEFACTOS));
      fs.rmSync(path.join(repo, DIR_ARTEFACTOS), { recursive: true, force: true });
    });

    await group('filtrado de patches', () => {
      const patch = [
        'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1 +1 @@', '-x', '+y',
        'diff --git a/.env b/.env', '--- a/.env', '+++ b/.env', '@@ -1 +1 @@', '-A=1', '+A=2',
        'diff --git a/k.key b/k.key', 'Binary files a/k.key and b/k.key differ',
        'diff --git "a/ra\\tro" "b/ra\\tro"', 'Binary files differ', ''
      ].join('\n');
      const excl = (r) => /(^|\/)\.env|\.key$/.test(r);
      const f = filtrarPatch(patch, excl);
      check('queda el permitido', f.includes('src/a.js') && f.includes('+y'));
      check('se va el excluido con ---/+++', !f.includes('.env') && !f.includes('A=2'));
      check('se va el binario excluido (por encabezado)', !f.includes('k.key'));
      check('un encabezado entrecomillado sin ---/+++ se descarta (ante la duda)', !f.includes('ra\\tro'));
      check('rutasDelBloque con espacios', JSON.stringify(rutasDelBloque('diff --git a/x y.md b/x y.md\nBinary files differ')) === '["x y.md"]');
      const grande = `diff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -0,0 +1 @@\n+${'z'.repeat(1100 * 1024)}\n`;
      check('tope de 1 MB con marca', filtrarPatch(grande, () => false).includes('patch truncado'));
    });
  } finally {
    for (const d of [raiz, repo, noRepo]) fs.rmSync(d, { recursive: true, force: true });
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
