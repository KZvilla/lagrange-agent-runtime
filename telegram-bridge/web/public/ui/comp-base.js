/*
 * FEAT-136 — Componentes de base reutilizables. Mismas clases CSS que el
 * código viejo (app.css no cambia): migrar una vista no cambia cómo se ve.
 * BE-141 — Acá viven también el menú de acciones (`MenuAcciones`) y el diálogo modal (`Dialogo`).
 * BE-141 — Los <select> no llevan envoltorio: su componente es la regla base `select { … }` de app.css.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState, useEffect, useRef } from '../vendor/hooks.module.js';
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
 */
export function MenuAcciones({ disparador, clase, etiqueta, items, abajo = false }) {
  const [abierto, setAbierto] = useState(false);
  const [confirmando, setConfirmando] = useState(null);
  const raiz = useRef(null);
  // BE-141 — Al abrir, el foco va al primer ítem; las flechas se mueven entre ellos.
  useEffect(() => { if (abierto) raiz.current?.querySelector('[role="menu"] [role="menuitem"]:not([disabled])')?.focus(); }, [abierto, confirmando]);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (ev) => { if (!raiz.current?.contains(ev.target)) { setAbierto(false); setConfirmando(null); } };
    const tecla = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); setAbierto(false); setConfirmando(null); } };
    document.addEventListener('pointerdown', fuera, true);
    document.addEventListener('keydown', tecla, true);
    return () => { document.removeEventListener('pointerdown', fuera, true); document.removeEventListener('keydown', tecla, true); };
  }, [abierto]);
  if (!items?.length) return null;
  const cerrar = () => { setAbierto(false); setConfirmando(null); };
  const elegir = (d) => {
    // FEAT-160 F3 — Un destino con motivo sigue enfocable (aria-disabled) para que se lea por qué, pero no hace nada.
    if (d.motivo) return;
    if (d.confirmar) { setConfirmando(d); return; }
    cerrar();
    d.hacer();
  };
  const item = (d) => (d.armado
    ? html`<${BotonDosPasos} key=${d.clave || d.texto} role="menuitem" clase=${d.peligro ? 'peligro' : ''} texto=${d.texto} armado=${d.armado} alConfirmar=${() => { cerrar(); return d.hacer(); }} />`
    : html`<button key=${d.clave || d.texto} type="button" role="menuitem" disabled=${Boolean(d.no)} aria-disabled=${d.motivo ? 'true' : undefined} title=${d.titulo}
        class=${d.peligro ? 'peligro' : undefined} data-nivel=${d.nivel === 'ejecutar' ? 'ejecutar' : undefined} onClick=${() => elegir(d)}>${d.texto}${d.sufijo ? html`<span class="tenue">${d.sufijo}</span>` : null}${d.motivo ? html`<span class="menu-motivo">${d.motivo}</span>` : null}</button>`);
  const lista = confirmando
    ? html`<p class="menu-nota">${confirmando.confirmar}</p>
        <button type="button" role="menuitem" class="peligro" data-nivel=${confirmando.nivel === 'ejecutar' ? 'ejecutar' : undefined}
          onClick=${() => { const d = confirmando; cerrar(); d.hacer(); }}>${confirmando.texto}</button>
        <button type="button" role="menuitem" onClick=${() => setConfirmando(null)}>No</button>`
    : items.map(item);
  return html`<span class=${`menu-mover${abierto ? ' abierto' : ''}`} ref=${raiz} onClick=${(e) => e.stopPropagation()}>
    <button type="button" class=${clase} aria-haspopup="menu" aria-expanded=${String(abierto)} aria-label=${etiqueta} title=${etiqueta}
      onClick=${() => { setAbierto(!abierto); setConfirmando(null); }}>${disparador}</button>
    ${abierto ? html`<div class=${`menu menu-mover-lista${abajo ? ' abajo' : ''}`} role="menu" onKeyDown=${(e) => moverFocoConFlechas(e, e.currentTarget)}>${lista}</div>` : null}
  </span>`;
}
