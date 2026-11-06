'use strict';

/**
 * BE-179 — Tope de concurrencia en proceso para `agy_run`.
 *
 * El problema real es la cuota: dos `agy_run` solapados pueden pasar el
 * preflight a la vez y agotar el mismo grupo. `agy_fanout` ya tiene su propio
 * tope por lote; este módulo no lo toca en la primera entrega. El knob es
 * `AGY_RUN_MAX_CONCURRENT` (entero 1..8, default 2), leído una sola vez.
 *
 * El semáforo es FIFO y libera el slot en `finally`, también cuando la función
 * rechaza. Un `AbortSignal` cancelado mientras espera sale de la cola sin
 * lanzar el trabajo.
 */

const MAX_DEFECTO = 2;
const MAX_PERMITIDO = 8;

function maxDeEntorno(env = process.env) {
  const crudo = env && env.AGY_RUN_MAX_CONCURRENT;
  if (crudo === undefined || crudo === null || String(crudo).trim() === '') {
    return { max: MAX_DEFECTO, aviso: null };
  }
  const n = Number(crudo);
  if (Number.isInteger(n) && n >= 1 && n <= MAX_PERMITIDO) {
    return { max: n, aviso: null };
  }
  return {
    max: MAX_DEFECTO,
    aviso: `AGY_RUN_MAX_CONCURRENT=${JSON.stringify(crudo)} se ignora: tiene que ser un entero de 1 a ${MAX_PERMITIDO}; se usa ${MAX_DEFECTO}`
  };
}

function errorAbort() {
  const err = new Error('Cancelled while waiting for an agy slot');
  err.name = 'AbortError';
  return err;
}

function crearLimite({ max = MAX_DEFECTO } = {}) {
  const tope = Number.isInteger(max) && max >= 1 ? max : MAX_DEFECTO;
  let activos = 0;
  const cola = [];

  const estado = () => ({ max: tope, activos, esperando: cola.length });

  function siguiente() {
    while (activos < tope && cola.length) {
      const item = cola.shift();
      if (item.signal && item.signal.aborted) {
        item.reject(errorAbort());
        continue;
      }
      if (item.onAbort && item.signal) item.signal.removeEventListener('abort', item.onAbort);
      activos += 1;
      if (item.alEmpezar) item.alEmpezar(Math.max(0, Date.now() - item.encoladoEn));
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => {
          activos -= 1;
          siguiente();
        });
    }
  }

  function ejecutar(fn, { signal, alEmpezar } = {}) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('limite.ejecutar requiere una función'));
    if (signal && signal.aborted) return Promise.reject(errorAbort());

    if (activos < tope) {
      activos += 1;
      if (alEmpezar) alEmpezar(0);
      return Promise.resolve()
        .then(fn)
        .finally(() => {
          activos -= 1;
          siguiente();
        });
    }

    return new Promise((resolve, reject) => {
      const item = { fn, resolve, reject, signal, alEmpezar, onAbort: null, encoladoEn: Date.now() };
      if (signal) {
        item.onAbort = () => {
          const i = cola.indexOf(item);
          if (i >= 0) cola.splice(i, 1);
          reject(errorAbort());
        };
        signal.addEventListener('abort', item.onAbort, { once: true });
      }
      cola.push(item);
    });
  }

  return { ejecutar, estado };
}

module.exports = { crearLimite, maxDeEntorno, MAX_DEFECTO, MAX_PERMITIDO };
