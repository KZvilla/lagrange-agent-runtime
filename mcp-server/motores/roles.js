/**
 * FEAT-072 — Validación de `motores` en `~/.claude/antigravity.json`:
 *
 *   "motores": {
 *     "roles": { "alma": { "motor": "claude", "modelo": "sonnet", "esfuerzo": "medium" }, … },
 *     "claude": { "bin": null, "freno_cuota_5h": null }
 *   }
 *
 * Sin dependencias, para que `lib/config.js` y `saveConfig` validen igual sin
 * cargar los motores. `test/motores-claude.test.js` fija que `MODELO_OBLIGATORIO`
 * coincide con lo que declara cada motor.
 */

const ROLES_BASE = ['alma', 'consolidar', 'cast'];
const MODELO_OBLIGATORIO = Object.freeze({ antigravity: false, claude: true });
const ESFUERZOS = ['low', 'medium', 'high', 'xhigh', 'max'];
const RE_CAST = /^cast:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RE_MODELO = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;

function rolValido(rol) {
  return ROLES_BASE.includes(rol) || RE_CAST.test(rol);
}

/**
 * `{ ok: true, roles }` o `{ ok: false, motivo }`. Todo o nada: una sola
 * entrada inválida invalida la sección, y todo queda en `antigravity`.
 */
function validarRoles(roles) {
  if (roles === undefined || roles === null) return { ok: true, roles: {} };
  if (typeof roles !== 'object' || Array.isArray(roles)) return { ok: false, motivo: '`motores.roles` tiene que ser un objeto' };
  const salida = {};
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
    if (esfuerzo !== null && !ESFUERZOS.includes(esfuerzo)) {
      return { ok: false, motivo: `el rol "${rol}" trae un esfuerzo inválido "${esfuerzo}" (válidos: ${ESFUERZOS.join(', ')})` };
    }
    salida[rol] = { motor, modelo, esfuerzo };
  }
  return { ok: true, roles: salida };
}

/** `motores.claude.bin`: una ruta (string no vacío) o `null`. */
function validarBin(bin) {
  if (bin === undefined || bin === null) return { ok: true, bin: null };
  if (typeof bin !== 'string' || !bin.trim()) return { ok: false, motivo: '`motores.claude.bin` tiene que ser una ruta o null' };
  return { ok: true, bin: bin.trim() };
}

module.exports = { ROLES_BASE, MODELO_OBLIGATORIO, ESFUERZOS, rolValido, validarRoles, validarBin };
