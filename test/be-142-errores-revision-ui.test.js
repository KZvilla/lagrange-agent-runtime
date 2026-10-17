/**
 * BE-142 — Errores de la revisión de UI posterior a BE-141: el «⋮» y «Mover a…» arman sus ítems al abrirse (la
 * tarjeta no se redibuja cuando entra otra), el menú se abre hacia arriba si abajo no entra y sin desplazar la
 * página, Esc devuelve el foco al disparador, el selector de meta no queda en blanco con una meta borrada, el menú
 * contextual de Tuberías devuelve el foco y Reconstruir imagen no ofrece por defecto la versión que va a fallar.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const leer = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8').replace(/\r\n/g, '\n');
const corte = (s, desde, hasta = '\n}\n') => { const i = s.indexOf(desde); return s.slice(i, s.indexOf(hasta, i) + hasta.length); };
const comp = leer('comp-base.js');
const vista = leer('vista-tablero.js');
const css = leer('../app.css');

group('MenuAcciones', () => {
  const menu = corte(comp, 'export function MenuAcciones(');
  check('acepta items como función y la resuelve al dibujar', menu.includes("const todos = typeof items === 'function' ? items() : items;")
    && menu.includes('if (!todos?.length) return null;') && menu.includes(': todos.map(item);'));
  check('el foco al primer ítem no desplaza la página', menu.includes('?.focus({ preventScroll: true })'));
  check('mide y se abre hacia arriba si abajo no entra', menu.includes('r.bottom > window.innerHeight - 8') && menu.includes("${arriba ? ' arriba' : ''}")
    && css.includes('.menu-mover-lista.arriba { top: auto; bottom: calc(100% + 6px); }'));
  check('la regla «arriba» va después de «abajo» (gana a igual especificidad)', css.indexOf('.menu-mover-lista.arriba') > css.indexOf('.menu-mover-lista.abajo'));
  check('Esc y elegir devuelven el foco al disparador; el clic afuera no', menu.includes('<button ref=${boton}')
    && menu.includes('if (devolver) boton.current?.focus();') && menu.includes("if (ev.key === 'Escape') { ev.stopPropagation(); cerrar(true); }")
    && menu.includes('if (!raiz.current?.contains(ev.target)) cerrar(); };'));
});

group('Ítems perezosos en el tablero', () => {
  const hacer = corte(vista, 'function TarjetaPorHacer(');
  check('el «⋮» de Por hacer pasa una función', hacer.includes('secundarias = () => [') && hacer.includes('movidasDeHacer(t)'));
  const mover = corte(vista, 'export function MenuMover(');
  check('«Mover a…» también', mover.includes('const items = () => [') && mover.includes('items=${items}'));
});

group('Meta borrada', () => {
  check('el selector muestra «Sin meta» si la meta ya no existe', leer('tablero-metas.js').includes('<select value=${metaPorId(t.metaId) ? t.metaId : \'\'}'));
});

group('Menú contextual de Tuberías', () => {
  const menu = leer('tuberias-menu.js');
  check('guarda el foco previo en el primer render', menu.includes('const previo = useRef(document.activeElement);'));
  check('lo devuelve solo con Esc o al elegir', menu.includes('const devolver = useRef(false);') && menu.includes('if (!devolver.current) return;')
    && menu.includes('devolver.current = true; alCerrar(); it.accion();') && menu.includes("e.preventDefault(); devolver.current = true; alCerrar();"));
  check('sin foco previo, vuelve al «⋯» del origen', menu.includes("menu.origen?.querySelector?.('.tub-receta-mas')"));
  check('la lista pasa el origen y MenuReceta lo propaga', leer('tuberias-lateral.js').includes("origen: e.currentTarget.closest?.('.tub-receta')")
    && leer('tuberias-receta-acciones.js').includes("tipo: 'receta', id: r.id, origen: menu.origen }}"));
});

group('Reconstruir imagen', () => {
  const dlg = corte(leer('harness-acciones.js'), 'function DialogoConstruir(');
  check('si la fijada falla (agy), arranca en la última', dlg.includes("const fijadaFalla = harness === 'agy' && Boolean(ultima) && ultima !== im.fijada;")
    && dlg.includes("useState(fijadaFalla ? 'ultima' : 'fijada')"));
  check('y la fijada no se puede elegir, con el motivo junto a la opción', dlg.includes('disabled=${fijadaFalla}') && dlg.includes('con la fijada, el build fallaría')
    && !dlg.includes('<li class="tub-aviso-txt">El instalador de agy'));
  check('«ningún lote arranca» destacado', dlg.includes('<strong>Mientras dura, ningún lote arranca ni se reanuda.</strong>'));
});

group('Tamaño de los módulos', () => {
  for (const f of ['tablero-metas.js', 'tablero-tarjeta.js', 'tuberias-menu.js', 'tuberias-lateral.js', 'tuberias-receta-acciones.js']) {
    check(`${f} ≤ 210 líneas`, leer(f).split('\n').length <= 210);
  }
});

report();
