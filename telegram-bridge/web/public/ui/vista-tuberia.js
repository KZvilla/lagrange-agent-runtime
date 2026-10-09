/*
 * FEAT-148 F1 — El diagrama vivo de la tubería de un lote.
 *
 * Dibuja lo que `proyectarTuberia` (mcp-server/lotes/receta-lote.js) ya
 * derivó en el servidor: acá no se calcula ningún estado, solo se pinta.
 * Columnas = etapas de la receta; filas = tareas del lote; la revisión es del
 * lote entero y ocupa todas las filas. Debajo, el historial como log.
 */
import { html } from './html.js';
import { duracion } from './nucleo.js';
import { fechaCorta } from './fechas.js';

const TEXTO_ESTADO = { ok: 'ok', falla: 'falla', corriendo: 'en curso', pendiente: 'pendiente', omitida: 'omitida' };

function actorTexto(actor) {
  if (!actor) return null;
  return [actor.motor, actor.modelo].filter(Boolean).join(' · ') || null;
}

function Celda({ e, fila, columna, filas = 1 }) {
  const estado = e?.estado || 'pendiente';
  const detalle = [
    e?.veredicto,
    e?.salida ? `→ ${e.salida}` : null,
    e?.motivo,
    Number.isFinite(e?.duracionMs) ? duracion(e.duracionMs) : null
  ].filter(Boolean).join(' · ');
  return html`<div class=${`tub-celda tub-${estado}`} style=${`grid-row: ${fila} / span ${filas}; grid-column: ${columna}`}>
    <span class="tub-estado"><span class="tub-punto" aria-hidden="true"></span>${TEXTO_ESTADO[estado] || estado}</span>
    ${actorTexto(e?.actor) ? html`<span class="tub-actor mono">${actorTexto(e.actor)}</span>` : null}
    ${detalle ? html`<span class="tub-detalle">${detalle}</span>` : null}
  </div>`;
}

export function Tuberia({ t }) {
  if (!t || !Array.isArray(t.receta?.etapas)) return null;
  const etapas = t.receta.etapas;
  const tareas = t.tareas || [];
  const filas = Math.max(1, tareas.length);
  const porTarea = etapas.filter((e) => e.id !== 'revision');
  return html`<div class="tuberia">
    <div class="tub-grilla" style=${`grid-template-columns: minmax(72px, auto) repeat(${etapas.length}, minmax(120px, 1fr))`}>
      <div class="tub-cabecera" style="grid-row: 1; grid-column: 1"></div>
      ${etapas.map((e, i) => html`<div key=${e.id} class="tub-cabecera" style=${`grid-row: 1; grid-column: ${i + 2}`}>
        ${e.titulo}${e.id === 'escribir' && Number.isFinite(t.escrituraMs) ? html` <span class="tenue">· ${duracion(t.escrituraMs)}</span>` : null}
        ${i < etapas.length - 1 ? html`<span class="tub-flecha" aria-hidden="true">→</span>` : null}
      </div>`)}
      ${tareas.map((tarea, f) => html`
        <div key=${`n-${tarea.id}`} class="tub-tarea mono recorte" style=${`grid-row: ${f + 2}; grid-column: 1`}>${tarea.id}</div>
        ${porTarea.map((e) => html`<${Celda} key=${`${tarea.id}-${e.id}`} e=${tarea.etapas?.[e.id]} fila=${f + 2} columna=${etapas.indexOf(e) + 2} />`)}`)}
      <${Celda} e=${t.revision} fila=${2} columna=${etapas.length + 1} filas=${filas} />
    </div>
    ${t.historial?.length ? html`<ol class="tub-log">${t.historial.map((h, i) => html`<li key=${i}>
      <span class="mono tenue">${fechaCorta(h.cuando) || h.cuando || '—'}</span> <strong>${h.estado}</strong>${h.motivo ? html` <span class="tenue">· ${h.motivo}</span>` : null}
    </li>`)}</ol>` : null}
  </div>`;
}
