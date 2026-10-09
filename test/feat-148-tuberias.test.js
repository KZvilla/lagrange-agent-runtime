/**
 * FEAT-148 F1 — Receta del lote, proyección de su tubería y el componente de la consola.
 * La paridad receta ↔ revisarLote vive en lotes-pipeline.test.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { RECETA_LOTE, ETAPA_DE_ESTADO, proyectarTuberia, resumenTuberia } = require('../mcp-server/lotes/receta-lote.js');
const { ESTADOS } = require('../mcp-server/lotes/registro.js');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const fuente = (f) => fs.readFileSync(path.join(UI, f), 'utf8').replace(/\r\n/g, '\n');

const CREADO = '2026-10-09T10:00:00.000Z';
const prueba = (estado, extra = {}) => ({ estado, argv: null, exitCode: null, duracionMs: null, salida: '', salidaTruncada: false, ...extra });
const auditoria = (estado, extra = {}) => ({ estado, veredicto: null, modelo: null, conversation_id: null, reporte: '', error: null, duracionMs: null, ...extra });

function tarea(id, cambios = {}) {
  return { id, rama: null, worktree: null, estado: 'corriendo', commit: null, anomalias: [], error: null, conversation_id: null,
    modelo: 'gemini-3.8-flash', skill: null, sinCambios: false, prueba: prueba('pendiente'), auditoria: auditoria('pendiente'), ...cambios };
}

function lote(estado, tareas, historial = [{ estado: 'corriendo', cuando: CREADO }], extra = {}) {
  return { id: 'l1', estado, creado: CREADO, modelo: 'gemini-3.8-flash', tareas, historial, ...extra };
}

const escrita = (id, extra = {}) => tarea(id, { estado: 'para revisar', commit: 'abc1234', prueba: prueba('paso', { duracionMs: 1500 }),
  auditoria: auditoria('completa', { veredicto: 'PASS', modelo: 'gemini-3.1-pro', duracionMs: 90000 }), ...extra });

const etapa = (p, i, id) => p.tareas[i].etapas[id].estado;

async function main() {
  await group('receta del lote', () => {
    check('la receta es la lista escribir → verificar → auditar → revision', RECETA_LOTE.etapas.map((e) => e.id).join(',') === 'escribir,verificar,auditar,revision');
    check('la revisión es humana con salidas integrar y descartar', RECETA_LOTE.etapas[3].tipo === 'humano' && RECETA_LOTE.etapas[3].salidas.join(',') === 'integrar,descartar');
    check('la receta está congelada', Object.isFrozen(RECETA_LOTE) && Object.isFrozen(RECETA_LOTE.etapas) && Object.isFrozen(RECETA_LOTE.etapas[0]));
    check('ETAPA_DE_ESTADO solo nombra estados reales del registro', Object.keys(ETAPA_DE_ESTADO).every((e) => ESTADOS.includes(e)));
    check('ETAPA_DE_ESTADO solo apunta a etapas de la receta', Object.values(ETAPA_DE_ESTADO).every((id) => RECETA_LOTE.etapas.some((e) => e.id === id)));
    check('sin lote no hay tubería', proyectarTuberia(null) === null);
  });

  await group('estados activos del lote', () => {
    const corriendo = proyectarTuberia(lote('corriendo', [tarea('t1'), tarea('t2', { estado: 'escrita', commit: 'c2', prueba: prueba('pendiente'), auditoria: auditoria('pendiente') })]));
    check('corriendo: la tarea que escribe está en curso', etapa(corriendo, 0, 'escribir') === 'corriendo');
    check('corriendo: la que terminó de escribir queda ok y el resto pendiente',
      etapa(corriendo, 1, 'escribir') === 'ok' && etapa(corriendo, 1, 'verificar') === 'pendiente' && etapa(corriendo, 1, 'auditar') === 'pendiente');
    check('corriendo: revisión pendiente', corriendo.revision.estado === 'pendiente');
    check('el actor del escritor sale del lote', corriendo.tareas[0].etapas.escribir.actor.motor === 'antigravity' && corriendo.tareas[0].etapas.escribir.actor.modelo === 'gemini-3.8-flash');

    const conClaude = proyectarTuberia(lote('corriendo', [tarea('t1', { modelo: 'sonnet' })], undefined, { motor: 'claude@trabajo' }));
    check('el motor claude@<cuenta> del lote aparece como actor', conClaude.tareas[0].etapas.escribir.actor.motor === 'claude@trabajo' && conClaude.tareas[0].etapas.escribir.actor.modelo === 'sonnet');

    const verificando = proyectarTuberia(lote('verificando', [tarea('t1', { estado: 'verificando', commit: 'c1' })]));
    check('verificando: la prueba corre', etapa(verificando, 0, 'escribir') === 'ok' && etapa(verificando, 0, 'verificar') === 'corriendo' && etapa(verificando, 0, 'auditar') === 'pendiente');

    const auditando = proyectarTuberia(lote('auditando', [tarea('t1', { estado: 'auditando', commit: 'c1', prueba: prueba('fallo', { duracionMs: 2000 }) })]));
    check('auditando: prueba roja es falla consultiva y la auditoría corre', etapa(auditando, 0, 'verificar') === 'falla' && etapa(auditando, 0, 'auditar') === 'corriendo');
    check('la duración de la prueba se proyecta', auditando.tareas[0].etapas.verificar.duracionMs === 2000);
    check('resumen (G0): lo que está en curso le gana a todo',
      corriendo.resumen.escribir === 'corriendo' && corriendo.resumen.verificar === 'pendiente' && auditando.resumen.auditar === 'corriendo' && auditando.resumen.verificar === 'falla');
  });

  await group('estados finales del lote', () => {
    const historial = [{ estado: 'corriendo', cuando: CREADO }, { estado: 'verificando', cuando: '2026-10-09T10:05:00.000Z' },
      { estado: 'auditando', cuando: '2026-10-09T10:06:00.000Z' }, { estado: 'para revisar', cuando: '2026-10-09T10:08:00.000Z' }];
    const revisar = proyectarTuberia(lote('para revisar', [escrita('t1'), escrita('t2', { auditoria: auditoria('completa', { veredicto: 'FAIL', modelo: 'gemini-3.1-pro' }) })], historial));
    check('para revisar: todo ok y la revisión espera (G2.5: esperando, no en curso)', ['escribir', 'verificar', 'auditar'].every((e) => etapa(revisar, 0, e) === 'ok') && revisar.revision.estado === 'esperando');
    check('veredicto FAIL pinta la auditoría como falla con el veredicto', etapa(revisar, 1, 'auditar') === 'falla' && revisar.tareas[1].etapas.auditar.veredicto === 'FAIL');
    check('el auditor aparece como actor con su modelo', revisar.tareas[0].etapas.auditar.actor.modelo === 'gemini-3.1-pro');
    check('la escritura dura de creado a verificando (5 min)', revisar.escrituraMs === 5 * 60 * 1000);
    check('el historial se proyecta como log', revisar.historial.length === 4 && revisar.historial[3].estado === 'para revisar');
    check('resumen (G0): una auditoría FAIL marca la etapa como falla y la revisión espera',
      revisar.resumen.escribir === 'ok' && revisar.resumen.verificar === 'ok' && revisar.resumen.auditar === 'falla' && revisar.resumen.revision === 'esperando');

    const integrado = proyectarTuberia(lote('integrado', [escrita('t1')], historial));
    check('integrado: revisión ok por integrar', integrado.revision.estado === 'ok' && integrado.revision.salida === 'integrar');
    const descartado = proyectarTuberia(lote('descartado', [escrita('t1')], historial));
    check('descartado: revisión ok por descartar', descartado.revision.estado === 'ok' && descartado.revision.salida === 'descartar');

    const sinCommit = proyectarTuberia(lote('para revisar', [escrita('t1'), tarea('t2', { estado: 'escrita', sinCambios: true,
      prueba: prueba('omitida', { motivo: 'sin cambios' }), auditoria: auditoria('omitida', { motivo: 'sin cambios' }) })], historial));
    check('tarea sin cambios: escribir ok, verificar y auditar omitidos con motivo',
      etapa(sinCommit, 1, 'escribir') === 'ok' && etapa(sinCommit, 1, 'verificar') === 'omitida' && sinCommit.tareas[1].etapas.auditar.motivo === 'sin cambios');

    const noConfigurada = proyectarTuberia(lote('para revisar', [escrita('t1', { prueba: prueba('no configurada') })], historial));
    check('sin prueba declarada: verificar omitida', etapa(noConfigurada, 0, 'verificar') === 'omitida');
  });

  await group('cortes (fallido, interrumpido)', () => {
    const todoSinCambios = proyectarTuberia(lote('fallido', [tarea('t1', { estado: 'escrita', sinCambios: true, prueba: prueba('omitida', { motivo: 'sin cambios' }), auditoria: auditoria('omitida', { motivo: 'sin cambios' }) })],
      [{ estado: 'corriendo', cuando: CREADO }, { estado: 'fallido', cuando: '2026-10-09T10:02:00.000Z' }]));
    check('todo sin cambios: revisión omitida "nada que revisar", no falla', todoSinCambios.revision.estado === 'omitida' && todoSinCambios.revision.motivo === 'nada que revisar');
    check('resumen (G0): una etapa que ninguna tarea alcanzó queda omitida', todoSinCambios.resumen.escribir === 'ok' && todoSinCambios.resumen.verificar === 'omitida' && todoSinCambios.resumen.revision === 'omitida');
    check('fallido directo desde corriendo cuenta como fin de la escritura', todoSinCambios.escrituraMs === 2 * 60 * 1000);

    const escrituraRota = proyectarTuberia(lote('fallido', [tarea('t1', { estado: 'fallida', prueba: prueba('omitida', { motivo: 'sin commit' }), auditoria: auditoria('omitida', { motivo: 'sin commit' }) })]));
    check('escritura fallida: escribir falla y el resto omitido', etapa(escrituraRota, 0, 'escribir') === 'falla' && etapa(escrituraRota, 0, 'verificar') === 'omitida');

    // marcarFallido (servicio.js) deja prueba/auditoria en `pendiente` si verificar lanzó.
    const cortadoEnVerificar = proyectarTuberia(lote('fallido', [tarea('t1', { estado: 'verificando', commit: 'c1' })]));
    check('corte en verificar: verificar falla (cortada) y auditar omitida',
      etapa(cortadoEnVerificar, 0, 'verificar') === 'falla' && cortadoEnVerificar.tareas[0].etapas.verificar.motivo === 'cortada' && etapa(cortadoEnVerificar, 0, 'auditar') === 'omitida');
    check('con commit, la revisión del lote fallido es falla', cortadoEnVerificar.revision.estado === 'falla');

    const cortadoEnAuditar = proyectarTuberia(lote('fallido', [tarea('t1', { estado: 'auditando', commit: 'c1', prueba: prueba('fallo') })]));
    check('una prueba roja no oculta el corte de la auditoría', etapa(cortadoEnAuditar, 0, 'verificar') === 'falla' && etapa(cortadoEnAuditar, 0, 'auditar') === 'falla' && cortadoEnAuditar.tareas[0].etapas.auditar.motivo === 'cortada');

    // marcarInterrumpidos (registro.js) pasa a `interrumpida` cualquier tarea activa.
    const interrumpido = proyectarTuberia(lote('interrumpido', [
      tarea('t1', { estado: 'interrumpida' }),
      tarea('t2', { estado: 'interrumpida', commit: 'c2', prueba: prueba('paso') })
    ], [{ estado: 'corriendo', cuando: CREADO }, { estado: 'interrumpido', cuando: '2026-10-09T10:03:00.000Z', motivo: 'el proceso dueño ya no existe' }]));
    check('interrumpida sin commit: escribir falla', etapa(interrumpido, 0, 'escribir') === 'falla' && etapa(interrumpido, 0, 'verificar') === 'omitida');
    check('interrumpida con commit: escribir ok, auditar cortada', etapa(interrumpido, 1, 'escribir') === 'ok' && etapa(interrumpido, 1, 'verificar') === 'ok' && etapa(interrumpido, 1, 'auditar') === 'falla');
    check('interrumpido: revisión falla y la escritura no tiene duración', interrumpido.revision.estado === 'falla' && interrumpido.escrituraMs === null);
    check('el motivo del historial llega al log', interrumpido.historial[1].motivo === 'el proceso dueño ya no existe');
  });


  await group('G2.5: resumen para la lista, cruces y reloj', () => {
    const historial = [{ estado: 'corriendo', cuando: CREADO }, { estado: 'verificando', cuando: '2026-10-09T10:05:00.000Z' },
      { estado: 'auditando', cuando: '2026-10-09T10:06:00.000Z' }, { estado: 'para revisar', cuando: '2026-10-09T10:08:00.000Z' }];
    const conTiempos = (id, v, a, extra = {}) => escrita(id, { tiempos: { verificar: { inicio: v[0], fin: v[1] }, auditar: { inicio: a[0], fin: a[1] } }, ...extra });
    const l = lote('para revisar', [
      conTiempos('t1', ['2026-10-09T10:05:00.000Z', '2026-10-09T10:05:02.000Z'], ['2026-10-09T10:06:00.000Z', '2026-10-09T10:07:00.000Z']),
      conTiempos('t2', ['2026-10-09T10:05:02.000Z', '2026-10-09T10:05:05.000Z'], ['2026-10-09T10:07:00.000Z', '2026-10-09T10:08:00.000Z'],
        { auditoria: auditoria('completa', { veredicto: 'FAIL', modelo: 'gemini-3.1-pro' }) })
    ], historial);
    const p = proyectarTuberia(l);
    check('resumenTuberia es el mismo resumen de la proyección', JSON.stringify(resumenTuberia(l)) === JSON.stringify(p.resumen));
    check('resumenTuberia sin lote es null', resumenTuberia(null) === null);
    check('cruces: las dos tareas llegaron a todas las etapas y a la revisión', JSON.stringify(p.cruces) === JSON.stringify({ escribir: 2, verificar: 2, auditar: 2, revision: 2 }));
    const parcial = proyectarTuberia(lote('verificando', [tarea('t1', { estado: 'verificando', commit: 'c1' }), tarea('t2', { estado: 'escrita', commit: 'c2' })]));
    check('cruces en un lote parcial: a verificar llegó una, a auditar ninguna', parcial.cruces.verificar === 1 && parcial.cruces.auditar === 0 && parcial.cruces.revision === 0);
    const r = p.reloj;
    check('reloj: del creado al cierre (para revisar)', r.inicioMs === Date.parse(CREADO) && r.finMs === Date.parse('2026-10-09T10:08:00.000Z'));
    check('reloj: tres fases del lote según el historial', r.fases.map((f) => f.etapa).join(',') === 'escribir,verificar,auditar' && r.fases[0].hasta === Date.parse('2026-10-09T10:05:00.000Z'));
    const t2 = r.tareas.find((t) => t.id === 't2');
    check('reloj: t2 esperó su turno para verificar (2 s) y para auditar (1m 55s)',
      t2.tramos.map((x) => `${x.etapa}:${x.tipo}`).join(',') === 'verificar:espera,verificar:trabajo,auditar:espera,auditar:falla'
      && t2.tramos[0].hasta - t2.tramos[0].desde === 2000 && t2.tramos[2].hasta - t2.tramos[2].desde === 115000);
    check('reloj: un FAIL es un tramo de falla y la espera total suma los huecos', r.esperaMs === 2000 + 58000 + 115000);
    const activo = proyectarTuberia(lote('auditando', [conTiempos('t1', ['2026-10-09T10:05:00.000Z', '2026-10-09T10:05:02.000Z'], ['2026-10-09T10:06:00.000Z', null], { estado: 'auditando' })],
      historial.slice(0, 3)));
    check('reloj activo: sin fin y el tramo en curso con hasta null', activo.reloj.finMs === null && activo.reloj.tareas[0].tramos.at(-1).hasta === null);
    const enCola = proyectarTuberia(lote('auditando', [
      conTiempos('t1', ['2026-10-09T10:05:00.000Z', '2026-10-09T10:05:02.000Z'], ['2026-10-09T10:06:00.000Z', null], { estado: 'auditando' }),
      tarea('t2', { estado: 'verificando', commit: 'c2', prueba: prueba('paso'), auditoria: auditoria('pendiente'),
        tiempos: { verificar: { inicio: '2026-10-09T10:05:02.000Z', fin: '2026-10-09T10:05:05.000Z' } } })
    ], historial.slice(0, 3)));
    const t2cola = enCola.reloj.tareas.find((t) => t.id === 't2').tramos.at(-1);
    check('reloj activo: la tarea que espera su turno para auditar tiene una espera abierta',
      t2cola.etapa === 'auditar' && t2cola.tipo === 'espera' && t2cola.hasta === null && t2cola.desde === Date.parse('2026-10-09T10:05:05.000Z'));
    const viejo = proyectarTuberia(lote('para revisar', [escrita('t1')], historial));
    check('lote sin tiempos por tarea: quedan las fases, sin tareas', viejo.reloj.fases.length === 3 && viejo.reloj.tareas.length === 0);
    check('sin creado no hay reloj', proyectarTuberia({ ...l, creado: undefined }).reloj === null);
  });

  await group('proyección acotada', () => {
    const largo = 'x'.repeat(5000);
    const p = proyectarTuberia(lote('corriendo', [tarea(largo, { modelo: largo })], [{ estado: 'corriendo', cuando: CREADO, motivo: largo }]));
    check('ids, modelos y motivos se recortan', p.tareas[0].id.length <= 80 && p.tareas[0].etapas.escribir.actor.modelo.length <= 80 && p.historial[0].motivo.length <= 120);
    check('la proyección no expone rutas ni salidas', !JSON.stringify(proyectarTuberia(lote('para revisar', [escrita('t1', { worktree: 'C:/secreto', prueba: prueba('paso', { salida: 'SALIDA' }) })]))).match(/secreto|SALIDA/));
  });

  await group('consola: vista Tuberías (G2) y enlace del tablero', () => {
    const vista = fuente('vista-tuberias.js');
    const tablero = fuente('vista-tablero.js');
    const app = fs.readFileSync(path.join(UI, '..', 'app.js'), 'utf8');
    const servidor = fs.readFileSync(path.join(UI, '..', '..', 'servidor.js'), 'utf8');
    const html = fs.readFileSync(path.join(UI, '..', 'index.html'), 'utf8');
    check('la isla se carga con import dinámico solo al entrar', /import\('\.\.\/vendor\/grafo\.module\.js'\)/.test(vista) && !/^import .*grafo\.module/m.test(vista));
    check('la vista monta una vez, actualiza y desmonta al salir',
      (vista.match(/\.montar\(/g) || []).length === 1 && /\.actualizar\(props\)/.test(vista) && /\.desmontar\(\)/.test(vista));
    check('la vista no deriva estados de etapa: se los pasa a la isla', !/commit|sinCambios|prueba\.|auditoria\.|\.etapas\b/.test(vista));
    check('nada de innerHTML en la vista', !/innerHTML/.test(vista));
    check('la vista se mantiene chica (punto de control §9: ~300 líneas)', vista.split('\n').length < 300);
    check('ruta /tuberias en el cliente, en el servidor (shell) y en el menú',
      /p === '\/tuberias'/.test(app) && /\^\\\/tuberias\$/.test(servidor) && /href="\/tuberias" data-ruta data-vista="tuberias"/.test(html));
    check('el cajón del tablero ya no dibuja la grilla: enlaza a Tuberías', /Ver en Tuberías/.test(tablero) && /elegirLote\(l\.id\)/.test(tablero) && !/vista-tuberia\.js/.test(tablero));
    check('el componente de F1 ya no existe', !fs.existsSync(path.join(UI, 'vista-tuberia.js')));
  });

  await group('consola G2.5: acciones en un solo lugar, inspector y tabla fuera de la isla', () => {
    const vista = fuente('vista-tuberias.js');
    const detalle = fuente('tuberias-detalle.js');
    const acciones = fuente('lote-acciones.js');
    const tablero = fuente('vista-tablero.js');
    const isla = fs.readFileSync(path.join(UI, '..', '..', 'grafo', 'src', 'montar.tsx'), 'utf8');
    const nodos = fs.readFileSync(path.join(UI, '..', '..', 'grafo', 'src', 'nodos.tsx'), 'utf8');
    check('VerDiff y las acciones del lote viven en lote-acciones.js y el tablero las importa',
      /export function VerDiff/.test(acciones) && /export async function detenerTareaLote/.test(acciones)
      && /from '\.\/lote-acciones\.js'/.test(tablero) && !/function VerDiff/.test(tablero));
    check('Tuberías no importa el tablero (el módulo de 1300 líneas)', !/vista-tablero\.js/.test(detalle) && !/vista-tablero\.js/.test(vista));
    check('integrar y descartar están en la cabecera, con dos pasos', /CabeceraLote/.test(detalle) && (detalle.match(/BotonDosPasos/g) || []).length >= 3 && /integrarLote\(l, recargar\)/.test(detalle) && /descartarLote\(l, recargar\)/.test(detalle));
    check('los nodos del grafo no llevan botones', !/<button/.test(nodos));
    check('detener es por tarea, solo mientras escribe, desde el inspector de Escribir',
      /Detener esta tarea/.test(detalle) && /l\.estado === 'corriendo' && st\.estado === 'corriendo'/.test(detalle) && !/Detener/.test(vista));
    check('la isla solo avisa qué nodo se eligió: sin fetch ni rutas', /onNodeClick/.test(isla) && /alElegir/.test(isla) && !/fetch\(|\/api\//.test(isla));
    check('la vista pasa selección y aviso a la isla', /seleccion: sel, alElegir/.test(vista));
    check('el inspector tiene la estructura fija (resumen, por tarea, excluidas, nota)',
      ['titulo="Resumen"', 'titulo="Por tarea"', 'titulo="Excluidas"', 'NOTA'].every((x) => detalle.includes(x)));
    check('punto de control: cada archivo JS de Tuberías queda en ~200 líneas o menos',
      [vista, detalle, acciones].every((f) => f.split('\n').length <= 210));
  });

  await group('consola G3: borrador en Tuberías', () => {
    const borrador = fuente('tuberias-borrador.js');
    const vista = fuente('vista-tuberias.js');
    const tablero = fuente('vista-tablero.js');
    const servidor = fs.readFileSync(path.join(UI, '..', '..', 'servidor.js'), 'utf8');
    check('Volver sale del editor y Lanzar lote va en dos pasos', /alVolver\}>Volver</.test(borrador) && /texto="Lanzar lote"/.test(borrador) && /BotonDosPasos/.test(borrador));
    check('lanza con actores por la ruta de siempre y muestra el rechazo del servidor tal cual',
      /\/api\/tarjetas\/\$\{enc\(b\.madreId\)\}\/lote/.test(borrador) && /actores: \{ escribir:/.test(borrador) && /avisar\(err\.message, 'error'\)/.test(borrador));
    check('las opciones salen de /api/motores (cuentasLote) y los borradores del servidor', /\/api\/motores/.test(borrador) && /cuentasLote/.test(borrador) && /\/api\/lotes\/borradores/.test(borrador));
    check('motor y esfuerzo del auditor se ven como restricciones fijas', /Motor fijo/.test(borrador) && /Esfuerzo fijo/.test(borrador));
    check('una tarea sin prueba avisa que no se va a poder integrar', /no se va a poder integrar/.test(borrador));
    check('se autoguarda en este navegador', /porClave\('tuberias\.borrador'/.test(borrador) && /Guardado en este navegador/.test(borrador));
    check('nada de innerHTML y archivo chico (punto de control)', !/innerHTML/.test(borrador) && borrador.split('\n').length <= 210 && vista.split('\n').length <= 210);
    check('el tablero enlaza a Preparar en Tuberías', /Preparar en Tuberías/.test(tablero) && /elegirBorrador\(t\.id\)/.test(tablero));
    check('la ruta de borradores va antes de /api/lotes/:id', servidor.indexOf('nucleo.borradoresLote()') > 0 && servidor.indexOf('nucleo.borradoresLote()') < servidor.indexOf('nucleo.lote(p[0])'));
  });

  report();
}

main();
