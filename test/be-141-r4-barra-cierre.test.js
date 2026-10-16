/**
 * BE-141 R4 — La barra de progreso es una sola (`BarraProgreso`, comp-base.js) para metas y orquestación, con su
 * accesibilidad y el ancho por CSSOM. El tablero usa `Campo` en sus rótulos de campo. Las familias que no llevan
 * componente (vacíos, botones, fichas…) quedan documentadas en el encabezado de comp-base.js.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const leer = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8').replace(/\r\n/g, '\n');
const comp = leer('comp-base.js');
const css = leer('../app.css');

group('BarraProgreso', () => {
  const barra = comp.slice(comp.indexOf('export function BarraProgreso('), comp.indexOf('\n}\n', comp.indexOf('export function BarraProgreso(')));
  check('exportada, accesible y con el ancho por CSSOM', barra.includes('role="progressbar"') && barra.includes('aria-valuenow=') && barra.includes('style=${{ width:'));
  check('acotada y sin dividir por cero', barra.includes('max > 0 ?') && barra.includes('Math.min(100, Math.max(0,'));
  for (const f of ['tablero-metas.js', 'vista-orquestacion.js']) {
    const s = leer(f);
    check(`${f} la usa y no arma una a mano`, s.includes('<${BarraProgreso} valor=') && !s.includes('role="progressbar"'));
  }
  check('una sola regla, con display block y reduced-motion', /^\.barra-progreso \{ display: block;/m.test(css) && css.includes('@media (prefers-reduced-motion: reduce) { .barra-progreso > span { transition: none; } }'));
  check('sin las reglas viejas', !css.includes('.meta-barra') && !css.includes('.orq-progreso span') && css.includes('.meta-item.cumplida .barra-progreso > span'));
});

group('Campo en el tablero y la regla para lo nuevo', () => {
  const vista = leer('vista-tablero.js');
  check('vista-tablero.js sin rótulos de campo a mano', !vista.includes('<label class="campo">') && vista.includes('<${Campo} texto="Título">'));
  check('el encabezado de comp-base.js dice que lo nuevo sale de acá', comp.includes('Lo nuevo sale de acá: no se escribe otro a mano.'));
});

report();
