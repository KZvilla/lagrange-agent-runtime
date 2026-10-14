/*
 * FEAT-160 F6 — Las explicaciones de «cómo funciona» van detrás de un ⓘ, no
 * como texto suelto. El globito se abre al pasar el mouse, con el foco del
 * teclado o con un toque (el teléfono no tiene hover), y Esc lo cierra.
 * No usa `title`: no anda con el dedo ni con un lector de pantalla.
 *
 * El globo es `position: fixed` y se ubica contra la ventana al abrirse: dentro
 * de un panel con scroll (el detalle) no se recorta, abre hacia arriba si abajo
 * no entra y no se sale por los costados.
 *
 * Lo que cuenta algo de *esta* tarjeta (estado, por qué no se puede lanzar)
 * no va acá: se queda visible.
 */
import { html } from './html.js';
import { useState, useRef } from '../vendor/hooks.module.js';

let siguiente = 0;
const MARGEN = 8;

/** Pone el globo junto al ⓘ, dentro de la ventana. Se mide en el cuadro siguiente: recién ahí el CSS lo muestra. */
function ubicar(raiz) {
  requestAnimationFrame(() => {
    const g = raiz?.querySelector('.ayuda-globo');
    const b = raiz?.querySelector('.ayuda-boton')?.getBoundingClientRect();
    if (!g || !b || !g.offsetWidth) return;
    const left = Math.max(MARGEN, Math.min(b.left + b.width / 2 - g.offsetWidth / 2, innerWidth - g.offsetWidth - MARGEN));
    const abajo = b.bottom + 6;
    const top = abajo + g.offsetHeight > innerHeight - MARGEN && b.top - 6 - g.offsetHeight >= MARGEN ? b.top - 6 - g.offsetHeight : abajo;
    g.style.left = `${Math.round(left)}px`;
    g.style.top = `${Math.round(top)}px`;
    g.style.visibility = 'visible';
  });
}

/** `etiqueta` nombra el ⓘ para un lector de pantalla («Ayuda: Notas»); `texto` es lo que explica. */
export function Ayuda({ etiqueta, texto }) {
  const [id] = useState(() => `ayuda-${++siguiente}`);
  const [fijo, setFijo] = useState(false);
  const raiz = useRef(null);
  if (!texto) return null;
  const abrir = () => ubicar(raiz.current);
  const tecla = (ev) => { if (ev.key === 'Escape' && fijo) { ev.stopPropagation(); setFijo(false); } };
  return html`<span ref=${raiz} class=${`ayuda${fijo ? ' abierta' : ''}`} onClick=${(e) => e.stopPropagation()} onMouseEnter=${abrir}>
    <button type="button" class="ayuda-boton" aria-label=${`Ayuda: ${etiqueta}`} aria-describedby=${id} aria-expanded=${String(fijo)}
      onClick=${() => { setFijo(!fijo); abrir(); }} onFocus=${abrir} onKeyDown=${tecla} onBlur=${() => setFijo(false)}>i</button>
    <span class="ayuda-globo" role="tooltip" id=${id}>${texto}</span>
  </span>`;
}
