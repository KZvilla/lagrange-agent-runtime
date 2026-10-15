/**
 * FEAT-162 F2 — El confeti, en un solo lugar. Siempre `confetti.create` con un canvas propio y
 * `useWorker: false`: la CSP de la consola (`default-src 'none'`, sin `worker-src`) bloquea el
 * worker por blob que usa la función global. `pruebas/orquestacion.ts` falla si aparece una
 * llamada a `confetti(` en otro archivo o si falta `useWorker: false` acá.
 */
import confetti from 'canvas-confetti';

export type Festejo = (tamano: 'corto' | 'grande') => void;

/** Crea el lanzador sobre un canvas fijo encima de la página; `cerrar` lo saca. */
export function crearFestejo(colores: () => string[]): { festejar: Festejo; cerrar: () => void } {
  const canvas = document.createElement('canvas');
  canvas.className = 'go-confeti';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const lanzar = confetti.create(canvas, { resize: true, useWorker: false });
  return {
    festejar: (tamano) => {
      const c = colores();
      void lanzar(tamano === 'grande'
        ? { particleCount: 160, spread: 100, startVelocity: 45, origin: { y: 0.55 }, colors: c, disableForReducedMotion: true }
        : { particleCount: 45, spread: 55, startVelocity: 32, origin: { x: 0.4, y: 0.35 }, colors: c, disableForReducedMotion: true });
    },
    cerrar: () => { lanzar.reset(); canvas.remove(); }
  };
}
