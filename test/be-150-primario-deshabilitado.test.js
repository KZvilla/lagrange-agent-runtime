/**
 * BE-150 — Deshabilitado, el botón primario se ve como cualquier botón deshabilitado (gris de la base, al 50 %): el
 * azul del acento a media opacidad se leía como activo («Guardar versión N» sin cambios, la barra de Ajustes…).
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const css = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'app.css'), 'utf8').replace(/\r\n/g, '\n');
const REGLA = '.boton.primario:disabled { background: var(--realce); color: var(--texto); border-color: var(--borde-fuerte); }';

group('BE-150', () => {
  check('el primario deshabilitado toma el gris de la base', css.includes(REGLA));
  check('va después de .boton.primario (le gana en la cascada)', css.indexOf(REGLA) > css.indexOf('.boton.primario { background: var(--acento);'));
  check('sigue heredando la opacidad y el cursor de .boton:disabled', css.includes('.boton:disabled { opacity: .5; cursor: default; }'));
  const posteriores = [...css.matchAll(/^[^/\n{]*\.boton\.primario[^{\n]*\{[^}]*background/gm)].map((m) => m[0].split('{')[0].trim())
    .filter((s) => s !== '.boton.primario' && s !== '.boton.primario:disabled' && s !== '.boton.primario.armado');
  check(`ninguna otra regla pinta el fondo de un primario${posteriores.length ? ` (${posteriores.join(', ')})` : ''}`, !posteriores.length);
});

report();
