/*
 * FEAT-136 — El estado del mundo nuevo: señales por dominio, no un objeto
 * gigante. Acá vive lo de la consola entera; cada vista tiene las suyas en su
 * módulo. `app.js` las usa a través de accesores en `estado`.
 */
import { signal } from '../vendor/signals-core.module.js';
import { alEvento } from './sse.js';

/** FEAT-136 F2 — La vista actual (`{ vista, tipo?, id? }`) y los sujetos (almas y agentes) con su estado. */
export const ruta = signal({ vista: 'inicio' });
export const sujetos = signal({ almas: [], agentes: [] });
export const daemon = signal(null);
/** Cuántos eventos llegaron por el puente: sirve para ver que el reenvío anda. */
export const eventos = signal(0);

alEvento('*', () => { eventos.value += 1; });
