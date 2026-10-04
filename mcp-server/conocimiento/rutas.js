/**
 * FEAT-129 §1 — Dónde vive la base de conocimiento y a qué proyecto pertenece
 * cada cosa.
 *
 * La raíz cuelga de `~/.claude/`, al lado de `lagrange-almas` (`almas/rutas.js`):
 * la comparten las dos cuentas porque no depende de `CLAUDE_CONFIG_DIR`.
 *
 * El proyecto es el clon principal, también desde un worktree:
 * `--git-common-dir` absoluto apunta a `<clon>/.git` y su `dirname` es el clon
 * (sin el `dirname`, el slug terminaba en `---git`). El slug es el de
 * `recall.slugDeProyecto`, la misma convención que `projects/<slug>/memory`.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { homeDir } = require('../almas/rutas.js');
const { slugDeProyecto } = require('../recall.js');

const WIN = process.platform === 'win32';
const ARGS_GIT = ['rev-parse', '--path-format=absolute', '--git-common-dir'];

function dirConocimiento(env = process.env) {
  const explicito = (env.LAGRANGE_CONOCIMIENTO_DIR || '').trim();
  if (explicito) return path.resolve(explicito);
  return path.join(homeDir(env), '.claude', 'lagrange-conocimiento');
}

function dirProyecto(slug, env = process.env) {
  return path.join(dirConocimiento(env), 'proyectos', slug);
}

/** El clon a partir de la salida de git, o `null` si no sirve. */
function clonDeSalida(salida) {
  const dir = String(salida || '').trim();
  return dir ? path.dirname(path.resolve(dir)) : null;
}

/**
 * Raíz del proyecto del `cwd`, sincrónica: la usa el hook (proceso corto) y el
 * primer evento de un MCP que todavía no la resolvió. Si git falla, el cwd.
 */
function raizDeProyectoSync(cwd, { timeoutMs = 1000 } = {}) {
  const base = path.resolve(cwd || process.cwd());
  try {
    const salida = execFileSync('git', ['-C', base, ...ARGS_GIT], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, windowsHide: true
    });
    return clonDeSalida(salida) || base;
  } catch {
    return base;
  }
}

/** Lo mismo sin frenar el event loop: la usa el MCP. Nunca rechaza. */
function raizDeProyecto(cwd, { timeoutMs = 5000 } = {}) {
  const base = path.resolve(cwd || process.cwd());
  return new Promise((resolve) => {
    execFile('git', ['-C', base, ...ARGS_GIT], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, salida) => {
      resolve(err ? base : (clonDeSalida(salida) || base));
    });
  });
}

// El cwd del MCP no cambia: se resuelve una vez por cwd.
const cache = new Map();

/** La raíz ya resuelta para `cwd`, o la resuelve sincrónicamente (una sola vez). */
function raizCacheada(cwd) {
  const base = path.resolve(cwd || process.cwd());
  if (!cache.has(base)) cache.set(base, raizDeProyectoSync(base));
  return cache.get(base);
}

/** Resuelve en segundo plano y deja la raíz en la caché. */
async function precargarRaiz(cwd) {
  const base = path.resolve(cwd || process.cwd());
  if (!cache.has(base)) cache.set(base, await raizDeProyecto(base));
  return cache.get(base);
}

/** Barras normales, sin barra final y, en Windows, en minúsculas: solo para comparar. */
function normalizarRuta(ruta) {
  const r = String(ruta || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return WIN ? r.toLowerCase() : r;
}

/**
 * §1 (ronda 3) — Si el `project:` de un handoff es de este proyecto. Sin
 * fallback al cwd: igual a la raíz o dentro de `<raíz>/.worktrees/`. Comparación
 * de strings, sin git.
 */
function esDelProyecto(project, raiz) {
  const p = normalizarRuta(project);
  const r = normalizarRuta(raiz);
  if (!p || !r || p === 'unknown') return false;
  return p === r || p.startsWith(`${r}/.worktrees/`);
}

/** Existe y es archivo. */
function existeArchivo(ruta) {
  try { return fs.statSync(ruta).isFile(); } catch { return false; }
}

module.exports = {
  dirConocimiento, dirProyecto, raizDeProyectoSync, raizDeProyecto, raizCacheada, precargarRaiz,
  normalizarRuta, esDelProyecto, slugDeProyecto, existeArchivo
};
