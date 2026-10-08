/*
 * FEAT-136 — El helper de DOM imperativo del código viejo. Desde F4 la
 * consola entera son componentes: `el` queda solo para la vista de
 * rendimiento (`rendimiento-vista.js`, un script clásico sin módulos que arma
 * su DOM con el `el` que recibe al montarse).
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
