/**
 * FEAT-149 F1 — La receta en el servicio, el verificador con pasos, el criterio
 * del juez y el recorrido de revisión.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert.js');
const { crearRegistro } = require('../mcp-server/lotes/registro.js');
const { crearServicioLotes } = require('../mcp-server/lotes/servicio.js');
const { crearAlmacenRecetas } = require('../mcp-server/lotes/recetas.js');
const { crearVerificador } = require('../mcp-server/lotes/verificador.js');
const { crearAuditor } = require('../mcp-server/lotes/auditor.js');
const { revisarLote } = require('../mcp-server/lotes/pipeline-revision.js');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'f149-f1-'));
const repo = path.join(raiz, 'repo');
const datos = path.join(raiz, 'datos');
fs.mkdirSync(repo, { recursive: true });
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 't@t']);
git(['config', 'user.name', 't']);
fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'base']);

const almacen = crearAlmacenRecetas(datos);
almacen.crear({ id: 'tdd', titulo: 'TDD', nodos: {
  escribir: { skill: 'tdd-estricto', plantilla: 'Primero el test.\n{tarea.prompt}\nSolo: {archivos}' },
  verificar: { comandos: ['lint'] },
  auditar: { criterio: 'Seguridad primero.', modelo: 'gemini-3.1-pro' }
} });
const docker = async () => ({ code: 0, stdout: 'ok', stderr: '' });
const servicio = crearServicioLotes({ registro: crearRegistro({ dir: path.join(datos, 'lotes') }), docker, aWsl: async (x) => x, dirDatos: datos,
  config: { fanoutStatusline: false, fanoutControl: false, fanoutProgressLog: false }, recolectar: async () => {},
  leerCuerpoSkill: (nombre) => `cuerpo de ${nombre}`,
  fanout: async () => ({ lanzado: false, detalle: 'simulado' }), ejecutarStream: async () => {}, ejecutarStdin: async () => {} });
const base = { slug: 'f149-a', cwd: repo, modelo: 'gemini-3.8-flash', tareas: [
  { id: 't_a', prompt: 'Cambiar A', archivos: ['a.js'] },
  { id: 't_b', prompt: 'Cambiar B', archivos: ['b.js'], skill: 'otra' }
] };
const motivo = (fn) => { try { fn(); return ''; } catch (err) { return err.message; } };

(async () => {
  await group('la receta en validarSolicitud', async () => {
    const clasica = servicio.validarSolicitud(base);
    check('sin receta: clásica y el prompt tal cual', clasica.receta.id === 'clasica' && clasica.tareas[0].prompt === 'Cambiar A' && !clasica.tareas[0].skill);
    const s = servicio.validarSolicitud({ ...base, receta: 'tdd' });
    check('la plantilla va al prompt de la tarea', s.tareas[0].prompt === 'Primero el test.\nCambiar A\nSolo: a.js', JSON.stringify(s.tareas[0].prompt));
    check('la skill de la receta es el defecto; la de la tarea gana', s.tareas[0].skill === 'tdd-estricto' && s.tareas[1].skill === 'otra');
    check('el modelo auditor de la receta se usa si el pedido no trae otro', s.tareas[0].modelo_auditor === 'gemini-3.1-pro');
    const pisado = servicio.validarSolicitud({ ...base, receta: 'tdd', modelo_auditor: 'gemini-3.5-pro' });
    check('el del pedido gana al de la receta', pisado.tareas[0].modelo_auditor === 'gemini-3.5-pro');
    const conCambio = servicio.validarSolicitud({ ...base, receta: { id: 'tdd', cambios: { 'auditar.criterio': 'Solo correctitud.' } } });
    check('los cambios del lote quedan con su origen', conCambio.receta.nodos.auditar.criterio === 'Solo correctitud.' && conCambio.receta.origen['auditar.criterio'] === 'lote' && conCambio.receta.origen['escribir.plantilla'] === 'receta');
    check('"id@vN" se acepta', servicio.validarSolicitud({ ...base, receta: 'tdd@v1' }).receta.version === 1);
    check('una receta inexistente o mal escrita se rechaza', /no existe/.test(motivo(() => servicio.validarSolicitud({ ...base, receta: 'nada' })))
      && /inválida/.test(motivo(() => servicio.validarSolicitud({ ...base, receta: 'tdd; rm' }))));
    check('un cambio que rompe la plantilla se rechaza', /tarea\.prompt/.test(motivo(() => servicio.validarSolicitud({ ...base, receta: { id: 'tdd', cambios: { 'escribir.plantilla': 'nada' } } }))));
    check('el auditor de la receta pasa por la regla de familia', /distinto del escritor/.test(motivo(() => servicio.validarSolicitud({ ...base, modelo: 'gemini-3.1-pro', receta: 'tdd' }))));
  });

  await group('aviso temprano de comandos al preparar', async () => {
    let m = '';
    try { await servicio.preparar({ ...base, slug: 'f149-b', receta: 'tdd' }); } catch (err) { m = err.message; }
    check('si HEAD no declara el comando, no se lanza', /no lo declara/.test(m), m);
  });

  await group('el registro congela la receta', () => {
    const registro = crearRegistro({ dir: path.join(raiz, 'reg') });
    const receta = servicio.validarSolicitud({ ...base, receta: 'tdd' }).receta;
    registro.crear({ id: 'f149-reg', repo, ramaBase: 'main', modelo: 'x', receta, tareas: [{ id: 't_a' }] });
    check('lote.receta guardada', registro.leer('f149-reg').receta.id === 'tdd' && registro.leer('f149-reg').receta.nodos.verificar.comandos[0] === 'lint');
    registro.crear({ id: 'f149-viejo', repo, ramaBase: 'main', modelo: 'x', tareas: [{ id: 't_a' }] });
    check('sin receta no se agrega la clave', !('receta' in registro.leer('f149-viejo')));
  });

  await group('verificador con pasos', async () => {
    const corridas = [];
    const armar = (codigos, declarados = { lint: { argv: ['npm', 'run', 'lint'], timeout_minutes: 3 } }) => crearVerificador({
      docker, aWsl: async (x) => x, raizCopias: path.join(raiz, 'copias'), idLote: 'lote-v', expiraEpoch: 2000000000,
      ejecutarProceso: async (_bin, args) => { const argv = args.slice(args.indexOf('--') + 1); corridas.push(args.join(' ')); const c = codigos.shift(); return { code: c, error: null, salida: `salida ${c}`, salidaTruncada: false, timeout: false }; },
      comandos: { baseDeTarea: async () => 'abc1234', leerComandosRepo: async () => declarados, resolverComandos: require('../mcp-server/lotes/comandos-repo.js').resolverComandos }
    });
    const wt = repo;
    const pedido = { taskId: 't_a', worktree: wt, comandos: ['lint'], commit: 'abc1234', ramaBase: 'main', repo };

    const sinPrueba = await armar([0])({ ...pedido, prueba: null });
    check('sin prueba de la tarea + lint que pasa → «no configurada»', sinPrueba.estado === 'no configurada' && sinPrueba.pasos.length === 1 && sinPrueba.pasos[0].estado === 'paso', JSON.stringify(sinPrueba));
    const lintFalla = await armar([0, 2])({ ...pedido, prueba: { argv: ['node', 't.js'] } });
    check('prueba pasa + lint falla → «fallo» con el argv del lint', lintFalla.estado === 'fallo' && lintFalla.argv[2] === 'lint' && lintFalla.exitCode === 2 && lintFalla.pasos.map((p) => p.estado).join() === 'paso,fallo');
    check('el paso del repo guarda la base de la que se leyó', lintFalla.pasos[1].base === 'abc1234' && lintFalla.pasos[1].origen === 'repo');
    const pruebaFalla = await armar([1])({ ...pedido, prueba: { argv: ['node', 't.js'] } });
    check('si falla la prueba, el lint queda omitido', pruebaFalla.estado === 'fallo' && pruebaFalla.pasos.map((p) => p.estado).join() === 'fallo,omitida');
    const todo = await armar([0, 0])({ ...pedido, prueba: { argv: ['node', 't.js'] } });
    check('todo pasa → «paso» con el argv de la prueba de la tarea', todo.estado === 'paso' && todo.argv[0] === 'node');
    const noDeclarado = await armar([0], {})({ ...pedido, prueba: { argv: ['node', 't.js'] } });
    check('si en la base el comando no existe: «error» (infraestructura) y no corre nada', noDeclarado.estado === 'error' && /no lo declara/.test(noDeclarado.error) && noDeclarado.pasos.length === 1);
    const n = corridas.length;
    const sinComandos = await armar([0])({ taskId: 't_a', worktree: wt, prueba: { argv: ['node', 't.js'] } });
    check('sin comandos de receta: el camino de siempre, sin pasos', sinComandos.estado === 'paso' && !('pasos' in sinComandos) && corridas.length === n + 1);
    const roto = await armar([0])({ ...pedido, worktree: path.join(raiz, 'no-es-repo'), prueba: { argv: ['node', 't.js'] } });
    check('un fallo de infraestructura es «error», no una excepción', roto.estado === 'error' && roto.pasos.some((p) => p.estado === 'error'));
  });

  await group('criterio del juez', async () => {
    const commit = git(['rev-parse', 'HEAD']).trim();
    const prompts = [];
    const auditar = crearAuditor({
      docker: async (args) => ({ code: 0, stdout: args[0] === 'inspect' ? 'true\n' : '', stderr: '' }), aWsl: async () => '/mnt/copia',
      raizCopias: path.join(raiz, 'copias-a'), idLote: 'lote-a', expiraEpoch: 2000000000,
      credenciales: { asegurarVida: async () => {}, volumenSecretoProxy: 's' },
      ejecutarStdin: async (_b, prompt) => { prompts.push(prompt); return { success: true, data: { response: '## Verdict: PASS\n' } }; }
    });
    await auditar({ taskId: 't_a', worktree: repo, commit, promptTarea: 'Cambiar A', archivos: ['a.js'], modeloEscritor: 'gemini-3.8-flash' });
    await auditar({ taskId: 't_a', worktree: repo, commit, promptTarea: 'Cambiar A', archivos: ['a.js'], modeloEscritor: 'gemini-3.8-flash', criterio: 'Seguridad primero.' });
    check('sin criterio el prompt no cambia', !prompts[0].includes('Additional review criteria'));
    const i = prompts[1].indexOf('## Additional review criteria');
    check('con criterio va en el plan, antes de la evidencia no confiable', i > 0 && prompts[1].includes('Seguridad primero.') && i < prompts[1].indexOf('BEGIN UNTRUSTED_DIFF'));
  });

  await group('revisarLote pasa receta, base y criterio', async () => {
    const registro = crearRegistro({ dir: path.join(raiz, 'reg2') });
    registro.crear({ id: 'f149-rev', repo, ramaBase: 'main', modelo: 'x', tareas: [{ id: 't_a' }] });
    const llamadas = { v: [], a: [] };
    const receta = servicio.validarSolicitud({ ...base, receta: 'tdd' }).receta;
    await revisarLote({ slug: 'f149-rev', tareas: [{ id: 't_a', prompt: 'p', archivos: ['a.js'], prueba: null }],
      resultados: [{ id: 't_a', exito: true, commit: 'abc1234', ruta: repo, rama: 'wt/x' }], registro, receta, repo,
      verificar: async (x) => { llamadas.v.push(x); return { estado: 'no configurada' }; },
      auditar: async (x) => { llamadas.a.push(x); return { estado: 'completa', veredicto: 'PASS' }; } });
    check('verificar recibe comandos, commit, rama base y repo', llamadas.v[0].comandos[0] === 'lint' && llamadas.v[0].commit === 'abc1234' && llamadas.v[0].ramaBase === 'main' && llamadas.v[0].repo === repo);
    check('auditar recibe el criterio', llamadas.a[0].criterio === 'Seguridad primero.');
    llamadas.v.length = 0; llamadas.a.length = 0;
    registro.crear({ id: 'f149-rev2', repo, ramaBase: 'main', modelo: 'x', tareas: [{ id: 't_a' }] });
    await revisarLote({ slug: 'f149-rev2', tareas: [{ id: 't_a', prompt: 'p', archivos: ['a.js'] }],
      resultados: [{ id: 't_a', exito: true, commit: 'abc1234', ruta: repo, rama: 'wt/x' }], registro,
      verificar: async (x) => { llamadas.v.push(x); return { estado: 'no configurada' }; },
      auditar: async (x) => { llamadas.a.push(x); return { estado: 'completa', veredicto: 'PASS' }; } });
    check('sin receta: las mismas claves de siempre', !('comandos' in llamadas.v[0]) && !('criterio' in llamadas.a[0]));
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  report();
})();
