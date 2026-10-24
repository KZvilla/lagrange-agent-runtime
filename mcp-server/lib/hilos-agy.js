/**
 * FEAT-180 — Qué modelo se le pasa a agy y cuál se muestra cuando se retoma un hilo.
 *
 * agy fija el modelo y el esfuerzo de un hilo en su primer turno e ignora
 * `--model` en un `--conversation` posterior (#274): la salida decía el modelo
 * pedido como si hubiera corrido. Al retomar no se pasa `--model` ni `--effort`;
 * se muestra el que Lagrange registró para ese hilo (`uso_por_hilo`) o
 * «desconocido". Pedir otro modelo para un hilo existente falla antes de lanzar:
 * cambiarlo no existe en agy, y abrir uno nuevo pierde el contexto.
 *
 * Puro: el registro del hilo lo lee quien llama (`almacenUso.leerHilo`).
 */
'use strict';

/**
 * @param {object} p
 * @param {string|null} [p.conversationId]
 * @param {boolean} [p.continueSession]  `-c`: retoma el último hilo sin saber cuál
 * @param {string|null} [p.model]        el `model` del pedido
 * @param {string|null} [p.defaultModel] `config.defaultModel`
 * @param {{ modelo?: string|null, esfuerzo?: string|null }|null} [p.hilo]  lo registrado del hilo
 * @returns {{ retomado: boolean, modeloParaCli: string|null, modeloParaCuota: string|null,
 *   modeloMostrado: string|null, esfuerzoMostrado: string|null, error: string|null }}
 *   El esfuerzo para la CLI lo calcula quien llama, y solo si `!retomado`.
 */
function resolverModeloDeHilo({ conversationId = null, continueSession = false, model = null, defaultModel = null, hilo = null } = {}) {
  if (!conversationId && !continueSession) {
    const m = model || defaultModel || null;
    return { retomado: false, modeloParaCli: m, modeloParaCuota: m, modeloMostrado: m, esfuerzoMostrado: null, error: null };
  }
  const registrado = (hilo && hilo.modelo) || null;
  const esfuerzoMostrado = (hilo && hilo.esfuerzo) || null;
  const base = { retomado: true, modeloParaCli: null, modeloParaCuota: null, modeloMostrado: registrado, esfuerzoMostrado, error: null };
  if (continueSession && !conversationId) {
    if (model) {
      return { ...base, error: 'continue_session no puede cambiar el modelo: agy conserva el del hilo y ignora --model. '
        + 'Retomalo por conversation_id sin model, o abrí un hilo nuevo con ese modelo y pasale un resumen.' };
    }
    // `-c` no sabe qué hilo retoma hasta que agy responde: sin grupo para el preflight.
    return { ...base, modeloMostrado: null, esfuerzoMostrado: null };
  }
  if (model && model !== registrado) {
    const tiene = registrado ? `nació con ${registrado}` : 'tiene un modelo que Lagrange no registró';
    return { ...base, error: `El hilo ${conversationId} ${tiene}; agy ignora --model al retomarlo, así que no se puede pasar a ${model}. `
      + `Opciones: seguí sin model (con el modelo del hilo), o abrí un hilo nuevo con ${model} y pasale un resumen de lo hecho (el contexto del hilo no viaja).` };
  }
  return { ...base, modeloParaCuota: registrado };
}

/** Las líneas de la salida que dicen con qué modelo corrió: `Model:` en un hilo nuevo, `Thread model:` al retomar. */
function lineasDeModelo(r, { esfuerzo = null } = {}) {
  if (!r.retomado) return { modelo: r.modeloMostrado, esfuerzo };
  return {
    hilo: true,
    modelo: r.modeloMostrado || 'unknown (created before Lagrange recorded it)',
    esfuerzo: r.esfuerzoMostrado || (r.modeloMostrado ? 'default' : 'unknown')
  };
}

module.exports = { resolverModeloDeHilo, lineasDeModelo };
