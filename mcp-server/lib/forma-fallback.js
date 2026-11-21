'use strict';

/**
 * FEAT-202 S0 — La forma de `fallback_agy`, en un módulo hoja: la leen `lib/config.js` y `lib/ajustes.js` sin cargar
 * `fallback-agy.js`, que la reexporta.
 */

const { RE_CUENTA, rolValido, caminoDeRespaldo, motoresDeRespaldo, generalDeRol } = require('../motores/roles.js');

const RE_FALLBACK = /^claude@([a-z0-9][a-z0-9-]{0,31})$/;
const FALLBACK_DEEPSEEK = 'deepseek';
const FALLBACK_OPENCODE_GO = 'opencode-go';
// FEAT-206 — agy como destino del respaldo, con su modelo por defecto.
const FALLBACK_ANTIGRAVITY = 'antigravity';
/** FEAT-206 — Los valores válidos, en un solo texto: lo usan la carga, la validación, `set_config` y Ajustes. */
const DESTINOS_VALIDOS_TEXTO = '"claude@<cuenta>", "deepseek", "opencode-go", "antigravity" o null';

/**
 * FEAT-168 — La forma de un valor de `fallback_agy`: `{ motor: 'claude',
 * cuenta }`, `{ motor: 'deepseek' | 'opencode-go', cuenta: null }` (FEAT-175)
 * o `null` si no es válido.
 * Solo la forma: que la cuenta exista lo mira cada superficie (config,
 * set_config, Ajustes), que tienen las cuentas a mano.
 */
function formaDeFallback(v) {
  if (v === FALLBACK_DEEPSEEK || v === FALLBACK_OPENCODE_GO || v === FALLBACK_ANTIGRAVITY) return { motor: v, cuenta: null };
  const m = typeof v === 'string' ? RE_FALLBACK.exec(v) : null;
  return m && RE_CUENTA.test(m[1]) ? { motor: 'claude', cuenta: m[1] } : null;
}

const NOMBRE_MOTOR = Object.freeze({ claude: 'claude@<cuenta>', deepseek: 'deepseek', 'opencode-go': 'opencode-go', antigravity: 'antigravity' });

/**
 * FEAT-206 — El motor efectivo de un rol con la tabla `motores.roles` (la herencia de `elegir`: `cast:<x>` → `cast`,
 * `alma:<x>` → `alma`, `consolidar:<x>` → `consolidar`). Sin entrada, antigravity.
 */
function motorEfectivo(roles, rol) {
  const tabla = roles && typeof roles === 'object' ? roles : {};
  const general = generalDeRol(rol);
  const entrada = tabla[rol] || (general ? tabla[general] : null);
  return (entrada && typeof entrada.motor === 'string' && entrada.motor) || 'antigravity';
}

/**
 * FEAT-205 — Valida el respaldo de un rol (`fallback_agy_roles[rol]`): un destino con la forma de `fallback_agy` que el
 * camino del rol acepta (`motoresDeRespaldo`), o `null` («sin respaldo»). `cuentas`: los nombres de `motores.cuentas`.
 * Un `claude@<cuenta>` exige la cuenta declarada y que no sea `principal` (como el global en Ajustes v2).
 * Devuelve `{ ok: true, valor }` o `{ ok: false, motivo }`.
 */
function validarRespaldoRol(rol, valor, cuentas = [], { roles = null } = {}) {
  if (typeof rol !== 'string' || !rolValido(rol)) return { ok: false, motivo: `rol desconocido "${String(rol).slice(0, 80)}"` };
  if (!caminoDeRespaldo(rol)) return { ok: false, motivo: `el rol "${rol}" no tiene respaldo` };
  if (valor === null) return { ok: true, valor: null };
  const forma = formaDeFallback(valor);
  if (!forma) return { ok: false, motivo: `el respaldo de "${rol}" tiene que ser ${DESTINOS_VALIDOS_TEXTO}` };
  const admite = motoresDeRespaldo(rol);
  if (!admite.includes(forma.motor)) {
    return { ok: false, motivo: `el rol "${rol}" no puede caer a ${forma.motor} (acepta: ${admite.map((m) => NOMBRE_MOTOR[m]).join(', ')})` };
  }
  if (forma.motor === 'claude') {
    if (forma.cuenta === 'principal') return { ok: false, motivo: `el respaldo de "${rol}" no puede ser la cuenta principal` };
    if (!(cuentas || []).includes(forma.cuenta)) return { ok: false, motivo: `el respaldo de "${rol}" usa la cuenta "${forma.cuenta}", que no está en \`motores.cuentas\`` };
  }
  // FEAT-206 (decisión 4) — Con la tabla de roles, el destino no puede ser el motor efectivo del rol, ni claude a claude.
  // `regla` dice cuál choca, para que la carga tolerante conserve claude a claude con un aviso.
  if (roles) {
    const m = motorEfectivo(roles, rol);
    if (forma.motor === m) {
      const regla = m === 'claude' ? 'claude-a-claude' : 'mismo-motor';
      const motivo = m === 'claude'
        ? `el rol "${rol}" corre en claude y su respaldo no puede ser otra cuenta de claude`
        : `el rol "${rol}" corre en ${m}: su respaldo no puede ser el mismo motor`;
      return { ok: false, motivo: `${motivo}; para limpiarlo, mandá fallback_agy_roles entero con "${rol}": null, o elegí otro respaldo en la terminal`, regla };
    }
  }
  return { ok: true, valor };
}

/**
 * FEAT-205 — El mapa entero. `estricto` (escritura): todo o nada, `{ ok: false, motivo, rol }` en la primera entrada
 * mala. Tolerante (la carga): se queda con las buenas y deja un aviso por cada una que ignora.
 */
function validarMapaRespaldos(mapa, cuentas = [], { estricto = false, roles = null } = {}) {
  if (mapa === undefined || mapa === null) return { ok: true, mapa: {}, avisos: [] };
  if (typeof mapa !== 'object' || Array.isArray(mapa)) return { ok: false, motivo: '`fallback_agy_roles` tiene que ser un objeto { rol: destino | null }', avisos: [] };
  const salida = {};
  const avisos = [];
  for (const [rol, valor] of Object.entries(mapa)) {
    const r = validarRespaldoRol(rol, valor, cuentas, { roles });
    if (r.ok) { salida[rol] = r.valor; continue; }
    if (estricto) return { ok: false, motivo: r.motivo, rol, avisos };
    // FEAT-206 — En la carga, una entrada del mismo motor o de claude a claude se conserva (el rol puede cambiar de
    // motor) y no rige; claude a claude suma un aviso.
    if (r.regla) {
      salida[rol] = valor;
      if (r.regla === 'claude-a-claude') avisos.push(`fallback_agy_roles: el rol "${rol}" corre en claude y su respaldo es otra cuenta de claude; no rige`);
      continue;
    }
    avisos.push(`fallback_agy_roles: ${r.motivo}; se ignora esa entrada`);
  }
  return { ok: true, mapa: salida, avisos };
}

module.exports = { RE_FALLBACK, FALLBACK_DEEPSEEK, FALLBACK_OPENCODE_GO, FALLBACK_ANTIGRAVITY, DESTINOS_VALIDOS_TEXTO, NOMBRE_MOTOR, formaDeFallback, motorEfectivo, validarRespaldoRol, validarMapaRespaldos };
