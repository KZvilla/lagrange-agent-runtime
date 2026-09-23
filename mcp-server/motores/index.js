/**
 * FEAT-072 — Registro de motores, elección por rol y despacho.
 *
 * Las superficies (charla, consolidación, cast) no preguntan "¿es claude?":
 * resuelven el motor del rol, le piden `preflight` y `armar`, y entregan lo
 * armado al ejecutor que el motor declara (`motor.ejecutor`). Si ese ejecutor
 * no fue inyectado, rechazan: una superficie nunca lanza un CLI por su cuenta.
 *
 * La validación de `motores.roles` vive en `roles.js` (sin dependencias, para
 * que `lib/config.js` la cargue sin traer los motores).
 */

const os = require('node:os');
const antigravity = require('./antigravity.js');
const claude = require('./claude.js');
const roles = require('./roles.js');

const MOTORES = Object.freeze({ [antigravity.id]: antigravity, [claude.id]: claude });

function motorPorId(id) {
  return MOTORES[id] || null;
}

/**
 * `{ motor, modelo, esfuerzo }` para un rol (`alma`, `consolidar`, `cast`,
 * `cast:<nombre>`). `cast:<nombre>` gana sobre `cast`. Sin configuración, o con
 * una sección inválida (que `loadConfig` ya descartó), es `antigravity` sin
 * modelo ni esfuerzo propios: lo de siempre.
 */
function elegir(config, rol) {
  const tabla = (config && config.motores && config.motores.roles) || {};
  let entrada = tabla[rol] || null;
  if (!entrada && rol.startsWith('cast:')) entrada = tabla.cast || null;
  const motor = (entrada && motorPorId(entrada.motor)) || antigravity;
  return {
    motor,
    modelo: (entrada && entrada.modelo) || null,
    esfuerzo: (entrada && entrada.esfuerzo) || null
  };
}

/** Motivo de rechazo si el motor no tiene su ejecutor en este proceso; `null` si lo tiene. */
function faltaEjecutor(motor, ejecutores) {
  return typeof (ejecutores || {})[motor.ejecutor] === 'function'
    ? null
    : `el motor ${motor.id} no está disponible en este proceso`;
}

/**
 * Arma, ejecuta con el ejecutor del motor e interpreta. `limpiar()` corre
 * siempre. Si Claude arrancó pero no informó hilo (watchdog), el resultado se
 * queda con el previsto: el hilo existe y perderlo obliga a re-explicar todo.
 * Si no arrancó (`lanzado: false`), no hay hilo que registrar.
 */
async function despachar({ motor, pedido, pre = {}, ejecutores, opciones = {}, env = process.env, homeDir = os.homedir() }) {
  const armado = motor.armar(pedido, { bin: pre.bin || null, env, homeDir });
  let crudo;
  try {
    crudo = await ejecutores[motor.ejecutor](armado, opciones);
  } finally {
    if (armado && typeof armado.limpiar === 'function') armado.limpiar();
  }
  const resultado = motor.interpretar(crudo, pedido);
  if (!resultado.hilo && crudo && crudo.lanzado && armado.hiloPrevisto) resultado.hilo = armado.hiloPrevisto;
  return resultado;
}

/** ¿Algún rol de la configuración corre en este motor? */
function usaMotor(config, id) {
  const tabla = (config && config.motores && config.motores.roles) || {};
  return Object.values(tabla).some(r => r && r.motor === id);
}

/**
 * Un contexto de sondas por proceso para todos los motores, perezoso por
 * motor: `leerSondas(motor, perfil)` y `dispararSondas(motor, perfil)` como los
 * espera el `preflight`. Sin motor es `antigravity` (su `preflight` lo pasa
 * explícito igual).
 *
 * `config` puede ser un valor o una función (para leerla al momento): de ahí
 * sale `motores.claude.bin`.
 */
function crearContextoSondas({ agyBin, homeDir = os.homedir(), log = () => {}, config = null } = {}) {
  let deAgy = null;
  let deClaude = null;
  const leerConfig = () => (typeof config === 'function' ? config() : config);
  const de = (id) => {
    if (id === claude.id) {
      return (deClaude ||= require('./sondas-claude.js').crearContextoSondas({
        homeDir,
        log,
        obtenerBin: () => require('./claude-ejecutar.js').resolverBinario(leerConfig())
      }));
    }
    return (deAgy ||= require('./sondas-antigravity.js').crearContextoSondas({ agyBin, homeDir, log }));
  };
  return {
    leerSondas: (motor = antigravity.id, perfil) => de(motor).leerSondas(perfil),
    dispararSondas: (motor = antigravity.id) => de(motor).dispararSondas(),
    correrAhora: (motor = antigravity.id) => de(motor).correrAhora(),
    // Al arrancar un proceso (el bot): agy siempre; claude solo si algún rol lo
    // usa, así nadie paga sondas de un motor que no configuró.
    dispararSiHaceFalta: async () => {
      const v = await de(antigravity.id).dispararSiHaceFalta();
      if (usaMotor(leerConfig(), claude.id)) await de(claude.id).dispararSiHaceFalta();
      return v;
    },
    deMotor: de
  };
}

module.exports = {
  MOTORES,
  ROLES_BASE: roles.ROLES_BASE,
  motorPorId,
  elegir,
  usaMotor,
  faltaEjecutor,
  despachar,
  crearContextoSondas
};
