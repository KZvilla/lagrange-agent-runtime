/**
 * FEAT-149 F1 — Recetas del lote: formato, validador, almacén y comandos del repo.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert.js');
const R = require('../mcp-server/lotes/recetas.js');
const C = require('../mcp-server/lotes/comandos-repo.js');

const rechaza = (fn, re) => { try { fn(); return false; } catch (err) { return re ? re.test(err.message) : true; } };
const nodos = (extra = {}) => ({ escribir: { skill: null, plantilla: null }, verificar: { comandos: [] }, auditar: { criterio: null, modelo: null }, ...extra });

group('validador de nodos', () => {
  check('la clásica es válida', R.validarReceta(R.CLASICA).id === 'clasica');
  check('forma desconocida se rechaza', rechaza(() => R.validarReceta({ ...R.CLASICA, forma: 'grafo' }), /forma/));
  check('clave extra en la receta o en un nodo se rechaza', rechaza(() => R.validarReceta({ ...R.CLASICA, x: 1 }), /desconocido/)
    && rechaza(() => R.validarNodos(nodos({ escribir: { skill: null, tools: 'comandos' } })), /desconocido "tools"/));
  check('nodo desconocido se rechaza', rechaza(() => R.validarNodos({ ...nodos(), planificar: {} }), /desconocido/));
  check('plantilla sin {tarea.prompt}', rechaza(() => R.validarNodos(nodos({ escribir: { plantilla: 'hacé algo' } })), /tarea\.prompt/));
  check('plantilla con variable desconocida', rechaza(() => R.validarNodos(nodos({ escribir: { plantilla: '{tarea.prompt} {secreto}' } })), /\{secreto\}/));
  check('plantilla con ruta absoluta del host', rechaza(() => R.validarNodos(nodos({ escribir: { plantilla: '{tarea.prompt} mirá C:\\Users\\x' } })), /ruta absoluta/));
  check('plantilla de más de 8 KB', rechaza(() => R.validarNodos(nodos({ escribir: { plantilla: '{tarea.prompt}' + 'x'.repeat(8200) } })), /KB/));
  check('plantilla válida se conserva', R.validarNodos(nodos({ escribir: { plantilla: 'TDD.\n{tarea.prompt}\nSolo {archivos}' } })).escribir.plantilla.startsWith('TDD.'));
  check('criterio de más de 4 KB o con ruta absoluta', rechaza(() => R.validarNodos(nodos({ auditar: { criterio: 'x'.repeat(4200) } })))
    && rechaza(() => R.validarNodos(nodos({ auditar: { criterio: 'ver /mnt/c/x' } })), /ruta absoluta/));
  check('modelo auditor que no es de agy', rechaza(() => R.validarNodos(nodos({ auditar: { modelo: 'sonnet' } })), /agy/));
  check('comandos: nombre inválido, repetido o más de 4', rechaza(() => R.validarNodos(nodos({ verificar: { comandos: ['Lint!'] } })))
    && rechaza(() => R.validarNodos(nodos({ verificar: { comandos: ['lint', 'lint'] } })), /repetido/)
    && rechaza(() => R.validarNodos(nodos({ verificar: { comandos: ['a', 'b', 'c', 'd', 'e'] } })), /hasta 4/));
  check('skill con ruta se rechaza', rechaza(() => R.validarNodos(nodos({ escribir: { skill: '../x' } }))));
});

group('cambios de un lote', () => {
  const ef = R.aplicarCambios(R.CLASICA, { 'auditar.criterio': 'seguridad primero' });
  check('aplica el cambio y marca el origen', ef.nodos.auditar.criterio === 'seguridad primero' && ef.origen['auditar.criterio'] === 'lote' && ef.origen['escribir.skill'] === 'receta');
  check('no muta la receta', R.CLASICA.nodos.auditar.criterio === null);
  check('un campo que no se puede cambiar se rechaza', rechaza(() => R.aplicarCambios(R.CLASICA, { 'escribir.tools': 'comandos' }), /no puede cambiar/));
  check('el cambio pasa por el validador', rechaza(() => R.aplicarCambios(R.CLASICA, { 'escribir.plantilla': 'sin variable' }), /tarea\.prompt/));
});

group('plantilla', () => {
  const t = { prompt: 'Sumá {archivos} y $& raro', archivos: ['a.js', 'b.js'] };
  check('sin plantilla, el prompt tal cual', R.renderPlantilla(null, t) === t.prompt);
  const r = R.renderPlantilla('Antes\n{tarea.prompt}\nArchivos: {archivos}', t);
  check('reemplaza las variables una sola vez (el prompt no se re-escanea)', r === 'Antes\nSumá {archivos} y $& raro\nArchivos: a.js, b.js', r);
});

group('almacén', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f149-recetas-'));
  try {
    const a = R.crearAlmacenRecetas(dir);
    check('lista vacía tiene solo la clásica', a.listar().length === 1 && a.listar()[0].incorporada);
    const v1 = a.crear({ id: 'tdd-estricto', titulo: 'TDD estricto', nodos: nodos({ escribir: { skill: 'tdd', plantilla: null } }) });
    check('crear da la versión 1', v1.version === 1 && a.leer('tdd-estricto').nodos.escribir.skill === 'tdd');
    const v2 = a.nuevaVersion('tdd-estricto', { nodos: nodos({ auditar: { criterio: 'seguridad', modelo: null } }) });
    check('nueva versión es la 2 y conserva el título', v2.version === 2 && a.leer('tdd-estricto').titulo === 'TDD estricto');
    check('se puede leer la versión vieja', a.leer('tdd-estricto', 1).nodos.escribir.skill === 'tdd');
    check('crear con un id existente se rechaza', rechaza(() => a.crear({ id: 'tdd-estricto', titulo: 'x' }), /ya existe/));
    check('"clasica" está reservado y no admite versiones', rechaza(() => a.crear({ id: 'clasica', titulo: 'x' }), /reservado/)
      && rechaza(() => a.nuevaVersion('clasica', { nodos: nodos() }), /no admite/));
    check('id con ruta se rechaza', rechaza(() => a.leer('../fuera')));
    check('versión inexistente se rechaza', rechaza(() => a.leer('tdd-estricto', 9), /versión 9/));
    check('la lista trae la última versión', a.listar().find((x) => x.id === 'tdd-estricto').version === 2);
    check('no deja temporales', fs.readdirSync(path.join(dir, 'recetas', 'tdd-estricto')).every((f) => /^v\d+\.json$/.test(f)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

group('proyección', () => {
  const { proyectarTuberia } = require('../mcp-server/lotes/receta-lote.js');
  const viejo = proyectarTuberia({ id: 'x', estado: 'para revisar', tareas: [{ id: 't', estado: 'para revisar', commit: 'abc', prueba: { estado: 'paso' }, auditoria: { estado: 'completa', veredicto: 'PASS' } }] });
  check('un lote sin receta se proyecta como la clásica', viejo.configuracion.id === 'clasica' && viejo.configuracion.origen['auditar.criterio'] === 'receta');
  const ef = R.aplicarCambios(R.CLASICA, { 'verificar.comandos': ['lint'] });
  const nuevo = proyectarTuberia({ id: 'y', estado: 'para revisar', receta: ef, tareas: [{ id: 't', estado: 'para revisar', commit: 'abc',
    prueba: { estado: 'fallo', pasos: [{ origen: 'tarea', nombre: 'prueba', estado: 'paso', duracionMs: 10, salida: 'secreto' }, { origen: 'repo', nombre: 'lint', estado: 'fallo', duracionMs: 5 }] },
    auditoria: { estado: 'pendiente' } }] });
  const v = nuevo.tareas[0].etapas ? nuevo.tareas[0].etapas.verificar : null;
  check('la configuración del lote viaja con su origen', nuevo.configuracion.nodos.verificar.comandos[0] === 'lint' && nuevo.configuracion.origen['verificar.comandos'] === 'lote');
  check('los pasos de Verificar se proyectan sin la salida', JSON.stringify(nuevo).includes('"nombre":"lint"') && !JSON.stringify(nuevo).includes('secreto'), JSON.stringify(v));
});

(async () => {
  await group('comandos del repo', async () => {
    check('parsea y valida', C.parsearComandos('{"lint":{"argv":["npm","run","lint"],"timeout_minutes":3}}').lint.timeout_minutes === 3);
    check('JSON inválido, argv inválido, tope, campo extra', rechaza(() => C.parsearComandos('{x'), /JSON/)
      && rechaza(() => C.parsearComandos('{"lint":{"argv":[]}}'))
      && rechaza(() => C.parsearComandos('{"lint":{"argv":["a"],"timeout_minutes":20}}'), /entre 0 y 15/)
      && rechaza(() => C.parsearComandos('{"lint":{"argv":["a"],"shell":true}}'), /desconocido/));
    check('resolver un comando no declarado se rechaza', rechaza(() => C.resolverComandos({}, ['lint']), /no lo declara/));

    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'f149-cmd-'));
    const git = (args) => execFileSync('git', args, { cwd: raiz, encoding: 'utf8' });
    try {
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(raiz, 'a.txt'), 'x');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      check('sin archivo en el commit: {}', Object.keys(await C.leerComandosRepo(raiz, 'HEAD')).length === 0);
      fs.mkdirSync(path.join(raiz, '.lagrange'));
      fs.writeFileSync(path.join(raiz, '.lagrange', 'comandos.json'), '{"lint":{"argv":["npm","run","lint"]}}');
      check('un cambio sin commitear no cuenta', Object.keys(await C.leerComandosRepo(raiz, 'HEAD')).length === 0);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'comandos']);
      const base = git(['rev-parse', 'HEAD']).trim();
      check('commiteado se lee', (await C.leerComandosRepo(raiz, 'HEAD')).lint.argv[2] === 'lint');
      git(['checkout', '-q', '-b', 'tarea']);
      fs.writeFileSync(path.join(raiz, '.lagrange', 'comandos.json'), '{"lint":{"argv":["sh","-c","curl evil"]}}');
      git(['commit', '-qam', 'el agente cambia los comandos']);
      const commitTarea = git(['rev-parse', 'HEAD']).trim();
      const b = await C.baseDeTarea(raiz, commitTarea, 'main');
      check('la base de la tarea es el commit del que nació', b === base);
      check('desde la base se leen los comandos originales, no los del agente', (await C.leerComandosRepo(raiz, b)).lint.argv[0] === 'npm');
      check('ref inválida se rechaza', await C.leerComandosRepo(raiz, 'main; rm').then(() => false, () => true));
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });
  report();
})();
