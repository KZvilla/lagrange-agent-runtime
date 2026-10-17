/**
 * BE-146 — Ajustes (revisión de UI posterior a BE-141): «Esta pantalla» solo en General y dentro de su grilla, Roles sin
 * mensaje doble y con «Nueva regla para…», cuentas con su identidad, colores de 256 resueltos, muestras y emblemas a un
 * clic, borde de color en la tarjeta, placeholders tenues y la barra con los botones bien apagados.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const leer = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8').replace(/\r\n/g, '\n');
const vista = leer('vista-ajustes.js');
const gen = leer('ajustes-general.js');
const css = leer('../app.css');

group('BE-146', () => {
  check('«Esta pantalla» va como extra de General, no fija en la página', vista.includes('extra=${html`<${OlvidarPantalla} />`}')
    && !vista.includes('${cuerpo}</div>\n    <${OlvidarPantalla} />') && gen.includes('extra = null }) {') && gen.includes('      ${extra}\n    </div>'));
  check('Roles: la nota solo con reglas y «Nueva regla para… + Agregar»', vista.includes('${filas.length ? html`<p class="nota-chica">Sin regla, todo corre en agy.')
    && vista.includes('<span class="tenue">Nueva regla para</span>') && vista.includes('>+ Agregar</button>'));
  check('cuentas con el punto y el nombre de su identidad', vista.includes('const idn = borrador.value.identidades?.[c.cuenta];') && vista.includes('style=${{ background: colorCss(idn.color) }}'));
  check('colores de 256 resueltos', vista.includes('if (Number.isInteger(color) && color >= 0 && color <= 255) return color256(color);'));
  check('muestras y emblemas a un clic, como botones', vista.includes('class="ajustes-muestra"') && vista.includes("const EMBLEMAS = ['✦', '☘', '◆', '★', '☾'];") && vista.includes('class="ajustes-sugerencia"'));
  check('borde de la tarjeta en su color, por CSSOM', vista.includes(`<div class="ajustes-tarjeta con-identidad" style=\${{ '--idn': color }}>`)
    && css.includes('.ajustes-tarjeta.con-identidad { border-top: 3px solid var(--idn, var(--borde)); }'));
  check('placeholders tenues y el del freno', css.includes('.ajustes input::placeholder { color: var(--tenue); opacity: .55; }') && gen.includes('placeholder="90"'));
  check('barra flotante y botones apagados sin quitarlos', css.includes('.ajustes-barra { box-shadow: 0 -6px 14px var(--sombra); }') && css.includes('.ajustes-barra .boton:disabled { opacity: .35; }'));
  check('ajustes-general.js ≤ 210 líneas', gen.split('\n').length <= 210);
});

report();
