/*
 * FEAT-128 — Las metas en el tablero: la franja arriba del kanban (barra, clic filtra), el alta y la edición, el chip
 * de la tarjeta y el selector del detalle. Las metas son las de `/meta` (FEAT-126) más las de tarjetas; desde acá
 * solo se crean de fecha o de tarjetas, nunca con un comando.
 *
 * El progreso de una meta de tarjetas se cuenta acá, con las tarjetas que ya llegan por SSE (`reglas-metas.js`): el
 * daemon solo deja una foto para la terminal. Solo importa módulos hoja: nunca vista-tablero.js.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState, useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar, nodo } from './nucleo.js';
import { BotonDosPasos } from './comp-base.js';
import { alEvento } from './sse.js';
import { filtro, metaFiltro } from './tablero-filtros.js';
import { conteoDeMetas, cumplidaEnVivo, progresoEnVivo, detalleEnVivo } from './reglas-metas.js';

const TOPE_NOMBRE = 60;
const enc = encodeURIComponent;
/** `{ proyectos, metas }` | null mientras carga. */
export const metas = signal(null);
const formAbierto = signal(false);
const editando = signal(null);

export async function cargarMetas() {
  try {
    const r = await api('/api/metas', undefined, { cache: 'no-store' });
    metas.value = { proyectos: r.proyectos || [], metas: r.metas || [] };
  } catch { metas.value = { proyectos: [], metas: [] }; }
}
alEvento('metas', (e) => { metas.value = { proyectos: e.proyectos || [], metas: e.metas || [] }; });

const lista = () => metas.value?.metas || [];
export const metaPorId = (id) => (id ? lista().find((m) => m.id === id) || null : null);
const alternarFiltro = (id) => { metaFiltro.value = metaFiltro.value === id ? '' : id; };

/** La meta de una tarjeta, como chip: clic filtra por ella. Sin meta (o una que ya no existe), nada. */
export function ChipMeta({ t }) {
  const m = metaPorId(t.metaId);
  if (!m) return null;
  return html`<button type="button" class=${`chip meta-chip${metaFiltro.value === m.id ? ' activa' : ''}`} title=${`Meta «${m.nombre}»: filtrar por ella`}
    onClick=${(e) => { e.stopPropagation(); alternarFiltro(m.id); }}><span aria-hidden="true">◎</span> ${m.nombre}</button>`;
}

/** En el detalle: a qué meta suma la tarjeta. Con hijas, la familia entera. */
export function SelectorMeta({ t, familia = false, alCambiar = null }) {
  if (nodo.value !== 'local') return null;
  const opciones = lista().filter((m) => !m.cerrada || m.id === t.metaId);
  const elegir = async (valor) => {
    try {
      await api(`/api/tareas/${enc(t.id)}/meta`, { metaId: valor || null, familia });
      avisar(valor ? `Suma a «${metaPorId(valor)?.nombre || valor}»${familia ? ', con sus hijas' : ''}.` : 'Ya no suma a ninguna meta.');
    } catch (err) { avisar(err.message, 'error'); }
    // BE-139 — Sin esto el selector seguía mostrando la meta anterior.
    alCambiar?.();
  };
  return html`<label class="campo meta-selector"><span class="bloque-titulo">Meta${familia ? ' (con sus hijas)' : ''}</span>
    <select class="entrada" value=${t.metaId || ''} onChange=${(e) => elegir(e.currentTarget.value)}>
      <option value="">Sin meta</option>
      ${opciones.map((m) => html`<option key=${m.id} value=${m.id}>${m.nombre}${m.proyecto ? ` · ${m.proyecto.nombre}` : ''}</option>`)}
    </select></label>`;
}

function NuevaMeta({ proyectos }) {
  const delFiltro = proyectos.find((p) => p.nombre === filtro.value.proyecto);
  const [f, setF] = useState({ tipo: 'tarjetas', nombre: '', fin: '', proyecto: delFiltro?.id || proyectos[0]?.id || '' });
  const [enviando, setEnviando] = useState(false);
  const cambiar = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const enviar = async (e) => {
    e.preventDefault();
    if (!f.nombre.trim()) { avisar('Falta el nombre.', 'error'); return; }
    if (f.tipo === 'fecha' && !f.fin) { avisar('Falta la fecha.', 'error'); return; }
    setEnviando(true);
    try {
      await api('/api/metas', { tipo: f.tipo, nombre: f.nombre.trim(), workspaceId: f.proyecto || null, ...(f.tipo === 'fecha' ? { fin: `${f.fin}T23:59` } : {}) });
      avisar('Meta creada.');
      formAbierto.value = false;
    } catch (err) { avisar(err.message, 'error'); }
    setEnviando(false);
  };
  return html`<form class="meta-form" onSubmit=${enviar} aria-label="Nueva meta">
    <label class="campo"><span class="bloque-titulo">Nombre</span>
      <input type="text" class="entrada" maxlength=${String(TOPE_NOMBRE)} required value=${f.nombre} onInput=${cambiar('nombre')} /></label>
    <label class="campo"><span class="bloque-titulo">Avanza con</span>
      <select class="entrada" value=${f.tipo} onChange=${cambiar('tipo')}>
        <option value="tarjetas">las tarjetas que le vincules</option><option value="fecha">el tiempo, hasta una fecha</option></select></label>
    ${f.tipo === 'fecha' ? html`<label class="campo"><span class="bloque-titulo">Fecha límite</span>
      <input type="date" class="entrada" required value=${f.fin} onInput=${cambiar('fin')} /></label>` : null}
    ${proyectos.length > 1 ? html`<label class="campo"><span class="bloque-titulo">Proyecto</span>
      <select class="entrada" value=${f.proyecto} onChange=${cambiar('proyecto')}>${proyectos.map((p) => html`<option key=${p.id} value=${p.id}>${p.nombre}</option>`)}</select></label>` : null}
    <div class="meta-form-acciones"><button type="submit" class="boton primario chico" disabled=${enviando}>Crear</button>
      <button type="button" class="boton chico" onClick=${() => { formAbierto.value = false; }}>Cancelar</button></div>
  </form>`;
}

function EditarMeta({ m }) {
  const [nombre, setNombre] = useState(m.nombre);
  const [fin, setFin] = useState(m.fin ? m.fin.slice(0, 10) : '');
  const enviar = async (cambios, aviso) => {
    try { await api(`/api/metas/${enc(m.id)}/editar`, cambios); avisar(aviso); editando.value = null; } catch (err) { avisar(err.message, 'error'); }
  };
  const guardar = (e) => {
    e.preventDefault();
    enviar({ nombre: nombre.trim(), ...(m.tipo === 'fecha' && fin ? { fin: `${fin}T23:59` } : {}) }, 'Meta guardada.');
  };
  const borrar = async () => {
    try { await api(`/api/metas/${enc(m.id)}/borrar`, {}); avisar('Meta borrada: sus tarjetas quedaron sin meta.'); editando.value = null; if (metaFiltro.value === m.id) metaFiltro.value = ''; }
    catch (err) { avisar(err.message, 'error'); }
  };
  return html`<form class="meta-form" onSubmit=${guardar} aria-label=${`Editar la meta ${m.nombre}`}>
    <label class="campo"><span class="bloque-titulo">Nombre</span>
      <input type="text" class="entrada" maxlength=${String(TOPE_NOMBRE)} required value=${nombre} onInput=${(e) => setNombre(e.currentTarget.value)} /></label>
    ${m.tipo === 'fecha' ? html`<label class="campo"><span class="bloque-titulo">Fecha límite</span>
      <input type="date" class="entrada" value=${fin} onInput=${(e) => setFin(e.currentTarget.value)} /></label>` : null}
    <div class="meta-form-acciones">
      <button type="submit" class="boton primario chico">Guardar</button>
      <button type="button" class="boton chico" onClick=${() => enviar({ cerrada: !m.cerrada }, m.cerrada ? 'Meta reabierta.' : 'Meta cerrada.')}>${m.cerrada ? 'Reabrir' : 'Cerrar'}</button>
      <${BotonDosPasos} clase="boton chico peligro" texto="Borrar" armado="¿Borrar? Clic de nuevo" alConfirmar=${borrar} />
      <button type="button" class="boton chico" onClick=${() => { editando.value = null; }}>Cancelar</button>
    </div>
  </form>`;
}

function ItemMeta({ m, c, conProyecto }) {
  const cumplida = cumplidaEnVivo(m, c);
  const pct = Math.round(progresoEnVivo(m, c) * 100);
  const activo = metaFiltro.value === m.id;
  // BE-139 — «cerrada» y «cumplida» ya las dice el detalle: la pastilla queda para riesgo y error.
  const estado = cumplida ? null : m.estado?.enRiesgo ? 'en riesgo' : m.estado?.error ? 'error' : null;
  return html`<li class=${`meta-item${activo ? ' activa' : ''}${cumplida ? ' cumplida' : ''}${editando.value === m.id ? ' editando' : ''}`}>
    <button type="button" class="meta-item-foco" aria-pressed=${String(activo)} title=${activo ? 'Quitar el filtro' : 'Ver solo sus tarjetas'} onClick=${() => alternarFiltro(m.id)}>
      <span class="meta-item-fila"><b class="meta-nombre">${m.nombre}</b>
        ${conProyecto ? html`<span class="chip chico meta-proyecto" title=${m.proyecto.nombre}>${m.proyecto.nombre}</span>` : null}
        ${estado ? html`<span class=${`ficha ficha-chica meta-estado-${estado.replace(' ', '-')}`}>${estado}</span>` : null}</span>
      <span class="meta-barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${String(pct)} aria-label=${`Progreso de ${m.nombre}`}><span style=${{ width: `${pct}%` }}></span></span>
      <span class="meta-detalle tenue">${detalleEnVivo(m, c)}</span>
    </button>
    <button type="button" class="accion meta-editar" aria-label=${`Editar la meta ${m.nombre}`} onClick=${() => { editando.value = editando.value === m.id ? null : m.id; }}>⋯</button>
    ${editando.value === m.id ? html`<${EditarMeta} key=${m.id} m=${m} />` : null}
  </li>`;
}

/** La franja: las activas primero, las cumplidas plegadas. Solo en la consola local (las metas no viajan a nodos). */
export function FranjaMetas({ tareas }) {
  const [verCumplidas, setVerCumplidas] = useState(false);
  useEffect(() => { if (metas.value === null) cargarMetas(); }, []);
  if (nodo.value !== 'local') return null;
  if (metas.value === null) return html`<section class="franja-metas" aria-label="Metas"><div class="franja-metas-cabecera"><span class="bloque-titulo">Metas</span><span class="tenue">cargando…</span></div></section>`;
  const { proyectos } = metas.value;
  const delProyecto = filtro.value.proyecto ? lista().filter((m) => m.proyecto?.nombre === filtro.value.proyecto) : lista();
  const conteo = conteoDeMetas(tareas);
  const activas = delProyecto.filter((m) => !cumplidaEnVivo(m, conteo[m.id]));
  const cumplidas = delProyecto.filter((m) => cumplidaEnVivo(m, conteo[m.id]));
  const conProyecto = !filtro.value.proyecto && proyectos.length > 1;
  const item = (m) => html`<${ItemMeta} key=${m.id} m=${m} c=${conteo[m.id]} conProyecto=${conProyecto} />`;
  const filtrada = metaPorId(metaFiltro.value);
  return html`<section class="franja-metas" aria-label="Metas">
    <div class="franja-metas-cabecera">
      <span class="bloque-titulo">Metas</span>
      ${filtrada ? html`<span class="tenue">Solo «${filtrada.nombre}» · <button type="button" class="accion" onClick=${() => { metaFiltro.value = ''; }}>ver todas</button></span>` : null}
      ${cumplidas.length ? html`<button type="button" class="accion" aria-expanded=${String(verCumplidas)} onClick=${() => setVerCumplidas(!verCumplidas)}>Cumplidas (${cumplidas.length})</button>` : null}
      <button type="button" class="boton chico meta-nueva" aria-expanded=${String(formAbierto.value)} onClick=${() => { formAbierto.value = !formAbierto.value; }}>+ Meta</button>
    </div>
    ${formAbierto.value ? html`<${NuevaMeta} proyectos=${proyectos} />` : null}
    ${activas.length || (verCumplidas && cumplidas.length)
      ? html`<ul class="meta-lista desplazable">${activas.map(item)}${verCumplidas ? cumplidas.map(item) : null}</ul>`
      : html`<p class="tenue meta-vacio">${delProyecto.length ? 'Todas las metas están cumplidas.' : 'Sin metas todavía: creá una y vinculale tarjetas desde su detalle.'}</p>`}
  </section>`;
}
