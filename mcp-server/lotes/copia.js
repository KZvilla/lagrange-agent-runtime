/**
 * Copia plana, sincronización de vuelta y commit seguro (FEAT-061 fase 2).
 *
 * POR QUÉ NO SE LE DA EL WORKTREE AL AGENTE
 * -----------------------------------------
 * Un worktree tiene `.git`. Un `.git/config` plantado ejecuta código en el
 * host la próxima vez que alguien corre git ahí (`core.pager`, `core.editor`,
 * alias, `filter` de `.gitattributes`), y un `.git/hooks/pre-commit` lo ejecuta
 * en el commit que hacemos nosotros. El agente corre con
 * `--dangerously-skip-permissions`: darle el `.git` sería darle ejecución en
 * Windows con la frontera del contenedor ya cruzada.
 *
 * Por eso el contenedor recibe una COPIA PLANA (sin `.git`) y el host
 * sincroniza de vuelta descartando lo que no puede confiar. La sincronización
 * es, en la práctica, la segunda frontera: la primera es Docker.
 *
 * LO QUE SE DESCARTA, Y POR QUÉ CADA COSA
 * --------------------------------------
 *  - `.git` en cualquier nivel, incluidas las variantes que NTFS resuelve al
 *    mismo nombre: `.Git`, `.git.`, `.git ` (punto y espacio finales se caen),
 *    `GIT~1` (nombre corto 8.3) y cualquier nombre con `:` (flujo alternativo
 *    de datos: `archivo.txt:oculto`).
 *  - Nombres reservados de Windows (`CON`, `NUL`, `COM1`…), también con
 *    extensión: `nul.txt` sigue siendo el dispositivo.
 *  - Symlinks, junctions y cualquier cosa que no sea archivo o directorio: no
 *    se copian ni se siguen. Un symlink a `C:\` convertiría la escritura dentro
 *    del worktree en escritura en cualquier parte.
 *  - Archivos fuera de lo que la tarea declaró en `archivos`. En el fan-out de
 *    hoy eso es una frase en el prompt; acá es un control.
 *
 * Nada de esto aborta la sincronización: se descarta y se anota como anomalía,
 * que es lo que después mira el humano.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const RESERVADOS_WINDOWS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`)
]);

/**
 * Lleva un nombre a lo que Win32 resuelve realmente: minúsculas y sin puntos ni
 * espacios finales. `".git. "` y `".GIT"` son el mismo directorio para el
 * sistema de archivos; compararlos crudos es el bug.
 */
function normalizarNombreWin32(nombre) {
  return String(nombre || '').replace(/[. ]+$/, '').toLowerCase();
}

/**
 * ¿Este componente de ruta es de los que no se copian nunca?
 */
function nombreProhibido(nombre) {
  const crudo = String(nombre || '');
  if (crudo.includes(':')) return 'flujo alternativo de datos (:)';

  const normal = normalizarNombreWin32(crudo);
  if (!normal) return 'nombre vacío';
  if (normal === '.git') return '.git';
  // Nombre corto 8.3: `GIT~1` resuelve a `.git` sin llamarse `.git`.
  if (/~\d+$/.test(normal)) return 'nombre corto 8.3';
  // El dispositivo manda aunque tenga extensión: `nul.tar.gz` sigue siendo NUL.
  const base = normal.split('.')[0];
  if (RESERVADOS_WINDOWS.has(base)) return `nombre reservado de Windows (${base})`;
  return null;
}

function rutaProhibida(relativa) {
  for (const parte of String(relativa).split(/[\\/]+/)) {
    if (!parte || parte === '.') continue;
    if (parte === '..') return 'salto de directorio (..)';
    const motivo = nombreProhibido(parte);
    if (motivo) return motivo;
  }
  return null;
}

/**
 * Semántica de `archivos` idéntica a la de reparto.js: una entrada es un
 * archivo exacto, o un subárbol si termina en `/`. Sin distinguir mayúsculas,
 * porque Windows no las distingue.
 */
function dentroDeDeclarados(relativa, archivos) {
  const rel = String(relativa).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  for (const declarado of archivos || []) {
    const texto = String(declarado || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const esDirectorio = texto.endsWith('/');
    const limpio = texto.replace(/\/+$/, '').toLowerCase();
    if (!limpio) continue;
    if (rel === limpio) return true;
    if (esDirectorio && rel.startsWith(limpio + '/')) return true;
  }
  return false;
}

function gitPorDefecto(args, { cwd, permitirFallo = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    if (permitirFallo) return '';
    throw new Error(`git ${args.slice(0, 3).join(' ')} falló: ${String(err.stderr || err.message).trim().slice(0, 300)}`);
  }
}

/**
 * El prefijo de seguridad de CUALQUIER invocación de git sobre el worktree.
 *
 * Va en una sola función porque los `-c` no persisten entre comandos: si el
 * `add` los lleva y el `commit` no, el `pre-commit` plantado corre igual. Eso
 * fue un hallazgo de la 1.ª auditoría del plan.
 *
 * `hooksPath` apunta a una carpeta vacía nuestra en vez de a `NUL`: S9 midió
 * que las dos funcionan en Git 2.49 para Windows, y una carpeta real no depende
 * de cómo trate git a un nombre de dispositivo.
 */
function prefijoGit(worktree, hooksPath) {
  return [
    '-C', worktree,
    '-c', `core.hooksPath=${hooksPath}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat',
    '-c', 'commit.gpgsign=false'
  ];
}

function crearHooksVacio(base) {
  const dir = path.join(base, 'hooks-vacios');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * El `tar` de Windows (bsdtar, en System32) y no el que primero aparezca en el
 * PATH: si la sesión corre desde Git Bash, `tar` es el de MSYS, que interpreta
 * `C:\…` como un host remoto y falla con "Cannot connect to C:". El de Windows
 * entiende las rutas con unidad.
 */
function binarioTar() {
  if (process.platform !== 'win32') return 'tar';
  const deWindows = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(deWindows) ? deWindows : 'tar';
}

/**
 * Copia el HEAD del worktree a `destino`, SIN `.git`.
 *
 * `git archive` da exactamente los archivos rastreados de ese commit: ni
 * `.git`, ni artefactos sin versionar, ni lo que haya dejado una corrida
 * anterior. Un `cp -r` del worktree no tendría esa garantía.
 */
function copiaPlana({ worktree, destino, raizPermitida, git = gitPorDefecto }) {
  const destinoAbs = path.resolve(destino);
  const raizAbs = path.resolve(raizPermitida);
  if (destinoAbs !== raizAbs && !destinoAbs.startsWith(raizAbs + path.sep)) {
    throw new Error(`la copia tiene que quedar dentro de ${raizAbs}, no en ${destinoAbs}`);
  }
  const motivo = rutaProhibida(path.relative(raizAbs, destinoAbs));
  if (motivo) throw new Error(`ruta de copia rechazada: ${motivo}`);

  fs.rmSync(destinoAbs, { recursive: true, force: true });
  fs.mkdirSync(destinoAbs, { recursive: true });

  // Ningún ancestro puede ser un symlink: si lo fuera, "dentro de la raíz" no
  // significaría nada.
  const real = fs.realpathSync(destinoAbs);
  if (path.resolve(real) !== destinoAbs) {
    throw new Error(`la ruta de la copia pasa por un enlace: ${destinoAbs} → ${real}`);
  }

  const tar = path.join(os.tmpdir(), `lagrange-lote-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tar`);
  try {
    git(['-C', worktree, 'archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: worktree });
    execFileSync(binarioTar(), ['-xf', tar, '-C', destinoAbs], { windowsHide: true });
  } finally {
    try { fs.unlinkSync(tar); } catch {}
  }

  if (fs.existsSync(path.join(destinoAbs, '.git'))) {
    throw new Error('la copia plana quedó con un .git: se aborta antes de dársela al agente');
  }
  return destinoAbs;
}

function listar(dir, prefijo = '') {
  const salida = [];
  let entradas;
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return salida;
  }
  for (const entrada of entradas) {
    const rel = prefijo ? `${prefijo}/${entrada.name}` : entrada.name;
    const abs = path.join(dir, entrada.name);
    let st = null;
    let error = null;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      // No se salta en silencio: un symlink de Linux creado dentro del
      // contenedor aparece en Windows como una entrada cuyo `lstat` da EACCES
      // (medido con una sonda real). No copiarlo está bien; no CONTARLO
      // dejaría al humano sin saber que el agente lo plantó.
      error = err.code || 'ilegible';
    }
    salida.push({ rel, abs, st, nombre: entrada.name, error });
    // Solo se baja por directorios REALES: un symlink a un directorio se anota
    // y no se recorre.
    if (st && st.isDirectory()) salida.push(...listar(abs, rel));
  }
  return salida;
}

/**
 * Escribe un archivo de la copia en el worktree, con la paranoia puesta en el
 * destino: sin seguir symlinks, sin pasar por el `.git` del worktree y con la
 * ruta final verificada dentro del worktree.
 */
function escribirEnWorktree(worktree, rel, origen) {
  const destino = path.resolve(worktree, rel);
  const raiz = path.resolve(worktree);
  if (destino !== raiz && !destino.startsWith(raiz + path.sep)) {
    throw new Error(`destino fuera del worktree: ${rel}`);
  }

  const dir = path.dirname(destino);
  fs.mkdirSync(dir, { recursive: true });

  // Defensa en profundidad, sobre la ruta REAL y no sobre el texto: si algún
  // componente del destino fuera un enlace o una junction, "empieza con la ruta
  // del worktree" no querría decir nada. Dos condiciones, las dos sobre
  // `realpath`: caer dentro del worktree, y no caer dentro de su `.git`.
  const dirReal = fs.realpathSync(dir);
  const raizReal = fs.realpathSync(raiz);
  if (dirReal !== raizReal && !dirReal.startsWith(raizReal + path.sep)) {
    throw new Error(`el destino real queda fuera del worktree (¿un enlace en el camino?): ${rel} → ${dirReal}`);
  }
  const gitDir = path.join(raizReal, '.git');
  if (dirReal === gitDir || dirReal.startsWith(gitDir + path.sep)) {
    throw new Error(`destino dentro de .git: ${rel}`);
  }

  // Borrar y crear con O_EXCL: si el destino era un symlink, se elimina el
  // enlace en vez de escribir a través de él.
  try { fs.unlinkSync(destino); } catch {}
  const fd = fs.openSync(destino, 'wx');
  try {
    fs.writeFileSync(fd, fs.readFileSync(origen));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Trae de la copia al worktree lo que la tarea tenía permitido tocar.
 *
 * @returns {{ tocados: string[], anomalias: Array<{ruta: string, motivo: string}> }}
 */
function sincronizar({ copia, worktree, archivos, git = gitPorDefecto }) {
  const anomalias = [];
  const tocados = [];
  const vistos = new Set();

  for (const entrada of listar(copia)) {
    const motivo = rutaProhibida(entrada.rel);
    if (motivo) {
      anomalias.push({ ruta: entrada.rel, motivo: `descartado: ${motivo}` });
      continue;
    }
    if (!entrada.st) {
      anomalias.push({ ruta: entrada.rel, motivo: `descartado: no se pudo inspeccionar (${entrada.error}); suele ser un enlace creado dentro del contenedor` });
      continue;
    }
    if (entrada.st.isSymbolicLink()) {
      anomalias.push({ ruta: entrada.rel, motivo: 'descartado: enlace simbólico o junction' });
      continue;
    }
    if (entrada.st.isDirectory()) continue;
    if (!entrada.st.isFile()) {
      anomalias.push({ ruta: entrada.rel, motivo: 'descartado: no es un archivo regular' });
      continue;
    }
    if (!dentroDeDeclarados(entrada.rel, archivos)) {
      // Solo es anomalía si el agente LO TOCÓ. La copia trae el repo entero,
      // así que reportar todo lo que está fuera de alcance llenaría el informe
      // de ruido y escondería lo único que importa: que el agente escribió
      // donde no debía.
      let intacto = false;
      try {
        intacto = fs.readFileSync(path.resolve(worktree, entrada.rel)).equals(fs.readFileSync(entrada.abs));
      } catch {
        intacto = false;
      }
      if (!intacto) {
        anomalias.push({ ruta: entrada.rel, motivo: 'descartado: fuera de los archivos declarados' });
      }
      continue;
    }

    vistos.add(entrada.rel.toLowerCase());
    const destino = path.resolve(worktree, entrada.rel);
    let igual = false;
    try {
      igual = fs.readFileSync(destino).equals(fs.readFileSync(entrada.abs));
    } catch {}
    if (igual) continue;

    try {
      escribirEnWorktree(worktree, entrada.rel, entrada.abs);
      tocados.push(entrada.rel);
    } catch (err) {
      anomalias.push({ ruta: entrada.rel, motivo: `no se pudo escribir: ${err.message}` });
    }
  }

  // Borrados: un archivo rastreado, dentro de lo declarado, que el agente quitó
  // de la copia. Sin esto, "borrá X" sería la única instrucción que el
  // contenedor no puede cumplir.
  const rastreados = String(git(['-C', worktree, 'ls-files', '-z'], { cwd: worktree, permitirFallo: true }) || '')
    .split('\0').filter(Boolean);
  for (const rel of rastreados) {
    if (!dentroDeDeclarados(rel, archivos)) continue;
    if (vistos.has(rel.toLowerCase())) continue;
    if (rutaProhibida(rel)) continue;
    const destino = path.resolve(worktree, rel);
    try {
      if (fs.existsSync(destino)) {
        fs.unlinkSync(destino);
        tocados.push(rel);
      }
    } catch (err) {
      anomalias.push({ ruta: rel, motivo: `no se pudo borrar: ${err.message}` });
    }
  }

  return { tocados, anomalias };
}

/**
 * Commitea EXACTAMENTE las rutas que tocó la sincronización.
 *
 * No `tarea.archivos`: un archivo declarado que el agente no creó hace fallar
 * `git add` con `pathspec did not match` (exit 128) y perdería el trabajo del
 * resto de la tarea.
 */
function commitSeguro({ worktree, tocados, mensaje, autor = 'Lagrange Lotes <lotes@lagrange.local>', hooksPath, git = gitPorDefecto }) {
  if (!tocados || !tocados.length) return { commit: null, sinCambios: true };

  const hooks = hooksPath || crearHooksVacio(os.tmpdir());
  const pre = prefijoGit(worktree, hooks);

  git([...pre, 'add', '-A', '--', ...tocados], { cwd: worktree });

  // ¿Quedó algo realmente en el índice? Un archivo idéntico al de HEAD no
  // produce cambios, y `git commit` sin cambios sale con error.
  let hayCambios = true;
  try {
    git([...pre, 'diff', '--cached', '--quiet'], { cwd: worktree });
    hayCambios = false;
  } catch {
    hayCambios = true;
  }
  if (!hayCambios) return { commit: null, sinCambios: true };

  git([...pre, '-c', `user.name=${autor.replace(/ <.*$/, '')}`, '-c', `user.email=${(autor.match(/<(.*)>/) || [, 'lotes@lagrange.local'])[1]}`,
    'commit', '-m', mensaje], { cwd: worktree });

  const sha = String(git([...pre, 'rev-parse', 'HEAD'], { cwd: worktree }) || '').trim();
  return { commit: sha || null, sinCambios: false };
}

module.exports = {
  RESERVADOS_WINDOWS,
  normalizarNombreWin32,
  nombreProhibido,
  rutaProhibida,
  dentroDeDeclarados,
  prefijoGit,
  crearHooksVacio,
  copiaPlana,
  sincronizar,
  commitSeguro
};
