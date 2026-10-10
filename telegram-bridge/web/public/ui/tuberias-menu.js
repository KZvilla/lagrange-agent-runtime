/*
 * FEAT-149 F4a — El menú contextual del editor de grafos. La isla avisa dónde y sobre qué
 * (`{ tipo, id, x, y, posicion }`); acá se pinta un menú flotante en esa posición, dentro de la
 * ventana, con foco en la primera acción y flechas para moverse. Se cierra con Escape, con un clic
 * afuera, con scroll o al cambiar el tamaño de la ventana (el zoom y el paneo del lienzo los avisa
 * la isla). Sin librería: es un `role="menu"` con botones.
 */
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/hooks.module.js';
import { html } from './html.js';

const MARGEN = 8;

/** `items`: `[{ texto, accion, deshabilitado?, motivo?, peligro? } | 'separador']`. */
export function MenuContextual({ menu, titulo, items, alCerrar }) {
  const caja = useRef(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const el = caja.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(MARGEN, Math.min(menu.x, window.innerWidth - r.width - MARGEN));
    const top = Math.max(MARGEN, Math.min(menu.y, window.innerHeight - r.height - MARGEN));
    setPos({ left, top });
    el.querySelector('button:not([disabled])')?.focus();
  }, [menu.x, menu.y, menu.tipo, menu.id]);
  useEffect(() => {
    const afuera = (e) => { if (caja.current && !caja.current.contains(e.target)) alCerrar(); };
    const tecla = (e) => { if (e.key === 'Escape') { e.preventDefault(); alCerrar(); } };
    const cerrar = () => alCerrar();
    document.addEventListener('pointerdown', afuera, true);
    document.addEventListener('keydown', tecla);
    window.addEventListener('scroll', cerrar, true);
    window.addEventListener('resize', cerrar);
    return () => {
      document.removeEventListener('pointerdown', afuera, true);
      document.removeEventListener('keydown', tecla);
      window.removeEventListener('scroll', cerrar, true);
      window.removeEventListener('resize', cerrar);
    };
  }, [alCerrar]);
  const flechas = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const botones = [...caja.current.querySelectorAll('button:not([disabled])')];
    const i = botones.indexOf(document.activeElement);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? botones.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + botones.length) % botones.length;
    botones[j]?.focus();
  };
  return html`<div class="tub-menu" role="menu" aria-label=${titulo} ref=${caja} style=${`left:${pos.left}px;top:${pos.top}px`} onKeyDown=${flechas}
    onContextMenu=${(e) => e.preventDefault()}>
    <div class="tub-menu-titulo" aria-hidden="true">${titulo}</div>
    ${items.map((it, i) => (it === 'separador'
      ? html`<hr key=${`s${i}`} class="tub-menu-sep" />`
      : html`<button key=${it.texto} type="button" role="menuitem" class=${`tub-menu-item${it.peligro ? ' peligro' : ''}`} disabled=${Boolean(it.deshabilitado)}
          title=${it.motivo || ''} onClick=${() => { alCerrar(); it.accion(); }}>${it.texto}${it.atajo ? html`<kbd>${it.atajo}</kbd>` : null}</button>`))}
  </div>`;
}
