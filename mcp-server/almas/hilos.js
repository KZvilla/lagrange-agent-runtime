/**
 * FEAT-043 — El hilo de chat de cada alma.
 *
 * Un hilo dura mientras la charla siga viva: pasadas 6 h sin turnos se abre uno
 * nuevo. La continuidad larga no la da el hilo sino la memoria y el diario, que
 * se inyectan cuando el hilo nace (snapshot congelado, RFC §4.2).
 *
 * El archivo es JSON y se lee y escribe con `agents/almacen.js`, que aparta un
 * archivo ilegible en vez de pisarlo.
 */

const path = require('node:path');
const { leerJson, guardarJson } = require('../agents/almacen.js');
const { dirAlmas, validarClave } = require('./rutas.js');

const VENTANA_MS = 6 * 60 * 60 * 1000;

function rutaEstado(env = process.env) {
  return path.join(dirAlmas(env), 'estado.json');
}

function leerEstado(env) {
  const { datos, ilegible } = leerJson(rutaEstado(env));
  const estado = datos && typeof datos.almas === 'object' && datos.almas ? datos : { almas: {} };
  Object.defineProperty(estado, '_ilegible', { value: ilegible, enumerable: false });
  return estado;
}

function guardar(estado, env) {
  guardarJson(rutaEstado(env), { almas: estado.almas }, { ilegible: estado._ilegible });
}

/**
 * BE-039 — Un hilo por motor. El de agy sigue en `conversation_id` y
 * `ultimo_turno` de primer nivel, con el significado de siempre (una entrada
 * vieja ya está en el formato nuevo); los demás motores van en
 * `hilos_por_motor[motor]`. `turnos` cuenta los de cualquier motor.
 */
const MOTOR_POR_DEFECTO = 'antigravity';

/** `{ conversation_id, ultimo_turno }` del motor, o `null`. */
function hiloDelMotor(entrada, motor = MOTOR_POR_DEFECTO) {
  if (!entrada) return null;
  if (motor === MOTOR_POR_DEFECTO) {
    return entrada.conversation_id ? { conversation_id: entrada.conversation_id, ultimo_turno: entrada.ultimo_turno } : null;
  }
  const h = entrada.hilos_por_motor && entrada.hilos_por_motor[motor];
  return h && h.conversation_id ? h : null;
}

/** Todos los hilos de una entrada, como `[motor, hilo]`. */
function hilosDe(entrada) {
  if (!entrada) return [];
  const salida = [];
  if (entrada.conversation_id) salida.push([MOTOR_POR_DEFECTO, hiloDelMotor(entrada)]);
  for (const [motor, h] of Object.entries(entrada.hilos_por_motor || {})) {
    if (motor !== MOTOR_POR_DEFECTO && h && h.conversation_id) salida.push([motor, h]);
  }
  return salida;
}

/** El `ultimo_turno` más reciente entre todos los motores (lo exporta `portable.js`). */
function ultimoTurno(entrada) {
  if (!entrada) return null;
  const fechas = [entrada.ultimo_turno, ...Object.values(entrada.hilos_por_motor || {}).map(h => h && h.ultimo_turno)]
    .filter(f => typeof f === 'string' && Number.isFinite(Date.parse(f)));
  if (!fechas.length) return entrada.ultimo_turno || null;
  return fechas.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/**
 * El hilo vigente de un alma en ese motor, o `null` si no hay o si venció la
 * ventana (con el `ultimo_turno` de ese motor). Si el rol cambió de motor, nace
 * un hilo nuevo y el del otro motor se conserva para cuando vuelva.
 */
function hiloDe(clave, { ventanaMs = VENTANA_MS, ahora = Date.now(), env = process.env, motor = MOTOR_POR_DEFECTO } = {}) {
  validarClave(clave);
  const h = hiloDelMotor(leerEstado(env).almas[clave], motor);
  if (!h) return null;
  const ultimo = Date.parse(h.ultimo_turno || '');
  if (!Number.isFinite(ultimo)) return h.conversation_id;
  return ahora - ultimo > ventanaMs ? null : h.conversation_id;
}

/** Anota el turno y su hilo. Se llama aunque el turno haya fallado: perder el hilo obliga a empezar de cero. */
function registrarTurno(clave, { conversationId, motor = MOTOR_POR_DEFECTO } = {}, env = process.env) {
  validarClave(clave);
  const estado = leerEstado(env);
  const previo = estado.almas[clave] || {};
  const ahora = new Date().toISOString();
  if (motor === MOTOR_POR_DEFECTO) {
    estado.almas[clave] = {
      ...previo,
      conversation_id: conversationId || previo.conversation_id || null,
      ultimo_turno: ahora,
      turnos: (previo.turnos || 0) + 1
    };
  } else {
    const otros = previo.hilos_por_motor || {};
    const anterior = otros[motor] || {};
    estado.almas[clave] = {
      ...previo,
      turnos: (previo.turnos || 0) + 1,
      hilos_por_motor: {
        ...otros,
        [motor]: { conversation_id: conversationId || anterior.conversation_id || null, ultimo_turno: ahora }
      }
    };
  }
  guardar(estado, env);
  return estado.almas[clave];
}

/**
 * Olvida los hilos de todos los motores (no la memoria): el próximo turno
 * arranca limpio y relee el contexto. `true` si limpió algo, también cuando el
 * único hilo era de otro motor.
 */
function olvidarHilo(clave, env = process.env) {
  validarClave(clave);
  const estado = leerEstado(env);
  const previo = estado.almas[clave];
  if (!previo || !hilosDe(previo).length) return false;
  const { hilos_por_motor: _todos, ...resto } = previo;
  estado.almas[clave] = { ...resto, conversation_id: null };
  guardar(estado, env);
  return true;
}

/** El motor dueño de este hilo si es de un alma, o `null`. */
function motorDeHiloDeAlma(conversationId, env = process.env) {
  if (!conversationId) return null;
  for (const entrada of Object.values(leerEstado(env).almas)) {
    for (const [motor, h] of hilosDe(entrada)) {
      if (h.conversation_id === conversationId) return motor;
    }
  }
  return null;
}

/**
 * ¿Este `conversation_id` es el hilo de un alma, en cualquier motor?
 *
 * La misma defensa que `castAgentes.esHiloDeAgente`: el bot se niega a retomar
 * un hilo así por una vía que no pase por `--agent`, porque correría con el
 * agente por defecto —con escritura— sobre un hilo que nació sin tools. En
 * Claude la barrera ni siquiera queda fijada al hilo: un `--resume` sin los
 * flags de aislamiento le devuelve las tools (SEC-018 §1.2).
 */
function esHiloDeAlma(conversationId, env = process.env) {
  return motorDeHiloDeAlma(conversationId, env) !== null;
}

module.exports = {
  VENTANA_MS, rutaEstado, leerEstado, hiloDe, registrarTurno, olvidarHilo, esHiloDeAlma,
  motorDeHiloDeAlma, hilosDe, ultimoTurno
};
