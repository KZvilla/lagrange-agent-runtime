/**
 * FEAT-075 — Escritura de `motores` en `~/.claude/antigravity.json`, compartida
 * por `agy_set_config` (el MCP) y la consola web (el bridge). Vive fuera de
 * `mcp-server/index.js` para que el bridge la use sin cargar el servidor MCP.
 *
 * Valida estricto, igual que `agy_set_config` desde FEAT-072: lo que
 * `loadConfig` ignoraría entero no se guarda.
 */

const os = require('node:os');
const path = require('node:path');
const roles = require('./roles.js');
const { leerJson, guardarJson } = require('../agents/almacen.js');

/**
 * `motores` de `agy_set_config` sobre lo guardado. `roles` reemplaza la tabla
 * entera (así se puede quitar un rol); cada motor se fusiona campo a campo
 * (`bin`, `freno_cuota_5h`). Lanza con el motivo si no valida.
 */
function fusionarMotores(actual, nuevo) {
  if (!nuevo || typeof nuevo !== 'object' || Array.isArray(nuevo)) throw new Error('`motores` tiene que ser un objeto.');
  const salida = { ...(actual && typeof actual === 'object' && !Array.isArray(actual) ? actual : {}) };
  for (const [clave, valor] of Object.entries(nuevo)) {
    if (clave === 'roles') {
      const r = roles.validarRoles(valor, { estricto: true });
      if (!r.ok) throw new Error(r.motivo);
      salida.roles = r.roles;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(roles.MODELO_OBLIGATORIO, clave)) {
      throw new Error(`clave desconocida en \`motores\`: "${clave}" (válidas: roles, ${Object.keys(roles.MODELO_OBLIGATORIO).join(', ')}).`);
    }
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error(`\`motores.${clave}\` tiene que ser un objeto.`);
    const motor = { ...(salida[clave] || {}) };
    if (valor.bin !== undefined) {
      if (clave !== 'claude') throw new Error('`bin` solo aplica a `motores.claude`.');
      const b = roles.validarBin(valor.bin);
      if (!b.ok) throw new Error(b.motivo);
      motor.bin = b.bin;
    }
    if (valor.freno_cuota_5h !== undefined) {
      const f = valor.freno_cuota_5h;
      if (f !== null && !(Number.isFinite(f) && f >= 0 && f <= 1)) throw new Error('`freno_cuota_5h` va de 0 a 1, o null.');
      motor.freno_cuota_5h = f;
    }
    salida[clave] = motor;
  }
  return salida;
}

/** El archivo global que escribe `saveConfig` con `scope: 'global'`. */
function rutaConfigGlobal(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'antigravity.json');
}

/**
 * Reemplaza UN rol de `motores.roles` (o lo quita, con `entrada === null`) en
 * el archivo global. `{ ok: true, roles }` o `{ ok: false, motivo }`.
 *
 * Relee justo antes de escribir y toca un solo rol: una escritura concurrente
 * de `agy_set_config` gana o pierde entera, sin mezclarse (último que escribe
 * gana, como entre dos `agy_set_config`). La escritura es atómica (temporal +
 * rename) y preserva el resto del archivo. Un archivo ilegible NO se pisa ni
 * se aparta: la web no puede tirar la configuración del usuario por un JSON
 * roto; se informa y se arregla a mano.
 */
function guardarRol(rol, entrada, { homeDir = os.homedir() } = {}) {
  if (typeof rol !== 'string' || !roles.rolValido(rol)) return { ok: false, motivo: `rol desconocido "${rol}"` };
  const ruta = rutaConfigGlobal(homeDir);
  const leido = leerJson(ruta);
  if (leido.ilegible) return { ok: false, motivo: `${ruta} no se puede leer como JSON; no se modifica` };
  const datos = leido.datos && typeof leido.datos === 'object' && !Array.isArray(leido.datos) ? leido.datos : {};
  if (leido.datos !== null && datos !== leido.datos) return { ok: false, motivo: `${ruta} no es un objeto JSON; no se modifica` };

  // Lo ya guardado se normaliza como en la carga (un esfuerzo que el modelo no
  // admite, escrito a mano, no bloquea editar otro sujeto); lo nuevo, estricto.
  const guardados = roles.validarRoles(datos.motores && typeof datos.motores === 'object' ? datos.motores.roles : undefined);
  if (!guardados.ok) return { ok: false, motivo: `motores.roles guardada no valida (${guardados.motivo}); arreglala antes` };
  const tabla = { ...guardados.roles };
  if (entrada === null) delete tabla[rol];
  else {
    const nueva = roles.validarRoles({ [rol]: entrada }, { estricto: true });
    if (!nueva.ok) return { ok: false, motivo: nueva.motivo };
    tabla[rol] = nueva.roles[rol];
  }

  let motores;
  try {
    motores = fusionarMotores(datos.motores, { roles: tabla });
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
  guardarJson(ruta, { ...datos, motores });
  return { ok: true, roles: motores.roles };
}

module.exports = { fusionarMotores, rutaConfigGlobal, guardarRol };
