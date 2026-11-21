'use strict';

/**
 * Lo que rinde cada modelo de OpenCode Go: los pedidos estimados cada 5 h en el plan Go, según la Console
 * (https://opencode.ai/console/go, leída el 2026-11-21). El cupo de Go se mide en dólares por modelo, y todos comparten
 * la misma asignación: un modelo caro gasta la misma plata en menos pedidos.
 *
 * Solo informa: lo muestra la terminal en la ficha de Go. Qué modelos se pueden elegir sigue saliendo de la tabla
 * `MODELOS_GO` de `niveles.js`. Un id que no está acá sale sin estimación (`pedidos5h: null`, `gratis: false`).
 *
 * Es una hoja (sin dependencias). Los números cambian: al actualizarlos, cambiar también `FECHA`.
 */

const FECHA = '2026-11-21';
const FUENTE = 'https://opencode.ai/console/go';

/** `id` del catálogo de Go → `{ nombre, pedidos5h }`. `pedidos5h: null` con `gratis: true` es sin tope. */
const ESTIMADOS = Object.freeze({
  'deepseek-v4.1-flash': { nombre: 'DeepSeek V4.1 Flash 1017', pedidos5h: 43300 },
  'muse-spark-1.2-contributor': { nombre: 'Muse Spark 1.2 Contributor', pedidos5h: 45300 },
  'muse-spark-1.3-contributor': { nombre: 'Muse Spark 1.3 Contributor', pedidos5h: 45300 },
  'mimo-v2.6-flash': { nombre: 'MiMo-V2.6-Flash', pedidos5h: 30100 },
  'longcat-2.0': { nombre: 'LongCat-2.0', pedidos5h: 11400 },
  'glm-5.3': { nombre: 'GLM-5.3', pedidos5h: 6600 },
  'glm-5.3-flash': { nombre: 'GLM-5.3-Flash', pedidos5h: 6320 },
  'qwen3.8-flash': { nombre: 'Qwen3.8 Flash', pedidos5h: 5400 },
  'qwen3.7-plus': { nombre: 'Qwen3.7 Plus', pedidos5h: 4310 },
  hy3: { nombre: 'Hy3', pedidos5h: 4300 },
  'gpt-6-luna': { nombre: 'GPT-6 Luna', pedidos5h: 4230 },
  'minimax-m3.1-flash': { nombre: 'MiniMax M3.1 Flash', pedidos5h: 3880 },
  'claude-haiku-5-5': { nombre: 'Claude Haiku 5.5', pedidos5h: 3850 },
  'mimo-v2.6-pro': { nombre: 'MiMo-V2.6-Pro', pedidos5h: 3260 },
  'minimax-m3': { nombre: 'MiniMax-M3', pedidos5h: 3210 },
  hy4: { nombre: 'Hy4', pedidos5h: 2710 },
  'gpt-5.6-luna': { nombre: 'GPT-5.6 Luna', pedidos5h: 2050 },
  'hy4-preview': { nombre: 'Hy4 preview', pedidos5h: 1350 },
  'deepseek-v4-pro': { nombre: 'DeepSeek V4 Pro', pedidos5h: 1040 },
  'kimi-k2.7-code': { nombre: 'Kimi K2.7 Code', pedidos5h: 994 },
  'gemini-4-argon': { nombre: 'Gemini 4 Argon', pedidos5h: 566 },
  'qwen4-max': { nombre: 'Qwen4 Max', pedidos5h: 463 },
  'step-5-preview': { nombre: 'Step 5 Preview', pedidos5h: 426 },
  'grok-4.7': { nombre: 'Grok 4.7', pedidos5h: 169 },
  'qwen3.8-max': { nombre: 'Qwen3.8 Max', pedidos5h: 162 },
  'kimi-k3.1-pro': { nombre: 'Kimi K3.1 Pro', pedidos5h: 147 },
  'kimi-k3': { nombre: 'Kimi K3', pedidos5h: 98 },
  'hy4-flash-free': { nombre: 'Hy4 flash Free', pedidos5h: null, gratis: true },
  'beam-free': { nombre: 'Beam Free', pedidos5h: null, gratis: true },
  'iceman-contributor-free': { nombre: 'Iceman Contributor Free', pedidos5h: null, gratis: true },
  'longcat-2.5-free': { nombre: 'LongCat 2.5 Free', pedidos5h: null, gratis: true }
});

/** `{ id, nombre, pedidos5h, gratis }` de un id; sin estimación, `nombre: null` y `pedidos5h: null`. */
function estimadoDe(id) {
  const e = Object.prototype.hasOwnProperty.call(ESTIMADOS, id) ? ESTIMADOS[id] : null;
  return { id, nombre: e ? e.nombre : null, pedidos5h: e ? e.pedidos5h : null, gratis: Boolean(e && e.gratis) };
}

/** Los gratis primero; después, de más a menos pedidos; los sin estimación al final, por id. */
function ordenar(a, b) {
  if (a.gratis !== b.gratis) return a.gratis ? -1 : 1;
  const pa = a.pedidos5h === null ? -1 : a.pedidos5h;
  const pb = b.pedidos5h === null ? -1 : b.pedidos5h;
  return pb - pa || a.id.localeCompare(b.id);
}

/**
 * Los modelos de Go que no están en `enTabla`: los del catálogo vivo (`ids`) si se pudo leer; si no, los de
 * `ESTIMADOS`. Con su estimación y en orden.
 */
function otrosModelos(ids, enTabla) {
  const fuera = new Set(enTabla);
  const base = Array.isArray(ids) ? ids : Object.keys(ESTIMADOS);
  return [...new Set(base)].filter((id) => typeof id === 'string' && !fuera.has(id)).map(estimadoDe).sort(ordenar);
}

module.exports = { FECHA, FUENTE, ESTIMADOS, estimadoDe, otrosModelos };
