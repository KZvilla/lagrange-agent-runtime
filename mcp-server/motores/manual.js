'use strict';

/**
 * FEAT-202 S1 — Dónde va una llamada cuando agy está en modo manual (FEAT-191/192), decidido en un solo lugar (D8).
 *
 * El modo manual es una barrera de los términos de uso de Google, no un detalle: con él, Lagrange nunca lanza agy.
 * `destinoManual` devuelve:
 *
 *   'normal'   no hay modo manual, o la llamada no lanza agy (corre en otro motor, o es una consulta);
 *   'cola'     plan / review / audit que resuelven a agy: van por pedido → informe (FEAT-192);
 *   'rechazo'  lanzaría agy y no tiene adónde ir: se frena al entrar, con un aviso.
 *
 * Las herramientas con respaldo (textos, casts, almas, lectura con `fallback_agy`) no se frenan acá: lo resuelven
 * `respaldo.js` y el `preflight` de antigravity, que también miran el modo manual. Lo mismo las sondas de agy y su
 * cupo (`sondas-antigravity.js`, `lib/cuota-agy.js`).
 *
 * FEAT-206 — El modo manual solo gobierna agy. Una lectura en agy con un respaldo capaz (`respaldo: true`, lo resuelve
 * el llamador con `eleccionDeRespaldo`, que ya descarta un hilo retomado) no va a la cola: corre el respaldo. Que un
 * rol en claude no caiga a otra cuenta de claude lo decide `respaldo.js`, no este módulo.
 *
 * `eleccion` es el motor ya resuelto. Hoy lo resuelve solo `engine`; desde S3, también el rol. Un motor que no es
 * antigravity nunca va a la cola.
 */

const agyModo = require('./antigravity/modo.js');

/** Lanzan agy y no tienen respaldo. */
const SIN_RESPALDO = Object.freeze(new Set(['agy_run', 'agy_research', 'agy_image', 'agy_fanout']));
/** Las de lectura que tienen cola de pedidos (FEAT-192). */
const CON_COLA = Object.freeze(new Set(['agy_plan', 'agy_review', 'agy_audit']));

function lanzaAgy(herramienta, args) {
  return SIN_RESPALDO.has(herramienta)
    // Una sesión de voz abierta antes del cambio tampoco recibe turnos ni se relanza; status, drain y stop siguen.
    || (herramienta === 'agy_voice_stream' && ['start', 'send', 'confirm'].includes(args.action || 'start'))
    // `list` y `register` consultan `agy agents`; `cast` cae al respaldo del rol.
    || (herramienta === 'cast_agent' && ['list', 'register'].includes(args.action))
    // `alma action:"agente"` verifica el agente con `agy agents` (y con `sondas: true`, las corre).
    || (herramienta === 'alma' && args.action === 'agente')
    || (herramienta === 'agy_lote' && args.accion !== 'estado' && !String(args.motor || '').startsWith('claude@'));
}

/** El motor de la llamada: la elección resuelta, o `engine`; sin ninguno, antigravity (el defecto). */
function motorDe(args, eleccion) {
  if (eleccion && eleccion.motor) return typeof eleccion.motor === 'string' ? eleccion.motor : eleccion.motor.id;
  return args.engine === undefined || args.engine === 'agy' ? 'antigravity' : args.engine;
}

function destinoManual({ herramienta, args = {}, eleccion = null, manual = agyModo.enModoManual(), respaldo = false } = {}) {
  if (!manual) return 'normal';
  if (CON_COLA.has(herramienta)) return motorDe(args, eleccion) === 'antigravity' && !respaldo ? 'cola' : 'normal';
  // FEAT-202 S5 — Una llamada ya resuelta a otro motor (`run` por rol) no lanza agy: corre ahí.
  if (eleccion && motorDe(args, eleccion) !== 'antigravity') return 'normal';
  return lanzaAgy(herramienta, args) ? 'rechazo' : 'normal';
}

module.exports = { SIN_RESPALDO, CON_COLA, destinoManual };
