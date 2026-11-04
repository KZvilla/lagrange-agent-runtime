/**
 * BE-049 — agy corta por `--print-timeout` y hay que detectarlo aunque no lo
 * informe como éxito.
 *
 * Historial:
 *  - agy 1.2.11 (2026-09-26): sale con 0, `status: "SUCCESS"` y solo deja
 *    `[agy] print timeout after 8s with turn in progress; returning partial output`
 *    en stderr.
 *  - agy 1.5.0 (2026-11-04): sale con 3, `status: "ERROR"`, y el JSON trae
 *    `finished_reason: "print_timeout"` y la respuesta parcial. En stderr
 *    conviven la línea vieja, `error: print timeout after ... with the turn
 *    still in progress; the response is partial` y un `AGY_ERROR` con
 *    `"reason":"print_timeout"` y las tareas de fondo terminadas.
 *
 * `finished_reason` es la señal principal; el texto es el respaldo para
 * versiones viejas o salidas sin JSON.
 *
 * CommonJS a propósito: el bridge (ESM) lo carga con `createRequire`, igual
 * que `cli-compat.js`.
 */

// La frase tiene que abrir una línea (con o sin el prefijo que usa agy): así
// un mensaje de una tool o un MCP que solo la mencione no se toma por corte.
const PATRON = /(?:^|\n)(?:\[agy\]\s*|error:\s*|Print mode:\s*)?print timeout after (\S+)/i;

/** `{ limite }` si hay corte; si no, `null`. */
function detectarCortePorTimeout(stderr, { finishedReason, error } = {}) {
  const texto = [error, stderr].filter(Boolean).join('\n');
  const porRazon = String(finishedReason || '').toLowerCase() === 'print_timeout'
    || /"reason"\s*:\s*"print_timeout"/i.test(texto);
  const m = PATRON.exec(texto);
  if (!porRazon && !m) return null;
  return { limite: m ? m[1].replace(/[;,].*$/, '') : null };
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
