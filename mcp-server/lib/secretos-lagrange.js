/**
 * SEC-027 — Los secretos que pone Lagrange en el `.env` unificado no llegan a
 * ningún hijo que corra un modelo.
 *
 * El daemon carga el `.env` en su `process.env` (`loadBridgeEnv`), y de ahí lo
 * heredaban los `claude -p` de los roles, el consolidador y su agy, y las sondas.
 * Un hijo con shell (agy con skip-permissions) puede leer cualquier variable
 * heredada con un `echo` y devolverla al chat.
 *
 * Lista cerrada, no heurística: solo lo que pone Lagrange. Lo que el usuario
 * exporta por su cuenta (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, un proxy) es la
 * credencial que eligió para ese CLI y no se toca: quitarla rompería su login
 * (`README.md`, "GEMINI_API_KEY or agy auth login").
 *
 * Se aplica en los hijos con modelo: `opcionesDeAgy` (todo agy), `entornoParaClaude`
 * (todo `claude -p`) y, en el bridge, `sanitizeEnv`. El proceso Node del
 * consolidador no se filtra: necesita `LAGRANGE_MEMORY_TOKEN` (`almas/profunda.js`).
 *
 * `telegram-bridge/policy.js` es ESM puro a propósito y tiene una copia de la
 * lista y del patrón; `test/secretos-lagrange.test.js` verifica que no se separen.
 */

const SECRETOS_DE_LAGRANGE = Object.freeze([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_NOTIFY_CHAT_ID',
  'ALLOWED_USER_IDS',
  // Credencial del servicio de memoria de los agentes persistidos (FEAT-022).
  'LAGRANGE_MEMORY_TOKEN',
  // FEAT-166 — La key del motor deepseek.
  'DEEPSEEK_API_KEY',
  // La key de OpenCode Go (motor futuro).
  'OPENCODE_GO_API_KEY'
]);

/** Los tokens de los bots extra (FEAT-091) y de las almas: `TELEGRAM_BOT_<NOMBRE>_TOKEN`. */
const RE_TOKEN_DE_BOT = /^TELEGRAM_BOT_[A-Z0-9_]+_TOKEN$/i;

/** ¿Es un secreto de Lagrange? Sin distinguir mayúsculas: Windows no las distingue. */
function esSecretoDeLagrange(nombre) {
  const n = String(nombre).toUpperCase();
  return SECRETOS_DE_LAGRANGE.includes(n) || RE_TOKEN_DE_BOT.test(n);
}

/** Copia de `env` sin los secretos de Lagrange. Pura: no toca `env`. */
function sinSecretosDeLagrange(env = process.env) {
  const salida = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (!esSecretoDeLagrange(k)) salida[k] = v;
  }
  return salida;
}

module.exports = { SECRETOS_DE_LAGRANGE, RE_TOKEN_DE_BOT, esSecretoDeLagrange, sinSecretosDeLagrange };
