/**
 * BE-148 — El texto sobre `--peligro` (botón de dos pasos armado, opción peligrosa elegida de un Segmentado) va en
 * `--fondo`: en el tema oscuro `--peligro` es un rosa claro y el blanco no se leía. El aviso flotante sube un poco.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const css = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'app.css'), 'utf8').replace(/\r\n/g, '\n');
const regla = (sel) => { const i = css.indexOf(`\n${sel} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1); };

group('Texto sobre --peligro', () => {
  check('el botón armado', regla('.boton.armado').includes('color: var(--fondo); background: var(--peligro);'));
  check('la opción peligrosa elegida', regla('.segmentado button.activo.peligro').includes('color: var(--fondo);'));
  check('sin blanco fijo sobre --peligro', !/background: var\(--peligro\);[^}]*color: #fff|color: #fff;[^}]*background: var\(--peligro\)/.test(css));
});

group('Aviso flotante', () => {
  check('sobre la esquina, no en ella', regla('.aviso-flotante').includes('bottom: calc(64px + env(safe-area-inset-bottom, 0px));'));
});

report();
