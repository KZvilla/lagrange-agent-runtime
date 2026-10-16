/**
 * FEAT-160 F4 — La barra de filtros del tablero, en dos niveles (diseño B del
 * lienzo): a la vista la búsqueda, Quién y Proyecto; lo ocasional (Mostrar,
 * Origen, Solo de hoy, Solo archivadas) detrás de «Filtros (n)», y cada filtro
 * escondido que esté activo, también afuera, como pastilla con «×».
 *
 * FEAT-160 F5b — En el teléfono (`enCarrusel`) la barra deja la búsqueda y «Filtros (n)»; Quién, Proyecto y lo
 * del panel van juntos en una hoja inferior, y Quién y Proyecto también cuentan y tienen pastilla.
 *
 * Acá viven el estado persistido (`filtro`, `mostrar`) y lo encontrado
 * (`busqueda`); las reglas son puras (reglas-filtro.js). Solo importa módulos
 * hoja: nunca vista-tablero.js (que lo importa a él).
 */
import { signal, effect } from '../vendor/signals-core.module.js';
import { useState, useEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { Icono } from './comp-base.js';
import { sujetos } from './estado.js';
import { persistente } from './persistencia.js';
import { Hoja, enCarrusel } from './hoja.js';
import { FILTRO_VACIO, MOSTRAR, TEXTO_MOSTRAR, TEXTO_ORIGEN, migrarFiltro, escondidosActivos, hayFiltros } from './reglas-filtro.js';

export const TOPE_BUSQUEDA = 200;
const ICONO_BUSCAR = 'M6 1.8a4.2 4.2 0 1 0 0 8.4a4.2 4.2 0 1 0 0-8.4M9.2 9.2L12.5 12.5';
const ICONO_FILTROS = 'M2 3.5h10M4 7h6M6 10.5h2';

/** Las siete claves de siempre: Desktop valida `tablero.filtro` con esa forma exacta. `mostrar` va aparte. */
export const filtro = persistente('tablero.filtro', FILTRO_VACIO, {
  validar: (v) => v && typeof v === 'object' && typeof v.quien === 'string' && typeof v.q === 'string' && v.q.length <= TOPE_BUSQUEDA
});
export const mostrar = persistente('tablero.mostrar', 'todo', { validar: (v) => MOSTRAR.includes(v) });
/** FEAT-128 — La meta por la que se filtra (o ''). Va aparte, como `mostrar`: Desktop no la conoce. */
export const metaFiltro = persistente('tablero.meta', '', { validar: (v) => typeof v === 'string' && (v === '' || /^g_[0-9a-f]{8}$/.test(v)) });
export const busqueda = signal({ seq: 0, ids: null, error: null });

// Un filtro guardado con `quien: 'fanout' | 'propuestas'` (de antes de F4) pasa a «Mostrar». Corre también si Desktop
// vuelve a sembrar un valor viejo: la migración es idempotente.
effect(() => {
  const { filtro: f, mostrar: m } = migrarFiltro(filtro.value);
  if (!m) return;
  mostrar.value = m;
  filtro.value = f;
});

/** Solo claves de `FILTRO_VACIO`: lo demás (p. ej. `mostrar`) nunca entra al filtro guardado. */
export function cambiarFiltro(cambios) {
  const f = { ...filtro.value };
  for (const k of Object.keys(FILTRO_VACIO)) if (k in cambios) f[k] = cambios[k];
  filtro.value = f;
}
/** Quitar uno o varios filtros, de cualquiera de los dos niveles. */
function quitar(cambios, alBuscar) {
  if ('mostrar' in cambios) mostrar.value = cambios.mostrar;
  cambiarFiltro(cambios);
  if ('q' in cambios) alBuscar();
}
export function limpiarFiltros(alBuscar) {
  const f = filtro.value;
  metaFiltro.value = '';
  mostrar.value = 'todo';
  filtro.value = { ...FILTRO_VACIO, agrupar: f.agrupar };
  if (f.q.trim()) alBuscar();
}

function Grupo({ rotulo, nombre, opciones, valor, alElegir }) {
  return html`<fieldset class="filtros-grupo" role="radiogroup" aria-label=${rotulo}>
    <legend>${rotulo}</legend>
    <div class="segmentos">${Object.entries(opciones).map(([v, t]) => html`<label key=${v} class=${v === valor ? 'si' : undefined}>
      <input type="radio" name=${nombre} value=${v} checked=${v === valor} onChange=${() => alElegir(v)} />${t}</label>`)}</div>
  </fieldset>`;
}

function Interruptor({ id, rotulo, nota, valor, alCambiar }) {
  return html`<label class="interruptor"><input type="checkbox" role="switch" id=${id} checked=${valor} onChange=${(e) => alCambiar(e.currentTarget.checked)} />${rotulo}${nota ? html` <span class="tenue">${nota}</span>` : null}</label>`;
}

/** Lo del panel, igual en el panel flotante (escritorio) y en la hoja (teléfono). */
function CuerpoFiltros({ f, m, lotesOcultos }) {
  return html`<${Grupo} rotulo="Mostrar" nombre="filtro-mostrar" opciones=${TEXTO_MOSTRAR} valor=${m} alElegir=${(v) => { mostrar.value = v; }} />
    <${Grupo} rotulo="Origen" nombre="filtro-origen" opciones=${TEXTO_ORIGEN} valor=${f.origen} alElegir=${(v) => cambiarFiltro({ origen: v })} />
    <div class="filtros-grupo"><span class="filtros-rotulo">Cuándo</span>
      <${Interruptor} id="filtro-hoy" rotulo="Solo de hoy" valor=${f.hoy} alCambiar=${(v) => cambiarFiltro({ hoy: v })} /></div>
    <div class="filtros-grupo"><span class="filtros-rotulo">Archivo</span>
      <${Interruptor} id="filtro-archivadas" rotulo="Solo archivadas" nota="(en vez de las activas)" valor=${f.archivadas} alCambiar=${(v) => cambiarFiltro({ archivadas: v })} /></div>
    ${lotesOcultos ? html`<p class="filtros-aviso">${lotesOcultos === 1 ? '1 lote oculto' : `${lotesOcultos} lotes ocultos`}: los lotes vienen de Claude Code, así que no tienen origen web ni Telegram, no se archivan y no tienen un quién.</p>` : null}`;
}

function PanelFiltros({ f, m, lotesOcultos, alBuscar, cerrar }) {
  const escondidos = escondidosActivos(f, m);
  const limpiarEstos = () => quitar(Object.assign({}, ...escondidos.map((p) => p.quitar)), alBuscar);
  return html`<div class="filtros-panel" id="filtros-panel" role="group" aria-label="Más filtros">
    <${CuerpoFiltros} f=${f} m=${m} lotesOcultos=${lotesOcultos} />
    <div class="filtros-pie"><span>${escondidos.length ? `${escondidos.length} ${escondidos.length === 1 ? 'filtro' : 'filtros'} acá` : 'Ninguno activo'}</span>
      ${escondidos.length ? html`<button type="button" class="accion" onClick=${limpiarEstos}>limpiar estos</button>` : null}
      <button type="button" class="accion" onClick=${cerrar}>cerrar</button></div>
  </div>`;
}

function CamposQuienProyecto({ f, quien, quienes, almas, agentes, nombres }) {
  return html`<label class="filtro-campo">Quién
      <select id="filtro-quien" class=${quien !== 'todo' ? 'activo' : null} value=${quien} onChange=${(e) => cambiarFiltro({ quien: e.currentTarget.value })}>
        ${quienes.map(([v, t]) => html`<option key=${v} value=${v}>${t}</option>`)}
        ${almas.length ? html`<optgroup label="Almas">${almas.map((a) => html`<option key=${a.clave} value=${`alma:${a.clave}`}>${a.voz}</option>`)}</optgroup>` : null}
        ${agentes.length ? html`<optgroup label="Agentes">${agentes.map((g) => html`<option key=${g.nombre} value=${`agente:${g.nombre}`}>${g.nombre}</option>`)}</optgroup>` : null}
      </select></label>
    <label class="filtro-campo">Proyecto
      <select id="filtro-proyecto" class=${f.proyecto ? 'activo' : null} value=${f.proyecto} onChange=${(e) => cambiarFiltro({ proyecto: e.currentTarget.value })}>
        <option value="">Todos</option>${[...nombres].sort().map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
      </select></label>`;
}

/** FEAT-160 F5b — La hoja del teléfono: los dos niveles juntos, en vivo; el pie dice cuántas quedan y cierra. */
function HojaFiltros({ campos, f, m, lotesOcultos, visibles, hay, limpiar, cerrar }) {
  return html`<${Hoja} id="hoja-filtros" titulo="Filtros" alCerrar=${cerrar}
    aparte=${hay ? html`<button type="button" class="accion" onClick=${limpiar}>Limpiar</button>` : null}
    pie=${html`<button type="button" class="boton primario" onClick=${cerrar}>${visibles === 1 ? 'Ver 1 tarjeta' : `Ver ${visibles} tarjetas`}</button>`}>
    <div class="filtros-hoja">${campos}<${CuerpoFiltros} f=${f} m=${m} lotesOcultos=${lotesOcultos} /></div>
  <//>`;
}

/** `proyectos`, `lotesOcultos`, `visibles` y `alBuscar` los sabe la vista (tareas, lotes y el pedido de búsqueda). */
export function Filtros({ proyectos, lotesOcultos = 0, visibles = 0, alBuscar }) {
  const f = filtro.value;
  const m = mostrar.value;
  const b = busqueda.value;
  const { almas, agentes } = sujetos.value;
  const [abierto, setAbierto] = useState(false);
  const raiz = useRef(null);
  const boton = useRef(null);
  useEffect(() => {
    // En el teléfono la hoja maneja su velo y su Esc.
    if (!abierto || enCarrusel.value) return undefined;
    const fuera = (ev) => { if (!raiz.current?.contains(ev.target)) setAbierto(false); };
    const tecla = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); setAbierto(false); boton.current?.focus(); } };
    document.addEventListener('pointerdown', fuera, true);
    document.addEventListener('keydown', tecla, true);
    return () => { document.removeEventListener('pointerdown', fuera, true); document.removeEventListener('keydown', tecla, true); };
  }, [abierto]);
  const nombres = new Set(proyectos);
  if (f.proyecto) nombres.add(f.proyecto);
  const quienes = [['todo', 'Todos'], ['alma', 'Almas'], ['agente', 'Agentes'], ['trabajo', 'Trabajo']];
  const quienValido = quienes.some(([v]) => v === f.quien) || almas.some((a) => `alma:${a.clave}` === f.quien) || agentes.some((g) => `agente:${g.nombre}` === f.quien);
  const quien = quienValido ? f.quien : 'todo';
  const telefono = enCarrusel.value;
  const nombreQuien = [...quienes, ...almas.map((a) => [`alma:${a.clave}`, a.voz]), ...agentes.map((g) => [`agente:${g.nombre}`, g.nombre])].find(([v]) => v === quien)?.[1];
  const escondidos = escondidosActivos({ ...f, quien }, m, telefono ? { quien: nombreQuien } : null);
  const campos = html`<${CamposQuienProyecto} f=${f} quien=${quien} quienes=${quienes} almas=${almas} agentes=${agentes} nombres=${nombres} />`;
  const cerrar = () => { setAbierto(false); boton.current?.focus(); };
  const buscar = (q) => { cambiarFiltro({ q }); alBuscar(); };
  const encontradas = f.q.trim() && b.ids ? b.ids.size : null;
  return html`<div class="tablero-filtros" role="toolbar" aria-label="Filtros del tablero">
    <label class="buscador"><${Icono} d=${ICONO_BUSCAR} />
      <input type="search" id="tablero-buscar" maxlength=${String(TOPE_BUSQUEDA)} autocomplete="off" spellcheck="false" aria-label="Buscar en el tablero" placeholder="Buscar en pedidos, títulos y notas"
        value=${f.q} onInput=${(e) => buscar(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Escape' && f.q) { e.preventDefault(); e.stopPropagation(); buscar(''); } }} />
      ${encontradas !== null ? html`<span class="buscador-cuenta" aria-live="polite">${encontradas === 1 ? '1 resultado' : `${encontradas} resultados`}</span>` : html`<span class="tecla">/</span>`}</label>
    ${telefono ? null : campos}
    <div class="filtros-mas" ref=${raiz}>
      <button type="button" ref=${boton} id="filtros-boton" class=${`filtro${escondidos.length ? ' con' : ''}`} aria-expanded=${String(abierto)} aria-controls=${telefono ? 'hoja-filtros' : 'filtros-panel'}
        onClick=${() => setAbierto(!abierto)}><${Icono} d=${ICONO_FILTROS} />Filtros${escondidos.length ? html`<span class="filtros-n">${escondidos.length}</span>` : null}</button>
      ${abierto && !telefono ? html`<${PanelFiltros} f=${f} m=${m} lotesOcultos=${lotesOcultos} alBuscar=${alBuscar} cerrar=${cerrar} />` : null}
      ${abierto && telefono ? html`<${HojaFiltros} campos=${campos} f=${f} m=${m} lotesOcultos=${lotesOcultos} visibles=${visibles}
        hay=${escondidos.length > 0} limpiar=${() => quitar(Object.assign({}, ...escondidos.map((p) => p.quitar)), alBuscar)} cerrar=${cerrar} />` : null}
    </div>
    ${escondidos.map((p) => html`<span key=${p.clave} class="pastilla-filtro">${p.texto}<button type="button" aria-label=${`Quitar filtro: ${p.texto}`} title="Quitar" onClick=${() => quitar(p.quitar, alBuscar)}>×</button></span>`)}
    ${lotesOcultos ? html`<span class="filtros-ocultos" title="Los lotes vienen de Claude Code: no tienen origen web ni Telegram, no se archivan y no tienen un quién.">· ${lotesOcultos === 1 ? '1 lote oculto' : `${lotesOcultos} lotes ocultos`}</span>` : null}
    <span class="filtros-activos" id="filtros-activos">${hayFiltros(f, m)
      ? html`<button type="button" class="accion" onClick=${() => limpiarFiltros(alBuscar)}>limpiar todo</button>`
      : null}</span>
  </div>`;
}
