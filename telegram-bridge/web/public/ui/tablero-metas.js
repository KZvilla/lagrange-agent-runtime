/*
 * FEAT-128 — Las metas en el tablero: la franja arriba del kanban (barra, clic filtra), el alta y la edición, el chip
 * de la tarjeta y el selector del detalle. Las metas son las de `/meta` (FEAT-126) más las de tarjetas; desde acá
 * solo se crean de fecha o de tarjetas, nunca con un comando.
 *
 * El progreso de una meta de tarjetas se cuenta acá, con las tarjetas que ya llegan por SSE (`reglas-metas.js`): el
 * daemon solo deja una foto para la terminal. Solo importa módulos hoja: nunca vista-tablero.js.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState, useEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar, nodo, tono } from './nucleo.js';
import { BotonDosPasos, Dialogo, Campo, BarraProgreso } from './comp-base.js';
import { alEvento } from './sse.js';
import { filtro, metaFiltro } from './tablero-filtros.js';
import { conteoDeMetas, cumplidaEnVivo, progresoEnVivo, detalleEnVivo } from './reglas-metas.js';

const TOPE_NOMBRE = 60;
const enc = encodeURIComponent;
/** `{ proyectos, metas }` | null mientras carga. */
export const metas = signal(null);
const formAbierto = signal(false);
/** La meta abierta en el diálogo del «⋯». */
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
  return html`<button type="button" class=${`chip meta-chip ${tono(m.id)}${metaFiltro.value === m.id ? ' activa' : ''}`} title=${`Meta «${m.nombre}»: filtrar por ella`}
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
    <select value=${metaPorId(t.metaId) ? t.metaId : ''} onChange=${(e) => elegir(e.currentTarget.value)}>
      <option value="">Sin meta</option>
      ${opciones.map((m) => html`<option key=${m.id} value=${m.id}>${m.nombre}${m.proyecto ? ` · ${m.proyecto.nombre}` : ''}</option>`)}
    </select></label>`;
}

function NuevaMeta({ proyectos }) {
  const delFiltro = proyectos.find((p) => p.nombre === filtro.value.proyecto);
  const [f, setF] = useState({ tipo: 'tarjetas', nombre: '', fin: '', proyecto: delFiltro?.id || proyectos[0]?.id || '' });
  const [enviando, setEnviando] = useState(false);
  const nombre = useRef(null);
  useEffect(() => { nombre.current?.focus(); }, []);
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
    <${Campo} texto="Nombre">
      <input ref=${nombre} type="text" maxlength=${String(TOPE_NOMBRE)} required placeholder="p. ej. Publicar la v2" value=${f.nombre} onInput=${cambiar('nombre')} /><//>
    <${Campo} texto="Avanza con">
      <select value=${f.tipo} onChange=${cambiar('tipo')}>
        <option value="tarjetas">las tarjetas que le vincules</option><option value="fecha">el tiempo, hasta una fecha</option></select><//>
    ${f.tipo === 'fecha' ? html`<${Campo} texto="Fecha límite">
      <input type="date" required value=${f.fin} onInput=${cambiar('fin')} /><//>` : null}
    ${proyectos.length > 1 ? html`<${Campo} texto="Proyecto">
      <select value=${f.proyecto} onChange=${cambiar('proyecto')}>${proyectos.map((p) => html`<option key=${p.id} value=${p.id}>${p.nombre}</option>`)}</select><//>` : null}
    <div class="meta-form-acciones"><button type="submit" class="boton primario chico" disabled=${enviando}>Crear</button>
      <button type="button" class="boton chico" onClick=${() => { formAbierto.value = false; }}>Cancelar</button></div>
  </form>`;
}

/** BE-141 — El «⋯» de una meta abre este diálogo: editar, cerrar o reabrir, borrar. */
function DialogoMeta({ m, c }) {
  const [nombre, setNombre] = useState(m.nombre);
  const [fin, setFin] = useState(m.fin ? m.fin.slice(0, 10) : '');
  // FEAT-165 — Se mueve de proyecto (sus tarjetas siguen vinculadas); una con comandos no: su aprobación es de este.
  const proyectos = m.tieneComando ? [] : (metas.value?.proyectos || []);
  const [proyecto, setProyecto] = useState(m.proyecto?.id || '');
  const otro = proyectos.find((p) => p.id === proyecto && p.id !== m.proyecto?.id);
  const enviar = async (cambios, aviso) => {
    try { await api(`/api/metas/${enc(m.id)}/editar`, cambios); avisar(aviso); editando.value = null; } catch (err) { avisar(err.message, 'error'); }
  };
  const guardar = (e) => {
    e.preventDefault();
    enviar({ nombre: nombre.trim(), ...(m.tipo === 'fecha' && fin ? { fin: `${fin}T23:59` } : {}), ...(otro ? { workspaceId: otro.id } : {}) }, otro ? `Meta movida a «${otro.nombre}».` : 'Meta guardada.');
  };
  const borrar = async () => {
    try { await api(`/api/metas/${enc(m.id)}/borrar`, {}); avisar('Meta borrada: sus tarjetas quedaron sin meta.'); editando.value = null; if (metaFiltro.value === m.id) metaFiltro.value = ''; }
    catch (err) { avisar(err.message, 'error'); }
  };
  const cerrar = () => { editando.value = null; };
  // BE-144 — El estado a la vista (proyecto, tipo y avance). FEAT-165 — El tipo no se edita (cambia su medida).
  return html`<${Dialogo} etiqueta=${`Meta ${m.nombre}`} alCerrar=${cerrar}><strong>Meta «${m.nombre}»</strong>
  <span class="tenue dialogo-sub">${[m.proyecto?.nombre, m.tipo, detalleEnVivo(m, c)].filter(Boolean).join(' · ')}</span>
  <form class="dialogo-form" onSubmit=${guardar}>
    <${Campo} texto="Nombre">
      <input type="text" maxlength=${String(TOPE_NOMBRE)} required value=${nombre} onInput=${(e) => setNombre(e.currentTarget.value)} /><//>
    ${proyectos.length > 1 ? html`<${Campo} texto="Proyecto">
      <select value=${proyecto} onChange=${(e) => setProyecto(e.currentTarget.value)}>${proyectos.map((p) => html`<option key=${p.id} value=${p.id}>${p.nombre}</option>`)}</select><//>` : null}
    ${m.tipo === 'fecha' ? html`<${Campo} texto="Fecha límite">
      <input type="date" value=${fin} onInput=${(e) => setFin(e.currentTarget.value)} /><//>` : null}
    <div class="dialogo-pie">
      <${BotonDosPasos} clase="boton chico peligro" texto="Borrar" armado="¿Borrar? Clic de nuevo" alConfirmar=${borrar} />
      <span class="dialogo-hueco"></span>
      <button type="button" class="boton chico" onClick=${() => enviar({ cerrada: !m.cerrada }, m.cerrada ? 'Meta reabierta.' : 'Meta cumplida.')}>${m.cerrada ? 'Reabrir' : 'Marcar cumplida'}</button>
      <button type="button" class="boton chico" onClick=${cerrar}>Cancelar</button>
      <button type="submit" class="boton primario chico">Guardar</button>
    </div>
  </form><//>`;
}

function ItemMeta({ m, c, conProyecto, festejo }) {
  const cumplida = cumplidaEnVivo(m, c);
  const pct = Math.round(progresoEnVivo(m, c) * 100);
  const activo = metaFiltro.value === m.id;
  // BE-139 — «cerrada» y «cumplida» ya las dice el detalle: la pastilla queda para riesgo y error.
  const estado = cumplida ? null : m.estado?.enRiesgo ? 'en riesgo' : m.estado?.error ? 'error' : null;
  // BE-144 — Una meta de tarjetas sin tarjetas dice qué hacer; el color de la meta es el de su chip.
  const detalle = m.tipo === 'tarjetas' && !cumplida && !(c && c.total) ? 'Vinculá tarjetas desde su detalle' : detalleEnVivo(m, c);
  return html`<li class=${`meta-item ${tono(m.id)}${activo ? ' activa' : ''}${cumplida ? ' cumplida' : ''}${festejo ? ' festejo' : ''}`}>
    <button type="button" class="meta-item-foco" aria-pressed=${String(activo)} title=${activo ? 'Quitar el filtro' : 'Ver solo sus tarjetas'} onClick=${() => alternarFiltro(m.id)}>
      <span class="meta-item-fila"><b class="meta-nombre">${cumplida ? '✓ ' : ''}${m.nombre}</b>
        ${conProyecto ? html`<span class="chip chico meta-proyecto" title=${m.proyecto.nombre}>${m.proyecto.nombre}</span>` : null}
        ${estado ? html`<span class=${`ficha ficha-chica meta-estado-${estado.replace(' ', '-')}`}>${estado}</span>` : null}</span>
      <${BarraProgreso} valor=${pct} etiqueta=${`Progreso de ${m.nombre}`} />
      <span class="meta-detalle tenue">${detalle}</span>
    </button>
    <button type="button" class="tarjeta-mas meta-editar" aria-haspopup="dialog" aria-label=${`Acciones de la meta ${m.nombre}`} title="Editar, marcar cumplida o borrar" onClick=${() => { editando.value = m.id; }}>⋮</button>
  </li>`;
}

/** La franja: las activas primero, las cumplidas plegadas. Solo en la consola local (las metas no viajan a nodos). */
export function FranjaMetas({ tareas }) {
  const [verCumplidas, setVerCumplidas] = useState(false);
  const [festejo, setFestejo] = useState(null);
  const vistas = useRef(null);
  useEffect(() => { if (metas.value === null) cargarMetas(); }, []);
  // BE-144 — Una meta que pasa a cumplida (no las que ya lo estaban al cargar) se festeja un momento. El hook va antes
  // de los return tempranos: el orden de los hooks no puede cambiar entre dibujos.
  const conteo = conteoDeMetas(tareas);
  const idsCumplidas = metas.value ? lista().filter((m) => cumplidaEnVivo(m, conteo[m.id])).map((m) => m.id) : null;
  const firma = idsCumplidas ? idsCumplidas.join(',') : null;
  useEffect(() => {
    if (!idsCumplidas) return undefined;
    const antes = vistas.current;
    vistas.current = new Set(idsCumplidas);
    const nueva = antes && idsCumplidas.find((id) => !antes.has(id));
    if (!nueva) return undefined;
    setFestejo(nueva);
    const t = setTimeout(() => setFestejo(null), 1200);
    return () => clearTimeout(t);
  }, [firma]);
  if (nodo.value !== 'local') return null;
  if (metas.value === null) return html`<section class="franja-metas" aria-label="Metas"><div class="franja-metas-cabecera"><span class="bloque-titulo">Metas</span><span class="tenue">cargando…</span></div></section>`;
  const { proyectos } = metas.value;
  const delProyecto = filtro.value.proyecto ? lista().filter((m) => m.proyecto?.nombre === filtro.value.proyecto) : lista();
  // La que se está festejando sigue a la vista entre las activas aunque las cumplidas estén plegadas.
  const activas = delProyecto.filter((m) => !cumplidaEnVivo(m, conteo[m.id]) || (festejo === m.id && !verCumplidas));
  const cumplidas = delProyecto.filter((m) => cumplidaEnVivo(m, conteo[m.id]));
  const conProyecto = !filtro.value.proyecto && proyectos.length > 1;
  const item = (m) => html`<${ItemMeta} key=${m.id} m=${m} c=${conteo[m.id]} conProyecto=${conProyecto} festejo=${festejo === m.id} />`;
  const sinMetas = !delProyecto.length && !formAbierto.value;
  const filtrada = metaPorId(metaFiltro.value);
  const editada = metaPorId(editando.value);
  return html`<section class="franja-metas" aria-label="Metas">
    <div class=${`franja-metas-cabecera${sinMetas ? ' vacia' : ''}`}>
      <span class="bloque-titulo">Metas</span>
      ${sinMetas ? html`<span class="tenue">Sin metas todavía: creá una y vinculale tarjetas desde su detalle.</span>` : null}
      ${filtrada ? html`<span class="tenue">Solo «${filtrada.nombre}» · <button type="button" class="accion" onClick=${() => { metaFiltro.value = ''; }}>ver todas</button></span>` : null}
      ${cumplidas.length ? html`<button type="button" class=${`accion${verCumplidas ? ' activo' : ''}`} aria-pressed=${String(verCumplidas)} onClick=${() => setVerCumplidas(!verCumplidas)}>Cumplidas (${cumplidas.length})</button>` : null}
      <button type="button" class="boton chico meta-nueva" aria-expanded=${String(formAbierto.value)} onClick=${() => { formAbierto.value = !formAbierto.value; }}>+ Meta</button>
    </div>
    ${formAbierto.value ? html`<${NuevaMeta} proyectos=${proyectos} />` : null}
    ${editada ? html`<${DialogoMeta} key=${editada.id} m=${editada} c=${conteo[editada.id]} />` : null}
    ${activas.length || (verCumplidas && cumplidas.length)
      ? html`<ul class="meta-lista desplazable">${activas.map(item)}${verCumplidas ? cumplidas.map(item) : null}</ul>`
      : delProyecto.length && !formAbierto.value ? html`<p class="tenue meta-vacio">Todas las metas están cumplidas.</p>` : null}
  </section>`;
}
