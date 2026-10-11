/*
 * FEAT-148 / FEAT-150 — El lienzo de Tuberías: carga la isla del grafo (TypeScript, con import
 * dinámico solo al entrar), mide su ancho y arma la disposición de cada dibujo.
 *
 * Contrato con la isla: `montar(el, props) → { actualizar(props), desmontar() }`. La isla avisa
 * (`alElegir`, `alMover`, `alCandado`…) y esta capa decide qué se guarda y dónde.
 *
 * Disposición (FEAT-150), por capas: acomodo automático ← la de la receta ← el ajuste de este
 * dispositivo. El ajuste y el candado viven en `localStorage` (conveniencia por dispositivo: si se
 * pierden, se vuelve al automático). En un lienzo angosto el acomodo es vertical y la disposición
 * de la receta (pensada en horizontal) no se usa.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { persistente, porClave } from './persistencia.js';

export const ANGOSTO_PX = 720;
/** `angosta` | `ancha`: la mide el lienzo montado. */
export const claseLienzo = signal('ancha');
export const candadoTub = persistente('tuberias.candado', true, { validar: (v) => typeof v === 'boolean' });
// F4a — En un grafo los ids de nodo son libres (los de la clásica cumplen la misma forma).
const ID_NODO = /^[a-z][a-z0-9-]{0,23}$/;
export const esDisposicion = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  && Object.entries(v).every(([k, xy]) => ID_NODO.test(k) && Array.isArray(xy) && xy.length === 2 && xy.every((n) => Number.isFinite(n) && Math.abs(n) <= 10000));
const ajustesTub = porClave('tuberias.disposicion', null, { validar: (v) => v === null || esDisposicion(v), tope: 40 });

/**
 * Las props de disposición del visor y del borrador: el ajuste de este dispositivo para esa receta
 * y clase de pantalla, o la de la receta (solo en ancha). Mover guarda el ajuste; restablecer lo borra.
 */
export function propsDisposicion(clave, base = null) {
  const vertical = claseLienzo.value === 'angosta';
  const ajuste = ajustesTub.de(`${clave}|${vertical ? 'angosta' : 'ancha'}`);
  const propia = ajuste.value;
  const deReceta = !vertical && esDisposicion(base) ? base : null;
  return {
    vertical, candado: candadoTub.value, disposicion: propia || deReceta,
    textoAjuste: propia ? 'guardada en este dispositivo' : (deReceta ? 'de la recipe' : null),
    alCandado: (c) => { candadoTub.value = c; },
    alMover: (d) => { ajuste.value = d; },
    ...(propia ? { alRestablecer: () => { ajuste.value = null; } } : {})
  };
}

let isla = null;
function cargarIsla() {
  if (!document.querySelector('link[data-grafo]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/grafo.css';
    css.dataset.grafo = '';
    document.head.append(css);
  }
  isla ??= import('../vendor/grafo.module.js').catch((err) => { isla = null; throw err; });
  return isla;
}

export function Lienzo({ props }) {
  const nodo = useRef(null);
  const instancia = useRef(null);
  // Los últimos datos: si cambian mientras la isla carga, se monta con estos y no con los del primer pintado.
  const ultimos = useRef(props);
  ultimos.current = props;
  const [fallo, setFallo] = useState(null);
  useEffect(() => {
    let vivo = true;
    cargarIsla().then((m) => {
      if (!vivo || !nodo.current) return;
      instancia.current = m.montar(nodo.current, ultimos.current);
    }, (err) => { if (vivo) setFallo(err.message || String(err)); });
    // FEAT-150 — La clase de pantalla sale del ancho del lienzo, no de la ventana.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(([e]) => {
      const ancho = e.contentRect.width;
      if (ancho > 0) claseLienzo.value = ancho < ANGOSTO_PX ? 'angosta' : 'ancha';
    });
    if (ro && nodo.current) ro.observe(nodo.current);
    return () => { vivo = false; ro?.disconnect(); instancia.current?.desmontar(); instancia.current = null; };
  }, []);
  useEffect(() => { instancia.current?.actualizar(props); }, [props]);
  if (fallo) return html`<p class="error">No se pudo cargar el grafo: ${fallo}. Recargá la página.</p>`;
  return html`<div class="tub-isla" ref=${nodo}></div>`;
}

/**
 * FEAT-150 — El inspector como cajón inferior en pantallas angostas (CSS): la barra alterna medio
 * y pantalla completa. En pantallas anchas es transparente (`display: contents`).
 */
export function Cajon({ children }) {
  const [completo, setCompleto] = useState(false);
  return html`<div class=${`tub-cajon${completo ? ' completo' : ''}`}>
    <button type="button" class="tub-cajon-barra" aria-expanded=${String(completo)} aria-label=${completo ? 'Achicar el detalle' : 'Detalle a pantalla completa'}
      onClick=${() => setCompleto(!completo)}><span aria-hidden="true"></span></button>
    ${children}
  </div>`;
}
