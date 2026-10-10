/**
 * FEAT-149 F3 — Editor de recetas (servidor): disposición, problemas, chequeos del entorno,
 * estimación por lotes anteriores y las rutas revisar/comprobar del núcleo.
 */
const { check, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const recetas = require('../mcp-server/lotes/recetas.js');
const { estimarDuracion, proyectarTuberia } = require('../mcp-server/lotes/receta-lote.js');
const { crearServicioLotes } = require('../mcp-server/lotes/servicio.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f149-f3-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');
const lanza = (fn) => { try { fn(); return ''; } catch (err) { return err.message; } };
const base = () => JSON.parse(JSON.stringify(recetas.CLASICA.nodos));

(async () => {
  // ---- disposición
  check('disposición: redondea y conserva', JSON.stringify(recetas.validarDisposicion({ entrada: [0.4, 10.6], revision: [-20, 3] })) === '{"entrada":[0,11],"revision":[-20,3]}');
  check('disposición: ausente o vacía = null', recetas.validarDisposicion(null) === null && recetas.validarDisposicion({}) === null);
  check('disposición: nodo desconocido', /nodo desconocido/.test(lanza(() => recetas.validarDisposicion({ planificar: [0, 0] }))));
  check('disposición: no finita o fuera de rango', /\[x, y\]/.test(lanza(() => recetas.validarDisposicion({ entrada: [NaN, 0] }))) && /\[x, y\]/.test(lanza(() => recetas.validarDisposicion({ entrada: [10001, 0] }))));
  check('disposición: forma inválida', /\[x, y\]/.test(lanza(() => recetas.validarDisposicion({ entrada: [1] }))) && /objeto/.test(lanza(() => recetas.validarDisposicion([]))));

  const almacen = recetas.crearAlmacenRecetas(path.join(dir, 'datos'));
  const r1 = almacen.crear({ id: 'con-lugar', titulo: 'Con lugar', nodos: base(), disposicion: { escribir: [300, 40] } });
  check('crear guarda la disposición', r1.disposicion.escribir[1] === 40 && almacen.leer('con-lugar').disposicion.escribir[0] === 300);
  const r2 = almacen.nuevaVersion('con-lugar', { nodos: base() });
  check('una versión sin disposición no la hereda (vuelve al automático)', r2.version === 2 && !('disposicion' in almacen.leer('con-lugar')));
  check('crear rechaza una disposición inválida', /nodo desconocido/.test(lanza(() => almacen.crear({ id: 'mala', titulo: 'x', nodos: base(), disposicion: { x: [0, 0] } }))));
  const efectiva = recetas.aplicarCambios(almacen.leer('con-lugar', 1), { 'auditar.criterio': 'seguridad' });
  check('aplicarCambios conserva la disposición', efectiva.disposicion && efectiva.disposicion.escribir[0] === 300 && efectiva.origen['auditar.criterio'] === 'lote');
  const proy = proyectarTuberia({ id: 'l', estado: 'corriendo', creado: new Date().toISOString(), tareas: [], historial: [], receta: efectiva });
  check('la proyección pasa la disposición en configuracion', proy.configuracion.disposicion.escribir[0] === 300);
  const proyMala = proyectarTuberia({ id: 'l', estado: 'corriendo', creado: new Date().toISOString(), tareas: [], historial: [], receta: { ...efectiva, disposicion: { x: 1 } } });
  check('una disposición rota en el registro se ignora', proyMala.configuracion.disposicion === null);

  // ---- problemas
  check('la clásica no tiene problemas', recetas.problemasDeNodos(base()).length === 0);
  const sinTope = base();
  sinTope.verificar.siFalla = 'reescribir';
  const pSinTope = recetas.problemasDeNodos(sinTope);
  check('bucle sin vueltas: error que apunta al cable de Verificar', pSinTope.length === 1 && pSinTope[0].severidad === 'error' && pSinTope[0].ir.cable === 'vuelta-verificar');
  check('validarNodos lanza el mismo texto de siempre', lanza(() => recetas.validarNodos(sinTope)) === 'un bucle sin vueltas no hace nada: poné escribir.vueltas en 1 o más');
  const varios = base();
  varios.escribir.plantilla = 'sin variable';
  varios.auditar.modelo = 'gpt-4';
  varios.verificar.comandos = ['lint', 'lint'];
  const pVarios = recetas.problemasDeNodos(varios);
  check('junta todos los errores, cada uno con su nodo', pVarios.length === 3 && pVarios.map((p) => p.ir.nodo).sort().join() === 'auditar,escribir,verificar', JSON.stringify(pVarios));
  check('el primer error es el de siempre (modelo antes que plantilla)', lanza(() => recetas.validarNodos(varios)).startsWith('auditar.modelo'));
  const sinUso = base();
  sinUso.escribir.vueltas = 2;
  check('vueltas sin cable: info en Escribir', recetas.problemasDeNodos(sinUso)[0].codigo === 'vueltas-sin-uso' && recetas.problemasDeNodos(sinUso)[0].severidad === 'info');
  sinUso.auditar.siFail = 'reescribir';
  const pCosto = recetas.problemasDeNodos(sinUso);
  check('bucle activo: info de costo en el cable del juez', pCosto.length === 1 && pCosto[0].codigo === 'costo-bucle' && pCosto[0].ir.cable === 'vuelta-auditar');
  check('claves desconocidas cortan sin seguir revisando', recetas.problemasDeNodos({ escribir: { x: 1 }, verificar: {}, auditar: {} }).length === 1);
  check('nodos que no son objeto: un error', recetas.problemasDeNodos(null).length === 1);
  const repoP = recetas.problemasDeRepo({ verificar: { comandos: ['lint', 'build', 'test'] } }, { lint: { argv: ['x'], descripcion: 'eslint' }, build: { argv: ['y'] } });
  check('repo: sin descripción y no declarado, como avisos', repoP.length === 2 && repoP.every((p) => p.severidad === 'aviso') && repoP[0].codigo === 'comando-sin-descripcion' && repoP[1].codigo === 'comando-no-declarado');

  // ---- estimación
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  const iso = (min) => new Date(t0 + min * 60000).toISOString();
  const lote = (n, desplazar, estado = 'para revisar') => ({
    id: `l${n}`, estado, creado: iso(desplazar), actualizado: iso(desplazar + 20),
    historial: [{ estado: 'corriendo', cuando: iso(desplazar) }, { estado: 'verificando', cuando: iso(desplazar + 5) }, { estado: 'auditando', cuando: iso(desplazar + 7) }, { estado: 'para revisar', cuando: iso(desplazar + 20) }],
    tareas: [{ id: 'a', tiempos: { verificar: { inicio: iso(desplazar + 5), fin: iso(desplazar + 6) }, auditar: { inicio: iso(desplazar + 8), fin: iso(desplazar + 10) } } }]
  });
  check('estimación: sin lotes, sin historial', estimarDuracion([]).sinHistorial === true);
  check('estimación: un lote no alcanza', estimarDuracion([lote(1, 0)]).sinHistorial === true);
  const est = estimarDuracion([lote(1, 0), lote(2, 100), lote(3, 200), lote(4, 300, 'corriendo')]);
  check('estimación: escritura del lote + trabajo de la tarea, sin esperas ni lotes activos', est.lotes === 3 && est.medianaMs === 8 * 60000 && est.p90Ms === 8 * 60000, JSON.stringify(est));

  // ---- chequeos del entorno (servicio)
  const llamadas = [];
  const dockerCaido = async (args) => { llamadas.push(args.join(' ')); throw new Error('sin daemon'); };
  const crear = (docker, extra = {}) => crearServicioLotes({ registro: { crear() {}, leer() {}, listar() { return []; } }, docker, aWsl: async (x) => x,
    config: { fanoutStatusline: false }, recolectar: async () => {}, fanout: async () => ({}), ejecutarStream: async () => {}, ejecutarStdin: async () => {}, ...extra });
  const caido = await crear(dockerCaido).chequearEntorno({ motor: 'antigravity' });
  check('Docker caído: una línea en error y el resto sin comprobar, sin correrlos', caido[0].id === 'docker' && !caido[0].ok && caido.slice(1).every((c) => c.sinComprobar && !c.ok) && llamadas.length === 1, JSON.stringify(caido).slice(0, 200));
  const sinImagen = async (args) => (args[0] === 'image' && /verificador/i.test(args[2] || '') ? { code: 1 } : { code: 0, stdout: '' });
  const conClaude = await crear(sinImagen, { verificarSondasClaude: async () => ({ ok: false, motivo: 'sondas vencidas' }) }).chequearEntorno({ motor: 'claude', cuenta: 'trabajo' });
  const fallas = conClaude.filter((c) => !c.ok).map((c) => c.id);
  check('corre todos y marca cada falla en su línea (imagen y sondas)', fallas.length === 2 && fallas.some((x) => x.startsWith('imagen:')) && fallas.includes('sondas-claude') && conClaude.some((c) => c.id === 'login-claude' && c.ok), JSON.stringify(fallas));
  // `comprobarPreflight` (el que usa preparar) lanza el motivo de la primera línea que falla: los textos de siempre.
  check('el motivo de Docker es el texto de siempre', caido[0].motivo === 'Docker en WSL no responde: sin daemon. Probá wsl -e docker version.', caido[0].motivo);
  const imagen = conClaude.find((c) => c.id.startsWith('imagen:') && !c.ok);
  check('el motivo de una imagen es el texto de siempre', /^Falta la imagen .+\. Construila con npm run lotes -- imagenes\.$/.test(imagen.motivo), imagen.motivo);
  check('el motivo de las sondas es el texto de siempre', conClaude.find((c) => c.id === 'sondas-claude').motivo === 'Claude en el lote no está habilitado para trabajo: sondas vencidas.');

  // ---- núcleo: revisar y comprobar
  const tareas = await import('../telegram-bridge/tareas.js');
  const { crearCanalWeb } = await import('../telegram-bridge/web/canal.js');
  const { crearNucleoWeb } = await import('../telegram-bridge/web/nucleo.js');
  const comandosRepo = require('../mcp-server/lotes/comandos-repo.js');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, '.lagrange'), { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, '.lagrange', 'comandos.json'), JSON.stringify({ lint: { argv: ['npm', 'run', 'lint'] } }));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  const madre = tareas.crearTarjeta({ titulo: 'Madre', pedido: 'Coordinar' }).tarea;
  const hija = tareas.proponerTarjeta({ autor: 'agente:orquestador', madre: madre.id, titulo: 'A', pedido: 'Editar A',
    sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1' }).tarea;
  tareas.aceptarPropuesta(hija.id);
  let pedidoEntorno = null;
  const nucleo = crearNucleoWeb({
    canal: crearCanalWeb(), bot: {}, almas: {}, tareas,
    workspaces: () => [{ id: 'ws-1', name: 'Repo', path: repo }], ultimoWorkspace: () => null,
    logs: () => ({}), sesiones: () => ({}), estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true,
    lotes: {
      servicio: { chequearEntorno: async (s) => { pedidoEntorno = s; return [{ id: 'docker', texto: 'Docker en WSL', ok: true, motivo: null }, { id: 'ca', texto: 'CA TLS del proxy', ok: false, motivo: 'vencida' }]; } },
      registro: { marcarInterrumpidos() { return []; }, listar() { return [lote(1, 0), lote(2, 100)]; }, leer() { return null; } },
      proyectarTuberia: () => null, resumenTuberia: () => null, validarId: (id) => id,
      recetas: almacen, comandosRepo, libRecetas: recetas, estimarDuracion,
      cuotaDeModelo: (m) => (m.startsWith('gemini') ? { grupo: 'gemini', agotada: false } : null)
    }
  });
  const conLint = base();
  conLint.verificar.comandos = ['lint', 'build'];
  const rev = await nucleo.revisarReceta({ receta: { titulo: 'X', nodos: conLint }, madreId: madre.id });
  check('revisar suma los avisos del repo del borrador', rev.ok && rev.problemas.map((p) => p.codigo).join() === 'comando-sin-descripcion,comando-no-declarado', JSON.stringify(rev));
  const revSinTitulo = await nucleo.revisarReceta({ receta: { titulo: ' ', nodos: base(), disposicion: { nada: [0, 0] } } });
  check('revisar: título y disposición como errores', revSinTitulo.problemas.map((p) => p.codigo).join() === 'titulo,disposicion');
  check('revisar sin receta da 400', (await nucleo.revisarReceta({})).codigo === 400);
  const revRepoMalo = await nucleo.revisarReceta({ receta: { titulo: 'X', nodos: base() }, madreId: 't_noexiste' });
  check('revisar con un borrador que no existe: aviso, no error', revRepoMalo.ok && revRepoMalo.problemas[0].codigo === 'repo' && revRepoMalo.problemas[0].severidad === 'aviso');
  const comp = await nucleo.comprobarReceta({ receta: { titulo: 'X', nodos: sinTope }, actores: { escribir: { motor: 'claude@trabajo', modelo: 'sonnet' }, auditar: { modelo: 'claude-sonnet-4-6' } } });
  check('comprobar: el error de la receta y el bucle sin tope en estructura', comp.estructura[0].estado === 'error' && comp.estructura[2].estado === 'error');
  check('comprobar: juez de la misma familia que el escritor Claude, aviso', comp.estructura[3].estado === 'aviso');
  check('comprobar: el entorno pide la cuenta de Claude y marca cada línea', pedidoEntorno.motor === 'claude' && pedidoEntorno.cuenta === 'trabajo' && comp.entorno[1].estado === 'error' && comp.entorno[1].detalle === 'vencida');
  check('comprobar: cuota sin dato reciente para el juez, aviso', comp.entorno.some((l) => l.estado === 'aviso' && /sin dato reciente/.test(l.texto)));
  const vuelta = base();
  vuelta.escribir.vueltas = 2;
  vuelta.auditar.siFail = 'reescribir';
  const comp2 = await nucleo.comprobarReceta({ receta: { titulo: 'X', nodos: vuelta }, actores: { escribir: { motor: 'antigravity', modelo: 'gemini-3.8-flash' }, auditar: { modelo: 'gemini-3.1-pro' } } });
  check('comprobar: agy pide el entorno sin cuenta y la cuota de los dos modelos', pedidoEntorno.motor === 'antigravity' && comp2.entorno.filter((l) => /cuota/.test(l.texto)).length === 2);
  check('comprobar: estimación con las vueltas', /≈ 8–8 min por tarea sin vueltas; hasta ≈ 24 con 2 vueltas/.test(comp2.estimacion.texto), comp2.estimacion.texto);
  check('comprobar: estructura sana', comp2.estructura.every((l) => l.estado === 'ok'));
  // F4a — Una receta de grafo por el mismo núcleo: problemas con `ir` a nodo o arista, crear y comprobar.
  const G = require('../mcp-server/lotes/grafo-receta.js');
  const grafo = G.compilarClasica({ escribir: { vueltas: 1 }, verificar: { siFalla: 'reescribir', comandos: ['lint'] }, auditar: {} });
  const revG = await nucleo.revisarReceta({ receta: { titulo: 'G', grafo }, madreId: madre.id });
  check('grafo: revisar sin errores y con los avisos del repo por Verificar', revG.ok && !revG.problemas.some((p) => p.severidad === 'error') && revG.problemas.some((p) => p.codigo === 'comando-sin-descripcion' && p.ir.nodo === 'verificar'), JSON.stringify(revG.problemas));
  const roto = JSON.parse(JSON.stringify(grafo)); roto.aristas = roto.aristas.filter((x) => x.id !== 'auditar-error');
  const revRoto = await nucleo.revisarReceta({ receta: { titulo: 'G', grafo: roto } });
  check('grafo: un puerto suelto es error y apunta al nodo', revRoto.problemas.some((p) => p.codigo === 'puerto-suelto' && p.ir.nodo === 'auditar'));
  const compG = await nucleo.comprobarReceta({ receta: { titulo: 'G', grafo: roto }, actores: { escribir: { motor: 'antigravity', modelo: 'gemini-3.8-flash' }, auditar: { modelo: 'gemini-3.1-pro' } } });
  check('grafo: comprobar dice que hay errores y estima con las vueltas posibles', compG.estructura[0].estado === 'error' && compG.estructura[1].estado === 'ok' && /hasta ≈/.test(compG.estimacion.texto), JSON.stringify(compG.estructura));
  // FEAT-153 — Un Escribir con motor Claude: Comprobar pide al entorno el login y las sondas de esa cuenta.
  const grafoClaude = JSON.parse(JSON.stringify(grafo)); grafoClaude.nodos.planb = { tipo: 'escribir', motor: 'claude@trabajo', modelo: 'sonnet' };
  for (const p of ['ok', 'sin-cambios', 'error']) grafoClaude.aristas.push({ id: `pb-${p}`, desde: 'planb', puerto: p, hacia: p === 'ok' ? 'verificar' : 'auditar' });
  await nucleo.comprobarReceta({ receta: { titulo: 'G', grafo: grafoClaude }, actores: { escribir: { motor: 'antigravity', modelo: 'gemini-3.8-flash' } } });
  check('grafo: comprobar pide al entorno las cuentas de los nodos', JSON.stringify(pedidoEntorno.cuentasNodos) === '["trabajo"]', JSON.stringify(pedidoEntorno));
  const creada = nucleo.crearReceta({ id: 'g-web', titulo: 'G web', grafo });
  check('grafo: crear por la web guarda grafo-v1', creada.ok && creada.receta.forma === 'grafo-v1');

  // ---- consola (fuentes de ui/)
  const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
  const fuente = (f) => fs.readFileSync(path.join(UI, f), 'utf8').replace(/\r\n/g, '\n');
  const editor = fuente('tuberias-editor.js');
  const insp = fuente('tuberias-editor-inspector.js');
  const lienzo = fuente('tuberias-lienzo.js');
  const receta = fuente('tuberias-receta.js');
  const nucleoUi = fuente('nucleo.js');
  const archivos = fs.readdirSync(UI).filter((f) => f === 'vista-tuberias.js' || f.startsWith('tuberias-'));
  const largos = archivos.map((f) => [f, fuente(f).split('\n').length]);
  check('web: cada archivo de Tuberías queda en 210 líneas o menos', largos.every(([, n]) => n <= 210), JSON.stringify(largos));
  check('web: el editor no llama rutas de lote ni lanza', ![editor, insp].some((f) => /\/api\/(lotes|tarjetas)/.test(f)));
  check('web: los problemas salen del servidor (revisar con debounce, comprobar al tocar)',
    /\/api\/recetas\/revisar/.test(editor) && /ESPERA_REVISAR_MS = 800/.test(editor) && /\/api\/recetas\/comprobar/.test(editor) && /onClick=\$\{comprobar\}/.test(editor));
  check('web: copia de trabajo, disposición y candado por porClave/persistente',
    /porClave\('tuberias\.receta'/.test(editor) && /porClave\('tuberias\.disposicion'/.test(lienzo) && /persistente\('tuberias\.candado'/.test(lienzo) && /persistente\('tuberias\.editor'/.test(receta));
  check('web: guardar con errores queda deshabilitado con el motivo', /disabled title=\$\{motivo\}/.test(editor) && /disabled=\$\{Boolean\(motivo\) \|\| !sinVersionar\}/.test(editor));
  check('web: la clásica solo se guarda como nueva', /receta\.incorporada \? null/.test(editor));
  check('web: al guardar desde un borrador, el borrador pasa a la versión nueva', /borradorDe\(b\)\.cambiar\(\(s\) => \(\{ \.\.\.s, receta: r, cambios: \{\} \}\)\)/.test(editor));
  check('web: el borrador ofrece «Editar receta» con su contexto', /recetaEditada\.value = \{ id: s\.receta\.id, madreId \}/.test(receta) && /madreId=\$\{b\.madreId\}/.test(fuente('tuberias-borrador.js')));
  check('web: revisar es de lectura (SEC-022)', /RUTAS_LECTURA = \[\/\^\\\/api\\\/recetas\\\/revisar\$\/\]/.test(nucleoUi));
  check('web: nada de innerHTML', ![editor, insp, lienzo].some((f) => /innerHTML/.test(f)));

  report();
  fs.rmSync(dir, { recursive: true, force: true });
})();
