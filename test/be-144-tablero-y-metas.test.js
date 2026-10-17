/**
 * BE-144 — Tablero y metas (revisión de UI posterior a BE-141): vacíos por columna, «Guardar y lanzar» sin sujeto
 * deshabilitado, «Asignar a» arriba del detalle, título y tono de columna en el encabezado; y las metas con «⋮»,
 * color, «Marcar cumplida», avance real y festejo.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const leer = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8').replace(/\r\n/g, '\n');
const corte = (s, desde, hasta = '\n}\n') => { const i = s.indexOf(desde); return s.slice(i, s.indexOf(hasta, i) + hasta.length); };
const vista = leer('vista-tablero.js');
const css = leer('../app.css');

group('R1 — Tablero y detalle', () => {
  check('cada columna vacía dice lo suyo, Por hacer incluida', vista.includes("const VACIO_COLUMNA = { hacer: 'Nada por hacer.") && vista.includes("cola: 'Nada esperando turno'")
    && vista.includes("curso: 'Nadie trabajando ahora'") && vista.includes('${VACIO_COLUMNA[c.id]}') && !vista.includes("'En espera'"));
  check('Por hacer no muestra el vacío con el formulario abierto', vista.includes("!(c.id === 'hacer' && nuevaAbierta.value)"));
  check('«Guardar y lanzar» sin sujeto, deshabilitado y con motivo (columna y hoja)', (vista.match(/disabled=\$\{enviando \|\| !asignacion\.sujeto\} title=\$\{asignacion\.sujeto \? null : SIN_SUJETO\}/g) || []).length === 2);
  const det = corte(vista, 'function DetalleTarea(', 'function DetalleFanout(');
  check('«Asignar a» en su bloque, primero en el lateral de Por hacer', det.includes('const bAsignar = porHacer ?') && det.includes('<${Zona}>${bAsignar}${bPartir}')
    && corte(vista, 'function AsignarPorHacer(').includes('data-asignar') && !corte(vista, 'function EdicionPorHacer(').includes('<${Asignacion}'));
  check('el motivo del pie lleva al selector', vista.includes("document.querySelector('#detalle [data-asignar] select')?.focus()") && (vista.match(/<\$\{MotivoPie\} t=\$\{t\} motivo=\$\{motivo\} \/>/g) || []).length === 2);
  check('título enfocable en el encabezado, también en Por hacer, con el tono de la columna', det.includes('<h2 class="detalle-titulo" tabindex="-1"') && det.includes('detalle-cabecera con-tono col-${columnaDeEstado(t.estado)}')
    && css.includes('.detalle-cabecera.con-tono { border-top: 3px solid var(--col-tono, transparent); }'));
  check('al abrir, el foco va al título (sin anillo con el mouse)', vista.includes("document.querySelector('#detalle .detalle-titulo[tabindex]') || document.querySelector('#detalle .detalle-cerrar')")
    && css.includes('.detalle-titulo:focus:not(:focus-visible) { outline: none; }'));
  check('Partir en chico', corte(vista, 'function FormularioPartir(').includes('class="boton chico" data-nivel="ejecutar"'));
  check('alto inicial 40', leer('tablero-detalle.js').includes('export const ALTO_INICIAL = 40;'));
  check('la tarjeta abierta con borde de acento', css.includes('outline: 2px solid var(--acento); outline-offset: -1px;'));
  check('«⚠ sin asignar» y el contador solo cerca del tope', vista.includes("'⚠ sin asignar'") && vista.includes('pedido.length >= TOPE_PEDIDO_TARJETA * 0.8 ?'));
  check('vista-tablero.js dentro de su tope', vista.split('\n').length <= 1340);
});

report();
