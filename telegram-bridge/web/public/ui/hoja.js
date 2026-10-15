/*
 * FEAT-160 F5b — La hoja inferior del teléfono (alta y filtros del tablero) y
 * `enCarrusel`, la media query del carrusel como señal: los componentes que
 * cambian de forma en el teléfono la leen y se redibujan al cruzar el umbral.
 *
 * El velo es hermano del diálogo, no su padre: un `pointerdown` en un campo
 * nunca llega al velo. Esc cierra en captura y no sigue (no cierra también el
 * detalle ni el cajón, que escucha app.js).
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { MQ_CARRUSEL } from './telefono.js';

const mq = typeof matchMedia === 'function' ? matchMedia(MQ_CARRUSEL) : null;
export const enCarrusel = signal(Boolean(mq?.matches));
mq?.addEventListener('change', (ev) => { enCarrusel.value = ev.matches; });

const ENFOCABLE = 'input, textarea, select, button:not([disabled])';

/** `pie` y `aparte` son contenido; quien llama devuelve el foco al cerrar (sabe qué botón abrió). */
export function Hoja({ id, titulo, aparte, alCerrar, pie, children }) {
  const dialogo = useRef(null);
  useEffect(() => {
    dialogo.current?.querySelector(`.hoja-cuerpo :is(${ENFOCABLE})`)?.focus();
    const tecla = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      alCerrar();
    };
    window.addEventListener('keydown', tecla, true);
    return () => window.removeEventListener('keydown', tecla, true);
  }, []);
  return html`<div class="velo-hoja" aria-hidden="true" onPointerDown=${(ev) => { ev.preventDefault(); alCerrar(); }}></div>
    <section class="hoja" id=${id} role="dialog" aria-modal="true" aria-labelledby=${`${id}-titulo`} ref=${dialogo}>
      <div class="hoja-tirador" aria-hidden="true"></div>
      <div class="hoja-cab"><h2 id=${`${id}-titulo`}>${titulo}</h2>${aparte ? html`<div class="hoja-aparte">${aparte}</div>` : null}</div>
      <div class="hoja-cuerpo">${children}</div>
      ${pie ? html`<div class="hoja-pie">${pie}</div>` : null}
    </section>`;
}
