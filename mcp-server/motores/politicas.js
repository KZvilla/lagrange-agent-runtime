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
 *
 * FEAT-074 — La cuota de agy viene por grupo (`grupos.gemini`,
 * `grupos.claude_gpt`). Si el motor declara `grupoDeCuota(pedido)`, se mira
 * ese grupo; sin grupo (agy elige el modelo), el más gastado de los dos. Un
 * dato por grupo de más de 6 h no frena: frenar con un dato de ayer es peor que
 * no frenar.
 *
 * FEAT-085 — Con `cuenta` en el pedido, la cuota que se mira es la de esa
 * cuenta (`claude@trabajo`); el umbral, el del motor. Frenar detiene el rol:
 * nunca lo pasa a otra cuenta.
 */

const { claveDeCuenta } = require('./roles.js');

const ORIGENES = ['usuario', 'programado', 'fondo', 'orquestador'];
const CUOTA_VIEJA_MS = 6 * 60 * 60 * 1000;

function origenDe(pedido) {
  return pedido && ORIGENES.includes(pedido.origen) ? pedido.origen : 'usuario';
}

/** `{ ok: true }` o `{ ok: false, motivo }`. `contexto` trae `config` y `leerCuota` si el llamador los tiene. */
/**
 * La ventana de 5 h que decide el freno: `{ uso, resetea, grupo }` o `null`.
 * Sin `grupos`, la de siempre (`cuota.ventana_5h`, BE-039).
 */
function ventanaDelFreno(motor, pedido, cuota, ahora = Date.now()) {
  if (!cuota || typeof cuota !== 'object') return null;
  if (!cuota.grupos || typeof cuota.grupos !== 'object') {
    return Number.isFinite(cuota.ventana_5h) ? { uso: cuota.ventana_5h, resetea: cuota.resetea_5h || null, grupo: null } : null;
  }
  const visto = Date.parse(cuota.visto_en || '');
  if (!Number.isFinite(visto) || ahora - visto > CUOTA_VIEJA_MS) return null;
  const grupo = typeof motor.grupoDeCuota === 'function' ? motor.grupoDeCuota(pedido) : null;
  const candidatos = (grupo ? [grupo] : Object.keys(cuota.grupos))
    .map(g => ({ g, v: cuota.grupos[g] }))
    .filter(({ v }) => v && Number.isFinite(v.ventana_5h));
  if (!candidatos.length) return null;
  const peor = candidatos.reduce((a, b) => (b.v.ventana_5h > a.v.ventana_5h ? b : a));
  return { uso: peor.v.ventana_5h, resetea: peor.v.resetea_5h || null, grupo: peor.g };
}

function verificarPoliticas(motor, pedido, { config = null, leerCuota = null, ahora = Date.now() } = {}) {
  if (motor.modeloObligatorio && !(pedido && pedido.modelo)) {
    return {
      ok: false,
      motivo: `el motor ${motor.id} exige un modelo explícito y el pedido no lo trae; no se deja elegir al CLI.`
    };
  }

  const umbral = config && config.motores && config.motores[motor.id] && config.motores[motor.id].freno_cuota_5h;
  if (Number.isFinite(umbral) && umbral >= 0 && umbral <= 1 && origenDe(pedido) !== 'usuario' && typeof leerCuota === 'function') {
    let cuota = null;
    const clave = claveDeCuenta(motor.id, (pedido && pedido.cuenta) || null);
    try { cuota = leerCuota(clave); } catch {}
    const ventana = ventanaDelFreno(motor, pedido, cuota, ahora);
    if (ventana && ventana.uso > umbral) {
      const reinicio = ventana.resetea ? `; se reinicia ${ventana.resetea}` : '';
      const grupo = ventana.grupo ? ` (grupo ${ventana.grupo})` : '';
      return {
        ok: false,
        frenado: true,
        motivo: `freno de cuota de ${clave}${grupo}: la ventana de 5 h va en ${Math.round(ventana.uso * 100)} % `
          + `(umbral ${Math.round(umbral * 100)} %)${reinicio}. Solo pasan los pedidos del usuario.`
      };
    }
  }
  return { ok: true };
}

module.exports = { ORIGENES, CUOTA_VIEJA_MS, origenDe, ventanaDelFreno, verificarPoliticas };
