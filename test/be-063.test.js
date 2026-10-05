/**
 * BE-063 — En la consola, lo que el nodo elegido no permite se ve deshabilitado
 * (antes solo frenaba al hacer clic).
 *
 * Sin DOM: se evalúa el trozo de app.js que decide el nivel con un estado y
 * controles de mentira, y se revisa en la fuente que cada control de `ejecutar`
 * lleve su marca.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const appJs = fs.readFileSync(path.join(PUBLICO, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const appCss = fs.readFileSync(path.join(PUBLICO, 'app.css'), 'utf8').replace(/\r\n/g, '\n');

// Desde `esRemoto` hasta antes de `rutaDeNodo`: niveles, motivo y BE-063.
const trozo = appJs.slice(appJs.indexOf('  const esRemoto = () =>'), appJs.indexOf('  function rutaDeNodo('));
function armar(nodo, nodos) {
  const avisos = [];
  const estado = { nodo, nodos };
  const avisar = (texto, tipo) => avisos.push({ texto, tipo });
  const f = new Function('estado', 'avisar', `${trozo}; return { permiteDeVista, bloqueadoPorNivel, anunciarNivel, frenarPorNivel, alcanza };`);
  return { ...f(estado, avisar), avisos };
}

// Un control con `data-nivel` (o sin él) y un hijo adentro, como el ícono de un botón.
function control(nivel, titulo = null) {
  const attrs = new Map();
  if (titulo !== null) attrs.set('title', titulo);
  const c = {
    dataset: nivel ? { nivel } : {},
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    get title() { return attrs.get('title') || ''; },
    set title(v) { attrs.set('title', v); },
    attrs
  };
  c.closest = (sel) => (sel === '[data-nivel]' && nivel ? c : null);
  const hijo = { closest: c.closest };
  return { c, hijo };
}
function evento(target) {
  const ev = { target, frenado: false, prevenido: false };
  ev.preventDefault = () => { ev.prevenido = true; };
  ev.stopImmediatePropagation = () => { ev.frenado = true; };
  return ev;
}

const RED = [{ id: 'local', permite: 'ejecutar' }, { id: 'n1', permite: 'operar' }, { id: 'n2', permite: 'lectura' }, { id: 'n3', permite: 'ejecutar' }];

(async () => {
  await group('BE-063 — el nivel de la vista', () => {
    check('local: ejecutar', armar('local', RED).permiteDeVista() === 'ejecutar');
    check('nodo operar: operar', armar('n1', RED).permiteDeVista() === 'operar');
    check('nodo sin datos todavía: lectura', armar('n1', []).permiteDeVista() === 'lectura');
    check('"Todos": lectura', armar('todos', RED).permiteDeVista() === 'lectura');
  });

  await group('BE-063 — operar: ejecutar queda frenado, operar no', () => {
    const v = armar('n1', RED);
    const { c, hijo } = control('ejecutar');
    check('un control de ejecutar está bloqueado, aun desde su ícono', v.bloqueadoPorNivel(hijo) === c);
    const ev = evento(hijo);
    v.frenarPorNivel(ev);
    check('el clic se frena antes que su acción', ev.prevenido && ev.frenado);
    check('y avisa el motivo', v.avisos.length === 1 && /permite solo operar/.test(v.avisos[0].texto) && v.avisos[0].tipo === 'error', JSON.stringify(v.avisos));
    const op = control('operar');
    const ev2 = evento(op.hijo);
    v.frenarPorNivel(ev2);
    check('un control de operar pasa', !ev2.prevenido && !ev2.frenado && v.bloqueadoPorNivel(op.hijo) === null);
    const sin = control(null);
    const ev3 = evento(sin.hijo);
    v.frenarPorNivel(ev3);
    check('un control sin marca pasa', !ev3.prevenido && v.avisos.length === 1);
  });

  await group('BE-063 — lectura frena todo lo marcado; ejecutar y local, nada', () => {
    const l = armar('n2', RED);
    check('lectura: operar bloqueado', l.bloqueadoPorNivel(control('operar').hijo) !== null);
    check('lectura: ejecutar bloqueado', l.bloqueadoPorNivel(control('ejecutar').hijo) !== null);
    check('nodo con ejecutar: pasa', armar('n3', RED).bloqueadoPorNivel(control('ejecutar').hijo) === null);
    check('local: pasa', armar('local', RED).bloqueadoPorNivel(control('ejecutar').hijo) === null);
  });

  await group('BE-063 — el motivo como tooltip, y el suyo vuelve', () => {
    const { c, hijo } = control('ejecutar', 'Entra a la cola ahora');
    armar('n1', RED).anunciarNivel({ target: hijo });
    check('bloqueado: tooltip con el motivo y aria-disabled', /permite solo operar/.test(c.title) && c.getAttribute('aria-disabled') === 'true', c.title);
    armar('n1', RED).anunciarNivel({ target: hijo });
    check('pasar dos veces no pisa el título guardado', c.dataset.tituloPropio === 'Entra a la cola ahora');
    armar('n3', RED).anunciarNivel({ target: hijo });
    check('con nivel suficiente vuelve su título y se va aria-disabled', c.title === 'Entra a la cola ahora' && c.getAttribute('aria-disabled') === null && !('tituloPropio' in c.dataset));
    const s = control('ejecutar');
    armar('n1', RED).anunciarNivel({ target: s.hijo });
    armar('local', RED).anunciarNivel({ target: s.hijo });
    check('sin título propio, se quita el del motivo', s.c.getAttribute('title') === null);
  });

  await group('BE-063 — cada control de ejecutar lleva la marca', () => {
    const E = "'data-nivel': 'ejecutar'";
    const lineaCon = (texto) => appJs.split('\n').filter((l) => l.includes(texto));
    const marcados = {
      'enviar / castear': "text: esAlma ? 'Enviar' : 'Castear'",
      'reintentar (minúscula)': "text: 'reintentar', onclick: () => reintentarTareaWeb",
      'Reintentar': "text: 'Reintentar', onclick: () => reintentarTareaWeb",
      escuchar: "'data-escuchar': t.id",
      'volver a heredar': "text: 'Volver a heredar'",
      'partir en tarjetas': "text: 'Partir en tarjetas…'",
      // BE-105 — El del formulario ejecuta; el de la tarjeta de una madre solo abre el detalle.
      'preparar lote': "text: 'Preparar lote…', disabled",
      lanzar: "text: 'Lanzar',",
      'guardar y lanzar': "text: 'Guardar y lanzar'",
      'descartar lote': "text: 'Descartar lote'",
      'nueva programación': "text: '+ Nueva programación'",
      'programar para (panel del sujeto)': "href: `/programado?nueva=",
      'programar (enviar el formulario)': "text: 'Programar' }",
      'lectura automática': "class: 'lectura-auto'"
    };
    for (const [nombre, texto] of Object.entries(marcados)) {
      const lineas = lineaCon(texto);
      check(`${nombre}: marcado (${lineas.length})`, lineas.length > 0 && lineas.every((l) => l.includes(E)), lineas.filter((l) => !l.includes(E)).join('\n'));
    }
    const lanzarEnDetalle = appJs.split('\n').filter((l) => /text: 'Lanzar',/.test(l)).length;
    check('los tres botones Lanzar', lanzarEnDetalle === 3, String(lanzarEnDetalle));
    check('los cuatro Reintentar', lineaCon('reintentarTareaWeb(t.id)').filter((l) => l.includes(E)).length === 4);
    // Lo de operar no se marca: crear sin lanzar, anotar, archivar, cancelar, borrar.
    const deOperar = {
      'guardar tarjeta': "const guardar = el('button', { type: 'button', class: 'boton', text: 'Guardar' });",
      anotar: "text: 'Anotar'",
      archivar: "text: t.archivada ? 'desarchivar' : 'archivar'",
      'cancelar (actividad)': "class: 'accion peligro', text: 'cancelar'",
      'quitar / cancelar (tablero)': "text: columna === 'cola' ? 'quitar' : 'cancelar'",
      borrar: "text: 'Borrar'"
    };
    // BE-105 — El «Preparar lote…» de la tarjeta de una madre abre el detalle: navegación, sin marca.
    const deTarjeta = lineaCon("text: 'Preparar lote…'").filter((l) => !l.includes('disabled'));
    check(`preparar lote (tarjeta de una madre): sin marca (${deTarjeta.length})`, deTarjeta.length === 1 && !deTarjeta[0].includes('data-nivel'), deTarjeta.join('\n'));
    for (const [nombre, texto] of Object.entries(deOperar)) {
      const lineas = lineaCon(texto);
      check(`${nombre}: sin marca (${lineas.length})`, lineas.length > 0 && lineas.every((l) => !l.includes('data-nivel')), lineas.join('\n'));
    }
    const voz = appJs.slice(appJs.indexOf('function pintarControlesVoz('), appJs.indexOf('onclick: () => prepararVozWeb(s)'));
    check('preparar voz: marcado', voz.includes(E));
    const motor = appJs.slice(appJs.indexOf("const res = await api('/api/motores/rol'") - 1200, appJs.indexOf("const res = await api('/api/motores/rol'"));
    check('guardar el modelo del rol: marcado', /const guardar = el\('button', \{ type: 'button', class: 'boton primario', 'data-nivel': 'ejecutar', text: 'Guardar' \}\);/.test(motor));
  });

  await group('BE-063 — cuerpo, escuchas y CSS', () => {
    const cargar = appJs.slice(appJs.indexOf('async function cargarNodos('), appJs.indexOf('function pintarSelectorNodo('));
    check('cargarNodos fija data-permite al saber qué permite el nodo', /estado\.nodos = nodos;\n\s+document\.body\.dataset\.permite = permiteDeVista\(\);/.test(cargar));
    const arranque = appJs.slice(appJs.indexOf('// ---------------------------------------------------------------- arranque'));
    check('al arrancar: data-permite y las tres escuchas', arranque.includes('document.body.dataset.permite = permiteDeVista();')
      && arranque.includes("document.addEventListener('click', frenarPorNivel, true);")
      && arranque.includes("document.addEventListener('pointerover', anunciarNivel);")
      && arranque.includes("document.addEventListener('focusin', anunciarNivel);"));
    check('el CSS apaga lo que no alcanza', appCss.includes('[data-permite="lectura"] [data-nivel], [data-permite="operar"] [data-nivel="ejecutar"] { opacity: .45; cursor: not-allowed; }'));
  });

  report();
})();
