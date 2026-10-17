/**
 * BE-141 R2 — El diálogo modal (`Dialogo`) y el menú de acciones (`MenuAcciones`) son componentes compartidos de
 * comp-base.js. Los diálogos de las recetas y de la imagen de lotes los usan; el «⋯» de una meta abre un diálogo en
 * vez de desplegar la edición dentro de la tarjeta; las flechas del menú son una sola función.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const leer = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8').replace(/\r\n/g, '\n');
const comp = leer('comp-base.js');
const css = fs.readFileSync(path.join(UI, '..', 'app.css'), 'utf8').replace(/\r\n/g, '\n');
const corte = (txt, desde) => txt.slice(txt.indexOf(desde), txt.indexOf('\n}\n', txt.indexOf(desde)));

group('comp-base.js', () => {
  const dialogo = corte(comp, 'export function Dialogo(');
  check('exporta Dialogo, MenuAcciones y moverFocoConFlechas', ['export function Dialogo(', 'export function MenuAcciones(', 'export function moverFocoConFlechas('].every((x) => comp.includes(x)));
  check('Dialogo: modal con etiqueta', dialogo.includes('role="dialog" aria-modal="true" aria-label=${etiqueta}'));
  check('Dialogo: foco adentro al abrir y de vuelta al cerrar', dialogo.includes('const previo = document.activeElement;') && dialogo.includes('previo.focus()'));
  check('Dialogo: Esc cierra sin llegar al detalle; el velo cierra', dialogo.includes("if (e.key === 'Escape') { e.stopPropagation(); alCerrar(); }") && dialogo.includes('if (e.target === e.currentTarget) alCerrar();'));
  const menu = corte(comp, 'export function MenuAcciones(');
  check('MenuAcciones: flechas y foco al primer ítem', menu.includes('moverFocoConFlechas(e, e.currentTarget)') && menu.includes('[role="menuitem"]:not([disabled])'));
});

group('quién los usa', () => {
  for (const f of ['tuberias-receta-acciones.js', 'harness-acciones.js', 'tablero-metas.js']) {
    const s = leer(f);
    check(`${f} usa <\${Dialogo}> y no arma su velo`, s.includes('<${Dialogo}') && !s.includes('tub-dialogo') && !s.includes('role="dialog"'));
  }
  check('tablero-tarjeta.js ya no define el menú', !leer('tablero-tarjeta.js').includes('export function MenuAcciones('));
  check('tuberias-menu.js usa las flechas comunes', leer('tuberias-menu.js').includes('moverFocoConFlechas(e, caja.current') && !leer('tuberias-menu.js').includes("'ArrowDown'"));
  const metas = leer('tablero-metas.js');
  check('el «⋯» es un botón que abre el diálogo', metas.includes('class="tarjeta-mas meta-editar" aria-haspopup="dialog"') && !metas.includes("' editando'"));
  check('tablero-metas.js y tablero-tarjeta.js ≤ 210 líneas', metas.split('\n').length <= 210 && leer('tablero-tarjeta.js').split('\n').length <= 210);
});

group('CSS', () => {
  check('el diálogo con clases propias (sin tub-dialogo)', /^\.dialogo-fondo \{/m.test(css) && /^\.dialogo \{/m.test(css) && /^\.dialogo-pie \{/m.test(css) && !css.includes('tub-dialogo'));
  check('la meta ya no se ensancha al editar', !css.includes('.meta-item.editando') && !css.includes('.meta-item .meta-form'));
});

report();
