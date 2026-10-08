/*
 * FEAT-136 — Lo que comparten todas las vistas: la API (con el prefijo del
 * nodo elegido y los permisos que ese nodo declara), los avisos flotantes y el
 * formato de fechas y duraciones. Sacado de `app.js` sin cambiar el
 * comportamiento; `nodo` y `nodos` pasan a ser señales.
 */
import { signal } from '../vendor/signals-core.module.js';

/** FEAT-089 — El nodo que se está mirando (`local` es este daemon) y los que hay. */
export const nodo = signal((() => { try { return localStorage.getItem('lagrange.nodo') || 'local'; } catch { return 'local'; } })());
export const nodos = signal([]);

export const $ = (sel) => document.querySelector(sel);

export const ICONOS = {
  foco: 'M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9',
  salir: 'M9 3L5 7l4 4',
  sistema: 'M2 3h10v7H2zM5 12h4',
  claro: 'M7 1.5v1.5M7 11v1.5M1.5 7H3M11 7h1.5M3.1 3.1l1 1M9.9 9.9l1 1M3.1 10.9l1-1M9.9 4.1l1-1M7 4.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  oscuro: 'M11.5 8.5A5 5 0 0 1 5.5 2.5a5 5 0 1 0 6 6z',
  // FEAT-082 — Botón Panel, cierre de cajón y una por sección de la tira.
  panel: 'M1.5 1.5h11v11h-11zM9 1.5v11',
  cerrar: 'M3 3l8 8M11 3l-8 8',
  motor: 'M4 4h6v6H4zM5.5 1.5V4M8.5 1.5V4M5.5 10v2.5M8.5 10v2.5M1.5 5.5H4M1.5 8.5H4M10 5.5h2.5M10 8.5h2.5',
  consolidacion: 'M2 3.5h10M2 7h7M2 10.5h4',
  hilo: 'M7 1.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M7 4v3l2 1.2',
  actividad: 'M1.5 7H4l2-4.5 2.5 9 2-4.5h2',
  memoria: 'M3 2h7.5A1.5 1.5 0 0 1 12 3.5V12H4.5A1.5 1.5 0 0 1 3 10.5zM3 10.5A1.5 1.5 0 0 1 4.5 9H12',
  usuario: 'M7 2a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M2.5 12.5c.7-2.5 2.5-3.8 4.5-3.8s3.8 1.3 4.5 3.8',
  diario: 'M3.5 1.5h7v11h-7zM5.5 4.5h3M5.5 7h3',
  proyecto: 'M1.5 3.5h4l1.2 1.5h5.8v7.5h-11z',
  contexto: 'M7 1.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M7 6.5V10M7 4.2v.3',
  criterio: 'M3.5 7.5L6 10l4.5-6',
  programado: 'M2 3h10v9.5H2zM2 6h10M4.5 1.5v3M9.5 1.5v3',
  // FEAT-081 — Una lupa: buscar en la memoria profunda.
  profunda: 'M6 1.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9M9.3 9.3l3.2 3.2'
};

// FEAT-089 §6.5 — Con un nodo remoto elegido, cada `/api/...` va a
// `/api/n/<nodo>/...`, salvo `/api/nodos`, que es del servidor.
// SEC-022 §3.2 — Lo que se puede hacer ahí lo decide ese nodo (`permite`):
// con `lectura` no sale ninguna acción; con más, decide el servidor y el nodo.
export const esRemoto = () => nodo.value && nodo.value !== 'local';
export const NIVELES = ['lectura', 'operar', 'ejecutar'];
export const permiteRemoto = () => nodos.value.find((n) => n.id === nodo.value)?.permite || 'lectura';
export const alcanza = (nivel) => !esRemoto() || NIVELES.indexOf(permiteRemoto()) >= NIVELES.indexOf(nivel);
export const motivoRemoto = () => (nodo.value === 'todos'
  ? 'En "Todos" se mira: elegí el nodo de la tarjeta para actuar.'
  : `Este nodo permite solo ${permiteRemoto()} (BRIDGE_NODO_PERMITE en su .env).`);
// BE-063 — Un control que pide más de lo que permite el nodo se ve y se
// anuncia deshabilitado, no solo frena al hacer clic: lleva `data-nivel` y el
// cuerpo, `data-permite` (el CSS lo apaga). No usa `disabled`, que cada acción
// vuelve a poner en false al terminar.
export const permiteDeVista = () => (esRemoto() ? permiteRemoto() : 'ejecutar');
export const bloqueadoPorNivel = (nodo) => {
  const control = nodo?.closest?.('[data-nivel]');
  return control && !alcanza(control.dataset.nivel) ? control : null;
};
// El motivo va de tooltip al pasar o enfocar; el suyo vuelve si el nivel alcanza.
export function anunciarNivel(ev) {
  const control = ev.target?.closest?.('[data-nivel]');
  if (!control) return;
  if (!alcanza(control.dataset.nivel)) {
    if (!('tituloPropio' in control.dataset)) control.dataset.tituloPropio = control.getAttribute('title') || '';
    control.title = motivoRemoto();
    control.setAttribute('aria-disabled', 'true');
  } else if ('tituloPropio' in control.dataset) {
    if (control.dataset.tituloPropio) control.title = control.dataset.tituloPropio;
    else control.removeAttribute('title');
    delete control.dataset.tituloPropio;
    control.removeAttribute('aria-disabled');
  }
}
export function frenarPorNivel(ev) {
  const control = bloqueadoPorNivel(ev.target);
  if (!control) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  avisar(motivoRemoto(), 'error');
}
// SEC-022 §3.1 — Las rutas que piden `ejecutar` (la misma tabla que usan el
// servidor y el nodo): lanzar agentes, GPU, modelo y borrar lotes. El resto
// de los POST es `operar`.
export const RUTAS_EJECUTAR = [/^\/api\/almas\/[^/]+\/mensaje$/, /^\/api\/cast$/, /^\/api\/tareas\/[^/]+\/(reintentar|escuchar)$/, /^\/api\/voz\/preparar$/,
  /^\/api\/tarjetas\/[^/]+\/(lanzar|partir|lote)$/, /^\/api\/lotes\/[^/]+\/(descartar|integrar)$/, /^\/api\/motores\/rol$/, /^\/api\/programaciones$/];
export const nivelDeRuta = (ruta, cuerpo) => (RUTAS_EJECUTAR.some((r) => r.test(ruta)) || (ruta === '/api/tarjetas' && cuerpo?.lanzar === true) ? 'ejecutar' : 'operar');
export function rutaDeNodo(ruta) {
  if (/^\/api\/rendimiento(\?|$)/.test(ruta)) return ruta;
  // FEAT-134 — Ajustes es siempre de esta máquina (nunca de un nodo).
  if (/^\/api\/ajustes(\/|\?|$)/.test(ruta)) return ruta;
  if (!esRemoto() || !ruta.startsWith('/api/') || ruta === '/api/nodos' || ruta.startsWith('/api/n/') || ruta.startsWith('/api/red/')) return ruta;
  // FEAT-090 §5.2 — Las almas viven en el servidor: sus vistas no llevan prefijo.
  if (/^\/api\/almas(\/|\?|$)/.test(ruta)) return ruta;
  // FEAT-090 §6.5 — "Todos": el tablero y las programaciones de la red; el resto, lo local.
  if (nodo.value === 'todos') {
    if (/^\/api\/tareas(\?|$)/.test(ruta) && !/[?&](sujeto|programado)=/.test(ruta)) return '/api/red/tablero';
    if (ruta === '/api/programaciones') return '/api/red/programaciones';
    return ruta;
  }
  return `/api/n/${encodeURIComponent(nodo.value)}${ruta.slice(4)}`;
}

export async function api(ruta, cuerpo, { signal, cache } = {}) {
  // FEAT-134 — Ajustes es local: los permisos de un nodo remoto no aplican.
  if (cuerpo !== undefined && !/^\/api\/ajustes(\/|\?|$)/.test(ruta) && !alcanza(nivelDeRuta(ruta, cuerpo))) throw new Error(motivoRemoto());
  ruta = rutaDeNodo(ruta);
  const opciones = cuerpo === undefined
    ? { credentials: 'same-origin', signal, cache }
    : { credentials: 'same-origin', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) };
  const r = await fetch(ruta, opciones);
  let datos;
  try { datos = await r.json(); } catch { datos = { ok: false, error: `HTTP ${r.status}` }; }
  if (r.status === 401) {
    const error = new Error('La sesión venció (¿se reinició el daemon?). Pedí un link nuevo con npm run bridge:web o /web.');
    error.status = 401;
    throw error;
  }
  if (!r.ok || datos.ok === false) {
    // FEAT-057 — Un error puede traer datos (guardar y lanzar: la tarjeta quedó guardada).
    const error = new Error(datos.error || `HTTP ${r.status}`);
    error.datos = datos;
    // FEAT-081 — Para distinguir "ya no existe" (404) de un fallo.
    error.status = r.status;
    throw error;
  }
  return datos;
}

let temporizadorAviso = null;
export function avisar(texto, tipo) {
  const a = $('#aviso');
  a.textContent = texto;
  a.className = `aviso-flotante${tipo === 'error' ? ' error' : ''}`;
  a.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { a.hidden = true; }, tipo === 'error' ? 6000 : 3000);
}

export function duracion(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function relativo(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 172800) return 'ayer';
  return new Date(t).toLocaleDateString('es');
}

export const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '');
// FEAT-083 — Para una columna angosta: "14:14" si es de hoy, "ayer 14:14" o "22/9 14:14".
export function momentoCorto(iso, ahora = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const hh = hora(iso);
  const ayer = new Date(ahora);
  ayer.setDate(ahora.getDate() - 1);
  if (d.toDateString() === ahora.toDateString()) return hh;
  if (d.toDateString() === ayer.toDateString()) return `ayer ${hh}`;
  return `${d.getDate()}/${d.getMonth() + 1} ${hh}`;
}
export const dia = (iso) => (iso ? new Date(iso).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }) : '');

// Color estable por clave: el mismo alma siempre tiene el mismo tono.
export function tono(clave) {
  let h = 0;
  for (const c of String(clave)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return `tono-${h % 6}`;
}
