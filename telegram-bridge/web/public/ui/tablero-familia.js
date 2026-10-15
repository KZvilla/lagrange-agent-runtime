/*
 * FEAT-160 F2 — La familia de la tarjeta abierta, a la vista.
 *
 *   - `marcasDeFamilia(f, abiertaId, activo)`: un cálculo por render del tablero.
 *     Devuelve `(id) => { clase, marca }`: los miembros llevan `familiar` y una
 *     marca («madre», «1/3»…), la abierta `familiar-abierta`, el resto `atenuada`.
 *     Sin familia, o mientras hay un arrastre (`activo` falso), nada.
 *   - `TiraFamilia`: en el detalle de una tarea, un paso por miembro que abre
 *     ese miembro sin cerrar el detalle, más ‹ › y «n de m». El reloj de lo que
 *     está en curso lo trae `ChipEstado`.
 *
 * No importa vista-tablero.js: lo que necesita de ahí llega por props.
 */
import { html } from './html.js';
import { tituloDe } from './reglas-tablero.js';

const NADA = Object.freeze({ clase: '', marca: null });

/** Lo que se lee en la marca de un miembro: «madre», «partiendo» o «n/m» (sobre las hijas). */
export function textoDeMarca(f, i) {
  const m = f.miembros[i];
  if (i === 0) return 'madre';
  if (m.motivo === 'orquestar') return 'partiendo';
  const hijas = f.miembros.filter((x) => x.motivo === 'hija');
  return `${hijas.indexOf(m) + 1}/${hijas.length}`;
}

/** `(id) => { clase, marca }` para las tarjetas del tablero; la marca es el texto, el componente la dibuja. */
export function marcasDeFamilia(f, abiertaId, activo) {
  if (!f || !activo) return () => NADA;
  const porId = new Map(f.miembros.map((m, i) => [m.id, i]));
  return (id) => {
    if (!porId.has(id)) return { clase: ' atenuada', marca: null };
    return { clase: id === abiertaId ? ' familiar familiar-abierta' : ' familiar', marca: textoDeMarca(f, porId.get(id)) };
  };
}

/** La marca dibujada en la tarjeta: arriba a la derecha, fuera del flujo, solo visual (el dato accesible es la tira). */
export const MarcaFamilia = ({ texto }) => (texto ? html`<span class="marca-familia" aria-hidden="true">${texto}</span>` : null);

/**
 * La tira del detalle. `f` sale de `familiaDe`; `abrir(id)` abre otro miembro;
 * `ChipEstado` es el de vista-tablero.js; `lote` (opcional) es `{ id, estado }`
 * del batch de la madre, que se abre como `c:<id>`.
 */
export function TiraFamilia({ f, abrir, ChipEstado, lote = null }) {
  if (!f) return null;
  const n = f.miembros.length;
  const i = f.indice;
  const ir = (k) => { const m = f.miembros[k]; if (m && !m.ausente) abrir(m.id); };
  const pasos = f.miembros.map((m, k) => {
    const actual = k === i;
    if (m.ausente) {
      return html`<button key=${m.id} type="button" class="paso-familia ausente" disabled>
        <span class="paso-familia-rol">madre</span><span class="paso-familia-titulo">ya no está en el tablero</span></button>`;
    }
    return html`<button key=${m.id} type="button" class=${`paso-familia${actual ? ' actual' : ''}`} aria-current=${actual ? 'true' : null} onClick=${() => ir(k)}>
      <span class="paso-familia-rol">${textoDeMarca(f, k)}</span>
      <span class="paso-familia-titulo">${tituloDe(m)}</span>
      <${ChipEstado} t=${m} chica />
    </button>`;
  });
  return html`<div class="tira-familia">
    <div class="tira-familia-cabecera">
      <span class="tenue">Familia</span>
      <button type="button" class="accion" aria-label="Anterior de la familia" disabled=${i <= 0 || f.miembros[i - 1]?.ausente} onClick=${() => ir(i - 1)}>‹</button>
      <span class="mono tenue">${i + 1} de ${n}</span>
      <button type="button" class="accion" aria-label="Siguiente de la familia" disabled=${i >= n - 1} onClick=${() => ir(i + 1)}>›</button>
    </div>
    <nav aria-label="Familia" class="tira-familia-pasos">${pasos}
      ${lote ? html`<button type="button" class="ficha ficha-id" onClick=${() => abrir(`c:${lote.id}`)}>batch · ${lote.estado || 'sin datos'}</button>` : null}
    </nav>
  </div>`;
}
