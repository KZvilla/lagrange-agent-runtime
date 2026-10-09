/*
 * FEAT-148 G2 — Vista «Tuberías»: la lista de lotes y, al lado, el grafo vivo de
 * la tubería del elegido.
 *
 * El grafo es la isla en TypeScript (telegram-bridge/web/grafo/ → vendor/grafo.module.js),
 * que se carga con import dinámico solo al entrar acá. Contrato:
 * `montar(el, props) → { actualizar(props), desmontar() }`. Esta vista trae los datos
 * (sondeo, como el tablero: los archivos de lote no avisan por SSE) y la isla los pinta.
 * Ni una ni otra derivan estados: los manda `tuberia` (proyectarTuberia, en el servidor).
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api } from './nucleo.js';
import { persistente } from './persistencia.js';

const SONDEO_MS = 10_000;
const ACTIVOS = ['corriendo', 'verificando', 'auditando'];
const ID_VALIDO = /^[A-Za-z0-9._-]{1,120}$/;

/** Lista de lotes (`{ lotes }` | `{ error }`) y el detalle del elegido (`{ lote }` | `{ error }`). */
export const lotesTub = signal(null);
const detalleTub = signal(null);
/** El lote elegido se recuerda por dispositivo (FEAT-136). */
export const loteElegido = persistente('tuberias.lote', null, { validar: (v) => v === null || (typeof v === 'string' && ID_VALIDO.test(v)) });

/** Para el enlace «Ver en Tuberías» del tablero: deja elegido el lote antes de navegar. */
export function elegirLote(id) {
  if (typeof id === 'string' && ID_VALIDO.test(id)) loteElegido.value = id;
}

let isla = null;
function cargarIsla() {
  if (!document.querySelector('link[data-grafo]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/grafo.css';
    css.dataset.grafo = '';
    document.head.append(css);
  }
  isla ??= import('../vendor/grafo.module.js').catch((err) => { isla = null; throw err; });
  return isla;
}

export async function cargarLotesTub() {
  try { lotesTub.value = await api('/api/lotes', undefined, { cache: 'no-store' }); }
  catch (err) { lotesTub.value = { error: err.message }; }
}

async function cargarDetalleTub() {
  const id = loteElegido.value;
  if (!id) { detalleTub.value = null; return; }
  try { detalleTub.value = await api(`/api/lotes/${encodeURIComponent(id)}`, undefined, { cache: 'no-store' }); }
  catch (err) { detalleTub.value = { error: err.message, id }; }
}

function ItemLote({ l }) {
  const activo = ACTIVOS.includes(l.estado);
  const elegido = loteElegido.value === l.id;
  return html`<li><button type="button" class=${`tub-lote${elegido ? ' elegido' : ''}`} aria-pressed=${String(elegido)} onClick=${() => { loteElegido.value = l.id; }}>
    <span class="tub-lote-fila"><span class=${`tub-lote-punto ${activo ? 'en-curso' : l.estado === 'integrado' || l.estado === 'para revisar' ? 'bien' : 'mal'}`} aria-hidden="true"></span><span class="mono recorte">${l.id}</span></span>
    <span class="tub-lote-sub">${l.workspace?.nombre || '—'} · ${l.estado} · ${l.tareas.length} tarea${l.tareas.length === 1 ? '' : 's'}</span>
  </button></li>`;
}

function ListaLotes() {
  const r = lotesTub.value;
  if (!r) return html`<p class="tenue">Cargando lotes…</p>`;
  if (r.error) return html`<p class="error">${r.error}</p>`;
  const visibles = (r.lotes || []).filter((l) => l.estado !== 'descartado');
  if (!visibles.length) return html`<p class="tenue">Todavía no hay lotes. Se lanzan desde una tarjeta madre del tablero.</p>`;
  const enCurso = visibles.filter((l) => ACTIVOS.includes(l.estado));
  const resto = visibles.filter((l) => !ACTIVOS.includes(l.estado));
  return html`
    ${enCurso.length ? html`<h2 class="tub-grupo">En curso</h2><ul class="tub-lotes">${enCurso.map((l) => html`<${ItemLote} key=${l.id} l=${l} />`)}</ul>` : null}
    ${resto.length ? html`<h2 class="tub-grupo">Terminados</h2><ul class="tub-lotes">${resto.map((l) => html`<${ItemLote} key=${l.id} l=${l} />`)}</ul>` : null}`;
}

function Lienzo({ props }) {
  const nodo = useRef(null);
  const instancia = useRef(null);
  // Los últimos datos: si cambian mientras la isla carga, se monta con estos y no con los del primer pintado.
  const ultimos = useRef(props);
  ultimos.current = props;
  const [fallo, setFallo] = useState(null);
  useEffect(() => {
    let vivo = true;
    cargarIsla().then((m) => {
      if (!vivo || !nodo.current) return;
      instancia.current = m.montar(nodo.current, ultimos.current);
    }, (err) => { if (vivo) setFallo(err.message || String(err)); });
    return () => { vivo = false; instancia.current?.desmontar(); instancia.current = null; };
  }, []);
  useEffect(() => { instancia.current?.actualizar(props); }, [props]);
  if (fallo) return html`<p class="error">No se pudo cargar el grafo: ${fallo}. Recargá la página.</p>`;
  return html`<div class="tub-isla" ref=${nodo}></div>`;
}

export function VistaTuberias() {
  useEffect(() => {
    cargarLotesTub();
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      cargarLotesTub();
      cargarDetalleTub();
    }, SONDEO_MS);
    return () => clearInterval(id);
  }, []);
  // Sin elección (o con un lote que ya no está), el primero en curso o, si no hay, el más reciente.
  const lista = lotesTub.value?.lotes?.filter((l) => l.estado !== 'descartado') || null;
  useEffect(() => {
    if (!lista || !lista.length) return;
    if (!lista.some((l) => l.id === loteElegido.value)) loteElegido.value = (lista.find((l) => ACTIVOS.includes(l.estado)) || lista[0]).id;
  }, [lista?.map((l) => l.id).join(',')]);
  useEffect(() => { cargarDetalleTub(); }, [loteElegido.value]);

  const d = detalleTub.value;
  const lote = d?.lote && d.lote.id === loteElegido.value ? d.lote : null;
  const props = lote ? { lote: { id: lote.id, estado: lote.estado }, tuberia: lote.tuberia || null } : { lote: null, tuberia: null };
  return html`<div class="tuberias">
    <aside class="tub-lateral" aria-label="Lotes">
      <${ListaLotes} />
    </aside>
    <section class="tub-principal" aria-label="Tubería del lote">
      ${lote ? html`<header class="tub-cabecera"><h1 class="mono">${lote.id}</h1><span class="tenue">${lote.workspace?.nombre || ''} · ${lote.estado}</span></header>` : null}
      ${d?.error && d.id === loteElegido.value ? html`<p class="error">${d.error}</p>` : null}
      <${Lienzo} props=${props} />
    </section>
  </div>`;
}
