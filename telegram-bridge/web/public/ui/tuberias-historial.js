/*
 * FEAT-149 F4a — Deshacer y rehacer en el editor de grafos: una pila de estados de la copia de
 * trabajo, hasta 50, en memoria (por receta). Quitar un nodo o una arista no pide confirmación:
 * se deshace. `version` es una señal para que los botones se habiliten solos.
 */
import { signal } from '../vendor/signals-core.module.js';

export const TOPE_HISTORIAL = 50;
const pilas = new Map();

export function historialDe(clave) {
  if (!pilas.has(clave)) pilas.set(clave, crearHistorial());
  return pilas.get(clave);
}

export function crearHistorial(tope = TOPE_HISTORIAL) {
  const pasado = [];
  const futuro = [];
  const version = signal(0);
  const tocar = () => { version.value++; };
  return {
    version,
    /** Guarda el estado de antes de un cambio; un cambio nuevo borra lo que se podía rehacer. */
    antes(estado) {
      pasado.push(structuredClone(estado));
      if (pasado.length > tope) pasado.shift();
      futuro.length = 0;
      tocar();
    },
    deshacer(actual) {
      if (!pasado.length) return null;
      futuro.push(structuredClone(actual));
      tocar();
      return pasado.pop();
    },
    rehacer(actual) {
      if (!futuro.length) return null;
      pasado.push(structuredClone(actual));
      tocar();
      return futuro.pop();
    },
    puedeDeshacer: () => pasado.length > 0,
    puedeRehacer: () => futuro.length > 0,
    vaciar() { pasado.length = 0; futuro.length = 0; tocar(); }
  };
}

/** Ctrl+Z / Ctrl+Shift+Z (o Ctrl+Y), salvo escribiendo en un campo de texto (ahí deshace el navegador). */
export function teclaHistorial(e, { deshacer, rehacer }) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); deshacer(); return true; }
  if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); rehacer(); return true; }
  return false;
}
