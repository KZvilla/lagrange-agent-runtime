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
const MAX_PATCH = 1024 * 1024;
const MAX_BUFFER_DIFF = 8 * 1024 * 1024;

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
function filtrarPatch(patch, excluido) {
  const texto = String(patch || '');
  if (!texto) return '';
  const bloques = texto.split(/(?=^diff --git )/m);
  const quedan = bloques.filter((b) => {
    if (!b.startsWith('diff --git ')) return true;
    const rutas = rutasDelBloque(b);
    return rutas !== null && !rutas.some(excluido);
  });
  let salida = quedan.join('');
  if (Buffer.byteLength(salida) > MAX_PATCH) {
    salida = Buffer.from(salida).subarray(0, MAX_PATCH).toString('utf8') + '\n\n[… patch truncado a 1 MB por la instantánea …]\n';
  }
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
function instantaneaDeTrabajo({ repo, destino, raizPermitida, denyPaths = [] }) {
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
      if (archivos + 1 > MAX_ARCHIVOS) throw new Error(`la instantánea supera ${MAX_ARCHIVOS} archivos`);
      if (bytes + st.size > MAX_BYTES) throw new Error(`la instantánea supera ${MAX_BYTES / 1024 / 1024} MB`);
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
    }

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
      `# archivos en la instantánea: ${archivos}; excluidos por deny_paths: ${excluidos}`,
      ...(omitidos.length ? ['', '# omitidos', ...omitidos] : []),
      ...(noCopiados.length ? ['', '# no copiados (bloqueados o ilegibles)', ...noCopiados] : [])
    ].join('\n');
    fs.writeFileSync(path.join(dirArt, 'estado.txt'), `${estado}\n`);
    const log = head === '(sin commits)' ? '' : (git(['log', '-20', '--oneline', '--decorate', '--no-color'], { permitirFallo: true }) || '');
    fs.writeFileSync(path.join(dirArt, 'log.txt'), log || '(sin historia)\n');
    const diffContra = (base, nombre, titulo) => {
      const crudo = git(['diff', base, '--no-ext-diff', '--no-textconv', '--no-color'], { permitirFallo: true, filtros: true, maxBuffer: MAX_BUFFER_DIFF });
      const cuerpo = crudo === null ? `[${titulo}: no disponible (git falló o supera ${MAX_BUFFER_DIFF / 1024 / 1024} MB)]\n` : filtrarPatch(crudo, excluido);
      fs.writeFileSync(path.join(dirArt, nombre), cuerpo || `[${titulo}: sin cambios]\n`);
    };
    if (head !== '(sin commits)') {
      diffContra('HEAD', 'diff-sin-commitear.patch', 'cambios sin commitear (los archivos nuevos están enteros en la instantánea)');
      const base = baseDeRama(git);
      if (base) diffContra(base.base, 'diff-rama.patch', `diff contra el merge-base con ${base.ref}`);
    }
    return { destino: destinoAbs, raizRepo, archivos, bytes, excluidos, omitidos, noCopiados };
  } finally {
    try { fs.rmSync(hooks, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  DIR_ARTEFACTOS, MAX_ARCHIVOS, MAX_BYTES, MAX_PATCH,
  instantaneaDeTrabajo, filtrarPatch, rutasDelBloque
};
