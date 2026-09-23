/**
 * FEAT-018 — Estado persistido de los agentes casteados.
 *
 * Lo unico que hace falta guardar para que un agente sea "persistente" es su
 * `conversation_id`: con el, `agy --conversation <id>` continua el hilo exacto
 * de la vez anterior. El criterio acumulado no vive aca, vive en mcp-memory.
 *
 * Los estados que se guardan son los observables del RFC §4. `Corriendo` no se
 * persiste a proposito: mientras un cast corre, el propio proceso es la
 * evidencia, y un flag en disco solo sirve para quedar mintiendo si el proceso
 * muere de golpe.
 */

const os = require('node:os');
const path = require('node:path');
const { leerJson, guardarJson } = require('./almacen.js');

function rutaEstado(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'antigravity-agents-state.json');
}

/**
 * Devuelve el estado con una marca `_ilegible` no enumerable cuando el archivo
 * existe pero no se pudo interpretar. Los lectores pueden ignorarla — un
 * estado ilegible se comporta como vacío y no le voltea el cast a nadie —, pero
 * los que escriben tienen que respetarla: sin eso, un read-modify-write sobre
 * un archivo truncado borraba los hilos de todos los demás agentes.
 */
function leerEstado(homeDir = os.homedir()) {
  const { datos, ilegible } = leerJson(rutaEstado(homeDir));
  const estado = datos && typeof datos.agents === 'object' && datos.agents ? datos : { agents: {} };
  Object.defineProperty(estado, '_ilegible', { value: ilegible, enumerable: false });
  return estado;
}

function guardarEstado(estado, homeDir = os.homedir()) {
  guardarJson(rutaEstado(homeDir), { agents: estado.agents }, { ilegible: estado._ilegible });
}

function estadoDe(nombre, homeDir = os.homedir()) {
  return leerEstado(homeDir).agents[nombre] || null;
}

/**
 * BE-039 — Un hilo por motor. El de agy sigue en `conversation_id` de primer
 * nivel, como siempre; los demás motores van en `hilos_por_motor[motor]`.
 * `casts`, `ultimo_cast`, `ultimo_cwd` y `estado` cuentan los de cualquier
 * motor. Sin ventana de expiración, igual que antes.
 */
const MOTOR_POR_DEFECTO = 'antigravity';

/** Todos los hilos de una entrada, como `[motor, conversationId]`. */
function hilosDe(entrada) {
  if (!entrada) return [];
  const salida = [];
  if (entrada.conversation_id) salida.push([MOTOR_POR_DEFECTO, entrada.conversation_id]);
  for (const [motor, h] of Object.entries(entrada.hilos_por_motor || {})) {
    if (motor !== MOTOR_POR_DEFECTO && h && h.conversation_id) salida.push([motor, h.conversation_id]);
  }
  return salida;
}

/** ¿Tiene algún hilo, de cualquier motor? Lo usa el tablero para decir "inactivo". */
function tieneHilo(entrada) {
  return hilosDe(entrada).length > 0;
}

/** El `conversation_id` guardado para ese motor, o null si nunca se casteó con él. */
function hiloDe(nombre, homeDir = os.homedir(), { motor = MOTOR_POR_DEFECTO } = {}) {
  const entrada = estadoDe(nombre, homeDir);
  if (!entrada) return null;
  if (motor === MOTOR_POR_DEFECTO) return entrada.conversation_id || null;
  const h = entrada.hilos_por_motor && entrada.hilos_por_motor[motor];
  return (h && h.conversation_id) || null;
}

/**
 * Cierra un cast: guarda el hilo para la proxima vez y lleva la cuenta.
 * Read-modify-write con rename atomico; dos casts simultaneos del mismo agente
 * no son un caso que valga la pena bloquear, pero un archivo truncado si
 * romperia la continuidad de todos los agentes.
 */
function registrarCast(nombre, datos = {}, homeDir = os.homedir()) {
  const estado = leerEstado(homeDir);
  const previo = estado.agents[nombre] || { casts: 0 };
  // `contar: false` es un turno fallido o cancelado: se guarda el hilo, porque
  // retomarlo evita re-explicarle todo al agente, pero no cuenta como cast
  // hecho ni mueve la fecha del ultimo.
  const contar = datos.contar !== false;
  const motor = datos.motor || MOTOR_POR_DEFECTO;
  const comunes = {
    estado: 'inactivo',
    ultimo_cast: contar ? new Date().toISOString() : (previo.ultimo_cast || null),
    ultimo_cwd: datos.cwd || previo.ultimo_cwd || null,
    casts: (previo.casts || 0) + (contar ? 1 : 0)
  };
  if (motor === MOTOR_POR_DEFECTO) {
    estado.agents[nombre] = {
      ...previo,
      // Un cast que no devolvio conversation_id no debe borrar el hilo anterior.
      conversation_id: datos.conversationId || previo.conversation_id || null,
      ...comunes
    };
  } else {
    const otros = previo.hilos_por_motor || {};
    const anterior = otros[motor] || {};
    estado.agents[nombre] = {
      ...previo,
      ...comunes,
      hilos_por_motor: { ...otros, [motor]: { conversation_id: datos.conversationId || anterior.conversation_id || null } }
    };
  }
  guardarEstado(estado, homeDir);
  return estado.agents[nombre];
}

/** Olvida los hilos de todos los motores sin tocar su memoria de largo plazo. */
function olvidarHilo(nombre, homeDir = os.homedir()) {
  const estado = leerEstado(homeDir);
  if (!estado.agents[nombre]) return false;
  const { hilos_por_motor: _todos, ...resto } = estado.agents[nombre];
  estado.agents[nombre] = {
    ...resto,
    conversation_id: null,
    estado: 'registrado'
  };
  guardarEstado(estado, homeDir);
  return true;
}

module.exports = {
  rutaEstado,
  leerEstado,
  guardarEstado,
  estadoDe,
  hiloDe,
  hilosDe,
  tieneHilo,
  registrarCast,
  olvidarHilo
};
