const { check, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-tareas-lotes-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');

(async () => {
  const tareas = await import('../telegram-bridge/tareas.js');
  const madre = tareas.crearTarjeta({ titulo: 'Madre', pedido: 'Coordinar cambios' }).tarea;
  const crearHija = (titulo) => tareas.proponerTarjeta({
    autor: 'agente:orquestador', madre: madre.id, titulo, pedido: `Hacer ${titulo}`,
    sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1'
  }).tarea;
  const a = crearHija('A');
  const b = crearHija('B');
  tareas.aceptarPropuesta(a.id);
  tareas.aceptarPropuesta(b.id);

  const reserva = tareas.reservarFamilia([madre.id, a.id, b.id]);
  check('reserva la familia completa', reserva.ok && tareas.familiaReservada(a.id));
  check('una segunda reserva concurrente recibe 409', tareas.reservarFamilia([madre.id, a.id, b.id]).codigo === 409);
  check('editar queda bloqueado durante el preflight', tareas.editarTarjeta(a.id, { titulo: 'otro' }).codigo === 409);
  check('proponer otra hija queda bloqueado durante el preflight', tareas.proponerTarjeta({ autor: 'agente:x', madre: madre.id, titulo: 'C', pedido: 'C' }).codigo === 409);

  const vinculo = tareas.vincularLote({ madre, hijas: [a, b], loteId: 'web-lote-1' });
  tareas.liberarReservaFamilia(reserva.ids);
  check('vincula madre e hijas con una sola operación', vinculo.ok && [madre.id, a.id, b.id].every((id) => tareas.obtener(id).loteId === 'web-lote-1'));
  check('doble vínculo se rechaza', tareas.vincularLote({ madre, hijas: [a, b], loteId: 'web-lote-2' }).codigo === 409);
  check('lanzar por el carril viejo queda bloqueado', tareas.lanzarTarjeta(a.id, { carril: 'cast', sujeto: a.sujeto, proyecto: a.proyecto, workspaceId: a.workspaceId }) === null);
  check('las notas siguen permitidas', tareas.agregarNota(a.id, 'evidencia').ok);
  check('desvincula solo el id exacto', tareas.desvincularLote('otro').cantidad === 0 && tareas.desvincularLote('web-lote-1').cantidad === 3);
  check('después del descarte vuelve a ser editable', tareas.editarTarjeta(a.id, { titulo: 'A2' }).ok);

  tareas.reiniciarParaTests();
  fs.rmSync(dir, { recursive: true, force: true });
  report();
})().catch((err) => {
  console.error(err);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
