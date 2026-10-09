/*
 * FEAT-136 F3 — El tablero (FEAT-054/057/059/061/068/098/105/108) en
 * componentes: filtros y búsqueda, columnas, tarjetas, lotes de fan-out y
 * confinados, el formulario de tarjeta nueva y el detalle.
 *
 * Estado en señales (`app.js` las usa con accesores en `estado`):
 *   - `tablero`: lista | { error } | null. El SSE la muta en su lugar
 *     (`alCambiarTarea` en app.js) y avisa con `tocarTablero()`.
 *   - `filtro`: persiste por dispositivo. `busqueda`: lo que encontró el
 *     servidor (D9). `detalle`: la tarjeta abierta (vive también en `?t=`).
 *   - `fanout` y `lotes`: el sondeo cada 10 s mientras el tablero está a la vista.
 *   - El borrador de la tarjeta nueva persiste.
 * Las tarjetas y el detalle llevan `key`: un evento no desarma un «¿seguro?»
 * ni lo que se está escribiendo (antes, slots y huellas a mano).
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState, useEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar, duracion, relativo, tono, nodo, alcanza, motivoRemoto } from './nucleo.js';
import { fechaCorta } from './fechas.js';
import { Icono, Reloj, BotonDosPasos, Avatar } from './comp-base.js';
import { Resultado } from './resultado.js';
import { Tuberia } from './vista-tuberia.js';
import { PieDeMemoria, BotonEscuchar, LineaDeTiempo, Parcial, reintentable } from './vista-charla.js';
import { ruta, sujetos, daemon } from './estado.js';
import { persistente } from './persistencia.js';
import { arrastre, configurarArrastre, alPresionar, cancelarArrastre } from './tablero-arrastre.js';

export const COLUMNAS = [
  { id: 'hacer', titulo: 'Por hacer', estados: ['por_hacer'] },
  { id: 'cola', titulo: 'En cola', estados: ['en_cola'] },
  { id: 'curso', titulo: 'Trabajando', estados: ['en_curso'] },
  { id: 'ok', titulo: 'Terminado', estados: ['ok'] },
  { id: 'mal', titulo: 'Con error o cancelado', estados: ['error', 'cancelada', 'interrumpida'] }
];
const TOPE_TERMINADAS = 40;
// Los mismos topes que el registro (tareas.js).
const TOPE_PEDIDO_TARJETA = 16 * 1024;
const TOPE_TITULO = 120;
const TOPE_NOTA = 1000;
const TOPE_BUSQUEDA = 200;
const ESPERA_BUSQUEDA_MS = 250;
const SONDEO_FANOUT_MS = 10_000;
export const columnaDeEstado = (e) => COLUMNAS.find((c) => c.estados.includes(e))?.id || 'mal';
export const CHIP_ESTADO = {
  por_hacer: ['Por hacer', ''], en_cola: ['En cola', ''], en_curso: ['Trabajando', 'est-curso'],
  ok: ['Terminada', 'est-ok'], error: ['Con error', 'est-mal'], cancelada: ['Cancelada', 'est-mal'], interrumpida: ['Interrumpida', 'est-mal']
};
const ICONO_NOTA = 'M2 2.5h10v6.5H6.5L3.5 11.5V9H2z';
const ICONO_CERRAR = 'M3 3l8 8M11 3l-8 8';
const ICONO_BUSCAR = 'M6 1.8a4.2 4.2 0 1 0 0 8.4a4.2 4.2 0 1 0 0-8.4M9.2 9.2L12.5 12.5';
export const ICONO_POR_HACER = 'M2.5 2.5h9v9h-9z';
const ICONO_FANOUT = 'M3 2.5v3.5a2 2 0 0 0 2 2h4a2 2 0 0 1 2 2v1.5M3 6v5.5M11 2.5v1';
const ICONO_TRABAJO = 'M2 3.5h10v7H2zM4.5 6l1.5 1.5L4.5 9M7.5 9H10';
const SUB_DE_ESTADO = { ok: 'sub-ok', en_curso: 'sub-corriendo', en_cola: 'sub-corriendo', error: 'sub-error', cancelada: 'sub-error', interrumpida: 'sub-error' };
const enc = encodeURIComponent;
export const normalizar = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// ── Estado ────────────────────────────────────────────────────────────────
export const tablero = signal(null);
/** El SSE muta `tablero` en su lugar: esto avisa a las columnas (en un solo redibujo por ráfaga). */
const versionTablero = signal(0);
let tocarPendiente = null;
export function tocarTablero() {
  if (tocarPendiente) return;
  tocarPendiente = setTimeout(() => { tocarPendiente = null; versionTablero.value++; }, 200);
}
const FILTRO_VACIO = { quien: 'todo', proyecto: '', origen: '', hoy: false, archivadas: false, agrupar: false, q: '' };
export const filtro = persistente('tablero.filtro', FILTRO_VACIO, {
  validar: (v) => v && typeof v === 'object' && typeof v.quien === 'string' && typeof v.q === 'string' && v.q.length <= TOPE_BUSQUEDA
});
export const busqueda = signal({ seq: 0, ids: null, error: null });
export const detalle = signal(null);
export const fanout = signal(null);
export const lotes = signal(null);
const nueva = persistente('tablero.nueva', { titulo: '', pedido: '' }, {
  validar: (v) => v && typeof v.titulo === 'string' && typeof v.pedido === 'string' && v.pedido.length <= TOPE_PEDIDO_TARJETA
});

/** Lo que el tablero le pide al resto de la consola (lo arma app.js). */
let acc = { escuchar: () => {}, workspaces: async () => [], proveedores: () => null, cargarProveedores: async () => {} };
export function configurarTablero(a) { acc = { ...acc, ...a }; }

const cambiarFiltro = (cambios) => { filtro.value = { ...filtro.value, ...cambios }; };

// ── Carga ─────────────────────────────────────────────────────────────────
export async function cargarTablero() {
  try {
    tablero.value = (await api('/api/tareas')).tareas;
  } catch (err) {
    tablero.value = { error: err.message };
  }
}

let fanoutEnVuelo = false;
export async function cargarFanout() {
  if (fanoutEnVuelo) return;
  fanoutEnVuelo = true;
  try {
    const [f, l] = await Promise.allSettled([api('/api/fanout'), api('/api/lotes')]);
    fanout.value = f.status === 'fulfilled' ? f.value : { error: f.reason.message };
    lotes.value = l.status === 'fulfilled' ? l.value : { error: l.reason.message };
  } catch (err) {
    fanout.value = { error: err.message };
  } finally {
    fanoutEnVuelo = false;
  }
  const d = detalle.value;
  if (d?.id.startsWith('c:') || d?.tarea?.loteId) cargarDetalle();
}
// Los archivos de estado del fan-out los escribe el MCP: no hay aviso por SSE.
setInterval(() => {
  if (ruta.value.vista === 'tablero' && document.visibilityState === 'visible') cargarFanout();
}, SONDEO_FANOUT_MS);
document.addEventListener('visibilitychange', () => {
  if (ruta.value.vista === 'tablero' && document.visibilityState === 'visible') cargarFanout();
});

// D9 — La búsqueda va al servidor; solo vale la respuesta del último pedido.
let esperaBusqueda = null;
export function programarBusqueda(ms = ESPERA_BUSQUEDA_MS) {
  clearTimeout(esperaBusqueda);
  const seq = busqueda.value.seq + 1;
  const q = filtro.value.q.trim();
  if (!q) { busqueda.value = { seq, ids: null, error: null }; return; }
  busqueda.value = { ...busqueda.value, seq };
  esperaBusqueda = setTimeout(async () => {
    let ids = null;
    let error = null;
    try {
      ids = new Set((await api(`/api/tareas?q=${enc(q)}`)).tareas.map((t) => t.id));
    } catch (err) {
      error = err.message;
    }
    if (seq !== busqueda.value.seq) return;
    busqueda.value = { seq, ids, error };
  }, ms);
}
/** Una tarjeta borrada sale también de lo encontrado. */
export function olvidarDeBusqueda(id) {
  const b = busqueda.value;
  if (!b.ids?.has(id)) return;
  const ids = new Set(b.ids);
  ids.delete(id);
  busqueda.value = { ...b, ids };
}

// ── Detalle ───────────────────────────────────────────────────────────────
let detalleSeq = 0;
export function abrirDetalle(id, { url = true } = {}) {
  if (detalle.value?.id !== id) detalle.value = { id, tarea: null, lote: null, error: null };
  if (url) history.replaceState(null, '', `/tablero?t=${enc(id)}`);
  if (!id.startsWith('f:')) cargarDetalle();
  requestAnimationFrame(() => document.querySelector('#detalle .detalle-cerrar')?.focus());
}
export function cerrarDetalle({ url = true } = {}) {
  const id = detalle.value?.id;
  detalle.value = null;
  if (url && location.search) history.replaceState(null, '', '/tablero');
  if (id) requestAnimationFrame(() => document.querySelector(`.tarjeta[data-id="${CSS.escape(id)}"] .tarjeta-abrir`)?.focus());
}
export async function cargarDetalle() {
  const d = detalle.value;
  if (!d || d.id.startsWith('f:')) return;
  const seq = ++detalleSeq;
  const vigente = () => seq === detalleSeq && detalle.value?.id === d.id;
  try {
    const esLote = d.id.startsWith('c:');
    const r = await api(esLote ? `/api/lotes/${enc(d.id.slice(2))}` : `/api/tareas/${enc(d.id)}`);
    if (!vigente()) return;
    detalle.value = esLote ? { ...detalle.value, lote: r.lote, error: null } : { ...detalle.value, tarea: r.tarea, error: null };
  } catch (err) {
    if (!vigente()) return;
    detalle.value = { ...detalle.value, tarea: null, error: err.message };
  }
}
let detallePendiente = null;
function programarDetalle() {
  clearTimeout(detallePendiente);
  detallePendiente = setTimeout(cargarDetalle, 150);
}
/**
 * Lo que llega por SSE es un resumen: si cambió algo que no trae (estado,
 * notas, historial) se pide la tarea; si solo avanzó la actividad, alcanza.
 */
export function alCambiarTareaAbierta(t) {
  const d = detalle.value;
  // FEAT-059 — Una hija o una orquestación de la tarjeta abierta cambian su familia (se recalcula del tablero).
  if (!d || d.id !== t.id || !d.tarea) return;
  const cambio = d.tarea.estado !== t.estado
    || Boolean(d.tarea.archivada) !== Boolean(t.archivada)
    || (d.tarea.notas?.length || 0) !== t.cantidadNotas
    || d.tarea.eventos?.at(-1)?.t !== t.ultimoEvento?.t;
  if (cambio) { programarDetalle(); return; }
  detalle.value = { ...d, tarea: { ...d.tarea, actividad: t.actividad } };
}

// ── Filtros ───────────────────────────────────────────────────────────────
function pasaArchivo(x, f, b) {
  // FEAT-068 — Sin «ver archivadas», una archivada solo aparece si la búsqueda la devolvió.
  if (f.archivadas) return Boolean(x.archivada);
  return !x.archivada || Boolean(b.ids?.has(x.id));
}
const claveDeSujeto = (s) => (s.tipo === 'alma' ? `alma:${s.clave}` : `agente:${s.nombre}`);
function pasaQuien(x, f) {
  if (['alma', 'agente', 'trabajo'].includes(f.quien)) return x.sujeto?.tipo === f.quien;
  if (f.quien !== 'todo') return Boolean(x.sujeto) && x.sujeto.tipo !== 'trabajo' && claveDeSujeto(x.sujeto) === f.quien;
  return true;
}
function pasaResto(x, f, b) {
  if (f.proyecto && x.proyecto !== f.proyecto) return false;
  if (f.origen && x.origen !== f.origen) return false;
  if (b.ids && !b.ids.has(x.id)) return false;
  return true;
}
export function pasaFiltros(x, f = filtro.value, b = busqueda.value) {
  if (f.hoy) {
    const inicio = new Date();
    inicio.setHours(0, 0, 0, 0);
    const cuando = x.lote ? x.actualizado || x.iniciado : x.actualizada || x.creada;
    if (!(Date.parse(cuando) >= inicio.getTime())) return false;
  }
  if (x.lote) {
    // Un lote viene de Claude Code: no es de la web ni de Telegram, y no se archiva.
    if (f.archivadas || f.origen || (f.quien !== 'todo' && f.quien !== 'fanout')) return false;
    if (f.proyecto && x.workspace.nombre !== f.proyecto) return false;
    const q = normalizar(f.q.trim());
    return !q || normalizar([x.slug, ...x.tareas.map((t) => t.id)].join(' ')).includes(q);
  }
  if (f.quien === 'fanout') return false;
  if (!pasaArchivo(x, f, b)) return false;
  if (f.quien === 'propuestas') return Boolean(x.propuesta) && pasaResto(x, f, b);
  return pasaQuien(x, f) && pasaResto(x, f, b);
}

// ── Lotes ─────────────────────────────────────────────────────────────────
// D12 — Un lote es una tarjeta madre, en la columna de su estado.
function loteDeTablero(l) {
  const cuenta = (e) => l.tareas.filter((t) => t.estado === e).length;
  const ok = cuenta('ok');
  const errores = cuenta('error');
  let columna = 'cola';
  if (l.estado === 'activo') columna = 'curso';
  else if (errores) columna = 'mal';
  else if (l.estado === 'terminado' || (l.tareas.length && ok === l.tareas.length)) columna = 'ok';
  return { ...l, lote: true, id: `f:${l.workspace.id}:${l.slug}`, columna, ok, errores };
}
// BE-098 — Un lote confinado también escribe el estado de fan-out: su vista es la del lote.
export const esFanoutDeLote = (f, confinados) => confinados.some((c) => c.id === f.slug && String(c.workspace?.id) === String(f.workspace?.id));
const lotesConfinados = () => (Array.isArray(lotes.value?.lotes) ? lotes.value.lotes : []);
const loteConfinadoPorId = (id) => lotesConfinados().find((l) => l.id === id) || null;
const lotesDeTablero = () => (Array.isArray(fanout.value?.lotes) ? fanout.value.lotes : [])
  .filter((f) => !esFanoutDeLote(f, lotesConfinados()))
  .map(loteDeTablero);
function loteConfinadoDeTablero(l) {
  const activos = ['corriendo', 'verificando', 'auditando'];
  const columna = activos.includes(l.estado) ? 'curso' : ['para revisar', 'descartado', 'integrado'].includes(l.estado) ? 'ok' : 'mal';
  return { ...l, slug: l.id, lote: true, confinado: true, idApi: l.id, id: `c:${l.id}`, columna,
    ok: l.tareas.filter((t) => t.commitCorto).length, errores: l.tareas.filter((t) => /fall|error|interrump/.test(t.estado)).length };
}
const lotesConfinadosDeTablero = () => lotesConfinados().filter((l) => !l.madreId && l.estado !== 'descartado').map(loteConfinadoDeTablero);
const enCursoSub = (st) => st.estado === 'corriendo' || st.estado === 'reintentando';

// ── Sujetos y familia ──────────────────────────────────────────────────────
export function nombreDeSujeto(s) {
  if (s?.tipo === 'alma') return s.voz || s.clave;
  if (s?.tipo === 'agente') return s.nombre;
  return `trabajo · ${s?.modo === 'plan' ? 'plan' : 'run'}`;
}
function AvatarDeSujeto({ s }) {
  if (s?.tipo === 'alma' || s?.tipo === 'agente') return html`<${Avatar} s=${s} />`;
  return html`<div class="avatar agente" aria-hidden="true"><${Icono} d=${ICONO_TRABAJO} tam=${12} /></div>`;
}
function rutaDeSujeto(s) {
  if (s?.tipo === 'alma') return `/alma/${enc(s.clave)}`;
  if (s?.tipo === 'agente') return `/agente/${enc(s.nombre)}`;
  return null;
}
export const tituloDe = (t) => t.titulo || String(t.pedido || '').split('\n').find((l) => l.trim())?.trim().slice(0, 90) || '(sin pedido)';
const vozDeAlma = (clave) => sujetos.value.almas.find((a) => a.clave === clave)?.voz || clave;
// FEAT-058 — `alma:<clave>` → la voz del alma, si todavía existe.
const autorDe = (a) => (a === 'usuario' ? 'vos' : /^alma:/.test(a || '') ? vozDeAlma(a.slice(5)) : String(a || '').replace(/^agente:/, ''));
// FEAT-059 — Proponen las almas y los agentes orquestadores.
export const esPropuesta = (t) => Boolean(t.propuesta) && /^(alma|agente):/.test(t.creadaPor || '');
const devolvible = (t) => ['error', 'cancelada', 'interrumpida'].includes(t.estado) && t.motivo !== 'orquestar'
  && t.motivo !== 'reaccion' && t.carril !== 'principal' && (t.sujeto?.tipo === 'alma' || t.sujeto?.tipo === 'agente');
const tareasDelTablero = () => (Array.isArray(tablero.value) ? tablero.value : []);
const hijasDe = (id) => tareasDelTablero().filter((x) => x.motivo === 'hija' && x.madre === id);
const madreDe = (t) => (t.motivo === 'hija' && t.madre ? tareasDelTablero().find((x) => x.id === t.madre) || { id: t.madre } : null);
const partiendo = (id) => tareasDelTablero().find((x) => x.motivo === 'orquestar' && x.madre === id && (x.estado === 'en_cola' || x.estado === 'en_curso'));
const terminadas = (hijas) => hijas.filter((h) => h.estado === 'ok').length;
// BE-105 — Una madre con hijas en Por hacer, en cola o en curso, o partiéndose, no corre como tarea común.
function motivoMadre(id) {
  if (partiendo(id)) return 'Se está partiendo en hijas.';
  const actuales = hijasDe(id).filter((h) => ['por_hacer', 'en_cola', 'en_curso'].includes(h.estado)).length;
  return actuales ? `Es madre de ${actuales} hija(s): lanzalas como lote (Preparar lote…) o de a una.` : null;
}
function motivoNoLanzable(t) {
  if (t.loteId) return `Vinculada al lote ${t.loteId}.`;
  const deMadre = motivoMadre(t.id);
  if (deMadre) return deMadre;
  if (!t.sujeto) return 'Asignala a un alma o a un agente para lanzarla.';
  if (t.sujeto.tipo === 'agente' && !t.workspaceId) return 'Elegí sobre qué proyecto trabaja el agente.';
  return null;
}

// ── Acciones ──────────────────────────────────────────────────────────────
async function accion(ruta, cuerpo, ok) {
  try {
    const r = await api(ruta, cuerpo);
    if (ok) avisar(typeof ok === 'function' ? ok(r) : ok);
    return r;
  } catch (err) {
    avisar(err.message, 'error');
    return null;
  }
}
const lanzarTarjeta = (id) => accion(`/api/tarjetas/${enc(id)}/lanzar`, {}, 'Lanzada: entró a la cola.');
const cancelarTarea = (id) => accion(`/api/tareas/${enc(id)}/cancelar`, {}, (r) => (r.accion === 'quitada' ? 'Quitada de la cola.' : 'Cancelada.'));
const reintentarTarea = (id) => accion(`/api/tareas/${enc(id)}/reintentar`, {}, 'Reintentando.');
const aceptarPropuesta = (id) => accion(`/api/tarjetas/${enc(id)}/aceptar`, {}, 'Aceptada: ya es una tarjeta tuya.');
const archivarTarea = (id, archivar = true) => accion(`/api/tareas/${enc(id)}/${archivar ? 'archivar' : 'desarchivar'}`, {}, archivar ? 'Tarjeta archivada.' : 'Tarjeta desarchivada.');
const archivarVarias = (ids) => accion('/api/tareas/archivar', { ids }, (r) => (r.archivadas.length === 1 ? 'Se archivó 1 tarjeta.' : `Se archivaron ${r.archivadas.length} tarjetas.`));
async function devolverTarea(id) {
  const r = await accion(`/api/tareas/${enc(id)}/devolver`, {}, 'Volvió a Por hacer como una tarjeta nueva.');
  if (r) abrirDetalle(r.tarea.id);
}
async function borrarTarjeta(t, aviso) {
  const r = await accion(`/api/tarjetas/${enc(t.id)}/borrar`, {}, aviso);
  if (r && detalle.value?.id === t.id) cerrarDetalle();
}
async function detenerSubtarea(l, st) {
  const r = await accion('/api/fanout/detener', { workspaceId: l.workspace.id, lote: l.slug, tarea: st.id }, `Se pidió detener ${st.id}: el lote la corta en su próximo chequeo.`);
  if (r) cargarFanout();
}

// ── FEAT-138: mover tarjetas ──────────────────────────────────────────────
/**
 * Arrastrar (o «Mover a…») entre columnas usa una acción que ya existe. Las
 * columnas Trabajando y Terminado nunca son destino: las decide el ejecutor.
 * Decisión del usuario (2026-10-07).
 */
export const TRANSICIONES = Object.freeze({
  'hacer→cola': { accion: 'lanzar', confirmar: true, nivel: 'ejecutar', texto: 'Lanzar', a: 'En cola' },
  'cola→mal': { accion: 'cancelar', confirmar: true, nivel: 'operar', texto: 'Quitar de la cola', a: 'Con error o cancelado' },
  'curso→mal': { accion: 'cancelar', confirmar: true, nivel: 'operar', texto: 'Cancelar', a: 'Con error o cancelado' },
  'mal→hacer': { accion: 'devolver', confirmar: false, nivel: 'operar', texto: 'Volver a Por hacer', a: 'Por hacer' },
  'mal→cola': { accion: 'reintentar', confirmar: false, nivel: 'ejecutar', texto: 'Reintentar', a: 'En cola' }
});
const EJECUTAR = { lanzar: (t) => lanzarTarjeta(t.id), cancelar: (t) => cancelarTarea(t.id), devolver: (t) => devolverTarea(t.id), reintentar: (t) => reintentarTarea(t.id) };

/** En la vista «Todos» (FEAT-090) las acciones irían al daemon local: ahí no se mueve nada. */
export const motivoSinMover = () => (nodo.value === 'todos' ? 'Elegí un nodo para mover tarjetas: «Todos» es solo para mirar.' : null);

/** Por qué esta tarjeta no puede hacer esta transición, o `null` si puede. */
export function motivoTransicion(t, tr) {
  const general = motivoSinMover();
  if (general) return general;
  if (!alcanza(tr.nivel)) return motivoRemoto();
  if (tr.accion === 'lanzar') return motivoNoLanzable(t);
  if (tr.accion === 'cancelar') return t.carril === 'principal' ? 'El trabajo de /run y /plan se maneja desde Telegram.' : null;
  if (tr.accion === 'reintentar') return reintentable(t) ? null : 'Esta tarea no se puede reintentar.';
  if (tr.accion === 'devolver') return devolvible(t) ? null : 'Esta tarea no vuelve a Por hacer.';
  return null;
}

/** Los destinos de una tarjeta, con su motivo si no se puede (el menú los muestra deshabilitados). */
export function destinosDe(t) {
  const desde = columnaDeEstado(t.estado);
  return Object.entries(TRANSICIONES).filter(([k]) => k.startsWith(`${desde}→`))
    .map(([k, tr]) => ({ ...tr, hasta: k.split('→')[1], motivo: motivoTransicion(t, tr) }));
}

/** El orden de Por hacer: el mismo que `tareas.js` (`posicion`; a igual posición, la más reciente). */
export const porPosicion = (a, b) => (a.posicion ?? 0) - (b.posicion ?? 0)
  || String(b.actualizada || b.creada || '').localeCompare(String(a.actualizada || a.creada || ''));
const columnaHacer = () => tareasDelTablero().filter((x) => x.estado === 'por_hacer').sort(porPosicion);

/** Reordenar Por hacer: `antes`/`despues` son las vecinas donde queda. Sin optimismo: el orden llega por SSE. */
export const moverEnHacer = (id, antes, despues) => accion(`/api/tarjetas/${enc(id)}/mover`, { antes, despues }, null);

/** Subir, bajar o llevar arriba de todo, sobre la columna entera (no sobre lo filtrado). */
function movidasDeHacer(t) {
  const col = columnaHacer();
  const i = col.findIndex((x) => x.id === t.id);
  if (i < 0) return [];
  return [
    { texto: 'Arriba de todo', hacer: () => moverEnHacer(t.id, null, col[0].id), no: i === 0 },
    { texto: 'Subir', hacer: () => moverEnHacer(t.id, i >= 2 ? col[i - 2].id : null, col[i - 1]?.id ?? null), no: i === 0 },
    { texto: 'Bajar', hacer: () => moverEnHacer(t.id, col[i + 1]?.id ?? null, col[i + 2]?.id ?? null), no: i === col.length - 1 }
  ];
}

/**
 * «Mover a…»: lo mismo que arrastrar, para el teléfono, el teclado y un lector
 * de pantalla. Solo los destinos de la tabla; lanzar y cancelar confirman.
 */
export function MenuMover({ t, clase = 'accion secundaria' }) {
  const [abierto, setAbierto] = useState(false);
  const [confirmando, setConfirmando] = useState(null);
  const raiz = useRef(null);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (ev) => { if (!raiz.current?.contains(ev.target)) { setAbierto(false); setConfirmando(null); } };
    const tecla = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); setAbierto(false); setConfirmando(null); } };
    document.addEventListener('pointerdown', fuera, true);
    document.addEventListener('keydown', tecla, true);
    return () => { document.removeEventListener('pointerdown', fuera, true); document.removeEventListener('keydown', tecla, true); };
  }, [abierto]);
  if (motivoSinMover()) return null;
  const destinos = destinosDe(t);
  const orden = t.estado === 'por_hacer' ? movidasDeHacer(t) : [];
  if (!destinos.length && !orden.length) return null;
  const cerrar = () => { setAbierto(false); setConfirmando(null); };
  const elegir = (d) => {
    if (d.confirmar) { setConfirmando(d); return; }
    cerrar();
    EJECUTAR[d.accion](t);
  };
  const lista = confirmando
    ? html`<p class="menu-nota">${confirmando.accion === 'lanzar' ? '¿Lanzar' : '¿Cancelar'} «${tituloDe(t)}»?</p>
        <button type="button" role="menuitem" class="peligro" data-nivel=${confirmando.nivel === 'ejecutar' ? 'ejecutar' : undefined}
          onClick=${() => { const d = confirmando; cerrar(); EJECUTAR[d.accion](t); }}>${confirmando.texto}</button>
        <button type="button" role="menuitem" onClick=${() => setConfirmando(null)}>No</button>`
    : html`${destinos.map((d) => html`<button key=${d.accion} type="button" role="menuitem" disabled=${Boolean(d.motivo)} title=${d.motivo || `A ${d.a}`}
            data-nivel=${d.nivel === 'ejecutar' ? 'ejecutar' : undefined} onClick=${() => elegir(d)}>${d.texto}<span class="tenue">${` → ${d.a}`}</span></button>`)}
        ${orden.map((o) => html`<button key=${o.texto} type="button" role="menuitem" disabled=${o.no} onClick=${() => { cerrar(); o.hacer(); }}>${o.texto}</button>`)}`;
  return html`<span class="menu-mover" ref=${raiz} onClick=${(e) => e.stopPropagation()}>
    <button type="button" class=${clase} aria-haspopup="menu" aria-expanded=${String(abierto)} onClick=${() => { setAbierto(!abierto); setConfirmando(null); }}>Mover a…</button>
    ${abierto ? html`<div class="menu menu-mover-lista" role="menu">${lista}</div>` : null}
  </span>`;
}

// ── FEAT-138 F2: arrastrar ────────────────────────────────────────────────
/** Con un filtro o una búsqueda, las vecinas visibles no son todas: no se reordena. */
const hayOcultasEnHacer = () => columnaHacer().some((x) => !pasaFiltros(x));

/** Si `t` se puede soltar en `hasta`: `null` sí; un motivo, no; `''`, neutro (su propia columna). */
export function validarDestino(t, desde, hasta) {
  const general = motivoSinMover();
  if (general) return general;
  if (desde === hasta) {
    if (hasta !== 'hacer') return '';
    return hayOcultasEnHacer() ? 'Con un filtro o una búsqueda activa no se reordena: hay tarjetas que no se ven.' : null;
  }
  const tr = TRANSICIONES[`${desde}→${hasta}`];
  if (!tr) {
    if (hasta === 'curso') return 'Trabajando lo decide el ejecutor.';
    if (hasta === 'ok') return 'Terminado lo marca un resultado real.';
    return 'Desde acá no se mueve a esa columna.';
  }
  return motivoTransicion(t, tr);
}

/** Una tarjeta se arrastra si tiene algún lugar adonde ir (en Por hacer, también para reordenarla). */
export function arrastrable(t) {
  if (motivoSinMover() || t.loteId) return false;
  if (t.estado === 'por_hacer') return true;
  return destinosDe(t).some((d) => !d.motivo);
}

/** La confirmación de un arrastre que lanza o cancela: `{ t, tr, hasta }`. */
export const confirmacion = signal(null);

configurarArrastre({
  columnaDe: (t) => columnaDeEstado(t.estado),
  validar: validarDestino,
  soltar: (t, desde, hasta, antes, despues) => {
    if (desde === hasta) { if (hasta === 'hacer') moverEnHacer(t.id, antes, despues); return; }
    const tr = TRANSICIONES[`${desde}→${hasta}`];
    if (!tr) return;
    if (tr.confirmar) confirmacion.value = { t, tr, hasta };
    else EJECUTAR[tr.accion](t);
  }
});

/** La confirmación en línea, arriba de la columna donde se soltó. Esc o «No» la descartan; el foco va a «No» (un Enter apurado no lanza). */
function ConfirmarSoltar({ c }) {
  const no = useRef(null);
  useEffect(() => {
    no.current?.focus();
    const tecla = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); confirmacion.value = null; } };
    document.addEventListener('keydown', tecla, true);
    return () => document.removeEventListener('keydown', tecla, true);
  }, [c]);
  const hacer = () => { confirmacion.value = null; EJECUTAR[c.tr.accion](c.t); };
  return html`<div class="confirmar-soltar" role="alertdialog" aria-label=${c.tr.texto}>
    <p>${c.tr.accion === 'lanzar' ? '¿Lanzar' : '¿Cancelar'} «${tituloDe(c.t)}»?</p>
    <div class="confirmar-soltar-botones">
      <button type="button" class="boton chico" ref=${no} onClick=${() => { confirmacion.value = null; }}>No</button>
      <button type="button" class=${`boton chico ${c.tr.accion === 'lanzar' ? 'primario' : 'peligro'}`}
        data-nivel=${c.tr.nivel === 'ejecutar' ? 'ejecutar' : undefined} onClick=${hacer}>${c.tr.texto}</button>
    </div>
  </div>`;
}

/** Lo que una tarjeta necesita para arrastrarse: el `onPointerDown`, sus clases y el asa para el dedo. */
function propsArrastre(t) {
  if (!arrastrable(t)) return { clase: '', alPresionar: undefined, asa: null };
  const a = arrastre.value;
  return {
    clase: ` arrastrable${a?.id === t.id ? ' arrastrada' : ''}`,
    alPresionar: (e) => alPresionar(e, t),
    asa: html`<span class="asa-arrastre" aria-hidden="true" title="Arrastrar">⠿</span>`
  };
}

/** Un botón que se deshabilita mientras su acción corre (lanzar no se dispara dos veces). */
function BotonAccion({ texto, alHacer, clase = 'boton', ...resto }) {
  const [ocupado, setOcupado] = useState(false);
  const clic = async (e) => {
    e.stopPropagation();
    setOcupado(true);
    try { await alHacer(); } finally { setOcupado(false); }
  };
  return html`<button type="button" class=${clase} ...${resto} disabled=${resto.disabled || ocupado} onClick=${clic}>${texto}</button>`;
}

// ── Piezas de tarjeta ─────────────────────────────────────────────────────
export function ChipEstado({ t }) {
  const [texto, clase] = CHIP_ESTADO[t.estado] || [t.estado, ''];
  return html`<span class=${`chip-estado ${clase}`}>
    ${t.estado === 'por_hacer' ? html`<${Icono} d=${ICONO_POR_HACER} tam=${10} />` : html`<span class="punto-chip" aria-hidden="true"></span>`}
    ${texto}${t.estado === 'en_curso' ? html` · <${Reloj} desde=${t.iniciada || t.creada} clase="" />` : null}
  </span>`;
}
function CuentaDeNotas({ t }) {
  if (!t.cantidadNotas) return null;
  return html`<span class="notas-cuenta" title=${`${t.cantidadNotas} nota(s)`}><${Icono} d=${ICONO_NOTA} tam=${12} />${String(t.cantidadNotas)}</span>`;
}
function ContadorHijas({ t }) {
  const hijas = hijasDe(t.id);
  if (!hijas.length) return partiendo(t.id) ? html`<span class="notas-cuenta">partiendo…</span>` : null;
  return html`<span class="notas-cuenta" title="Tarjetas hijas terminadas">${terminadas(hijas)}/${hijas.length} hijas</span>`;
}
function EnlaceMadre({ t }) {
  const madre = madreDe(t);
  if (!madre) return null;
  return html`<button type="button" class="accion enlace-madre" title="Abrir la tarjeta madre" onClick=${(e) => { e.stopPropagation(); abrirDetalle(madre.id); }}>↳ hija de ${madre.estado ? tituloDe(madre) : madre.id}</button>`;
}
function Barra({ partes }) {
  return html`<div class="barra-lote" aria-hidden="true">${partes.filter(([, n]) => n).map(([clase, n]) => html`<div key=${clase} class=${`seg ${clase}`} style=${{ flexGrow: String(n) }}></div>`)}</div>`;
}
const barraDeLote = (l) => ['ok', 'corriendo', 'reintentando', 'error', 'pendiente', 'desconocido'].map((e) => [`sub-${e}`, l.tareas.filter((t) => t.estado === e).length]);
const barraDeHijas = (hijas) => ['sub-ok', 'sub-corriendo', 'sub-error', 'sub-pendiente'].map((c) => [c, hijas.filter((h) => (SUB_DE_ESTADO[h.estado] || 'sub-pendiente') === c).length]);
function ChipSubtarea({ st }) {
  let extra = null;
  if (st.estado === 'ok') extra = ' ✓';
  else if (st.estado === 'error') extra = st.detenido ? ' · detenida' : ' ✗';
  else if (st.estado === 'reintentando') extra = ` · reintento ${st.intentos}`;
  else if (st.estado === 'corriendo' && st.inicio) extra = html` · <${Reloj} desde=${st.inicio} clase="" />`;
  return html`<span class=${`chip-sub sub-${st.estado}`}>${st.id}${extra}</span>`;
}

/** La tarjeta entera abre el detalle con el mouse; con el teclado, su título. */
const abrirConClic = (id) => (e) => { if (!e.target.closest('button, a, input, select, textarea')) abrirDetalle(id); };
const seleccion = (id) => {
  const activa = detalle.value?.id === id;
  return { clase: activa ? ' seleccionada' : '', current: activa ? 'true' : null };
};

function TarjetaLote({ l }) {
  const sel = seleccion(l.id);
  return html`<article class=${`tarjeta col-${l.columna} lote${sel.clase}`} data-id=${l.id} aria-current=${sel.current} onClick=${abrirConClic(l.id)}>
    <div class="tarjeta-cabecera">
      <div class="avatar agente" aria-hidden="true"><${Icono} d=${ICONO_FANOUT} tam=${12} /></div>
      <button type="button" class="tarjeta-abrir mono" onClick=${() => abrirDetalle(l.id)}>${l.slug}</button>
      <span class="tarjeta-lado">${l.ok}/${l.tareas.length}</span>
    </div>
    <${Barra} partes=${barraDeLote(l)} />
    <div class="chips-sub">${l.tareas.map((st) => html`<${ChipSubtarea} key=${st.id} st=${st} />`)}</div>
    <div class="tarjeta-meta">${[l.workspace.nombre, l.confinado ? `confinado · ${l.estado}` : 'desde Claude Code', relativo(l.actualizado)].filter(Boolean).join(' · ')}</div>
  </article>`;
}

function TarjetaPorHacer({ t }) {
  const s = t.sujeto;
  const lote = t.loteId ? loteConfinadoPorId(t.loteId) : null;
  const motivo = motivoNoLanzable(t);
  const propuesta = esPropuesta(t);
  const madre = motivoMadre(t.id);
  const sel = seleccion(t.id);
  const claseProp = propuesta ? ` propuesta ${t.creadaPor.startsWith('alma:') ? tono(t.creadaPor.slice(5)) : ''}` : '';
  const arr = propsArrastre(t);
  return html`<article class=${`tarjeta col-hacer${s ? '' : ' sin-sujeto'}${claseProp}${sel.clase}${arr.clase}`} data-id=${t.id} aria-current=${sel.current} onClick=${abrirConClic(t.id)} onPointerDown=${arr.alPresionar}>
    ${arr.asa}
    ${propuesta ? html`<div class="etiqueta-propuesta">Propuesta · ${autorDe(t.creadaPor)}</div>` : null}
    <${EnlaceMadre} t=${t} />
    <button type="button" class="tarjeta-abrir" onClick=${() => abrirDetalle(t.id)}>${tituloDe(t)}</button>
    ${t.titulo ? html`<div class="tarjeta-pedido">${t.pedido}</div>` : null}
    <div class=${`tarjeta-pie ${s?.tipo === 'alma' ? tono(s.clave) : ''}`}>
      ${s ? html`<${AvatarDeSujeto} s=${s} />` : html`<span class="avatar vacante" aria-hidden="true"></span>`}
      <span class=${s ? `recorte${s.tipo === 'agente' ? ' mono' : ' nombre-alma'}` : 'sin-asignar'}>${s ? nombreDeSujeto(s) : 'sin asignar'}</span>
      ${t.proyecto ? html`<span class="mono tenue recorte">· ${t.proyecto}</span>` : null}
      <${CuentaDeNotas} t=${t} />
      <${ContadorHijas} t=${t} />
      ${t.loteId ? html`<button type="button" class="chip-sub" onClick=${() => abrirDetalle(`c:${t.loteId}`)}>lote · ${lote?.estado || 'sin datos'}</button>` : null}
      ${t.loteId ? null : html`<${MenuMover} t=${t} />`}
      ${propuesta ? html`<${BotonDosPasos} clase="accion peligro derecha" texto="Descartar" armado="¿Descartar? Clic de nuevo" alConfirmar=${() => borrarTarjeta(t, 'Propuesta descartada.')} />` : null}
      ${propuesta ? html`<${BotonAccion} clase="boton chico" texto="Aceptar" alHacer=${() => aceptarPropuesta(t.id)} />` : null}
      ${madre
        // BE-105 — Una madre con hijas no se lanza sola: lleva al detalle (navegación, sin data-nivel).
        ? html`<button type="button" class=${`boton primario chico${propuesta ? '' : ' derecha'}`} title=${madre} onClick=${() => abrirDetalle(t.id)}>Preparar lote…</button>`
        : html`<${BotonAccion} clase=${`boton primario chico${propuesta ? '' : ' derecha'}`} data-nivel="ejecutar" texto="Lanzar" disabled=${Boolean(motivo)} title=${motivo || 'Entra a la cola ahora'} alHacer=${() => lanzarTarjeta(t.id)} />`}
    </div>
  </article>`;
}

function Tarjeta({ t }) {
  const columna = columnaDeEstado(t.estado);
  const s = t.sujeto || {};
  const sel = seleccion(t.id);
  let lado;
  if (columna === 'curso') lado = html`<span class="tarjeta-lado vivo"><${Reloj} desde=${t.iniciada || t.creada} clase="" /></span>`;
  else {
    let texto = t.estado;
    if (columna === 'cola') texto = 'en cola';
    else if (columna === 'ok' && t.iniciada && t.terminada) texto = duracion(Date.parse(t.terminada) - Date.parse(t.iniciada));
    else if (t.estado === 'ok') texto = '';
    lado = html`<span class="tarjeta-lado">${texto}</span>`;
  }
  const acciones = [];
  if ((columna === 'cola' || columna === 'curso') && t.carril !== 'principal') {
    acciones.push(html`<${BotonDosPasos} key="c" clase="accion peligro derecha" texto=${columna === 'cola' ? 'quitar' : 'cancelar'} alConfirmar=${() => cancelarTarea(t.id)} />`);
  }
  if (columna === 'mal' && reintentable(t)) acciones.push(html`<button key="r" type="button" class="accion" data-nivel="ejecutar" onClick=${() => reintentarTarea(t.id)}>Reintentar</button>`);
  if (columna === 'mal' && devolvible(t)) acciones.push(html`<button key="d" type="button" class="accion secundaria" onClick=${() => devolverTarea(t.id)}>Volver a Por hacer</button>`);
  if (columna === 'ok' || columna === 'mal') acciones.push(html`<button key="a" type="button" class="accion secundaria" onClick=${() => archivarTarea(t.id, !t.archivada)}>${t.archivada ? 'desarchivar' : 'archivar'}</button>`);
  const meta = [t.proyecto, t.origen === 'web' ? 'desde web' : 'desde Telegram', relativo(t.terminada || t.iniciada || t.creada)].filter(Boolean).join(' · ');
  const arr = propsArrastre(t);
  return html`<article class=${`tarjeta col-${columna} ${s.tipo === 'alma' ? tono(s.clave) : ''}${t.archivada ? ' archivada' : ''}${sel.clase}${arr.clase}`} data-id=${t.id} aria-current=${sel.current} onClick=${abrirConClic(t.id)} onPointerDown=${arr.alPresionar}>
    ${arr.asa}
    <div class="tarjeta-cabecera"><${AvatarDeSujeto} s=${s} /><span class=${`tarjeta-nombre${s.tipo === 'alma' ? '' : ' mono'}`}>${nombreDeSujeto(s)}</span>${lado}</div>
    <button type="button" class=${`tarjeta-abrir${t.titulo ? '' : ' tarjeta-pedido'}`} onClick=${() => abrirDetalle(t.id)}>${t.titulo || t.pedido || '(sin pedido)'}</button>
    ${columna === 'curso' ? html`<div class="barrido" aria-hidden="true"><div></div></div>` : null}
    ${columna === 'curso' && t.actividad?.length ? html`<div class="tarjeta-actividad">${t.actividad.at(-1).texto}</div>` : null}
    ${columna === 'mal' && t.error ? html`<div class="tarjeta-error">${t.error}</div>` : null}
    <${EnlaceMadre} t=${t} />
    <div class="tarjeta-meta">${meta}${t.cantidadNotas ? ' ' : null}<${CuentaDeNotas} t=${t} />${hijasDe(t.id).length || partiendo(t.id) ? ' ' : null}<${ContadorHijas} t=${t} /></div>
    ${acciones.length ? html`<div class="tarjeta-acciones">${acciones}</div>` : null}
  </article>`;
}

// ── Asignar y crear ───────────────────────────────────────────────────────
/** Los workspaces, ordenados con los favoritos primero (una sola carga compartida). */
function useWorkspaces() {
  const [lista, setLista] = useState(null);
  useEffect(() => {
    let vivo = true;
    acc.workspaces().then((l) => { if (vivo) setLista([...l].sort((a, b) => Number(b.favorito) - Number(a.favorito))); }).catch(() => { if (vivo) setLista([]); });
    return () => { vivo = false; };
  }, []);
  return lista;
}

/** La etiqueta de un selector: `filtro-campo` (barra, tarjeta nueva) o `campo` (detalle). Fuera de los componentes que la usan: adentro se re-montaría en cada dibujo (y el select perdería el foco). */
function EtiquetaCampo({ envolver, texto, children }) {
  return envolver === 'campo'
    ? html`<label class="campo"><span class="bloque-titulo">${texto}</span>${children}</label>`
    : html`<label class="filtro-campo">${texto}${children}</label>`;
}

/** «Proyecto»: los workspaces con los favoritos primero; uno que ya no existe se muestra igual. */
function SelectorProyecto({ ws, valor, alCambiar }) {
  return html`<select aria-label="Proyecto" value=${valor} onChange=${(e) => alCambiar(e.currentTarget.value)}>
    ${ws === null ? html`<option value="">cargando…</option>` : html`<option value="">Elegí un proyecto</option>`}
    ${(ws || []).map((w) => html`<option key=${w.id} value=${w.id}>${(w.favorito ? '★ ' : '') + w.nombre}</option>`)}
    ${valor && ws && !ws.some((w) => w.id === valor) ? html`<option value=${valor}>(ya no existe)</option>` : null}
  </select>`;
}

/** El proyecto propuesto: el elegido o, si `predeterminado`, el favorito. */
const proyectoPropuesto = (ws, wsId, predeterminado) => wsId || (predeterminado && ws ? ws.find((w) => w.favorito)?.id || '' : '');

/**
 * «Asignar a» y «Proyecto». Un alma no usa proyecto: el campo se oculta.
 * `alCambiar({ sujeto, workspaceId }, { soloProyecto })`.
 */
export function Asignacion({ valor, wsId, predeterminado = false, alCambiar, envolver = 'filtro', textoProyecto = 'sobre', textoAsignar = 'Asignar a', obligatorio = false }) {
  const ws = useWorkspaces();
  const { almas, agentes } = sujetos.value;
  const conocido = !valor || agentes.some((g) => `agente:${g.nombre}` === valor) || almas.some((a) => `alma:${a.clave}` === valor);
  const esAgente = String(valor || '').startsWith('agente:');
  const proyecto = proyectoPropuesto(ws, wsId, predeterminado);
  // Obligatorio (una programación siempre tiene a quién): sin elegido, el primero de la lista.
  const primero = agentes.length ? `agente:${agentes[0].nombre}` : almas.length ? `alma:${almas[0].clave}` : '';
  useEffect(() => { if (obligatorio && !valor && primero) alCambiar({ sujeto: primero, workspaceId: proyecto }, {}); }, [primero]);
  // Lo propuesto (el favorito) pasa a ser lo elegido: es lo que se manda al guardar.
  useEffect(() => { if (predeterminado && esAgente && proyecto && proyecto !== wsId) alCambiar({ sujeto: valor, workspaceId: proyecto }, { soloProyecto: true }); }, [proyecto, esAgente]);
  return html`
    <${EtiquetaCampo} envolver=${envolver} texto=${textoAsignar}>
      <select aria-label="Asignar a" value=${valor || ''} onChange=${(e) => alCambiar({ sujeto: e.currentTarget.value, workspaceId: proyecto }, {})}>
        ${obligatorio ? null : html`<option value="">Sin asignar</option>`}
        ${agentes.length ? html`<optgroup label="Agentes · solo lectura">${agentes.map((g) => html`<option key=${g.nombre} value=${`agente:${g.nombre}`}>${g.nombre}</option>`)}</optgroup>` : null}
        ${almas.length ? html`<optgroup label="Almas">${almas.map((a) => html`<option key=${a.clave} value=${`alma:${a.clave}`}>${a.voz}</option>`)}</optgroup>` : null}
        ${conocido ? null : html`<option value=${valor}>${valor.slice(valor.indexOf(':') + 1)} (no disponible)</option>`}
      </select>
    <//>
    ${esAgente ? html`<${EtiquetaCampo} envolver=${envolver} texto=${textoProyecto}>
      <${SelectorProyecto} ws=${ws} valor=${proyecto} alCambiar=${(v) => alCambiar({ sujeto: valor, workspaceId: v }, { soloProyecto: true })} />
    <//>` : null}`;
}

function NuevaTarjeta() {
  const [abierta, setAbierta] = useState(false);
  const [asignacion, setAsignacion] = useState({ sujeto: '', workspaceId: '' });
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);
  const titulo = useRef(null);
  const abrirRef = useRef(null);
  const n = nueva.value;
  useEffect(() => { if (abierta) titulo.current?.focus(); }, [abierta]);
  const cerrar = (limpiar) => {
    setAbierta(false);
    setError('');
    if (limpiar) nueva.value = { titulo: '', pedido: '' };
    requestAnimationFrame(() => abrirRef.current?.focus());
  };
  const enviar = async (lanzar) => {
    if (enviando) return;
    if (!n.pedido.trim()) { setError('Falta el pedido.'); return; }
    const cuerpo = { titulo: n.titulo, pedido: n.pedido, sujeto: asignacion.sujeto || null, lanzar };
    if (cuerpo.sujeto?.startsWith('agente:') && asignacion.workspaceId) cuerpo.workspaceId = asignacion.workspaceId;
    setEnviando(true);
    setError('');
    try {
      await api('/api/tarjetas', cuerpo);
      avisar(lanzar ? 'Guardada y lanzada.' : 'Guardada en Por hacer.');
      cerrar(true);
    } catch (err) {
      if (err.datos?.tarea) {
        // Guardar y lanzar: se guardó, pero no se pudo lanzar.
        avisar(`Quedó en Por hacer, pero no se lanzó: ${err.message}`, 'error');
        cerrar(true);
      } else {
        setError(err.message);
      }
    } finally {
      setEnviando(false);
    }
  };
  const teclado = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar(false); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(false); }
  };
  return html`<div class="nueva">
    <button ref=${abrirRef} type="button" class="nueva-tarjeta" id="nueva-tarjeta" hidden=${abierta} onClick=${() => setAbierta(true)}>+ Nueva tarjeta${n.pedido || n.titulo ? ' · borrador' : ''}</button>
    <form class="form-tarjeta" hidden=${!abierta} aria-label="Nueva tarjeta" onSubmit=${(e) => e.preventDefault()} onKeyDown=${teclado}>
      <input ref=${titulo} type="text" maxlength=${String(TOPE_TITULO)} aria-label="Título" placeholder="Título (opcional)" value=${n.titulo} onInput=${(e) => { nueva.value = { ...nueva.value, titulo: e.currentTarget.value }; }} />
      <textarea rows="3" maxlength=${String(TOPE_PEDIDO_TARJETA)} aria-label="Pedido" placeholder="¿Qué hay que hacer?" value=${n.pedido} onInput=${(e) => { nueva.value = { ...nueva.value, pedido: e.currentTarget.value }; }}></textarea>
      ${abierta ? html`<div class="form-fila"><${Asignacion} valor=${asignacion.sujeto} wsId=${asignacion.workspaceId} predeterminado alCambiar=${(v) => setAsignacion({ sujeto: v.sujeto, workspaceId: v.workspaceId || '' })} /></div>` : null}
      <div class="form-fila acciones">
        <span class="tecla">Ctrl+Enter guarda</span>
        <button type="button" class="boton fantasma" onClick=${() => cerrar(false)}>Cancelar</button>
        <button type="button" class="boton" disabled=${enviando} onClick=${() => enviar(false)}>Guardar</button>
        <button type="button" class="boton primario" data-nivel="ejecutar" disabled=${enviando} onClick=${() => enviar(true)}>Guardar y lanzar</button>
      </div>
      <div class="error" aria-live="polite">${error}</div>
    </form>
  </div>`;
}

// ── Columnas ──────────────────────────────────────────────────────────────
function Columnas() {
  void versionTablero.value;
  const lista = tablero.value;
  const f = filtro.value;
  const b = busqueda.value;
  const aviso = lista === null ? 'cargando…' : lista.error || null;
  const porColumna = new Map(COLUMNAS.map((c) => [c.id, []]));
  for (const t of Array.isArray(lista) ? lista.filter((x) => pasaFiltros(x, f, b)) : []) porColumna.get(columnaDeEstado(t.estado)).push(t);
  for (const l of lotesDeTablero().filter((x) => pasaFiltros(x, f, b))) porColumna.get(l.columna).push(l);
  for (const l of lotesConfinadosDeTablero().filter((x) => pasaFiltros(x, f, b))) porColumna.get(l.columna).push(l);
  const clave = (x, ...campos) => String(campos.map((c) => x[c]).find(Boolean) || '');
  const pintar = (x) => (x.lote ? html`<${TarjetaLote} key=${x.id} l=${x} />` : x.estado === 'por_hacer' ? html`<${TarjetaPorHacer} key=${x.id} t=${x} />` : html`<${Tarjeta} key=${x.id} t=${x} />`);
  // FEAT-138 — Mientras se arrastra, cada columna dice si acepta la tarjeta.
  const a = arrastre.value;
  const arrastrada = a ? tareasDelTablero().find((x) => x.id === a.id) : null;
  if (a && (!arrastrada || columnaDeEstado(arrastrada.estado) !== a.desde)) {
    queueMicrotask(() => { cancelarArrastre(); avisar('La tarjeta cambió mientras la arrastrabas.'); });
  }
  const conf = confirmacion.value;

  return html`<div class="columnas" id="columnas">${COLUMNAS.map((c) => {
    let xs = porColumna.get(c.id);
    // FEAT-138 — Por hacer va en el orden que eligió el usuario (`posicion`).
    if (c.id === 'hacer') xs.sort(porPosicion);
    else if (c.id === 'ok' || c.id === 'mal') xs.sort((a, z) => clave(z, 'terminada', 'actualizado', 'creada').localeCompare(clave(a, 'terminada', 'actualizado', 'creada')));
    else xs.sort((a, z) => clave(a, 'creada', 'iniciado').localeCompare(clave(z, 'creada', 'iniciado')));
    const total = xs.length;
    const terminadasCol = c.id === 'ok' || c.id === 'mal';
    // FEAT-068 — N y los ids de la lista filtrada completa, sin lotes ni las ya archivadas.
    const archivables = terminadasCol && !f.archivadas ? xs.filter((x) => !x.lote && !x.archivada).map((x) => x.id) : [];
    if (terminadasCol) xs = xs.slice(0, TOPE_TERMINADAS);
    let cuerpo;
    if (aviso) cuerpo = html`<p class=${lista?.error ? 'error' : 'meta'}>${aviso}</p>`;
    else if (c.id === 'curso' && f.agrupar) {
      const grupos = new Map();
      for (const x of xs) {
        const nombre = x.lote ? 'fan-out' : nombreDeSujeto(x.sujeto);
        if (!grupos.has(nombre)) grupos.set(nombre, []);
        grupos.get(nombre).push(x);
      }
      cuerpo = [...grupos].map(([nombre, ys]) => [html`<div key=${`g-${nombre}`} class="columna-grupo">${nombre}</div>`, ...ys.map(pintar)]);
    } else cuerpo = xs.map(pintar);
    let claseDestino = '';
    let motivoDestino;
    if (a && arrastrada) {
      const m = validarDestino(arrastrada, a.desde, c.id);
      claseDestino = m === null ? ' destino-valido' : m ? ' destino-invalido' : '';
      motivoDestino = m || undefined;
      if (a.sobre === c.id) claseDestino += ' destino-sobre';
      // La línea donde caería, en Por hacer (entre `antes` y `despues`).
      if (c.id === 'hacer' && a.sobre === 'hacer' && m === null && Array.isArray(cuerpo)) {
        const linea = html`<div key="insercion" class="marca-insercion" aria-hidden="true"></div>`;
        const i = a.despues ? cuerpo.findIndex((v) => v?.key === a.despues) : -1;
        cuerpo = i >= 0 ? [...cuerpo.slice(0, i), linea, ...cuerpo.slice(i)] : [...cuerpo, linea];
      }
    }
    return html`<section key=${c.id} class=${`columna col-${c.id}${claseDestino}`} aria-label=${c.titulo} data-columna=${c.id} title=${motivoDestino}>
      <div class="columna-titulo">
        ${c.id === 'hacer' ? html`<span class="marca-hacer" aria-hidden="true"><${Icono} d=${ICONO_POR_HACER} tam=${12} /></span>` : html`<span class=${`marca-estado col-${c.id}`} aria-hidden="true"></span>`}
        ${c.titulo}
        <span class="cuenta">${String(total)}</span>
        ${c.id === 'hacer' ? html`<span class="columna-nota" title=${motivoSinMover() || undefined}>${motivoSinMover() ? 'elegí un nodo para moverlas' : 'no corren hasta lanzarlas'}</span>` : null}
        ${terminadasCol ? html`<span class="columna-accion">${archivables.length
          ? html`<${BotonDosPasos} key=${archivables.length} clase="accion secundaria" texto=${`Archivar ${archivables.length}`} armado=${`¿Archivar ${archivables.length}? Clic de nuevo`} alConfirmar=${() => archivarVarias(archivables)} />`
          : null}</span>` : null}
      </div>
      ${c.id === 'hacer' ? html`<${NuevaTarjeta} />` : null}
      ${conf && conf.hasta === c.id ? html`<${ConfirmarSoltar} c=${conf} />` : null}
      <div class="columna-lista">
        ${cuerpo}
        ${!aviso && !xs.length ? html`<div class="vacio">${c.id === 'hacer' ? 'Nada planeado.' : 'nada'}</div>` : null}
        ${!aviso && total > xs.length ? html`<div class="vacio">y ${total - xs.length} más</div>` : null}
      </div>
    </section>`;
  })}</div>`;
}

// ── FEAT-138 F3: el teléfono ──────────────────────────────────────────────
/** La columna que se miraba en el teléfono, por dispositivo. */
export const columnaVista = persistente('tablero.columna', 'hacer', { validar: (v) => COLUMNAS.some((c) => c.id === v) });
const ANCHO_CARRUSEL = '(max-width: 800px)';

/**
 * Hasta 800 px las columnas son un carrusel (una por pantalla, `scroll-snap`)
 * con pestañas arriba; más ancho, las pestañas no se ven y nada cambia.
 * Arrastrar cerca del borde pasa a la columna de al lado (tablero-arrastre.js).
 */
function CarruselColumnas() {
  const envoltura = useRef(null);
  const carril = () => envoltura.current?.querySelector('#columnas');
  const irA = (id, suave = true) => {
    const col = carril()?.querySelector(`[data-columna="${id}"]`);
    col?.scrollIntoView({ behavior: suave ? 'smooth' : 'auto', block: 'nearest', inline: 'center' });
  };
  useEffect(() => {
    const c = carril();
    if (!c || !matchMedia(ANCHO_CARRUSEL).matches) return undefined;
    irA(columnaVista.value, false);
    let pendiente = null;
    const alDesplazar = () => {
      clearTimeout(pendiente);
      pendiente = setTimeout(() => {
        const cols = [...c.querySelectorAll('[data-columna]')];
        const izq = c.getBoundingClientRect().left;
        const cerca = cols.reduce((m, x) => (Math.abs(x.getBoundingClientRect().left - izq) < Math.abs(m.getBoundingClientRect().left - izq) ? x : m), cols[0]);
        if (cerca && columnaVista.value !== cerca.dataset.columna) columnaVista.value = cerca.dataset.columna;
      }, 120);
    };
    c.addEventListener('scroll', alDesplazar, { passive: true });
    return () => { clearTimeout(pendiente); c.removeEventListener('scroll', alDesplazar); };
  }, []);
  void versionTablero.value;
  const lista = tareasDelTablero();
  // Lo mismo que cuenta cada columna: tareas y lotes que pasan los filtros.
  const lotesVisibles = [...lotesDeTablero(), ...lotesConfinadosDeTablero()].filter((l) => pasaFiltros(l));
  const cuenta = (id) => lista.filter((x) => columnaDeEstado(x.estado) === id && pasaFiltros(x)).length + lotesVisibles.filter((l) => l.columna === id).length;
  const actual = columnaVista.value;
  return html`<div class="columnas-envoltura" ref=${envoltura}>
    <nav class="pestanas-columnas" aria-label="Columnas del tablero">
      ${COLUMNAS.map((c) => html`<button key=${c.id} type="button" class=${c.id === actual ? 'activa' : undefined} aria-current=${c.id === actual ? 'true' : undefined}
        onClick=${() => { columnaVista.value = c.id; irA(c.id); }}>${c.titulo}<span class="cuenta">${String(cuenta(c.id))}</span></button>`)}
    </nav>
    <${Columnas} />
  </div>`;
}

// ── Filtros (barra) ───────────────────────────────────────────────────────
function Filtros() {
  const f = filtro.value;
  const { almas, agentes } = sujetos.value;
  const nombres = new Set();
  for (const t of tareasDelTablero()) if (t.proyecto) nombres.add(t.proyecto);
  for (const l of Array.isArray(fanout.value?.lotes) ? fanout.value.lotes : []) nombres.add(l.workspace.nombre);
  if (f.proyecto) nombres.add(f.proyecto);
  const quienes = [
    ['todo', 'Todos'], ['alma', 'Almas'], ['agente', 'Agentes'], ['trabajo', 'Trabajo'], ['fanout', 'Fan-out'], ['propuestas', 'Propuestas']
  ];
  const quienValido = quienes.some(([v]) => v === f.quien) || almas.some((a) => `alma:${a.clave}` === f.quien) || agentes.some((g) => `agente:${g.nombre}` === f.quien);
  const quien = quienValido ? f.quien : 'todo';
  const activos = [quien !== 'todo', f.proyecto, f.origen, f.hoy, f.archivadas, f.q.trim()].filter(Boolean).length;
  const buscar = (q) => { cambiarFiltro({ q }); programarBusqueda(); };
  return html`<div class="tablero-filtros" role="toolbar" aria-label="Filtros del tablero">
    <label class="buscador"><${Icono} d=${ICONO_BUSCAR} />
      <input type="search" id="tablero-buscar" maxlength=${String(TOPE_BUSQUEDA)} autocomplete="off" spellcheck="false" aria-label="Buscar en el tablero" placeholder="Buscar en pedidos, títulos y notas"
        value=${f.q} onInput=${(e) => buscar(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Escape' && f.q) { e.preventDefault(); e.stopPropagation(); buscar(''); } }} />
      <span class="tecla">/</span></label>
    <label class="filtro-campo">Quién
      <select id="filtro-quien" class=${quien !== 'todo' ? 'activo' : null} value=${quien} onChange=${(e) => cambiarFiltro({ quien: e.currentTarget.value })}>
        ${quienes.map(([v, t]) => html`<option key=${v} value=${v}>${t}</option>`)}
        ${almas.length ? html`<optgroup label="Almas">${almas.map((a) => html`<option key=${a.clave} value=${`alma:${a.clave}`}>${a.voz}</option>`)}</optgroup>` : null}
        ${agentes.length ? html`<optgroup label="Agentes">${agentes.map((g) => html`<option key=${g.nombre} value=${`agente:${g.nombre}`}>${g.nombre}</option>`)}</optgroup>` : null}
      </select></label>
    <label class="filtro-campo">Proyecto
      <select id="filtro-proyecto" class=${f.proyecto ? 'activo' : null} value=${f.proyecto} onChange=${(e) => cambiarFiltro({ proyecto: e.currentTarget.value })}>
        <option value="">Todos</option>${[...nombres].sort().map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
      </select></label>
    <label class="filtro-campo">Origen
      <select id="filtro-origen" class=${f.origen ? 'activo' : null} value=${f.origen} onChange=${(e) => cambiarFiltro({ origen: e.currentTarget.value })}>
        <option value="">Web y Telegram</option><option value="web">Web</option><option value="telegram">Telegram</option>
      </select></label>
    <button type="button" class="filtro" id="filtro-hoy" aria-pressed=${String(f.hoy)} onClick=${() => cambiarFiltro({ hoy: !f.hoy })}>Hoy</button>
    <button type="button" class="filtro" id="filtro-archivadas" aria-pressed=${String(f.archivadas)} onClick=${() => cambiarFiltro({ archivadas: !f.archivadas })}>Ver archivadas</button>
    <span class="filtro-separador"></span>
    <label class="filtro-campo"><input type="checkbox" id="filtro-agrupar" checked=${f.agrupar} onChange=${(e) => cambiarFiltro({ agrupar: e.currentTarget.checked })} />Agrupar por quién</label>
    <span class="filtros-activos" id="filtros-activos">${activos
      ? html`${activos} ${activos === 1 ? 'filtro activo' : 'filtros activos'} · <button type="button" class="accion" onClick=${() => { filtro.value = { ...FILTRO_VACIO, agrupar: f.agrupar }; programarBusqueda(); }}>limpiar</button>`
      : null}</span>
  </div>`;
}

function NotaTablero() {
  const partes = [];
  const f = fanout.value;
  if (f?.error) partes.push(`Fan-out: ${f.error}`);
  else if (f?.lentos?.length) partes.push(`Fan-out sin respuesta de ${f.lentos.join(', ')}.`);
  if (lotes.value?.error) partes.push(`Lotes confinados: ${lotes.value.error}`);
  else if (lotes.value?.ilegibles) partes.push(`${lotes.value.ilegibles} registro(s) de lote ilegible(s) en disco.`);
  if (busqueda.value.error) partes.push(`Búsqueda: ${busqueda.value.error}`);
  return html`<div class="tablero-nota tenue" id="tablero-nota" aria-live="polite">${partes.join(' ')}</div>`;
}

// ── Detalle ───────────────────────────────────────────────────────────────
const BotonCerrar = () => html`<button type="button" class="boton-icono detalle-cerrar" aria-label="Cerrar detalle (Esc)" title="Cerrar (Esc)" onClick=${() => cerrarDetalle()}><${Icono} d=${ICONO_CERRAR} tam=${12} /></button>`;
const Titulo = ({ children }) => html`<div class="bloque-titulo">${children}</div>`;

function textoDeEvento(e, t) {
  switch (e.tipo) {
    case 'creada': return t.creadaPor === 'usuario' ? 'Creada en Por hacer' : 'Entró a la cola';
    case 'editada': return 'Editada';
    case 'propuesta': return `Propuesta por ${autorDe(e.detalle || t.creadaPor)}`;
    case 'aceptada': return 'Aceptada';
    case 'partida': return 'Se pidió partirla en tarjetas';
    case 'hija': return 'Nueva tarjeta hija';
    case 'madre_borrada': return `Se borró su tarjeta madre · ${e.detalle}`;
    case 'madre_cerrada': return `Su tarjeta madre terminó sin lote: quedó independiente · ${e.detalle}`;
    case 'lote_lanzado': return `Lote lanzado · ${e.detalle}`;
    case 'incluida_en_lote': return `Incluida en lote · ${e.detalle}`;
    case 'lote_descartado': return `Lote descartado · ${e.detalle}`;
    case 'lanzada': return `Lanzada · entró a la cola${t.carril ? ` del carril ${t.carril === 'alma' ? 'charla' : t.carril}` : ''}`;
    case 'en_curso': return 'En curso';
    case 'ok': return 'Terminada';
    case 'error': return 'Con error';
    case 'cancelada': return 'Cancelada';
    case 'interrumpida': return 'Interrumpida por un reinicio del daemon';
    case 'nota': return 'Nota agregada';
    case 'archivada': return 'Archivada';
    case 'desarchivada': return 'Desarchivada';
    case 'devuelta': return e.detalle && e.detalle === t.madre ? 'Vino de una tarea que no salió' : 'Volvió a Por hacer como otra tarjeta';
    default: return e.tipo;
  }
}

/** D5 — Solo en Por hacer. Cada campo se guarda al cambiar; el servidor valida sujeto y proyecto. */
function EdicionPorHacer({ t }) {
  const [titulo, setTitulo] = useState(t.titulo || '');
  const [pedido, setPedido] = useState(t.pedido || '');
  const [guardado, setGuardado] = useState('');
  const guardar = async (cambios) => {
    setGuardado('guardando…');
    try {
      await api(`/api/tarjetas/${enc(t.id)}/editar`, cambios);
      setGuardado('cambios guardados');
    } catch (err) {
      setGuardado('');
      avisar(err.message, 'error');
    }
    cargarDetalle();
  };
  return html`<div class="edicion">
    <label class="campo"><span class="bloque-titulo">Título</span>
      <input type="text" class="campo-titulo" maxlength=${String(TOPE_TITULO)} placeholder="Sin título" value=${titulo} onInput=${(e) => setTitulo(e.currentTarget.value)} onChange=${() => guardar({ titulo })} /></label>
    <label class="campo"><span class="bloque-titulo">Pedido</span>
      <textarea rows="7" maxlength=${String(TOPE_PEDIDO_TARJETA)} value=${pedido} onInput=${(e) => setPedido(e.currentTarget.value)}
        onChange=${() => { if (pedido.trim()) guardar({ pedido }); else avisar('El pedido no puede quedar vacío.', 'error'); }}></textarea>
      <span class="mono tenue cuenta-texto">${pedido.length} / ${TOPE_PEDIDO_TARJETA}</span></label>
    <div class="campo-doble">
      <${Asignacion} envolver="campo" textoProyecto="Proyecto" valor=${t.sujeto ? claveDeSujeto(t.sujeto) : ''} wsId=${t.workspaceId}
        alCambiar=${(v, { soloProyecto } = {}) => guardar(soloProyecto ? { workspaceId: v.workspaceId || null } : { sujeto: v.sujeto || null, ...(String(v.sujeto).startsWith('agente:') ? { workspaceId: v.workspaceId || null } : {}) })} />
    </div>
    <div class="tenue nota-asignar">Un alma no usa proyecto. Todo se valida de nuevo al lanzar: si el agente dejó de ser de solo lectura, la tarjeta no se lanza. <span class="tenue guardado" aria-live="polite">${guardado}</span></div>
  </div>`;
}

/** «Partir en tarjetas»: un agente de solo lectura propone de 2 a 6 hijas. */
function FormularioPartir({ t }) {
  const agentes = sujetos.value.agentes.map((g) => g.nombre);
  const preferido = t.sujeto?.tipo === 'agente' && agentes.includes(t.sujeto.nombre)
    ? t.sujeto.nombre
    : agentes.includes(daemon.value?.orquestador) ? daemon.value.orquestador : agentes[0];
  const [abierto, setAbierto] = useState(false);
  const [agente, setAgente] = useState(preferido || '');
  const [ws, setWs] = useState(t.workspaceId || '');
  const [enviando, setEnviando] = useState(false);
  const listaWs = useWorkspaces();
  const enCurso = partiendo(t.id);
  const partir = async () => {
    const elegido = proyectoPropuesto(listaWs, ws, true);
    if (!elegido) { avisar('Elegí un proyecto para el orquestador.', 'error'); return; }
    setEnviando(true);
    const r = await accion(`/api/tarjetas/${enc(t.id)}/partir`, { agente, workspaceId: elegido || null }, `Partiendo con ${agente}: las hijas llegan como propuestas.`);
    setEnviando(false);
    if (r) setAbierto(false);
  };
  return html`<div class="detalle-bloque" data-partir=${t.id}>
    <button type="button" class="boton" data-nivel="ejecutar" hidden=${abierto} disabled=${!agentes.length || Boolean(enCurso)} title=${agentes.length ? null : 'No hay agentes de solo lectura registrados.'} onClick=${() => setAbierto(true)}>Partir en tarjetas…</button>
    ${abierto ? html`<div class="form-partir">
      <div class="tenue">Un agente de solo lectura lee la tarjeta (y el proyecto) y propone de 2 a 6 tarjetas hijas. No lanza nada.</div>
      <div class="campo-doble">
        <label class="campo"><span class="bloque-titulo">Orquestador</span>
          <select aria-label="Agente orquestador" value=${agente} onChange=${(e) => setAgente(e.currentTarget.value)}>${agentes.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}</select></label>
        <${EtiquetaCampo} envolver="campo" texto="Proyecto"><${SelectorProyecto} ws=${listaWs} valor=${proyectoPropuesto(listaWs, ws, true)} alCambiar=${setWs} /><//>
      </div>
      <div class="form-fila acciones">
        <button type="button" class="boton fantasma" onClick=${() => setAbierto(false)}>Cancelar</button>
        <button type="button" class="boton primario" disabled=${enviando} onClick=${partir}>Partir</button>
      </div>
    </div>` : null}
  </div>`;
}

/** FEAT-061 — Preparar un lote confinado con las hijas de una madre. */
function FormularioLote({ t, hijas }) {
  const d = daemon.value;
  const [abierto, setAbierto] = useState(false);
  const [modelo, setModelo] = useState(d?.modelo || 'gemini-3.8-flash');
  const [effort, setEffort] = useState(d?.esfuerzo || 'low');
  const [concurrencia, setConcurrencia] = useState(String(Math.min(3, hijas.length || 1)));
  const [timeout, setTimeoutMin] = useState('45');
  const [campos, setCampos] = useState({});
  const [lanzando, setLanzando] = useState(false);
  if (t.motivo === 'hija') return null;
  if (t.loteId) {
    const lote = loteConfinadoPorId(t.loteId);
    return html`<div class="detalle-bloque"><div class="meta">Lote asociado · ${lote?.estado || 'sin datos'} · ${t.loteId}</div>
      <button type="button" class="boton" onClick=${() => abrirDetalle(`c:${t.loteId}`)}>Ver lote</button></div>`;
  }
  if (!hijas.length) return null;
  let motivo = null;
  if (hijas.some((h) => h.propuesta)) motivo = 'Aceptá o descartá todas las propuestas antes de lanzar.';
  else if (hijas.some((h) => h.estado !== 'por_hacer')) motivo = 'Todas las hijas deben seguir en Por hacer.';
  else if (hijas.some((h) => h.sujeto?.tipo !== 'agente' || !h.workspaceId)) motivo = 'Todas las hijas deben estar asignadas a un agente y proyecto.';
  else if (new Set(hijas.map((h) => h.workspaceId)).size !== 1) motivo = 'Todas las hijas deben usar el mismo proyecto.';
  else if (t.workspaceId && t.workspaceId !== hijas[0].workspaceId) motivo = 'El proyecto de la madre no coincide con el de sus hijas.';
  const campo = (id) => campos[id] || { archivos: '', prueba: '', timeoutPrueba: '10' };
  const editar = (id, k, v) => setCampos({ ...campos, [id]: { ...campo(id), [k]: v } });
  const textoCuota = () => {
    const lista = acc.proveedores();
    if (!Array.isArray(lista)) return 'Cuota: sin datos.';
    const salud = lista.find((p) => p.id === 'antigravity')?.uso?.cuota;
    if (!salud) return 'Cuota: sin datos.';
    return salud === 'HEALTHY' ? 'Cuota: sin 429 recientes.' : `Cuota: ${salud}.`;
  };
  const abrir = () => { setAbierto(true); if (!acc.proveedores()) acc.cargarProveedores(); };
  const lanzar = async () => {
    const entradas = [];
    try {
      for (const h of hijas) {
        const c = campo(h.id);
        const archivos = c.archivos.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        if (!archivos.length || archivos.length > 32) throw new Error(`${tituloDe(h)} necesita entre 1 y 32 rutas.`);
        let prueba = null;
        if (c.prueba.trim()) {
          const argv = JSON.parse(c.prueba);
          if (!Array.isArray(argv) || !argv.length) throw new Error(`La prueba de ${tituloDe(h)} debe ser un array JSON.`);
          prueba = { argv, timeout_minutes: Number(c.timeoutPrueba) };
        }
        entradas.push({ id: h.id, archivos, prueba });
      }
    } catch (err) { avisar(err.message, 'error'); return; }
    setLanzando(true);
    try {
      const r = await api(`/api/tarjetas/${enc(t.id)}/lote`, { hijas: entradas, modelo: modelo.trim(), effort, concurrencia: Number(concurrencia), timeout_minutes: Number(timeout) });
      avisar('Lote lanzado. Podés cerrar la pestaña: el daemon continúa trabajando.');
      await cargarFanout();
      abrirDetalle(`c:${r.id}`);
    } catch (err) { avisar(err.message, 'error'); setLanzando(false); }
  };
  return html`<div class="detalle-bloque lote-preparar">
    <button type="button" class="boton primario" data-nivel="ejecutar" hidden=${abierto} disabled=${Boolean(motivo)} title=${motivo || 'Configurar workers confinados'} onClick=${abrir}>Preparar lote…</button>
    ${motivo ? html`<span class="tenue motivo">${motivo}</span>` : null}
    ${abierto ? html`<div class="form-lote">
      <p class="tenue">Crea ramas y worktrees. Las asignaciones del tablero no se montan dentro del contenedor y nada se integra automáticamente.</p>
      <p class="tenue">${hijas.length} workers · hasta ${hijas.length} auditorías. El modelo, esfuerzo, concurrencia y topes efectivos son los configurados abajo.</p>
      <div class="campo-doble">
        <label class="campo"><span class="bloque-titulo">Modelo</span><input type="text" maxlength="64" value=${modelo} onInput=${(e) => setModelo(e.currentTarget.value)} /></label>
        <label class="campo"><span class="bloque-titulo">Esfuerzo</span><select value=${effort} onChange=${(e) => setEffort(e.currentTarget.value)}>${['low', 'medium', 'high'].map((v) => html`<option key=${v} value=${v}>${v}</option>`)}</select></label>
        <label class="campo"><span class="bloque-titulo">Concurrencia · máximo 3</span><input type="number" min="1" max="3" value=${concurrencia} onInput=${(e) => setConcurrencia(e.currentTarget.value)} /></label>
        <label class="campo"><span class="bloque-titulo">Tope por worker · minutos</span><input type="number" min="1" max="45" value=${timeout} onInput=${(e) => setTimeoutMin(e.currentTarget.value)} /></label>
      </div>
      <div class="tenue">${textoCuota()}</div>
      ${hijas.map((h) => html`<fieldset key=${h.id} class="lote-worker"><legend>${tituloDe(h)}</legend>
        <div class="tenue">${h.sujeto?.nombre || 'sin agente'} · ejecuta el modelo común dentro del contenedor</div>
        <label class="campo"><span class="bloque-titulo">Archivos autorizados · uno por línea</span>
          <textarea rows="4" placeholder=${'src/archivo.js\ntest/archivo.test.js'} aria-label=${`Archivos autorizados para ${tituloDe(h)}`} value=${campo(h.id).archivos} onInput=${(e) => editar(h.id, 'archivos', e.currentTarget.value)}></textarea></label>
        <div class="campo-doble">
          <label class="campo"><span class="bloque-titulo">Prueba opcional · argv JSON</span><input type="text" placeholder='["npm","test"]' aria-label=${`Prueba opcional para ${tituloDe(h)}`} value=${campo(h.id).prueba} onInput=${(e) => editar(h.id, 'prueba', e.currentTarget.value)} /></label>
          <label class="campo"><span class="bloque-titulo">Tope de prueba · minutos</span><input type="number" min="1" max="15" aria-label=${`Tope de prueba para ${tituloDe(h)}`} value=${campo(h.id).timeoutPrueba} onInput=${(e) => editar(h.id, 'timeoutPrueba', e.currentTarget.value)} /></label>
        </div>
      </fieldset>`)}
      <div class="form-fila acciones">
        <button type="button" class="boton fantasma" onClick=${() => setAbierto(false)}>Cancelar</button>
        <button type="button" class="boton primario" disabled=${lanzando} onClick=${lanzar}>Lanzar ${hijas.length} workers confinados</button>
      </div>
    </div>` : null}
  </div>`;
}

function CompositorNota({ id }) {
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const enviar = async () => {
    const t = texto.trim();
    if (!t || enviando) return;
    setEnviando(true);
    try {
      await api(`/api/tareas/${enc(id)}/notas`, { texto: t });
      setTexto('');
      programarDetalle();
    } catch (err) {
      avisar(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };
  return html`<div class="nota-nueva">
    <textarea rows="2" maxlength=${String(TOPE_NOTA)} aria-label="Nueva nota" placeholder="Agregar una nota (solo para vos)" value=${texto} onInput=${(e) => setTexto(e.currentTarget.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar(); } }}></textarea>
    <button type="button" class="boton" disabled=${enviando} onClick=${enviar}>Anotar</button>
  </div>`;
}

function AccionesDeDetalle({ t }) {
  if (t.estado === 'por_hacer') {
    const motivo = motivoNoLanzable(t);
    const borrar = html`<${BotonDosPasos} clase="boton peligro" texto="Borrar" armado="¿Borrar? Clic de nuevo" alConfirmar=${() => borrarTarjeta(t, 'Tarjeta borrada.')} />`;
    // FEAT-138 — Reordenar también desde el detalle (no en una tarjeta de un lote).
    const mover = t.loteId ? null : html`<${MenuMover} t=${t} clase="boton" />`;
    if (t.propuesta) {
      return html`<${BotonDosPasos} clase="boton peligro" texto="Descartar" armado="¿Descartar? Clic de nuevo" alConfirmar=${() => borrarTarjeta(t, 'Propuesta descartada.')} />
        <${BotonAccion} texto="Aceptar" alHacer=${() => aceptarPropuesta(t.id)} />
        ${mover}
        ${motivo ? html`<span class="tenue motivo">${motivo}</span>` : null}
        <${BotonAccion} clase="boton primario derecha" data-nivel="ejecutar" texto="Lanzar" disabled=${Boolean(motivo)} title=${motivo || 'Lanzarla también la acepta'} alHacer=${() => lanzarTarjeta(t.id)} />`;
    }
    // BE-105 — Una madre se lanza desde su formulario de lote, que ya dice por qué.
    if (motivoMadre(t.id)) return html`${borrar}${mover}`;
    return html`${borrar}${mover}${motivo ? html`<span class="tenue motivo">${motivo}</span>` : null}
      <${BotonAccion} clase="boton primario derecha" data-nivel="ejecutar" texto="Lanzar" disabled=${Boolean(motivo)} title=${motivo || 'Entra a la cola ahora'} alHacer=${() => lanzarTarjeta(t.id)} />`;
  }
  const r = rutaDeSujeto(t.sujeto);
  const columna = columnaDeEstado(t.estado);
  return html`
    ${r ? html`<a class="boton" href=${r} data-ruta>${t.sujeto.tipo === 'alma' ? 'Abrir charla' : 'Abrir conversación'}</a>` : null}
    ${t.carril === 'principal' ? html`<span class="tenue">El trabajo de /run y /plan se maneja desde Telegram.</span>` : null}
    ${reintentable(t) ? html`<button type="button" class="boton" data-nivel="ejecutar" onClick=${() => reintentarTarea(t.id)}>Reintentar</button>` : null}
    ${devolvible(t) ? html`<button type="button" class="boton" onClick=${() => devolverTarea(t.id)}>Volver a Por hacer</button>` : null}
    ${['ok', 'mal'].includes(columna) ? html`<button type="button" class="boton" onClick=${() => archivarTarea(t.id, !t.archivada)}>${t.archivada ? 'desarchivar' : 'archivar'}</button>` : null}
    ${(t.estado === 'en_cola' || t.estado === 'en_curso') && t.carril !== 'principal'
      ? html`<${BotonDosPasos} clase="boton peligro derecha" texto=${t.estado === 'en_cola' ? 'Quitar de la cola' : 'Cancelar'} armado="¿Seguro? Clic de nuevo" alConfirmar=${() => cancelarTarea(t.id)} />` : null}`;
}

function DetalleTarea({ d }) {
  const t = d.tarea;
  if (!t) {
    return html`<div class="detalle-cabecera"><div class="detalle-fila"><span class="mono tenue">${d.id}</span><${BotonCerrar} /></div></div>
      <div class="detalle-cuerpo"><p class=${d.error ? 'error' : 'meta'}>${d.error || 'cargando…'}</p></div>`;
  }
  void versionTablero.value;
  const porHacer = t.estado === 'por_hacer';
  const hijas = hijasDe(t.id);
  const enCurso = partiendo(t.id);
  const notas = Array.isArray(t.notas) ? t.notas : [];
  const eventos = Array.isArray(t.eventos) ? t.eventos : [];
  const conActividad = t.estado === 'en_curso' || t.actividad?.length;
  const sub = porHacer
    ? [t.propuesta ? `propuesta de ${autorDe(t.creadaPor)}` : null, `creada ${fechaCorta(t.creada)}`, t.actualizada && t.actualizada !== t.creada ? `editada ${fechaCorta(t.actualizada)}` : null].filter(Boolean).join(' · ')
    : [t.id, t.archivada ? `archivada ${fechaCorta(t.archivada)}` : null].filter(Boolean).join(' · ');
  const origen = /^(alma|agente):/.test(t.creadaPor || '') ? `Propuesta de ${autorDe(t.creadaPor)} · lanzada desde la web` : t.creadaPor === 'usuario' ? 'Por hacer · lanzada desde la web' : t.origen === 'web' ? 'desde la web' : 'desde Telegram';
  let resultado = null;
  if (t.estado === 'ok' && (t.resultado || t.memoria)) {
    resultado = html`<${Titulo}>Resultado<//>${t.resultado ? html`<${Resultado} t=${t} />` : null}
      <div class="pie"><${PieDeMemoria} t=${t} />${t.resultado ? html`<${BotonEscuchar} t=${t} escuchar=${acc.escuchar} />` : null}</div>`;
  } else if (columnaDeEstado(t.estado) === 'mal') {
    resultado = html`<${Titulo}>${CHIP_ESTADO[t.estado]?.[0] || 'Error'}<//><div class="tarjeta-error">${t.error || 'Sin detalle.'}</div>`;
  }
  const familia = madreDe(t) || enCurso || hijas.length || porHacer;
  return html`
    <div class="detalle-cabecera">
      <div class="detalle-fila"><${ChipEstado} t=${t} /><span class="tenue detalle-sub">${sub}</span><${BotonCerrar} /></div>
      ${porHacer ? null : html`<div class="detalle-titulo">${tituloDe(t)}</div>`}
    </div>
    <div class=${`detalle-cuerpo ${t.sujeto?.tipo === 'alma' ? tono(t.sujeto.clave) : ''}`}>
      ${porHacer ? html`<${EdicionPorHacer} key=${t.id} t=${t} />` : null}
      ${porHacer ? null : html`<div class="detalle-bloque"><dl class="grilla">
        <dt>Quién</dt><dd>${t.sujeto?.tipo === 'agente' ? `${t.sujeto.nombre} · solo lectura` : nombreDeSujeto(t.sujeto)}</dd>
        ${t.proyecto ? html`<dt>Proyecto</dt><dd>${t.proyecto}</dd>` : null}
        <dt>Origen</dt><dd>${origen}</dd>
        ${t.madre && t.motivo !== 'hija' ? html`<dt>${t.motivo === 'orquestar' ? 'Parte a' : 'Viene de'}</dt><dd><button type="button" class="accion mono" onClick=${() => abrirDetalle(t.madre)}>${t.madre}</button></dd>` : null}
        ${t.iniciada && t.terminada ? html`<dt>Duración</dt><dd>${duracion(Date.parse(t.terminada) - Date.parse(t.iniciada))}</dd>` : null}
      </dl></div>`}
      ${porHacer ? null : html`<div class="detalle-bloque"><${Titulo}>${t.carril === 'principal' ? 'Pedido (extracto)' : t.motivo === 'reaccion' ? 'Reacción' : 'Pedido'}<//><div class="detalle-texto">${t.pedido || '—'}</div></div>`}
      ${porHacer && !t.propuesta ? html`<${FormularioPartir} key=${`p-${t.id}`} t=${t} />` : null}
      ${familia ? html`<div class="detalle-bloque">
        <${EnlaceMadre} t=${t} />
        ${enCurso ? html`<div class="partiendo"><span class="meta">Partiendo con ${enCurso.sujeto?.nombre || 'un agente'}… </span><button type="button" class="accion" onClick=${() => abrirDetalle(enCurso.id)}>ver</button></div>` : null}
        ${hijas.length ? html`<${Titulo}>Tarjetas hijas · ${terminadas(hijas)}/${hijas.length} terminadas<//><${Barra} partes=${barraDeHijas(hijas)} />
          <ul class="subtareas">${hijas.map((h) => html`<li key=${h.id} class="subtarea"><span class=${`punto ${SUB_DE_ESTADO[h.estado] || ''}`} aria-hidden="true"></span>
            <button type="button" class="tarjeta-abrir recorte" onClick=${() => abrirDetalle(h.id)}>${tituloDe(h)}</button>
            <span class="tenue derecha recorte">${[h.propuesta ? 'propuesta' : CHIP_ESTADO[h.estado]?.[0], h.sujeto ? nombreDeSujeto(h.sujeto) : 'sin asignar'].filter(Boolean).join(' · ')}</span></li>`)}</ul>` : null}
        ${porHacer ? html`<${FormularioLote} key=${`l-${t.id}`} t=${t} hijas=${hijas} />` : null}
      </div>` : null}
      ${conActividad ? html`<div class="detalle-bloque"><${Titulo}>Actividad<//><${LineaDeTiempo} t=${t} />
        ${t.estado === 'en_curso' ? html`<${Parcial} id=${t.id} />` : null}
        ${t.estado === 'en_curso' && !t.actividad?.length ? html`<div class="tenue">Sin actividad todavía.</div>` : null}</div>` : null}
      ${resultado ? html`<div class="detalle-bloque">${resultado}</div>` : null}
      <div class="detalle-bloque">
        <${Titulo}>Notas · ${notas.length}<//>
        <div class="lista-notas">${notas.length
          ? notas.map((n, i) => html`<div key=${i} class="nota">${n.texto}<div class="nota-meta">${autorDe(n.autor)} · ${fechaCorta(n.t)}</div></div>`)
          : html`<div class="tenue">Sin notas. Son solo para vos: nadie las lee como instrucción.</div>`}</div>
        <${CompositorNota} key=${`n-${t.id}`} id=${t.id} />
      </div>
      ${eventos.length ? html`<div class="detalle-bloque"><${Titulo}>Historial<//><ol class="historial">${eventos.map((e, i) => html`<li key=${i}>
        <span class="t">${fechaCorta(e.t)}</span><span class=${e.tipo === 'en_curso' ? 'vivo' : e.tipo === 'error' ? 'error' : null}>${textoDeEvento(e, t)}</span>
        ${['devuelta', 'partida', 'hija'].includes(e.tipo) && e.detalle ? html`<button type="button" class="accion" onClick=${() => abrirDetalle(e.detalle)}>ver</button>` : null}</li>`)}</ol></div>` : null}
    </div>
    <div class="detalle-pie"><${AccionesDeDetalle} t=${t} /></div>`;
}

function DetalleFanout({ id }) {
  const l = lotesDeTablero().find((x) => x.id === id);
  if (!l) {
    // BE-098 — Un `f:` que es de un lote confinado se ve como lote.
    const partes = /^f:(.+):([^:]+)$/.exec(id);
    const cargando = fanout.value === null || lotes.value === null;
    if (partes && !cargando && esFanoutDeLote({ slug: partes[2], workspace: { id: partes[1] } }, lotesConfinados())) {
      queueMicrotask(() => abrirDetalle(`c:${partes[2]}`));
      return null;
    }
    return html`<div class="detalle-cabecera"><div class="detalle-fila"><span class="chip-estado">fan-out</span><${BotonCerrar} /></div></div>
      <div class="detalle-cuerpo"><p class="meta">${cargando ? 'cargando…' : 'Ese lote ya no aparece: terminó hace más de 24 h o se borró su estado.'}</p></div>`;
  }
  const clase = { curso: 'est-curso', ok: 'est-ok', mal: 'est-mal' }[l.columna] || '';
  const texto = { curso: 'Trabajando', ok: 'Terminado', mal: 'Con error', cola: 'Pendiente' }[l.columna];
  return html`<div class="detalle-cabecera">
      <div class="detalle-fila"><span class=${`chip-estado ${clase}`}><span class="punto-chip" aria-hidden="true"></span>${texto}</span><span class="tenue detalle-sub">${l.ok}/${l.tareas.length} listas</span><${BotonCerrar} /></div>
      <div class="detalle-titulo mono">${l.slug}</div></div>
    <div class="detalle-cuerpo">
      <div class="detalle-bloque"><dl class="grilla">
        <dt>Proyecto</dt><dd>${l.workspace.nombre}</dd><dt>Origen</dt><dd>fan-out lanzado desde Claude Code</dd>
        <dt>Inicio</dt><dd>${fechaCorta(l.iniciado) || '—'}</dd><dt>${l.terminado ? 'Terminó' : 'Actualizado'}</dt><dd>${fechaCorta(l.terminado || l.actualizado) || '—'}</dd>
      </dl></div>
      <div class="detalle-bloque"><${Titulo}>Subtareas<//><${Barra} partes=${barraDeLote(l)} />
        <ul class="subtareas">${l.tareas.map((st) => html`<li key=${st.id} class="subtarea"><span class=${`punto sub-${st.estado}`} aria-hidden="true"></span><span class="mono recorte">${st.id}</span>
          <span class="tenue">${st.detenido ? 'detenida' : st.estado}${st.intentos > 1 ? ` · ${st.intentos} intentos` : ''}${st.estado === 'corriendo' && st.inicio ? html` · <${Reloj} desde=${st.inicio} clase="" />` : null}</span>
          <span class="derecha">${enCursoSub(st) ? html`<${BotonDosPasos} clase="boton peligro chico" texto="Detener" armado="¿Detener? Clic de nuevo" alConfirmar=${() => detenerSubtarea(l, st)} />` : null}</span></li>`)}</ul></div>
      <p class="tenue">Detener deja un pedido que el lote lee en su próximo chequeo; la subtarea se corta ahí, no al instante.</p>
    </div>`;
}

function VerDiff({ l, st }) {
  const [diff, setDiff] = useState(null);
  const [cargando, setCargando] = useState(false);
  const ver = async () => {
    setCargando(true);
    try {
      const r = await api(`/api/lotes/${enc(l.id)}/tareas/${enc(st.id)}/diff`);
      setDiff(r.diff || '(sin diff)');
    } catch (err) { avisar(err.message, 'error'); setCargando(false); }
  };
  return html`<button type="button" class="accion" disabled=${cargando} onClick=${ver}>${diff === null ? 'Ver diff' : 'Diff cargado'}</button>
    ${diff === null ? null : html`<pre class="salida-lote">${diff}</pre>`}`;
}

function DetalleLoteConfinado({ d }) {
  const l = d.lote;
  if (!l) {
    return html`<div class="detalle-cabecera"><div class="detalle-fila"><span class="chip-estado">lote confinado</span><${BotonCerrar} /></div></div>
      <div class="detalle-cuerpo"><p class=${d.error ? 'error' : 'meta'}>${d.error || 'cargando…'}</p></div>`;
  }
  const activos = ['corriendo', 'verificando', 'auditando'];
  const clase = activos.includes(l.estado) ? 'est-curso' : ['para revisar', 'integrado'].includes(l.estado) ? 'est-ok' : 'est-mal';
  const destino = l.ramaBase || 'la rama base';
  const conCommit = l.tareas.filter((t) => t.commit).length;
  const integrar = async () => {
    const r = await accion(`/api/lotes/${enc(l.id)}/integrar`, { confirmacion: l.id }, (x) => `Lote integrado en ${x.rama} (${x.despuesCorto}).${x.saltados ? ` ${x.saltados} resto(s) sin borrar.` : ''}`);
    if (r) { await cargarFanout(); cerrarDetalle(); }
  };
  const descartar = async () => {
    const r = await accion(`/api/lotes/${enc(l.id)}/descartar`, { confirmacion: l.id }, 'Lote descartado; la familia vuelve a estar editable.');
    if (r) { await cargarFanout(); cerrarDetalle(); }
  };
  return html`<div class="detalle-cabecera">
      <div class="detalle-fila"><span class=${`chip-estado ${clase}`}><span class="punto-chip" aria-hidden="true"></span>${l.estado}</span><${BotonCerrar} /></div>
      <div class="detalle-titulo mono">${l.id}</div></div>
    <div class="detalle-cuerpo">
      <div class="detalle-bloque"><dl class="grilla">
        <dt>Proyecto</dt><dd>${l.workspace.nombre}</dd>
        ${l.ramaBase ? html`<dt>Rama base</dt><dd>${l.ramaBase}</dd>` : null}
        ${l.integracion ? html`<dt>Integrado</dt><dd>en ${l.integracion.rama} · ${l.integracion.despuesCorto}${l.integracion.cuando ? ` · ${fechaCorta(l.integracion.cuando)}` : ''}</dd>` : null}
        <dt>Modelo</dt><dd>${l.modelo || '—'}</dd><dt>Creado</dt><dd>${fechaCorta(l.creado) || '—'}</dd><dt>Actualizado</dt><dd>${fechaCorta(l.actualizado) || '—'}</dd>
      </dl></div>
      ${l.tuberia ? html`<div class="detalle-bloque"><${Titulo}>Tubería<//><${Tuberia} t=${l.tuberia} /></div>` : null}
      <div class="detalle-bloque"><${Titulo}>Workers confinados<//>${l.tareas.map((st) => html`<section key=${st.id} class="lote-tarea">
        <div class="detalle-fila"><strong class="mono recorte">${st.id}</strong><span class="chip-sub derecha">${st.estado}</span></div>
        ${st.rama ? html`<div class="mono tenue detalle-sub">${st.rama}</div>` : null}
        ${st.commitCorto ? html`<div class="mono tenue">commit ${st.commitCorto}</div>` : null}
        ${st.error ? html`<pre class="salida-lote error">${st.error}</pre>` : null}
        ${l.estado === 'corriendo' && st.estado === 'corriendo'
          // BE-098 — Detener vive acá; solo mientras escriben (en verificando/auditando ya no hay qué cortar).
          ? html`<${BotonDosPasos} clase="boton peligro chico" texto="Detener" armado="¿Detener? Clic de nuevo" alConfirmar=${() => detenerSubtarea({ workspace: l.workspace, slug: l.id }, st)} />` : null}
        ${st.prueba && st.prueba.estado !== 'pendiente' ? html`<${Titulo}>Prueba · ${st.prueba.estado}${st.prueba.exitCode == null ? '' : ` · exit ${st.prueba.exitCode}`}<//>
          ${st.prueba.argv ? html`<div class="mono tenue">${JSON.stringify(st.prueba.argv)}</div>` : null}
          ${st.prueba.salida ? html`<pre class="salida-lote">${st.prueba.salida}</pre>` : null}` : null}
        ${st.auditoria && st.auditoria.estado !== 'pendiente' ? html`<${Titulo}>Auditoría · ${st.auditoria.veredicto || st.auditoria.estado}<//>
          ${st.auditoria.reporte ? html`<pre class="salida-lote">${st.auditoria.reporte}</pre>` : null}
          ${st.auditoria.error ? html`<pre class="salida-lote error">${st.auditoria.error}</pre>` : null}` : null}
        ${st.commit ? html`<${VerDiff} l=${l} st=${st} />` : null}
      </section>`)}</div>
      ${l.estado === 'para revisar' && l.integrable && !l.integrable.ok ? html`<div class="detalle-bloque"><${Titulo}>Por qué no se puede integrar<//>${l.integrable.motivos.map((m, i) => html`<div key=${i} class="meta">${m}</div>`)}</div>` : null}
      ${l.estado === 'corriendo' ? html`<p class="tenue">Detener deja un pedido que el lote lee en su próximo chequeo; la tarea se corta ahí, no al instante.</p>` : null}
      <p class="tenue">Pruebas y auditorías son evidencia consultiva. Nada se integra automáticamente: la integración la decide un humano.</p>
    </div>
    <div class="detalle-pie">
      ${l.madreId ? html`<button type="button" class="boton" onClick=${() => abrirDetalle(l.madreId)}>Ver tarjeta madre</button>` : null}
      ${l.estado === 'para revisar' && l.integrable
        // FEAT-108 — Integrar solo con prueba verde y PASS en cada tarea (lo decide el servidor).
        ? (l.integrable.ok
          ? html`<${BotonDosPasos} clase="boton primario" data-nivel="ejecutar" texto=${`Integrar en ${destino}`} armado=${`¿Mergear ${conCommit} tarea${conCommit === 1 ? '' : 's'} en ${destino}? Clic de nuevo`} alConfirmar=${integrar} />`
          : html`<button type="button" class="boton primario" data-nivel="ejecutar" disabled title=${l.integrable.motivos.join('\n')}>Integrar en ${destino}</button>`)
        : null}
      ${['para revisar', 'fallido', 'interrumpido'].includes(l.estado)
        ? html`<${BotonDosPasos} clase="boton peligro derecha" data-nivel="ejecutar" texto="Descartar lote" armado="¿Borrar ramas y worktrees? Clic de nuevo" alConfirmar=${descartar} />` : null}
    </div>`;
}

function Detalle() {
  const d = detalle.value;
  let cuerpo = null;
  if (d?.id.startsWith('f:')) cuerpo = html`<${DetalleFanout} key=${d.id} id=${d.id} />`;
  else if (d?.id.startsWith('c:')) cuerpo = html`<${DetalleLoteConfinado} key=${d.id} d=${d} />`;
  else if (d) cuerpo = html`<${DetalleTarea} key=${d.id} d=${d} />`;
  return html`<aside class="detalle" id="detalle" aria-label="Detalle de la tarjeta" hidden=${!d}>${cuerpo}</aside>`;
}

// ── La página ─────────────────────────────────────────────────────────────
export function VistaTablero() {
  useEffect(() => {
    if (tablero.value === null) cargarTablero();
    if (filtro.value.q.trim() && !busqueda.value.ids) programarBusqueda(0);
    cargarFanout();
    // D11 — La tarjeta abierta vive en la URL: una recarga la mantiene.
    const id = new URLSearchParams(location.search).get('t');
    if (id) abrirDetalle(id, { url: false }); else cerrarDetalle({ url: false });
  }, []);
  return html`<div class="tablero">
    <${Filtros} />
    <${NotaTablero} />
    <div class=${`tablero-cuerpo${detalle.value ? ' con-detalle' : ''}`} id="tablero-cuerpo">
      <${CarruselColumnas} />
      <${Detalle} />
    </div>
  </div>`;
}
