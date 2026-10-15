/*
 * FEAT-162 F2 — El cargador de la isla del grafo (FEAT-148), compartido por Tuberías y
 * Orquestación: agrega `/grafo.css` una vez y hace el `import()` del bundle una sola vez
 * (si falla, el próximo intento vuelve a probar).
 */
let isla = null;

export function cargarIsla() {
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
