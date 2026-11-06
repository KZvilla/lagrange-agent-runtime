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

/**
 * FEAT-183 — Qué agente se pasa a agy y qué se muestra al retomar.
 *
 * agy fija el agente de un hilo en su primer turno e ignora `--agent` en un
 * `--conversation` posterior. Por eso al retomar no se pasa `--agent`: la
 * garantía es comparar el agente registrado del hilo. Si el hilo no tiene
 * agente registrado, pedir uno falla cerrado: no se puede verificar.
 */
function resolverAgenteDeHilo({ conversationId = null, continueSession = false, agent = null, hilo = null } = {}) {
  const registrado = (hilo && hilo.agente) || null;
  if (!conversationId && !continueSession) {
    return { agenteParaCli: agent || null, agenteMostrado: agent || null, error: null };
  }
  if (continueSession && !conversationId) {
    if (agent) {
      return {
        agenteParaCli: null, agenteMostrado: null,
        error: 'continue_session no puede cambiar el agente: -c no dice qué hilo retoma hasta que agy responde. '
          + 'Retomalo por conversation_id sin agent, o abrí un hilo nuevo con ese agente y pasale un resumen.'
      };
    }
    return { agenteParaCli: null, agenteMostrado: null, error: null };
  }
  if (!agent) {
    return { agenteParaCli: null, agenteMostrado: registrado, error: null };
  }
  if (!registrado) {
    return {
      agenteParaCli: null, agenteMostrado: null,
      error: `El hilo ${conversationId} no tiene un agente registrado por Lagrange; no se puede verificar que sea "${agent}". `
        + 'Retomalo sin agent, o abrí un hilo nuevo con ese agente y pasale un resumen.'
    };
  }
  if (agent !== registrado) {
    return {
      agenteParaCli: null, agenteMostrado: registrado,
      error: `El hilo ${conversationId} nació con el agente "${registrado}"; agy ignora --agent al retomarlo, `
        + `así que no se puede pasar a "${agent}".`
    };
  }
  return { agenteParaCli: null, agenteMostrado: registrado, error: null };
}

/**
 * BE-178 — El footer de `agy_plan` no debe invitar a retomar en `agy_run` un
 * hilo que nació en el contenedor de solo lectura: ese hilo vive en un volumen
 * Docker y `agy_run` corre en el host. `pie` es la línea de aislamiento que
 * devuelve `ejecutarSoloLectura`.
 */
function lineaDeHiloDePlan({ conversationId = null, pie = '', modoConsulta = false } = {}) {
  if (!conversationId) return '';
  if (modoConsulta) {
    return `\nConversation ID: \`${conversationId}\` (pass as \`conversation_id\` to ask a follow-up)`;
  }
  if (/^Isolation: container/m.test(pie || '')) {
    return `\nConversation ID: \`${conversationId}\` (pass as \`conversation_id\` to refine this plan; `
      + 'to execute it, start a new `agy_run` with the plan text: this thread lives in the container)';
  }
  return `\nConversation ID: \`${conversationId}\` (pass as \`conversation_id\` to refine this plan, or to \`agy_run\` to begin execution)`;
}

module.exports = { resolverModeloDeHilo, resolverAgenteDeHilo, lineasDeModelo, lineaDeHiloDePlan };
