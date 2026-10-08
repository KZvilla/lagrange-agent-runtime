/*
 * FEAT-136 — Componentes de base reutilizables. Mismas clases CSS que el
 * código viejo (app.css no cambia): migrar una vista no cambia cómo se ve.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState, useEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { avisar, relativo } from './nucleo.js';

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
