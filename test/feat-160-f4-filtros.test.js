/**
 * FEAT-160 F4 — La barra de filtros en dos niveles. Las reglas
 * (ui/reglas-filtro.js) se ejecutan; la barra (ui/tablero-filtros.js), la
 * vista y el CSS se leen como texto. Dos ejes: `filtro.quien` (el sujeto) y
 * `mostrar` (todo, propuestas o lotes), que se guarda aparte porque Desktop
 * valida `tablero.filtro` con sus siete claves exactas.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const leer = (rel) => fs.readFileSync(path.join(PUBLICO, rel), 'utf8').replace(/\r\n/g, '\n');
const vista = leer('ui/vista-tablero.js');
const barra = leer('ui/tablero-filtros.js');
const reglasTxt = leer('ui/reglas-filtro.js');
const css = leer('app.css');

const CLAVES = ['quien', 'proyecto', 'origen', 'hoy', 'archivadas', 'agrupar', 'q'];
const AHORA = Date.parse('2026-10-14T15:00:00');
const HOY = '2026-10-14T10:00:00';
const AYER = '2026-10-13T10:00:00';
const tarea = (extra = {}) => ({ id: 't1', estado: 'por_hacer', creada: HOY, origen: 'web', proyecto: 'p1', sujeto: { tipo: 'alma', clave: 'alya' }, ...extra });
const lote = (extra = {}) => ({ id: 'f:1', lote: true, slug: 'docs', tareas: [{ id: 'a' }], workspace: { nombre: 'p1' }, actualizado: HOY, ...extra });
const SIN = { seq: 0, ids: null, error: null };

(async () => {
  const R = await import(pathToFileURL(path.join(PUBLICO, 'ui', 'reglas-filtro.js')).href);
  const V = (cambios = {}) => ({ ...R.FILTRO_VACIO, ...cambios });

  await group('El filtro guardado y su migración', () => {
    check('FILTRO_VACIO tiene exactamente las siete claves de Desktop', JSON.stringify(Object.keys(R.FILTRO_VACIO).sort()) === JSON.stringify([...CLAVES].sort()));
    const a = R.migrarFiltro(V({ quien: 'fanout', proyecto: 'p1' }));
    check('fanout → Mostrar «lotes» y Quién «todo», sin tocar lo demás', a.mostrar === 'lotes' && a.filtro.quien === 'todo' && a.filtro.proyecto === 'p1');
    const b = R.migrarFiltro(V({ quien: 'propuestas' }));
    check('propuestas → Mostrar «propuestas» y Quién «todo»', b.mostrar === 'propuestas' && b.filtro.quien === 'todo');
    check('un sujeto concreto queda intacto', R.migrarFiltro(V({ quien: 'alma:alya' })).mostrar === null && R.migrarFiltro(V({ quien: 'alma:alya' })).filtro.quien === 'alma:alya');
    check('idempotente', R.migrarFiltro(a.filtro).mostrar === null && JSON.stringify(R.migrarFiltro(a.filtro).filtro) === JSON.stringify(a.filtro));
    check('la salida conserva las siete claves', JSON.stringify(Object.keys(a.filtro).sort()) === JSON.stringify([...CLAVES].sort()));
  });

  await group('Qué pasa', () => {
    const pasa = (x, f = {}, m = 'todo', b = SIN) => R.pasaFiltros(x, V(f), b, m, AHORA);
    check('Mostrar lotes: solo lotes', pasa(lote(), {}, 'lotes') && !pasa(tarea(), {}, 'lotes'));
    check('Mostrar propuestas: solo propuestas, nunca lotes', pasa(tarea({ propuesta: {} }), {}, 'propuestas') && !pasa(tarea(), {}, 'propuestas') && !pasa(lote(), {}, 'propuestas'));
    check('las propuestas de Alya: los dos ejes a la vez', pasa(tarea({ propuesta: {} }), { quien: 'alma:alya' }, 'propuestas')
      && !pasa(tarea({ propuesta: {}, sujeto: { tipo: 'alma', clave: 'otra' } }), { quien: 'alma:alya' }, 'propuestas'));
    check('un lote no pasa con origen, archivadas ni un quién', !pasa(lote(), { origen: 'web' }) && !pasa(lote(), { archivadas: true }) && !pasa(lote(), { quien: 'alma' }) && pasa(lote()));
    check('un lote: proyecto y búsqueda por slug', pasa(lote(), { proyecto: 'p1', q: 'DOCS' }) && !pasa(lote(), { proyecto: 'p2' }));
    check('Solo archivadas reemplaza las activas', pasa(tarea({ archivada: true }), { archivadas: true }) && !pasa(tarea(), { archivadas: true }));
    check('FEAT-068: una archivada que la búsqueda encontró aparece', pasa(tarea({ archivada: true }), { q: 'x' }, 'todo', { ...SIN, ids: new Set(['t1']) }) && !pasa(tarea({ archivada: true })));
    check('Solo de hoy', pasa(tarea(), { hoy: true }) && !pasa(tarea({ creada: AYER }), { hoy: true }));
    check('Quién por tipo y por sujeto', pasa(tarea(), { quien: 'alma' }) && !pasa(tarea(), { quien: 'agente' }) && pasa(tarea({ sujeto: { tipo: 'agente', nombre: 'rev' } }), { quien: 'agente:rev' }));
  });

  await group('Pastillas, lotes ocultos y «hay filtros»', () => {
    const ps = R.escondidosActivos(V({ origen: 'telegram', hoy: true, archivadas: true }), 'lotes');
    check('una pastilla por filtro escondido, con su texto', JSON.stringify(ps.map((p) => p.texto)) === JSON.stringify(['Solo lotes', 'Origen: Telegram', 'Solo de hoy', 'Solo archivadas']));
    check('quitar una apaga solo esa', JSON.stringify(ps.map((p) => p.quitar)) === JSON.stringify([{ mostrar: 'todo' }, { origen: '' }, { hoy: false }, { archivadas: false }]));
    check('sin escondidos, sin pastillas', R.escondidosActivos(V({ quien: 'alma', proyecto: 'p1', q: 'x' }), 'todo').length === 0);
    const ls = [lote(), lote({ id: 'f:2', workspace: { nombre: 'p2' } })];
    check('lotes ocultos por origen, archivadas o quién (no por proyecto)', R.lotesOcultos(ls, V({ origen: 'web' }), SIN, 'todo', AHORA) === 2
      && R.lotesOcultos(ls, V({ quien: 'alma', proyecto: 'p1' }), SIN, 'todo', AHORA) === 1 && R.lotesOcultos(ls, V(), SIN, 'todo', AHORA) === 0);
    check('con Mostrar propuestas no se avisa (se pidió ocultarlos)', R.lotesOcultos(ls, V({ origen: 'web' }), SIN, 'propuestas', AHORA) === 0);
    check('hay filtros: cualquiera de los dos niveles; agrupar no cuenta', R.hayFiltros(V({ q: ' x ' }), 'todo') && R.hayFiltros(V(), 'lotes') && R.hayFiltros(V({ hoy: true }), 'todo')
      && !R.hayFiltros(V({ agrupar: true, q: '  ' }), 'todo'));
  });

  await group('Módulos', () => {
    check('reglas-filtro.js no importa nada', !/^import /m.test(reglasTxt));
    const imports = [...barra.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
    check('tablero-filtros.js solo trae módulos hoja (nunca la vista)', JSON.stringify(imports) === JSON.stringify(['../vendor/signals-core.module.js', '../vendor/hooks.module.js', './html.js', './comp-base.js', './estado.js', './persistencia.js', './hoja.js', './reglas-filtro.js'])
      && !imports.some((i) => i.includes('vista-tablero')), imports.join(' '));
    check('tablero-filtros.js: 210 líneas o menos', barra.split('\n').length <= 210, String(barra.split('\n').length));
    check('vista-tablero.js re-exporta lo que usa app.js', vista.includes('export { filtro, busqueda, normalizar };') && vista.includes('export function pasaFiltros(x, f = filtro.value, b = busqueda.value, m = mostrar.value) {'));
    check('«mostrar» en su propia clave, validado contra las tres opciones', barra.includes("persistente('tablero.mostrar', 'todo', { validar: (v) => MOSTRAR.includes(v) })"));
    check('el filtro guardado sigue validado como antes', barra.includes("export const filtro = persistente('tablero.filtro', FILTRO_VACIO, {"));
    check('cambiarFiltro solo escribe claves de FILTRO_VACIO', barra.includes('for (const k of Object.keys(FILTRO_VACIO)) if (k in cambios) f[k] = cambios[k];'));
    check('la migración también corre si Desktop resiembra un valor viejo', /effect\(\(\) => \{\n  const \{ filtro: f, mostrar: m \} = migrarFiltro\(filtro\.value\);/.test(barra));
    check('Columnas y el carrusel se suscriben a «mostrar»', vista.includes('  const m = mostrar.value;\n  const conFiltros = hayFiltros(f, m);') && vista.includes('  void mostrar.value;\n  const lista = tareasDelTablero();'));
    check('persistencia.js no se tocó (CLAVES_NATIVAS sin «tablero.mostrar»)', !leer('ui/persistencia.js').includes('tablero.mostrar'));
  });

  await group('La barra', () => {
    check('el buscador conserva su id (el atajo «/» de app.js)', barra.includes('id="tablero-buscar"') && leer('app.js').includes("$('#tablero-buscar')?.focus();"));
    check('cuántas encontró la búsqueda', barra.includes("encontradas === 1 ? '1 resultado' : `${encontradas} resultados`"));
    const quien = barra.slice(barra.indexOf('const quienes = ['), barra.indexOf('\n', barra.indexOf('const quienes = [')));
    check('Quién ya no tiene Fan-out ni Propuestas', !quien.includes('fanout') && !quien.includes('propuestas') && quien.includes("['trabajo', 'Trabajo']"));
    check('el botón: aria-expanded, aria-controls y su cuenta', barra.includes("aria-expanded=${String(abierto)} aria-controls=${telefono ? 'hoja-filtros' : 'filtros-panel'}") && barra.includes('<span class="filtros-n">${escondidos.length}</span>'));
    check('el panel se cierra con Esc (devuelve el foco) y con un clic afuera', barra.includes("if (ev.key === 'Escape') { ev.stopPropagation(); setAbierto(false); boton.current?.focus(); }") && barra.includes("addEventListener('pointerdown', fuera, true)"));
    check('Mostrar y Origen como radios nativos en un radiogroup', barra.includes('role="radiogroup"') && barra.includes('<input type="radio"') && barra.includes('nombre="filtro-mostrar"') && barra.includes('nombre="filtro-origen"'));
    check('Solo de hoy y Solo archivadas como interruptores, con sus ids', barra.includes('role="switch"') && barra.includes('id="filtro-hoy" rotulo="Solo de hoy"') && barra.includes('id="filtro-archivadas" rotulo="Solo archivadas"'));
    check('pastillas con «×» etiquetado', barra.includes('aria-label=${`Quitar filtro: ${p.texto}`}'));
    check('el aviso de lotes ocultos, en la barra y en el panel', barra.includes('class="filtros-ocultos"') && barra.includes('class="filtros-aviso"'));
    check('limpiar todo conserva agrupar y vuelve Mostrar a «todo»', barra.includes("mostrar.value = 'todo';\n  filtro.value = { ...FILTRO_VACIO, agrupar: f.agrupar };"));
    const todo = barra + vista + reglasTxt;
    check('renombres: «Todos los orígenes» y «Solo archivadas»; ya no «Web y Telegram» ni «Ver archivadas»', reglasTxt.includes("'': 'Todos los orígenes'") && barra.includes('rotulo="Solo archivadas"')
      && !todo.includes('Web y Telegram') && !todo.includes('Ver archivadas'));
  });

  await group('Columnas y CSS', () => {
    const titulo = vista.slice(vista.indexOf('<div class="columna-titulo">'), vista.indexOf('${avisoDestino ?'));
    check('«Agrupar por quién» en el encabezado de Trabajando', titulo.includes("${c.id === 'curso' ? html`<span class=\"columna-accion\"><button type=\"button\" class=\"accion secundaria\" id=\"filtro-agrupar\" aria-pressed=${String(f.agrupar)}")
      && !barra.includes('filtro-agrupar'));
    check('vacío con contexto cuando hay filtros (también en Por hacer)', vista.includes('${!aviso && !xs.length && conFiltros ? html`<div class="vacio">Ninguna coincide con los filtros · <button type="button" class="accion" onClick=${() => limpiarFiltros(programarBusqueda)}>limpiar</button></div>`'));
    check('el panel flota bajo el botón', /\.filtros-panel \{ position: absolute; top: calc\(100% \+ 6px\); left: 0;/.test(css));
    // FEAT-160 F5b — En el teléfono el panel es una hoja (test/feat-160-f5b-hojas.test.js).
    check('en el teléfono el panel flotante no se dibuja', barra.includes('${abierto && !telefono ? html`<${PanelFiltros}'));
    check('sin :has', !css.includes(':has('));
  });

  report();
})();
