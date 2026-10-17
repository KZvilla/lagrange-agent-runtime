/*
 * FEAT-162 — La vista Orquestación: lo que una sesión (Spica, Epikouros…) hace
 * con la consola por la herramienta MCP `consola`. Cada orquestación muestra su
 * plan (pasos enlazados a tarjetas y lotes), las aprobaciones pendientes del
 * modo «pedir» (Aprobar / Rechazar), sus acciones como línea de tiempo y
 * «⏹ Frenar orquestación». El SSE (`tipo: 'orquestacion'`) la mantiene al día.
 * F2 — La activa se ve además como grafo vivo (la isla de Tuberías, `montarOrquestacion`): pasos,
 * tarjetas, lotes, la aprobación pendiente y los subagentes. Pide solo lo enlazado, por id.
 * F3 — La conversación con la sesión (`Conversacion`) y las aprobaciones de una herramienta del MCP (`local`):
 * aprobarlas no ejecuta nada, la sesión las usa al volver a pedirlas.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { BotonDosPasos, Cabecera, BarraProgreso } from './comp-base.js';
import { fechaCorta } from './fechas.js';
import { GrafoOrquestacion, textoAprobado } from './orquestacion-grafo.js';
import { Conversacion } from './orquestacion-conversacion.js';

const enc = encodeURIComponent;
/** Lista (la más nueva primero) | `{ error }` | null mientras carga. */
export const orquestaciones = signal(null);

export async function cargarOrquestaciones() {
  try { orquestaciones.value = (await api('/api/orquestaciones', undefined, { cache: 'no-store' })).orquestaciones || []; }
  catch (err) { orquestaciones.value = { error: err.message }; }
}

/** El SSE: reemplaza la orquestación que cambió (o la suma arriba). */
export function alCambiarOrquestacion(o) {
  const lista = Array.isArray(orquestaciones.value) ? orquestaciones.value : null;
  if (!lista || !o?.id) return;
  const i = lista.findIndex((x) => x.id === o.id);
  orquestaciones.value = i === -1 ? [o, ...lista] : lista.map((x) => (x.id === o.id ? o : x));
}

const MODO = { operar: 'solo operar', pedir: 'pide permiso', yolo: 'YOLO' };
const ICONO_PASO = { pendiente: '○', en_curso: '◐', hecho: '●', fallo: '✕' };
const TEXTO_RESULTADO = { ok: 'hecho', error: 'falló', rechazada: 'rechazada', pendiente: 'espera aprobación', en_curso: 'corriendo' };
/**
 * BE-132 — La última vista como activa conserva su grafo al terminar o frenarse: si se desmontara en el mismo
 * render, el festejo grande no vería la transición. Al recargar, una terminada vuelve a ser solo la lista.
 */
let conGrafo = null;

function Enlace({ e }) {
  const href = e.tipo === 'tarjeta' ? `/tablero?t=${enc(e.id)}` : '/pipelines';
  return html`<a class="orq-enlace" href=${href} data-ruta>${e.tipo === 'tarjeta' ? 'tarjeta' : 'lote'} <code>${e.id}</code></a>`;
}

function Pasos({ o }) {
  if (!o.pasos.length) return html`<p class="tenue">Sin pasos declarados.</p>`;
  const hechos = o.pasos.filter((p) => p.estado === 'hecho').length;
  return html`<div class="orq-pasos">
    <${BarraProgreso} valor=${hechos} max=${o.pasos.length} clase="orq-progreso" etiqueta="Pasos hechos" />
    <span class="tenue orq-cuenta-pasos">${hechos}/${o.pasos.length} pasos</span>
    <ol>${o.pasos.map((p) => html`<li key=${p.id} class=${`orq-paso orq-${p.estado}`}>
      <span class="orq-icono" aria-hidden="true">${ICONO_PASO[p.estado] || '○'}</span>
      <span class="orq-texto">${p.texto}</span><span class="visualmente-oculto">(${p.estado.replace('_', ' ')})</span>
      ${p.enlaces.length ? html`<span class="orq-enlaces">${p.enlaces.map((e) => html`<${Enlace} key=${`${e.tipo}${e.id}`} e=${e} />`)}</span>` : null}
    </li>`)}</ol>
  </div>`;
}

function Aprobaciones({ o, alResolver }) {
  const pendientes = o.aprobaciones.filter((a) => a.estado === 'pendiente');
  if (!pendientes.length) return null;
  const decidir = async (a, que) => {
    try {
      const r = await api(`/api/orquestaciones/${enc(o.id)}/aprobaciones/${enc(a.id)}/${que}`, {});
      avisar(que === 'aprobar' ? textoAprobado(a.metodo, r) : 'Rechazado.', r.ok === false ? 'error' : undefined);
    } catch (err) { avisar(err.message, 'error'); }
    alResolver();
  };
  return html`<section class="orq-aprobaciones" aria-label="Esperan tu aprobación">
    <h3>Esperan tu aprobación</h3>
    ${pendientes.map((a) => html`<div key=${a.id} class="orq-aprobacion">
      <div><b>${a.metodo}</b> ${a.local ? html`<span class="orq-resumen">${a.resumen || ''}</span>` : html`<code>${a.ruta}</code>`}<br /><span class="tenue">vence ${fechaCorta(a.vence)}</span></div>
      <span class="orq-acciones-aprob">
        <${BotonDosPasos} clase="boton" texto="Rechazar" armado="¿Rechazar? Clic de nuevo" alConfirmar=${() => decidir(a, 'rechazar')} />
        <${BotonDosPasos} clase="boton primario" data-nivel="ejecutar" texto="Aprobar" armado="¿Ejecutarlo? Clic de nuevo" alConfirmar=${() => decidir(a, 'aprobar')} />
      </span>
    </div>`)}
  </section>`;
}

function Acciones({ o }) {
  if (!o.acciones.length) return null;
  const ultimas = o.acciones.slice(-30).reverse();
  return html`<details class="orq-linea">
    <summary>Acciones (${o.acciones.length})</summary>
    <ol>${ultimas.map((a, i) => html`<li key=${`${a.t}${i}`} class=${`orq-res-${a.resultado}`}>
      <time datetime=${a.t}>${fechaCorta(a.t)}</time> <b>${a.metodo}</b>${a.ruta ? html` <code>${a.ruta}</code>` : null}
      <span class="orq-sep" aria-hidden="true">·</span><span class="orq-resultado">${TEXTO_RESULTADO[a.resultado] || a.resultado}</span>
      ${a.enlace ? html` <${Enlace} e=${a.enlace} />` : null}
    </li>`)}</ol>
  </details>`;
}

function Orquestacion({ o, alCambio }) {
  const frenar = async () => {
    try { await api(`/api/orquestaciones/${enc(o.id)}/frenar`, {}); avisar('Orquestación frenada: la sesión ya no puede hacer nada en su nombre.'); }
    catch (err) { avisar(err.message, 'error'); }
    alCambio();
  };
  const cerrar = async () => {
    try { await api(`/api/orquestaciones/${enc(o.id)}/cerrar`, {}); avisar('Orquestación cerrada.'); }
    catch (err) { avisar(err.message, 'error'); }
    alCambio();
  };
  const activa = o.estado === 'activa';
  if (activa) conGrafo = o.id;
  return html`<article class=${`orq-tarjeta orq-${o.estado}`} aria-label=${`Orquestación de ${o.quien}: ${o.titulo}`}>
    <header class="orq-cabecera">
      <span class="orq-quien">${o.quien}</span>
      <h2>${o.titulo}</h2>
      <span class=${`ficha orq-modo-${o.modo}`}>${MODO[o.modo] || o.modo}</span>
      <span class="ficha">${o.estado}</span>
      ${activa ? html`<${BotonDosPasos} clase="boton peligro derecha" texto="⏹ Frenar orquestación" armado="¿Frenarla? Clic de nuevo" alConfirmar=${frenar} />` : null}
      ${o.estado !== 'terminada' ? html`<${BotonDosPasos} clase="boton" texto="Cerrar" armado="¿Cerrarla? Clic de nuevo" alConfirmar=${cerrar} />` : null}
    </header>
    ${activa && o.modo === 'yolo' ? html`<p class="orq-yolo" role="note">YOLO: esta sesión lanza, integra y descarta sin preguntarte. Frenala si algo no te cierra.</p>` : null}
    ${activa || conGrafo === o.id ? html`<${GrafoOrquestacion} o=${o} alCambio=${alCambio} />` : null}
    <${Aprobaciones} o=${o} alResolver=${alCambio} />
    <${Conversacion} o=${o} />
    <${Pasos} o=${o} />
    <${Acciones} o=${o} />
  </article>`;
}

export function VistaOrquestacion() {
  // BE-132 — Al entrar a la vista (también navegando sin recargar), una terminada vuelve a ser solo la lista.
  const recien = useRef(true);
  if (recien.current) { recien.current = false; conGrafo = null; }
  useEffect(() => { cargarOrquestaciones(); }, []);
  const lista = orquestaciones.value;
  let cuerpo;
  let terminadas = [];
  let sinFoco = false;
  if (lista === null) cuerpo = html`<p class="tenue">cargando…</p>`;
  else if (lista.error) cuerpo = html`<p class="error">${lista.error}</p>`;
  else if (!lista.length) {
    cuerpo = html`<div class="vacio orq-vacio"><p>Ninguna sesión orquestó la consola todavía.</p>
      <p class="tenue">Pedíselo a Spica o a Epikouros: usan la herramienta <code>consola</code> (acción <code>abrir</code>) y el plan aparece acá, en vivo. Qué pueden hacer solas lo decidís en Ajustes › General.</p></div>`;
  } else {
    // BE-133 — A la vista, las activas y frenadas (y la que se acaba de terminar mirándola, BE-132); las terminadas,
    // plegadas en el lateral.
    const enFoco = (o) => o.estado !== 'terminada' || o.id === conGrafo;
    const orden = [...lista].filter(enFoco).sort((a, b) => (a.estado === 'activa' ? -1 : 0) - (b.estado === 'activa' ? -1 : 0));
    cuerpo = orden.length ? orden.map((o) => html`<${Orquestacion} key=${o.id} o=${o} alCambio=${cargarOrquestaciones} />`)
      : html`<p class="tenue orq-vacio">Ninguna orquestación en curso. Las terminadas están acá abajo.</p>`;
    terminadas = lista.filter((o) => !enFoco(o));
    // BE-135 — Sin ninguna en foco, la principal es una línea: las terminadas se llevan el ancho, desplegadas.
    sinFoco = !orden.length;
  }
  return html`<div class="orquestacion">
    <${Cabecera} titulo="Orquestación" />
    <div class=${`orq-layout${sinFoco ? ' sin-foco' : ''}`}>
      <div class="orq-lista">${cuerpo}</div>
      <${Lateral} terminadas=${terminadas} abiertas=${sinFoco} />
    </div>
  </div>`;
}

/**
 * BE-133 — La columna lateral (en pantalla ancha; en angosta va debajo). Hoy lleva las terminadas, plegadas; es el
 * esqueleto para sumar más cosas.
 */
function Lateral({ terminadas, abiertas }) {
  return html`<aside class="orq-lateral desplazable" aria-label="Más de la orquestación">
    ${terminadas.length ? html`<details class="orq-terminadas" open=${abiertas}>
      <summary>Terminadas (${terminadas.length})</summary>
      <ul>${terminadas.map((o) => html`<li key=${o.id}><details class="orq-terminada" name="orq-terminadas">
        <summary><span class="orq-quien">${o.quien}</span> ${o.titulo} <time class="tenue" datetime=${o.actualizada}>${fechaCorta(o.actualizada)}</time></summary>
        <${Orquestacion} o=${o} alCambio=${cargarOrquestaciones} />
      </details></li>`)}</ul>
    </details>` : null}
  </aside>`;
}
