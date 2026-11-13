/**
 * FEAT-191 — Modo manual de agy: Lagrange nunca lanza agy para que el modelo trabaje.
 *
 * Todo se prueba sin agy: en modo manual cada camino tiene que cortar ANTES del spawn,
 * así que los dobles de `intentarAgy`, `lanzar`, `spawnFn` y compañía fallan el test si
 * se llaman. La config se aísla con `LAGRANGE_AGY_MODO_CONFIG` (el HOME de la suite es
 * el real).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-191-'));
const CONFIG_FALSA = path.join(tmp, 'antigravity.json');
process.env.LAGRANGE_AGY_MODO_CONFIG = CONFIG_FALSA;
delete process.env.LAGRANGE_AGY_MODO;

const agyModo = require(path.join(MCP, 'lib', 'agy-modo.js'));
const { opcionesDeAgy } = require(path.join(MCP, 'lib', 'opciones-agy.js'));
const fb = require(path.join(MCP, 'lib', 'fallback-agy.js'));
const cuotaAgy = require(path.join(MCP, 'lib', 'cuota-agy.js'));
const docker = require(path.join(MCP, 'lotes', 'docker.js'));
const antigravity = require(path.join(MCP, 'motores', 'antigravity.js'));
const sondasAgy = require(path.join(MCP, 'motores', 'sondas-antigravity.js'));
const ajustesGeneral = require(path.join(MCP, 'lib', 'ajustes-general.js'));

const fuente = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\r\n/g, '\n');
const escribirConfig = (o) => {
  fs.writeFileSync(CONFIG_FALSA, JSON.stringify(o));
};
const manual = () => escribirConfig({ agy_modo: 'manual' });
const auto = () => escribirConfig({});
const silencio = () => {};
const prohibido = (que) => async () => { throw new Error(`${que} no tenía que llamarse en modo manual`); };

async function main() {
  await group('el modo: fuentes y precedencia (fail-closed)', () => {
    auto();
    check('sin agy_modo: auto', agyModo.modoAgy() === 'auto');
    manual();
    check('agy_modo manual en la config global: manual', agyModo.modoAgy() === 'manual');
    escribirConfig({ agy_modo: 'MANUAL ' });
    check('sin distinguir mayúsculas ni espacios', agyModo.enModoManual());
    escribirConfig({ agy_modo: 'cualquiera' });
    check('un valor inválido no activa el manual', agyModo.modoAgy() === 'auto');
    auto();
    process.env.LAGRANGE_AGY_MODO = 'manual';
    check('LAGRANGE_AGY_MODO=manual gana sobre la config en auto', agyModo.enModoManual());
    manual();
    process.env.LAGRANGE_AGY_MODO = 'auto';
    check('LAGRANGE_AGY_MODO=auto NO apaga el manual de la config', agyModo.enModoManual());
    delete process.env.LAGRANGE_AGY_MODO;
    fs.writeFileSync(CONFIG_FALSA, '{ roto');
    fs.utimesSync(CONFIG_FALSA, new Date(Date.now() + 200000), new Date(Date.now() + 200000));
    check('un archivo ilegible no decide (auto)', agyModo.modoAgy() === 'auto');
    check('la del proyecto no cuenta: solo se lee la global', !fuente('mcp-server/lib/agy-modo.js').includes('process.cwd()'));
  });

  await group('el punto único: opcionesDeAgy', () => {
    auto();
    check('en auto, como siempre', opcionesDeAgy({ cwd: 'x' }).windowsHide === true);
    manual();
    let err = null;
    try { opcionesDeAgy({ cwd: 'x' }); } catch (e) { err = e; }
    check('en manual lanza ErrorModoManual', agyModo.esErrorModoManual(err), err && err.message);
    check('el mensaje explica cómo seguir', err && /engine "opencode-go"/.test(err.message) && /agy_modo "auto"/.test(err.message));
    const local = opcionesDeAgy({ local: true, encoding: 'utf8' });
    check('local: true pasa (--version, help)', local.encoding === 'utf8');
    check('y la marca no llega a Node', !('local' in local));
  });

  await group('fallback: textos (conFallback)', async () => {
    manual();
    let generado = 0;
    const r = await fb.conFallback({
      config: { fallbackAgy: 'deepseek' }, intentarAgy: prohibido('intentarAgy'), prompt: 'hola', estado: null,
      generar: async () => { generado++; return { ok: true, texto: 'listo', duracion: 0.1 }; },
      refrescarCuota: prohibido('refrescarCuota'), log: silencio
    });
    check('con destino: va directo al suplente', generado === 1 && r.via === 'deepseek' && r.motivo === 'manual' && r.res.success, JSON.stringify(r));
    check('la nota dice modo manual', fb.notaDeVia(r).includes('agy en modo manual'));
    const sin = await fb.conFallback({ config: {}, intentarAgy: prohibido('intentarAgy'), prompt: 'hola', estado: null, log: silencio });
    check('sin destino: error claro, sin agy', sin.preflight && !sin.res.success && sin.res.error === agyModo.MENSAJE);
  });

  await group('fallback: lectura (conFallbackLectura)', async () => {
    manual();
    const llamadas = [];
    const r = await fb.conFallbackLectura({
      config: { fallbackAgy: 'opencode-go' }, intentarAgy: prohibido('intentarAgy'),
      intentarSuplente: async (m) => { llamadas.push(m); return { ok: true }; }, estado: null,
      refrescarCuota: prohibido('refrescarCuota'), log: silencio
    });
    check('con suplente de lectura: lo usa', llamadas.join() === 'opencode-go' && r.via === 'opencode-go' && r.motivo === 'manual');
    const retomado = await fb.conFallbackLectura({
      config: { fallbackAgy: 'opencode-go' }, intentarAgy: prohibido('intentarAgy'), intentarSuplente: prohibido('intentarSuplente'),
      estado: null, conversationId: 'h1', log: silencio
    });
    check('un hilo retomado: error claro', retomado.preflight && retomado.res.error === agyModo.MENSAJE);
    const conClaude = await fb.conFallbackLectura({
      config: { fallbackAgy: 'claude@trabajo' }, intentarAgy: prohibido('intentarAgy'), intentarSuplente: prohibido('intentarSuplente'),
      estado: null, log: silencio
    });
    check('con claude@ (sin perfil de lectura): error claro', conClaude.preflight && conClaude.motivo === 'manual');
  });

  await group('fallback: roles (conFallbackDeRol) y respaldo de OpenCode Go', async () => {
    manual();
    const eleccion = { motor: antigravity, fijo: false, modelo: null };
    const sinAlternativa = await fb.conFallbackDeRol({ config: {}, eleccion, tipo: 'alma', intentar: prohibido('intentar(agy)'), estado: null, log: silencio });
    check('sin fallback: error claro, sin intentar agy', sinAlternativa.resultado.preflight && sinAlternativa.resultado.error === agyModo.MENSAJE);
    const fijo = await fb.conFallbackDeRol({ config: { fallbackAgy: 'deepseek' }, eleccion: { ...eleccion, fijo: true }, tipo: 'alma', intentar: prohibido('intentar(agy)'), estado: fb.crearEstado({ leerFallback: () => ({}), guardarFallback: () => true }), log: silencio });
    check('un rol fijo en agy: error claro', fijo.resultado.error === agyModo.MENSAJE);
    let usado = null;
    const conDs = await fb.conFallbackDeRol({
      config: { fallbackAgy: 'deepseek' }, eleccion, tipo: 'alma',
      intentar: async (el) => { usado = el.motor.id; if (el.motor.id === 'antigravity') throw new Error('agy no'); return { resultado: { ok: true } }; },
      estado: fb.crearEstado({ leerFallback: () => ({}), guardarFallback: () => true }), log: silencio
    });
    check('con fallback: directo al suplente', usado === 'deepseek' && conDs.fallback && conDs.fallback.motivo === 'manual', JSON.stringify(conDs.fallback));
    const go = { motor: { id: 'opencode-go' }, fijo: true };
    let vueltas = 0;
    const r = await fb.conRespaldoEnAgy(go, async () => { vueltas++; return { resultado: { ok: false, error: 'cupo' } }; }, { log: silencio });
    check('OpenCode Go que falla no se repite en agy', vueltas === 1 && /modo manual/.test(r.resultado.error));
  });

  await group('motor antigravity, sondas y cuota', async () => {
    manual();
    let disparadas = 0;
    const pre = await antigravity.preflight({ perfil: 'sin-tools', prompt: 'x' }, { agyBin: 'agy-que-no-existe', leerSondas: prohibido('leerSondas'), dispararSondas: () => { disparadas++; } });
    check('el preflight corta con el motivo de manual', pre.ok === false && pre.manual === true && pre.motivo === agyModo.MENSAJE);
    check('y no dispara sondas', disparadas === 0);
    const s = sondasAgy.crearContextoSondas({ agyBin: 'agy-que-no-existe', homeDir: tmp, lanzar: prohibido('lanzar'), ejecutar: prohibido('ejecutar'), log: silencio });
    const rs = await s.correrAhora();
    check('las sondas no corren', rs && rs.manual === true, JSON.stringify(rs));
    const r = await cuotaAgy.refrescarConAgy({ forzar: true, refrescar: prohibido('refrescar /usage'), resolverBin: () => 'agy' });
    check('/usage no se refresca', r.ok === false && r.manual === true);
  });

  await group('agy dentro de contenedores', () => {
    manual();
    const intentos = {
      argvTarea: () => docker.argvTarea({ nombres: docker.nombres('l1', 't1'), rutaCopia: '/c', rutaPedido: '/p', modelo: 'gemini-4-hydrogen', effort: 'low', idLote: 'l1', expiraEpoch: 1 }),
      argvAuditor: () => docker.argvAuditor({ nombres: docker.nombres('l1', 't1'), rutaCopia: '/c', modelo: 'gemini-4-hydrogen', effort: 'high', idLote: 'l1', expiraEpoch: 1 }),
      argvSoloLectura: () => docker.argvSoloLectura({ nombres: docker.nombres('ro-x', 'ro'), rutaCopia: '/c', volumenHilo: 'ro-hilo-x', modelo: 'gemini-4-hydrogen', effort: 'high', idLote: 'ro-x', expiraEpoch: 1 }),
      argvRefrescador: () => docker.argvRefrescador({ nombreContenedor: 'a', nombreRed: 'b', nombreProxy: 'c', idLote: 'x', expiraEpoch: 1, guion: 'g' })
    };
    for (const [nombre, fn] of Object.entries(intentos)) {
      let err = null;
      try { fn(); } catch (e) { err = e; }
      check(`${nombre} no arma el argv`, agyModo.esErrorModoManual(err), err && err.message);
    }
  });

  await group('BE-181 (F14): el punto único de Docker frena la imagen de agy, la arme quien la arme', async () => {
    const corridas = [];
    const dockerFalso = docker.crearDocker({ ejecutarComando: async (bin, args) => { corridas.push(args); return { code: 0, stdout: '', stderr: '' }; } });
    manual();
    let err = null;
    try { await dockerFalso(['run', '--rm', docker.IMAGEN_AGY, 'agy', '-p', 'hola']); } catch (e) { err = e; }
    check('un argv a mano con la imagen de agy se frena antes de correr', agyModo.esErrorModoManual(err) && corridas.length === 0, err && err.message);
    for (const nombre of ['argvTarea', 'argvAuditor', 'argvSoloLectura', 'argvRefrescador']) {
      auto();
      const argv = { argvTarea: () => docker.argvTarea({ nombres: docker.nombres('l1', 't1'), rutaCopia: '/c', rutaPedido: '/p', modelo: 'm', effort: 'low', idLote: 'l1', expiraEpoch: 1 }),
        argvAuditor: () => docker.argvAuditor({ nombres: docker.nombres('l1', 't1'), rutaCopia: '/c', modelo: 'm', effort: 'high', idLote: 'l1', expiraEpoch: 1 }),
        argvSoloLectura: () => docker.argvSoloLectura({ nombres: docker.nombres('ro-x', 'ro'), rutaCopia: '/c', volumenHilo: 'ro-hilo-x', modelo: 'm', effort: 'high', idLote: 'ro-x', expiraEpoch: 1 }),
        argvRefrescador: () => docker.argvRefrescador({ nombreContenedor: 'a', nombreRed: 'b', nombreProxy: 'c', idLote: 'x', expiraEpoch: 1, guion: 'g' }) }[nombre]();
      check(`arrancaAgy reconoce el argv de ${nombre} (armado en auto)`, docker.arrancaAgy(argv));
    }
    manual();
    const plomeria = {
      'image inspect (preflight de los lotes de Claude)': ['image', 'inspect', '-f', '{{.Id}}', docker.IMAGEN_AGY],
      'chown del volumen de credencial (compartido con Claude)': docker.argvPrepararVolumenToken('lagrange-tok-x'),
      'chown del volumen del hilo': docker.argvPrepararVolumenHilo('ro-hilo-x'),
      'rm del señuelo': docker.argvLimpiarSenuelo('ro-hilo-x'),
      'agy --version de Proveedores (no invoca al modelo)': ['run', '--rm', '--network', 'none', docker.IMAGEN_AGY, 'agy', '--version'],
      'otra imagen (Claude)': ['run', '--rm', docker.IMAGEN_CLAUDE, 'claude'],
      'mantenimiento (ps)': ['ps', '-a']
    };
    for (const [que, argv] of Object.entries(plomeria)) {
      const antes = corridas.length;
      let e2 = null;
      try { await dockerFalso(argv); } catch (e) { e2 = e; }
      check(`en manual sigue corriendo: ${que}`, !e2 && corridas.length === antes + 1, e2 && e2.message);
    }
    let e3 = null;
    try { await dockerFalso(['run', '--rm', docker.IMAGEN_AGY, 'agy', '--version', '-p', 'x']); } catch (e) { e3 = e; }
    check('agy --version con algo más ya no es plomería', agyModo.esErrorModoManual(e3));
    auto();
    const antes = corridas.length;
    await dockerFalso(['run', '--rm', docker.IMAGEN_AGY, 'agy']);
    check('en auto, la imagen de agy corre', corridas.length === antes + 1);
    manual();
    const { executeAgyStdin } = require(path.join(MCP, 'agy-stream.js'));
    const r = await executeAgyStdin('wsl', 'hola', ['-e', 'docker', 'run', '--rm', docker.IMAGEN_AGY, 'agy'], { cwd: tmp, agregarFormatos: false, timeoutMinutes: 1 });
    check('agy-stream: wsl con la imagen de agy no arranca en manual', r && r.success === false && /manual/i.test(String(r.error || r.stderr || '')), JSON.stringify(r).slice(0, 300));
  });

  await group('lotes: en manual solo con claude@ en escritores, Juez y Advisor (F5)', () => {
    const { execFileSync } = require('node:child_process');
    const R = require(path.join(MCP, 'lotes', 'recetas.js'));
    const { crearRegistro } = require(path.join(MCP, 'lotes', 'registro.js'));
    const { crearServicioLotes } = require(path.join(MCP, 'lotes', 'servicio.js'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');
    git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    // Escribir → Verificar → Advisor → Juez → Vos (el de FEAT-155).
    const grafo = ({ juez = {}, advisor = {} } = {}) => ({
      nodos: { entrada: { tipo: 'entrada' }, esc: { tipo: 'escribir' }, ver: { tipo: 'verificar' }, adv: { tipo: 'advisor', ...advisor }, hum: { tipo: 'humano' }, juez: { tipo: 'juez', ...juez }, vos: { tipo: 'revision' } },
      aristas: [
        { id: 'e-in', desde: 'entrada', puerto: 'sale', hacia: 'esc' },
        { id: 'esc-ok', desde: 'esc', puerto: 'ok', hacia: 'ver' }, { id: 'esc-sc', desde: 'esc', puerto: 'sin-cambios', hacia: 'juez' }, { id: 'esc-err', desde: 'esc', puerto: 'error', hacia: 'vos' },
        { id: 'ver-pasa', desde: 'ver', puerto: 'pasa', hacia: 'adv' }, { id: 'ver-falla', desde: 'ver', puerto: 'falla', hacia: 'adv' }, { id: 'ver-err', desde: 'ver', puerto: 'error', hacia: 'vos' },
        { id: 'adv-ok', desde: 'adv', puerto: 'aprobado', hacia: 'juez' }, { id: 'adv-corr', desde: 'adv', puerto: 'corregir', hacia: 'esc', alAgotar: 'juez' },
        { id: 'adv-hum', desde: 'adv', puerto: 'humano', hacia: 'hum' }, { id: 'adv-err', desde: 'adv', puerto: 'error', hacia: 'vos' },
        { id: 'hum-corr', desde: 'hum', puerto: 'corregir', hacia: 'esc', alAgotar: 'juez' }, { id: 'hum-ok', desde: 'hum', puerto: 'aprobar', hacia: 'juez' }, { id: 'hum-cancel', desde: 'hum', puerto: 'cancelar', hacia: 'vos' },
        { id: 'j-pass', desde: 'juez', puerto: 'pass', hacia: 'vos' }, { id: 'j-fail', desde: 'juez', puerto: 'fail', hacia: 'vos' }, { id: 'j-err', desde: 'juez', puerto: 'error', hacia: 'vos' }
      ]
    });
    const dirDatos = path.join(tmp, 'datos');
    const almacen = R.crearAlmacenRecetas(dirDatos);
    almacen.crear({ id: 'todo-claude', titulo: 'Todo Claude', grafo: grafo({ juez: { motor: 'claude@trabajo', modelo: 'haiku' }, advisor: { motor: 'claude@trabajo' } }) });
    almacen.crear({ id: 'juez-agy', titulo: 'Juez agy', grafo: grafo({ advisor: { motor: 'claude@trabajo' } }) });
    const servicio = crearServicioLotes({
      registro: crearRegistro({ dir: path.join(dirDatos, 'lotes') }), docker: async () => ({ code: 0, stdout: '', stderr: '' }), aWsl: async (x) => x, dirDatos,
      config: { motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } } }, fanoutStatusline: false, fanoutControl: false, fanoutProgressLog: false },
      recolectar: async () => {}, leerCuerpoSkill: (n) => `cuerpo de ${n}`, fanout: async () => ({ lanzado: false }), ejecutarStream: async () => {}, ejecutarStdin: async () => {}
    });
    const base = { slug: 'm191', cwd: repo, tareas: [{ id: 't_a', prompt: 'Cambiar A', archivos: ['a.js'] }] };
    const motivo = (d) => { try { servicio.validarSolicitud(d); return ''; } catch (e) { return e.message; } };
    manual();
    check('todo claude@ (escritor, Juez y Advisor): se acepta', motivo({ ...base, motor: 'claude@trabajo', receta: 'todo-claude' }) === '', motivo({ ...base, motor: 'claude@trabajo', receta: 'todo-claude' }));
    check('escritor en agy: se rechaza y lo nombra', /modo manual/.test(motivo({ ...base, receta: 'todo-claude' })) && /el escritor del lote/.test(motivo({ ...base, receta: 'todo-claude' })));
    check('Juez en agy: se rechaza y lo nombra', /el Juez juez/.test(motivo({ ...base, motor: 'claude@trabajo', receta: 'juez-agy' })));
    check('receta clásica (Juez de agy): se rechaza', /receta sin grafo/.test(motivo({ ...base, motor: 'claude@trabajo' })));
    auto();
    check('en auto, el Juez de agy sigue valiendo', motivo({ ...base, motor: 'claude@trabajo', receta: 'juez-agy' }) === '', motivo({ ...base, motor: 'claude@trabajo', receta: 'juez-agy' }));
    manual();
    const { esLanzadorDeContenedor } = require(path.join(MCP, 'agy-stream.js'));
    check('F1: wsl (Docker) no pasa por la guardia', opcionesDeAgy({ contenedor: true, cwd: 'x' }).cwd === 'x');
    const IMAGEN_AGY = docker.IMAGEN_AGY;
    const claudeArgv = ['-e', 'docker', 'run', '--rm', docker.IMAGEN_CLAUDE, 'bash'];
    check('F1: wsl -e docker con otra imagen es lanzador de contenedor', esLanzadorDeContenedor('wsl', claudeArgv) && esLanzadorDeContenedor('C:\\Windows\\System32\\wsl.exe', claudeArgv));
    check('BE-181 (F14): el nombre del binario ya no alcanza', !esLanzadorDeContenedor('wsl') && !esLanzadorDeContenedor('wsl', ['-e', 'agy', '-p', 'x']) && !esLanzadorDeContenedor('agy.exe', claudeArgv));
    check('BE-181 (F14): un contenedor que arranca agy no es "contenedor" (pasa por la guardia)', !esLanzadorDeContenedor('wsl', ['-e', 'docker', 'run', IMAGEN_AGY, 'bash', '-c', 'agy']) && !esLanzadorDeContenedor('wsl', ['-e', 'docker', 'run', `${IMAGEN_AGY}:1.5`, 'agy', '-p', 'x']));
    check('BE-181 (F1 de la auditoría): la plomería con la imagen de agy sigue siendo contenedor', esLanzadorDeContenedor('wsl', ['-e', 'docker', ...docker.argvPrepararVolumenToken('lagrange-tok-x')]) && esLanzadorDeContenedor('wsl', ['-e', 'docker', 'image', 'inspect', IMAGEN_AGY]));
  });

  await group('F6 y F10: say/narrate con alma y el mensaje (F7, F8 y F13 se prueban por MCP más abajo)', () => {
    const src = fuente('mcp-server/index.js');
    check('argsDeAlma no verifica con agy agents en manual', /if \(!agyModo\.enModoManual\(\) && Date\.now\(\) >= almaVerificadaHasta\)/.test(src));
    check('el mensaje dice cómo salir si el manual viene del entorno', /quitá LAGRANGE_AGY_MODO=manual/.test(agyModo.MENSAJE));
    check('F3: el formato de agy_status', src.includes('- OS: ${process.platform}'));
    const servicio = fuente('mcp-server/lotes/servicio.js');
    const reanudar = servicio.slice(servicio.indexOf('async function reanudar('), servicio.indexOf('adquirirLock(lote.repo', servicio.indexOf('async function reanudar(')));
    check('F15: reanudar exige el lote sin agy antes de tomar el lock', reanudar.includes('exigirLoteSinAgy('));
  });

  await group('F2 y F11: suite hermética y sin caché que falle abierto', () => {
    const { entornoDeTests } = require(path.join(RAIZ, 'scripts', 'entorno-de-tests.js'));
    const e = entornoDeTests({ ...process.env, LAGRANGE_AGY_MODO: 'manual', LAGRANGE_AGY_MODO_CONFIG: '' });
    check('los hijos de la suite no ven la config real ni la variable', /lagrange-tests-sin-config/.test(e.env.LAGRANGE_AGY_MODO_CONFIG) && e.env.LAGRANGE_AGY_MODO === '');
    e.limpiar();
    auto();
    const st = fs.statSync(CONFIG_FALSA);
    fs.writeFileSync(CONFIG_FALSA, JSON.stringify({ agy_modo: 'manual' }));
    fs.utimesSync(CONFIG_FALSA, st.atime, st.mtime);
    check('pasar a manual sin mover el mtime se ve igual', agyModo.enModoManual());
    check('Ajustes normaliza como el runtime ("Manual ")', ajustesGeneral.leerGeneral({ agy_modo: 'Manual ' }).general.agy_modo === 'manual');
  });

  await group('herramientas y bot', async () => {
    const src = fuente('mcp-server/index.js');
    check('handleToolCall frena antes del switch', /const freno = frenoModoManual\(name, args\);\n\s+if \(freno\) return freno;\n\n\s+switch \(name\)/.test(src));
    check('frena agy_run, research, image y fanout', /new Set\(\['agy_run', 'agy_research', 'agy_image', 'agy_fanout'\]\)/.test(src));
    check('frena agy_voice_stream start y agy_lote con motor agy', /name === 'agy_voice_stream'/.test(src) && /name === 'agy_lote' && args\.accion !== 'estado'/.test(src));
    manual();
    const { runAgyArgs } = await import('../telegram-bridge/executor.js');
    let spawns = 0;
    const r = await runAgyArgs(['-p', 'hola'], { spawnFn: () => { spawns++; throw new Error('spawn'); } });
    check('el bot no lanza agy: aviso claro', spawns === 0 && r.success === false && r.error === agyModo.MENSAJE, JSON.stringify(r));
  });

  await group('BE-181 (F16): los frenos por MCP, con el modo cambiado con el servidor vivo', async () => {
    const { startServer } = require('./lib/mcp-client');
    const capture = path.join(tmp, 'capture.jsonl');
    fs.writeFileSync(capture, '');
    auto();
    const agentsLog = path.join(tmp, 'agents.jsonl');
    let lanzadosEnAuto = 0;
    const server = startServer({ cwd: tmp, captureFile: capture, env: { LAGRANGE_AGY_MODO_CONFIG: CONFIG_FALSA, LAGRANGE_AGY_MODO: '', STUB_AGENTS_LOG: agentsLog } });
    const texto = (r) => ((r && r.result && r.result.content) || (r && r.content) || []).map((c) => c.text || '').join(' ');
    const esError = (r) => Boolean((r && r.result && r.result.isError) || (r && r.isError));
    const avisa = (r, etiqueta) => !esError(r) && texto(r).includes(`${etiqueta} — Manual mode is on`);
    try {
      await server.initialize();
      manual();
      auto();
      const abierta = await server.callTool('agy_voice_stream', { action: 'start', message: 'hola', prewarm_voicebox: false });
      const streamId = (/stream_id[^A-Za-z0-9_-]*([A-Za-z0-9_-]{6,})/.exec(texto(abierta)) || [])[1];
      check('F8: en auto la sesión de voz se abre (con el stub)', Boolean(streamId) && !esError(abierta), texto(abierta).slice(0, 300));
      lanzadosEnAuto = fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).length;
      manual();
      for (const action of ['send', 'confirm']) {
        const r = await server.callTool('agy_voice_stream', { action, stream_id: streamId, text: 'hola' });
        check(`F8: la sesión abierta antes del cambio no recibe ${action}`, avisa(r, 'AGY Voice Stream'), texto(r).slice(0, 200));
      }
      const nueva = await server.callTool('agy_voice_stream', { action: 'start', message: 'hola', prewarm_voicebox: false });
      check('F3 de la auditoría: start se frena en manual', avisa(nueva, 'AGY Voice Stream'), texto(nueva).slice(0, 200));
      const st = await server.callTool('agy_voice_stream', { action: 'status', stream_id: streamId });
      check('F8: status no se frena (no lanza agy)', !texto(st).includes('Manual mode is on'), texto(st).slice(0, 200));
      for (const action of ['list', 'register']) {
        const r = await server.callTool('cast_agent', { action, name: 'x' });
        check(`F7: cast_agent ${action} se frena`, avisa(r, 'Cast Agent'), texto(r).slice(0, 200));
      }
      const al = await server.callTool('alma', { action: 'agente' });
      check('F13: alma action:"agente" se frena', avisa(al, 'Alma'), texto(al).slice(0, 200));
    } finally {
      await server.stop();
      auto();
    }
    const lanzados = fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean);
    check('F16: en manual no se lanzó nada (solo el start en auto)', lanzados.filter((l) => !/"event":"kill"/.test(l)).length === lanzadosEnAuto, lanzados.join(' | ').slice(0, 400));
    const agentes = fs.existsSync(agentsLog) ? fs.readFileSync(agentsLog, 'utf8').trim() : '';
    check('F16: ninguna consulta a agy agents (cast_agent, alma)', agentes === '', agentes.slice(0, 300));
  });

  await group('BE-181 (F18): el modo en la barra de la consola', () => {
    const barra = fuente('telegram-bridge/web/public/ui/barra.js');
    const bot = fuente('telegram-bridge/bot.js');
    check('el estado del daemon lleva agyModo', bot.includes('orquestador: orquestadorPorDefecto(), agyModo: modoAgy()'));
    check('la barra muestra "agy: manual" solo en la rama manual', /const manual = d\.agyModo === 'manual';/.test(barra) && /\$\{manual \? html`[^`]*>agy: manual<\/span>` : null\}/.test(barra) && barra.split('>agy: manual<').length === 2);
  });

  await group('Ajustes → General y set_config', () => {
    const datos = ajustesGeneral.aplicarGeneral({}, { agy_modo: 'manual' });
    check('Ajustes guarda manual', datos.agy_modo === 'manual');
    check('auto borra la clave (es el default)', !('agy_modo' in ajustesGeneral.aplicarGeneral({ agy_modo: 'manual' }, { agy_modo: 'auto' })));
    let err = null;
    try { ajustesGeneral.aplicarGeneral({}, { agy_modo: 'a-medias' }); } catch (e) { err = e; }
    check('un valor inválido se rechaza', err && err.campo === 'general.agy_modo');
    check('leerGeneral lo devuelve', ajustesGeneral.leerGeneral({ agy_modo: 'manual' }).general.agy_modo === 'manual');
    const web = fuente('telegram-bridge/web/public/ui/ajustes-general.js');
    check('la consola lo manda al guardar y tiene su tarjeta', /'orquestacion_modo', 'agy_modo'\]/.test(web) && /function TarjetaModoAgy/.test(web));
    const src = fuente('mcp-server/index.js');
    check('set_config: solo global', /`agy_modo` solo se guarda con scope "global"/.test(src));
  });

  auto();
}

main()
  .then(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(report() ? 0 : 1); })
  .catch((err) => { console.error(err); process.exit(1); });
