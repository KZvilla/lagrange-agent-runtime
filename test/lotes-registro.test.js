/**
 * FEAT-061 fase 2 — Registro de lotes.
 *
 * La invariante que importa más que el resto: nada se expulsa. Un lote es
 * trabajo sin integrar, y si desaparece del registro el usuario pierde ramas
 * sin enterarse de que existieron. (El recolector vive en
 * lotes-recolector.test.js.)
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crearRegistro, ESTADOS_ACTIVOS } = require('../mcp-server/lotes/registro.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-registro-'));

group('registro', () => {
  const r = crearRegistro({ dir });
  const lote = r.crear({ id: 'lote1', repo: 'C:/repo', ramaBase: 'feat/x', modelo: 'gemini-3.8-flash', tareas: [{ id: 't1' }, { id: 't2' }] });

  check('nace corriendo', lote.estado === 'corriendo');
  check('guarda el pid dueño', lote.pid === process.pid);
  check('cada tarea arranca corriendo', lote.tareas.every(t => t.estado === 'corriendo'));
  check('el archivo está en <dir>/lotes/<id>.json', fs.existsSync(path.join(dir, 'lotes', 'lote1.json')));

  let duplicado = false;
  try { r.crear({ id: 'lote1', repo: 'x', ramaBase: 'y', tareas: [] }); } catch { duplicado = true; }
  check('no se puede crear dos veces el mismo id', duplicado);

  let idMalo = false;
  try { r.crear({ id: '../fuga', repo: 'x', ramaBase: 'y', tareas: [] }); } catch { idMalo = true; }
  check('un id con ".." se rechaza', idMalo);

  r.actualizarTarea('lote1', 't1', { estado: 'para revisar', commit: 'abc1234', anomalias: [{ ruta: 'x', motivo: 'y' }] });
  const leido = r.leer('lote1');
  check('la tarea se actualiza', leido.tareas[0].commit === 'abc1234');
  check('guarda las anomalías', leido.tareas[0].anomalias.length === 1);

  r.cambiarEstado('lote1', 'verificando');
  r.cambiarEstado('lote1', 'auditando');
  r.cambiarEstado('lote1', 'para revisar');
  check('corriendo → verificando → auditando → para revisar', r.leer('lote1').estado === 'para revisar');
  check('queda historial completo', r.leer('lote1').historial.length === 4);

  let invalida = false;
  try { r.cambiarEstado('lote1', 'corriendo'); } catch { invalida = true; }
  check('para revisar → corriendo se rechaza', invalida);

  r.cambiarEstado('lote1', 'descartado');
  invalida = false;
  try { r.cambiarEstado('lote1', 'para revisar'); } catch { invalida = true; }
  check('descartado es final', invalida);

  check('el lote descartado sigue en disco (nada se expulsa)', !!r.leer('lote1'));

  // Descartar libera el nombre: el lote ya no tiene worktrees ni ramas, y
  // obligar a inventar un slug nuevo cada vez seria una molestia sin motivo.
  const reusado = r.crear({ id: 'lote1', repo: 'C:/repo', ramaBase: 'feat/x', tareas: [{ id: 't1' }] });
  check('un id descartado se puede volver a usar', reusado.estado === 'corriendo');
  const apartados = fs.readdirSync(path.join(dir, 'lotes')).filter(f => f.startsWith('lote1-descartado-'));
  check('y el archivo viejo se aparta, no se borra', apartados.length === 1, JSON.stringify(apartados));
  check('el lote nuevo esta en su archivo de siempre', r.leer('lote1').tareas.length === 1);
});

group('lotes huérfanos', () => {
  const r = crearRegistro({ dir, pidVivo: (pid) => pid === 4242 });
  r.crear({ id: 'vivo', repo: 'x', ramaBase: 'y', tareas: [{ id: 'a' }], pid: 4242 });
  r.crear({ id: 'muerto', repo: 'x', ramaBase: 'y', tareas: [{ id: 'a' }], pid: 999999 });
  r.crear({ id: 'auditando-muerto', repo: 'x', ramaBase: 'y', tareas: [{ id: 'a' }], pid: 999998 });
  r.cambiarEstado('auditando-muerto', 'verificando');
  r.cambiarEstado('auditando-muerto', 'auditando');

  const marcados = r.marcarInterrumpidos();
  check('marca el del pid muerto', marcados.includes('muerto'));
  check('marca también un auditor huérfano', marcados.includes('auditando-muerto'));
  check('no toca el del pid vivo', !marcados.includes('vivo') && r.leer('vivo').estado === 'corriendo');
  check('sus tareas quedan interrumpidas', r.leer('muerto').tareas[0].estado === 'interrumpida');

  const ids = r.listar().map(l => l.id);
  check('listar los devuelve a todos', ids.includes('vivo') && ids.includes('muerto') && ids.includes('lote1'));
});

group('consumidores de estados activos', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lotes.mjs'), 'utf8');
  const usos = cli.match(/ESTADOS_ACTIVOS\.includes\(l\.estado\)/g) || [];
  check('verificando y auditando son estados activos',
    ESTADOS_ACTIVOS.includes('verificando') && ESTADOS_ACTIVOS.includes('auditando'));
  check('recolectar y descartar protegen todos los estados activos', usos.length >= 2);
  check('el CLI no conserva el filtro legado solo-corriendo', !cli.includes("filter(l => l.estado === 'corriendo')"));
});

group('compatibilidad v1', () => {
  const r = crearRegistro({ dir });
  const carpeta = path.join(dir, 'lotes');
  fs.mkdirSync(carpeta, { recursive: true });
  fs.writeFileSync(path.join(carpeta, 'viejo.json'), JSON.stringify({ version: 1, id: 'viejo', estado: 'para revisar', creado: '2020-01-01', actualizado: '2020-01-01', tareas: [{ id: 'a', estado: 'para revisar' }], historial: [] }));
  const viejo = r.leer('viejo');
  check('v1 recibe defaults de fase 3 al leer', viejo.tareas[0].prueba.estado === 'pendiente' && viejo.tareas[0].auditoria.estado === 'pendiente');
  r.actualizarTarea('viejo', 'a', { sinCambios: true });
  check('una modificación legítima lo guarda como v2', JSON.parse(fs.readFileSync(path.join(carpeta, 'viejo.json'), 'utf8')).version === 2);
});

group('lectura degradada', () => {
  const r = crearRegistro({ dir });
  fs.writeFileSync(path.join(dir, 'lotes', 'roto.json'), '{no es json');
  const estado = r.listarConEstado();
  check('cuenta archivos ilegibles sin ocultar los lotes sanos', estado.ilegibles === 1 && estado.lotes.some((l) => l.id === 'lote1'));
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
report();
