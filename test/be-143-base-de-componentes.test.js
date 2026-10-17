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

report();
