/**
 * FEAT-149 F4a — Receta como grafo: validador, caminante por fases, topes, desvíos al agotar,
 * presupuesto, transiciones nuevas del registro y la puerta de integración por commit.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert.js');
const R = require('../mcp-server/lotes/recetas.js');
const G = require('../mcp-server/lotes/grafo-receta.js');
const { revisarLote } = require('../mcp-server/lotes/pipeline-revision.js');
const { crearRegistro } = require('../mcp-server/lotes/registro.js');
const { evaluarIntegrable } = require('../mcp-server/lotes/integrar.js');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'f149-f4a-'));
const rechaza = (fn, re) => { try { fn(); return false; } catch (err) { return re ? re.test(err.message) : true; } };
const codigos = (g) => G.revisarGrafo(g).errores.filter((e) => e.severidad === 'error').map((e) => e.codigo);
const copia = (x) => JSON.parse(JSON.stringify(x));

/**
 * J1: Escribir → Verificar → Juez → Vos. La prueba roja vuelve a Escribir hasta 2 veces y,
 * agotado, va a un plan B (otro Escribir) con su propio Verificar.
 */
function grafoJ1(extra = {}) {
  return {
    nodos: {
      entrada: { tipo: 'entrada' },
      esc: { tipo: 'escribir', vueltas: 3 },
      ver: { tipo: 'verificar' },
      juez: { tipo: 'juez' },
      planb: { tipo: 'escribir', titulo: 'Plan B', modelo: 'gemini-3.1-pro' },
      verb: { tipo: 'verificar' },
      vos: { tipo: 'revision' }
    },
    aristas: [
      { id: 'e-in', desde: 'entrada', puerto: 'sale', hacia: 'esc' },
      { id: 'esc-ok', desde: 'esc', puerto: 'ok', hacia: 'ver' },
      { id: 'esc-sc', desde: 'esc', puerto: 'sin-cambios', hacia: 'juez' },
      { id: 'esc-err', desde: 'esc', puerto: 'error', hacia: 'vos' },
      { id: 'ver-pasa', desde: 'ver', puerto: 'pasa', hacia: 'juez' },
      { id: 'ver-falla', desde: 'ver', puerto: 'falla', hacia: 'esc', tope: 2, alAgotar: 'planb' },
      { id: 'ver-err', desde: 'ver', puerto: 'error', hacia: 'juez' },
      { id: 'pb-ok', desde: 'planb', puerto: 'ok', hacia: 'verb' },
      { id: 'pb-sc', desde: 'planb', puerto: 'sin-cambios', hacia: 'juez' },
      { id: 'pb-err', desde: 'planb', puerto: 'error', hacia: 'vos' },
      { id: 'verb-pasa', desde: 'verb', puerto: 'pasa', hacia: 'juez' },
      { id: 'verb-falla', desde: 'verb', puerto: 'falla', hacia: 'juez' },
      { id: 'verb-err', desde: 'verb', puerto: 'error', hacia: 'juez' },
      { id: 'j-pass', desde: 'juez', puerto: 'pass', hacia: 'vos' },
      { id: 'j-fail', desde: 'juez', puerto: 'fail', hacia: 'vos' },
      { id: 'j-err', desde: 'juez', puerto: 'error', hacia: 'vos' }
    ],
    ...extra
  };
}
const recetaGrafo = (g) => R.aplicarCambios({ id: 'j1', version: 1, titulo: 'J1', forma: G.FORMA_GRAFO, grafo: G.validarGrafo(g) }, {});

group('validador', () => {
  check('J1 es válido', codigos(grafoJ1()).length === 0, JSON.stringify(G.revisarGrafo(grafoJ1()).errores));
  check('la clásica compilada es válida, con y sin bucle', codigos(G.compilarClasica(R.CLASICA.nodos)).length === 0
    && codigos(G.compilarClasica({ escribir: { vueltas: 2 }, verificar: { siFalla: 'reescribir' }, auditar: { siFail: 'reescribir' } })).length === 0);
  const suelto = grafoJ1(); suelto.aristas = suelto.aristas.filter((a) => a.id !== 'j-err');
  check('un puerto sin arista es error y apunta al nodo', codigos(suelto).includes('puerto-suelto')
    && G.revisarGrafo(suelto).errores.find((e) => e.codigo === 'puerto-suelto').ir.nodo === 'juez');
  const doble = grafoJ1(); doble.aristas.push({ id: 'j-err2', desde: 'juez', puerto: 'error', hacia: 'vos' });
  check('dos aristas del mismo puerto es error', codigos(doble).includes('puerto-doble'));
  const ciclo = grafoJ1(); ciclo.aristas.find((a) => a.id === 'j-fail').hacia = 'ver';
  check('un bucle sin tope (Juez → Verificar) es error', codigos(ciclo).includes('ciclo-sin-tope'));
  const conTope = grafoJ1(); Object.assign(conTope.aristas.find((a) => a.id === 'j-fail'), { hacia: 'ver', tope: 1, alAgotar: 'vos' });
  check('con tope y desvío, el mismo bucle vale', codigos(conTope).length === 0, codigos(conTope).join());
  const sinDesvio = grafoJ1(); delete sinDesvio.aristas.find((a) => a.id === 'ver-falla').alAgotar;
  check('una arista agotable en un bucle sin «al agotar» es error', codigos(sinDesvio).includes('sin-al-agotar'));
  const desvioSuelto = grafoJ1(); desvioSuelto.aristas.find((a) => a.id === 'j-pass').alAgotar = 'vos';
  check('«al agotar» en una arista que no se agota es error', codigos(desvioSuelto).includes('al-agotar-sin-tope'));
  const saltaJuez = grafoJ1(); saltaJuez.aristas.find((a) => a.id === 'ver-pasa').hacia = 'vos';
  check('Verificar → Vos por «pasa» se salta el Juez', codigos(saltaJuez).includes('salta-juez'));
  const saltaVer = grafoJ1(); saltaVer.aristas.find((a) => a.id === 'pb-ok').hacia = 'juez';
  check('plan B → Juez por «ok» se salta Verificar', codigos(saltaVer).includes('salta-verificar'));
  check('los caminos de falla a Vos no son saltos (la puerta los rechaza igual)', !codigos(grafoJ1()).includes('salta-juez'));
  const muchos = grafoJ1(); for (let i = 0; i < 12; i++) muchos.nodos[`n${i}`] = { tipo: 'revision' };
  check('más de 16 nodos es error', codigos(muchos).includes('demasiados-nodos'));
  check('dos Entradas o ninguna Revisión es error', codigos({ ...grafoJ1(), nodos: { ...grafoJ1().nodos, otra: { tipo: 'entrada' } } }).includes('entrada')
    && codigos({ nodos: { entrada: { tipo: 'entrada' } }, aristas: [] }).includes('revision'));
  const iguales = grafoJ1(); iguales.nodos.juez.modelo = 'gemini-3.1-pro';
  const aviso = G.revisarGrafo(iguales).errores.find((e) => e.codigo === 'revisores-iguales');
  check('un Juez con el modelo de un escritor es aviso…', aviso && aviso.severidad === 'aviso');
  iguales.reglas = { revisoresDistintos: true };
  check('…y error con la regla revisoresDistintos', codigos(iguales).includes('revisores-iguales'));
  check('el presupuesto tiene techos', codigos(grafoJ1({ presupuesto: { llamadas: 99 } })).includes('presupuesto')
    && G.validarGrafo(grafoJ1()).presupuesto.llamadas === G.PRESUPUESTO.llamadas);
  check('un campo desconocido en un nodo se rechaza', codigos({ ...grafoJ1(), nodos: { ...grafoJ1().nodos, ver: { tipo: 'verificar', siFalla: 'x' } } }).includes('config'));
  check('el aviso de costo da el peor caso', /Peor caso/.test(G.revisarGrafo(grafoJ1()).errores.find((e) => e.codigo === 'costo').texto));
});

group('recetas grafo-v1', () => {
  const dir = path.join(raiz, 'datos');
  const almacen = R.crearAlmacenRecetas(dir);
  const creada = almacen.crear({ id: 'j1', titulo: 'J1', grafo: grafoJ1(), disposicion: { esc: [10, 20], planb: [30, 40] } });
  check('se guarda como grafo-v1, con disposición por id de nodo', creada.forma === 'grafo-v1' && creada.disposicion.planb[0] === 30);
  check('se lee igual y aparece en la lista con su forma', almacen.leer('j1').grafo.aristas.length === 16 && almacen.listar().find((r) => r.id === 'j1').forma === 'grafo-v1');
  check('una disposición con un nodo que no está se rechaza', rechaza(() => almacen.crear({ id: 'j2', titulo: 'J2', grafo: grafoJ1(), disposicion: { fantasma: [0, 0] } })));
  almacen.crear({ id: 'vieja', titulo: 'Vieja', nodos: R.CLASICA.nodos });
  const convertida = almacen.nuevaVersion('vieja', { grafo: G.compilarClasica(R.CLASICA.nodos) });
  check('convertir: la versión 2 es grafo y la 1 sigue clásica', convertida.forma === 'grafo-v1' && almacen.leer('vieja', 1).forma === R.FORMA);
  const ef = recetaGrafo(grafoJ1());
  check('la receta efectiva trae el grafo y la vista clásica', ef.grafo.nodos.planb.modelo === 'gemini-3.1-pro' && Array.isArray(ef.nodos.verificar.comandos));
  check('un lote cambia configuración de un nodo…', R.aplicarCambios({ ...ef, grafo: ef.grafo }, { 'juez.criterio': 'más estricto' }).grafo.nodos.juez.criterio === 'más estricto');
  check('…pero no topes, vueltas ni topología', rechaza(() => R.aplicarCambios(ef, { 'esc.vueltas': 3 })) && rechaza(() => R.aplicarCambios(ef, { 'ver-falla.tope': 5 }))
    && rechaza(() => R.aplicarCambios(ef, { 'vos.titulo': 'x' })));
});

/** Un lote falso con sus tareas y un registro real. */
function armar(id, n = 1) {
  const registro = crearRegistro({ dir: path.join(raiz, `reg-${id}`) });
  const tareas = Array.from({ length: n }, (_, i) => ({ id: `t_${i}`, prompt: `P${i}`, promptOriginal: `P${i}`, archivos: [`f${i}.js`], prueba: { argv: ['node', 'x'] }, modelo: 'gemini-3.8-flash' }));
  registro.crear({ id, repo: raiz, ramaBase: 'main', modelo: 'x', tareas });
  const resultados = tareas.map((t, i) => ({ id: t.id, exito: true, commit: `c${i}0000000`, ruta: path.join(raiz, t.id), rama: `wt/${t.id}` }));
  return { registro, tareas, resultados };
}
let commits = 0;
const reescribirOk = (pedidos) => async (lista) => { pedidos.push(...lista); return lista.map((x) => ({ id: x.tarea.id, exito: true, commit: `n${++commits}000000` })); };
const auditarPass = async ({ commit }) => ({ estado: 'completa', veredicto: 'PASS', reporte: `PASS ${commit}` });

(async () => {
  await group('caminante: tope 2 y desvío al plan B', async () => {
    const { registro, tareas, resultados } = armar('j1');
    const pruebas = ['fallo', 'fallo', 'fallo', 'paso'];
    const pedidos = [];
    const auditados = [];
    const lote = await revisarLote({ slug: 'j1', tareas, resultados, registro, receta: recetaGrafo(grafoJ1()), repo: raiz,
      verificar: async () => ({ estado: pruebas.shift() }),
      auditar: async (a) => { auditados.push(a); return auditarPass(a); },
      reescribir: reescribirOk(pedidos) });
    const t = lote.tareas[0];
    check('dos vueltas a Escribir y la tercera al plan B', pedidos.length === 3 && !pedidos[0].nodo && !pedidos[1].nodo && pedidos[2].nodo && pedidos[2].nodo.id === 'planb', JSON.stringify(pedidos.map((p) => p.nodo)));
    check('el desvío queda en el recorrido como agotada', t.recorrido.some((x) => x.arista === 'ver-falla' && x.agotada && x.hacia === 'planb'));
    check('el contador de la arista llega al tope', t.contadores['ver-falla'] === 2);
    check('el Juez juzga al plan B contra su modelo y una sola vez', auditados.length === 1 && auditados[0].modeloEscritor === 'gemini-3.1-pro');
    check('la prueba y la auditoría dicen de qué commit son', t.prueba.commit === t.commit && t.auditoria.commit === t.commit);
    check('termina para revisar e integrable', lote.estado === 'para revisar' && t.fin === 'revision' && evaluarIntegrable(lote).ok, JSON.stringify(evaluarIntegrable(lote).motivos));
  });

  await group('un error de infraestructura no consume el tope', async () => {
    const { registro, tareas, resultados } = armar('j2');
    const pedidos = [];
    const lote = await revisarLote({ slug: 'j2', tareas, resultados, registro, receta: recetaGrafo(grafoJ1()), repo: raiz,
      verificar: async () => ({ estado: 'error', error: 'docker' }), auditar: auditarPass, reescribir: reescribirOk(pedidos) });
    const t = lote.tareas[0];
    check('va por su puerto, sin vuelta ni contador', pedidos.length === 0 && !t.contadores['ver-falla'] && t.recorrido.some((x) => x.puerto === 'error'));
    check('y el lote queda fallido', lote.estado === 'fallido');
  });

  await group('presupuesto de llamadas', async () => {
    const { registro, tareas, resultados } = armar('j3');
    const pedidos = [];
    const lote = await revisarLote({ slug: 'j3', tareas, resultados, registro, receta: recetaGrafo(grafoJ1({ presupuesto: { llamadas: 2 } })), repo: raiz,
      verificar: async () => ({ estado: 'fallo' }), auditar: auditarPass, reescribir: reescribirOk(pedidos) });
    const t = lote.tareas[0];
    check('corta cuando la próxima llamada lo pasaría', pedidos.length === 1 && t.fin === 'presupuesto agotado (llamadas)', `${pedidos.length} ${t.fin}`);
    check('va a revisión y no es integrable', lote.estado === 'para revisar' && !evaluarIntegrable(lote).ok);
  });

  await group('fases: dos tareas en nodos distintos', async () => {
    const { registro, tareas, resultados } = armar('j4', 2);
    const porTarea = { t_0: ['paso'], t_1: ['fallo', 'paso'] };
    const lote = await revisarLote({ slug: 'j4', tareas, resultados, registro, receta: recetaGrafo(grafoJ1()), repo: raiz, concurrencia: 2,
      verificar: async ({ taskId }) => ({ estado: porTarea[taskId].shift() }), auditar: auditarPass, reescribir: reescribirOk([]) });
    const hist = lote.historial.map((h) => h.estado).join(',');
    check('el lote pasa verificando → auditando → corriendo y vuelve', hist === 'corriendo,verificando,auditando,corriendo,verificando,auditando,para revisar', hist);
    check('las dos terminan integrables', evaluarIntegrable(lote).ok);
  });

  await group('transiciones nuevas: cerrar desde Verificar y volver del Juez a Verificar', async () => {
    const cierra = grafoJ1(); cierra.aristas.find((a) => a.id === 'ver-falla').hacia = 'vos';
    delete cierra.aristas.find((a) => a.id === 'ver-falla').tope; delete cierra.aristas.find((a) => a.id === 'ver-falla').alAgotar;
    const a = armar('j5');
    const l1 = await revisarLote({ slug: 'j5', ...a, receta: recetaGrafo(cierra), repo: raiz, verificar: async () => ({ estado: 'fallo' }), auditar: auditarPass, reescribir: reescribirOk([]) });
    check('verificando → para revisar no hace tirar al registro', l1.estado === 'para revisar' && l1.historial.at(-2).estado === 'verificando');
    const vuelve = grafoJ1(); Object.assign(vuelve.aristas.find((x) => x.id === 'j-fail'), { hacia: 'ver', tope: 1, alAgotar: 'vos' });
    const b = armar('j6');
    let auditorias = 0;
    let verificaciones = 0;
    const l2 = await revisarLote({ slug: 'j6', ...b, receta: recetaGrafo(vuelve), repo: raiz,
      verificar: async () => { verificaciones++; return { estado: 'paso' }; },
      auditar: async () => { auditorias++; return { estado: 'completa', veredicto: 'FAIL', reporte: 'FAIL' }; }, reescribir: reescribirOk([]) });
    const hist = l2.historial.map((h) => h.estado).join(',');
    check('auditando → verificando no hace tirar al registro', hist.includes('auditando,verificando'), hist);
    check('el mismo commit no se vuelve a verificar ni a juzgar', verificaciones === 1 && auditorias === 1);
    check('agotado el tope, sigue el desvío', l2.tareas[0].recorrido.at(-1).agotada === true && l2.estado === 'para revisar');
  });

  group('puerta de integración por commit', () => {
    const tarea = (extra) => ({ id: 't', commit: 'c2', prueba: { estado: 'paso', commit: 'c2' }, auditoria: { estado: 'completa', veredicto: 'PASS', commit: 'c2' }, ...extra });
    const lote = (t, receta) => ({ estado: 'para revisar', tareas: [t], ...(receta ? { receta } : {}) });
    check('veredictos del último commit: integrable', evaluarIntegrable(lote(tarea())).ok);
    check('una auditoría de otro commit no se integra', !evaluarIntegrable(lote(tarea({ auditoria: { estado: 'completa', veredicto: 'PASS', commit: 'c1' } }))).ok);
    check('una prueba de otro commit no se integra', !evaluarIntegrable(lote(tarea({ prueba: { estado: 'paso', commit: 'c1' } }))).ok);
    const vieja = { id: 't', commit: 'c2', prueba: { estado: 'paso' }, auditoria: { estado: 'completa', veredicto: 'PASS' } };
    check('un lote viejo sin el dato sigue integrable', evaluarIntegrable(lote(vieja)).ok);
    check('pero un lote de grafo sin el dato no', !evaluarIntegrable(lote(copia(vieja), { forma: 'grafo-v1' })).ok);
  });

  await group('proyección y problemas para la consola', async () => {
    const { proyectarTuberia } = require('../mcp-server/lotes/receta-lote.js');
    const { registro, tareas, resultados } = armar('j7');
    const lote = await revisarLote({ slug: 'j7', tareas, resultados, registro, receta: recetaGrafo(grafoJ1()), repo: raiz,
      verificar: async () => ({ estado: 'paso' }), auditar: auditarPass, reescribir: reescribirOk([]) });
    registro.leer('j7');
    const p = proyectarTuberia({ ...lote, receta: recetaGrafo(grafoJ1()) });
    check('la configuración trae el grafo y su forma', p.configuracion.forma === 'grafo-v1' && p.configuracion.grafo.nodos.planb.tipo === 'escribir');
    check('cada tarea trae su recorrido y cómo terminó', p.tareas[0].recorrido.map((x) => x.nodo).join() === 'esc,ver,juez' && p.tareas[0].fin === 'revision');
    check('el estado vivo marca lo recorrido y lo que no', p.vivo.nodos.esc === 'ok' && p.vivo.nodos.vos === 'esperando' && p.vivo.nodos.planb === 'omitida'
      && p.vivo.aristas['ver-pasa'] === 1 && p.vivo.tareas.t_0.nodos.juez === 'ok', JSON.stringify(p.vivo.nodos));
    const recien = proyectarTuberia({ id: 'x', estado: 'corriendo', creado: new Date().toISOString(), historial: [], receta: recetaGrafo(grafoJ1()),
      tareas: [{ id: 't_0', estado: 'corriendo', prueba: { estado: 'pendiente' }, auditoria: { estado: 'pendiente' } }] });
    check('antes del caminante, el primer Escribir se ve en curso', recien.vivo.nodos.esc === 'corriendo' && recien.vivo.nodos.entrada === 'ok' && recien.vivo.nodos.juez === 'pendiente', JSON.stringify(recien.vivo.nodos));
    const sinDato = proyectarTuberia({ ...lote, receta: { forma: 'grafo-v1', grafo: { nodos: {} } } });
    check('un grafo roto en el registro no se dibuja (y no rompe)', !sinDato.configuracion.grafo);
    const problemas = R.problemasDeGrafo(grafoJ1(), { fantasma: [0, 0] }, { lint: { argv: ['x'] } });
    check('problemas: la disposición con un nodo que no está es error', problemas.some((x) => x.codigo === 'disposicion'));
    const conComando = grafoJ1(); conComando.nodos.verb.comandos = ['tests'];
    const delRepo = R.problemasDeGrafo(conComando, null, { lint: { argv: ['x'] } });
    check('problemas: un comando no declarado apunta a su Verificar', delRepo.some((x) => x.codigo === 'comando-no-declarado' && x.ir.nodo === 'verb'));
  });

  group('armado del lote con un grafo', () => {
    const { crearServicioLotes } = require('../mcp-server/lotes/servicio.js');
    const dirDatos = path.join(raiz, 'datos-servicio');
    const almacen = R.crearAlmacenRecetas(dirDatos);
    almacen.crear({ id: 'j1', titulo: 'J1', grafo: grafoJ1() });
    const conJuez = grafoJ1(); conJuez.nodos.juez2 = { tipo: 'juez', modelo: 'gemini-3.8-flash' };
    conJuez.aristas.find((a) => a.id === 'verb-pasa').hacia = 'juez2';
    conJuez.aristas.push({ id: 'j2-pass', desde: 'juez2', puerto: 'pass', hacia: 'vos' }, { id: 'j2-fail', desde: 'juez2', puerto: 'fail', hacia: 'vos' }, { id: 'j2-err', desde: 'juez2', puerto: 'error', hacia: 'vos' });
    almacen.crear({ id: 'juez-flash', titulo: 'Juez flash', grafo: conJuez });
    const servicio = crearServicioLotes({ registro: crearRegistro({ dir: path.join(dirDatos, 'lotes') }), docker: async () => ({ code: 0, stdout: '', stderr: '' }), aWsl: async (x) => x, dirDatos,
      config: { fanoutStatusline: false, fanoutControl: false, fanoutProgressLog: false }, recolectar: async () => {}, leerCuerpoSkill: (n) => `cuerpo de ${n}`,
      fanout: async () => ({ lanzado: false }), ejecutarStream: async () => {}, ejecutarStdin: async () => {} });
    const base = { slug: 'f4a-s', cwd: raiz, modelo: 'gemini-3.8-flash', tareas: [{ id: 't_a', prompt: 'Cambiar A', archivos: ['a.js'] }] };
    const motivo = (fn) => { try { fn(); return ''; } catch (err) { return err.message; } };
    const s = servicio.validarSolicitud({ ...base, receta: 'j1' });
    check('el plan B con modelo propio queda validado para el reescritor', s.escritores.planb && s.escritores.planb.modelo === 'gemini-3.1-pro' && s.receta.forma === 'grafo-v1');
    const conEsfuerzo = servicio.validarSolicitud({ ...base, receta: 'j1', effort: 'medium' });
    check('el esfuerzo del lote que el plan B no admite no lo rechaza: va el suyo', conEsfuerzo.escritores.planb.effort && conEsfuerzo.escritores.planb.effort !== 'medium', JSON.stringify(conEsfuerzo.escritores));
    check('un auditor con el modelo del plan B se rechaza', /distinto del escritor/.test(motivo(() => servicio.validarSolicitud({ ...base, receta: 'j1', modelo_auditor: 'gemini-3.1-pro' }))));
    check('un Juez con modelo propio igual al de un escritor se rechaza', /distinto del escritor/.test(motivo(() => servicio.validarSolicitud({ ...base, receta: 'juez-flash' }))));
  });

  await group('consola: operaciones sobre el grafo (ui/tuberias-grafo.js)', async () => {
    const { pathToFileURL } = require('node:url');
    const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
    const U = await import(pathToFileURL(path.join(UI, 'tuberias-grafo.js')).href);
    const conBucle = { escribir: { vueltas: 2 }, verificar: { siFalla: 'reescribir', comandos: ['lint'] }, auditar: { siFail: 'reescribir', modelo: 'gemini-3.1-pro' } };
    for (const nodos of [R.CLASICA.nodos, conBucle]) {
      check('convertir a grafo da lo mismo que el servidor', JSON.stringify(G.validarGrafo(U.deClasica(nodos))) === JSON.stringify(G.validarGrafo(G.compilarClasica(nodos))));
    }
    const base = U.deClasica(R.CLASICA.nodos);
    const { grafo: conPlanB, id } = U.agregarNodo(base, 'escribir');
    check('agregar da un id libre', id === 'escribir-2' && conPlanB.nodos[id].tipo === 'escribir' && !base.nodos[id]);
    const conectado = U.conectar(conPlanB, 'verificar', 'falla', id);
    check('conectar un puerto ocupado reemplaza su arista (va una sola)', conectado.aristas.filter((a) => a.desde === 'verificar' && a.puerto === 'falla').length === 1
      && conectado.aristas.find((a) => a.desde === 'verificar' && a.puerto === 'falla').hacia === id);
    check('no se conecta a la Entrada ni a sí mismo', U.conectar(base, 'verificar', 'falla', 'entrada') === base && U.conectar(base, 'verificar', 'falla', 'verificar') === base);
    const conDesvio = U.ponerAlAgotar(U.ponerTope(base, 'verificar-falla', 2), 'verificar-falla', 'revision');
    const sinVos = U.quitarNodo(conDesvio, 'revision');
    check('quitar un nodo quita sus aristas y los desvíos que llevaban a él', !sinVos.nodos.revision && !sinVos.aristas.some((a) => a.hacia === 'revision' || a.alAgotar === 'revision'));
    check('la Entrada no se quita', U.quitarNodo(base, 'entrada') === base);
    check('quitar el cable «al agotar» quita solo el desvío', !U.quitarArista(conDesvio, 'verificar-falla~agotar').aristas.find((a) => a.id === 'verificar-falla').alAgotar);
    const insertado = U.insertarEnArista(base, 'escribir-ok', 'verificar');
    check('insertar en una arista deja el grafo válido', insertado.id && codigos(insertado.grafo).length === 0, codigos(insertado.grafo).join());
    const filas = U.predicados(conDesvio, conDesvio.aristas.find((a) => a.id === 'verificar-falla'));
    check('el inspector muestra los dos predicados de una arista con tope', filas.length === 2 && /menos de 2 veces/.test(filas[0].si) && /ya se agotó/.test(filas[1].si) && filas[1].va === 'Vos');
    check('las notas de un nodo salen de su configuración', U.notasDeGrafo(U.deClasica(conBucle)).verificar.some((n) => n.texto === 'lint'));
    // Cada módulo de la consola compila como módulo ES (una redeclaración rompía la vista entera en el navegador).
    const { spawnSync } = require('node:child_process');
    const rotos = fs.readdirSync(UI).filter((f) => f.endsWith('.js')).filter((f) => spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(path.join(UI, f)), encoding: 'utf8' }).status !== 0);
    check('los módulos de ui/ compilan como módulos ES', rotos.length === 0, rotos.join());
    const H = await import(pathToFileURL(path.join(UI, 'tuberias-historial.js')).href).catch(() => null);
    if (H) {
      const h = H.crearHistorial(2);
      h.antes({ n: 1 }); h.antes({ n: 2 }); h.antes({ n: 3 });
      const d1 = h.deshacer({ n: 4 });
      check('deshacer vuelve al estado anterior y el tope de la pila se respeta', d1.n === 3 && h.deshacer(d1).n === 2 && h.deshacer({ n: 2 }) === null);
      check('rehacer vuelve hacia adelante', h.rehacer({ n: 2 }).n === 3);
    }
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  report();
})();
