/*
 * FEAT-136 — Componentes de base reutilizables. Mismas clases CSS que el
 * código viejo (app.css no cambia): migrar una vista no cambia cómo se ve.
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

/** Botón de dos pasos para lo destructivo: el primer clic arma, el segundo confirma (4 s). */
export function BotonDosPasos({ texto, armado = '¿seguro?', clase = 'accion peligro', alConfirmar, ...resto }) {
  const [listo, setListo] = useState(false);
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  const clic = async () => {
    if (!listo) {
      setListo(true);
      t.current = setTimeout(() => setListo(false), 4000);
      return;
    }
    clearTimeout(t.current);
    setListo(false);
    await alConfirmar?.();
  };
  return html`<button type="button" class=${`${clase}${listo ? ' armado' : ''}`} onClick=${clic} ...${resto}>${listo ? armado : texto}</button>`;
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
