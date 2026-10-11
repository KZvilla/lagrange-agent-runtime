/*
 * FEAT-156 — La barra lateral de Pipelines (L1): batches por estado, drafts y recipes en secciones. Lo que espera de
 * vos y lo que corre no se pliega; el resto se pliega con un clic en la cabecera (se recuerda en este navegador).
 * Recipes muestra las primeras 5 y «ver todas». La barra tiene su propio scroll (app.css): nunca empuja el lienzo.
 */
import { useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { persistente } from './persistencia.js';
import { Marca, estadoDeLote } from './tuberias-detalle.js';
import { borradoresTub, borradorElegido, ElegirBorrador } from './tuberias-borrador.js';
import { recetasTub, recetaEditada } from './tuberias-receta.js';
import { lotesTub, loteElegido, elegirLote, proyectoTub } from './vista-tuberias.js';
import { MenuReceta, DialogoReceta } from './tuberias-receta-acciones.js';

const ACTIVOS = ['corriendo', 'verificando', 'auditando'];
const ESPERAN = ['para revisar', 'esperando humano'];
const ETAPAS = ['escribir', 'verificar', 'auditar', 'revision'];
const RECETAS_VISIBLES = 5;
const PLEGABLES = ['borradores', 'terminados', 'recetas'];
const plegadas = persistente('tuberias.plegadas', {}, { validar: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => PLEGABLES.includes(k)) });

function ItemLote({ l }) {
  const elegido = !borradorElegido.value && !recetaEditada.value && loteElegido.value === l.id;
  const [estado, texto] = estadoDeLote(l.estado);
  return html`<li><button type="button" class=${`tub-lote${elegido ? ' elegido' : ''}`} aria-pressed=${String(elegido)} onClick=${() => elegirLote(l.id)}>
    <span class="tub-lote-fila"><span class=${`recorte${l.titulo ? '' : ' mono'}`} title=${l.id}>${l.titulo || l.id}</span><span class="derecha"><${Marca} estado=${estado} texto=${estado === 'esperando' ? 'tu turno' : texto} /></span></span>
    ${l.resumen ? html`<span class="tub-barrita" aria-label=${`Etapas: ${ETAPAS.map((e) => `${e} ${l.resumen[e] || 'pendiente'}`).join(', ')}`}>${ETAPAS.map((e) => html`<i key=${e} class=${`tub-est-${l.resumen[e] || 'pendiente'}`} title=${`${e}: ${l.resumen[e] || 'pendiente'}`}></i>`)}</span>` : null}
    <span class="tub-lote-sub">${l.workspace?.nombre || '—'} · ${l.tareas.length} tarea${l.tareas.length === 1 ? '' : 's'}</span>
  </button></li>`;
}

/** Una sección: cabecera con su cantidad; las plegables se abren y cierran con un clic. */
function Seccion({ id, titulo, n, children }) {
  if (!n) return null;
  const plegable = PLEGABLES.includes(id);
  const abierta = !plegable || !plegadas.value[id];
  const alternar = () => { plegadas.value = { ...plegadas.value, [id]: abierta }; };
  return html`<section class="tub-seccion" aria-label=${titulo}>
    ${plegable
      ? html`<h2 class="tub-grupo"><button type="button" class="tub-grupo-boton" aria-expanded=${String(abierta)} onClick=${alternar}>
          <span aria-hidden="true">${abierta ? '▾' : '▸'}</span> ${titulo} <span class="tub-cuenta">${n}</span></button></h2>`
      : html`<h2 class="tub-grupo"><span class="tub-grupo-fijo">${titulo} <span class="tub-cuenta">${n}</span></span></h2>`}
    ${abierta ? children : null}
  </section>`;
}

/** FEAT-149 F3 — Las recipes: elegir una abre el editor. FEAT-156 — «⋯» (o clic derecho): editar, duplicar, renombrar, borrar. */
function ListaRecetas() {
  const [todas, setTodas] = useState(false);
  const [menu, setMenu] = useState(null);
  const [dialogo, setDialogo] = useState(null);
  // Las propias primero (son las que se usan y se cambian); después las incorporadas.
  const todasR = recetasTub.value?.recetas || [];
  const lista = [...todasR.filter((r) => !r.incorporada), ...todasR.filter((r) => r.incorporada)];
  const visibles = todas ? lista : lista.slice(0, RECETAS_VISIBLES);
  const abrir = (r, e) => { e.preventDefault(); e.stopPropagation(); const c = e.currentTarget.getBoundingClientRect?.(); setMenu({ r, x: e.clientX || c?.left || 0, y: e.clientY || c?.bottom || 0 }); };
  return html`<${Seccion} id="recetas" titulo="Recipes" n=${lista.length}>
    <ul class="tub-lotes">${visibles.map((r) => html`<li key=${r.id} class="tub-receta" onContextMenu=${(e) => abrir(r, e)}>
      <button type="button" class=${`tub-lote${recetaEditada.value?.id === r.id ? ' elegido' : ''}`} title=${r.descripcion || ''} onClick=${() => { recetaEditada.value = { id: r.id, madreId: null }; borradorElegido.value = null; }}>
        <span class="tub-lote-fila"><span class="recorte">${r.titulo}</span><span class="derecha tenue">v${r.version}</span></span>
        <span class="tub-lote-sub">${r.incorporada ? (r.descripcion ? 'plantilla · se duplica para cambiarla' : 'incorporada · se guarda como nueva') : `${r.versiones} versi${r.versiones === 1 ? 'ón' : 'ones'}`}</span></button>
      <button type="button" class="tub-receta-mas" aria-label=${`Acciones de la recipe ${r.titulo}`} aria-haspopup="menu" onClick=${(e) => abrir(r, e)}>⋯</button></li>`)}</ul>
    ${lista.length > RECETAS_VISIBLES ? html`<button type="button" class="enlace tub-ver-todas" onClick=${() => setTodas(!todas)}>${todas ? 'ver menos' : `ver todas (${lista.length})`}</button>` : null}
    ${menu ? html`<${MenuReceta} menu=${menu} alCerrar=${() => setMenu(null)} alDialogo=${setDialogo} />` : null}
    ${dialogo ? html`<${DialogoReceta} d=${dialogo} alCerrar=${() => setDialogo(null)} />` : null}
  <//>`;
}

export function ListaLotes() {
  const r = lotesTub.value;
  if (!r) return html`<p class="tenue">Cargando batches…</p>`;
  if (r.error) return html`<p class="error">${r.error}</p>`;
  const todos = (r.lotes || []).filter((l) => l.estado !== 'descartado');
  const borradores = borradoresTub.value?.borradores || [];
  const proyectos = [...new Set(todos.map((l) => l.workspace?.nombre).filter(Boolean))].sort();
  const visibles = proyectoTub.value ? todos.filter((l) => l.workspace?.nombre === proyectoTub.value) : todos;
  const de = (f) => visibles.filter(f);
  const grupo = (id, titulo, lista) => html`<${Seccion} id=${id} titulo=${titulo} n=${lista.length}><ul class="tub-lotes">${lista.map((l) => html`<${ItemLote} key=${l.id} l=${l} />`)}</ul><//>`;
  return html`
    ${proyectos.length > 1 ? html`<label class="tub-filtro">
      <select aria-label="Filtrar por proyecto" value=${proyectoTub.value} onChange=${(ev) => { proyectoTub.value = ev.currentTarget.value; }}>
        <option value="">Todos los proyectos</option>${proyectos.map((p) => html`<option value=${p}>${p}</option>`)}
      </select></label>` : null}
    ${!todos.length && !borradores.length ? html`<p class="tenue">Todavía no hay batches. Se preparan desde una tarjeta madre con hijas.</p>` : null}
    ${grupo('esperan', 'Esperan tu decisión', de((l) => ESPERAN.includes(l.estado)))}
    ${grupo('curso', 'En curso', de((l) => ACTIVOS.includes(l.estado)))}
    <${Seccion} id="borradores" titulo="Drafts" n=${borradores.length}><ul class="tub-lotes">${borradores.map((b) => html`<${ElegirBorrador} key=${b.madreId} b=${b} />`)}</ul><//>
    ${grupo('terminados', 'Terminados', de((l) => !ESPERAN.includes(l.estado) && !ACTIVOS.includes(l.estado)))}
    <${ListaRecetas} />`;
}
