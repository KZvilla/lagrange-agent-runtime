/**
 * FEAT-075 — Escritura de `motores` en `~/.claude/antigravity.json`, compartida
 * por `set_config` (el MCP) y la consola web (el bridge). Vive fuera de
 * `mcp-server/index.js` para que el bridge la use sin cargar el servidor MCP.
 *
 * Valida estricto, igual que `set_config` desde FEAT-072: lo que
 * `loadConfig` ignoraría entero no se guarda.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const roles = require('./roles.js');
const { leerJson, guardarJson } = require('../agents/almacen.js');
const { conLock } = require('../almas/archivos.js');
const { validarRespaldoRol, validarMapaRespaldos } = require('../lib/forma-fallback.js');

/**
 * `motores` de `set_config` sobre lo guardado. `roles` y `cuentas`
 * reemplazan su tabla entera (así se puede quitar un rol o una cuenta); cada
 * motor se fusiona campo a campo (`bin`, `freno_cuota_5h`). Lanza con el motivo
 * si no valida.
 *
 * FEAT-085 — Los roles se validan contra las cuentas que quedan: un rol no
 * puede nombrar una cuenta que no existe, ni quitarse una cuenta en uso.
 * `cuentas` se guarda como se escribió (`~/.claude-work`), no resuelta.
 * `nombresCuentas`: las cuentas contra las que validar cuando el archivo no es
 * el que las define (el del proyecto valida contra las de la global).
 */
function fusionarMotores(actual, nuevo, { homeDir = os.homedir(), nombresCuentas = undefined } = {}) {
  if (!nuevo || typeof nuevo !== 'object' || Array.isArray(nuevo)) throw new Error('`motores` tiene que ser un objeto.');
  const salida = { ...(actual && typeof actual === 'object' && !Array.isArray(actual) ? actual : {}) };
  if (nuevo.cuentas !== undefined) {
    const c = roles.validarCuentas(nuevo.cuentas, { homeDir });
    if (!c.ok) throw new Error(c.motivo);
    salida.cuentas = c.crudas;
  }
  const nombres = nombresCuentas !== undefined
    ? nombresCuentas
    : Object.keys(salida.cuentas && typeof salida.cuentas === 'object' ? salida.cuentas : {});
  for (const [clave, valor] of Object.entries(nuevo)) {
    if (clave === 'cuentas') continue;
    if (clave === 'roles') {
      const r = roles.validarRoles(valor, { estricto: true, cuentas: nombres });
      if (!r.ok) throw new Error(r.motivo);
      salida.roles = r.roles;
      continue;
    }
    // FEAT-166 — Un motor sin nada que configurar no tiene sección.
    if (roles.SIN_SECCION.includes(clave)) throw new Error(`\`motores.${clave}\` no existe: el motor ${clave} no tiene nada que configurar (informa saldo, y no hay freno por saldo).`);
    if (!Object.prototype.hasOwnProperty.call(roles.MODELO_OBLIGATORIO, clave)) {
      throw new Error(`clave desconocida en \`motores\`: "${clave}" (válidas: roles, cuentas, ${Object.keys(roles.MODELO_OBLIGATORIO).filter((m) => !roles.SIN_SECCION.includes(m)).join(', ')}).`);
    }
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error(`\`motores.${clave}\` tiene que ser un objeto.`);
    // FEAT-202 S4 (D5) — Cada motor, sus claves (`CLAVES_DE_SECCION`): opencode-go solo `freno_cuota`.
    const aceptadas = roles.CLAVES_DE_SECCION[clave];
    const ajena = aceptadas && Object.keys(valor).find((k) => !aceptadas.includes(k));
    if (ajena === 'bin') throw new Error('`bin` solo aplica a `motores.claude`.');
    if (ajena) throw new Error(`\`motores.${clave}.${ajena}\` no existe (el motor ${clave} acepta: ${aceptadas.join(', ')}).`);
    const motor = { ...(salida[clave] || {}) };
    if (valor.bin !== undefined) {
      if (clave !== 'claude') throw new Error('`bin` solo aplica a `motores.claude`.');
      const b = roles.validarBin(valor.bin);
      if (!b.ok) throw new Error(b.motivo);
      motor.bin = b.bin;
    }
    // Son la misma perilla: la última escrita gana y borra a la otra (Ajustes de la consola todavía escribe el alias).
    for (const [claveFreno, otra] of [['freno_cuota_5h', 'freno_cuota'], ['freno_cuota', 'freno_cuota_5h']]) {
      if (valor[claveFreno] === undefined) continue;
      const f = valor[claveFreno];
      if (f !== null && !(Number.isFinite(f) && f >= 0 && f <= 1)) throw new Error(`\`${claveFreno}\` va de 0 a 1, o null.`);
      motor[claveFreno] = f;
      delete motor[otra];
    }
    salida[clave] = motor;
  }
  // Quitar una cuenta (sin tocar `roles`) no puede dejar un rol apuntándola.
  if (nuevo.cuentas !== undefined && nuevo.roles === undefined && salida.roles) {
    const huerfano = Object.entries(salida.roles).find(([, r]) => r && r.cuenta && !nombres.includes(r.cuenta));
    if (huerfano) throw new Error(`el rol "${huerfano[0]}" usa la cuenta "${huerfano[1].cuenta}", que se quitaría de \`motores.cuentas\`.`);
  }
  return salida;
}

/**
 * FEAT-134 — El home que usa la configuración: el mismo orden que
 * `loadConfig` (`HOME`, `USERPROFILE`), para que los tres escritores
 * (`saveConfig`, `guardarRol`, Ajustes) escriban el archivo que se lee.
 */
function homeDeConfig(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** El archivo global que escribe `saveConfig` con `scope: 'global'`. */
function rutaConfigGlobal(homeDir = homeDeConfig()) {
  return path.join(homeDir, '.claude', 'antigravity.json');
}

/**
 * FEAT-134 — Lee la configuración global para modificarla: `{ ok, datos }` o
 * `{ ok: false, motivo }`. Un archivo ilegible, o que no es un objeto JSON, NO
 * se pisa: se informa y se arregla a mano. Que no exista da `{}`.
 */
function leerParaModificar(ruta) {
  const leido = leerJson(ruta);
  if (leido.ilegible) return { ok: false, motivo: `${ruta} no se puede leer como JSON; no se modifica` };
  if (leido.datos === null) {
    // `leerJson` da `null` para "no existe", "vacío" y el literal `null`: solo los dos primeros son {}.
    let crudo = '';
    try { crudo = fs.readFileSync(ruta, 'utf8'); } catch { crudo = ''; }
    if (crudo.trim()) return { ok: false, motivo: `${ruta} no es un objeto JSON; no se modifica` };
    return { ok: true, datos: {} };
  }
  if (typeof leido.datos !== 'object' || Array.isArray(leido.datos)) return { ok: false, motivo: `${ruta} no es un objeto JSON; no se modifica` };
  return { ok: true, datos: leido.datos };
}

/**
 * FEAT-134 — Lo de `guardarRol` sin I/O: aplica UN rol (o lo quita, con
 * `entrada === null`) sobre `datos` (el JSON global ya leído) y devuelve
 * `{ ok: true, datos, roles }` con un objeto nuevo, o `{ ok: false, motivo }`.
 * Ajustes la usa para varios roles dentro de un solo lock y una sola escritura.
 */
function aplicarRol(datos, rol, entrada, { homeDir = homeDeConfig(), validarRespaldo = true } = {}) {
  if (typeof rol !== 'string' || !roles.rolValido(rol)) return { ok: false, motivo: `rol desconocido "${rol}"` };
  // Lo ya guardado se normaliza como en la carga (un esfuerzo que el modelo no
  // admite, escrito a mano, no bloquea editar otro sujeto); lo nuevo, estricto.
  const guardados = roles.validarRoles(datos.motores && typeof datos.motores === 'object' ? datos.motores.roles : undefined);
  if (!guardados.ok) return { ok: false, motivo: `motores.roles guardada no valida (${guardados.motivo}); arreglala antes` };
  const tabla = { ...guardados.roles };
  const nombres = Object.keys(datos.motores && datos.motores.cuentas && typeof datos.motores.cuentas === 'object' ? datos.motores.cuentas : {});
  if (entrada === null) delete tabla[rol];
  else {
    // FEAT-085 — La web no edita la cuenta: una entrada sin la clave `cuenta`
    // conserva la guardada del mismo rol (y del mismo motor). `cuenta: null` la quita.
    const previa = tabla[rol];
    if (entrada && typeof entrada === 'object' && !('cuenta' in entrada) && previa && previa.cuenta && previa.motor === entrada.motor) {
      entrada = { ...entrada, cuenta: previa.cuenta };
    }
    const nueva = roles.validarRoles({ [rol]: entrada }, { estricto: true, cuentas: nombres });
    if (!nueva.ok) return { ok: false, motivo: nueva.motivo };
    tabla[rol] = nueva.roles[rol];
  }
  // FEAT-206 (A5) — Cambiar el motor de un rol revalida el respaldo entero contra los roles que quedan: un respaldo que
  // queda en el mismo motor, o de claude a claude, no se guarda.
  // `validarRespaldo: false` cuando la misma escritura cambia también el respaldo: lo valida `aplicarRespaldoRol` después,
  // con el mapa nuevo y los roles nuevos.
  if (validarRespaldo && datos.fallback_agy_roles !== undefined) {
    const r = validarMapaRespaldos(datos.fallback_agy_roles, nombres, { estricto: true, roles: tabla });
    if (!r.ok) return { ok: false, motivo: `fallback_agy_roles: ${r.motivo}` };
  }
  let motores;
  try {
    motores = fusionarMotores(datos.motores, { roles: tabla }, { homeDir });
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
  // FEAT-206 — Lo que la carga sacó de lo guardado (p. ej. `audit` en claude) se informa: la escritura lo deja fuera.
  return { ok: true, datos: { ...datos, motores }, roles: motores.roles, avisos: guardados.avisos || [] };
}

/**
 * FEAT-205 — Lo de `guardarRol` para el respaldo, sin I/O: fija el de UN rol en `fallback_agy_roles` (un destino o
 * `null`, «sin respaldo») o lo borra con `'heredar'`. Si el mapa queda vacío, la clave sale del archivo. Valida
 * estricto (`validarRespaldoRol`) contra las cuentas del mismo archivo. `{ ok: true, datos }` o `{ ok: false, motivo }`.
 */
function aplicarRespaldoRol(datos, rol, valor) {
  const nombres = Object.keys(datos.motores && datos.motores.cuentas && typeof datos.motores.cuentas === 'object' ? datos.motores.cuentas : {});
  const previo = datos.fallback_agy_roles && typeof datos.fallback_agy_roles === 'object' && !Array.isArray(datos.fallback_agy_roles)
    ? datos.fallback_agy_roles : {};
  const mapa = { ...previo };
  if (valor === 'heredar') {
    if (!roles.rolValido(rol)) return { ok: false, motivo: `rol desconocido "${rol}"` };
    // Un rol sin camino de respaldo (research, run, imagen, voz) no tiene qué heredar: es el mismo 400 que un destino.
    if (!roles.caminoDeRespaldo(rol)) return { ok: false, motivo: `el rol "${rol}" no tiene respaldo` };
    delete mapa[rol];
  } else {
    const r = validarRespaldoRol(rol, valor, nombres);
    if (!r.ok) return { ok: false, motivo: r.motivo };
    mapa[rol] = r.valor;
  }
  // FEAT-206 — El mapa entero, con los roles del archivo (el mismo motor y claude a claude no se guardan).
  const rolesGuardados = datos.motores && typeof datos.motores === 'object' && datos.motores.roles && typeof datos.motores.roles === 'object' ? datos.motores.roles : {};
  const entero = validarMapaRespaldos(mapa, nombres, { estricto: true, roles: rolesGuardados });
  if (!entero.ok) return { ok: false, motivo: entero.motivo };
  const salida = { ...datos };
  if (Object.keys(mapa).length) salida.fallback_agy_roles = mapa;
  else delete salida.fallback_agy_roles;
  return { ok: true, datos: salida };
}

/**
 * Reemplaza UN rol de `motores.roles` (o lo quita, con `entrada === null`) en
 * el archivo global. `{ ok: true, roles }` o `{ ok: false, motivo }`.
 *
 * FEAT-134 — Leer, aplicar y escribir corren bajo el lock del archivo
 * (`conLock`, el mismo de `saveConfig` y Ajustes): una escritura concurrente
 * espera en vez de pisarse. El lock no es reentrante, así que quien ya lo tiene
 * usa `aplicarRol`, nunca esta función. La escritura es atómica (temporal +
 * rename) y preserva el resto del archivo. Un archivo ilegible NO se pisa ni se
 * aparta: la web no puede tirar la configuración del usuario por un JSON roto.
 */
function guardarRol(rol, entrada, { homeDir = homeDeConfig(), respaldo } = {}) {
  if (typeof rol !== 'string' || !roles.rolValido(rol)) return { ok: false, motivo: `rol desconocido "${rol}"` };
  // FEAT-205 — `entrada === undefined`: no se toca el rol (solo el respaldo). Los dos, o ninguno: un solo `guardarJson`.
  if (entrada === undefined && respaldo === undefined) return { ok: false, motivo: 'nada que guardar', campo: 'motor' };
  const ruta = rutaConfigGlobal(homeDir);
  try {
    return conLock(ruta, () => {
      const leido = leerParaModificar(ruta);
      if (!leido.ok) return leido;
      let datos = leido.datos;
      let tabla = null;
      let avisos = [];
      if (entrada !== undefined) {
        const r = aplicarRol(datos, rol, entrada, { homeDir, validarRespaldo: respaldo === undefined });
        if (!r.ok) return { ...r, campo: 'motor' };
        datos = r.datos;
        tabla = r.roles;
        avisos = r.avisos || [];
      }
      if (respaldo !== undefined) {
        const r = aplicarRespaldoRol(datos, rol, respaldo);
        if (!r.ok) return { ...r, campo: 'respaldo' };
        datos = r.datos;
      }
      guardarJson(ruta, datos);
      return { ok: true, roles: tabla || ((datos.motores && datos.motores.roles) || {}), respaldos: datos.fallback_agy_roles || {}, avisos };
    });
  } catch (err) {
    if (err && err.code === 'ELOCK') return { ok: false, motivo: err.message };
    throw err;
  }
}

module.exports = { fusionarMotores, homeDeConfig, rutaConfigGlobal, leerParaModificar, aplicarRol, aplicarRespaldoRol, guardarRol };
