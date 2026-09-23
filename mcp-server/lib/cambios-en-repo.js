'use strict';

/**
 * SEC-020 — Qué cambió en el repo mientras corría una tool "de solo lectura".
 *
 * `agy_plan`, `agy_review`, `agy_audit` y `agy_research` lanzan agy con
 * `--mode plan --dangerously-skip-permissions`: con skip, plan mode corre
 * comandos, y `deny`/`deny_commands` son texto en el prompt. El 2026-09-23 una
 * auditoría con `deny: ["edit"]` y `deny_commands: ["node*"]` corrió los gates y
 * escribió `diff.diff` en el worktree. Esto no lo impide: lo hace visible. Se
 * saca una foto de `git status` antes y otra después, y la salida de la tool
 * informa la diferencia. No se revierte ni se borra nada.
 *
 * Límites, que la salida repite: solo el repo de `cwd`; lo ignorado por git y lo
 * escrito fuera del repo no se ve; un cambio del usuario durante la corrida
 * aparece igual (la foto no sabe quién escribió).
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRADAS = 5000;
const MAX_LINEAS = 30;

// Campos fijos antes de la ruta en cada tipo de registro de porcelain v2.
const CAMPOS_ANTES_DE_RUTA = { 1: 8, 2: 9, u: 10, '?': 1 };

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, '--no-optional-locks', '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

/** La ruta es lo que queda después de N campos separados por espacio: puede tener espacios. */
function rutaDelRegistro(registro, campos) {
  let desde = 0;
  for (let i = 0; i < campos; i++) {
    desde = registro.indexOf(' ', desde) + 1;
    if (desde === 0) return null;
  }
  return registro.slice(desde);
}

function firmaDe(raiz, ruta) {
  try {
    const st = fs.statSync(path.join(raiz, ruta));
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

/**
 * Foto del estado de trabajo del repo que contiene `cwd`, o `null` si no hay
 * repo o git falla (timeout incluido). Las rutas quedan como las da git:
 * relativas a la raíz y con `/`.
 */
function fotoDelRepo(cwd) {
  try {
    const raiz = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    if (!raiz) return null;
    const salida = git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    const tokens = salida.split('\0');
    let head = '';
    let rama = '';
    let truncado = false;
    const entradas = new Map();
    for (let i = 0; i < tokens.length; i++) {
      const registro = tokens[i];
      if (!registro) continue;
      if (registro.startsWith('# branch.oid ')) {
        const oid = registro.slice('# branch.oid '.length);
        head = oid === '(initial)' ? '' : oid;
        continue;
      }
      if (registro.startsWith('# branch.head ')) {
        const nombre = registro.slice('# branch.head '.length);
        rama = nombre === '(detached)' ? '' : nombre;
        continue;
      }
      if (registro.startsWith('#')) continue;
      const tipo = registro[0];
      const campos = CAMPOS_ANTES_DE_RUTA[tipo];
      // En un renombre (`2`), el token siguiente es la ruta de origen, sin prefijo.
      if (tipo === '2') i++;
      if (!campos) continue;
      const ruta = rutaDelRegistro(registro, campos);
      if (!ruta) continue;
      if (entradas.size >= MAX_ENTRADAS) {
        truncado = true;
        continue;
      }
      const xy = tipo === '?' ? '??' : registro.slice(2, 4);
      entradas.set(ruta, { xy, firma: firmaDe(raiz, ruta) });
    }
    return { raiz, head, rama, entradas, truncado };
  } catch {
    return null;
  }
}

/** Toda ruta cuya entrada difiere entre las dos fotos, como transición de estado. */
function compararFotos(antes, despues) {
  if (!antes || !despues) return null;
  const rutas = new Set([...antes.entradas.keys(), ...despues.entradas.keys()]);
  const cambios = [];
  for (const ruta of [...rutas].sort()) {
    const a = antes.entradas.get(ruta);
    const d = despues.entradas.get(ruta);
    if (a && d && a.xy === d.xy && a.firma === d.firma) continue;
    cambios.push({ ruta, antes: a ? a.xy : null, despues: d ? d.xy : null });
  }
  return {
    raiz: despues.raiz,
    headAntes: antes.head,
    headDespues: despues.head,
    ramaAntes: antes.rama,
    ramaDespues: despues.rama,
    cambios,
    truncado: antes.truncado || despues.truncado
  };
}

function describirCambio({ ruta, antes, despues }) {
  const de = antes === null ? 'clean' : antes;
  const a = despues === null ? (antes === '??' ? 'gone' : 'clean') : despues;
  const nota = antes !== null && antes === despues ? ' (content changed)' : '';
  return `- \`${ruta}\`: ${de} → ${a}${nota}`;
}

const LIMITES = '_Only this repository is checked; gitignored paths and writes outside it are not._';

/**
 * Sección Markdown para el pie de la tool. `dif` es lo que devuelve
 * `compararFotos` (o `null` si no hubo foto).
 */
function formatearCambios(dif, { etiqueta = 'the tool', cwd = '' } = {}) {
  if (!dif) {
    return `Working tree: not checked (\`${cwd}\` is not a git repository, or git failed).\n${LIMITES}`;
  }
  const headCambio = dif.headAntes !== dif.headDespues;
  const ramaCambio = dif.ramaAntes !== dif.ramaDespues;
  if (!headCambio && !ramaCambio && dif.cambios.length === 0) {
    return `Working tree: no changes detected in \`${dif.raiz}\` (git status before/after).\n${LIMITES}`;
  }
  const lineas = [`⚠️ **The working tree changed while ${etiqueta} ran** (possibly by it, possibly by you).`];
  if (headCambio) lineas.push(`- HEAD: \`${dif.headAntes || '(none)'}\` → \`${dif.headDespues || '(none)'}\``);
  if (ramaCambio) lineas.push(`- Branch: \`${dif.ramaAntes || '(detached)'}\` → \`${dif.ramaDespues || '(detached)'}\``);
  for (const c of dif.cambios.slice(0, MAX_LINEAS)) lineas.push(describirCambio(c));
  if (dif.cambios.length > MAX_LINEAS) lineas.push(`- …and ${dif.cambios.length - MAX_LINEAS} more`);
  if (dif.truncado) lineas.push(`- (status listing capped at ${MAX_ENTRADAS} entries: the comparison is partial)`);
  lineas.push(`Paths are relative to \`${dif.raiz}\`. Nothing was reverted or deleted.`);
  lineas.push(LIMITES);
  return lineas.join('\n');
}

module.exports = { fotoDelRepo, compararFotos, formatearCambios, MAX_ENTRADAS };
