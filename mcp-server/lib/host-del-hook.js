'use strict';

/**
 * BE-067 / BE-068 — Si el plugin corre bajo Codex, que comparte hooks.json y el
 * MCP con Claude Code.
 *
 * Medido el 2026-09-28 (codex-cli 0.157.1): Codex les pasa a sus hooks
 * PLUGIN_ROOT y también CLAUDE_PLUGIN_ROOT, los dos con la ruta de su caché.
 * Claude Code les pasa CLAUDE_PLUGIN_ROOT y nunca PLUGIN_ROOT
 * (plugins-reference). Cada host fija sus variables en vez de heredarlas, así que:
 *
 * - Codex, aunque lo haya lanzado una sesión o un hook de Claude: PLUGIN_ROOT
 *   igual a CLAUDE_PLUGIN_ROOT (o sin CLAUDE_PLUGIN_ROOT, si otra versión no lo pasa).
 * - Claude lanzado desde Codex: hereda PLUGIN_ROOT, pero su CLAUDE_PLUGIN_ROOT
 *   apunta a su propia caché. No es Codex.
 * - Claude solo: sin PLUGIN_ROOT.
 */

const path = require('path');

function normalizar(p) {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function esHookDeCodex(env = process.env) {
  const propio = String(env.PLUGIN_ROOT || '').trim();
  if (!propio) return false;
  const deClaude = String(env.CLAUDE_PLUGIN_ROOT || '').trim();
  return !deClaude || normalizar(propio) === normalizar(deClaude);
}

/**
 * BE-068 — Si este código corre desde la caché de plugins de Codex: bajo
 * CODEX_HOME o bajo un directorio `.codex`. Es la ruta del código, no una
 * variable, así que no se hereda. La caché de Claude Code vive en `.claude`.
 */
function codigoEnCacheDeCodex(raizPlugin, env = process.env) {
  const raiz = normalizar(raizPlugin);
  const home = String(env.CODEX_HOME || '').trim();
  if (home && raiz.startsWith(normalizar(home) + path.sep)) return true;
  return raiz.split(/[\\/]/).includes('.codex');
}

module.exports = { esHookDeCodex, codigoEnCacheDeCodex };
