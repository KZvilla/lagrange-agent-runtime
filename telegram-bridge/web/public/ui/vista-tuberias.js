/*
 * FEAT-148 — Vista «Tuberías»: la lista de lotes y, al lado, el grafo vivo de la
 * tubería del elegido, con su cabecera de acciones, el inspector del nodo y la tabla
 * de tareas (G2.5, en tuberias-detalle.js).
 *
 * El grafo es la isla en TypeScript (telegram-bridge/web/grafo/ → vendor/grafo.module.js),
 * que se carga con import dinámico solo al entrar acá. Contrato:
 * `montar(el, props) → { actualizar(props), desmontar() }`; la isla avisa con
 * `alElegir(id)` qué nodo se eligió. Esta vista trae los datos (sondeo, como el
 * tablero: los archivos de lote no avisan por SSE) y la isla los pinta. Ni una ni
 * otra derivan estados: los manda `tuberia` (proyectarTuberia, en el servidor).
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api } from './nucleo.js';
import { persistente } from './persistencia.js';
import { CabeceraLote, Inspector, TablaTareas, Marca, estadoDeLote } from './tuberias-detalle.js';
import { borradoresTub, cargarBorradores, borradorDe, propsBorrador, CabeceraBorrador, TablaBorrador, InspectorBorrador, borradorElegido, ElegirBorrador } from './tuberias-borrador.js';

const SONDEO_MS = 10_000;
const ACTIVOS = ['corriendo', 'verificando', 'auditando'];
const ID_VALIDO = /^[A-Za-z0-9._-]{1,120}$/;
const ETAPAS = ['escribir', 'verificar', 'auditar', 'revision'];

/** Lista de lotes (`{ lotes }` | `{ error }`) y el detalle del elegido (`{ lote }` | `{ error }`). */
export const lotesTub = signal(null);
const detalleTub = signal(null);
/** El nodo elegido en el grafo (o null): abre el inspector. */
const etapaElegida = signal(null);
/** El lote elegido y el filtro por proyecto se recuerdan por dispositivo (FEAT-136). */
export const loteElegido = persistente('tuberias.lote', null, { validar: (v) => v === null || (typeof v === 'string' && ID_VALIDO.test(v)) });
const proyectoTub = persistente('tuberias.proyecto', '', { validar: (v) => typeof v === 'string' && v.length <= 200 });

/** Para el enlace «Ver en Tuberías» del tablero: deja elegido el lote antes de navegar. */
export function elegirLote(id) {
  if (typeof id === 'string' && ID_VALIDO.test(id)) { loteElegido.value = id; borradorElegido.value = null; }
}

/** G3 — Para «Preparar en Tuberías» del tablero: abre el borrador de esa tarjeta madre. */
export function elegirBorrador(madreId) {
  if (typeof madreId === 'string' && ID_VALIDO.test(madreId)) borradorElegido.value = madreId;
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

/** Después de una acción: la vista se pone al día sin esperar al sondeo. */
const recargar = () => Promise.all([cargarLotesTub(), cargarDetalleTub(), cargarBorradores()]);

function ItemLote({ l }) {
  const elegido = !borradorElegido.value && loteElegido.value === l.id;
  const [estado, texto] = estadoDeLote(l.estado);
  return html`<li><button type="button" class=${`tub-lote${elegido ? ' elegido' : ''}`} aria-pressed=${String(elegido)} onClick=${() => { loteElegido.value = l.id; borradorElegido.value = null; }}>
    <span class="tub-lote-fila"><span class=${`recorte${l.titulo ? '' : ' mono'}`} title=${l.id}>${l.titulo || l.id}</span><span class="derecha"><${Marca} estado=${estado} texto=${estado === 'esperando' ? 'tu turno' : texto} /></span></span>
    ${l.resumen ? html`<span class="tub-barrita" aria-label=${`Etapas: ${ETAPAS.map((e) => `${e} ${l.resumen[e] || 'pendiente'}`).join(', ')}`}>${ETAPAS.map((e) => html`<i key=${e} class=${`tub-est-${l.resumen[e] || 'pendiente'}`} title=${`${e}: ${l.resumen[e] || 'pendiente'}`}></i>`)}</span>` : null}
    <span class="tub-lote-sub">${l.workspace?.nombre || '—'} · ${l.tareas.length} tarea${l.tareas.length === 1 ? '' : 's'}</span>
  </button></li>`;
}

const Grupo = ({ titulo, lista }) => (lista.length
  ? html`<h2 class="tub-grupo">${titulo}</h2><ul class="tub-lotes">${lista.map((l) => html`<${ItemLote} key=${l.id} l=${l} />`)}</ul>`
  : null);

function ListaLotes() {
  const r = lotesTub.value;
  if (!r) return html`<p class="tenue">Cargando lotes…</p>`;
  if (r.error) return html`<p class="error">${r.error}</p>`;
  const todos = (r.lotes || []).filter((l) => l.estado !== 'descartado');
  const borradores = borradoresTub.value?.borradores || [];
  if (!todos.length && !borradores.length) return html`<p class="tenue">Todavía no hay lotes. Se preparan desde una tarjeta madre con hijas.</p>`;
  const proyectos = [...new Set(todos.map((l) => l.workspace?.nombre).filter(Boolean))].sort();
  const visibles = proyectoTub.value ? todos.filter((l) => l.workspace?.nombre === proyectoTub.value) : todos;
  return html`
    ${proyectos.length > 1 ? html`<label class="tub-filtro">
      <select aria-label="Filtrar por proyecto" value=${proyectoTub.value} onChange=${(ev) => { proyectoTub.value = ev.currentTarget.value; }}>
        <option value="">Todos los proyectos</option>${proyectos.map((p) => html`<option value=${p}>${p}</option>`)}
      </select></label>` : null}
    ${borradores.length ? html`<h2 class="tub-grupo">Borradores</h2><ul class="tub-lotes">${borradores.map((b) => html`<${ElegirBorrador} key=${b.madreId} b=${b} />`)}</ul>` : null}
    <${Grupo} titulo="Esperan tu decisión" lista=${visibles.filter((l) => l.estado === 'para revisar')} />
    <${Grupo} titulo="En curso" lista=${visibles.filter((l) => ACTIVOS.includes(l.estado))} />
    <${Grupo} titulo="Terminados" lista=${visibles.filter((l) => l.estado !== 'para revisar' && !ACTIVOS.includes(l.estado))} />`;
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

const alElegir = (id) => { etapaElegida.value = id; };

const alLanzado = async (id) => { borradorElegido.value = null; elegirLote(id); await recargar(); };

/** G3 — El borrador: la misma página, con la cabecera, la tabla y el inspector de edición. */
function VistaBorrador({ b }) {
  const sel = etapaElegida.value;
  const props = { lote: null, tuberia: null, seleccion: sel, alElegir, borrador: propsBorrador(b, borradorDe(b).valor) };
  return html`<div class="tuberias">
    <aside class="tub-lateral" aria-label="Lotes"><${ListaLotes} /></aside>
    <section class="tub-principal" aria-label="Borrador del lote">
      <${CabeceraBorrador} b=${b} alVolver=${() => { borradorElegido.value = null; }} alLanzado=${alLanzado} />
      <${Lienzo} props=${props} />
      <${TablaBorrador} b=${b} />
    </section>
    ${sel ? html`<${InspectorBorrador} b=${b} sel=${sel} alCerrar=${() => alElegir(null)} />` : null}
  </div>`;
}

export function VistaTuberias() {
  useEffect(() => {
    const pedido = new URLSearchParams(location.search).get('borrador');
    if (pedido) elegirBorrador(pedido);
    cargarLotesTub();
    cargarBorradores();
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      cargarLotesTub();
      cargarDetalleTub();
      cargarBorradores();
    }, SONDEO_MS);
    return () => clearInterval(id);
  }, []);
  // Sin elección (o con un lote que ya no está), el primero que espera tu decisión, si no el primero en curso, si no el más reciente.
  const lista = lotesTub.value?.lotes?.filter((l) => l.estado !== 'descartado') || null;
  useEffect(() => {
    if (!lista || !lista.length) return;
    if (!lista.some((l) => l.id === loteElegido.value)) {
      loteElegido.value = (lista.find((l) => l.estado === 'para revisar') || lista.find((l) => ACTIVOS.includes(l.estado)) || lista[0]).id;
    }
  }, [lista?.map((l) => l.id).join(',')]);
  useEffect(() => { etapaElegida.value = null; cargarDetalleTub(); }, [loteElegido.value]);
  useEffect(() => { etapaElegida.value = null; }, [borradorElegido.value]);

  const b = (borradoresTub.value?.borradores || []).find((x) => x.madreId === borradorElegido.value) || null;
  if (b) return html`<${VistaBorrador} b=${b} />`;

  const d = detalleTub.value;
  const lote = d?.lote && d.lote.id === loteElegido.value ? d.lote : null;
  const sel = lote ? etapaElegida.value : null;
  const props = lote
    ? { lote: { id: lote.id, estado: lote.estado }, tuberia: lote.tuberia || null, nombres: lote.nombres || {}, seleccion: sel, alElegir, ahora: Date.now() }
    : { lote: null, tuberia: null, seleccion: null, alElegir, ahora: Date.now() };
  return html`<div class="tuberias">
    <aside class="tub-lateral" aria-label="Lotes">
      <${ListaLotes} />
    </aside>
    <section class="tub-principal" aria-label="Tubería del lote">
      ${lote ? html`<${CabeceraLote} l=${lote} recargar=${recargar} />` : null}
      ${d?.error && d.id === loteElegido.value ? html`<p class="error">${d.error}</p>` : null}
      <${Lienzo} props=${props} />
      ${lote ? html`<${TablaTareas} l=${lote} />` : null}
    </section>
    ${lote && sel ? html`<${Inspector} l=${lote} sel=${sel} alCerrar=${() => alElegir(null)} recargar=${recargar} />` : null}
  </div>`;
}
