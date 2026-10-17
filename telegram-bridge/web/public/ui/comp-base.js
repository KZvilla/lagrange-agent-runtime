/*
 * FEAT-136 — Componentes de base reutilizables. Mismas clases CSS que el
 * código viejo (app.css no cambia): migrar una vista no cambia cómo se ve.
 * BE-141 — Acá viven también el menú de acciones (`MenuAcciones`), el diálogo modal (`Dialogo`), los campos
 * (`Campo`, `CampoTub`) y la barra de progreso (`BarraProgreso`). Selectores y campos de texto toman su aspecto de
 * la regla base de app.css. Lo nuevo sale de acá: no se escribe otro a mano.
 * Sin componente, a propósito: los vacíos (`.vacio`), los botones (`.boton` y sus modificadores) y las fichas (`.ficha`)
 * ya son clases comunes; las cabeceras y los formularios en línea se componen en cada vista; `MenuCancelar` (barra),
 * `MenuContextual` (Tuberías, comparte las flechas), `Hoja` (teléfono), la paleta y el visor tienen comportamiento propio.
 * BE-141 — Los <select> no llevan envoltorio: su componente es la regla base `select { … }` de app.css.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState, useEffect, useLayoutEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { avisar, relativo, duracion, tono, ICONOS } from './nucleo.js';

/** Un reloj global: `Relativo` lo lee y se actualiza solo, sin redibujar la vista. */
export const ahora = signal(Date.now());
setInterval(() => { ahora.value = Date.now(); }, 30_000);

/** «hace 5 min», que se mantiene al día. */
export function Relativo({ iso }) {
  void ahora.value;
  return relativo(iso);
}

export function Icono({ d, tam = 14 }) {
  return html`<svg width=${tam} height=${tam} viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d=${d} /></svg>`;
}

/** Copia un texto; «Copiado» dos segundos y, si el portapapeles falla, un aviso. */
export function BotonCopiar({ texto, etiqueta = 'Copiar', clase = 'boton' }) {
  const [hecho, setHecho] = useState(false);
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setHecho(true);
      clearTimeout(t.current);
      t.current = setTimeout(() => setHecho(false), 2000);
    } catch {
      avisar('No se pudo copiar: seleccioná el comando a mano.', 'error');
    }
  };
  return html`<button type="button" class=${clase} onClick=${copiar}>${hecho ? 'Copiado' : etiqueta}</button>`;
}

/** Un enlace externo seguro. */
export function Externo({ href, children }) {
  return html`<a href=${href} target="_blank" rel="noopener noreferrer">${children}</a>`;
}

/** Cabecera de página (título y explicación), como `programado-cabecera`. */
export function Cabecera({ titulo, meta }) {
  return html`<div class="programado-cabecera"><h2>${titulo}</h2>${meta ? html`<p class="meta">${meta}</p>` : null}</div>`;
}

/** Un tic por segundo, solo mientras alguien lo mira (un reloj en curso). */
const segundo = signal(Date.now());
let ticSegundo = null;
let mirandoSegundo = 0;
function usarSegundo() {
  useEffect(() => {
    mirandoSegundo++;
    if (!ticSegundo) ticSegundo = setInterval(() => { segundo.value = Date.now(); }, 1000);
    return () => { if (--mirandoSegundo === 0) { clearInterval(ticSegundo); ticSegundo = null; } };
  }, []);
  return segundo.value;
}

/** Cuánto lleva algo en curso; se actualiza solo cada segundo. */
export function Reloj({ desde, clase = 'mono tenue' }) {
  const ahoraMs = usarSegundo();
  const t = Date.parse(desde);
  return html`<span class=${clase}>${Number.isFinite(t) ? duracion(ahoraMs - t) : ''}</span>`;
}

/**
 * Botón de dos pasos para lo destructivo: el primer clic arma, el segundo confirma (4 s).
 * FEAT-163 — Armado muestra un texto corto (`confirmar`, «¿Seguro?») y un borde que pulsa; la frase de `armado`
 * va a `title` y `aria-label`, así el botón no crece ni rompe el layout. Mantiene su ancho mientras está armado.
 * Un `armado` que no es texto (el bloque de la barra, FEAT-160 F5b) se muestra tal cual.
 */
export function BotonDosPasos({ texto, armado = '¿Seguro?', confirmar = '¿Seguro?', clase = 'accion peligro', alConfirmar, ...resto }) {
  const [listo, setListo] = useState(false);
  const [ancho, setAncho] = useState(null);
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  const frase = typeof armado === 'string' ? armado : null;
  const clic = async (e) => {
    if (!listo) {
      if (frase) setAncho(e.currentTarget.offsetWidth || null);
      setListo(true);
      t.current = setTimeout(() => { setListo(false); setAncho(null); }, 4000);
      return;
    }
    clearTimeout(t.current);
    setListo(false);
    setAncho(null);
    await alConfirmar?.();
  };
  const armadoAttrs = listo && frase ? { title: frase, 'aria-label': frase, style: ancho ? { minWidth: `${ancho}px` } : undefined } : {};
  return html`<button type="button" class=${`${clase}${listo ? ' armado' : ''}`} onClick=${clic} ...${resto} ...${armadoAttrs}>${listo ? (frase ? confirmar : armado) : texto}</button>`;
}

/** El avatar de un alma (inicial con su tono) o de un agente (dos iniciales). */
export function Avatar({ s, tam = '', children }) {
  if (s.tipo === 'alma') {
    const inicial = (s.voz || s.clave || '?').trim().charAt(0).toUpperCase();
    return html`<div class=${`avatar alma ${tono(s.clave)} ${tam}`} aria-hidden="true">${inicial}${children}</div>`;
  }
  const partes = String(s.nombre).replace(/^lagrange-/, '').split(/[-_]/).filter(Boolean);
  const iniciales = (partes.length > 1 ? partes[0][0] + partes[1][0] : (partes[0] || '?').slice(0, 2)).toLowerCase();
  return html`<div class=${`avatar agente ${tam}`} aria-hidden="true">${iniciales}${children}</div>`;
}

/** FEAT-082 — Cabecera de un cajón (panel o lateral): título, subtítulo y el botón que lo cierra. */
export function CabeceraCajon({ titulo, sub, previo = null, alCerrar }) {
  return html`<div class="cajon-cabecera">
    ${previo}
    <div class="cajon-titulo">
      <div class="sujeto-nombre">${titulo}</div>
      ${sub ? html`<div class="cajon-sub">${sub}</div>` : null}
    </div>
    <button type="button" class="boton-icono" title="Cerrar (Esc)" aria-label="Cerrar (Esc)" onClick=${() => alCerrar?.()}><${Icono} d=${ICONOS.cerrar} /></button>
  </div>`;
}

const ENFOCABLE = 'input, select, textarea, button:not([disabled])';

/** BE-141 — Flechas, Inicio y Fin entre los ítems habilitados de un menú (`MenuAcciones`, `MenuContextual`). */
export function moverFocoConFlechas(e, caja, selector = '[role="menuitem"]:not([disabled])') {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const botones = [...caja.querySelectorAll(selector)];
  const i = botones.indexOf(document.activeElement);
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? botones.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + botones.length) % botones.length;
  botones[j]?.focus();
}

/**
 * BE-141 — El diálogo modal: velo, foco al primer campo al abrir y de vuelta a quien lo abrió al cerrar; Esc (con el
 * foco adentro, sin llegar al detalle ni al cajón) y un clic en el velo cierran. La hoja del teléfono es `hoja.js`.
 */
export function Dialogo({ etiqueta, peligro = false, alCerrar, children }) {
  const caja = useRef(null);
  useEffect(() => {
    const previo = document.activeElement;
    caja.current?.querySelector(ENFOCABLE)?.focus();
    return () => { if (previo?.isConnected) previo.focus(); };
  }, []);
  return html`<div class="dialogo-fondo" onClick=${(e) => { if (e.target === e.currentTarget) alCerrar(); }}>
    <div ref=${caja} class=${`dialogo${peligro ? ' peligro' : ''}`} role="dialog" aria-modal="true" aria-label=${etiqueta}
      onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); alCerrar(); } }}>${children}</div></div>`;
}

/**
 * El menú de acciones: «⋮» de la tarjeta y «Mover a…» del detalle (BE-141: vino de tablero-tarjeta.js). Cada ítem es
 * `{ clave?, texto, sufijo?, titulo?, hacer, peligro?, nivel?, armado?, no?, motivo?, confirmar? }`:
 * `confirmar` (la pregunta) pide confirmación en el menú; `armado` (el texto
 * armado) lo vuelve de dos pasos; `no` lo deshabilita; un `motivo` lo deja
 * enfocable (aria-disabled) para que se lea por qué, pero no hace nada.
 * BE-142 — `items` también puede ser una función: se llama al dibujar el menú (al abrirlo), así lee el estado de
 * ese momento aunque la tarjeta que lo contiene no se haya vuelto a dibujar (la lista del tablero se muta en el lugar).
 */
const MARGEN_MENU = 8;
/** BE-143 — Sin separadores al principio, al final ni dos seguidos (los ítems condicionales pueden dejarlos sueltos). */
const sinSeparadoresDeMas = (xs) => xs.filter((d, i) => d !== 'separador' || (i > 0 && i < xs.length - 1 && xs[i - 1] !== 'separador'));

export function MenuAcciones({ disparador, clase, etiqueta, items, abajo = false }) {
  const [abierto, setAbierto] = useState(false);
  const [confirmando, setConfirmando] = useState(null);
  const raiz = useRef(null);
  const boton = useRef(null);
  // BE-142 — Con Esc o al elegir, el foco vuelve al disparador; con un clic afuera, no (queda donde se hizo clic).
  const cerrar = (devolver = false) => { setAbierto(false); setConfirmando(null); if (devolver) boton.current?.focus(); };
  // BE-141 — Al abrir, el foco va al primer ítem; las flechas se mueven entre ellos.
  // BE-142 — Sin desplazar la página.
  // BE-143 — La lista flota (`position: fixed`): ninguna columna con overflow la recorta. Va debajo del disparador, o
  // arriba si no entra; alineada a la derecha con `abajo`; siempre dentro de la ventana. Por CSSOM (la CSP no deja
  // estilos en texto) y oculta hasta medirla.
  useLayoutEffect(() => {
    const menu = raiz.current?.querySelector('[role="menu"]');
    if (!abierto || !menu || !boton.current) return;
    const d = boton.current.getBoundingClientRect();
    const r = menu.getBoundingClientRect();
    let top = d.bottom + 4;
    if (top + r.height > window.innerHeight - MARGEN_MENU && d.top - r.height - 4 >= MARGEN_MENU) top = d.top - r.height - 4;
    const left = Math.min(Math.max(MARGEN_MENU, abajo ? d.right - r.width : d.left), window.innerWidth - r.width - MARGEN_MENU);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(Math.max(MARGEN_MENU, top))}px`;
    menu.style.visibility = 'visible';
    menu.querySelector('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
  }, [abierto, confirmando]);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (ev) => { if (!raiz.current?.contains(ev.target)) cerrar(); };
    const tecla = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); cerrar(true); } };
    // BE-143 — Flotando, quedaría suelto si se desplaza lo de abajo: se cierra (salvo un scroll del propio menú).
    const desplazar = (ev) => { if (!raiz.current?.contains(ev.target)) cerrar(); };
    const redimensionar = () => cerrar();
    document.addEventListener('pointerdown', fuera, true);
    document.addEventListener('keydown', tecla, true);
    window.addEventListener('scroll', desplazar, true);
    window.addEventListener('resize', redimensionar);
    return () => {
      document.removeEventListener('pointerdown', fuera, true); document.removeEventListener('keydown', tecla, true);
      window.removeEventListener('scroll', desplazar, true); window.removeEventListener('resize', redimensionar);
    };
  }, [abierto]);
  const todos = typeof items === 'function' ? items() : items;
  if (!todos?.length) return null;
  const elegir = (d) => {
    // FEAT-160 F3 — Un destino con motivo sigue enfocable (aria-disabled) para que se lea por qué, pero no hace nada.
    if (d.motivo) return;
    if (d.confirmar) { setConfirmando(d); return; }
    cerrar(true);
    d.hacer();
  };
  // BE-143 — `'separador'` es una línea; `icono` (un path de `Icono`) va antes del texto.
  const conIcono = (d) => (d.icono ? html`<${Icono} d=${d.icono} />${d.texto}` : d.texto);
  const item = (d, i) => (d === 'separador' ? html`<hr key=${`s${i}`} class="menu-sep" />` : d.armado
    ? html`<${BotonDosPasos} key=${d.clave || d.texto} role="menuitem" clase=${d.peligro ? 'peligro' : ''} texto=${conIcono(d)} armado=${d.armado} alConfirmar=${() => { cerrar(true); return d.hacer(); }} />`
    : html`<button key=${d.clave || d.texto} type="button" role="menuitem" disabled=${Boolean(d.no)} aria-disabled=${d.motivo ? 'true' : undefined} title=${d.titulo}
        class=${d.peligro ? 'peligro' : undefined} data-nivel=${d.nivel === 'ejecutar' ? 'ejecutar' : undefined} onClick=${() => elegir(d)}>${conIcono(d)}${d.sufijo ? html`<span class="tenue">${d.sufijo}</span>` : null}${d.motivo ? html`<span class="menu-motivo">${d.motivo}</span>` : null}</button>`);
  const lista = confirmando
    ? html`<p class="menu-nota">${confirmando.confirmar}</p>
        <button type="button" role="menuitem" class="peligro" data-nivel=${confirmando.nivel === 'ejecutar' ? 'ejecutar' : undefined}
          onClick=${() => { const d = confirmando; cerrar(true); d.hacer(); }}>${confirmando.texto}</button>
        <button type="button" role="menuitem" onClick=${() => setConfirmando(null)}>No</button>`
    : sinSeparadoresDeMas(todos).map(item);
  return html`<span class=${`menu-mover${abierto ? ' abierto' : ''}`} ref=${raiz} onClick=${(e) => e.stopPropagation()}>
    <button ref=${boton} type="button" class=${clase} aria-haspopup="menu" aria-expanded=${String(abierto)} aria-label=${etiqueta} title=${etiqueta}
      onClick=${() => { setAbierto(!abierto); setConfirmando(null); }}>${disparador}</button>
    ${abierto ? html`<div class="menu menu-mover-lista" role="menu" onKeyDown=${(e) => moverFocoConFlechas(e, e.currentTarget)}>${lista}</div>` : null}
  </span>`;
}

/**
 * BE-143 — Un grupo de opciones excluyentes: `opciones` es `[[valor, texto, peligro?]]`. `attrs` (p. ej. `data-campo`
 * y la clase de error de Ajustes) se suma sin pisar la clase propia: antes el spread la pisaba con `class: null` y los
 * botones salían nativos, sin el elegido a la vista.
 */
export function Segmentado({ etiqueta, opciones, valor, alElegir, attrs = null }) {
  const { class: extra, ...resto } = attrs || {};
  return html`<div class=${extra ? `segmentado ${extra}` : 'segmentado'} role="group" aria-label=${etiqueta} ...${resto}>
    ${opciones.map(([v, t, peligro]) => html`<button key=${String(v)} type="button" aria-pressed=${String(valor === v)}
      class=${[valor === v ? 'activo' : '', peligro ? 'peligro' : ''].filter(Boolean).join(' ') || null} onClick=${() => alElegir(v)}>${t}</button>`)}
  </div>`;
}

/** BE-141 — Un campo con su rótulo arriba (`.campo`, el del tablero). */
export function Campo({ texto, children }) {
  return html`<label class="campo"><span class="bloque-titulo">${texto}</span>${children}</label>`;
}

/** BE-141 — El campo compacto de Tuberías (`.tub-campo`): rótulo chico arriba. */
export function CampoTub({ texto, children }) {
  return html`<label class="tub-campo"><span>${texto}</span>${children}</label>`;
}

/** BE-141 — Una barra de progreso accesible. El ancho va por CSSOM (la CSP no deja estilos en texto). */
export function BarraProgreso({ valor, max = 100, etiqueta, clase = null }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((valor / max) * 100))) : 0;
  return html`<span class=${clase ? `barra-progreso ${clase}` : 'barra-progreso'} role="progressbar" aria-valuemin="0" aria-valuemax=${String(max)}
    aria-valuenow=${String(valor)} aria-label=${etiqueta}><span style=${{ width: `${pct}%` }}></span></span>`;
}
