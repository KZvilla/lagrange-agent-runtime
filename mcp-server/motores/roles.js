/**
 * FEAT-072 — Validación de `motores` en `~/.claude/antigravity.json`:
 *
 *   "motores": {
 *     "roles": { "alma": { "motor": "claude", "modelo": "sonnet", "esfuerzo": "medium" }, … },
 *     "claude": { "bin": null, "freno_cuota_5h": null },
 *     "cuentas": { "trabajo": { "configDir": "~/.claude-work" } }
 *   }
 *
 * Sin más dependencia que `niveles.js` (una hoja), para que `lib/config.js` y
 * `saveConfig` validen igual sin cargar los motores. `test/motores-claude.test.js` fija que `MODELO_OBLIGATORIO`
 * coincide con lo que declara cada motor.
 *
 * FEAT-085 — Una cuenta de Claude es una carpeta (`CLAUDE_CONFIG_DIR`) donde el
 * usuario hizo el login con el binario oficial. Lagrange guarda solo la ruta:
 * nunca un token, y el esquema rechaza cualquier campo que no sea `configDir`.
 * La cuenta es del rol: nunca se cambia de cuenta porque otra se quedó sin
 * cuota (un rol frenado se frena). Eso roza los términos de uso.
 */

const os = require('node:os');
const path = require('node:path');
const { COMPLETO, nivelesPara, modeloBloqueado } = require('./niveles.js');

const ROLES_BASE = ['alma', 'consolidar', 'cast'];
const MODELO_OBLIGATORIO = Object.freeze({ antigravity: false, claude: true });
const ESFUERZOS = COMPLETO;
const RE_CAST = /^cast:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// FEAT-075 — La misma forma que `CLAVE_VALIDA` de `almas/rutas.js` (no se
// importa para que este módulo siga siendo hoja; un test fija que coinciden).
const RE_ALMA = /^alma:[a-z0-9][a-z0-9-]{0,63}$/;
// FEAT-079 — La consolidación de la charla de voz por alma, con la misma clave.
const RE_CONSOLIDAR = /^consolidar:[a-z0-9][a-z0-9-]{0,63}$/;
const RE_MODELO = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;
// FEAT-085
const RE_CUENTA = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PARECE_CREDENCIAL = /sk-ant-|oauth|token/i;
/** Los motores que admiten `cuenta`: solo claude tiene login por carpeta. */
const CON_CUENTA = new Set(['claude']);

function rolValido(rol) {
  return ROLES_BASE.includes(rol) || RE_CAST.test(rol) || RE_ALMA.test(rol) || RE_CONSOLIDAR.test(rol);
}

/**
 * FEAT-085 — Índice de hilos, cuota, uso y sondas: el motor solo (`claude`), o
 * el motor y la cuenta (`claude@trabajo`). Sin cuenta, todo queda como antes.
 */
function claveDeCuenta(motor, cuenta = null) {
  return cuenta ? `${motor}@${cuenta}` : motor;
}

/** `~` inicial al home y a absoluta. */
function expandirRuta(ruta, homeDir) {
  const t = ruta.trim();
  const expandida = t === '~' || /^~[\\/]/.test(t) ? path.join(homeDir, t.slice(1)) : t;
  return path.resolve(expandida);
}

function mismaRuta(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * FEAT-085 — `motores.cuentas`. `{ ok: true, cuentas, crudas }` o
 * `{ ok: false, motivo }`, todo o nada. `cuentas` trae `configDir` resuelta
 * (lo que usa el motor); `crudas`, como se escribió (lo que se guarda).
 */
function validarCuentas(cuentas, { homeDir = os.homedir() } = {}) {
  if (cuentas === undefined || cuentas === null) return { ok: true, cuentas: {}, crudas: {} };
  if (typeof cuentas !== 'object' || Array.isArray(cuentas)) return { ok: false, motivo: '`motores.cuentas` tiene que ser un objeto' };
  const salida = {};
  const crudas = {};
  const porDefecto = path.join(homeDir, '.claude');
  for (const [nombre, entrada] of Object.entries(cuentas)) {
    if (!RE_CUENTA.test(nombre)) return { ok: false, motivo: `nombre de cuenta inválido "${nombre}" (minúsculas, dígitos y guiones, hasta 32)` };
    if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) return { ok: false, motivo: `la cuenta "${nombre}" no es un objeto` };
    const extra = Object.keys(entrada).filter(k => k !== 'configDir');
    if (extra.length) {
      return { ok: false, motivo: `la cuenta "${nombre}" solo admite \`configDir\` (sobra: ${extra.join(', ')}); Lagrange nunca guarda credenciales` };
    }
    const { configDir } = entrada;
    if (typeof configDir !== 'string' || !configDir.trim()) return { ok: false, motivo: `la cuenta "${nombre}" necesita \`configDir\`` };
    if (PARECE_CREDENCIAL.test(configDir)) return { ok: false, motivo: `el \`configDir\` de "${nombre}" parece una credencial; va la carpeta, nunca el token` };
    const resuelta = expandirRuta(configDir, homeDir);
    if (mismaRuta(resuelta, porDefecto)) return { ok: false, motivo: `la cuenta "${nombre}" apunta a ~/.claude, que es la cuenta por defecto` };
    salida[nombre] = { configDir: resuelta };
    crudas[nombre] = { configDir: configDir.trim() };
  }
  return { ok: true, cuentas: salida, crudas };
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
 *   - `estricto: true` (la escritura: `set_config`, la web): se rechaza
 *     con el motivo, sin guardar.
 * Un rol de agy sin modelo no se puede contrastar (agy elige): pasa.
 *
 * FEAT-085 — `cuenta` (opcional, solo claude) se valida en forma en los dos
 * modos. Que exista se comprueba contra `cuentas` (los nombres) cuando llega:
 * lo pasa la escritura. En la carga no se pasa: una cuenta que falta la frena
 * el `preflight` con el motivo, nunca un cambio silencioso de cuenta o motor.
 */
function validarRoles(roles, { estricto = false, cuentas = null } = {}) {
  if (roles === undefined || roles === null) return { ok: true, roles: {}, avisos: [] };
  if (typeof roles !== 'object' || Array.isArray(roles)) return { ok: false, motivo: '`motores.roles` tiene que ser un objeto' };
  const salida = {};
  const avisos = [];
  for (const [rol, entrada] of Object.entries(roles)) {
    if (!rolValido(rol)) return { ok: false, motivo: `rol desconocido "${rol}" (válidos: ${ROLES_BASE.join(', ')}, alma:<clave>, consolidar:<clave>, cast:<nombre>)` };
    if (!entrada || typeof entrada !== 'object') return { ok: false, motivo: `el rol "${rol}" no es un objeto` };
    const { motor, modelo = null, esfuerzo = null, cuenta = null } = entrada;
    if (!Object.prototype.hasOwnProperty.call(MODELO_OBLIGATORIO, motor)) {
      return { ok: false, motivo: `el rol "${rol}" pide un motor desconocido "${motor}" (válidos: ${Object.keys(MODELO_OBLIGATORIO).join(', ')})` };
    }
    if (modelo !== null && (typeof modelo !== 'string' || !RE_MODELO.test(modelo))) {
      return { ok: false, motivo: `el rol "${rol}" trae un modelo inválido` };
    }
    // BE-045 — En los dos modos, como un modelo inválido: todo o nada.
    const bloqueado = modeloBloqueado(motor, modelo);
    if (bloqueado) return { ok: false, motivo: `el rol "${rol}": ${bloqueado}` };
    if (MODELO_OBLIGATORIO[motor] && !modelo) {
      return { ok: false, motivo: `el rol "${rol}" usa ${motor}, que exige \`modelo\`` };
    }
    if (cuenta !== null) {
      if (typeof cuenta !== 'string' || !RE_CUENTA.test(cuenta)) return { ok: false, motivo: `el rol "${rol}" trae una cuenta inválida` };
      if (!CON_CUENTA.has(motor)) return { ok: false, motivo: `el rol "${rol}": \`cuenta\` solo aplica al motor claude` };
      if (cuentas && !cuentas.includes(cuenta)) {
        return { ok: false, motivo: `el rol "${rol}" usa la cuenta "${cuenta}", que no está en \`motores.cuentas\`` };
      }
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
    if (cuenta !== null) salida[rol].cuenta = cuenta;
  }
  return { ok: true, roles: salida, avisos };
}

/** `motores.claude.bin`: una ruta (string no vacío) o `null`. */
function validarBin(bin) {
  if (bin === undefined || bin === null) return { ok: true, bin: null };
  if (typeof bin !== 'string' || !bin.trim()) return { ok: false, motivo: '`motores.claude.bin` tiene que ser una ruta o null' };
  return { ok: true, bin: bin.trim() };
}

module.exports = {
  ROLES_BASE, MODELO_OBLIGATORIO, ESFUERZOS, RE_ALMA, RE_CONSOLIDAR, RE_CUENTA,
  rolValido, validarRoles, validarBin, validarCuentas, claveDeCuenta
};
