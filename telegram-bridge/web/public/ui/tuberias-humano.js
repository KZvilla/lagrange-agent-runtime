/*
 * FEAT-149 F4b — Las tareas de un lote que esperan tu respuesta (nodo Humano de la receta): qué pasó, qué
 * dijo el Advisor si lo hubo, y tres respuestas. Corregir lleva tus indicaciones al Escribir; aprobar sigue
 * la receta (no cambia el veredicto del Juez); cancelar lleva la tarea a Vos y no se integra. «Seguir
 * esperando» es no responder: la tarea no ocupa contenedor ni cupo. Al responder, el lote se reanuda solo.
 */
import { useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { BotonDosPasos } from './comp-base.js';
import { accionLote } from './lote-acciones.js';
import { ConflictoJuntar, RamasDeTarea } from './tuberias-conflicto.js';

const enc = encodeURIComponent;
const MAX_TEXTO = 4096;
const DECISION = { APPROVE: 'aprobar', REVISE: 'corregir', HUMAN: 'que decidas vos' };
const LISTO = { 'sin-conflictos': 'Seguís sin las ramas que chocaron: el lote se reanuda.', 'resuelto-a-mano': 'Se comprueba tu resolución: el lote se reanuda.' };

function Espera({ l, t, recargar }) {
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const c = t.consejo && t.consejo.nodo ? t.consejo : null;
  const responder = async (accion) => {
    setEnviando(true);
    const r = await accionLote(`/api/lotes/${enc(l.id)}/tareas/${enc(t.id)}/responder`, { accion, ...(accion === 'corregir' ? { texto } : {}) },
      LISTO[accion] || 'Respuesta guardada: el lote se reanuda.');
    setEnviando(false);
    if (r) { setTexto(''); await recargar?.(); }
  };
  const bytes = new TextEncoder().encode(texto).length;
  return html`<article class="tub-espera" aria-label=${`${l.nombres?.[t.id] || t.id} espera tu respuesta`}>
    <div class="tub-fila"><b class="recorte" title=${t.id}>${l.nombres?.[t.id] || t.id}</b><span class="tub-est tub-est-esperando">◷ espera tu respuesta</span></div>
    <${RamasDeTarea} t=${t} />
    <${ConflictoJuntar} t=${t} />
    ${c ? html`<p>El Advisor propone <b>${DECISION[c.decision] || c.decision || '—'}</b>${c.modelo ? html` <span class="tenue">(${c.modelo})</span>` : null}.</p>
      ${c.indicaciones ? html`<pre class="salida-lote">${c.indicaciones}</pre>` : null}` : null}
    <label class="tub-campo"><span>Indicaciones para quien escribe (para corregir)</span>
      <textarea rows="4" maxlength=${MAX_TEXTO} value=${texto} disabled=${enviando} onInput=${(e) => setTexto(e.currentTarget.value)}></textarea></label>
    ${bytes > MAX_TEXTO ? html`<p class="error">Hasta ${MAX_TEXTO} bytes.</p>` : null}
    <div class="tub-fila">
      <button type="button" class="boton primario" data-nivel="ejecutar" disabled=${enviando || !texto.trim() || bytes > MAX_TEXTO} onClick=${() => responder('corregir')}>Corregir</button>
      <button type="button" class="boton" data-nivel="ejecutar" disabled=${enviando} onClick=${() => responder('aprobar')}>Aprobar</button>
      <${BotonDosPasos} clase="boton peligro" data-nivel="ejecutar" texto="Cancelar la tarea" armado="¿Cancelarla? Clic de nuevo" alConfirmar=${() => responder('cancelar')} />
    </div>
    ${t.conflicto ? html`<div class="tub-fila">
      <button type="button" class="boton" data-nivel="ejecutar" disabled=${enviando} onClick=${() => responder('sin-conflictos')}>Seguir sin las ramas que chocaron</button>
      <button type="button" class="boton" data-nivel="ejecutar" disabled=${enviando} onClick=${() => responder('resuelto-a-mano')}>Ya lo resolví</button>
    </div>
    <small class="tenue">«Ya lo resolví»: commiteá en la carpeta de la tarea; se comprueba que no queden marcadores y que solo cambiaste los archivos en conflicto. Las dos siguen a Verificar y al Juez.</small>` : null}
    ${t.humano?.aviso ? html`<p class="error">${t.humano.aviso}</p>` : null}
    <small class="tenue">Aprobar sigue la receta y no cambia el veredicto del Juez. Cancelar la lleva a Vos y no se integra.</small>
  </article>`;
}

export function EsperasHumanas({ l, recargar }) {
  const esperan = (l.tuberia?.tareas || []).filter((t) => t.humano && t.humano.estado === 'esperando');
  // F4c — Un conflicto que está resolviendo un agente (no espera a nadie): se muestra igual, sin botones.
  const resolviendo = (l.tuberia?.tareas || []).filter((t) => t.conflicto && !(t.humano && t.humano.estado === 'esperando'));
  const motivo = l.tuberia?.esperaMotivo;
  if (!esperan.length && !motivo && !resolviendo.length) return null;
  return html`<section class="tub-esperas" aria-label="Tareas que esperan tu respuesta">
    ${motivo ? html`<p class="error">No se pudo reanudar: ${motivo}</p>` : null}
    ${esperan.map((t) => html`<${Espera} key=${t.id} l=${l} t=${t} recargar=${recargar} />`)}
    ${resolviendo.map((t) => html`<article key=${t.id} class="tub-espera"><b class="recorte">${l.nombres?.[t.id] || t.id}</b><${RamasDeTarea} t=${t} /><${ConflictoJuntar} t=${t} /></article>`)}
  </section>`;
}
