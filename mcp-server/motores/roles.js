/**
 * FEAT-072 — Validación de `motores` en `~/.claude/antigravity.json`:
 *
 *   "motores": {
 *     "roles": { "alma": { "motor": "claude", "modelo": "sonnet", "esfuerzo": "medium" }, … },
 *     "claude": { "bin": null, "freno_cuota_5h": null }
 *   }
 *
 * Sin más dependencia que `niveles.js` (una hoja), para que `lib/config.js` y
 * `saveConfig` validen igual sin cargar los motores. `test/motores-claude.test.js` fija que `MODELO_OBLIGATORIO`
 * coincide con lo que declara cada motor.
 */

const { COMPLETO, nivelesPara } = require('./niveles.js');

const ROLES_BASE = ['alma', 'consolidar', 'cast'];
const MODELO_OBLIGATORIO = Object.freeze({ antigravity: false, claude: true });
const ESFUERZOS = COMPLETO;
const RE_CAST = /^cast:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RE_MODELO = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;

function rolValido(rol) {
  return ROLES_BASE.includes(rol) || RE_CAST.test(rol);
}

/**
 * `{ ok: true, roles, avisos }` o `{ ok: false, motivo }`. Todo o nada para
 * rol, motor y modelo: una sola entrada inválida invalida la sección, y todo
 * queda en `antigravity`.
 *
 * BE-041 — El esfuerzo se contrasta con `nivelesPara(motor, modelo)`. Uno que
 * el modelo no admite (Haiku con esfuerzo, Pro con `medium`):
 *   - `estricto: false` (la carga): se normaliza (sin esfuerzo, o el implícito
 *     de la familia) con un aviso. Un parámetro que el CLI ignora no puede
 *     tirar abajo toda la configuración.
 *   - `estricto: true` (la escritura: `agy_set_config`, la web): se rechaza
 *     con el motivo, sin guardar.
 * Un rol de agy sin modelo no se puede contrastar (agy elige): pasa.
 */
function validarRoles(roles, { estricto = false } = {}) {
  if (roles === undefined || roles === null) return { ok: true, roles: {}, avisos: [] };
  if (typeof roles !== 'object' || Array.isArray(roles)) return { ok: false, motivo: '`motores.roles` tiene que ser un objeto' };
  const salida = {};
  const avisos = [];
  for (const [rol, entrada] of Object.entries(roles)) {
    if (!rolValido(rol)) return { ok: false, motivo: `rol desconocido "${rol}" (válidos: ${ROLES_BASE.join(', ')}, cast:<nombre>)` };
    if (!entrada || typeof entrada !== 'object') return { ok: false, motivo: `el rol "${rol}" no es un objeto` };
    const { motor, modelo = null, esfuerzo = null } = entrada;
    if (!Object.prototype.hasOwnProperty.call(MODELO_OBLIGATORIO, motor)) {
      return { ok: false, motivo: `el rol "${rol}" pide un motor desconocido "${motor}" (válidos: ${Object.keys(MODELO_OBLIGATORIO).join(', ')})` };
    }
    if (modelo !== null && (typeof modelo !== 'string' || !RE_MODELO.test(modelo))) {
      return { ok: false, motivo: `el rol "${rol}" trae un modelo inválido` };
    }
    if (MODELO_OBLIGATORIO[motor] && !modelo) {
      return { ok: false, motivo: `el rol "${rol}" usa ${motor}, que exige \`modelo\`` };
    }
    if (esfuerzo !== null && !ESFUERZOS.includes(String(esfuerzo).toLowerCase())) {
      return { ok: false, motivo: `el rol "${rol}" trae un esfuerzo inválido "${esfuerzo}" (válidos: ${ESFUERZOS.join(', ')})` };
    }
    let nivel = esfuerzo === null ? null : String(esfuerzo).toLowerCase();
    if (nivel !== null && modelo) {
      const n = nivelesPara(motor, modelo);
      if (!n.admite || !n.niveles.includes(nivel)) {
        const motivo = n.admite
          ? `el rol "${rol}": ${modelo} no admite el esfuerzo "${nivel}" (admite: ${n.niveles.join(', ')})`
          : `el rol "${rol}": ${modelo} no admite esfuerzo`;
        if (estricto) return { ok: false, motivo };
        nivel = n.admite ? n.implicito : null;
        avisos.push(`${motivo}; se usa ${nivel ? `"${nivel}"` : 'sin esfuerzo'}`);
      }
    }
    salida[rol] = { motor, modelo, esfuerzo: nivel };
  }
  return { ok: true, roles: salida, avisos };
}

/** `motores.claude.bin`: una ruta (string no vacío) o `null`. */
function validarBin(bin) {
  if (bin === undefined || bin === null) return { ok: true, bin: null };
  if (typeof bin !== 'string' || !bin.trim()) return { ok: false, motivo: '`motores.claude.bin` tiene que ser una ruta o null' };
  return { ok: true, bin: bin.trim() };
}

module.exports = { ROLES_BASE, MODELO_OBLIGATORIO, ESFUERZOS, rolValido, validarRoles, validarBin };
