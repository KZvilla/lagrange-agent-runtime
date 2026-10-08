/**
 * BE-063 — En la consola, lo que el nodo elegido no permite se ve deshabilitado
 * (antes solo frenaba al hacer clic).
 *
 * Sin DOM: se importa ui/nucleo.js (FEAT-136: ahí vive lo que decide el
 * nivel) con un nodo y controles de mentira, y se revisa en la fuente del
 * cliente (app.js y ui/) que cada control de `ejecutar` lleve su marca.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const appJs = fs.readFileSync(path.join(PUBLICO, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
// FEAT-136 — El cliente: app.js más sus módulos de ui/ (las vistas se mudan ahí).
const cliente = [appJs, ...fs.readdirSync(path.join(PUBLICO, 'ui')).filter((f) => f.endsWith('.js')).sort()
  .map((f) => fs.readFileSync(path.join(PUBLICO, 'ui', f), 'utf8').replace(/\r\n/g, '\n'))].join('\n');
const appCss = fs.readFileSync(path.join(PUBLICO, 'app.css'), 'utf8').replace(/\r\n/g, '\n');

// FEAT-136 — Lo que decide el nivel vive en ui/nucleo.js: se importa el módulo real. `avisar` escribe en
// `#aviso`: un elemento de mentira registra lo que dice.
let nucleo = null;
const avisos = [];
const avisoFalso = {
  set textContent(v) { avisos.push({ texto: v, tipo: undefined }); },
  set className(c) { if (avisos.length) avisos[avisos.length - 1].tipo = c.includes('error') ? 'error' : undefined; },
  hidden: true
};
globalThis.document = { querySelector: (sel) => (sel === '#aviso' ? avisoFalso : null) };
function armar(nodo, nodos) {
  nucleo.nodo.value = nodo;
  nucleo.nodos.value = nodos;
  avisos.length = 0;
  const { permiteDeVista, bloqueadoPorNivel, anunciarNivel, frenarPorNivel, alcanza } = nucleo;
  return { permiteDeVista, bloqueadoPorNivel, anunciarNivel, frenarPorNivel, alcanza, avisos };
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
  nucleo = await import(require('url').pathToFileURL(path.join(PUBLICO, 'ui', 'nucleo.js')).href);
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
    // FEAT-136 — En los componentes la marca es `data-nivel="ejecutar"`; se mira todo el cliente.
    const E = "'data-nivel': 'ejecutar'";
    const E2 = 'data-nivel="ejecutar"';
    const marcada = (l) => l.includes(E) || l.includes(E2);
    // FEAT-136 — Cada control se busca con su forma vieja (el()) o la de componente (htm): vale cualquiera.
    const lineaCon = (patrones) => cliente.split('\n').filter((l) => [].concat(patrones).some((p) => l.includes(p)));
    const marcados = {
      'enviar / castear': ["text: esAlma ? 'Enviar' : 'Castear'", "${esAlma ? 'Enviar' : 'Castear'}"],
      'reintentar (minúscula)': ["text: 'reintentar', onclick: () => reintentarTareaWeb", "onClick=${() => acc.reintentar(t.id)}>reintentar"],
      Reintentar: ["text: 'Reintentar', onclick: () => reintentarTareaWeb", '>Reintentar</button>'],
      escuchar: ["'data-escuchar': t.id", 'data-escuchar=${t.id}'],
      'volver a heredar': ["text: 'Volver a heredar'", '>Volver a heredar<'],
      'partir en tarjetas': ["text: 'Partir en tarjetas…'", '>Partir en tarjetas…</button>'],
      // BE-105 — El del formulario ejecuta; el de la tarjeta de una madre solo abre el detalle.
      'preparar lote': ["text: 'Preparar lote…', disabled", "'Configurar workers confinados'"],
      lanzar: ["text: 'Lanzar',", 'texto="Lanzar"'],
      'guardar y lanzar': ["text: 'Guardar y lanzar'", '>Guardar y lanzar</button>'],
      'descartar lote': ["text: 'Descartar lote'", 'texto="Descartar lote"'],
      'nueva programación': ["text: '+ Nueva programación'", '>+ Nueva programación'],
      'programar para (panel del sujeto)': ['href: `/programado?nueva=', 'href=${`/programado?nueva='],
      'programar (enviar el formulario)': ["text: 'Programar' }", '>Programar</button>'],
      'lectura automática': ["class: 'lectura-auto'", 'class="lectura-auto"']
    };
    for (const [nombre, patrones] of Object.entries(marcados)) {
      const lineas = lineaCon(patrones);
      check(`${nombre}: marcado (${lineas.length})`, lineas.length > 0 && lineas.every(marcada), lineas.filter((l) => !marcada(l)).join('\n'));
    }
    const lanzar = lineaCon(["text: 'Lanzar',", 'texto="Lanzar"']).length;
    check('los tres botones Lanzar', lanzar === 3, String(lanzar));
    // La charla usa un solo botón (componente Turno) para sus dos casos; el tablero, los suyos.
    const reintentos = lineaCon(['reintentarTareaWeb(t.id)', 'acc.reintentar(t.id)', 'reintentarTarea(t.id)']).filter((l) => !/function /.test(l));
    check('cada Reintentar marcado (tablero y charla)', reintentos.length >= 3 && reintentos.every(marcada), reintentos.filter((l) => !marcada(l)).join(' | '));
    // Lo de operar no se marca: crear sin lanzar, anotar, archivar, cancelar, borrar.
    const deOperar = {
      'guardar tarjeta': ["const guardar = el('button', { type: 'button', class: 'boton', text: 'Guardar' });", 'onClick=${() => enviar(false)}>Guardar</button>'],
      anotar: ["text: 'Anotar'", '>Anotar</button>'],
      archivar: ["text: t.archivada ? 'desarchivar' : 'archivar'", "${t.archivada ? 'desarchivar' : 'archivar'}"],
      'cancelar (actividad)': '<${BotonDosPasos} texto="cancelar"',
      'quitar / cancelar (tablero)': ["text: columna === 'cola' ? 'quitar' : 'cancelar'", "texto=${columna === 'cola' ? 'quitar' : 'cancelar'}"],
      borrar: ["text: 'Borrar'", 'texto="Borrar"']
    };
    // BE-105 — El «Preparar lote…» de la tarjeta de una madre abre el detalle: navegación, sin marca.
    const deTarjeta = lineaCon(["text: 'Preparar lote…'", '>Preparar lote…</button>']).filter((l) => !l.includes('disabled'));
    check(`preparar lote (tarjeta de una madre): sin marca (${deTarjeta.length})`, deTarjeta.length === 1 && !deTarjeta[0].includes('data-nivel'), deTarjeta.join('\n'));
    for (const [nombre, patrones] of Object.entries(deOperar)) {
      const lineas = lineaCon(patrones);
      check(`${nombre}: sin marca (${lineas.length})`, lineas.length > 0 && lineas.every((l) => !l.includes('data-nivel')), lineas.join('\n'));
    }
    // FEAT-136 F4 — Los controles de voz son un componente (ui/voz.js).
    const voz = cliente.slice(cliente.indexOf('export function ControlesVoz('), cliente.indexOf('onClick=${() => prepararVoz(s)}'));
    check('preparar voz: marcado', marcada(voz));
    // FEAT-136 F4 — El formulario del motor es un componente (ui/panel.js).
    const motor = cliente.slice(cliente.indexOf('function FormularioMotor('), cliente.indexOf('// ---------------------------------------------------------------- FEAT-076: hilo'));
    check('guardar el modelo del rol: marcado', motor.includes('<button type="button" class="boton primario" data-nivel="ejecutar" disabled=${enviando} onClick=${guardar}>Guardar</button>'));
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
