/**
 * BE-143 — Base de componentes, segunda vuelta (revisión de UI posterior a BE-141): menús flotantes con separadores,
 * íconos y motivos; `Segmentado` compartido y con el elegido visible; diálogo con título separado y `BotonDosPasos`
 * de ancho estable; campos del formulario de tarjeta con caja.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const leer = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8').replace(/\r\n/g, '\n');
const corte = (s, desde, hasta = '\n}\n') => { const i = s.indexOf(desde); return s.slice(i, s.indexOf(hasta, i) + hasta.length); };
const regla = (css, sel) => { const i = css.indexOf(`\n${sel} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1); };
const comp = leer('comp-base.js');
const vista = leer('vista-tablero.js');
const css = leer('../app.css');

group('R1 — Menús', () => {
  const menu = corte(comp, 'export function MenuAcciones(');
  check('la lista flota y se ubica por CSSOM, oculta hasta medirla', regla(css, '.menu-mover-lista').includes('position: fixed;') && regla(css, '.menu-mover-lista').includes('visibility: hidden;')
    && menu.includes('menu.style.left = `${Math.round(left)}px`;') && menu.includes("menu.style.visibility = 'visible';"));
  check('alineada a la derecha con «abajo» y dentro de la ventana', menu.includes('abajo ? d.right - r.width : d.left') && menu.includes('window.innerWidth - r.width - MARGEN_MENU'));
  check('se cierra con scroll (salvo el propio) o resize', menu.includes("window.addEventListener('scroll', desplazar, true);") && menu.includes("window.addEventListener('resize', redimensionar);")
    && menu.includes('const desplazar = (ev) => { if (!raiz.current?.contains(ev.target)) cerrar(); };'));
  check('sin las clases de posición viejas', !css.includes('.menu-mover-lista.abajo') && !css.includes('.menu-mover-lista.arriba') && !menu.includes("' arriba'"));
  check('separadores (sin sobrantes) e íconos', menu.includes("d === 'separador' ? html`<hr key=${`s${i}`} class=\"menu-sep\" />`") && comp.includes('const sinSeparadoresDeMas = ')
    && menu.includes('const conIcono = (d) => (d.icono ?') && css.includes('.menu-sep { border: 0;'));
  const hacer = corte(vista, 'function TarjetaPorHacer(');
  check('el «⋮» separa Borrar o Descartar e ilustra sus ítems', hacer.includes("'separador',") && hacer.includes('icono: ICONO_BORRAR') && hacer.includes('icono: ICONO_ACEPTAR'));
  check('«Mover a…» separa los destinos del orden', corte(vista, 'export function MenuMover(').includes("['separador', ...movidasDeHacer(t)]"));
  check('las movidas deshabilitadas dicen por qué', vista.includes("titulo: m.no ? NO_MOVIDA[m.texto] : undefined") && vista.includes("'Ya está arriba de todo'") && vista.includes("'Ya está abajo de todo'"));
  check('deshabilitado legible', css.includes('.menu-mover-lista button:is(:disabled, [aria-disabled="true"]) { opacity: .45; cursor: not-allowed; }')
    && css.includes('.tub-menu-item:disabled { opacity: .45; cursor: not-allowed; }'));
  check('los ítems del menú contextual sin mayúsculas', !regla(css, '.tub-menu-item').includes('text-transform') && regla(css, '.tub-menu-item').includes('font-size: 13px;'));
  check('el menú contextual muestra el motivo de lo deshabilitado', leer('tuberias-menu.js').includes('${it.deshabilitado && it.motivo ? html`<span class="menu-motivo">${it.motivo}</span>` : null}'));
  check('el aviso flotante va abajo a la derecha', regla(css, '.aviso-flotante').includes('right: calc(20px + env(safe-area-inset-right, 0px));') && !regla(css, '.aviso-flotante').includes('translateX'));
});

group('R2 — Segmentado', () => {
  const seg = corte(comp, 'export function Segmentado(');
  check('vive en comp-base y une su clase con la de attrs', seg.includes("const { class: extra, ...resto } = attrs || {};") && seg.includes("class=${extra ? `segmentado ${extra}` : 'segmentado'}"));
  check('marca el elegido (aria-pressed y clase) y la opción peligrosa', seg.includes('aria-pressed=${String(valor === v)}') && seg.includes("peligro ? 'peligro' : ''"));
  const aj = leer('vista-ajustes.js');
  check('Ajustes usa el común (sin su propio grupo de botones)', aj.includes('Segmentado as SegmentadoBase') && aj.includes('attrs=${nombreCampo ? campo(nombreCampo) : null}') && !aj.includes('class="ajustes-seg"'));
  check('YOLO es la opción peligrosa', leer('ajustes-general.js').includes("[m, ETIQUETA_MODO[m] || m, m === 'yolo']"));
  check('CSS: el elegido en acento y el peligroso en rojo, sin la regla vieja', css.includes('.segmentado button.activo { background: var(--acento); color: var(--acento-texto);')
    && css.includes('.segmentado button.activo.peligro { background: var(--peligro);') && !css.includes('.ajustes-seg'));
});

group('R3 — Diálogo y dos pasos', () => {
  const dlg = corte(comp, 'export function Dialogo(');
  check('el título se separa con una línea de borde a borde (solo el hijo directo)', css.includes('.dialogo > strong:first-child { display: block; margin: -2px -18px 0;'));
  check('velo más marcado y desenfocado', regla(css, '.dialogo-fondo').includes('background: rgba(0, 0, 0, .5); backdrop-filter: blur(2px);'));
  check('el nombre propuesto viene seleccionado', dlg.includes("if (primero?.matches('input[type=\"text\"], input:not([type])')) primero.select();"));
  const rec = leer('tuberias-receta-acciones.js');
  check('la receta usa Campo y Duplicar dice qué copia', rec.includes('<${Campo} texto="Nombre">') && !rec.includes('class="tub-campo"') && rec.includes('Copia el grafo y la configuración de cada nodo; la original no cambia.'));
  const dos = corte(comp, 'export function BotonDosPasos(');
  check('dos pasos: ancho estable sin minWidth', dos.includes('<span class="dos-pasos">') && !dos.includes('minWidth') && css.includes('.dos-pasos > [aria-hidden="true"] { visibility: hidden; }'));
  check('armado relleno, con la barrita de 4 s y sin ella con reduced-motion', regla(css, '.boton.armado').includes('background: var(--peligro);') && css.includes('animation: armado-tiempo 4s linear forwards;')
    && css.includes('@media (prefers-reduced-motion: reduce) { .boton.armado::after { display: none; } }'));
});

group('R4 — Campos', () => {
  check('el formulario de tarjeta usa la caja de la base', !regla(css, '.form-tarjeta input[type="text"]').includes('transparent') && !regla(css, '.form-tarjeta textarea').includes('border: 0;'));
  const nueva = vista.slice(vista.indexOf('<form class="form-tarjeta"'), vista.indexOf('</form>', vista.indexOf('<form class="form-tarjeta"')));
  check('el atajo va debajo del pedido, con kbd, y no en la fila de botones', nueva.includes('<span class="tecla form-atajo"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> guarda</span>')
    && nueva.indexOf('form-atajo') < nueva.indexOf('form-fila acciones') && !nueva.includes('Ctrl+Enter guarda</span>\n        <button'));
  check('radios y casillas con el acento', css.includes('input[type="radio"], input[type="checkbox"] { accent-color: var(--acento); }'));
  check('vista-tablero.js dentro de su tope', vista.split('\n').length <= 1340);
});

report();
