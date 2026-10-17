/**
 * BE-147 — Charla y tema claro (revisión de UI posterior a BE-141): `--tenue` con contraste AA en los dos temas, la
 * barra de memoria en acento (ámbar y rojo solo cerca del tope), la firma de color del alma en sus respuestas, una
 * sombra mínima, la duración con su reloj y el pie de los mensajes propios solo al pasar el mouse.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const PUB = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const leer = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8').replace(/\r\n/g, '\n');
const css = leer('app.css');
const charla = leer('ui/vista-charla.js');
const panel = leer('ui/panel.js');

/** Los tokens de un bloque: desde `inicio` hasta la primera `}` que lo cierra. */
function tokens(inicio) {
  const i = css.indexOf(inicio);
  if (i < 0) return {};
  const cuerpo = css.slice(i + inicio.length, css.indexOf('}', i + inicio.length));
  const t = {};
  for (const m of cuerpo.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) t[m[1]] = m[2];
  return t;
}
const luminancia = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contraste = (a, b) => {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const oscuro = tokens(':root {');
const claroMedia = tokens(':root:not([data-tema="oscuro"]) {');
const claro = tokens(':root[data-tema="claro"] {');

group('BE-147 — contraste de --tenue', () => {
  check('los dos bloques claros declaran el mismo --tenue', claroMedia.tenue && claroMedia.tenue === claro.tenue);
  for (const [nombre, t] of [['oscuro', oscuro], ['claro (media)', claroMedia], ['claro (data-tema)', claro]]) {
    // Donde se dibuja texto tenue: la página, los paneles y los campos (no las burbujas propias, `--mia`).
    const fondos = ['fondo', 'superficie', 'realce', 'panel'];
    const bajos = fondos.filter((f) => !(t.tenue && t[f] && contraste(t.tenue, t[f]) >= 4.5));
    check(`${nombre}: --tenue ≥ 4,5:1 sobre ${fondos.join(', ')}${bajos.length ? ` (falla: ${bajos.join(', ')})` : ''}`, !bajos.length);
  }
});

group('BE-147 — charla y panel', () => {
  check('[87] duración con reloj y title', charla.includes('<span class="pie-duracion" title=${`respondió en ${d}`}><${Icono} d=${ICONO_RELOJ} tam=${11} />${d}</span>')
    && charla.includes('<${Duracion} ms=${Date.parse(t.terminada) - Date.parse(t.iniciada)} />'));
  check('[88] barra de memoria en acento, ámbar y rojo cerca del tope', css.includes('.uso > div { height: 3px; background: var(--acento); }')
    && css.includes('.uso.cerca > div { background: var(--t2); }') && css.includes('.uso.lleno > div { background: var(--error); }')
    && panel.includes("const nivelUso = (uso) => (uso >= 0.9 ? ' lleno' : uso >= 0.75 ? ' cerca' : '');")
    && panel.includes('class=${`uso${nivelUso(uso)}`}'));
  check('[90] pie propio solo al pasar el mouse, donde hay mouse', css.includes('@media (hover: hover) {\n  .fila-mia > .pie { opacity: 0;')
    && css.includes('.fila-mia:hover > .pie, .fila-mia:focus-within > .pie { opacity: 1; }'));
  check('[91] la respuesta del alma firma con su color, salvo un error', charla.includes("fila-suya ${esAlma ? `alma ${tono(s.clave)}` : ''}")
    && css.includes('.fila-suya.alma .burbuja.suya:not(.error):not(.parcial) { border-left: 3px solid var(--tono); }'));
  check('[93] sombra mínima en la burbuja del alma', css.includes('.burbuja.suya { box-shadow: 0 1px 2px var(--sombra); }'));
});

report();
