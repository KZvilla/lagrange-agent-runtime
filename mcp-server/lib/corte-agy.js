/**
 * BE-049 — agy corta por `--print-timeout` y lo informa como éxito.
 *
 * Sondeado en vivo contra agy 1.2.11 (2026-09-26): cuando vence el
 * `--print-timeout` con el turno en curso, agy sale con 0, emite
 * `status: "SUCCESS"` (JSON final o evento `result`) con la respuesta cortada
 * a la mitad, y la única señal es esta línea en stderr:
 *
 *   [agy] print timeout after 8s with turn in progress; returning partial output
 *
 * Sin detectarla, una review o una auditoría cortada llegaba a Claude como si
 * estuviera completa, y un lote sincronizaba trabajo a medias.
 *
 * CommonJS a propósito: el bridge (ESM) lo carga con `createRequire`, igual
 * que `cli-compat.js`.
 */

const PATRON = /print timeout after (\S+) with turn in progress; returning partial output/i;

/** `{ limite }` (p. ej. `'15m0s'`) si stderr trae el aviso del corte; si no, `null`. */
function detectarCortePorTimeout(stderr) {
  const m = PATRON.exec(String(stderr || ''));
  return m ? { limite: m[1] } : null;
}

/**
 * Mensaje de error corto, sin el texto de la respuesta: `fanout.esErrorDeCuota`
 * y el auditor del lote miran /quota|429/ en `error`, y una respuesta parcial
 * que mencionara "quota" dispararía un reintento falso.
 */
function mensajeCorte({ limite, conversationId } = {}) {
  return `Antigravity hit --print-timeout (${limite || 'unknown'}) with the turn still running: the response is INCOMPLETE.`
    + (conversationId ? ` Resume with conversation_id "${conversationId}"` : ' Retry')
    + ' or raise timeout_minutes.';
}

module.exports = { detectarCortePorTimeout, mensajeCorte };
