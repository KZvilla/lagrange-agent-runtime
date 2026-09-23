const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-be-038-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');
const almacen = require('../mcp-server/agents/almacen.js');
const guardarOriginal = almacen.guardarJson;
let escrituras = 0;
almacen.guardarJson = (...args) => { escrituras++; return guardarOriginal(...args); };

(async () => {
  const tareas = await import('../telegram-bridge/tareas.js');
  const nuevaMadre = () => tareas.crearTarjeta({ titulo: 'Madre', pedido: 'Coordinar' }).tarea;
  const hijaDe = (madre, titulo) => tareas.proponerTarjeta({
    autor: 'agente:orquestador', madre: madre.id, titulo, pedido: `Hacer ${titulo}`,
    sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1'
  }).tarea;
  const instantanea = (t) => {
    const { madre, motivo, eventos, actualizada, ...resto } = t;
    return structuredClone(resto);
  };

  const vacia = nuevaMadre();
  assert.deepEqual(tareas.borrarTarjeta(vacia.id), { ok: true });
  assert.equal(tareas.obtener(vacia.id), null);

  const madre = nuevaMadre();
  const propuesta = hijaDe(madre, 'Propuesta');
  const aceptada = hijaDe(madre, 'Aceptada');
  assert(tareas.aceptarPropuesta(aceptada.id).ok);
  assert(tareas.agregarNota(aceptada.id, 'Conservar esta nota').ok);
  const previas = [propuesta, aceptada].map(instantanea);
  const avisos = [];
  const desuscribir = tareas.suscribir((t, info) => avisos.push({ id: t.id, borrada: Boolean(info.borrada), madre: t.madre }));
  const antes = escrituras;
  assert.deepEqual(tareas.borrarTarjeta(madre.id), { ok: true });
  assert.equal(escrituras - antes, 1, 'la familia se guarda una sola vez');
  assert.deepEqual(avisos, [
    { id: propuesta.id, borrada: false, madre: null },
    { id: aceptada.id, borrada: false, madre: null },
    { id: madre.id, borrada: true, madre: null }
  ], 'se avisan primero las hijas y luego la baja de la madre');
  desuscribir();
  tareas.reiniciarParaTests();
  assert.equal(tareas.obtener(madre.id), null);
  for (const [i, id] of [propuesta.id, aceptada.id].entries()) {
    const t = tareas.obtener(id);
    assert.equal(t.madre, null);
    assert.equal(t.motivo, 'mensaje');
    assert.deepEqual(instantanea(t), previas[i], 'todos los demás campos sobreviven a la recarga');
    assert.deepEqual([t.eventos.at(-1).tipo, t.eventos.at(-1).detalle], ['madre_borrada', madre.id]);
  }

  const comprobarRechazo = (madre, hijas) => {
    const antes = [madre, ...hijas].map((t) => JSON.stringify(tareas.obtener(t.id)));
    const escriturasAntes = escrituras;
    const avisosRechazo = [];
    const cancelar = tareas.suscribir((t) => avisosRechazo.push(t.id));
    assert.equal(tareas.borrarTarjeta(madre.id).codigo, 409);
    cancelar();
    assert.deepEqual([madre, ...hijas].map((t) => JSON.stringify(tareas.obtener(t.id))), antes);
    assert.equal(escrituras, escriturasAntes);
    assert.deepEqual(avisosRechazo, []);
  };

  const reservada = nuevaMadre();
  const hijaReservada = hijaDe(reservada, 'Reservada');
  tareas.reservarFamilia([hijaReservada.id]);
  comprobarRechazo(reservada, [hijaReservada]);
  tareas.liberarReservaFamilia([hijaReservada.id]);
  tareas.reservarFamilia([reservada.id]);
  comprobarRechazo(reservada, [hijaReservada]);
  tareas.liberarReservaFamilia([reservada.id]);

  const lote = nuevaMadre();
  const hijaLote = hijaDe(lote, 'Lote');
  tareas.aceptarPropuesta(hijaLote.id);
  assert(tareas.vincularLote({ madre: lote, hijas: [hijaLote], loteId: 'lote-be-038' }).ok);
  comprobarRechazo(lote, [hijaLote]);
  tareas.desvincularLote('lote-be-038');
  hijaLote.loteId = 'otro-lote';
  comprobarRechazo(lote, [hijaLote]);
  hijaLote.loteId = null;

  const ejecutada = nuevaMadre();
  const hijaEjecutada = hijaDe(ejecutada, 'Ejecutada');
  tareas.aceptarPropuesta(hijaEjecutada.id);
  assert(tareas.lanzarTarjeta(hijaEjecutada.id, { carril: 'cast', sujeto: hijaEjecutada.sujeto, workspaceId: hijaEjecutada.workspaceId }));
  comprobarRechazo(ejecutada, [hijaEjecutada]);
  tareas.actualizar(hijaEjecutada.id, { estado: 'ok' });
  comprobarRechazo(ejecutada, [hijaEjecutada]);
  tareas.archivarTarea(hijaEjecutada.id);
  comprobarRechazo(ejecutada, [hijaEjecutada]);

  const partiendo = nuevaMadre();
  const orquestacion = tareas.crear({ carril: 'cast', origen: 'web', sujeto: { tipo: 'agente', nombre: 'orquestador' }, pedido: 'Partir', motivo: 'orquestar', madre: partiendo.id });
  comprobarRechazo(partiendo, []);
  tareas.actualizar(orquestacion.id, { estado: 'ok' });
  assert(tareas.borrarTarjeta(partiendo.id).ok, 'la orquestación ya cerrada no bloquea');

  const conHermanas = nuevaMadre();
  const primera = hijaDe(conHermanas, 'Primera');
  const segunda = hijaDe(conHermanas, 'Segunda');
  const madreAntes = JSON.stringify(tareas.obtener(conHermanas.id));
  const hermanaAntes = JSON.stringify(tareas.obtener(segunda.id));
  assert(tareas.borrarTarjeta(primera.id).ok);
  assert.equal(JSON.stringify(tareas.obtener(conHermanas.id)), madreAntes);
  assert.equal(JSON.stringify(tareas.obtener(segunda.id)), hermanaAntes);

  console.log('✔ BE-038: conservación, bloqueos, persistencia y avisos');
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  almacen.guardarJson = guardarOriginal;
  fs.rmSync(dir, { recursive: true, force: true });
});
