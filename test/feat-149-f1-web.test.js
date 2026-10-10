/**
 * FEAT-149 F1 — Recetas en la consola web: API del núcleo y receta del borrador al lanzar.
 */
const { check, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f149-web-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');

(async () => {
  const tareas = await import('../telegram-bridge/tareas.js');
  const { crearCanalWeb } = await import('../telegram-bridge/web/canal.js');
  const { crearNucleoWeb } = await import('../telegram-bridge/web/nucleo.js');
  const { crearAlmacenRecetas } = require('../mcp-server/lotes/recetas.js');
  const comandosRepo = require('../mcp-server/lotes/comandos-repo.js');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, '.lagrange'), { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, '.lagrange', 'comandos.json'), JSON.stringify({ lint: { argv: ['npm', 'run', 'lint'], timeout_minutes: 3, descripcion: 'eslint' } }));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);

  const madre = tareas.crearTarjeta({ titulo: 'Madre', pedido: 'Coordinar' }).tarea;
  const hija = tareas.proponerTarjeta({ autor: 'agente:orquestador', madre: madre.id, titulo: 'A', pedido: 'Editar A',
    sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1' }).tarea;
  tareas.aceptarPropuesta(hija.id);

  const loteConPasos = { id: 'f149-pasos', estado: 'para revisar', repo, creado: new Date().toISOString(), actualizado: new Date().toISOString(),
    tareas: [{ id: 't_x', estado: 'para revisar', commit: 'abc12345', vuelta: 2, vueltasMax: 3, vueltas: [{ n: 1, motivo: 'juez', auditoria: { veredicto: 'FAIL', reporte: 'MAJOR x', secreto: 'no' } }, { n: 2, motivo: null }], prueba: { estado: 'paso', argv: ['node', 't.js'], exitCode: 0,
      pasos: [{ origen: 'tarea', nombre: 'prueba', estado: 'paso', argv: ['node', 't.js'], exitCode: 0, salida: 'ok' }, { origen: 'repo', nombre: 'lint', estado: 'paso', argv: ['npm', 'run', 'lint'], exitCode: 0, salida: 'lint ok', base: 'abc' }] } }] };
  let solicitud = null;
  const servicio = {
    validarSolicitud(d) { solicitud = d; return d; },
    async preparar(d) { return { id: d.slug, preparado: true }; },
    ejecutarEnSegundoPlano() { return {}; },
    async cancelar() { return true; }
  };
  const nucleo = crearNucleoWeb({
    canal: crearCanalWeb(), bot: {}, almas: {}, tareas,
    workspaces: () => [{ id: 'ws-1', name: 'Repo', path: repo }], ultimoWorkspace: () => null,
    logs: () => ({}), sesiones: () => ({}), estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true,
    lotes: { servicio, registro: { marcarInterrumpidos() { return []; }, listar() { return [loteConPasos]; }, leer(id) { return id === loteConPasos.id ? loteConPasos : null; } },
      proyectarTuberia: () => null, resumenTuberia: () => null,
      validarId: (id) => id, recetas: crearAlmacenRecetas(path.join(dir, 'datos')), comandosRepo }
  });

  const lista = nucleo.recetas();
  check('la lista trae la clásica', lista.ok && lista.recetas[0].id === 'clasica');
  const nodos = { escribir: { skill: null, plantilla: '{tarea.prompt}\nTDD.' }, verificar: { comandos: ['lint'] }, auditar: { criterio: 'seguridad', modelo: null } };
  const creada = nucleo.crearReceta({ id: 'tdd', titulo: 'TDD', nodos });
  check('crear da 201 y la versión 1', creada.codigo === 201 && creada.receta.version === 1);
  check('crear repetida da 409', nucleo.crearReceta({ id: 'tdd', titulo: 'TDD', nodos }).codigo === 409);
  check('crear inválida da 400 con el motivo', /tarea\.prompt/.test(nucleo.crearReceta({ id: 'mala', titulo: 'x', nodos: { ...nodos, escribir: { plantilla: 'nada' } } }).error || ''));
  const v2 = nucleo.versionReceta('tdd', { nodos: { ...nodos, auditar: { criterio: 'correctitud', modelo: null } } });
  check('llevar a la receta crea la versión 2', v2.codigo === 201 && v2.receta.version === 2 && nucleo.receta('tdd').receta.version === 2);
  check('la clásica no admite versiones', nucleo.versionReceta('clasica', { nodos }).codigo === 400);
  check('receta inexistente da 404', nucleo.receta('nada').codigo === 404 && nucleo.versionReceta('nada', { nodos }).codigo === 404);

  const cmds = await nucleo.comandosDeBorrador(madre.id);
  check('los comandos del repo del borrador, del commit', cmds.ok && cmds.comandos[0].nombre === 'lint' && cmds.comandos[0].descripcion === 'eslint' && cmds.ruta === '.lagrange/comandos.json');

  const malo = await nucleo.lanzarLote(madre.id, { hijas: [{ id: hija.id, archivos: ['a.js'] }], receta: { id: 'tdd', cambios: [] } });
  check('una receta con forma inválida da 400', malo.codigo === 400);
  const r = await nucleo.lanzarLote(madre.id, { hijas: [{ id: hija.id, archivos: ['a.js'] }], receta: { id: 'tdd', version: 1, cambios: { 'auditar.criterio': 'solo este lote' } } });
  check('lanzar manda la receta y sus cambios al servicio', r.codigo === 202 && solicitud.receta.id === 'tdd' && solicitud.receta.version === 1 && solicitud.receta.cambios['auditar.criterio'] === 'solo este lote', JSON.stringify(r));
  const detalle = nucleo.lote('f149-pasos');
  const pasos = detalle.lote && detalle.lote.tareas[0].prueba.pasos;
  check('la web proyecta los pasos de Verificar (origen, nombre, salida)', Array.isArray(pasos) && pasos[1].origen === 'repo' && pasos[1].nombre === 'lint' && pasos[1].salida === 'lint ok' && !('base' in pasos[1]), JSON.stringify(detalle).slice(0, 300));
  const t0 = detalle.lote.tareas[0];
  check('F2: la web proyecta la vuelta y la historia acotada', t0.vuelta === 2 && t0.vueltasMax === 3 && t0.vueltas[0].motivo === 'juez' && t0.vueltas[0].reporte === 'MAJOR x' && !JSON.stringify(t0.vueltas).includes('secreto'));
  solicitud = null;
  report();
  fs.rmSync(dir, { recursive: true, force: true });
})();
