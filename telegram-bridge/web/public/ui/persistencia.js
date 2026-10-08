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
// Envueltos: en el navegador `setTimeout` llamado como método de otro objeto lanza «Illegal invocation».
const TEMPORIZADOR = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

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
export function persistente(clave, inicial, { validar = () => true, almacen = almacenPorDefecto(), esperaMs = ESPERA_MS, temporizador = TEMPORIZADOR } = {}) {
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

export function borrar(clave, { almacen = almacenPorDefecto() } = {}) {
  try { almacen.removeItem(PREFIJO + clave); return true; } catch { return false; }
}

/** Una clave válida a partir de un id cualquiera (`alma:Alya` → `alma:alya`). */
export function claveSegura(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9.:_-]/g, '_').slice(0, 60);
}

/**
 * Una señal persistente por id (un borrador por hilo, el scroll por hilo),
 * creada a demanda. Recuerda a lo sumo `tope` ids: al pasarse, olvida los
 * que se usaron hace más tiempo (índice LRU guardado bajo `<prefijo>.indice`).
 */
export function porClave(prefijo, inicial, { validar = () => true, tope = 50, almacen = almacenPorDefecto(), esperaMs = ESPERA_MS, temporizador } = {}) {
  const senales = new Map();
  const claveIndice = `${prefijo}.indice`;
  const leerIndice = () => leer(claveIndice, { almacen, validar: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string') }) || [];
  function usar(id) {
    const indice = [id, ...leerIndice().filter((x) => x !== id)];
    for (const viejo of indice.slice(tope)) borrar(`${prefijo}.${viejo}`, { almacen });
    escribir(claveIndice, indice.slice(0, tope), { almacen });
  }
  return {
    de(idCrudo) {
      const id = claveSegura(idCrudo);
      if (!senales.has(id)) {
        senales.set(id, persistente(`${prefijo}.${id}`, inicial, { validar, almacen, esperaMs, ...(temporizador ? { temporizador } : {}) }));
        usar(id);
      }
      return senales.get(id);
    }
  };
}
