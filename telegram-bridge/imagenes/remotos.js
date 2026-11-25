/**
 * FEAT-210 §3 — OpenAI y Gemini: cableados, pero todavía no generan.
 *
 * Tienen su configuración (`url` https, `modelo` y `key_env`, el NOMBRE de la
 * variable del `.env`, que se leería en cada pedido y nunca se guarda) y su
 * validación en `ajustes-imagenes.js`. `generar` devuelve siempre
 * `no-implementado`, y el bucle del orden pasa al siguiente.
 */

export function crearRemoto(id) {
  return {
    id,
    async generar() {
      return { ok: false, codigo: 'no-implementado', proveedor: id, modelo: null };
    }
  };
}
