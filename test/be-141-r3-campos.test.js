/**
 * BE-141 R3 — Los campos de texto tienen una regla base sin especificidad (`:where`): uno sin contexto (los de las
 * metas) ya no queda con el estilo nativo, y las reglas de contexto ganan en lo que declaran. `Campo` y `CampoTub`
 * viven en comp-base.js: Tuberías tenía la misma línea copiada en cuatro módulos.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const leer = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8').replace(/\r\n/g, '\n');
const css = leer('../app.css');
const comp = leer('comp-base.js');
const regla = (sel) => (css.split('\n').find((l) => l.startsWith(`${sel} {`)) || '');

group('regla base de los campos', () => {
  const base = css.split('\n').find((l) => l.startsWith(':where(') && l.includes('input[type="text"]') && l.includes('textarea') && !l.includes(':disabled')) || '';
  check(':where con los tipos de texto y textarea', base.includes('input[type="date"]') && !base.includes('checkbox') && !base.includes('radio'), base.slice(0, 120));
  check('con tokens y la fuente de la página', ['background: var(--realce)', 'color: var(--texto)', 'border: 1px solid var(--borde-fuerte)', 'font-family: inherit'].every((x) => base.includes(x)));
  // BE-143 — El formulario de tarjeta nueva pasó a la caja de la base: ya no anula padding, borde ni radio.
  check('lo que se apoyaba en el padding nativo lo declara', ['.buscador input', '.caja-texto textarea'].every((s) => regla(s).includes('padding: 0;')));
  check('los de borde inferior no se curvan', regla('.paleta input').includes('border-radius: 0;'));
  check('los contextos no repiten la base', !regla('.profunda-fila input').includes('var(--realce)') && !regla('.form-recuerdo textarea').includes('var(--realce)')
    && !regla('.nota-nueva textarea, .orq-escribir textarea, .edicion textarea, .edicion input[type="text"]').includes('var(--realce)'));
  check('una sola regla .tub-campo', (css.match(/^\.tub-campo \{/gm) || []).length === 1);
});

group('Campo y CampoTub', () => {
  check('comp-base.js los exporta', comp.includes('export function Campo(') && comp.includes('export function CampoTub('));
  for (const f of ['tuberias-borrador-inspector.js', 'tuberias-editor-inspector.js', 'tuberias-grafo-inspector.js', 'tuberias-grafo-ramas.js']) {
    const s = leer(f);
    check(`${f} usa el compartido`, !s.includes('const Campo =') && s.includes("CampoTub as Campo } from './comp-base.js';"));
  }
  const metas = leer('tablero-metas.js');
  check('las metas usan Campo y no la clase muerta «entrada»', metas.includes('<${Campo} texto="Nombre">') && !metas.includes('class="entrada"'));
});

report();
