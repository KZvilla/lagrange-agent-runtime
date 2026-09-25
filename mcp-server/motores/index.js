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
 * `{ motor, modelo, esfuerzo }` para un rol (`alma`, `alma:<clave>`,
 * `consolidar`, `consolidar:<clave>`, `cast`, `cast:<nombre>`). `cast:<nombre>` gana sobre `cast`,
 * `alma:<clave>` sobre `alma` (FEAT-075) y `consolidar:<clave>` sobre `consolidar` (FEAT-079), por entrada completa: el rol propio
 * no hereda campos sueltos del general. Sin configuración, o con una sección
 * inválida (que `loadConfig` ya descartó), es `antigravity` sin modelo ni
 * esfuerzo propios: lo de siempre.
 */
function elegir(config, rol) {
  const tabla = (config && config.motores && config.motores.roles) || {};
  let entrada = tabla[rol] || null;
  if (!entrada && rol.startsWith('cast:')) entrada = tabla.cast || null;
  if (!entrada && rol.startsWith('alma:')) entrada = tabla.alma || null;
  if (!entrada && rol.startsWith('consolidar:')) entrada = tabla.consolidar || null;
  const motor = (entrada && motorPorId(entrada.motor)) || antigravity;
  return {
    motor,
    modelo: (entrada && entrada.modelo) || null,
    esfuerzo: (entrada && entrada.esfuerzo) || null,
    // FEAT-085 — La cuenta viaja con la entrada completa, como el modelo.
    cuenta: (entrada && motor.id === claude.id && entrada.cuenta) || null
  };
}

/** FEAT-085 — Nombres de cuenta que usa algún rol de claude, sin repetir. */
function cuentasEnUso(config) {
  const tabla = (config && config.motores && config.motores.roles) || {};
  return [...new Set(Object.values(tabla).filter(r => r && r.motor === claude.id && r.cuenta).map(r => r.cuenta))].sort();
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
  // FEAT-085 — `configDir` lo resolvió el `preflight` de la cuenta del pedido.
  const armado = motor.armar(pedido, { bin: pre.bin || null, env, homeDir, configDir: pre.configDir || null });
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
 *
 * FEAT-085 — `claude@<cuenta>` es un contexto propio, con la carpeta de la
 * cuenta leída de la config al momento (si cambia la carpeta, nace otro). Una
 * cuenta que no está en `motores.cuentas` da un contexto que siempre rechaza y
 * nunca lanza nada.
 */
function crearContextoSondas({ agyBin, homeDir = os.homedir(), log = () => {}, config = null } = {}) {
  let deAgy = null;
  const deClaude = new Map();
  const leerConfig = () => (typeof config === 'function' ? config() : config);
  const obtenerBin = () => require('./claude-ejecutar.js').resolverBinario(leerConfig());
  const sinCuenta = (cuenta) => {
    const motivo = `la cuenta "${cuenta}" no está en motores.cuentas`;
    const rechazo = async () => ({ ok: false, motivo });
    return {
      leerSondas: rechazo, dispararSondas: () => {}, dispararSiHaceFalta: async () => [], correrAhora: async () => ({ ocupado: false, entradas: {} }),
      corriendo: () => false, huellaActual: () => null
    };
  };
  const de = (id) => {
    const [motor, cuenta = null] = String(id).split('@');
    if (motor === claude.id) {
      let configDir = null;
      if (cuenta) {
        const c = leerConfig();
        configDir = (c && c.motores && c.motores.cuentas && c.motores.cuentas[cuenta] && c.motores.cuentas[cuenta].configDir) || null;
        if (!configDir) return sinCuenta(cuenta);
      }
      const clave = `${cuenta || ''}|${configDir || ''}`;
      if (!deClaude.has(clave)) {
        deClaude.set(clave, require('./sondas-claude.js').crearContextoSondas({ homeDir, log, obtenerBin, cuenta, configDir }));
      }
      return deClaude.get(clave);
    }
    return (deAgy ||= require('./sondas-antigravity.js').crearContextoSondas({ agyBin, homeDir, log }));
  };
  return {
    leerSondas: (motor = antigravity.id, perfil) => de(motor).leerSondas(perfil),
    dispararSondas: (motor = antigravity.id) => de(motor).dispararSondas(),
    correrAhora: (motor = antigravity.id) => de(motor).correrAhora(),
    // Al arrancar un proceso (el bot): agy siempre; claude solo si algún rol lo
    // usa, así nadie paga sondas de un motor que no configuró. Cada cuenta en
    // uso, lo mismo.
    dispararSiHaceFalta: async () => {
      const v = await de(antigravity.id).dispararSiHaceFalta();
      const config = leerConfig();
      if (usaMotor(config, claude.id)) {
        const cuentas = cuentasEnUso(config);
        const tabla = (config && config.motores && config.motores.roles) || {};
        const sinCuentaEnUso = Object.values(tabla).some(r => r && r.motor === claude.id && !r.cuenta);
        if (sinCuentaEnUso) await de(claude.id).dispararSiHaceFalta();
        for (const cuenta of cuentas) await de(roles.claveDeCuenta(claude.id, cuenta)).dispararSiHaceFalta();
      }
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
  cuentasEnUso,
  claveDeCuenta: roles.claveDeCuenta,
  faltaEjecutor,
  despachar,
  crearContextoSondas
};
