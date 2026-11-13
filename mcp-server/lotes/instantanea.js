'use strict';

/**
 * SEC-020 fase 2 — La instantánea del árbol de trabajo que ve el contenedor de
 * `agy_plan` / `agy_review` / `agy_audit`.
 *
 * POR QUÉ NO SIRVE `copiaPlana`
 * -----------------------------
 * `copiaPlana` (lotes) copia `HEAD` con `git archive`. Una auditoría de
 * implementación se hace ANTES del commit: tiene que ver lo que hay en disco,
 * incluidos los cambios sin commitear y los archivos nuevos.
 *
 * POR QUÉ NO SE ESCRIBE NADA EN GIT
 * ---------------------------------
 * La v1 del plan armaba el árbol con `git add -A` sobre un índice temporal. La
 * auditoría del plan lo tumbó (BLOCKER): `git add` escribe objetos en
 * `.git/objects` y corre los filtros `clean` de `.gitattributes` (LFS o lo que
 * haya configurado). En una operación "de solo lectura" eso no va. Acá git solo
 * LISTA (`ls-files`) y DIFEA; los bytes se copian del disco con Node.
 *
 * `git diff` y `git status` comparan contra el árbol de trabajo y, para eso,
 * pasan los archivos por los filtros de `.gitattributes`. Con
 * `--attr-source=<árbol vacío>` (git 2.40+) no leen el `.gitattributes` del
 * árbol: no hay filtro que correr. Residual: `.git/info/attributes` y
 * `core.attributesFile` se siguen leyendo (los escribe el propio usuario). Si el
 * git es anterior a 2.40 se reintenta sin la opción.
 *
 * QUÉ NO ENTRA
 * ------------
 *  - lo ignorado por `.gitignore` (`--exclude-standard`): ahí viven
 *    `node_modules`, builds y secretos locales;
 *  - lo que coincide con `deny_paths` (barrera real en este modo: el archivo no
 *    se copia, así que el agente no lo puede leer), también en los diffs;
 *  - enlaces simbólicos, lo que no es archivo regular, lo que resuelve fuera del
 *    repo y los nombres que `copia.js` prohíbe (`.git`, reservados de Windows…).
 *
 * Los metadatos de git que el auditor necesita (estado, log, diffs) van como
 * archivos en `.lagrange-auditoria/`: la copia no lleva `.git` (un `.git`
 * plantado ejecuta código en el host la próxima vez que alguien corre git).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { rutaProhibida, prefijoGit } = require('./copia.js');
const { crearMatcher } = require('../lib/glob-rutas.js');

const DIR_ARTEFACTOS = '.lagrange-auditoria';
const ARBOL_VACIO = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_ARCHIVOS = 20000;
const MAX_BYTES = 300 * 1024 * 1024;
/** FEAT-186 — En modo `codigo` no se copian archivos más grandes que esto. */
const MAX_ARCHIVO_BYTES = 1024 * 1024;
const MAX_PATCH = 1024 * 1024;
const MAX_BUFFER_DIFF = 8 * 1024 * 1024;

/** FEAT-186 — `LAGRANGE_SNAPSHOT=completo` incluye el árbol entero; default `codigo`. */
function modoSnapshotConfigurado(env = process.env) {
  return String(env.LAGRANGE_SNAPSHOT || '').trim().toLowerCase() === 'completo' ? 'completo' : 'codigo';
}

/** FEAT-186 — Error accionable cuando la instantánea supera un tope duro. */
function mensajeDeLimite({ tipo, limite, total, incluidos = [] }) {
  const top = incluidos.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 5)
    .map((o) => `${o.ruta} (${(o.bytes / 1048576).toFixed(1)} MB)`).join(', ');
  const cabecera = tipo === 'bytes' ? `la instantánea supera ${limite}` : `la instantánea supera ${limite} ${tipo}`;
  return `${cabecera} (total: ${total}). Los incluidos más grandes: ${top || '(ninguno)'}. Opciones: deny_paths para excluir rutas, LAGRANGE_SNAPSHOT=completo si el árbol completo entra en 300 MB, o isolation "host" a conciencia.`;
}

function crearGit(repo, hooks) {
  const base = [...prefijoGit(repo, hooks), '-c', 'core.quotePath=false', '--no-optional-locks'];
  let conAttrSource = true;
  return function git(args, { maxBuffer = 32 * 1024 * 1024, permitirFallo = false, filtros = false } = {}) {
    const correr = (extra) => execFileSync('git', [...base, ...extra, ...args], {
      encoding: 'utf8', windowsHide: true, maxBuffer, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      if (!filtros || !conAttrSource) return correr([]);
      try {
        return correr([`--attr-source=${ARBOL_VACIO}`]);
      } catch (err) {
        // git < 2.40 no conoce la opción: se sigue sin ella (solo `status`/`diff`).
        if (!/attr-source|unknown option/i.test(String(err.stderr || err.message))) throw err;
        conAttrSource = false;
        return correr([]);
      }
    } catch (err) {
      if (permitirFallo) return null;
      throw new Error(`git ${args.slice(0, 2).join(' ')} falló: ${String(err.stderr || err.message).trim().slice(0, 300)}`);
    }
  };
}

/** El destino tiene que quedar dentro de la raíz permitida y sin enlaces en el camino (como `copiaPlana`). */
function prepararDestino(destino, raizPermitida) {
  const destinoAbs = path.resolve(destino);
  const raizAbs = path.resolve(raizPermitida);
  if (destinoAbs === raizAbs || !destinoAbs.startsWith(raizAbs + path.sep)) {
    throw new Error(`la instantánea tiene que quedar dentro de ${raizAbs}, no en ${destinoAbs}`);
  }
  const motivo = rutaProhibida(path.relative(raizAbs, destinoAbs));
  if (motivo) throw new Error(`ruta de instantánea rechazada: ${motivo}`);
  fs.rmSync(destinoAbs, { recursive: true, force: true });
  fs.mkdirSync(destinoAbs, { recursive: true });
  if (path.resolve(fs.realpathSync(destinoAbs)) !== destinoAbs) {
    throw new Error(`la ruta de la instantánea pasa por un enlace: ${destinoAbs}`);
  }
  return destinoAbs;
}

/**
 * Las rutas que toca un bloque `diff --git …`. Usa `--- a/…` / `+++ b/…` (sin
 * ambigüedad con espacios) y, si no están (binarios, cambios de modo), el
 * encabezado cuando las dos mitades son iguales. `null` si no se puede saber:
 * quien llama descarta el bloque (cerrado ante la duda).
 */
function rutasDelBloque(bloque) {
  const rutas = new Set();
  for (const linea of bloque.split('\n')) {
    const m = /^(?:---|\+\+\+) (?:a|b)\/(.*)$/.exec(linea);
    if (m) rutas.add(m[1].replace(/\t$/, ''));
    if (linea.startsWith('@@')) break;
  }
  if (rutas.size) return [...rutas];
  const cabecera = bloque.slice(0, bloque.indexOf('\n') === -1 ? bloque.length : bloque.indexOf('\n'));
  const s = cabecera.replace(/^diff --git /, '');
  if (s.startsWith('"')) return null;
  const largo = (s.length - 5) / 2;
  if (Number.isInteger(largo) && largo > 0 && s.startsWith('a/') && s.slice(largo + 2, largo + 5) === ' b/'
    && s.slice(2, largo + 2) === s.slice(largo + 5)) {
    return [s.slice(2, largo + 2)];
  }
  return null;
}

/** Quita del patch los bloques de archivos excluidos; después aplica el tope. */
function filtrarPatch(patch, excluido, esOmitidoPorTamano = null) {
  const texto = String(patch || '');
  if (!texto) return '';
  const bloques = texto.split(/(?=^diff --git )/m);
  const quedan = bloques.filter((b) => {
    if (!b.startsWith('diff --git ')) return true;
    const rutas = rutasDelBloque(b);
    return rutas !== null && !rutas.some(excluido) && !(esOmitidoPorTamano && rutas.some(esOmitidoPorTamano));
  });
  let salida = quedan.join('');
  if (Buffer.byteLength(salida) > MAX_PATCH) {
    salida = Buffer.from(salida).subarray(0, MAX_PATCH).toString('utf8') + '\n\n[… patch truncado a 1 MB por la instantánea …]\n';
  }
  return salida;
}

/**
 * FEAT-186 — Lee un `git diff --output=<tmp>` por bloques, descarta los
 * excluidos (deny_paths o tamaño) antes de consumir el presupuesto y recién
 * entonces trunca a `maxPatch`. Un asset de texto grande que ordena antes que
 * `src/` no puede ocultar los diffs de código posteriores. `maxCrudo` acota lo
 * que se lee del archivo para no crecer sin límite.
 */
function leerPatchFiltrado(ruta, excluido, esOmitidoPorTamano = null, { maxPatch = MAX_PATCH, maxCrudo = MAX_BUFFER_DIFF } = {}) {
  const fd = fs.openSync(ruta, 'r');
  const buf = Buffer.alloc(64 * 1024);
  let pendiente = '';
  let salida = '';
  let crudo = 0;
  let truncado = false;
  const conservar = (bloque) => {
    if (!bloque.startsWith('diff --git ')) return true;
    const rutas = rutasDelBloque(bloque);
    return rutas !== null && !rutas.some(excluido) && !(esOmitidoPorTamano && rutas.some(esOmitidoPorTamano));
  };
  const agregar = (bloque) => {
    if (!conservar(bloque)) return;
    const actual = Buffer.byteLength(salida);
    if (actual >= maxPatch) { truncado = true; return; }
    const resto = maxPatch - actual;
    const bytes = Buffer.byteLength(bloque);
    if (bytes <= resto) {
      salida += bloque;
    } else {
      salida += Buffer.from(bloque).subarray(0, resto).toString('utf8');
      truncado = true;
    }
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      crudo += n;
      pendiente += buf.toString('utf8', 0, n);
      let idx;
      while ((idx = pendiente.indexOf('\ndiff --git ')) !== -1) {
        const bloque = pendiente.slice(0, idx + 1);
        pendiente = pendiente.slice(idx + 1);
        agregar(bloque);
        if (truncado) break;
      }
      if (truncado || crudo >= maxCrudo) { truncado = true; break; }
    }
    if (!truncado && pendiente) agregar(pendiente);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  if (truncado) salida += '\n\n[… patch truncado por la instantánea …]\n';
  return salida;
}

function baseDeRama(git) {
  for (const ref of ['origin/HEAD', 'main', 'master']) {
    const existe = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { permitirFallo: true });
    if (!existe) continue;
    const base = git(['merge-base', 'HEAD', ref], { permitirFallo: true });
    if (base && base.trim()) return { ref, base: base.trim() };
  }
  return null;
}

/**
 * @returns {{ destino, raizRepo, archivos, bytes, excluidos, omitidos, noCopiados }}
 */
function instantaneaDeTrabajo({ repo, destino, raizPermitida, denyPaths = [], modoSnapshot = modoSnapshotConfigurado(), maxArchivoBytes = MAX_ARCHIVO_BYTES, umbralAvisoArchivos = 5000, umbralAvisoBytes = 200 * 1024 * 1024 }) {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-ro-hooks-'));
  try {
    const gitSuelto = crearGit(path.resolve(repo), hooks);
    const raiz = gitSuelto(['rev-parse', '--show-toplevel'], { permitirFallo: true });
    if (!raiz || !raiz.trim()) throw new Error(`${repo} no está dentro de un repositorio git: el modo contenedor audita repos`);
    const raizRepo = fs.realpathSync(path.resolve(raiz.trim()));
    const git = crearGit(raizRepo, hooks);
    const excluido = crearMatcher(denyPaths);
    const destinoAbs = prepararDestino(destino, raizPermitida);

    const listado = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 });
    const rutas = [...new Set(listado.split('\0').filter(Boolean))];
    let archivos = 0;
    let bytes = 0;
    let excluidos = 0;
    const omitidos = [];
    const omitidosPorTamano = [];
    const incluidos = [];
    let bytesOmitidos = 0;
    const noCopiados = [];
    for (const rel of rutas) {
      const normal = rel.replace(/\\/g, '/');
      if (normal === DIR_ARTEFACTOS || normal.startsWith(`${DIR_ARTEFACTOS}/`)) {
        throw new Error(`el repo ya tiene ${DIR_ARTEFACTOS}/, que la instantánea reserva para el contexto de git`);
      }
      if (excluido(normal)) { excluidos++; continue; }
      const prohibida = rutaProhibida(normal);
      if (prohibida) { omitidos.push(`${normal} (${prohibida})`); continue; }
      const abs = path.join(raizRepo, normal);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; } // borrado en disco: no hay nada que copiar
      if (st.isSymbolicLink() || !st.isFile()) { omitidos.push(`${normal} (no es un archivo regular)`); continue; }
      let real;
      try { real = fs.realpathSync(abs); } catch { noCopiados.push(normal); continue; }
      const relReal = path.relative(raizRepo, real);
      if (!relReal || relReal.startsWith('..') || path.isAbsolute(relReal)) { omitidos.push(`${normal} (resuelve fuera del repo)`); continue; }
      if (modoSnapshot !== 'completo' && st.size > maxArchivoBytes) {
        omitidosPorTamano.push({ ruta: normal, bytes: st.size });
        bytesOmitidos += st.size;
        continue;
      }
      if (archivos + 1 > MAX_ARCHIVOS) throw new Error(mensajeDeLimite({ tipo: 'archivos', limite: MAX_ARCHIVOS, total: archivos + 1, incluidos }));
      if (bytes + st.size > MAX_BYTES) throw new Error(mensajeDeLimite({ tipo: 'bytes', limite: `${MAX_BYTES / 1048576} MB`, total: `${((bytes + st.size) / 1048576).toFixed(1)} MB`, incluidos }));
      const destinoArchivo = path.join(destinoAbs, normal);
      try {
        fs.mkdirSync(path.dirname(destinoArchivo), { recursive: true });
        fs.copyFileSync(abs, destinoArchivo);
      } catch (err) {
        // Windows: un archivo bloqueado por otro proceso (EBUSY/EPERM) no tumba la instantánea.
        noCopiados.push(`${normal} (${err.code || 'error'})`);
        continue;
      }
      archivos++;
      bytes += st.size;
      incluidos.push({ ruta: normal, bytes: st.size });
    }
    const aviso = archivos > umbralAvisoArchivos || bytes > umbralAvisoBytes
      ? `snapshot grande (${archivos} archivos, ${(bytes / 1048576).toFixed(1)} MB); considerá deny_paths o isolation "host"`
      : null;

    // Contexto de git, sin `.git`.
    const dirArt = path.join(destinoAbs, DIR_ARTEFACTOS);
    fs.mkdirSync(dirArt, { recursive: true });
    const rama = (git(['symbolic-ref', '--short', '-q', 'HEAD'], { permitirFallo: true }) || '').trim() || '(detached)';
    const head = (git(['rev-parse', '--verify', '--quiet', 'HEAD'], { permitirFallo: true }) || '').trim() || '(sin commits)';
    const status = (git(['status', '--porcelain', '--untracked-files=all'], { permitirFallo: true, filtros: true }) || '')
      .split('\n').filter((l) => l && !excluido(l.slice(3).replace(/^.* -> /, ''))).join('\n');
    const estado = [
      `rama: ${rama}`,
      `HEAD: ${head}`,
      '',
      '# git status --porcelain (los archivos de deny_paths no se listan)',
      status || '(sin cambios)',
      '',
      `# archivos en la instantánea: ${archivos}; excluidos por deny_paths: ${excluidos}; omitidos por tamaño: ${omitidosPorTamano.length} (${(bytesOmitidos / 1048576).toFixed(1)} MB)`,
      ...(omitidos.length ? ['', '# omitidos', ...omitidos] : []),
      ...(omitidosPorTamano.length ? ['', `# omitidos por tamaño (>${(maxArchivoBytes / 1048576).toFixed(1)} MB): ${omitidosPorTamano.length}`, ...omitidosPorTamano.slice(0, 20).map((o) => `${o.ruta} (${(o.bytes / 1048576).toFixed(1)} MB)`) ] : []),
      ...(aviso ? ['', `# aviso: ${aviso}`] : []),
      ...(noCopiados.length ? ['', '# no copiados (bloqueados o ilegibles)', ...noCopiados] : [])
    ].join('\n');
    fs.writeFileSync(path.join(dirArt, 'estado.txt'), `${estado}\n`);
    const log = head === '(sin commits)' ? '' : (git(['log', '-20', '--oneline', '--decorate', '--no-color'], { permitirFallo: true }) || '');
    fs.writeFileSync(path.join(dirArt, 'log.txt'), log || '(sin historia)\n');
    const omitidosSet = new Set(omitidosPorTamano.map((o) => o.ruta));
    const esOmitidoPorTamano = (r) => omitidosSet.has(r);
    const diffContra = (base, nombre, titulo) => {
      const tmp = path.join(hooks, `${nombre}.raw`);
      // FEAT-186 — Los archivos omitidos por tamaño no entran al diff. Con pocos
      // se excluyen por pathspec (rápido y sin leer el bloque); con muchos, el
      // filtro por bloques de `leerPatchFiltrado` hace el trabajo.
      const excludes = omitidosPorTamano.length && omitidosPorTamano.length <= 200
        ? omitidosPorTamano.map((o) => `:(exclude,literal)${o.ruta}`)
        : null;
      const argsDiff = ['diff', base, '--no-ext-diff', '--no-textconv', '--no-color', `--output=${tmp}`];
      if (excludes) argsDiff.push('--', '.', ...excludes);
      const r = git(argsDiff, { permitirFallo: true, filtros: true });
      let cuerpo;
      if (r === null || !fs.existsSync(tmp)) {
        const crudo = git(['diff', base, '--no-ext-diff', '--no-textconv', '--no-color'], { permitirFallo: true, filtros: true, maxBuffer: MAX_BUFFER_DIFF });
        cuerpo = crudo === null
          ? `[${titulo}: no disponible (git falló o supera ${MAX_BUFFER_DIFF / 1024 / 1024} MB)]\n`
          : filtrarPatch(crudo, excluido, esOmitidoPorTamano);
      } else {
        cuerpo = leerPatchFiltrado(tmp, excluido, esOmitidoPorTamano);
      }
      fs.writeFileSync(path.join(dirArt, nombre), cuerpo || `[${titulo}: sin cambios]\n`);
    };
    if (head !== '(sin commits)') {
      diffContra('HEAD', 'diff-sin-commitear.patch', 'cambios sin commitear (los archivos nuevos están enteros en la instantánea)');
      const base = baseDeRama(git);
      if (base) diffContra(base.base, 'diff-rama.patch', `diff contra el merge-base con ${base.ref}`);
    }
    return { destino: destinoAbs, raizRepo, archivos, bytes, excluidos, omitidos, omitidosPorTamano, bytesOmitidos, modoSnapshot, aviso, noCopiados };
  } finally {
    try { fs.rmSync(hooks, { recursive: true, force: true }); } catch {}
  }
}

/**
 * FEAT-192 — Solo el contexto de git (estado, log y diffs, sin copiar el árbol) para un pedido del flujo manual:
 * agy corre sobre el repo real, así que basta con lo que la instantánea pone en `.lagrange-auditoria/`. Respeta
 * `deny_paths` en el estado y en los diffs, y el tope de `MAX_PATCH`. Sin repo git devuelve `null`.
 */
function artefactosDeGit({ repo, destino, denyPaths = [] }) {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-ro-hooks-'));
  try {
    const gitSuelto = crearGit(path.resolve(repo), hooks);
    const raiz = gitSuelto(['rev-parse', '--show-toplevel'], { permitirFallo: true });
    if (!raiz || !raiz.trim()) return null;
    const git = crearGit(fs.realpathSync(path.resolve(raiz.trim())), hooks);
    const excluido = crearMatcher(denyPaths);
    fs.mkdirSync(destino, { recursive: true });
    const rama = (git(['symbolic-ref', '--short', '-q', 'HEAD'], { permitirFallo: true }) || '').trim() || '(detached)';
    const head = (git(['rev-parse', '--verify', '--quiet', 'HEAD'], { permitirFallo: true }) || '').trim() || '(sin commits)';
    const status = (git(['status', '--porcelain', '--untracked-files=all'], { permitirFallo: true, filtros: true }) || '')
      .split('\n').filter((l) => l && !excluido(l.slice(3).replace(/^.* -> /, ''))).join('\n');
    fs.writeFileSync(path.join(destino, 'estado.txt'),
      `rama: ${rama}\nHEAD: ${head}\n\n# git status --porcelain (los archivos de deny_paths no se listan)\n${status || '(sin cambios)'}\n`);
    const log = head === '(sin commits)' ? '' : (git(['log', '-20', '--oneline', '--decorate', '--no-color'], { permitirFallo: true }) || '');
    fs.writeFileSync(path.join(destino, 'log.txt'), log || '(sin historia)\n');
    const diffContra = (base, nombre, titulo) => {
      const tmp = path.join(hooks, `${nombre}.raw`);
      const r = git(['diff', base, '--no-ext-diff', '--no-textconv', '--no-color', `--output=${tmp}`], { permitirFallo: true, filtros: true });
      const cuerpo = r === null || !fs.existsSync(tmp)
        ? `[${titulo}: no disponible (git falló)]\n`
        : leerPatchFiltrado(tmp, excluido);
      fs.writeFileSync(path.join(destino, nombre), cuerpo || `[${titulo}: sin cambios]\n`);
    };
    const archivos = ['estado.txt', 'log.txt'];
    if (head !== '(sin commits)') {
      diffContra('HEAD', 'diff-sin-commitear.patch', 'cambios sin commitear (los archivos nuevos no entran: leelos del árbol)');
      archivos.push('diff-sin-commitear.patch');
      const base = baseDeRama(git);
      if (base) { diffContra(base.base, 'diff-rama.patch', `diff contra el merge-base con ${base.ref}`); archivos.push('diff-rama.patch'); }
    }
    return { rama, head, archivos };
  } finally {
    try { fs.rmSync(hooks, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  artefactosDeGit,
  DIR_ARTEFACTOS, MAX_ARCHIVOS, MAX_BYTES, MAX_ARCHIVO_BYTES, MAX_PATCH,
  modoSnapshotConfigurado, mensajeDeLimite, instantaneaDeTrabajo, filtrarPatch, leerPatchFiltrado, rutasDelBloque
};
