/*
 * FEAT-136 — Los eventos del SSE para el mundo nuevo.
 *
 * Hasta F4 el `EventSource` vive en `app.js` (una sola conexión, y los
 * navegadores sin módulos siguen recibiendo eventos): `app.js` reenvía cada
 * evento ya parseado a `window.lagrangeUI.evento(e)`, que llega acá. Cada
 * oyente escribe solo en sus señales; nunca en el `estado` de `app.js`.
 */
const oyentes = new Map();

/** Registra un oyente para un `tipo` de evento; devuelve cómo darlo de baja. */
export function alEvento(tipo, fn) {
  if (!oyentes.has(tipo)) oyentes.set(tipo, new Set());
  oyentes.get(tipo).add(fn);
  return () => oyentes.get(tipo)?.delete(fn);
}

/** Un evento del SSE. Un oyente que falla no corta a los demás. Devuelve cuántos lo recibieron. */
export function despachar(e) {
  if (!e || typeof e !== 'object' || typeof e.tipo !== 'string') return 0;
  let n = 0;
  for (const fn of [...(oyentes.get(e.tipo) || []), ...(oyentes.get('*') || [])]) {
    try { fn(e); n++; } catch (err) { console.error('[lagrangeUI]', e.tipo, err); }
  }
  return n;
}

/** Solo para los tests. */
export function olvidarOyentes() { oyentes.clear(); }
