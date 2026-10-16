/**
 * BE-141 R1 — Los <select> tienen una regla base por elemento: uno fuera de los contextos de siempre (el de «Meta»
 * del detalle, los de «+ Meta», los de las recetas) ya no queda con el estilo nativo, gris y fuera de tema. Los
 * contextos solo redefinen lo que difiere.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const css = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'app.css'), 'utf8').replace(/\r\n/g, '\n');
const reglas = css.split('\n').filter((l) => /^[^/*@][^{]*\{/.test(l));
const soloSelect = reglas.filter((l) => {
  const sel = l.slice(0, l.indexOf('{'));
  return sel.split(',').every((s) => /\bselect\b/.test(s)) && !/^select\b/.test(sel);
});

group('regla base de los selectores', () => {
  check('select { … } con tokens', /^select \{[^}]*background: var\(--realce\);[^}]*color: var\(--texto\);[^}]*border: 1px solid var\(--borde-fuerte\);/m.test(css));
  check('deshabilitado atenuado', /^select:disabled \{ opacity: \.55;/m.test(css));
  check('los contextos de solo-select no repiten fondo ni borde base',
    soloSelect.length >= 5 && soloSelect.every((l) => !l.includes('background: var(--realce)') && !l.includes('border: 1px solid var(--borde-fuerte)')),
    soloSelect.filter((l) => l.includes('var(--realce)') || l.includes('var(--borde-fuerte)')).join(' | '));
  check('el compositor sigue en su color', /^\.compositor-fila select \{ color: inherit;/m.test(css));
  check('los de las recetas con el fondo de Tuberías', /^\.tub-campo-receta select \{[^}]*background: var\(--fondo\)/m.test(css));
});

report();
