/**
 * FEAT-191 — Modo manual de agy: Lagrange nunca lanza agy para que el modelo trabaje.
 *
 * Para quien ya recibió un strike de Google (403 ToS, 2026-11-12): el formulario de
 * apelación y la FAQ de Antigravity prohíben que un agente de terceros (Claude Code)
 * maneje el login de Antigravity, y la reincidencia es suspensión permanente. En
 * modo manual, agy lo maneja solo el usuario en su terminal (FEAT-192).
 *
 * Fuentes, fail-closed: `agy_modo` de la config GLOBAL (`~/.claude/antigravity.json`;
 * la del proyecto no cuenta: un repo clonado no le devuelve el modo automático a
 * nadie) y la variable `LAGRANGE_AGY_MODO`. Si cualquiera dice `manual`, es manual.
 *
 * Sin dependencias: lo carga `opcionesDeAgy` en cada lanzamiento, así que lee el
 * archivo con caché por mtime. `LAGRANGE_AGY_MODO_CONFIG` cambia la ruta del archivo
 * (solo tests: el `HOME` de la suite es el real).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODOS = Object.freeze(['auto', 'manual']);
const CODIGO = 'AGY_MODO_MANUAL';
const MENSAJE = 'agy está en modo manual (agy_modo: "manual", FEAT-191): Lagrange no lanza agy. '
  + 'Corrélo vos en tu terminal, o usá otro motor (engine "opencode-go" o "deepseek" en agy_audit/agy_review/agy_plan, '
  + 'o fallback_agy). Para volver: set_config agy_modo "auto".';

class ErrorModoManual extends Error {
  constructor(que = null) {
    super(que ? `${que}: ${MENSAJE}` : MENSAJE);
    this.name = 'ErrorModoManual';
    this.code = CODIGO;
  }
}

function rutaConfig(env = process.env) {
  if (env.LAGRANGE_AGY_MODO_CONFIG) return env.LAGRANGE_AGY_MODO_CONFIG;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.claude', 'antigravity.json');
}

let cache = { ruta: null, mtimeMs: null, valor: null };

/** `agy_modo` crudo de la config global, o `null`. Un archivo ilegible no decide nada. */
function modoDeConfig(env = process.env) {
  const ruta = rutaConfig(env);
  let st;
  try { st = fs.statSync(ruta); } catch { cache = { ruta, mtimeMs: null, valor: null }; return null; }
  if (cache.ruta === ruta && cache.mtimeMs === st.mtimeMs) return cache.valor;
  let valor = null;
  try {
    const v = JSON.parse(fs.readFileSync(ruta, 'utf8')).agy_modo;
    valor = typeof v === 'string' ? v.trim().toLowerCase() : null;
  } catch {}
  cache = { ruta, mtimeMs: st.mtimeMs, valor };
  return valor;
}

/** `'manual'` si alguna fuente lo pide; si no, `'auto'`. */
function modoAgy(env = process.env) {
  const deEnv = String(env.LAGRANGE_AGY_MODO || '').trim().toLowerCase();
  if (deEnv === 'manual' || modoDeConfig(env) === 'manual') return 'manual';
  return 'auto';
}

const enModoManual = (env = process.env) => modoAgy(env) === 'manual';

/** Lanza `ErrorModoManual` en modo manual. `que` nombra lo que se iba a hacer. */
function exigirAgyAutomatico(que = null, env = process.env) {
  if (enModoManual(env)) throw new ErrorModoManual(que);
}

const esErrorModoManual = (err) => Boolean(err && err.code === CODIGO);

module.exports = { MODOS, MENSAJE, CODIGO, ErrorModoManual, modoAgy, enModoManual, exigirAgyAutomatico, esErrorModoManual, rutaConfig };
