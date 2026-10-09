/**
 * FEAT-148 F1 — Receta del lote, proyección de su tubería y el componente de la consola.
 * La paridad receta ↔ revisarLote vive en lotes-pipeline.test.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { RECETA_LOTE, ETAPA_DE_ESTADO, proyectarTuberia } = require('../mcp-server/lotes/receta-lote.js');
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
  });

  await group('estados finales del lote', () => {
    const historial = [{ estado: 'corriendo', cuando: CREADO }, { estado: 'verificando', cuando: '2026-10-09T10:05:00.000Z' },
      { estado: 'auditando', cuando: '2026-10-09T10:06:00.000Z' }, { estado: 'para revisar', cuando: '2026-10-09T10:08:00.000Z' }];
    const revisar = proyectarTuberia(lote('para revisar', [escrita('t1'), escrita('t2', { auditoria: auditoria('completa', { veredicto: 'FAIL', modelo: 'gemini-3.1-pro' }) })], historial));
    check('para revisar: todo ok y la revisión espera', ['escribir', 'verificar', 'auditar'].every((e) => etapa(revisar, 0, e) === 'ok') && revisar.revision.estado === 'corriendo');
    check('veredicto FAIL pinta la auditoría como falla con el veredicto', etapa(revisar, 1, 'auditar') === 'falla' && revisar.tareas[1].etapas.auditar.veredicto === 'FAIL');
    check('el auditor aparece como actor con su modelo', revisar.tareas[0].etapas.auditar.actor.modelo === 'gemini-3.1-pro');
    check('la escritura dura de creado a verificando (5 min)', revisar.escrituraMs === 5 * 60 * 1000);
    check('el historial se proyecta como log', revisar.historial.length === 4 && revisar.historial[3].estado === 'para revisar');

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

  await group('proyección acotada', () => {
    const largo = 'x'.repeat(5000);
    const p = proyectarTuberia(lote('corriendo', [tarea(largo, { modelo: largo })], [{ estado: 'corriendo', cuando: CREADO, motivo: largo }]));
    check('ids, modelos y motivos se recortan', p.tareas[0].id.length <= 80 && p.tareas[0].etapas.escribir.actor.modelo.length <= 80 && p.historial[0].motivo.length <= 120);
    check('la proyección no expone rutas ni salidas', !JSON.stringify(proyectarTuberia(lote('para revisar', [escrita('t1', { worktree: 'C:/secreto', prueba: prueba('paso', { salida: 'SALIDA' }) })]))).match(/secreto|SALIDA/));
  });

  await group('consola: componente y enganche', () => {
    const vista = fuente('vista-tuberia.js');
    const tablero = fuente('vista-tablero.js');
    check('el componente exporta Tuberia', /export function Tuberia\(/.test(vista));
    check('el componente no deriva estados: solo lee etapa.estado', !/commit|sinCambios|prueba\.|auditoria\./.test(vista));
    check('el tablero importa y monta la tubería en un solo punto', /import \{ Tuberia \} from '\.\/vista-tuberia\.js';/.test(tablero) && (tablero.match(/<\$\{Tuberia\}/g) || []).length === 1);
    check('nada de innerHTML en el componente', !/innerHTML/.test(vista));
    check('el componente se mantiene chico (punto de control §7)', vista.split('\n').length < 400);
    const css = fs.readFileSync(path.join(UI, '..', 'app.css'), 'utf8');
    check('los cinco estados tienen estilo', ['ok', 'falla', 'corriendo', 'pendiente', 'omitida'].every((e) => css.includes(`.tub-${e}`)));
  });

  report();
}

main();
