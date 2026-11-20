/**
 * BE-039 — Políticas comunes a todo motor, que aplica su `preflight` antes de
 * cualquier I/O propio. Viven acá para que un segundo motor (FEAT-072) no las
 * reescriba con otro criterio.
 *
 *   1. Modelo explícito: un motor con `modeloObligatorio` rechaza el pedido sin
 *      `modelo`. El modelo por defecto de cada rol sale de la configuración de
 *      Lagrange, nunca del CLI: sin esto se repite BE-015 (una llamada sin
 *      `--model` corre con lo que el usuario dejó en otra ventana) sobre la
 *      suscripción del usuario.
 *   2. Freno de cuota, opt-in: con `config.motores[<id>].freno_cuota` (0-1),
 *      si la última utilización vista de la ventana lo supera, se rechazan los
 *      pedidos que no inició el usuario. El usuario nunca queda frenado: un
 *      pedido sin `origen` es `usuario`.
 *
 * FEAT-074 — La cuota de agy viene por grupo (`grupos.gemini`,
 * `grupos.claude_gpt`). Si el motor declara `grupoDeCuota(pedido)`, se mira
 * ese grupo; sin grupo (agy elige el modelo), el más gastado.
 *
 * FEAT-085 — Con `cuenta` en el pedido, la cuota que se mira es la de esa
 * cuenta (`claude@trabajo`); el umbral, el del motor. Frenar detiene el rol:
 * nunca lo pasa a otra cuenta.
 *
 * FEAT-202 S4 (D5) — El cupo tiene una forma común (`cupo.js`) y el freno mira
 * la ventana vigente de duración conocida más corta que informe el motor. Una
 * ventana vence cuando pasa su `reinicia` o cuando la lectura es más vieja que
 * la ventana (antes: 6 h fijas para agy). `freno_cuota` vale para todo motor
 * con `cupo: 'ventanas'`; `freno_cuota_5h` se sigue leyendo como alias. Un
 * motor de saldo no tiene freno. El cupo sale de `motor.cupoSinEsperar()` si el
 * motor lo informa por la red (opencode-go, de su caché), o de `leerCuota`.
 */

const { claveDeCuenta } = require('./roles.js');
const cupo = require('./cupo.js');

const ORIGENES = ['usuario', 'programado', 'fondo', 'orquestador'];
/** @deprecated FEAT-202 S4: el freno ya no vence por 6 h fijas. Queda por los lectores viejos. */
const CUOTA_VIEJA_MS = 6 * 60 * 60 * 1000;

function origenDe(pedido) {
  return pedido && ORIGENES.includes(pedido.origen) ? pedido.origen : 'usuario';
}

/** El umbral del freno de un motor (`freno_cuota`, o su alias `freno_cuota_5h`), o `null`. */
function umbralDelFreno(config, motorId) {
  const m = config && config.motores && config.motores[motorId];
  if (!m || typeof m !== 'object') return null;
  const u = m.freno_cuota !== undefined && m.freno_cuota !== null ? m.freno_cuota : m.freno_cuota_5h;
  return Number.isFinite(u) && u >= 0 && u <= 1 ? u : null;
}

/** El cupo con la forma común que mira el freno: el de la caché del motor o el guardado. */
function cupoDelMotor(motor, clave, leerCuota, cupoSinEsperar = null) {
  const deCache = typeof cupoSinEsperar === 'function' ? cupoSinEsperar : motor.cupoSinEsperar;
  if (typeof deCache === 'function') {
    try { return deCache(); } catch { return null; }
  }
  if (typeof leerCuota !== 'function') return null;
  let cuota = null;
  try { cuota = leerCuota(clave); } catch {}
  return cupo.desdeCuotaGuardada(cuota);
}

/**
 * La ventana que decide el freno: `{ uso, resetea, grupo, nombre }` o `null`. `cuota` puede venir con la forma
 * guardada (BE-039, FEAT-074) o con la común.
 */
function ventanaDelFreno(motor, pedido, cuota, ahora = Date.now()) {
  const c = cuota && cuota.tipo === 'ventanas' ? cuota : cupo.desdeCuotaGuardada(cuota);
  const grupo = typeof motor.grupoDeCuota === 'function' ? motor.grupoDeCuota(pedido) : null;
  const v = cupo.ventanaDelFreno(c, { grupo, ahora });
  return v ? { uso: v.usado, resetea: v.reinicia || null, grupo: v.grupo || null, nombre: v.nombre } : null;
}

/** `{ ok: true }` o `{ ok: false, motivo }`. `contexto` trae `config` y `leerCuota` si el llamador los tiene. */
function verificarPoliticas(motor, pedido, { config = null, leerCuota = null, cupoSinEsperar = null, ahora = Date.now() } = {}) {
  if (motor.modeloObligatorio && !(pedido && pedido.modelo)) {
    return {
      ok: false,
      motivo: `el motor ${motor.id} exige un modelo explícito y el pedido no lo trae; no se deja elegir al CLI.`
    };
  }

  const umbral = umbralDelFreno(config, motor.id);
  const conVentanas = !motor.capacidades || motor.capacidades.cupo === 'ventanas';
  if (umbral !== null && conVentanas && origenDe(pedido) !== 'usuario') {
    const clave = claveDeCuenta(motor.id, (pedido && pedido.cuenta) || null);
    const ventana = ventanaDelFreno(motor, pedido, cupoDelMotor(motor, clave, leerCuota, cupoSinEsperar), ahora);
    if (ventana && ventana.uso > umbral) {
      const reinicio = ventana.resetea ? `; se reinicia ${ventana.resetea}` : '';
      const grupo = ventana.grupo ? ` (grupo ${ventana.grupo})` : '';
      const nombre = cupo.NOMBRE_LEGIBLE[ventana.nombre] || ventana.nombre;
      return {
        ok: false,
        frenado: true,
        motivo: `freno de cuota de ${clave}${grupo}: la ventana de ${nombre} va en ${Math.round(ventana.uso * 100)} % `
          + `(umbral ${Math.round(umbral * 100)} %)${reinicio}. Solo pasan los pedidos del usuario.`
      };
    }
  }
  return { ok: true };
}

module.exports = { ORIGENES, CUOTA_VIEJA_MS, origenDe, umbralDelFreno, ventanaDelFreno, verificarPoliticas };
