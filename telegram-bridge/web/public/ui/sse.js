/*
 * FEAT-136 — Los eventos del SSE para el mundo nuevo.
 *
 * F4 — La única conexión (`conectar`) vive acá: cada evento parseado pasa
 * por los oyentes de los módulos y después por `alMensaje` (lo que la consola
 * orquesta: tareas, tarjetas, programaciones). Cada oyente escribe solo en
 * sus señales.
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

/**
 * Abre el `EventSource` de la consola. `alAbrir`/`alCaer` dicen cómo está la
 * conexión; `alMensaje(e)` recibe cada evento después de los oyentes.
 */
export function conectar({ alAbrir, alCaer, alMensaje }, Fuente = globalThis.EventSource) {
  const fuente = new Fuente('/api/eventos');
  fuente.onopen = () => alAbrir?.();
  fuente.onerror = () => alCaer?.();
  fuente.onmessage = (m) => {
    let e;
    try { e = JSON.parse(m.data); } catch { return; }
    despachar(e);
    alMensaje?.(e);
  };
  return fuente;
}

/** Solo para los tests. */
export function olvidarOyentes() { oyentes.clear(); }
