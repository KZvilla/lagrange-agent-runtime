'use strict';

/**
 * FEAT-202 S0 — La forma de `fallback_agy`, en un módulo hoja: la leen `lib/config.js` y `lib/ajustes.js` sin cargar
 * `fallback-agy.js`, que la reexporta.
 */

const { RE_CUENTA } = require('../motores/roles.js');

const RE_FALLBACK = /^claude@([a-z0-9][a-z0-9-]{0,31})$/;
const FALLBACK_DEEPSEEK = 'deepseek';
const FALLBACK_OPENCODE_GO = 'opencode-go';

/**
 * FEAT-168 — La forma de un valor de `fallback_agy`: `{ motor: 'claude',
 * cuenta }`, `{ motor: 'deepseek' | 'opencode-go', cuenta: null }` (FEAT-175)
 * o `null` si no es válido.
 * Solo la forma: que la cuenta exista lo mira cada superficie (config,
 * set_config, Ajustes), que tienen las cuentas a mano.
 */
function formaDeFallback(v) {
  if (v === FALLBACK_DEEPSEEK || v === FALLBACK_OPENCODE_GO) return { motor: v, cuenta: null };
  const m = typeof v === 'string' ? RE_FALLBACK.exec(v) : null;
  return m && RE_CUENTA.test(m[1]) ? { motor: 'claude', cuenta: m[1] } : null;
}

module.exports = { RE_FALLBACK, FALLBACK_DEEPSEEK, FALLBACK_OPENCODE_GO, formaDeFallback };
