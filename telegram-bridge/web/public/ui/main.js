/*
 * FEAT-136 F0 — El puente entre `app.js` (IIFE clásico) y los componentes.
 *
 * `window.lagrangeUI`:
 *   - `montar(nombre, nodo, props)`: monta el componente registrado con ese
 *     nombre; `false` si no hay ninguno (entonces `app.js` pinta como siempre).
 *   - `desmontar(nodo)`.
 *   - `evento(e)`: `app.js` reenvía cada evento del SSE ya parseado.
 *
 * Al quedar listo emite `lagrange-ui-lista` en `window`, por si `app.js` ya
 * pintó una vista que ahora tiene componente (los scripts diferidos corren
 * antes que este módulo). En F0 no hay componentes registrados.
 */
import { h, render } from './html.js';
import { despachar } from './sse.js';
import './estado.js';

const componentes = new Map();

/** Registra un componente montable por nombre (lo usan las vistas de F1 en adelante). */
export function registrar(nombre, componente) {
  componentes.set(nombre, componente);
}

const api = Object.freeze({
  version: 1,
  montar(nombre, nodo, props = {}) {
    const C = componentes.get(nombre);
    if (!C || !nodo) return false;
    render(h(C, props), nodo);
    return true;
  },
  desmontar(nodo) {
    if (nodo) render(null, nodo);
  },
  evento(e) {
    return despachar(e);
  },
  tiene(nombre) {
    return componentes.has(nombre);
  }
});

Object.defineProperty(window, 'lagrangeUI', { value: api, configurable: false, writable: false });
window.dispatchEvent(new Event('lagrange-ui-lista'));
