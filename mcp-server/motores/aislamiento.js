'use strict';

/**
 * FEAT-202 S3 (D2) — El aislamiento es un paso del núcleo, antes de `armar`: `prepararAislamiento(motor, pedido, …)`.
 *
 *   antigravity  lo de siempre (`lib/solo-lectura.js`, `decidir`): con `readonly_isolation`, el pedido `isolation` y la
 *                salud de Docker, contenedor o host. La marca del contenedor (`auto` con la marca puesta no vuelve al
 *                host) y lo que muestra `status` siguen ahí: este paso no la duplica, la consulta.
 *   motores sin `contenedor` (los de API)
 *                la instantánea del árbol de trabajo, siempre, con `deny_paths`. Un `isolation` pedido se rechaza
 *                antes de armar: no hay contenedor ni host a elegir.
 *
 * Devuelve `{ ok: true, modo, denyPaths, aviso }` o `{ ok: false, codigo: 'aislamiento', motivo }`. `modo` es
 * `contenedor`, `host`, `instantanea` o, FEAT-202 S5 (D7), `vivo`: el perfil `edicion` de un motor de API escribe en el
 * árbol vivo, con el confinamiento de `edicion-api.js`.
 */

async function prepararAislamiento(motor, pedido = {}, { config = null, decidir = null, env = process.env, raiz, comprobar } = {}) {
  const caps = (motor && motor.capacidades) || {};
  const denyPaths = Array.isArray(pedido.denyPaths) ? pedido.denyPaths : [];
  if (!caps.contenedor) {
    if (pedido.isolation) {
      return {
        ok: false, codigo: 'aislamiento',
        motivo: `el motor ${motor.id} no corre en contenedor ni en el host (son tools de Node sobre una instantánea), y el rol ${pedido.rol} pidió isolation "${pedido.isolation}": sacá isolation`
      };
    }
    return { ok: true, modo: pedido.perfil === 'edicion' ? 'vivo' : 'instantanea', denyPaths, aviso: null };
  }
  if (typeof decidir !== 'function') return { ok: false, codigo: 'aislamiento', motivo: `falta la decisión de aislamiento de ${motor.id}` };
  const d = await decidir({ config, env, pedido: pedido.isolation, raiz, comprobar });
  if (d.error) return { ok: false, codigo: 'aislamiento', motivo: d.error };
  return { ok: true, modo: d.modo, denyPaths, aviso: d.aviso || null };
}

module.exports = { prepararAislamiento };
