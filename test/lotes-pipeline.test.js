const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crearRegistro } = require('../mcp-server/lotes/registro.js');
const { revisarLote } = require('../mcp-server/lotes/pipeline-revision.js');

async function escenario({ pruebaEstado = 'paso', auditoriaEstado = 'completa' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-pipeline-'));
  const registro = crearRegistro({ dir });
  registro.crear({ id: 'l1', repo: 'r', ramaBase: 'b', modelo: 'gemini-3.8-flash', tareas: [{ id: 't1', modelo: 'gemini-3.8-flash' }] });
  const vistos = [];
  const lote = await revisarLote({
    slug: 'l1',
    tareas: [{ id: 't1', prompt: 'x', archivos: ['a.js'], modelo: 'gemini-3.8-flash', prueba: { argv: ['node', 'x.js'] } }],
    resultados: [{ id: 't1', exito: true, commit: 'abc1234', rama: 'wt/x', ruta: 'C:/wt', anomalias: [] }],
    registro,
    verificar: async () => { vistos.push('verificar'); return { estado: pruebaEstado, argv: ['node', 'x.js'], exitCode: pruebaEstado === 'paso' ? 0 : 1 }; },
    auditar: async () => { vistos.push('auditar'); return auditoriaEstado === 'completa' ? { estado: 'completa', veredicto: 'FAIL', modelo: 'gemini-3.1-pro', reporte: 'r' } : { estado: 'error', error: 'sin servicio' }; }
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { lote, vistos };
}

async function main() {
  await group('pipeline consultivo', async () => {
    const { lote, vistos } = await escenario({ pruebaEstado: 'fallo' });
    check('prueba roja no saltea auditoría', vistos.join(',') === 'verificar,auditar');
    check('FAIL consultivo termina para revisar', lote.estado === 'para revisar' && lote.tareas[0].auditoria.veredicto === 'FAIL');
    // FEAT-148 G2.5 — actualizarTarea es superficial: los tiempos de auditar no pisan los de verificar.
    const tt = lote.tareas[0].tiempos || {};
    const orden = (e) => e && e.inicio && e.fin && Date.parse(e.inicio) <= Date.parse(e.fin);
    check('quedan los tiempos de verificar y de auditar, cada uno con inicio ≤ fin', orden(tt.verificar) && orden(tt.auditar), JSON.stringify(tt));
    check('auditar empieza después de que verificar termina', Date.parse(tt.auditar.inicio) >= Date.parse(tt.verificar.fin));
  });
  // FEAT-148 — La receta declara el orden que recorre `revisarLote`: si alguien cambia
  // pipeline-revision.js sin tocar receta-lote.js, esto se pone rojo.
  await group('paridad receta ↔ revisarLote (FEAT-148)', async () => {
    const { RECETA_LOTE, ETAPA_DE_ESTADO } = require('../mcp-server/lotes/receta-lote.js');
    const { lote } = await escenario();
    const recorrido = lote.historial.map(h => ETAPA_DE_ESTADO[h.estado]);
    const declarado = RECETA_LOTE.etapas.map(e => e.id);
    check('cada estado del lote recorrido tiene su etapa', recorrido.every(Boolean), JSON.stringify(lote.historial.map(h => h.estado)));
    check('el orden recorrido es el de la receta', JSON.stringify(recorrido) === JSON.stringify(declarado), `${recorrido} ≠ ${declarado}`);
  });
  await group('infraestructura de auditoría', async () => {
    const { lote } = await escenario({ auditoriaEstado: 'error' });
    check('sin veredicto el lote falla cerrado', lote.estado === 'fallido');
  });
  report();
}

main();
