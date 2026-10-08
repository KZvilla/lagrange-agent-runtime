/*
 * FEAT-138 F2 — Arrastrar tarjetas en el tablero, con Pointer Events propios
 * (sin librería y sin el drag & drop de HTML5, que no anda con el dedo).
 *
 * - Mouse o lápiz: la tarjeta entera, después de moverse 6 px (un clic sigue
 *   abriendo el detalle).
 * - Dedo: solo desde el asa (`.asa-arrastre`, con `touch-action: none`), sin
 *   espera. El navegador decide al tocar si un gesto es scroll y no deja
 *   cambiarlo a mitad de camino: una espera larga sobre la tarjeta peleaba con
 *   el scroll de la columna.
 *
 * Qué se puede soltar dónde lo decide `vista-tablero.js` (`configurarArrastre`):
 * este módulo solo sigue el puntero, marca la columna de abajo y avisa al
 * soltar. Una copia de la tarjeta sigue al puntero (DOM propio, fuera de
 * Preact); las columnas leen la señal `arrastre` y se marcan solas.
 */
import { signal } from '../vendor/signals-core.module.js';

/** `{ id, desde, sobre, antes, despues, motivo }` mientras se arrastra; `null` si no. `motivo === null`: se puede soltar. */
export const arrastre = signal(null);

const UMBRAL_PX = 6;
const BORDE_SCROLL_PX = 48;
const PASO_SCROLL_PX = 14;
// En el carrusel del teléfono (scroll-snap) un paso chico vuelve a su columna: se salta una entera, con pausa.
const PAUSA_SALTO_MS = 700;

const cfg = { columnaDe: () => null, validar: () => '', soltar: () => {} };
/** `columnaDe(t)`, `validar(t, desde, hasta)` (motivo, `''` neutro, `null` válido) y `soltar(t, desde, hasta, antes, despues)`. */
export function configurarArrastre(opciones) { Object.assign(cfg, opciones); }

let sesion = null;

/** `onPointerDown` de una tarjeta arrastrable. */
export function alPresionar(ev, t) {
  if (sesion || ev.button !== 0) return;
  const dedo = ev.pointerType === 'touch';
  if (dedo && !ev.target.closest('.asa-arrastre')) return;
  if (!dedo && ev.target.closest('button, a, input, select, textarea, label, .menu-mover')) return;
  sesion = { t, dedo, card: ev.currentTarget, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, activo: false, cuadro: null, fantasma: null };
  window.addEventListener('pointermove', alMover, true);
  window.addEventListener('pointerup', alSoltar, true);
  window.addEventListener('pointercancel', cancelarArrastre, true);
  window.addEventListener('keydown', alTeclado, true);
  if (dedo) { ev.preventDefault(); empezar(); }
}

function empezar() {
  const r = sesion.card.getBoundingClientRect();
  const f = sesion.card.cloneNode(true);
  // Sin las clases del arrastre: `.tarjeta.arrastrable` le pondría `position: relative` y la copia quedaría fuera de la pantalla.
  f.classList.remove('arrastrable', 'arrastrada', 'seleccionada');
  f.classList.add('fantasma-arrastre');
  f.removeAttribute('data-id');
  f.setAttribute('aria-hidden', 'true');
  f.style.width = `${r.width}px`;
  // Con el mouse, la copia queda donde se agarró. Con el dedo se agarra del asa (arriba a la derecha):
  // la copia iría colgando hacia la izquierda y saldría de la pantalla; va centrada bajo el dedo.
  sesion.offX = sesion.dedo ? r.width / 2 : sesion.x0 - r.left;
  sesion.offY = sesion.dedo ? 24 : sesion.y0 - r.top;
  document.body.append(f);
  sesion.fantasma = f;
  sesion.activo = true;
  document.body.classList.add('arrastrando');
  arrastre.value = { id: sesion.t.id, desde: cfg.columnaDe(sesion.t), sobre: null, antes: null, despues: null, motivo: '' };
  posicionar();
  calcular();
  sesion.cuadro = requestAnimationFrame(bucle);
}

function posicionar() {
  if (sesion?.fantasma) sesion.fantasma.style.transform = `translate(${sesion.x - sesion.offX}px, ${sesion.y - sesion.offY}px) rotate(1.5deg)`;
}

function alMover(ev) {
  if (!sesion || ev.pointerId !== sesion.pointerId) return;
  sesion.x = ev.clientX;
  sesion.y = ev.clientY;
  if (!sesion.activo) {
    if (Math.hypot(sesion.x - sesion.x0, sesion.y - sesion.y0) < UMBRAL_PX) return;
    empezar();
  }
  ev.preventDefault();
  posicionar();
  calcular();
}

/** La columna de abajo y, en Por hacer, entre qué tarjetas caería. Solo escribe la señal si algo cambió. */
function calcular() {
  const col = document.elementFromPoint(sesion.x, sesion.y)?.closest('[data-columna]');
  const a = arrastre.value;
  const hasta = col?.dataset.columna || null;
  let antes = null;
  let despues = null;
  if (hasta === 'hacer') {
    const cards = [...col.querySelectorAll('.columna-lista > .tarjeta[data-id]')].filter((c) => c.dataset.id !== sesion.t.id);
    const i = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return sesion.y < r.top + r.height / 2; });
    despues = i >= 0 ? cards[i].dataset.id : null;
    antes = i > 0 ? cards[i - 1].dataset.id : i === 0 ? null : cards.at(-1)?.dataset.id ?? null;
  }
  const motivo = hasta ? cfg.validar(sesion.t, a.desde, hasta) : '';
  if (a.sobre !== hasta || a.antes !== antes || a.despues !== despues || a.motivo !== motivo) {
    arrastre.value = { ...a, sobre: hasta, antes, despues, motivo };
  }
}

/** Cerca de un borde, la columna (o el carrusel) se desplaza sola. */
function bucle() {
  if (!sesion?.activo) return;
  const debajo = document.elementFromPoint(sesion.x, sesion.y);
  const col = debajo?.closest('.columna');
  if (col) {
    const r = col.getBoundingClientRect();
    if (sesion.y < r.top + BORDE_SCROLL_PX && col.scrollTop > 0) { col.scrollTop -= PASO_SCROLL_PX; }
    else if (sesion.y > r.bottom - BORDE_SCROLL_PX && col.scrollTop + col.clientHeight < col.scrollHeight) { col.scrollTop += PASO_SCROLL_PX; }
  }
  const carril = document.getElementById('columnas');
  if (carril && carril.scrollWidth > carril.clientWidth) {
    const r = carril.getBoundingClientRect();
    const lado = sesion.x < r.left + BORDE_SCROLL_PX ? -1 : sesion.x > r.right - BORDE_SCROLL_PX ? 1 : 0;
    const ahora = performance.now();
    if (lado && getComputedStyle(carril).scrollSnapType.startsWith('x')) {
      if (!sesion.ultimoSalto || ahora - sesion.ultimoSalto > PAUSA_SALTO_MS) {
        sesion.ultimoSalto = ahora;
        // `scrollBy`/`scrollTo` suaves no se mueven con scroll-snap (medido en Chrome); `scrollIntoView` sí, como las pestañas.
        const cols = [...carril.querySelectorAll('[data-columna]')];
        const lejos = (x) => Math.abs(x.getBoundingClientRect().left - r.left);
        const actual = cols.reduce((m, x, i) => (lejos(x) < lejos(cols[m]) ? i : m), 0);
        cols[Math.min(cols.length - 1, Math.max(0, actual + lado))]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    } else if (lado) { carril.scrollLeft += lado * PASO_SCROLL_PX; }
  }
  // Mientras dura un salto suave, lo de abajo cambia sin que el puntero se mueva: se mira en cada cuadro (la señal solo cambia si cambió algo).
  calcular();
  sesion.cuadro = requestAnimationFrame(bucle);
}

function alSoltar(ev) {
  if (!sesion || ev.pointerId !== sesion.pointerId) return;
  const { t, activo } = sesion;
  const a = arrastre.value;
  terminar();
  if (!activo) return;
  // El clic que sigue al soltar no abre el detalle de la tarjeta.
  const comer = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', comer, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', comer, true), 0);
  if (a?.sobre && a.motivo === null) cfg.soltar(t, a.desde, a.sobre, a.antes, a.despues);
}

function alTeclado(ev) {
  if (ev.key !== 'Escape' || !sesion) return;
  ev.preventDefault();
  ev.stopPropagation();
  cancelarArrastre();
}

function terminar() {
  if (!sesion) return;
  window.removeEventListener('pointermove', alMover, true);
  window.removeEventListener('pointerup', alSoltar, true);
  window.removeEventListener('pointercancel', cancelarArrastre, true);
  window.removeEventListener('keydown', alTeclado, true);
  if (sesion.cuadro) cancelAnimationFrame(sesion.cuadro);
  sesion.fantasma?.remove();
  document.body.classList.remove('arrastrando');
  sesion = null;
  arrastre.value = null;
}

/** Corta el arrastre sin soltar (Esc, el navegador lo canceló, o la tarjeta cambió de estado). */
export function cancelarArrastre() { terminar(); }
