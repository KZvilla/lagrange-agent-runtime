'use strict';

/**
 * FEAT-206 — Por qué un motor «no puede», como un campo estructurado (`causa`) del resultado neutral. Lo ponen los
 * ejecutores y los preflight; lo lee `respaldo.js` (`motivoMotor`) para decidir si el pedido cae al respaldo. Nunca se
 * adivina por el texto del error, salvo en agy, que conserva sus regex (`motivoAgy`).
 *
 * Un módulo hoja: lo cargan los ejecutores, `cupo.js` y `politicas.js` sin arrastrar los motores.
 */

/** Las causas que hacen caer al respaldo, por motor. Lo demás (timeout, 400, respuesta vacía…) es un fallo del pedido. */
const CAUSAS_QUE_CAEN = Object.freeze({
  deepseek: Object.freeze(['cupo', 'sin-key', 'caido']),
  'opencode-go': Object.freeze(['cupo', 'sin-key', 'caido', 'sondas']),
  claude: Object.freeze(['sin-cli', 'sondas', 'cuota', 'caido']),
  antigravity: Object.freeze(['cuota', 'sin_agy', 'caido', 'manual'])
});

/**
 * La causa de un status HTTP de una API: 401/403 → `sin-key`, 402 → `cupo` (DeepSeek sin saldo), 429 → `cupo` (o
 * `caido` si es el «Endpoint is unavailable» de Go), 5xx → `caido`. Un 400/422 y lo demás: `null` (no cae).
 */
function causaPorEstado(status, { upstream = false } = {}) {
  if (status === 401 || status === 403) return 'sin-key';
  if (status === 402) return 'cupo';
  if (status === 429) return upstream ? 'caido' : 'cupo';
  if (Number.isFinite(status) && status >= 500 && status <= 599) return 'caido';
  return null;
}

/** El nombre del motor para un texto («OpenCode Go no pudo…»). */
const NOMBRE_DE_MOTOR = Object.freeze({ antigravity: 'agy', claude: 'claude', deepseek: 'DeepSeek', 'opencode-go': 'OpenCode Go' });

/** El porqué en palabras, por causa. Las de agy (`cuota`, `sin_agy`) conservan su texto de siempre. */
const TEXTO_DE_CAUSA = Object.freeze({
  cupo: 'sin cupo',
  cuota: 'sin cuota',
  'sin-key': 'sin key',
  'sin-cli': 'sin CLI',
  sin_agy: 'no está instalado',
  sondas: 'con las sondas vencidas',
  caido: 'no responde',
  manual: 'en modo manual'
});

/** «OpenCode Go sin cupo», «agy en modo manual», «claude sin CLI». */
function describirCausa(motorId, causa) {
  const quien = NOMBRE_DE_MOTOR[motorId] || motorId || 'el motor';
  // Sin causa conocida: «no responde», el texto de siempre de agy; una causa sin texto (el reintento amplio): «no pudo».
  return `${quien} ${TEXTO_DE_CAUSA[causa] || (causa ? 'no pudo' : 'no responde')}`;
}

module.exports = { CAUSAS_QUE_CAEN, causaPorEstado, NOMBRE_DE_MOTOR, TEXTO_DE_CAUSA, describirCausa };
