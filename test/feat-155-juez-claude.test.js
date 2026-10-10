/**
 * FEAT-155 — Juez y Advisor con Claude: el motor en la receta, el modelo por motor y de otra familia,
 * el contenedor de solo lectura (invariantes), el auditor con el stream de Claude, el cambio de
 * credenciales por motor en las fases del caminante y el preflight de las cuentas de los revisores.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert.js');
const R = require('../mcp-server/lotes/recetas.js');
const G = require('../mcp-server/lotes/grafo-receta.js');
const D = require('../mcp-server/lotes/docker.js');
const { crearAuditor, elegirModeloAuditor } = require('../mcp-server/lotes/auditor.js');
const { revisarLote } = require('../mcp-server/lotes/pipeline-revision.js');
const { crearRegistro } = require('../mcp-server/lotes/registro.js');
const { crearServicioLotes } = require('../mcp-server/lotes/servicio.js');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-'));
const rechaza = (fn, re) => { try { fn(); return false; } catch (err) { return re ? re.test(err.message) : true; } };
const codigos = (g) => G.revisarGrafo(g).errores.filter((e) => e.severidad === 'error').map((e) => e.codigo);

/** Escribir → Verificar → Advisor (agy) → Juez (motor elegido) → Vos. */
function grafo({ juez = {}, advisor = {} } = {}) {
  return {
    nodos: {
      entrada: { tipo: 'entrada' }, esc: { tipo: 'escribir' }, ver: { tipo: 'verificar' },
      adv: { tipo: 'advisor', ...advisor }, hum: { tipo: 'humano' }, juez: { tipo: 'juez', ...juez }, vos: { tipo: 'revision' }
    },
    aristas: [
      { id: 'e-in', desde: 'entrada', puerto: 'sale', hacia: 'esc' },
      { id: 'esc-ok', desde: 'esc', puerto: 'ok', hacia: 'ver' }, { id: 'esc-sc', desde: 'esc', puerto: 'sin-cambios', hacia: 'juez' }, { id: 'esc-err', desde: 'esc', puerto: 'error', hacia: 'vos' },
      { id: 'ver-pasa', desde: 'ver', puerto: 'pasa', hacia: 'adv' }, { id: 'ver-falla', desde: 'ver', puerto: 'falla', hacia: 'adv' }, { id: 'ver-err', desde: 'ver', puerto: 'error', hacia: 'vos' },
      { id: 'adv-ok', desde: 'adv', puerto: 'aprobado', hacia: 'juez' }, { id: 'adv-corr', desde: 'adv', puerto: 'corregir', hacia: 'esc', alAgotar: 'juez' },
      { id: 'adv-hum', desde: 'adv', puerto: 'humano', hacia: 'hum' }, { id: 'adv-err', desde: 'adv', puerto: 'error', hacia: 'vos' },
      { id: 'hum-corr', desde: 'hum', puerto: 'corregir', hacia: 'esc', alAgotar: 'juez' }, { id: 'hum-ok', desde: 'hum', puerto: 'aprobar', hacia: 'juez' }, { id: 'hum-cancel', desde: 'hum', puerto: 'cancelar', hacia: 'vos' },
      { id: 'j-pass', desde: 'juez', puerto: 'pass', hacia: 'vos' }, { id: 'j-fail', desde: 'juez', puerto: 'fail', hacia: 'vos' }, { id: 'j-err', desde: 'juez', puerto: 'error', hacia: 'vos' }
    ]
  };
}
const recetaGrafo = (g) => R.aplicarCambios({ id: 'f155', version: 1, titulo: 'F155', forma: G.FORMA_GRAFO, grafo: G.validarGrafo(g) }, {});

group('receta y modelos', () => {
  check('un Juez con claude@trabajo y haiku es válido', codigos(grafo({ juez: { motor: 'claude@trabajo', modelo: 'haiku' } })).length === 0, codigos(grafo({ juez: { motor: 'claude@trabajo', modelo: 'haiku' } })).join());
  check('un Advisor también admite motor', codigos(grafo({ advisor: { motor: 'claude@principal' } })).length === 0);
  check('motor inválido → error', codigos(grafo({ juez: { motor: 'opencode' } })).includes('config'));
  check('motor Claude con modelo de agy → error', codigos(grafo({ juez: { motor: 'claude@trabajo', modelo: 'gemini-3.1-pro' } })).includes('config'));
  check('sin motor, un alias de Claude no vale (agy)', codigos(grafo({ juez: { modelo: 'sonnet' } })).includes('config'));
  const ef = recetaGrafo(grafo({ juez: { motor: 'claude@trabajo', modelo: 'haiku' } }));
  check('un lote no puede cambiar el motor del Juez', rechaza(() => R.aplicarCambios(ef, { 'juez.motor': 'antigravity' })));
  check('el primer Juez de Claude no da el «modelo auditor» de agy del lote', ef.nodos.auditar.modelo === null);
  check('Claude: de otra familia que quien escribe', rechaza(() => elegirModeloAuditor('claude-haiku-5-5', 'haiku', { motor: 'claude' }), /distinto del escritor/));
  check('Claude: con un escritor flash, haiku vale', elegirModeloAuditor('gemini-3.8-flash', 'haiku', { motor: 'claude' }) === 'haiku');
  check('Claude: por defecto sonnet, o haiku si escribe un sonnet', elegirModeloAuditor('gemini-3.8-flash', null, { motor: 'claude' }) === 'sonnet' && elegirModeloAuditor('sonnet', null, { motor: 'claude' }) === 'haiku');
  check('Claude: un modelo de agy se rechaza', rechaza(() => elegirModeloAuditor('gemini-3.8-flash', 'gemini-3.1-pro', { motor: 'claude' }), /no es un modelo de Claude/));
  check('agy sigue igual', elegirModeloAuditor('gemini-3.8-flash', null) === 'gemini-3.1-pro');
});

group('contenedor de solo lectura', () => {
  const argv = D.argvAuditorClaude({ nombres: D.nombres('l1', 't1'), rutaCopia: '/mnt/c/copia', rutaPedido: '/mnt/c/pedido', modelo: 'haiku', effort: 'high', idLote: 'l1', expiraEpoch: 2000000000 });
  check('cumple sus invariantes', D.verificarInvariantesAuditorClaude(argv).length === 0, D.verificarInvariantesAuditorClaude(argv).join());
  const comando = argv.at(-1);
  check('solo Read, Glob y Grep; sin retomar ni saltear permisos', comando.includes('--tools Read,Glob,Grep ') && !/Edit|Write|Bash|--resume|--dangerously/.test(comando));
  check('el prompt entra por stdin desde /pedido', comando.endsWith('< /pedido/PROMPT.md'));
  check('imagen de Claude, /trabajo y /pedido de solo lectura', argv.includes(D.IMAGEN_CLAUDE) && argv.includes('/mnt/c/copia:/trabajo:ro') && argv.includes('/mnt/c/pedido:/pedido:ro'));
  const rompe = (f) => D.verificarInvariantesAuditorClaude(f(argv)).length > 0;
  check('/trabajo escribible rompe', rompe((a) => a.map((x) => (x === '/mnt/c/copia:/trabajo:ro' ? '/mnt/c/copia:/trabajo' : x))));
  check('sumar Bash o Edit rompe', rompe((a) => [...a.slice(0, -1), a.at(-1).replace('Read,Glob,Grep', 'Read,Glob,Grep,Bash')]) && rompe((a) => [...a.slice(0, -1), a.at(-1).replace('Read,Glob,Grep', 'Read,Edit,Glob,Grep')]));
  check('sumar --resume o --dangerously-skip-permissions rompe', rompe((a) => [...a.slice(0, -1), `${a.at(-1)} --resume x`]) && rompe((a) => [...a.slice(0, -1), `${a.at(-1)} --dangerously-skip-permissions`]));
  check('montar el socket de Docker rompe', rompe((a) => [...a.slice(0, 2), '-v', '/var/run/docker.sock:/trabajo2', ...a.slice(2)]));
});

(async () => {
  await group('auditor con Claude (dobles)', async () => {
    const dir = path.join(raiz, 'aud');
    const repo = path.join(dir, 'repo');
    const raizCopias = path.join(dir, 'copias');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(raizCopias, { recursive: true });
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'tarea']);
    const commit = git(['rev-parse', 'HEAD']).trim();
    let argvVisto = null;
    let promptVisto = null;
    const llamadas = [];
    const eventos = [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-5-5' },
      { type: 'result', subtype: 'success', is_error: false, result: '## Verdict: PASS\n\nTodo bien.', session_id: 's1', usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {} }
    ];
    const ejecutarStream = async (bin, args, opciones) => {
      argvVisto = args;
      const pedido = Buffer.from(args.find((a) => /:\/pedido:ro$/.test(a)).replace(/:\/pedido:ro$/, '').slice('/mnt/x/'.length), 'hex').toString();
      promptVisto = fs.readFileSync(path.join(pedido, 'PROMPT.md'), 'utf8');
      for (const ev of eventos) opciones.onLine(JSON.stringify(ev));
      return { success: true, data: { duration_seconds: 3 } };
    };
    const base = { docker: async (args) => ({ code: 0, stdout: args[0] === 'inspect' ? 'true\n' : '', stderr: '' }), aWsl: async (x) => `/mnt/x/${Buffer.from(x).toString('hex')}`, raizCopias, idLote: 'lote-155', expiraEpoch: 2000000000,
      ejecutarStdin: async () => { throw new Error('el Juez de Claude no usa el stdin de agy'); }, ejecutarStream, registrarLlamada: (x) => llamadas.push(x) };
    const claude = { asegurarVida: async () => {}, volumenSecretoProxy: 'lote-secreto', motor: 'claude', cuenta: 'trabajo' };
    const auditar = crearAuditor({ ...base, credenciales: claude });
    const r = await auditar({ taskId: 't1', worktree: repo, commit, promptTarea: 'Hacer A', archivos: ['a.js'], prueba: { estado: 'paso' }, modeloEscritor: 'gemini-3.8-flash', modeloAuditor: 'haiku', motor: 'claude', cuenta: 'trabajo' });
    check('veredicto PASS desde el stream de Claude', r.estado === 'completa' && r.veredicto === 'PASS' && r.motor === 'claude', JSON.stringify(r).slice(0, 300));
    check('corre la imagen de Claude con las tools de solo lectura', argvVisto.includes(D.IMAGEN_CLAUDE) && argvVisto.at(-1).includes('--tools Read,Glob,Grep '));
    check('el prompt adversarial va en /pedido/PROMPT.md con el diff', /Implementation Evidence/.test(promptVisto) && /UNTRUSTED_DIFF/.test(promptVisto));
    check('registra el uso con la cuenta', llamadas.length === 1 && llamadas[0].motor === 'claude@trabajo' && llamadas[0].tool === 'lote-juez');
    check('borra la copia y el pedido', !fs.existsSync(path.join(raizCopias, 'lote-155')));
    const conAgy = crearAuditor({ ...base, credenciales: { ...claude, motor: 'antigravity', cuenta: null } });
    const mal = await conAgy({ taskId: 't1', worktree: repo, commit, promptTarea: 'x', archivos: ['a.js'], prueba: {}, modeloEscritor: 'gemini-3.8-flash', modeloAuditor: 'haiku', motor: 'claude', cuenta: 'trabajo' });
    check('con credenciales de otro motor no corre', mal.estado === 'error' && /no son las del Juez/.test(mal.error), mal.error);
    const otraCuenta = await auditar({ taskId: 't1', worktree: repo, commit, promptTarea: 'x', archivos: ['a.js'], prueba: {}, modeloEscritor: 'gemini-3.8-flash', modeloAuditor: 'haiku', motor: 'claude', cuenta: 'principal' });
    check('ni con las de otra cuenta de Claude', otraCuenta.estado === 'error' && /no son las del Juez/.test(otraCuenta.error));
  });

  await group('caminante: credenciales por motor en cada fase', async () => {
    const registro = crearRegistro({ dir: path.join(raiz, 'reg') });
    const tareas = [0, 1].map((i) => ({ id: `t_${i}`, prompt: `P${i}`, archivos: [`f${i}.js`], modelo: 'gemini-3.8-flash', modelo_auditor: 'gemini-3.1-pro' }));
    const receta = recetaGrafo(grafo({ juez: { motor: 'claude@trabajo', modelo: 'haiku' } }));
    registro.crear({ id: 'c1', repo: raiz, ramaBase: 'main', modelo: 'x', receta, tareas });
    const pasos = [];
    const auditar = async (a) => {
      pasos.push(`${a.rol || 'juez'}:${a.motor || 'antigravity'}${a.cuenta ? `@${a.cuenta}` : ''}:${a.modeloAuditor || '-'}`);
      return a.rol === 'advisor' ? { estado: 'completa', decision: 'APPROVE', indicaciones: '' } : { estado: 'completa', veredicto: 'PASS', reporte: '', motor: a.motor };
    };
    const preparados = [];
    const usados = [];
    const lote = await revisarLote({ slug: 'c1', tareas, registro, receta, repo: raiz, resultados: tareas.map((t, i) => ({ id: t.id, exito: true, commit: `c${i}0000000`, ruta: raiz })),
      verificar: async () => ({ estado: 'paso' }), auditar, concurrencia: 2, registrarUso: (x) => usados.push(x),
      prepararMotor: async (motor, cuenta) => { preparados.push(`${motor}${cuenta ? `@${cuenta}` : ''}`); } });
    check('el Advisor (agy) y el Juez (Claude) preparan sus credenciales, una vez por fase', preparados.join(' ') === 'antigravity claude@trabajo', preparados.join(' '));
    check('el Juez recibe su motor, su cuenta y su modelo (no el auditor de agy del lote)', pasos.filter((p) => p.startsWith('juez')).every((p) => p === 'juez:claude@trabajo:haiku'), pasos.join(' '));
    check('el Advisor sigue en agy con el auditor del lote', pasos.filter((p) => p.startsWith('advisor')).every((p) => p === 'advisor:antigravity:gemini-3.1-pro'));
    check('el uso del Juez de Claude no va al uso de agy (el del Advisor de agy sí)', usados.length === 2 && usados.every((u) => u.motor !== 'claude'), String(usados.length));
    check('termina para revisar', lote.estado === 'para revisar');
  });

  await group('servicio: armado y preflight', async () => {
    const dirDatos = path.join(raiz, 'datos');
    const almacen = R.crearAlmacenRecetas(dirDatos);
    almacen.crear({ id: 'juez-claude', titulo: 'Juez Claude', grafo: grafo({ juez: { motor: 'claude@trabajo', modelo: 'haiku' } }) });
    almacen.crear({ id: 'juez-fantasma', titulo: 'Juez fantasma', grafo: grafo({ juez: { motor: 'claude@fantasma' } }) });
    almacen.crear({ id: 'juez-haiku', titulo: 'Juez haiku', grafo: grafo({ juez: { motor: 'claude@trabajo', modelo: 'haiku' } }) });
    const config = { fanoutStatusline: false, fanoutControl: false, fanoutProgressLog: false, motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } } } };
    const servicio = crearServicioLotes({ registro: crearRegistro({ dir: path.join(dirDatos, 'lotes') }), docker: async () => ({ code: 0, stdout: '', stderr: '' }), aWsl: async (x) => x, dirDatos,
      config, recolectar: async () => {}, fanout: async () => ({ lanzado: false }), ejecutarStream: async () => {}, ejecutarStdin: async () => {}, verificarSondasClaude: async () => ({ ok: true }) });
    const base = { slug: 'f155', cwd: raiz, modelo: 'gemini-3.8-flash', effort: 'low', tareas: [{ id: 't_a', prompt: 'Cambiar A', archivos: ['a.js'] }] };
    const motivo = (x) => { try { servicio.validarSolicitud({ ...base, ...x }); return ''; } catch (err) { return err.message; } };
    const s = servicio.validarSolicitud({ ...base, receta: 'juez-claude' });
    check('la cuenta del Juez entra al preflight aunque el lote sea agy', s.motor === 'antigravity' && s.cuentasNodos.join() === 'trabajo', JSON.stringify(s.cuentasNodos));
    const entorno = await servicio.chequearEntorno(s);
    check('preflight: imagen, login y sondas de la cuenta del Juez', ['imagen-claude', 'login-claude:trabajo', 'sondas-claude:trabajo'].every((id) => entorno.some((c) => c.id === id)), entorno.map((c) => c.id).join());
    check('una cuenta no declarada se rechaza', /no está declarada/.test(motivo({ receta: 'juez-fantasma' })));
    check('un escritor de la familia del Juez se rechaza', /distinto del escritor/.test(motivo({ receta: 'juez-haiku', motor: 'claude@trabajo', modelo: 'claude-haiku-5-5', effort: undefined })));
  });

  await group('consola: Motor y Modelo en el Juez y el Advisor', async () => {
    const ui = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
    const inspector = fs.readFileSync(path.join(ui, 'tuberias-grafo-inspector.js'), 'utf8');
    check('el Juez y el Advisor usan el selector de motor', (inspector.match(/<\$\{MotorEscribir\} id=\$\{id\} n=\$\{n\} poner=\$\{poner\} cambiarGrafo=\$\{cambiarGrafo\} revisor=\$\{true\} \/>/g) || []).length === 2);
    check('dice que con Claude solo lee', /contenedor de solo lectura/.test(inspector));
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  report();
})();
