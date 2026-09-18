/**
 * Argumentos de docker para el ejecutor de lotes (FEAT-061 fase 2).
 *
 * POR QUÉ ESTE MÓDULO ES SOLO ARGV
 * --------------------------------
 * El contenedor es la ÚNICA frontera real que tenemos. Las sondas del RFC
 * (§4.1) mostraron que agy con herramientas de escritura escribe y edita fuera
 * de su worktree aun sin `--dangerously-skip-permissions`, y que `allow`/`deny`
 * son texto en el prompt, no controles. Lo que sí confina —medido en disco— es
 * Docker con la red `--internal` y un proxy con allowlist.
 *
 * Por eso el argv se arma en funciones PURAS: son la superficie de seguridad de
 * la feature, y un test puede fijarlas carácter a carácter sin levantar Docker.
 * Si alguien agrega un `-v` de más, un `--privileged` o el socket de Docker, el
 * test de invariantes lo ve. Un argv armado a mano dentro del ejecutor, entre
 * `await`s, no se puede auditar así.
 *
 * El único lugar que ejecuta algo es `crearDocker`, que además existe para que
 * los tests inyecten un `docker` falso y ejerciten el ejecutor entero sin WSL.
 */
const { execFile } = require('node:child_process');

// Nombres de imagen: versionadas en el repo (mcp-server/lotes/imagenes/) y
// construidas con `npm run lotes -- imagenes`. El auto-actualizador de agy
// queda bloqueado por la allowlist: actualizar agy = reconstruir la imagen.
const IMAGEN_AGY = 'lagrange-lote-agy';
const IMAGEN_PROXY = 'lagrange-lote-proxy';

// El volumen con el OAuth real del usuario. NUNCA se monta en el contenedor de
// una tarea: solo lo ve el refrescador (credenciales.js).
const VOLUMEN_CREDENCIALES = 'agy-credenciales';

const ETIQUETA_LOTE = 'lagrange.lote';
const ETIQUETA_EXPIRA = 'lagrange.expira';

// uid/gid del usuario `agy` dentro de la imagen. Fijo acá porque el `--tmpfs`
// del home necesita el número, no el nombre.
const UID_AGY = 1001;
const GID_AGY = 1001;

const PUERTO_PROXY = 8888;

// `nobody` en Alpine, que es la imagen del proxy.
const UID_NOBODY = 65534;
const GID_NOBODY = 65534;

/**
 * Los identificadores viajan a nombres de contenedor, de red y de volumen, y de
 * ahí a una línea de comandos. Un id con `/`, `:` o `..` es una inyección de
 * argumentos esperando a pasar, así que se rechaza acá y no más adelante.
 */
function validarId(valor, que = 'id') {
  const texto = String(valor == null ? '' : valor);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(texto)) {
    throw new Error(`${que} inválido para Docker: ${JSON.stringify(texto)}. Solo letras, dígitos, "-" y "_", empezando por letra o dígito, hasta 64.`);
  }
  return texto;
}

/**
 * Igual de estricto, pero admitiendo el punto: los modelos se llaman
 * `gemini-3.8-flash`. Sigue sin admitir espacios, comillas ni barras, que es lo
 * que haría falta para colarse en el `bash -c` del contenedor.
 */
function validarOpcionCli(valor, que = 'opción') {
  const texto = String(valor == null ? '' : valor);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(texto)) {
    throw new Error(`${que} inválida: ${JSON.stringify(texto)}. Solo letras, dígitos, ".", "-" y "_".`);
  }
  return texto;
}

function nombres(idLote, n) {
  const id = validarId(idLote, 'id del lote');
  const tarea = validarId(n, 'id de la tarea');
  return {
    contenedor: `lote-${id}-${tarea}`,
    red: `lote-${id}-${tarea}-red`,
    proxy: `lote-${id}-${tarea}-proxy`,
    token: `lote-${id}-token`
  };
}

function etiquetas(idLote, expiraEpoch) {
  return [
    '--label', `${ETIQUETA_LOTE}=${validarId(idLote, 'id del lote')}`,
    '--label', `${ETIQUETA_EXPIRA}=${Math.trunc(Number(expiraEpoch) || 0)}`
  ];
}

function argvCrearRed(nombreRed, idLote, expiraEpoch) {
  return ['network', 'create', '--internal', ...etiquetas(idLote, expiraEpoch), validarId(nombreRed, 'nombre de red')];
}

function argvBorrarRed(nombreRed) {
  return ['network', 'rm', validarId(nombreRed, 'nombre de red')];
}

/**
 * El proxy vive en DOS redes: la `--internal` del contenedor (donde lo alcanza
 * el agente) y `bridge` (que es su única salida a internet). El agente no está
 * en `bridge`: por eso el proxy es el cuello de botella obligatorio y la
 * allowlist significa algo.
 */
function argvProxy({ nombreProxy, nombreRed, archivoPermitidos, idLote, expiraEpoch }) {
  return [
    // Sin `--rm`: si el proxy se cae al arrancar, con `--rm` desaparece y con
    // él sus logs, y el fallo llega como un críptico "container is marked for
    // removal" al conectar la red. Lo borra `rm -f` en el `finally` y, si algo
    // falla antes, el recolector por etiqueta.
    'run', '-d',
    '--name', validarId(nombreProxy, 'nombre del proxy'),
    '--network', validarId(nombreRed, 'nombre de red'),
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    // Como `nobody` desde el arranque: con las capacidades quitadas, tinyproxy
    // no puede hacer el setuid/setgid él mismo y sale con 77 (medido).
    '--user', `${UID_NOBODY}:${GID_NOBODY}`,
    '--read-only',
    '--tmpfs', '/tmp',
    '-v', `${archivoPermitidos}:/etc/tinyproxy/permitidos:ro`,
    ...etiquetas(idLote, expiraEpoch),
    IMAGEN_PROXY
  ];
}

/**
 * Levanta el proxy y CONFIRMA que quedó corriendo.
 *
 * `docker run -d` devuelve un id aunque el proceso de adentro se muera a los
 * milisegundos. Sin esta confirmación, el error que ve el usuario es el de la
 * operación siguiente ("container is marked for removal and cannot be
 * connected to the network"), que no dice nada de lo que pasó. Esto pasó en la
 * primera corrida real: tinyproxy salía con 77 y el lote fallaba sin explicar
 * por qué.
 */
async function levantarProxy(docker, argv, nombreProxy) {
  await docker(argv);
  const estado = await docker(['inspect', '-f', '{{.State.Running}}', validarId(nombreProxy, 'nombre del proxy')], { permitirFallo: true });
  if (String(estado.stdout || '').trim() === 'true') return true;

  const logs = await docker(['logs', nombreProxy], { permitirFallo: true });
  const salida = `${logs.stdout || ''}${logs.stderr || ''}`.trim().slice(0, 300) || '(sin salida)';
  throw new Error(`el proxy ${nombreProxy} no se quedó corriendo: ${salida}`);
}

function argvConectarBridge(nombreProxy) {
  return ['network', 'connect', 'bridge', validarId(nombreProxy, 'nombre del proxy')];
}

/**
 * El comando que corre DENTRO del contenedor.
 *
 * Dos decisiones que no son cosméticas:
 *  - el token se copia del montaje RO al `tmpfs` del home porque agy reescribe
 *    su directorio de config al arrancar (medido en S8), y `/token` es RO;
 *  - el prompt entra por `$(cat /pedido/PROMPT.md)` y no por el argv de
 *    `wsl.exe`, que tiene techo de 32 KB en Windows. Adentro es un argumento de
 *    Linux (128 KB) y el tope de la tool es 100 KB.
 */
function comandoInterno({ modelo, effort }) {
  const flags = ['--dangerously-skip-permissions', '--mode', 'accept-edits', '--output-format', 'stream-json'];
  if (effort) flags.push('--effort', validarOpcionCli(effort, 'effort'));
  if (modelo) flags.push('--model', validarOpcionCli(modelo, 'modelo'));
  return `cp -r /token/. "$HOME/" && exec agy ${flags.join(' ')} -p "$(cat /pedido/PROMPT.md)"`;
}

/**
 * El contenedor de una tarea. Todo lo que no está acá, el agente no lo tiene:
 * ni red fuera de la `--internal`, ni credenciales con `refresh_token`, ni
 * escritura fuera de `/trabajo`, ni capacidades, ni el socket de Docker.
 */
function argvTarea({ nombres: n, rutaCopia, rutaPedido, modelo, effort, idLote, expiraEpoch }) {
  return [
    'run', '--rm',
    '--name', validarId(n.contenedor, 'nombre del contenedor'),
    '--network', validarId(n.red, 'nombre de red'),
    '--read-only',
    '--tmpfs', '/tmp',
    '--tmpfs', `/home/agy:uid=${UID_AGY},gid=${GID_AGY},mode=700`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=256',
    '--memory=2g',
    '--cpus=2',
    '--user', `${UID_AGY}:${GID_AGY}`,
    '-v', `${rutaCopia}:/trabajo`,
    '-v', `${rutaPedido}:/pedido:ro`,
    '-v', `${validarId(n.token, 'volumen de token')}:/token:ro`,
    '-w', '/trabajo',
    '-e', `HTTPS_PROXY=http://${n.proxy}:${PUERTO_PROXY}`,
    '-e', `HTTP_PROXY=http://${n.proxy}:${PUERTO_PROXY}`,
    '-e', 'NO_PROXY=',
    ...etiquetas(idLote, expiraEpoch),
    IMAGEN_AGY,
    'bash', '-c', comandoInterno({ modelo, effort })
  ];
}

/**
 * El refrescador es el único que ve el volumen con el `refresh_token` real, y
 * lo ve en su propia red, con la allowlist ampliada (`oauth2.googleapis.com`).
 * Corre un turno trivial: lo único que nos interesa es el efecto secundario de
 * que agy renueve el token (medido en S6).
 */
function argvRefrescador({ nombreContenedor, nombreRed, nombreProxy, idLote, expiraEpoch, guion }) {
  return [
    'run', '--rm',
    '--name', validarId(nombreContenedor, 'nombre del refrescador'),
    '--network', validarId(nombreRed, 'nombre de red'),
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user', `${UID_AGY}:${GID_AGY}`,
    '-v', `${VOLUMEN_CREDENCIALES}:/home/agy`,
    '-v', `${validarId(`lote-${validarId(idLote, 'id del lote')}-token`, 'volumen de token')}:/token`,
    '-e', `HTTPS_PROXY=http://${nombreProxy}:${PUERTO_PROXY}`,
    '-e', `HTTP_PROXY=http://${nombreProxy}:${PUERTO_PROXY}`,
    '-e', 'NO_PROXY=',
    ...etiquetas(idLote, expiraEpoch),
    IMAGEN_AGY,
    'bash', '-c', guion
  ];
}

/**
 * Un volumen nuevo nace propiedad de root, y el refrescador corre como uid
 * 1001: sin este paso no puede escribir el token exportado. Es un contenedor
 * descartable que solo hace `chown`, y el único que corre como root.
 */
function argvPrepararVolumenToken(nombreVolumen) {
  return [
    'run', '--rm',
    '--user', '0:0',
    '--network', 'none',
    '-v', `${validarId(nombreVolumen, 'nombre de volumen')}:/token`,
    IMAGEN_AGY,
    'chown', `${UID_AGY}:${GID_AGY}`, '/token'
  ];
}

function argvStop(nombreContenedor, segundos = 10) {
  return ['stop', '-t', String(Math.trunc(segundos)), validarId(nombreContenedor, 'nombre del contenedor')];
}

function argvWait(nombreContenedor) {
  return ['wait', validarId(nombreContenedor, 'nombre del contenedor')];
}

function argvRmForzado(nombreContenedor) {
  return ['rm', '-f', validarId(nombreContenedor, 'nombre del contenedor')];
}

function argvExiste(nombreContenedor) {
  return ['ps', '-a', '--filter', `name=^${validarId(nombreContenedor, 'nombre del contenedor')}$`, '--format', '{{.Names}}'];
}

function argvCrearVolumen(nombreVolumen) {
  return ['volume', 'create', validarId(nombreVolumen, 'nombre de volumen')];
}

function argvBorrarVolumen(nombreVolumen) {
  return ['volume', 'rm', '-f', validarId(nombreVolumen, 'nombre de volumen')];
}

function argvListarPorEtiqueta(tipo) {
  if (tipo === 'contenedores') return ['ps', '-a', '--filter', `label=${ETIQUETA_LOTE}`, '--format', '{{.Names}}\t{{.Label "lagrange.lote"}}\t{{.Label "lagrange.expira"}}'];
  if (tipo === 'redes') return ['network', 'ls', '--filter', `label=${ETIQUETA_LOTE}`, '--format', '{{.Name}}\t{{.Label "lagrange.lote"}}\t{{.Label "lagrange.expira"}}'];
  if (tipo === 'volumenes') return ['volume', 'ls', '--filter', `label=${ETIQUETA_LOTE}`, '--format', '{{.Name}}\t{{.Label "lagrange.lote"}}\t{{.Label "lagrange.expira"}}'];
  throw new Error(`tipo desconocido para listar: ${tipo}`);
}

/**
 * Invariantes de seguridad del argv de una tarea, comprobables sin Docker.
 *
 * Existe como función (y no solo como test) para poder llamarla también en
 * caliente antes de un `docker run`: es barata y convierte "confiamos en que
 * nadie agregó un montaje" en una comprobación.
 */
function verificarInvariantes(argv) {
  const problemas = [];
  const texto = argv.join(' ');

  if (/docker\.sock/.test(texto)) problemas.push('el argv monta el socket de Docker');
  if (argv.includes('--privileged')) problemas.push('el argv usa --privileged');
  if (argv.some(a => /^--cap-add/.test(a))) problemas.push('el argv agrega capacidades');
  if (argv.some(a => /^--pid(=|$)/.test(a) || /^--ipc(=|$)/.test(a))) problemas.push('el argv comparte espacios de nombres del host');
  if (!argv.includes('--cap-drop=ALL')) problemas.push('falta --cap-drop=ALL');
  if (!argv.includes('--security-opt=no-new-privileges')) problemas.push('falta --security-opt=no-new-privileges');
  if (!argv.includes('--read-only')) problemas.push('falta --read-only');

  const redes = argv.filter((a, i) => argv[i - 1] === '--network');
  if (redes.some(r => r === 'host' || r === 'bridge')) problemas.push('el contenedor de la tarea no puede estar en host ni en bridge');

  const montajes = argv.filter((a, i) => argv[i - 1] === '-v');
  for (const m of montajes) {
    const destino = m.split(':')[1];
    const modo = m.split(':')[2] || 'rw';
    if (!['/trabajo', '/pedido', '/token'].includes(destino)) {
      problemas.push(`montaje inesperado en ${destino}`);
      continue;
    }
    if (destino !== '/trabajo' && modo !== 'ro') problemas.push(`${destino} tiene que ser de solo lectura`);
    if (destino === '/trabajo' && modo === 'ro') problemas.push('/trabajo tiene que ser escribible');
  }
  if (montajes.some(m => m.includes(`${VOLUMEN_CREDENCIALES}:`))) {
    problemas.push('el contenedor de la tarea no puede ver el volumen de credenciales');
  }

  return problemas;
}

/**
 * El único punto que ejecuta Docker. Todo pasa por `wsl -e docker …` porque el
 * Docker que usamos vive dentro de WSL, no en Windows.
 */
function crearDocker({ ejecutarComando, wslBin = 'wsl', timeoutMs = 120000 } = {}) {
  const correr = ejecutarComando || ((bin, args, opciones) => new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: opciones.timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || err && err.message || '')
      });
    });
  }));

  return async function docker(args, { permitirFallo = false, timeoutMs: propio } = {}) {
    const r = await correr(wslBin, ['-e', 'docker', ...args], { timeoutMs: propio || timeoutMs });
    if (r.code !== 0 && !permitirFallo) {
      throw new Error(`docker ${args.slice(0, 3).join(' ')} falló (${r.code}): ${String(r.stderr || '').trim().slice(0, 300)}`);
    }
    return r;
  };
}

/**
 * Traduce una ruta de Windows a la que ve Docker dentro de WSL. Se le pregunta
 * a `wslpath` en vez de construirla a mano (`C:\x` → `/mnt/c/x`) porque el
 * prefijo depende de la config de WSL, y equivocarse acá significa montar un
 * directorio que no es el que creímos.
 */
function crearTraductorDeRutas({ ejecutarComando, wslBin = 'wsl' } = {}) {
  const correr = ejecutarComando || ((bin, args) => new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  }));

  return async function aRutaWsl(rutaWindows) {
    const r = await correr(wslBin, ['-e', 'wslpath', '-a', String(rutaWindows).replace(/\\/g, '/')], {});
    const salida = String(r.stdout || '').trim();
    if (r.code !== 0 || !salida) {
      throw new Error(`no se pudo traducir ${rutaWindows} a una ruta de WSL: ${String(r.stderr || '').trim().slice(0, 200)}`);
    }
    return salida;
  };
}

module.exports = {
  crearTraductorDeRutas,
  IMAGEN_AGY,
  IMAGEN_PROXY,
  VOLUMEN_CREDENCIALES,
  ETIQUETA_LOTE,
  ETIQUETA_EXPIRA,
  UID_AGY,
  GID_AGY,
  PUERTO_PROXY,
  UID_NOBODY,
  GID_NOBODY,
  validarId,
  validarOpcionCli,
  nombres,
  etiquetas,
  comandoInterno,
  argvCrearRed,
  argvBorrarRed,
  argvProxy,
  levantarProxy,
  argvConectarBridge,
  argvTarea,
  argvRefrescador,
  argvStop,
  argvWait,
  argvRmForzado,
  argvExiste,
  argvPrepararVolumenToken,
  argvCrearVolumen,
  argvBorrarVolumen,
  argvListarPorEtiqueta,
  verificarInvariantes,
  crearDocker
};
