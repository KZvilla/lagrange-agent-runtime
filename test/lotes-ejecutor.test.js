/**
 * FEAT-061 fase 2 — El ejecutor en contenedor, su encaje con el orquestador y
 * la opción nueva de agy-stream.
 *
 * Todo con dobles: ni Docker ni agy. Lo que se fija acá es el ORDEN (red →
 * proxy → run → esperar al contenedor → sincronizar → commit → bajar) y las
 * tres salidas en las que NO hay que sincronizar: detenida, vencida y con
 * error. Esas tres fueron hallazgos de auditoría, no casos hipotéticos.
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { crearEjecutorContenedor, sanearId } = require('../mcp-server/lotes/ejecutor.js');
const { reglasDelSubagente, lanzarFanout } = require('../mcp-server/fanout.js');
const { executeAgyStreaming } = require('../mcp-server/agy-stream.js');

const raizTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-ejecutor-'));

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

function repoNuevo(nombre) {
  const dir = path.join(raizTmp, nombre);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, ['init', '-q', '-b', 'principal']);
  git(dir, ['config', 'user.email', 'test@test']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'original\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'inicial']);
  return dir;
}

/**
 * Docker falso que además registra el orden de las llamadas y simula un
 * contenedor que sigue existiendo un rato después de que muere el cliente
 * (que es lo que S10 midió en la máquina real).
 */
function dockerFalso({ vidaExtra = 1 } = {}) {
  const llamadas = [];
  let consultasExiste = 0;
  const docker = async (args) => {
    llamadas.push(args.join(' '));
    if (args[0] === 'ps') {
      consultasExiste++;
      return { code: 0, stdout: consultasExiste <= vidaExtra ? 'lote-l1-t1\n' : '', stderr: '' };
    }
    // `levantarProxy` pregunta si el proxy quedó corriendo antes de seguir.
    if (args[0] === 'inspect') return { code: 0, stdout: 'true\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { docker, llamadas };
}

function ejecutorDePrueba({ docker, repo, resultado, capturarArgv = {}, onLine }) {
  return crearEjecutorContenedor({
    docker,
    ejecutarStream: async (bin, args, opciones) => {
      capturarArgv.bin = bin;
      capturarArgv.args = args;
      capturarArgv.opciones = opciones;
      // El agente "trabaja": edita dentro de lo declarado, y de paso intenta
      // algo fuera.
      const copia = args[args.indexOf('-v') + 1].split(':')[0];
      const local = capturarArgv.dirCopia;
      if (local && fs.existsSync(local)) {
        fs.writeFileSync(path.join(local, 'src', 'a.js'), 'editado por el agente\n');
        fs.writeFileSync(path.join(local, 'fuera.js'), 'no deberia entrar\n');
      }
      void copia;
      if (opciones.onLine) opciones.onLine('{"event":"init"}');
      return resultado;
    },
    credenciales: { asegurarVida: async () => Date.now() + 3600000, destruir: async () => {}, volumenToken: 'lote-l1-token', volumenSecretoProxy: 'lote-l1-proxy-secreto' },
    idLote: 'l1',
    raizCopias: path.join(raizTmp, 'copias'),
    expiraEpoch: 99,
    aWsl: async (r) => `/mnt/c${String(r).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')}`,
    onLine,
    timeoutMinutesPorDefecto: 45
  });
}

async function correr({ resultado, repo, docker, capturar = {}, onLine }) {
  capturar.dirCopia = path.join(raizTmp, 'copias', 'l1', 't1');
  const ejecutar = ejecutorDePrueba({ docker, repo, resultado, capturarArgv: capturar, onLine });
  const res = await ejecutar({
    taskId: 't1',
    cwd: repo,
    prompt: 'hacé algo',
    archivos: ['src/'],
    model: 'gemini-3.8-flash',
    timeout_minutes: 10
  });
  return res;
}

async function main() {
  await group('saneo de ids', () => {
    check('un id normal queda igual', sanearId('backend') === 'backend');
    check('un punto se reemplaza', /^a-b-[0-9a-f]{6}$/.test(sanearId('a.b')), sanearId('a.b'));
    check('una barra se reemplaza', /^a-b-[0-9a-f]{6}$/.test(sanearId('a/b')), sanearId('a/b'));
    // Sin el sufijo, `a.b` y `a/b` producirían el mismo nombre de contenedor y
    // la misma carpeta de copia para dos tareas que corren a la vez.
    check('dos ids distintos no colisionan al sanearse', sanearId('a.b') !== sanearId('a/b'));
    check('el saneo es estable', sanearId('a.b') === sanearId('a.b'));
    check('un id vacío tiene respaldo', sanearId('') === 'tarea');
  });

  await group('camino feliz: orden, sincronización y commit', async () => {
    const repo = repoNuevo('feliz');
    const { docker, llamadas } = dockerFalso();
    const capturar = {};
    const res = await correr({ resultado: { success: true, data: { conversation_id: 'c1' } }, repo, docker, capturar });

    const orden = llamadas.map(l => l.split(' ').slice(0, 2).join(' '));
    // Ojo con findIndex: antes de crear nada, el ejecutor barre restos de una
    // corrida anterior (rm -f, network rm), asi que hay que mirar la ULTIMA
    // aparicion de las bajas, no la primera.
    const iRed = llamadas.findIndex(l => l.startsWith('network create'));
    const iProxy = llamadas.findIndex(l => l.startsWith('run -d'));
    const iStop = llamadas.findIndex(l => l.startsWith('stop -t'));
    const iWait = llamadas.findIndex(l => l.startsWith('wait '));
    const iBaja = llamadas.lastIndexOf(llamadas.filter(l => l.startsWith('network rm')).pop());

    check('crea la red antes que el proxy', iRed >= 0 && iRed < iProxy, orden.join(' | '));
    check('espera al contenedor (stop + wait)', iStop > iProxy && iWait > iStop);
    check('baja la red al final', iBaja > iWait);

    check('la tarea sale bien', res.success === true);
    check('devuelve el commit', typeof res.commit === 'string' && res.commit.length > 0);
    check('el worktree quedó con la edición', fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8') === 'editado por el agente\n');
    check('el archivo fuera de lo declarado NO entró', !fs.existsSync(path.join(repo, 'fuera.js')));
    check('y quedó como anomalía', res.anomalias.some(a => /fuera de los archivos declarados/.test(a.motivo)));
    check('el commit lleva el id del lote y de la tarea', git(repo, ['log', '-1', '--pretty=%s']).trim() === 'lote l1: tarea t1');
    check('la copia se borra al terminar', !fs.existsSync(capturar.dirCopia));
    check('el prompt NO viaja en el argv', !capturar.args.join(' ').includes('hacé algo'));
    check('el prompt viaja por el montaje /pedido', capturar.args.join(' ').includes(':/pedido:ro'));
    check('no le agrega --output-format al argv de wsl', capturar.opciones.agregarOutputFormat === false);
    check('el binario es wsl', capturar.bin === 'wsl');
  });

  await group('prompt de 90 KB', async () => {
    const repo = repoNuevo('grande');
    const { docker } = dockerFalso();
    const capturar = { dirCopia: path.join(raizTmp, 'copias', 'l1', 't1') };
    const ejecutar = ejecutorDePrueba({ docker, repo, resultado: { success: true, data: {} }, capturarArgv: capturar });
    const prompt = 'x'.repeat(90 * 1024);
    await ejecutar({ taskId: 't1', cwd: repo, prompt, archivos: ['src/'], timeout_minutes: 10 });
    check('un prompt de 90 KB no aparece en el argv', !capturar.args.some(a => a.length > 8192));
    check('el argv se mantiene corto', capturar.args.join(' ').length < 4096);
  });

  for (const [nombre, resultado] of [
    ['detenida (FEAT-012)', { success: false, stopped: true, error: 'Detenido por el usuario', motivo: 'a mano' }],
    ['vencida por el watchdog', { success: false, error: 'Antigravity MCP process watchdog timed out after 10 minutes' }],
    ['con error de agy', { success: false, error: 'Antigravity CLI exited with code 1.' }]
  ]) {
    await group(`una tarea ${nombre} no toca el worktree`, async () => {
      const repo = repoNuevo(`sin-sync-${nombre.replace(/[^a-z]/gi, '')}`);
      const antes = git(repo, ['rev-parse', 'HEAD']).trim();
      const { docker, llamadas } = dockerFalso();
      const res = await correr({ resultado, repo, docker });

      check('no commitea', res.commit === null);
      check('el worktree queda como estaba', fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8') === 'original\n');
      check('sin commits nuevos', git(repo, ['rev-parse', 'HEAD']).trim() === antes);
      check('sin cambios sin commitear', git(repo, ['status', '--porcelain']).trim() === '');
      check('igual espera al contenedor antes de limpiar',
        llamadas.findIndex(l => l.startsWith('wait '))
        < llamadas.lastIndexOf(llamadas.filter(l => l.startsWith('network rm')).pop()));
    });
  }

  await group('la limpieza no empieza antes de que el contenedor muera', async () => {
    const repo = repoNuevo('espera');
    // El contenedor sigue existiendo en las dos primeras consultas.
    const { docker, llamadas } = dockerFalso({ vidaExtra: 2 });
    await correr({ resultado: { success: true, data: {} }, repo, docker });
    const consultas = llamadas.filter(l => l.startsWith('ps -a')).length;
    check('reconsulta hasta que el contenedor desaparece', consultas >= 3, `consultas: ${consultas}`);
    const ultimaConsulta = llamadas.map((l, i) => l.startsWith('ps -a') ? i : -1).filter(i => i >= 0).pop();
    const ultimaBaja = llamadas.map((l, i) => l.startsWith('network rm') ? i : -1).filter(i => i >= 0).pop();
    check('recién después baja la red', ultimaConsulta < ultimaBaja);
  });

  await group('el log de progreso (FEAT-009)', async () => {
    const repo = repoNuevo('progreso');
    const { docker } = dockerFalso();
    const lineas = [];
    await correr({ resultado: { success: true, data: {} }, repo, docker, onLine: (l) => lineas.push(l) });
    check('onLine recibe las líneas NDJSON del contenedor', lineas.length === 1 && lineas[0].includes('"event":"init"'));
  });

  await group('invariantes: un argv comprometido no corre', async () => {
    const repo = repoNuevo('invariante');
    const { docker, llamadas } = dockerFalso();
    const ejecutar = crearEjecutorContenedor({
      docker,
      ejecutarStream: async () => { throw new Error('no debería haberse ejecutado'); },
      credenciales: { asegurarVida: async () => 0, volumenSecretoProxy: 'lote-l1-proxy-secreto' },
      idLote: 'l1',
      raizCopias: path.join(raizTmp, 'copias'),
      expiraEpoch: 1,
      // Un traductor de rutas comprometido: devuelve un montaje del disco del host.
      aWsl: async () => '/mnt/c/Users:/host -v /var/run/docker.sock',
      timeoutMinutesPorDefecto: 10
    });
    const res = await ejecutar({ taskId: 't1', cwd: repo, prompt: 'x', archivos: ['src/'] });
    check('no se ejecuta nada', res.success === false);
    check('el error nombra los invariantes', /invariantes/.test(res.error), res.error);
    check('nunca se corrió el contenedor', !llamadas.some(l => l.startsWith('run --rm --name lote-l1-t1 ')));
  });

  await group('reglas del subagente', () => {
    const tarea = { id: 't', prompt: 'hacelo', archivos: ['src/a.js'] };
    const normal = reglasDelSubagente(tarea);
    const enContenedor = reglasDelSubagente(tarea, { contenedor: true });

    check('sin contenedor, el prompt es el de siempre', normal.includes('git worktree propio y aislado')
      && normal.includes('commiteá tu trabajo en la rama actual'));
    check('con contenedor, el directorio es /trabajo sin git', enContenedor.includes('`/trabajo`') && enContenedor.includes('SIN git'));
    check('con contenedor, NO se le pide commit', !enContenedor.includes('commiteá tu trabajo en la rama actual'));
    check('con contenedor, se le dice que no use git', enContenedor.includes('NO uses git'));
    check('las demás reglas no cambian', ['No modifiques ningún otro', 'NO escribas ni ejecutes tests', 'NO invoques subagentes']
      .every(r => normal.includes(r) && enContenedor.includes(r)));
    check('la tarea sigue al final', enContenedor.trim().endsWith('hacelo'));
  });

  await group('lanzarFanout con contenedor', async () => {
    const repo = repoNuevo('fanout');
    const peticiones = [];
    const salida = await lanzarFanout({
      repoPath: repo,
      slug: 'lote1',
      tareas: [{ id: 't1', prompt: 'p', archivos: ['src/a.js'] }],
      contenedor: true
    }, {
      ejecutar: async (peticion) => {
        peticiones.push(peticion);
        return { success: true, commit: 'deadbee', anomalias: [{ ruta: 'x', motivo: 'y' }], conversation_id: 'c' };
      }
    });

    check('la petición lleva los archivos declarados', peticiones[0].archivos.join(',') === 'src/a.js');
    check('el prompt es el de contenedor', peticiones[0].prompt.includes('SIN git'));
    check('el commit llega al resultado', salida.resultados[0].commit === 'deadbee');
    check('las anomalías llegan al resultado', salida.resultados[0].anomalias.length === 1);

    // Y sin la opción, nada cambia para agy_fanout.
    const repo2 = repoNuevo('fanout-normal');
    const salida2 = await lanzarFanout({
      repoPath: repo2,
      slug: 'lote2',
      tareas: [{ id: 't1', prompt: 'p', archivos: ['src/a.js'] }]
    }, { ejecutar: async (p) => { peticiones.push(p); return { success: true }; } });

    const normal = peticiones[peticiones.length - 1];
    check('sin contenedor el prompt sigue pidiendo commit', normal.prompt.includes('commiteá tu trabajo'));
    check('sin contenedor commit queda null', salida2.resultados[0].commit === null);
    check('sin contenedor anomalias queda vacío', salida2.resultados[0].anomalias.length === 0);
  });

  await group('agy-stream: agregarOutputFormat', async () => {
    // Un guion que imprime sus propios argumentos: alcanza para ver qué argv se
    // armó, sin depender de agy. Tiene que ser un ARCHIVO y no `node -e`,
    // porque con `-e` los flags de después se los queda node.
    const guion = path.join(raizTmp, 'eco-argv.js');
    fs.writeFileSync(guion, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n');

    const porDefecto = [];
    await executeAgyStreaming(process.execPath, [guion], { timeoutMinutes: 1, onLine: (l) => porDefecto.push(l) });
    const conOpcion = [];
    await executeAgyStreaming(process.execPath, [guion], {
      timeoutMinutes: 1, agregarOutputFormat: false, onLine: (l) => conOpcion.push(l)
    });

    check('por defecto agrega --output-format stream-json', /--output-format.*stream-json/.test(porDefecto.join('')), porDefecto.join(''));
    check('con agregarOutputFormat:false no lo agrega', !/--output-format/.test(conOpcion.join('')), conOpcion.join(''));
    check('y el resto del argv no cambia', conOpcion.join('') === '[]');
  });

  try { fs.rmSync(raizTmp, { recursive: true, force: true }); } catch {}
  report();
}

main();
