/*
 * FEAT-136 — `html` (htm sobre el `h` de Preact) y lo básico para montar.
 *
 * Regla: las interpolaciones de htm son texto o props, nunca HTML. Está
 * prohibido `dangerouslySetInnerHTML` en `ui/` (lo fija un test).
 */
import { h, render, Fragment } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
// Instala la integración: un componente que lee `señal.value` se redibuja solo cuando cambia.
import '../vendor/signals.module.js';

export const html = htm.bind(h);
export { h, render, Fragment };
