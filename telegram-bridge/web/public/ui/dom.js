/*
 * FEAT-136 — Los helpers de DOM imperativo del código viejo (`el`, `icono`).
 * Solo los usa `app.js` mientras le queden vistas sin migrar; se borra en F4.
 */
export function el(tag, props, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) e.append(h);
  return e;
}

export const SVG = 'http://www.w3.org/2000/svg';
export function icono(dibujo, tam = 14) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('width', tam);
  s.setAttribute('height', tam);
  s.setAttribute('viewBox', '0 0 14 14');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.4');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', dibujo);
  s.append(p);
  return s;
}
