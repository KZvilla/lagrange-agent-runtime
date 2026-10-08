/* FEAT-136 — Fechas cortas compartidas (sacado de app.js sin cambios). */
import { hora } from './nucleo.js';

export function fechaCorta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const hoy = new Date();
  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);
  const hh = hora(iso);
  if (d.toDateString() === hoy.toDateString()) return hh;
  if (d.toDateString() === ayer.toDateString()) return `ayer ${hh}`;
  return `${d.toLocaleDateString('es', { day: 'numeric', month: 'short' })} ${hh}`;
}
