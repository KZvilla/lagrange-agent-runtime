/*
 * FEAT-136 — Mapas reactivos: un `Map` de toda la vida para el código viejo
 * (`get`, `set`, `has`, `delete`), que además avisa a los componentes.
 *
 * Un componente que lee `mapa.version.value` se redibuja cuando cambia
 * cualquier entrada. `tocar()` avisa sin reemplazar nada (para listas que el
 * código viejo muta en su lugar).
 */
import { signal } from '../vendor/signals-core.module.js';

export class MapaReactivo extends Map {
  constructor(entradas) {
    super(entradas);
    this.version = signal(0);
  }
  set(k, v) { super.set(k, v); if (this.version) this.version.value++; return this; }
  delete(k) { const r = super.delete(k); if (r) this.version.value++; return r; }
  clear() { super.clear(); this.version.value++; }
  tocar() { this.version.value++; }
}

/**
 * Una señal por clave, creada a demanda (por ejemplo, el texto en vivo de
 * cada tarea): actualizar una no redibuja a los que miran otra.
 */
export function senalesPorClave(inicial) {
  const mapa = new Map();
  return {
    de(clave) {
      if (!mapa.has(clave)) mapa.set(clave, signal(inicial));
      return mapa.get(clave);
    },
    borrar(clave) { const s = mapa.get(clave); if (s) s.value = inicial; mapa.delete(clave); },
    tiene(clave) { return mapa.has(clave); }
  };
}
