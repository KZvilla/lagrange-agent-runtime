/**
 * BE-139 — Lo que destapó la prueba en vivo de FEAT-128 (v1.38.0): la franja no recontaba al cambiar una tarjeta
 * (la lista se muta en el lugar y avisa con `versionTablero`), el selector del detalle quedaba con la meta vieja,
 * el «+ Meta» pegado al borde, el chip del proyecto se salía de la tarjeta, el fondo de la barra no se veía en 0 %,
 * la pastilla repetía «cerrada», la edición quedaba apretada y la franja no decía que estaba cargando.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const leer = (rel) => fs.readFileSync(path.join(PUBLICO, rel), 'utf8').replace(/\r\n/g, '\n');
const vista = leer('ui/vista-tablero.js');
const metas = leer('ui/tablero-metas.js');
const css = leer('app.css');

group('la franja reconta y el detalle se recarga', () => {
  check('MetasDelTablero lee versionTablero', /function MetasDelTablero\(\) \{\n  void versionTablero\.value;/.test(vista));
  // BE-140 — Con el mismo array, @preact/signals no re-renderiza la franja.
  check('le pasa una copia de la lista', vista.includes('<${FranjaMetas} tareas=${[...tareasDelTablero()]} />'));
  check('la página monta MetasDelTablero', vista.includes('<${MetasDelTablero} />') && !vista.includes('    <${FranjaMetas} tareas='));
  check('el selector recarga el detalle', vista.includes('alCambiar=${cargarDetalle}') && /alCambiar\?\.\(\);/.test(metas));
  check('un cambio de meta por SSE recarga el detalle abierto', vista.includes('|| (d.tarea.metaId ?? null) !== (t.metaId ?? null);'));
  check('mientras carga, dice que carga', /<span class="tenue">cargando…<\/span>/.test(metas));
});

group('la franja se ve bien', () => {
  check('el + Meta con aire arriba y a la derecha', /\.franja-metas \{ padding: 12px 24px 12px 20px;/.test(css));
  check('el chip del proyecto se recorta, con title', /\.meta-proyecto \{[^}]*text-overflow: ellipsis/.test(css) && /class="chip chico meta-proyecto" title=/.test(metas));
  check('el fondo de la barra se ve en 0 %', /\.meta-barra \{[^}]*background: var\(--borde-suave\)/.test(css));
  check('sin pastilla para cerrada o cumplida', /const estado = cumplida \? null :/.test(metas));
  // BE-141 — El «⋯» ya no despliega la edición en la tarjeta: abre un diálogo.
  check('el «⋯» abre un diálogo (el ítem no se ensancha)', !css.includes('.meta-item.editando') && metas.includes('<${Dialogo} etiqueta=${`Meta ${m.nombre}`}'));
  check('sin :has(', !css.includes(':has('));
});

report();
