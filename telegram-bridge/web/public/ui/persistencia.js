/*
 * FEAT-136 — El estado de la interfaz que sobrevive a recargar, por pestaña y
 * por dispositivo (`localStorage`). Decisión del usuario, 2026-10-07.
 *
 * `persistente(clave, inicial, { validar })` es una señal que se guarda sola
 * (con un debounce) bajo `lagrange.ui.v1.<clave>` y se lee al crearla. Un
 * valor guardado que no pasa `validar`, que no se puede parsear o que pesa
 * más de `TOPE_BYTES` se ignora: rige el inicial. Sin `localStorage` (privado,
 * bloqueado, lleno) todo funciona igual, sin recordar.
 *
 * Nunca se guarda un token ni una respuesta: solo lo que el usuario dejó en la
 * pantalla (vista, borradores, scroll, secciones, filtros, tema).
 */
import { signal, effect } from '../vendor/signals-core.module.js';

export const PREFIJO = 'lagrange.ui.v1.';
export const TOPE_BYTES = 64 * 1024;
export const ESPERA_MS = 300;

function almacenPorDefecto() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** Lee y valida; `undefined` si no hay nada usable. */
export function leer(clave, { almacen = almacenPorDefecto(), validar = () => true } = {}) {
  try {
    const crudo = almacen && almacen.getItem(PREFIJO + clave);
    if (crudo == null || crudo.length > TOPE_BYTES) return undefined;
    const valor = JSON.parse(crudo);
    return validar(valor) ? valor : undefined;
  } catch {
    return undefined;
  }
}

export function escribir(clave, valor, { almacen = almacenPorDefecto() } = {}) {
  try {
    const texto = JSON.stringify(valor);
    if (texto === undefined || texto.length > TOPE_BYTES) return false;
    almacen.setItem(PREFIJO + clave, texto);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} clave  `[a-z0-9.:_-]+`
 * @param {*} inicial
 * @param {{ validar?: (v: unknown) => boolean, almacen?: Storage|null, esperaMs?: number, temporizador?: { set: Function, clear: Function } }} opciones
 */
export function persistente(clave, inicial, { validar = () => true, almacen = almacenPorDefecto(), esperaMs = ESPERA_MS, temporizador = { set: setTimeout, clear: clearTimeout } } = {}) {
  if (!/^[a-z0-9.:_-]{1,80}$/.test(clave)) throw new Error(`clave de persistencia inválida: ${clave}`);
  const guardado = leer(clave, { almacen, validar });
  const s = signal(guardado === undefined ? inicial : guardado);
  let pendiente = null;
  let primera = true;
  effect(() => {
    const valor = s.value;
    if (primera) { primera = false; return; }
    if (pendiente) temporizador.clear(pendiente);
    pendiente = temporizador.set(() => { pendiente = null; escribir(clave, valor, { almacen }); }, esperaMs);
  });
  return s;
}

/** «Olvidar el estado de esta pantalla»: borra todo `lagrange.ui.*` (de cualquier versión). */
export function olvidarTodo({ almacen = almacenPorDefecto() } = {}) {
  let n = 0;
  try {
    const claves = [];
    for (let i = 0; i < almacen.length; i++) {
      const k = almacen.key(i);
      if (k && k.startsWith('lagrange.ui.')) claves.push(k);
    }
    for (const k of claves) { almacen.removeItem(k); n++; }
  } catch {}
  return n;
}
