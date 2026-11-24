/**
 * FEAT-210 — Los códigos de una imagen y sus textos fijos.
 *
 * `CODIGOS_ENTRADA` es el `codigo` de una entrada de `turno.imagenes` en
 * `error`; `MOTIVOS_RECHAZO`, el del pedido rechazado en el turno, antes de que
 * exista la entrada. Los textos son fijos: nunca llevan el error crudo de un
 * proveedor (el de agy trae rutas).
 */

const CODIGOS_ENTRADA = Object.freeze({
  'no-responde': 'no responde',
  'no-implementado': 'todavía no genera imágenes',
  manual: 'está en modo manual',
  cupo: 'se quedó sin cupo',
  tiempo: 'tardó demasiado',
  cancelada: 'Cancelada.',
  'fallo-del-flujo': 'El flujo de ComfyUI falló. Revisá el flujo en Ajustes → Imágenes.',
  error: 'No se pudo hacer la imagen.',
  'cola-llena': 'Ya hay demasiadas imágenes esperando. Probá en un rato.',
  interrumpida: 'Se interrumpió (el daemon se reinició).',
  'sin-proveedor': 'Ningún proveedor pudo hacer la imagen.',
  apagadas: 'Las imágenes están apagadas.',
  'foto-perdida': 'La foto ya no está; mandala de nuevo.'
});

const MOTIVOS_RECHAZO = Object.freeze({
  apagadas: 'las imágenes están apagadas',
  'hilo-externo': 'hilo con contenido externo',
  'una-por-turno': 'una imagen por respuesta',
  'pasada-descartada': 'la pidió junto con una búsqueda',
  aislado: 'un turno aislado no hace imágenes'
});

/** Los nombres legibles de cada proveedor, para los mensajes. */
const NOMBRES = Object.freeze({ comfyui: 'ComfyUI', antigravity: 'agy', openai: 'OpenAI', gemini: 'Gemini' });

/** El mensaje de una entrada en `error`: fijo por código. `sin-proveedor` nombra a cada uno con su motivo. */
function mensajeDe(codigo, { intentos = [] } = {}) {
  if (codigo === 'sin-proveedor' && intentos.length) {
    const partes = intentos.map(({ proveedor, codigo: c }) => `${NOMBRES[proveedor] || proveedor} ${CODIGOS_ENTRADA[c] || CODIGOS_ENTRADA.error}`);
    const texto = partes.join('; ');
    return `${texto.charAt(0).toUpperCase()}${texto.slice(1)}.`.slice(0, 200);
  }
  if (['no-responde', 'no-implementado', 'manual', 'cupo', 'tiempo'].includes(codigo)) {
    return `El proveedor ${CODIGOS_ENTRADA[codigo]}.`;
  }
  return CODIGOS_ENTRADA[codigo] || CODIGOS_ENTRADA.error;
}

/** El texto de un rechazo del pedido. */
function motivoDe(motivo) {
  return MOTIVOS_RECHAZO[motivo] || String(motivo || '');
}

module.exports = { CODIGOS_ENTRADA, MOTIVOS_RECHAZO, NOMBRES, mensajeDe, motivoDe };
