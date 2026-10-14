/*
 * FEAT-160 F2 — El detalle del tablero como franja inferior a todo el ancho.
 *
 * `FranjaDetalle` es solo el contenedor: el `<aside id="detalle">`, el asa que
 * cambia su altura y la altura misma (persistida). Lo que va adentro lo arma
 * `Detalle` en vista-tablero.js (tarea, fan-out o lote confinado), sin cambios.
 * En el teléfono (≤800 px) la franja es una hoja inferior de alto fijo: el asa
 * se oculta y queda un tirador decorativo.
 *
 * `ajustarAlto` y `altoDesdePuntero` son puras: las prueba
 * test/feat-160-f2-detalle.test.js sin navegador.
 */
import { html } from './html.js';
import { persistente } from './persistencia.js';

export const ALTO_MIN = 20;
export const ALTO_MAX = 85;
export const ALTO_INICIAL = 45;
const PASO = 5;

const acotar = (n) => Math.min(ALTO_MAX, Math.max(ALTO_MIN, Math.round(n)));
export const altoValido = (v) => Number.isFinite(v) && v >= ALTO_MIN && v <= ALTO_MAX;

/** La altura (en % del cuerpo del tablero) después de una tecla, o `null` si la tecla no es del asa. */
export function ajustarAlto(actual, tecla) {
  const base = altoValido(actual) ? actual : ALTO_INICIAL;
  if (tecla === 'ArrowUp') return acotar(base + PASO);
  if (tecla === 'ArrowDown') return acotar(base - PASO);
  if (tecla === 'Home') return ALTO_MIN;
  if (tecla === 'End') return ALTO_MAX;
  return null;
}

/** La altura que deja el puntero en `y` dentro de la caja del cuerpo (`{ top, bottom }`): la franja va del puntero al piso. */
export function altoDesdePuntero(y, caja) {
  const total = caja.bottom - caja.top;
  if (!(total > 0) || !Number.isFinite(y)) return ALTO_INICIAL;
  return acotar(((caja.bottom - y) / total) * 100);
}

/** La altura elegida, por dispositivo. Un valor guardado fuera de rango o ilegible vuelve a 45. */
export const altoDetalle = persistente('tablero.alto-detalle', ALTO_INICIAL, { validar: altoValido });

function alPresionarAsa(ev) {
  if (ev.button !== undefined && ev.button !== 0) return;
  const cuerpo = ev.currentTarget.closest('.tablero-cuerpo');
  if (!cuerpo) return;
  ev.preventDefault();
  const asa = ev.currentTarget;
  const franja = asa.closest('.detalle');
  franja?.classList.add('ajustando');
  asa.setPointerCapture?.(ev.pointerId);
  const mover = (e) => { altoDetalle.value = altoDesdePuntero(e.clientY, cuerpo.getBoundingClientRect()); };
  const soltar = () => {
    franja?.classList.remove('ajustando');
    asa.removeEventListener('pointermove', mover);
    asa.removeEventListener('pointerup', soltar);
    asa.removeEventListener('pointercancel', soltar);
  };
  asa.addEventListener('pointermove', mover);
  asa.addEventListener('pointerup', soltar);
  asa.addEventListener('pointercancel', soltar);
}

function alTeclaAsa(ev) {
  const nuevo = ajustarAlto(altoDetalle.value, ev.key);
  if (nuevo === null) return;
  ev.preventDefault();
  altoDetalle.value = nuevo;
}

/** El contenedor del detalle: oculto sin tarjeta abierta (`[hidden]` gana con `!important`, app.css L76). */
export function FranjaDetalle({ abierta, children }) {
  const alto = altoValido(altoDetalle.value) ? altoDetalle.value : ALTO_INICIAL;
  return html`<aside class="detalle" id="detalle" aria-label="Detalle de la tarjeta" hidden=${!abierta} style=${`--alto-detalle: ${alto}%`}>
    <button type="button" class="detalle-asa" role="separator" aria-orientation="horizontal" aria-controls="detalle"
      aria-valuemin=${ALTO_MIN} aria-valuemax=${ALTO_MAX} aria-valuenow=${alto} aria-label="Alto del detalle (flechas arriba y abajo)"
      onPointerDown=${alPresionarAsa} onKeyDown=${alTeclaAsa}><span aria-hidden="true"></span></button>
    <span class="detalle-tirador" aria-hidden="true"></span>
    ${children}
  </aside>`;
}
