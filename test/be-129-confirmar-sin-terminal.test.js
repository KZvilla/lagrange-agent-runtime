/**
 * BE-129 — `npm run lotes -- descartar|integrar` sin terminal: con `--confirmar <id>` no pregunta; sin la opción y
 * sin nada que leer (lo que pasa con `!` desde Claude Code) sale con error y dice cómo correrlo, en vez de colgarse
 * con «unsettled top-level await»; por un pipe sigue leyendo la respuesta.
 *
 * Corre el CLI de verdad sobre un registro temporal (`TELEGRAM_BRIDGE_DATA_DIR`). Solo los caminos que no borran:
 * el descarte exitoso poda contenedores de Docker y ese camino ya lo cubre el test de `descartarLote`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const CLI = path.join(__dirname, '..', 'scripts', 'lotes.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-129-'));
const carpeta = path.join(dir, 'lotes');
fs.mkdirSync(carpeta, { recursive: true });

const ahora = new Date().toISOString();
const tarea = { id: 'a', estado: 'para revisar', rama: 'lote/x-a', worktree: path.join(dir, 'no-existe'), commit: 'abc1234',
  prueba: { estado: 'paso', exitCode: 0 }, auditoria: { estado: 'completa', veredicto: 'PASS' } };
const lote = { version: 2, id: 'x', estado: 'para revisar', repo: dir, ramaBase: 'main', creado: ahora, actualizado: ahora,
  tareas: [tarea], historial: [] };
fs.writeFileSync(path.join(carpeta, 'x.json'), JSON.stringify(lote));

function correr(args, stdin) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, TELEGRAM_BRIDGE_DATA_DIR: dir },
    ...(stdin === null ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input: stdin })
  });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
}
const estado = () => JSON.parse(fs.readFileSync(path.join(carpeta, 'x.json'), 'utf8')).estado;

for (const accion of ['descartar', 'integrar']) {
  group(`${accion} sin terminal y sin --confirmar`, () => {
    for (const [nombre, stdin] of [['stdin vacío', ''], ['stdin ignorado', null]]) {
      const r = correr([accion, 'x'], stdin);
      check(`${nombre}: sale ≠ 0`, r.codigo !== 0 && r.codigo !== null, r.codigo);
      check(`${nombre}: dice cómo correrlo`, r.salida.includes(`sin terminal para confirmar: npm run lotes -- ${accion} x --confirmar x`), r.salida);
      check(`${nombre}: sin el warning de top-level await`, !/unsettled top-level await/i.test(r.salida), r.salida);
    }
    check('el lote sigue igual', estado() === 'para revisar');
  });

  group(`${accion} con otro id`, () => {
    const opcion = correr([accion, 'x', '--confirmar', 'y'], '');
    check('--confirmar y: «No coincide» y ≠ 0', /No coincide/.test(opcion.salida) && opcion.codigo !== 0, opcion.salida);
    check('--confirmar y: no pregunta', !/Escribí el id/.test(opcion.salida), opcion.salida);
    const pipe = correr([accion, 'x'], 'y\n');
    check('por pipe sigue leyendo: «No coincide»', /No coincide/.test(pipe.salida) && !/sin terminal/.test(pipe.salida), pipe.salida);
    check('el lote sigue igual', estado() === 'para revisar');
  });
}

group('el uso nombra --confirmar para los dos', () => {
  const r = correr([], '');
  check('descartar <id> [--confirmar <id>]', r.salida.includes('descartar <id> [--confirmar <id>]'), r.salida);
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
report();
