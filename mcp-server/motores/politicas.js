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
 *   2. Freno de cuota, opt-in: con `config.motores[<id>].freno_cuota_5h` (0-1),
 *      si la última utilización vista de la ventana de 5 h lo supera, se
 *      rechazan los pedidos que no inició el usuario. El usuario nunca queda
 *      frenado: un pedido sin `origen` es `usuario`.
 */

const ORIGENES = ['usuario', 'programado', 'fondo', 'orquestador'];

function origenDe(pedido) {
  return pedido && ORIGENES.includes(pedido.origen) ? pedido.origen : 'usuario';
}

/** `{ ok: true }` o `{ ok: false, motivo }`. `contexto` trae `config` y `leerCuota` si el llamador los tiene. */
function verificarPoliticas(motor, pedido, { config = null, leerCuota = null } = {}) {
  if (motor.modeloObligatorio && !(pedido && pedido.modelo)) {
    return {
      ok: false,
      motivo: `el motor ${motor.id} exige un modelo explícito y el pedido no lo trae; no se deja elegir al CLI.`
    };
  }

  const umbral = config && config.motores && config.motores[motor.id] && config.motores[motor.id].freno_cuota_5h;
  if (Number.isFinite(umbral) && umbral >= 0 && umbral <= 1 && origenDe(pedido) !== 'usuario' && typeof leerCuota === 'function') {
    let cuota = null;
    try { cuota = leerCuota(motor.id); } catch {}
    const uso = cuota && Number.isFinite(cuota.ventana_5h) ? cuota.ventana_5h : null;
    if (uso !== null && uso > umbral) {
      const reinicio = cuota.resetea_5h ? `; se reinicia ${cuota.resetea_5h}` : '';
      return {
        ok: false,
        frenado: true,
        motivo: `freno de cuota de ${motor.id}: la ventana de 5 h va en ${Math.round(uso * 100)} % `
          + `(umbral ${Math.round(umbral * 100)} %)${reinicio}. Solo pasan los pedidos del usuario.`
      };
    }
  }
  return { ok: true };
}

module.exports = { ORIGENES, origenDe, verificarPoliticas };
