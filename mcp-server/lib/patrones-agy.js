'use strict';

/**
 * FEAT-202 S0 — Cómo se reconoce en un texto de agy que se quedó sin cuota, en un módulo hoja: lo leen
 * `fallback-agy.js` (que lo reexporta) y `motores/sondas-antigravity.js`.
 */

// «agy sin cuota»: el motivo con que las sondas de agy (BE-073) rechazan el preflight.
const RE_CUOTA = /quota reached|RESOURCE_EXHAUSTED|\b429\b|agy sin cuota|AI credits balance is too low/i;
// BE-094 — Cuota del plan agotada y sin créditos de IA: agy corta enseguida con
// "Your AI credits balance is too low to continue." No se repone en minutos.
const RE_SIN_CREDITOS = /AI credits balance is too low/i;

module.exports = { RE_CUOTA, RE_SIN_CREDITOS };
