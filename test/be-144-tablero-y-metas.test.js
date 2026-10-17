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

group('R2 — Metas', () => {
  const metas = leer('tablero-metas.js');
  const reglas = leer('reglas-metas.js');
  check('sin metas, una línea con el botón junto al texto', metas.includes("franja-metas-cabecera${sinMetas ? ' vacia' : ''}") && css.includes('.franja-metas-cabecera.vacia .meta-nueva { margin-left: 0; }'));
  check('formulario: placeholder, foco al nombre, anchos y alto de botones', metas.includes('placeholder="p. ej. Publicar la v2"') && metas.includes('nombre.current?.focus()')
    && css.includes('.meta-form > .campo:first-child { flex-grow: 2; }') && css.includes('.meta-form-acciones .boton { min-height: 30px; }') && css.includes('.meta-nueva[aria-expanded="true"]'));
  check('el disparador es «⋮»', metas.includes('class="tarjeta-mas meta-editar" aria-haspopup="dialog"') && metas.includes('>⋮</button>') && !metas.includes('>⋯</button>'));
  check('color por meta en el ítem y en el chip', metas.includes('meta-item ${tono(m.id)}') && metas.includes('chip meta-chip ${tono(m.id)}') && css.includes('border-left: 3px solid var(--tono, var(--borde-suave));'));
  check('sin tarjetas, dice qué hacer', metas.includes("'Vinculá tarjetas desde su detalle'"));
  check('un solo término: «Marcar cumplida» y «Meta cumplida.»', metas.includes("'Marcar cumplida'") && metas.includes("'Meta cumplida.'") && !metas.includes('Cerrar meta') && !reglas.includes("return 'cerrada'"));
  check('el diálogo muestra proyecto, tipo y avance', metas.includes('<span class="tenue dialogo-sub">') && metas.includes('<${DialogoMeta} key=${editada.id} m=${editada} c=${conteo[editada.id]} />'));
  check('Borrar aparte, antes del hueco', corte(metas, 'function DialogoMeta(').indexOf('texto="Borrar"') < corte(metas, 'function DialogoMeta(').indexOf('dialogo-hueco')
    && corte(metas, 'function DialogoMeta(').indexOf('dialogo-hueco') < corte(metas, 'function DialogoMeta(').indexOf("'Marcar cumplida'"));
  check('cumplida a mano: avance real', reglas.includes('if (m.tipo === \'tarjetas\' && m.cerrada && c && c.total) return Math.min(1, c.hechas / c.total);'));
  check('cumplidas: filtro activo, atenuadas y con ✓', metas.includes('aria-pressed=${String(verCumplidas)}') && metas.includes("${cumplida ? '✓ ' : ''}") && css.includes('.meta-item.cumplida { opacity: .75; }'));
  check('festejo solo con CSS y sin él con reduced-motion', metas.includes("${festejo ? ' festejo' : ''}") && css.includes('@keyframes meta-festejo') && css.includes('@media (prefers-reduced-motion: reduce) { .meta-item.festejo::after { display: none; } }')
    && !metas.includes('grafo.module.js'));
  const franja = corte(metas, 'export function FranjaMetas(');
  check('el hook del festejo va antes de los return tempranos', franja.indexOf('}, [firma]);') > 0 && franja.indexOf('}, [firma]);') < franja.indexOf("if (nodo.value !== 'local') return null;"));
  check('la que se festeja sigue a la vista con las cumplidas plegadas', franja.includes('(festejo === m.id && !verCumplidas)'));
  check('riel de la barra visible', css.includes('.barra-progreso { display: block; height: 6px; border-radius: 999px; background: var(--borde);'));
  check('tablero-metas.js ≤ 210 líneas', metas.split('\n').length <= 210);
});

report();
