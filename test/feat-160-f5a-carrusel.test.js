/**
 * FEAT-160 F5a — El carrusel del teléfono: un solo umbral (ui/telefono.js),
 * dos columnas acostado, re-centrar al girar, el asa de 44×44 y las zonas de
 * soltado encima de las pestañas. telefono.js se ejecuta; el resto se lee como
 * texto (los componentes no se importan en node).
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const leer = (rel) => fs.readFileSync(path.join(PUBLICO, rel), 'utf8').replace(/\r\n/g, '\n');
const css = leer('app.css');
const app = leer('app.js');
const vista = leer('ui/vista-tablero.js');
const arr = leer('ui/tablero-arrastre.js');
const telTxt = leer('ui/telefono.js');
const ui = fs.readdirSync(path.join(PUBLICO, 'ui')).filter((f) => f.endsWith('.js')).map((f) => [f, leer(`ui/${f}`)]);
const corte = (txt, desde, hasta) => txt.slice(txt.indexOf(desde), txt.indexOf(hasta, txt.indexOf(desde)));
const CARRUSEL = '@media (max-width: 800px), (max-height: 500px) and (orientation: landscape) {';

(async () => {
  const T = await import(pathToFileURL(path.join(PUBLICO, 'ui', 'telefono.js')).href);

  await group('Un solo umbral', () => {
    check('telefono.js: 800 px y el carrusel también acostado', T.ANCHO_TELEFONO === 800 && T.MQ_TELEFONO === '(max-width: 800px)'
      && T.MQ_CARRUSEL === '(max-width: 800px), (max-height: 500px) and (orientation: landscape)');
    check('telefono.js es hoja', !/^import /m.test(telTxt));
    const viejo = /max-width: 760px|min-width: 761px|mq760/;
    check('ni 760 ni 761 en app.css', !viejo.test(css));
    check('ni en app.js', !viejo.test(app));
    const conViejo = ui.filter(([, t]) => viejo.test(t)).map(([f]) => f);
    check('ni en ui/*.js', conViejo.length === 0, conViejo.join(' '));
    check('la pareja de escritorio empieza en 801', css.includes('@media (min-width: 801px) and (max-width: 950px) {'));
    const anchos = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    check('ningún corte de teléfono distinto del de telefono.js (entre 700 y 850 px)', anchos.filter((n) => n >= 700 && n <= 850).every((n) => n === T.ANCHO_TELEFONO), anchos.join(' '));
    check('app.js usa la constante en sus cinco lugares', app.includes("import { MQ_TELEFONO } from './ui/telefono.js';") && app.includes('const mqTelefono = matchMedia(MQ_TELEFONO);')
      && (app.match(/mqTelefono/g) || []).length === 5);
    check('vista-tablero.js no tiene literal propio', vista.includes("import { MQ_CARRUSEL, MQ_APAISADO } from './telefono.js';") && !vista.includes('ANCHO_CARRUSEL') && !/matchMedia\('\(max-width/.test(vista));
  });

  await group('El carrusel, también acostado', () => {
    check('el bloque entero (carrusel, pestañas, filtros, hoja del detalle) con el apaisado', css.includes(CARRUSEL)
      && /\.detalle \{ position: fixed; left: 0; right: 0; bottom: 0; height: 85vh;/.test(css.slice(css.indexOf(CARRUSEL))));
    check('acostado, dos columnas y la mirada a la izquierda', /@media \(max-height: 500px\) and \(orientation: landscape\) \{\n  \.tablero-cuerpo \.columnas > \.columna \{ flex-basis: calc\(50% - 12px\); scroll-snap-align: start; \}/.test(css));
    const car = corte(vista, 'function CarruselColumnas()', '\nfunction ZonasSoltar()');
    check('escucha cruzar el umbral y girar', car.includes("const mqCarrusel = matchMedia(MQ_CARRUSEL);") && car.includes("matchMedia('(orientation: landscape)')")
      && car.includes("mqCarrusel.addEventListener('change', acomodar);") && car.includes("mqGiro.addEventListener('change', acomodar);")
      && car.includes("mqCarrusel.removeEventListener('change', acomodar); mqGiro.removeEventListener('change', acomodar);"));
    check('…y vuelve a la columna que se miraba, después del layout nuevo', /requestAnimationFrame\(\(\) => \{\n\s*irA\(columnaVista\.value, false\);/.test(car));
    check('acostado centra a la izquierda (irA y el salto por el borde)', car.includes("inline: matchMedia(MQ_APAISADO).matches ? 'start' : 'center'")
      && arr.includes("inline: matchMedia(MQ_APAISADO).matches ? 'start' : 'center'"));
    check('las columnas se buscan como .columna (las zonas también tienen data-columna)', car.includes('.columna[data-columna="${id}"]') && car.includes(".columna[data-columna]'"));
  });

  await group('El asa', () => {
    check('44×44 con any-pointer', css.includes('@media (any-pointer: coarse) { .asa-arrastre { display: grid; place-items: center; width: 44px; height: 44px;'));
    check('sin la regla vieja ni el corrimiento de la marca', !css.includes('(hover: none) and (pointer: coarse) { .asa-arrastre') && !css.includes('.tarjeta.arrastrable .marca-familia { right: 48px; }'));
    check('la copia queda donde se agarró, también con el dedo', arr.includes('sesion.offX = sesion.x0 - r.left;') && arr.includes('sesion.offY = sesion.y0 - r.top;') && !arr.includes('r.width / 2'));
  });

  await group('Las zonas de soltado', () => {
    const zonas = corte(vista, 'function ZonasSoltar()', '\n}\n');
    check('solo mientras se arrastra, con validarDestino', zonas.includes('if (!a || !arrastrada) return null;') && zonas.includes('validarDestino(arrastrada, a.desde, c.id)'));
    check('cada zona: data-columna, el nombre y qué pasa (o el motivo)', zonas.includes('class=${clase} data-columna=${c.id}><b>${c.titulo}</b>')
      && zonas.includes("'al final'") && zonas.includes('TRANSICIONES[`${a.desde}→${c.id}`]?.texto') && zonas.includes('`⊘ ${m}`'));
    const car = corte(vista, 'function CarruselColumnas()', '\nfunction ZonasSoltar()');
    check('las pestañas nunca llevan data-columna', !corte(car, '<nav class="pestanas-columnas"', '</nav>').includes('data-columna'));
    check('una capa encima, no pestañas más altas', css.includes('.zonas-soltar { position: absolute; left: 0; right: 0; top: 0; z-index: 4;') && css.includes('.columnas-envoltura { position: relative; }')
      && /\.zona-soltar \{[^}]*min-height: 52px;/.test(css));
    check('el motivo va en texto; atenuar es extra', css.includes('.zona-soltar.destino-invalido { opacity: .55; }') && zonas.includes('`⊘ ${m}`'));
    const calc = corte(arr, 'function calcular()', '\n}\n');
    check('la zona de Por hacer deja la tarjeta al final de la columna real', calc.includes("const zona = col.classList.contains('zona-soltar');")
      && calc.includes('document.querySelector(\'.columna[data-columna="hacer"]\')') && calc.includes('const i = zona ? -1 :'));
    check('sobre las zonas el carrusel no salta (toda la capa, no solo arriba del carril)', arr.includes("const lado = debajo?.closest('.zonas-soltar') ? 0 :"));
    check('fuera del carrusel la capa no existe', /^\.zonas-soltar \{ display: none; \}/m.test(css) && css.indexOf('.zonas-soltar { display: none; }') < css.indexOf(CARRUSEL));
    check('la confirmación, en la columna que se mira (en el carrusel)', vista.includes('(matchMedia(MQ_CARRUSEL).matches ? columnaVista.value : conf.hasta) === c.id'));
    check('sin :has', !css.includes(':has('));
    check('vista-tablero.js no pasa de 1340 líneas', vista.split('\n').length <= 1340, String(vista.split('\n').length));
  });

  report();
})();
