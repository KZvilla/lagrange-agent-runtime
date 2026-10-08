/*
 * FEAT-136 — El HTML acotado de los resultados (`resultadoHtml`, que arma el
 * servidor) se reconstruye nodo por nodo con una lista blanca. Nunca
 * innerHTML ni dangerouslySetInnerHTML: el componente cuelga los nodos en un
 * contenedor propio (ref) que Preact no maneja (auditoría del plan, NOTE).
 */
import { useRef, useLayoutEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';

const PERMITIDAS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'INS', 'S', 'STRIKE', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE', 'BR', 'SPAN', 'TG-SPOILER']);

export function copiarSeguro(origen, destino) {
  for (const n of origen.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { destino.append(n.textContent); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    if (n.tagName === 'A') {
      const href = n.getAttribute('href') || '';
      const a = document.createElement('a');
      a.setAttribute('rel', 'noopener noreferrer');
      a.setAttribute('target', '_blank');
      if (/^https?:\/\//i.test(href)) a.setAttribute('href', href);
      copiarSeguro(n, a);
      destino.append(a);
    } else if (PERMITIDAS.has(n.tagName)) {
      const c = document.createElement(n.tagName === 'TG-SPOILER' ? 'span' : n.tagName.toLowerCase());
      copiarSeguro(n, c);
      destino.append(c);
    } else {
      copiarSeguro(n, destino);
    }
  }
}

export function pintarResultado(nodo, tarea) {
  nodo.replaceChildren();
  if (tarea.resultadoHtml) {
    const doc = new DOMParser().parseFromString(`<body>${tarea.resultadoHtml}</body>`, 'text/html');
    copiarSeguro(doc.body, nodo);
  } else {
    nodo.textContent = tarea.resultado || '';
  }
}

/** La respuesta de una tarea, dentro de su burbuja. */
export function Resultado({ t, clase = 'burbuja suya' }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    if (t.tieneResultado === true && !('resultado' in t)) ref.current.textContent = '…';
    else pintarResultado(ref.current, t);
  }, [t.resultado, t.resultadoHtml, t.tieneResultado]);
  return html`<div class=${clase} ref=${ref}></div>`;
}
