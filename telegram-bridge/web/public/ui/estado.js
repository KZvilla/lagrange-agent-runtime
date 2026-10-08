/*
 * FEAT-136 — El estado del mundo nuevo: señales por dominio, no un objeto
 * gigante. Cada vista que se migra suma acá las suyas (F1 en adelante);
 * en F0 solo está la conexión, que alimenta el SSE reenviado por `app.js`.
 */
import { signal } from '../vendor/signals-core.module.js';
import { alEvento } from './sse.js';

/** El nodo que mira la consola (`local` o el nombre de un nodo de la red). */
export const nodo = signal('local');
/** Cuántos eventos llegaron por el puente: sirve para ver que el reenvío anda. */
export const eventos = signal(0);

alEvento('*', () => { eventos.value += 1; });
