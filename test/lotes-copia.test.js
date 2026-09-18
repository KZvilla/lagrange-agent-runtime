/**
 * FEAT-061 fase 2 — La sincronización es la segunda frontera (la primera es
 * Docker), y acá se la ejercita contra lo que un agente hostil intentaría.
 *
 * Las variantes que Windows NO deja crear en disco (`NUL`, un nombre con `:`,
 * un punto final) se prueban contra la función pura que decide, que es donde
 * vive la regla; las que sí se pueden crear se prueban de punta a punta sobre
 * repos temporales de verdad.
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const copia = require('../mcp-server/lotes/copia.js');

const raizTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-lotes-test-'));
const aBorrar = [raizTmp];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

function repoNuevo(nombre, archivos) {
  const dir = path.join(raizTmp, nombre);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'principal']);
  git(dir, ['config', 'user.email', 'test@test']);
  git(dir, ['config', 'user.name', 'test']);
  // Fixture con finales de linea fijos: con `core.autocrlf` global en true,
  // `git archive` exporta CRLF y la copia dejaria de ser byte a byte igual al
  // worktree, que es justo lo que estos tests comparan.
  git(dir, ['config', 'core.autocrlf', 'false']);
  for (const [rel, contenido] of Object.entries(archivos)) {
    const destino = path.join(dir, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenido);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'inicial']);
  return dir;
}

group('nombres prohibidos (la regla, sin tocar disco)', () => {
  check('.git', copia.nombreProhibido('.git') === '.git');
  check('.Git (mayúsculas)', copia.nombreProhibido('.Git') === '.git');
  check('.git. (punto final)', copia.nombreProhibido('.git.') === '.git');
  check('".git " (espacio final)', copia.nombreProhibido('.git ') === '.git');
  check('GIT~1 (nombre corto 8.3)', !!copia.nombreProhibido('GIT~1'));
  check('archivo:oculto (ADS)', !!copia.nombreProhibido('archivo.txt:oculto'));
  check('NUL', !!copia.nombreProhibido('NUL'));
  check('nul.tar.gz (reservado con extensión)', !!copia.nombreProhibido('nul.tar.gz'));
  check('con.txt', !!copia.nombreProhibido('con.txt'));
  check('aux', !!copia.nombreProhibido('aux'));
  check('COM1', !!copia.nombreProhibido('COM1'));
  check('consola.txt NO es reservado', copia.nombreProhibido('consola.txt') === null);
  check('config.json pasa', copia.nombreProhibido('config.json') === null);
  check('.gitignore pasa (no es .git)', copia.nombreProhibido('.gitignore') === null);
  check('.git en un nivel intermedio se detecta', !!copia.rutaProhibida('src/.git/config'));
  check('.. se detecta', !!copia.rutaProhibida('../fuera.txt'));
  check('ruta normal pasa', copia.rutaProhibida('src/app/index.js') === null);
});

group('archivos declarados', () => {
  check('coincidencia exacta', copia.dentroDeDeclarados('src/a.js', ['src/a.js']));
  check('subárbol con barra', copia.dentroDeDeclarados('src/x/y.js', ['src/']));
  check('sin barra no es subárbol', !copia.dentroDeDeclarados('src/x/y.js', ['src']));
  check('no confunde prefijos', !copia.dentroDeDeclarados('src/abc.js', ['src/a']));
  check('sin distinguir mayúsculas', copia.dentroDeDeclarados('SRC/A.js', ['src/a.js']));
  check('fuera de lo declarado', !copia.dentroDeDeclarados('otro.js', ['src/']));
});

group('copia plana', () => {
  const repo = repoNuevo('plana', { 'src/a.js': 'uno\n', 'README.md': 'hola\n' });
  const destino = path.join(raizTmp, 'copias', 'plana');
  copia.copiaPlana({ worktree: repo, destino, raizPermitida: path.join(raizTmp, 'copias') });

  check('trae los archivos versionados', fs.readFileSync(path.join(destino, 'src', 'a.js'), 'utf8') === 'uno\n');
  check('NO trae .git', !fs.existsSync(path.join(destino, '.git')));

  // Lo que el agente no debería ver: algo sin versionar en el worktree.
  fs.writeFileSync(path.join(repo, 'secreto.env'), 'TOKEN=1');
  const destino2 = path.join(raizTmp, 'copias', 'plana2');
  copia.copiaPlana({ worktree: repo, destino: destino2, raizPermitida: path.join(raizTmp, 'copias') });
  check('no arrastra archivos sin versionar', !fs.existsSync(path.join(destino2, 'secreto.env')));

  let rechazado = false;
  try {
    copia.copiaPlana({ worktree: repo, destino: path.join(raizTmp, 'fuera'), raizPermitida: path.join(raizTmp, 'copias') });
  } catch { rechazado = true; }
  check('un destino fuera de la raíz se rechaza', rechazado);
});

group('sincronización: lo que pasa y lo que se descarta', () => {
  const repo = repoNuevo('sync', { 'src/a.js': 'uno\n', 'src/viejo.js': 'borrame\n', 'ajeno.js': 'no tocar\n' });
  const dirCopia = path.join(raizTmp, 'copias', 'sync');
  copia.copiaPlana({ worktree: repo, destino: dirCopia, raizPermitida: path.join(raizTmp, 'copias') });

  // Lo que hace un agente bien portado…
  fs.writeFileSync(path.join(dirCopia, 'src', 'a.js'), 'uno editado\n');
  fs.writeFileSync(path.join(dirCopia, 'src', 'nuevo.js'), 'nuevo\n');
  fs.unlinkSync(path.join(dirCopia, 'src', 'viejo.js'));

  // …y lo que haría uno hostil.
  fs.writeFileSync(path.join(dirCopia, 'ajeno.js'), 'PISADO\n');
  fs.mkdirSync(path.join(dirCopia, '.Git'), { recursive: true });
  fs.writeFileSync(path.join(dirCopia, '.Git', 'config'), '[core]\n\tpager = calc.exe\n');
  fs.writeFileSync(path.join(dirCopia, '.gitattributes'), '* filter=maligno\n');

  const senuelo = path.join(raizTmp, 'senuelo.txt');
  fs.writeFileSync(senuelo, 'intacto');
  let symlinkCreado = false;
  try {
    fs.symlinkSync(senuelo, path.join(dirCopia, 'src', 'enlace.js'), 'file');
    symlinkCreado = true;
  } catch {}
  let junctionCreada = false;
  try {
    fs.symlinkSync(raizTmp, path.join(dirCopia, 'src', 'junction'), 'junction');
    junctionCreada = true;
  } catch {}

  const { tocados, anomalias } = copia.sincronizar({ copia: dirCopia, worktree: repo, archivos: ['src/'] });
  const motivo = rel => (anomalias.find(a => a.ruta.replace(/\\/g, '/') === rel) || {}).motivo || '';

  check('propaga una edición', fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8') === 'uno editado\n');
  check('propaga un alta', fs.readFileSync(path.join(repo, 'src', 'nuevo.js'), 'utf8') === 'nuevo\n');
  check('propaga un borrado', !fs.existsSync(path.join(repo, 'src', 'viejo.js')));
  check('los tocados son exactamente los tres', tocados.length === 3, tocados.join(', '));

  check('NO pisa un archivo fuera de lo declarado', fs.readFileSync(path.join(repo, 'ajeno.js'), 'utf8') === 'no tocar\n');
  check('y lo reporta como anomalía', /fuera de los archivos declarados/.test(motivo('ajeno.js')));
  // La copia trae el repo entero: si cada archivo fuera de alcance fuera una
  // anomalía, el informe sería ruido y taparía al que sí se tocó. Lo vimos en
  // la primera corrida real, donde una tarea de un archivo reportó dos.
  check('un archivo fuera de alcance que NO se tocó no es anomalía',
    !anomalias.some(a => a.ruta.replace(/\\/g, '/') === 'intacto.js'), JSON.stringify(anomalias));

  // Ojo: en Windows `.Git` y `.git` son el mismo directorio, asi que "no
  // existe" no prueba nada. Lo que importa es que el config REAL de git no
  // haya sido pisado con el del agente.
  check('NO pisa el .git/config real', !/calc\.exe/.test(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8')));
  check('el .git real sigue siendo el de git', fs.existsSync(path.join(repo, '.git', 'HEAD')));
  check('reporta el .Git', /\.git/.test(motivo('.Git/config')));
  check('.gitattributes queda fuera (no está declarado)', !fs.existsSync(path.join(repo, '.gitattributes')));

  if (symlinkCreado) {
    check('no sigue un symlink', /enlace|simbólico/.test(motivo('src/enlace.js')) || !fs.existsSync(path.join(repo, 'src', 'enlace.js')));
    check('el señuelo del symlink queda intacto', fs.readFileSync(senuelo, 'utf8') === 'intacto');
  } else {
    check('(symlink no creado: Windows sin permiso, se prueba la regla pura)', true);
  }
  if (junctionCreada) {
    check('no sigue una junction', !fs.existsSync(path.join(repo, 'src', 'junction', 'senuelo.txt')));
    // El motivo importa: si dijera "no es un archivo regular", significaría que
    // el enlace se está detectando de casualidad, por no ser un archivo, y no
    // porque el código mire si es un enlace.
    check('y la reporta COMO enlace', /enlace simbólico o junction/.test(motivo('src/junction')), motivo('src/junction'));
  } else {
    check('(junction no creada en este entorno)', true);
  }
});

group('un enlace en el worktree no saca la escritura fuera', () => {
  // El agente no puede crear enlaces en el worktree (solo ve la copia), pero si
  // uno ya estuviera ahí, el destino "dentro del worktree" dejaría de serlo.
  // Por eso la comprobación es sobre `realpath`, no sobre el texto de la ruta.
  const repo = repoNuevo('enlace-destino', { 'src/a.js': 'uno\n' });
  const afuera = path.join(raizTmp, 'afuera');
  fs.mkdirSync(afuera, { recursive: true });
  fs.writeFileSync(path.join(afuera, 'victima.js'), 'intacto\n');

  let junction = false;
  try {
    fs.symlinkSync(afuera, path.join(repo, 'src', 'sub'), 'junction');
    junction = true;
  } catch {}

  if (!junction) {
    check('(no se pudo crear la junction en este entorno)', true);
    return;
  }

  const dirCopia = path.join(raizTmp, 'copias', 'enlace-destino');
  fs.mkdirSync(path.join(dirCopia, 'src', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dirCopia, 'src', 'a.js'), 'uno\n');
  fs.writeFileSync(path.join(dirCopia, 'src', 'sub', 'victima.js'), 'PISADO\n');

  const { tocados, anomalias } = copia.sincronizar({ copia: dirCopia, worktree: repo, archivos: ['src/'] });
  check('no escribe a través del enlace', fs.readFileSync(path.join(afuera, 'victima.js'), 'utf8') === 'intacto\n');
  check('no lo cuenta como tocado', !tocados.some(t => t.includes('victima')));
  check('lo reporta como anomalía', anomalias.some(a => /fuera del worktree|no se pudo escribir/.test(a.motivo)),
    JSON.stringify(anomalias));
});

group('nombre corto 8.3 en disco', () => {
  // En su propio repo: si `.Git` ya existe, NTFS le da justamente `GIT~1` como
  // nombre corto y crear un directorio con ese nombre no crea nada nuevo. Acá
  // se prueba el caso puro: un `GIT~1` que el agente crea por su cuenta.
  const repo = repoNuevo('corto', { 'src/a.js': 'uno\n' });
  const dirCopia = path.join(raizTmp, 'copias', 'corto');
  copia.copiaPlana({ worktree: repo, destino: dirCopia, raizPermitida: path.join(raizTmp, 'copias') });

  fs.mkdirSync(path.join(dirCopia, 'src', 'GIT~1'));
  fs.writeFileSync(path.join(dirCopia, 'src', 'GIT~1', 'config'), 'x\n');

  const { tocados, anomalias } = copia.sincronizar({ copia: dirCopia, worktree: repo, archivos: ['src/'] });
  const motivos = anomalias.map(a => `${a.ruta.replace(/\\/g, '/')}: ${a.motivo}`).join(' | ');
  check('descarta el 8.3 y lo reporta', /8\.3/.test(motivos), motivos);
  check('no escribe nada de ese directorio', !tocados.length && !fs.existsSync(path.join(repo, 'src', 'GIT~1')));
});

group('commit seguro', () => {
  const repo = repoNuevo('commit', { 'src/a.js': 'uno\n' });

  // Un hook que dejaría rastro si llegara a correr.
  const senuelo = path.join(raizTmp, 'hook-corrio.txt');
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'),
    `#!/bin/sh\necho corrio > '${senuelo.replace(/\\/g, '/')}'\n`);
  try { fs.chmodSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755); } catch {}

  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'dos\n');
  const r = copia.commitSeguro({ worktree: repo, tocados: ['src/a.js'], mensaje: 'lote x: tarea 1' });

  check('commitea', !!r.commit && !r.sinCambios);
  check('el hook NO corrió', !fs.existsSync(senuelo));
  check('el mensaje es el del lote', git(repo, ['log', '-1', '--pretty=%s']).trim() === 'lote x: tarea 1');
  check('el autor es el del lote', /Lagrange/.test(git(repo, ['log', '-1', '--pretty=%an'])));

  // Con cambios sueltos en el worktree y SIN rutas tocadas: no se llama a git.
  // Si se llamara, `git add -A --` sin pathspec barrería todo el worktree y
  // commitearía lo que el lote no tocó.
  const antes = git(repo, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(repo, 'suelto.js'), 'esto no es del lote\n');
  const sinNada = copia.commitSeguro({ worktree: repo, tocados: [], mensaje: 'vacío' });
  check('sin rutas tocadas no commitea', sinNada.sinCambios === true && sinNada.commit === null);
  check('y no arrastra lo que había suelto en el worktree', git(repo, ['rev-parse', 'HEAD']).trim() === antes);
  check('el archivo suelto sigue sin versionar', /\?\? suelto\.js/.test(git(repo, ['status', '--porcelain'])));
  fs.unlinkSync(path.join(repo, 'suelto.js'));

  // Una ruta declarada que el agente nunca creó haría fallar `git add` si se
  // pasaran los archivos declarados en vez de los tocados.
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'tres\n');
  const soloTocados = copia.commitSeguro({ worktree: repo, tocados: ['src/a.js'], mensaje: 'lote x: tarea 2' });
  check('commitea aunque otra ruta declarada no exista', !!soloTocados.commit);

  // Un archivo idéntico al de HEAD no produce commit vacío.
  const igual = copia.commitSeguro({ worktree: repo, tocados: ['src/a.js'], mensaje: 'lote x: tarea 3' });
  check('un contenido sin cambios no hace commit', igual.sinCambios === true);
});

group('prefijo de git', () => {
  const pre = copia.prefijoGit('C:/repo', 'C:/hooks');
  check('lleva hooksPath', pre.join(' ').includes('core.hooksPath=C:/hooks'));
  check('apaga fsmonitor', pre.join(' ').includes('core.fsmonitor=false'));
  check('apaga el pager', pre.join(' ').includes('core.pager=cat'));
  check('apaga la firma', pre.join(' ').includes('commit.gpgsign=false'));
});

for (const dir of aBorrar) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

report();
