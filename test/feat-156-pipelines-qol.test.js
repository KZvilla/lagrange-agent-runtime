/**
 * FEAT-156 — Pipelines QoL: borrar, duplicar y renombrar recetas (con las incorporadas protegidas), las plantillas
 * genéricas (válidas, listadas y con presupuesto para que «corregir» de un humano llegue al Escribir), las rutas y sus
 * niveles, la paleta de nodos (grupos, búsqueda y filtro por puerto) y los nombres de la opción A en la consola.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert.js');
const R = require('../mcp-server/lotes/recetas.js');
const G = require('../mcp-server/lotes/grafo-receta.js');
const { PLANTILLAS } = require('../mcp-server/lotes/plantillas.js');
const { revisarLote } = require('../mcp-server/lotes/pipeline-revision.js');
const { crearRegistro, ESPERANDO_HUMANO } = require('../mcp-server/lotes/registro.js');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'f156-'));
const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const fuente = (f) => fs.readFileSync(path.join(UI, f), 'utf8');

group('recetas: borrar, duplicar, renombrar', () => {
  const dirDatos = path.join(raiz, 'datos');
  const a = R.crearAlmacenRecetas(dirDatos);
  const ids = a.listar().map((r) => r.id);
  check('lista: la Clásica primero y las 6 plantillas, todas incorporadas', ids[0] === 'clasica' && PLANTILLAS.every((p) => ids.includes(p.id)) && a.listar().every((r) => r.incorporada));
  check('las plantillas traen su descripción en el listado (no en la receta)', a.listar().find((r) => r.id === 'tdd-base').descripcion && !('descripcion' in a.leer('tdd-base')));
  check('una plantilla leída valida como receta', (() => { try { R.validarReceta(a.leer('mejor-de-dos')); return true; } catch { return false; } })());
  const dup = a.duplicar('ciclo-rapido', { id: 'mi-ciclo' });
  check('duplicar una plantilla crea una propia v1 con su grafo', dup.id === 'mi-ciclo' && dup.version === 1 && dup.titulo === 'Ciclo rápido (copia)' && dup.grafo.nodos.esc);
  const ren = a.renombrar('mi-ciclo', 'Mi ciclo');
  check('renombrar es una versión nueva con el mismo contenido', ren.version === 2 && ren.titulo === 'Mi ciclo' && JSON.stringify(ren.grafo) === JSON.stringify(dup.grafo));
  const falla = (f) => { try { f(); return null; } catch (err) { return err.message; } };
  check('no se borra una incorporada', /incorporada/.test(falla(() => a.borrar('clasica'))) && /incorporada/.test(falla(() => a.borrar('tdd-base'))));
  check('un id con ../ no llega al disco', /inválido/.test(falla(() => a.borrar('../datos'))) && fs.existsSync(dirDatos));
  check('no se versiona ni se renombra una incorporada', /no admite versiones/.test(falla(() => a.nuevaVersion('plan-b', { grafo: dup.grafo }))) && /no se renombra/.test(falla(() => a.renombrar('plan-b', 'x'))));
  check('los ids de las plantillas están reservados', /reservado/.test(falla(() => a.crear({ id: 'mejor-de-dos', titulo: 'x' }))));
  const b = a.borrar('mi-ciclo');
  check('borrar se lleva todas las versiones y la carpeta', b.versiones === 2 && !fs.existsSync(path.join(dirDatos, 'recetas', 'mi-ciclo')) && !a.listar().some((r) => r.id === 'mi-ciclo'));
  check('borrar algo que no existe lo dice', /no existe/.test(falla(() => a.borrar('nada'))));
});

group('plantillas: válidas y dentro del presupuesto por defecto', () => {
  for (const p of PLANTILLAS) {
    const r = G.revisarGrafo(p.grafo);
    const errores = r.errores.filter((e) => e.severidad === 'error');
    check(`${p.id}: sin errores del validador`, !errores.length, errores.map((e) => e.texto).join('; '));
    check(`${p.id}: el peor caso entra en ${G.PRESUPUESTO.llamadas} llamadas`, r.peorCaso.llamadas <= G.PRESUPUESTO.llamadas, JSON.stringify(r.peorCaso));
    check(`${p.id}: no fija modelos (un modelo fijo puede chocar con el auditor del batch)`, Object.values(p.grafo.nodos).every((n) => !n.modelo && !n.motor));
  }
  check('Join con «primera» admite conflicto → Revisión (y otro modo no)', !G.revisarGrafo(PLANTILLAS.find((p) => p.id === 'mejor-de-dos').grafo).errores.some((e) => e.codigo === 'conflicto-sin-escribir')
    && G.revisarGrafo({ ...structuredClone(PLANTILLAS.find((p) => p.id === 'mejor-de-dos').grafo), nodos: { ...structuredClone(PLANTILLAS.find((p) => p.id === 'mejor-de-dos').grafo.nodos), juntar: { tipo: 'juntar', modo: 'todas' } } }).errores.some((e) => e.codigo === 'conflicto-sin-escribir'));
});

/** Un batch falso con una tarea y un registro real, para recorrer una plantilla. */
function armar(id, plantilla) {
  const registro = crearRegistro({ dir: path.join(raiz, `reg-${id}`) });
  const tareas = [{ id: 't_0', prompt: 'P', promptOriginal: 'P', archivos: ['a.js'], prueba: { argv: ['node', 'x'] }, modelo: 'gemini-3.8-flash' }];
  const receta = R.aplicarCambios({ id: plantilla.id, version: 1, titulo: plantilla.titulo, forma: G.FORMA_GRAFO, grafo: G.validarGrafo(plantilla.grafo) }, {});
  registro.crear({ id, repo: raiz, ramaBase: 'main', modelo: 'x', receta, tareas });
  return { registro, tareas, receta, resultados: [{ id: 't_0', exito: true, commit: 'c0', ruta: raiz, rama: 'wt/t_0' }] };
}
let commits = 0;
const escritor = (pedidos) => async (lista) => { pedidos.push(...lista); return lista.map((x) => ({ id: x.tarea.id, exito: true, commit: `n${++commits}` })); };

(async () => {
  await group('plantillas: «corregir» del humano llega al Escribir', async () => {
    const casos = [
      // id de plantilla, cómo falla para llegar al Humano.
      ['escalar-a-vos', { verificar: async () => ({ estado: 'fallo', exitCode: 1 }) }],
      ['tdd-base', { verificar: async () => ({ estado: 'paso', exitCode: 0 }) }],
      ['revision-advisor', { verificar: async () => ({ estado: 'paso', exitCode: 0 }), advisor: 'HUMAN' }]
    ];
    for (const [pid, { verificar, advisor }] of casos) {
      const p = PLANTILLAS.find((x) => x.id === pid);
      const r = armar(`h-${pid}`, p);
      const pedidos = [];
      const auditar = async (a) => (a.rol === 'advisor' ? { estado: 'completa', decision: advisor || 'APPROVE', indicaciones: 'x', reporte: '' } : { estado: 'completa', veredicto: 'PASS', reporte: '' });
      const base = { slug: `h-${pid}`, registro: r.registro, tareas: r.tareas, receta: r.receta, repo: raiz, verificar, auditar };
      const l1 = await revisarLote({ ...base, resultados: r.resultados, reescribir: escritor(pedidos) });
      check(`${pid}: llega al Humano`, l1.estado === ESPERANDO_HUMANO, `${l1.estado} ${JSON.stringify(l1.tareas[0].recorrido.slice(-2))}`);
      const antes = pedidos.length;
      r.registro.guardarRespuesta(`h-${pid}`, 't_0', { accion: 'corregir', texto: 'hacelo así' });
      r.registro.retomar(`h-${pid}`);
      await revisarLote({ ...base, reescribir: escritor(pedidos), reanudar: true });
      const nuevo = pedidos[antes];
      check(`${pid}: la corrección reescribe con las indicaciones del usuario`, nuevo && nuevo.fallo.motivo === 'humano' && nuevo.fallo.indicaciones === 'hacelo así', JSON.stringify(nuevo && nuevo.fallo));
    }
  });

  await group('paleta y nombres en la consola', async () => {
    const P = await import(pathToFileURL(path.join(UI, 'tuberias-paleta.js')).href);
    const UG = await import(pathToFileURL(path.join(UI, 'tuberias-grafo.js')).href);
    check('los grupos cubren todos los tipos agregables, una vez', JSON.stringify(P.GRUPOS.flatMap(([, it]) => it.map(([t]) => t)).sort()) === JSON.stringify([...UG.AGREGABLES].sort()));
    const huecos = [];
    for (const [tipo, puertos] of Object.entries(UG.PUERTOS)) for (const p of puertos) {
      const s = P.SIGUIENTES[tipo]?.[p];
      if (!s || !s.length || !s.every((t) => UG.AGREGABLES.includes(t))) huecos.push(`${tipo}.${p}`);
    }
    check('SIGUIENTES cubre todo puerto de todo tipo con tipos que existen', !huecos.length, huecos.join(', '));
    check('buscar «ju» deja Juez y Join', JSON.stringify(P.tiposVisibles({ busqueda: 'ju' })) === JSON.stringify(['juez', 'juntar']));
    check('el filtro por puerto deja solo lo que sigue (Juez·fail)', JSON.stringify(P.tiposVisibles({ filtro: P.SIGUIENTES.juez.fail })) === JSON.stringify(['escribir', 'juez', 'advisor', 'humano', 'revision'].filter((t) => P.SIGUIENTES.juez.fail.includes(t))));
    check('buscar sin acentos encuentra «Semáforo»→Fan-out por su nombre nuevo', JSON.stringify(P.tiposVisibles({ busqueda: 'fan' })) === JSON.stringify(['semaforo']));
    check('opción A: Semáforo y Juntar se leen Fan-out y Join', UG.TITULO.semaforo === 'Fan-out' && UG.TITULO.juntar === 'Join');
    const html = fs.readFileSync(path.join(UI, '..', 'index.html'), 'utf8');
    check('la navegación dice Pipelines y va a /pipelines', /href="\/pipelines" data-ruta data-vista="tuberias">Pipelines</.test(html) && /'\/pipelines', 'tuberias', 'Pipelines'/.test(fuente('lateral.js')));
    check('el editor tiene un solo «+ Nodo» y no los 8 botones', /\+ Nodo ▾/.test(fuente('tuberias-editor-grafo.js')) && !/G\.AGREGABLES\.map\(\(t\) => html`<button/.test(fuente('tuberias-editor-grafo.js')));
    check('el menú del lienzo abre la paleta en vez de 8 ítems', /Agregar nodo acá…/.test(fuente('tuberias-editor-grafo.js')) && !/`Agregar \$\{G\.TITULO\[t\]\} acá`/.test(fuente('tuberias-editor-grafo.js')));
    check('soltar un cable en el vacío llega a la consola', /alSoltarCable/.test(fuente('tuberias-editor-grafo.js')) && /onConnectEnd/.test(fs.readFileSync(path.join(UI, '..', '..', 'grafo', 'src', 'montar.tsx'), 'utf8')));
    // Auditoría de la implementación: cerrar antes de agregar borraba la posición y el puerto de origen.
    check('la paleta agrega antes de cerrar (el editor lee de dónde vino)', /const elegir = \(t\) => \{ alElegir\(t\); alCerrar\(\); \}/.test(fuente('tuberias-paleta.js')));
    check('desde «conflicto» de un Join en «primera», la paleta ofrece Vos', /n\.modo === 'primera' \? \[\.\.\.s, 'revision'\]/.test(fuente('tuberias-editor-grafo.js')));
    check('la barra lateral pliega y recuerda (aria-expanded + persistente)', /aria-expanded/.test(fuente('tuberias-lateral.js')) && /persistente\('tuberias\.plegadas'/.test(fuente('tuberias-lateral.js')));
    check('borrar una recipe es de dos pasos y dice qué pasa con los batches', /¿Seguro\? Borrar/.test(fuente('tuberias-receta-acciones.js')) && /no cambian/.test(fuente('tuberias-receta-acciones.js')));
    const largos = ['tuberias-lateral.js', 'tuberias-receta-acciones.js', 'tuberias-paleta.js', 'tuberias-editor-grafo.js', 'vista-tuberias.js', 'tuberias-borrador.js']
      .map((f) => [f, fuente(f).split('\n').length]);
    check('ui/ sigue en 210 líneas o menos', largos.every(([, n]) => n <= 210), JSON.stringify(largos));
  });

  fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 5 });
  report();
})();
