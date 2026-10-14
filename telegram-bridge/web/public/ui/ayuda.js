/*
 * FEAT-160 F6 — Las explicaciones de «cómo funciona» van detrás de un ⓘ, no
 * como texto suelto. El globito se abre al pasar el mouse, con el foco del
 * teclado o con un toque (el teléfono no tiene hover), y Esc lo cierra.
 * No usa `title`: no anda con el dedo ni con un lector de pantalla.
 *
 * Lo que cuenta algo de *esta* tarjeta (estado, por qué no se puede lanzar)
 * no va acá: se queda visible.
 */
import { html } from './html.js';
import { useState } from '../vendor/hooks.module.js';

let siguiente = 0;

/** `etiqueta` nombra el ⓘ para un lector de pantalla («Ayuda: Notas»); `texto` es lo que explica. */
export function Ayuda({ etiqueta, texto }) {
  const [id] = useState(() => `ayuda-${++siguiente}`);
  const [fijo, setFijo] = useState(false);
  if (!texto) return null;
  const tecla = (ev) => { if (ev.key === 'Escape' && fijo) { ev.stopPropagation(); setFijo(false); } };
  return html`<span class=${`ayuda${fijo ? ' abierta' : ''}`} onClick=${(e) => e.stopPropagation()}>
    <button type="button" class="ayuda-boton" aria-label=${`Ayuda: ${etiqueta}`} aria-describedby=${id} aria-expanded=${String(fijo)}
      onClick=${() => setFijo(!fijo)} onKeyDown=${tecla} onBlur=${() => setFijo(false)}>i</button>
    <span class="ayuda-globo" role="tooltip" id=${id}>${texto}</span>
  </span>`;
}
