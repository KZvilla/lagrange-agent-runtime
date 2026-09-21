/**
 * Argumentos de docker para el ejecutor de lotes (FEAT-061 fase 2b).
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
const IMAGEN_VERIFICADOR = 'lagrange-lote-verificador-node';

// El volumen con el OAuth real del usuario. NUNCA se monta en el contenedor de
// una tarea: solo lo ve el refrescador (credenciales.js).
const VOLUMEN_CREDENCIALES = 'agy-credenciales';
const VOLUMEN_CA_PRIVADA = 'lagrange-lote-proxy-ca-privada';
const VOLUMEN_CA_PUBLICA = 'lagrange-lote-proxy-ca-publica';

const ETIQUETA_LOTE = 'lagrange.lote';
const ETIQUETA_EXPIRA = 'lagrange.expira';

// uid/gid del usuario `agy` dentro de la imagen. Fijo acá porque el `--tmpfs`
// del home necesita el número, no el nombre.
const UID_AGY = 1001;
const GID_AGY = 1001;

const PUERTO_PROXY = 8888;

function sanitizarSalida(valor) {
  return String(valor || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTADO]')
    .replace(/\bya29\.[A-Za-z0-9._~-]{10,}/gi, '[GOOGLE TOKEN REDACTADO]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g, '[JWT REDACTADO]')
    .replace(/lagrange-falso-[0-9a-f]{16,}/gi, '[TOKEN REDACTADO]');
}

// El proxy comparte uid con el refrescador: este escribe sus secretos 0600 y
// iron-proxy puede leerlos sin abrir permisos al resto del contenedor.
const UID_PROXY = UID_AGY;
const GID_PROXY = GID_AGY;

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
    token: `lote-${id}-token`,
    secretoProxy: `lote-${id}-proxy-secreto`
    , verificador: `lote-${id}-${tarea}-verificador`
    , auditor: `lote-${id}-${tarea}-auditor`
    , redAuditor: `lote-${id}-${tarea}-auditor-red`
    , proxyAuditor: `lote-${id}-${tarea}-auditor-proxy`
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
function argvProxy({ nombreProxy, nombreRed, perfil, volumenSecreto, idLote, expiraEpoch }) {
  if (!['tarea', 'refrescador'].includes(perfil)) throw new Error(`perfil de proxy inválido: ${perfil}`);
  if (perfil === 'tarea' && !volumenSecreto) throw new Error('el proxy de tarea necesita su volumen secreto');
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
    '--user', `${UID_PROXY}:${GID_PROXY}`,
    '--read-only',
    '--tmpfs', `/tmp:uid=${UID_PROXY},gid=${GID_PROXY},mode=700`,
    '-v', `${VOLUMEN_CA_PRIVADA}:/ca:ro`,
    ...(perfil === 'tarea' ? ['-v', `${validarId(volumenSecreto, 'volumen secreto')}:/secret:ro`] : []),
    ...etiquetas(idLote, expiraEpoch),
    IMAGEN_PROXY,
    'serve', perfil
  ];
}

/**
 * Levanta el proxy y CONFIRMA que quedó corriendo.
 *
 * `docker run -d` devuelve un id aunque el proceso de adentro se muera a los
 * milisegundos. Sin esta confirmación, el error que ve el usuario es el de la
 * operación siguiente ("container is marked for removal and cannot be
 * connected to the network"), que no dice nada de lo que pasó. Esto pasó en la
 * primera corrida real: el proxy salía al arrancar y el lote fallaba sin explicar
 * por qué.
 */
async function levantarProxy(docker, argv, nombreProxy) {
  await docker(argv);
  const estado = await docker(['inspect', '-f', '{{.State.Running}}', validarId(nombreProxy, 'nombre del proxy')], { permitirFallo: true });
  if (String(estado.stdout || '').trim() === 'true') return true;

  const logs = await docker(['logs', nombreProxy], { permitirFallo: true });
  const salida = sanitizarSalida(`${logs.stdout || ''}${logs.stderr || ''}`).trim().slice(0, 300) || '(sin salida)';
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
    '-v', `${VOLUMEN_CA_PUBLICA}:/proxy-ca:ro`,
    '-w', '/trabajo',
    '-e', `HTTPS_PROXY=http://${n.proxy}:${PUERTO_PROXY}`,
    '-e', `HTTP_PROXY=http://${n.proxy}:${PUERTO_PROXY}`,
    '-e', 'NO_PROXY=',
    '-e', 'SSL_CERT_FILE=/proxy-ca/ca.crt',
    ...etiquetas(idLote, expiraEpoch),
    IMAGEN_AGY,
    'bash', '-c', comandoInterno({ modelo, effort })
  ];
}

function validarArgvPrueba(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 32) throw new Error('prueba.argv debe tener entre 1 y 32 argumentos');
  let total = 0;
  for (const valor of argv) {
    if (typeof valor !== 'string' || !valor.length || valor.includes('\0') || valor.length > 4096) {
      throw new Error('cada argumento de prueba debe ser texto no vacío, sin NUL y de hasta 4096 caracteres');
    }
    total += Buffer.byteLength(valor);
  }
  if (total > 32768) throw new Error('prueba.argv supera 32 KiB');
  return [...argv];
}

function argvVerificador({ nombre, rutaCopia, argv, idLote, expiraEpoch }) {
  return [
    'run', '--rm', '--name', validarId(nombre, 'nombre del verificador'),
    '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/home/node:uid=1000,gid=1000,mode=700',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=2g', '--cpus=2',
    '--user', '1000:1000', '-v', `${rutaCopia}:/trabajo`, '-w', '/trabajo',
    ...etiquetas(idLote, expiraEpoch), IMAGEN_VERIFICADOR, ...validarArgvPrueba(argv)
  ];
}

function argvAuditor({ nombres: n, rutaCopia, modelo, effort, idLote, expiraEpoch }) {
  const flags = ['--dangerously-skip-permissions', '--mode', 'plan', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (effort) flags.push('--effort', validarOpcionCli(effort, 'effort'));
  flags.push('--model', validarOpcionCli(modelo, 'modelo'));
  return [
    'run', '--rm', '-i', '--name', validarId(n.auditor, 'nombre del auditor'),
    '--network', validarId(n.redAuditor, 'red del auditor'), '--read-only', '--tmpfs', '/tmp',
    '--tmpfs', `/home/agy:uid=${UID_AGY},gid=${GID_AGY},mode=700`, '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=2g', '--cpus=2',
    '--user', `${UID_AGY}:${GID_AGY}`, '-v', `${rutaCopia}:/trabajo:ro`,
    '-v', `${validarId(n.token, 'volumen de token')}:/token:ro`, '-v', `${VOLUMEN_CA_PUBLICA}:/proxy-ca:ro`,
    '-w', '/trabajo', '-e', `HTTPS_PROXY=http://${n.proxyAuditor}:${PUERTO_PROXY}`,
    '-e', `HTTP_PROXY=http://${n.proxyAuditor}:${PUERTO_PROXY}`, '-e', 'NO_PROXY=',
    '-e', 'SSL_CERT_FILE=/proxy-ca/ca.crt', ...etiquetas(idLote, expiraEpoch), IMAGEN_AGY,
    'bash', '-c', `cp -r /token/. "$HOME/" && exec agy ${flags.join(' ')}`
  ];
}

/**
 * El refrescador es el único que ve el volumen con el `refresh_token` real, y
 * lo ve en su propia red, con la allowlist ampliada (`oauth2.googleapis.com`).
 * Corre un turno trivial: lo único que nos interesa es el efecto secundario de
 * que agy renueve el token (medido en S6).
 */
function argvRefrescador({ nombreContenedor, nombreRed, nombreProxy, idLote, expiraEpoch, guion }) {
  const n = nombres(idLote, 'refresco');
  return [
    'run', '--rm',
    '--name', validarId(nombreContenedor, 'nombre del refrescador'),
    '--network', validarId(nombreRed, 'nombre de red'),
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user', `${UID_AGY}:${GID_AGY}`,
    '-v', `${VOLUMEN_CREDENCIALES}:/home/agy`,
    '-v', `${n.token}:/token`,
    '-v', `${n.secretoProxy}:/proxy-secret`,
    '-v', `${VOLUMEN_CA_PUBLICA}:/proxy-ca:ro`,
    '-e', `HTTPS_PROXY=http://${nombreProxy}:${PUERTO_PROXY}`,
    '-e', `HTTP_PROXY=http://${nombreProxy}:${PUERTO_PROXY}`,
    '-e', 'NO_PROXY=',
    '-e', 'SSL_CERT_FILE=/proxy-ca/ca.crt',
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
function argvPrepararVolumenCredencial(nombreVolumen, destino) {
  if (!['/token', '/proxy-secret'].includes(destino)) throw new Error(`destino de credencial inválido: ${destino}`);
  return [
    'run', '--rm',
    '--user', '0:0',
    '--network', 'none',
    '-v', `${validarId(nombreVolumen, 'nombre de volumen')}:${destino}`,
    IMAGEN_AGY,
    'chown', `${UID_AGY}:${GID_AGY}`, destino
  ];
}

function argvPrepararVolumenToken(nombreVolumen) {
  return argvPrepararVolumenCredencial(nombreVolumen, '/token');
}

function argvInicializarCA() {
  return [
    'run', '--rm', '--user', '0:0', '--network', 'none',
    '-v', `${VOLUMEN_CA_PRIVADA}:/ca-private`,
    '-v', `${VOLUMEN_CA_PUBLICA}:/ca-public`,
    IMAGEN_PROXY, 'init-ca'
  ];
}

function argvVerificarCA() {
  return [
    'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
    '-v', `${VOLUMEN_CA_PRIVADA}:/ca-private:ro`,
    '-v', `${VOLUMEN_CA_PUBLICA}:/ca-public:ro`,
    IMAGEN_PROXY, 'check-ca'
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

function argvCrearVolumen(nombreVolumen, idLote, expiraEpoch) {
  return ['volume', 'create', ...etiquetas(idLote, expiraEpoch), validarId(nombreVolumen, 'nombre de volumen')];
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
    if (!['/trabajo', '/pedido', '/token', '/proxy-ca'].includes(destino)) {
      problemas.push(`montaje inesperado en ${destino}`);
      continue;
    }
    if (destino !== '/trabajo' && modo !== 'ro') problemas.push(`${destino} tiene que ser de solo lectura`);
    if (destino === '/trabajo' && modo === 'ro') problemas.push('/trabajo tiene que ser escribible');
  }
  if (montajes.some(m => m.includes(`${VOLUMEN_CREDENCIALES}:`))) {
    problemas.push('el contenedor de la tarea no puede ver el volumen de credenciales');
  }
  if (!montajes.includes(`${VOLUMEN_CA_PUBLICA}:/proxy-ca:ro`)) problemas.push('falta la CA pública de solo lectura');
  if (!argv.includes('SSL_CERT_FILE=/proxy-ca/ca.crt')) problemas.push('falta SSL_CERT_FILE para la CA del proxy');
  if (montajes.some(m => m.includes(`${VOLUMEN_CA_PRIVADA}:`) || /proxy-secreto:/.test(m))) {
    problemas.push('la tarea no puede ver la CA privada ni el secreto del proxy');
  }

  return problemas;
}

function verificarInvariantesProxy(argv, perfil) {
  const problemas = [];
  const texto = argv.join(' ');
  if (!['tarea', 'refrescador'].includes(perfil)) problemas.push('perfil de proxy inválido');
  if (/docker\.sock/.test(texto)) problemas.push('el proxy monta el socket de Docker');
  if (argv.includes('--privileged') || argv.some(a => /^--cap-add/.test(a))) problemas.push('el proxy obtiene privilegios');
  if (!argv.includes('--cap-drop=ALL')) problemas.push('falta --cap-drop=ALL');
  if (!argv.includes('--security-opt=no-new-privileges')) problemas.push('falta no-new-privileges');
  if (!argv.includes('--read-only')) problemas.push('falta rootfs de solo lectura');
  const redes = argv.filter((a, i) => argv[i - 1] === '--network');
  if (redes.some(r => r === 'host' || r === 'bridge')) problemas.push('el proxy no debe arrancar en host/bridge');
  const montajes = argv.filter((a, i) => argv[i - 1] === '-v');
  if (!montajes.includes(`${VOLUMEN_CA_PRIVADA}:/ca:ro`)) problemas.push('falta CA privada RO');
  const secretos = montajes.filter(m => m.endsWith(':/secret:ro'));
  if (perfil === 'tarea' && secretos.length !== 1) problemas.push('el proxy de tarea necesita un secreto RO');
  if (perfil === 'refrescador' && secretos.length) problemas.push('el proxy refrescador no debe montar secretos de tarea');
  if (montajes.some(m => !m.endsWith(':/ca:ro') && !m.endsWith(':/secret:ro'))) problemas.push('montaje inesperado en el proxy');
  return problemas;
}

function verificarInvariantesVerificador(argv) {
  const problemas = [];
  const texto = argv.join(' ');
  if (!argv.includes('--network') || argv[argv.indexOf('--network') + 1] !== 'none') problemas.push('el verificador debe usar network none');
  if (!argv.includes('--read-only') || !argv.includes('--cap-drop=ALL') || !argv.includes('--security-opt=no-new-privileges')) problemas.push('falta hardening del verificador');
  if (!argv.includes('--pids-limit=256') || !argv.includes('--memory=2g') || !argv.includes('--cpus=2')) problemas.push('faltan límites del verificador');
  if (/docker\.sock|proxy-ca|agy-credenciales|proxy-secreto/.test(texto)) problemas.push('el verificador ve secretos o Docker');
  const montajes = argv.filter((a, i) => argv[i - 1] === '-v');
  if (montajes.length !== 1 || !montajes[0].endsWith(':/trabajo')) problemas.push('el verificador solo puede montar /trabajo RW');
  return problemas;
}

function verificarInvariantesAuditor(argv) {
  const problemas = verificarInvariantes(argv).filter(p => p !== '/trabajo tiene que ser escribible');
  const montajes = argv.filter((a, i) => argv[i - 1] === '-v');
  if (!argv.includes('-i')) problemas.push('el auditor necesita stdin interactivo (-i)');
  if (argv.includes('-t') || argv.includes('--tty')) problemas.push('el auditor no puede usar TTY');
  if (!montajes.some(m => m.endsWith(':/trabajo:ro'))) problemas.push('/trabajo debe ser RO para el auditor');
  if (montajes.some(m => m.endsWith(':/trabajo'))) problemas.push('/trabajo no puede ser RW para el auditor');
  if (!argv.join(' ').includes('--mode plan')) problemas.push('el auditor debe correr en mode plan');
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
      throw new Error(`docker ${args.slice(0, 3).join(' ')} falló (${r.code}): ${sanitizarSalida(r.stderr).trim().slice(0, 300)}`);
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
  IMAGEN_VERIFICADOR,
  VOLUMEN_CREDENCIALES,
  VOLUMEN_CA_PRIVADA,
  VOLUMEN_CA_PUBLICA,
  ETIQUETA_LOTE,
  ETIQUETA_EXPIRA,
  UID_AGY,
  GID_AGY,
  PUERTO_PROXY,
  sanitizarSalida,
  UID_PROXY,
  GID_PROXY,
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
  validarArgvPrueba,
  argvVerificador,
  argvAuditor,
  argvRefrescador,
  argvStop,
  argvWait,
  argvRmForzado,
  argvExiste,
  argvPrepararVolumenToken,
  argvPrepararVolumenCredencial,
  argvInicializarCA,
  argvVerificarCA,
  argvCrearVolumen,
  argvBorrarVolumen,
  argvListarPorEtiqueta,
  verificarInvariantes,
  verificarInvariantesProxy,
  verificarInvariantesVerificador,
  verificarInvariantesAuditor,
  crearDocker
};
