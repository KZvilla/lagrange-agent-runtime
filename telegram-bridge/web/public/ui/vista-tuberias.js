/*
 * FEAT-148 — Vista «Tuberías»: la lista de lotes y, al lado, el grafo vivo de la
 * tubería del elegido, con su cabecera de acciones, el inspector del nodo y la tabla
 * de tareas (G2.5, en tuberias-detalle.js).
 *
 * El grafo es la isla en TypeScript (telegram-bridge/web/grafo/ → vendor/grafo.module.js),
 * que monta `tuberias-lienzo.js` (con la disposición de FEAT-150). Esta vista trae los datos (sondeo, como el
 * tablero: los archivos de lote no avisan por SSE) y la isla los pinta. Ni una ni
 * otra derivan estados: los manda `tuberia` (proyectarTuberia, en el servidor).
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api } from './nucleo.js';
import { persistente } from './persistencia.js';
import { CabeceraLote, Inspector, TablaTareas, Marca, estadoDeLote } from './tuberias-detalle.js';
import { borradoresTub, cargarBorradores, borradorDe, propsBorrador, notasBorrador, CabeceraBorrador, TablaBorrador, borradorElegido, ElegirBorrador } from './tuberias-borrador.js';
import { InspectorBorrador } from './tuberias-borrador-inspector.js';
import { notasDeGrafo } from './tuberias-grafo.js';
import { notasDeConfiguracion, recetasTub, recetaEditada } from './tuberias-receta.js';
import { Lienzo, Cajon, propsDisposicion } from './tuberias-lienzo.js';
import { VistaEditor } from './tuberias-editor.js';
import { EsperasHumanas } from './tuberias-humano.js';

const SONDEO_MS = 10_000;
const ACTIVOS = ['corriendo', 'verificando', 'auditando'];
// F4b — Te esperan: la revisión final, o una tarea a mitad de camino.
const ESPERAN = ['para revisar', 'esperando humano'];
const ID_VALIDO = /^[A-Za-z0-9._-]{1,120}$/;
const ETAPAS = ['escribir', 'verificar', 'auditar', 'revision'];

/** Lista de lotes (`{ lotes }` | `{ error }`) y el detalle del elegido (`{ lote }` | `{ error }`). */
export const lotesTub = signal(null);
const detalleTub = signal(null);
/** El nodo elegido en el grafo (o null): abre el inspector. */
const etapaElegida = signal(null);
/** FEAT-149 F2 — La tarea elegida en el reloj: resalta su fila y su cable de vuelta. */
const tareaElegida = signal(null);
/** El lote elegido y el filtro por proyecto se recuerdan por dispositivo (FEAT-136). */
export const loteElegido = persistente('tuberias.lote', null, { validar: (v) => v === null || (typeof v === 'string' && ID_VALIDO.test(v)) });
const proyectoTub = persistente('tuberias.proyecto', '', { validar: (v) => typeof v === 'string' && v.length <= 200 });

/** Para el enlace «Ver en Tuberías» del tablero: deja elegido el lote antes de navegar. */
export function elegirLote(id) {
  if (typeof id === 'string' && ID_VALIDO.test(id)) { loteElegido.value = id; borradorElegido.value = null; recetaEditada.value = null; }
}

/** G3 — Para «Preparar en Tuberías» del tablero: abre el borrador de esa tarjeta madre. */
export function elegirBorrador(madreId) {
  if (typeof madreId === 'string' && ID_VALIDO.test(madreId)) { borradorElegido.value = madreId; recetaEditada.value = null; }
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
  const elegido = !borradorElegido.value && !recetaEditada.value && loteElegido.value === l.id;
  const [estado, texto] = estadoDeLote(l.estado);
  return html`<li><button type="button" class=${`tub-lote${elegido ? ' elegido' : ''}`} aria-pressed=${String(elegido)} onClick=${() => elegirLote(l.id)}>
    <span class="tub-lote-fila"><span class=${`recorte${l.titulo ? '' : ' mono'}`} title=${l.id}>${l.titulo || l.id}</span><span class="derecha"><${Marca} estado=${estado} texto=${estado === 'esperando' ? 'tu turno' : texto} /></span></span>
    ${l.resumen ? html`<span class="tub-barrita" aria-label=${`Etapas: ${ETAPAS.map((e) => `${e} ${l.resumen[e] || 'pendiente'}`).join(', ')}`}>${ETAPAS.map((e) => html`<i key=${e} class=${`tub-est-${l.resumen[e] || 'pendiente'}`} title=${`${e}: ${l.resumen[e] || 'pendiente'}`}></i>`)}</span>` : null}
    <span class="tub-lote-sub">${l.workspace?.nombre || '—'} · ${l.tareas.length} tarea${l.tareas.length === 1 ? '' : 's'}</span>
  </button></li>`;
}

const Grupo = ({ titulo, lista }) => (lista.length
  ? html`<h2 class="tub-grupo">${titulo}</h2><ul class="tub-lotes">${lista.map((l) => html`<${ItemLote} key=${l.id} l=${l} />`)}</ul>`
  : null);

/** FEAT-149 F3 — Las recetas: elegir una abre el editor. */
function ListaRecetas() {
  const lista = recetasTub.value?.recetas || [];
  if (!lista.length) return null;
  return html`<h2 class="tub-grupo">Recetas</h2><ul class="tub-lotes">${lista.map((r) => html`<li key=${r.id}>
    <button type="button" class=${`tub-lote${recetaEditada.value?.id === r.id ? ' elegido' : ''}`} onClick=${() => { recetaEditada.value = { id: r.id, madreId: null }; borradorElegido.value = null; }}>
      <span class="tub-lote-fila"><span class="recorte">${r.titulo}</span><span class="derecha tenue">v${r.version}</span></span>
      <span class="tub-lote-sub">${r.incorporada ? 'incorporada · se guarda como nueva' : `${r.versiones} versi${r.versiones === 1 ? 'ón' : 'ones'}`}</span></button></li>`)}</ul>`;
}

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
    <${Grupo} titulo="Esperan tu decisión" lista=${visibles.filter((l) => ESPERAN.includes(l.estado))} />
    <${Grupo} titulo="En curso" lista=${visibles.filter((l) => ACTIVOS.includes(l.estado))} />
    <${Grupo} titulo="Terminados" lista=${visibles.filter((l) => !ESPERAN.includes(l.estado) && !ACTIVOS.includes(l.estado))} />
    <${ListaRecetas} />`;
}

const alElegir = (id) => { etapaElegida.value = id; };
/** F4a — En un lote de grafo, lo elegido es un nodo (o una arista): el inspector es el de su tipo; una arista solo resalta. */
const ETAPA_DE_TIPO = { entrada: 'entrada', escribir: 'escribir', verificar: 'verificar', juez: 'auditar', revision: 'revision' };
function etapaDe(lote, sel) {
  const g = lote?.tuberia?.configuracion?.grafo;
  if (!sel || !g) return sel;
  return ETAPA_DE_TIPO[g.nodos[sel]?.tipo] || null;
}

/** FEAT-149 — Un panel plegable bajo el lienzo: una línea cerrado, el contenido abierto. */
const Panel = ({ titulo, resumen, children }) => html`<details class="tub-panel" open><summary><b>${titulo}</b><span class="tenue">${resumen}</span></summary>${children}</details>`;

const alLanzado = async (id) => { borradorElegido.value = null; elegirLote(id); await recargar(); };

/** G3 — El borrador: la misma página, con la cabecera, la tabla y el inspector de edición. */
function VistaBorrador({ b }) {
  const sel = etapaElegida.value;
  const v = borradorDe(b).valor;
  const props = { lote: null, tuberia: null, seleccion: sel, alElegir, ...propsBorrador(b, v), notas: notasBorrador(b, v),
    ...propsDisposicion(`${v.receta.id}@v${v.receta.version}`, v.receta.disposicion) };
  return html`<div class="tuberias">
    <aside class="tub-lateral" aria-label="Lotes"><${ListaLotes} /></aside>
    <section class="tub-principal" aria-label="Borrador del lote">
      <${CabeceraBorrador} b=${b} alVolver=${() => { borradorElegido.value = null; }} alLanzado=${alLanzado} />
      <${Lienzo} props=${props} />
      <${Panel} titulo="Tareas" resumen=${`${b.hijas.length} · archivos y prueba vienen de cada tarea`}><${TablaBorrador} b=${b} /><//>
    </section>
    ${sel ? html`<${Cajon}><${InspectorBorrador} b=${b} sel=${sel} alCerrar=${() => alElegir(null)} /><//>` : null}
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
      loteElegido.value = (lista.find((l) => ESPERAN.includes(l.estado)) || lista.find((l) => ACTIVOS.includes(l.estado)) || lista[0]).id;
    }
  }, [lista?.map((l) => l.id).join(',')]);
  useEffect(() => { etapaElegida.value = null; tareaElegida.value = null; cargarDetalleTub(); }, [loteElegido.value]);
  useEffect(() => { etapaElegida.value = null; if (borradorElegido.value) recetaEditada.value = null; }, [borradorElegido.value]);

  if (recetaEditada.value) return html`<${VistaEditor} lateral=${html`<${ListaLotes} />`} />`;
  const b = (borradoresTub.value?.borradores || []).find((x) => x.madreId === borradorElegido.value) || null;
  if (b) return html`<${VistaBorrador} b=${b} />`;

  const d = detalleTub.value;
  const lote = d?.lote && d.lote.id === loteElegido.value ? d.lote : null;
  const sel = lote ? etapaElegida.value : null;
  const props = lote
    ? { lote: { id: lote.id, estado: lote.estado }, tuberia: lote.tuberia || null, nombres: lote.nombres || {}, seleccion: sel, alElegir, ahora: Date.now(),
      tareaElegida: tareaElegida.value, alElegirTarea: (id) => { tareaElegida.value = id; },
      // F4a — Un lote de grafo se ve como grafo, con lo que recorrió cada tarea (y el resaltado de lo elegido).
      ...(lote.tuberia?.configuracion?.grafo ? { grafo: lote.tuberia.configuracion.grafo, vivo: lote.tuberia.vivo || null, resaltar: true, notas: notasDeGrafo(lote.tuberia.configuracion.grafo) }
        : lote.tuberia?.configuracion?.nodos ? { notas: notasDeConfiguracion(lote.tuberia.configuracion) } : {}),
      ...propsDisposicion(`${lote.tuberia?.configuracion?.id || 'clasica'}@v${lote.tuberia?.configuracion?.version || 1}`, lote.tuberia?.configuracion?.disposicion) }
    : { lote: null, tuberia: null, seleccion: null, alElegir, ahora: Date.now() };
  return html`<div class="tuberias">
    <aside class="tub-lateral" aria-label="Lotes">
      <${ListaLotes} />
    </aside>
    <section class="tub-principal" aria-label="Tubería del lote">
      ${lote ? html`<${CabeceraLote} l=${lote} recargar=${recargar} />` : null}
      ${lote ? html`<${EsperasHumanas} l=${lote} recargar=${recargar} />` : null}
      ${d?.error && d.id === loteElegido.value ? html`<p class="error">${d.error}</p>` : null}
      <${Lienzo} props=${props} />
      ${lote ? html`<${Panel} titulo="Tareas" resumen=${`${lote.tareas.length} · receta ${lote.tuberia?.configuracion?.titulo || 'Clásica'}${lote.tuberia?.configuracion?.version ? ` v${lote.tuberia.configuracion.version}` : ''}`}><${TablaTareas} l=${lote} /><//>` : null}
    </section>
    ${lote && etapaDe(lote, sel) ? html`<${Cajon}><${Inspector} l=${lote} sel=${etapaDe(lote, sel)} alCerrar=${() => alElegir(null)} recargar=${recargar} /><//>` : null}
  </div>`;
}
