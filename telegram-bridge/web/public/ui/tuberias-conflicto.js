/*
 * FEAT-149 F4c — Un conflicto al juntar las ramas de una tarea (K2/K3): qué ramas se juntaron, cuál chocó, los
 * archivos y, abiertos, sus bloques (lo juntado contra la rama que chocó). Los bloques son texto del repo: van
 * como texto (htm escapa), nunca como HTML.
 */
import { html } from './html.js';

/** El estado de cada rama de la tarea, en una línea: «1 ✓ · 2 ✓ · 3 ✕». */
export function RamasDeTarea({ t }) {
  if (!t.ramas?.length) return null;
  const icono = (r) => (t.juntadas?.includes(r.k) ? '✓' : r.estado === 'cancelada' ? '⊘' : r.estado === 'espera cupo' ? '◷' : r.fin && r.fin !== 'juntar' ? '✕' : r.fin ? '·' : '◐');
  return html`<p class="tub-ramas" aria-label="Ramas de la tarea">${t.ramas.map((r) => html`<span key=${r.k} class="tub-rama" title=${`rama ${r.k}: ${r.estado || '—'}${r.error ? ` · ${r.error}` : ''}`}>${icono(r)} rama ${r.k}</span>`)}</p>`;
}

export function ConflictoJuntar({ t }) {
  const c = t.conflicto;
  if (!c) return null;
  const juntadas = (t.juntadas || []).filter((k) => !c.ramas.includes(k));
  return html`<section class="tub-conflicto" aria-label="Conflicto al juntar">
    <p><b>Conflicto al juntar.</b> ${`${juntadas.length ? `Se juntaron ${juntadas.map((k) => `la ${k}`).join(' y ')}; ` : ''}chocó ${c.ramas.map((k) => `la ${k}`).join(' y ')} en ${c.archivos.length} archivo${c.archivos.length === 1 ? '' : 's'}.`} Nada se escribió en tu rama.</p>
    ${c.aviso ? html`<p class="error">${c.aviso}</p>` : null}
    ${c.archivos.map((a) => {
      const b = (c.bloques || []).find((x) => x.archivo === a);
      return html`<details key=${a} class="tub-conflicto-archivo"><summary class="mono">${a}</summary>
        ${b && b.texto ? html`<pre class="salida-lote">${b.texto}</pre>` : html`<p class="tenue">Sin bloques para mostrar (archivo grande, binario o borrado de un lado).</p>`}</details>`;
    })}
    ${c.carpeta ? html`<p class="tenue">Carpeta de la tarea: <span class="mono">${c.carpeta}</span></p>` : null}
  </section>`;
}
