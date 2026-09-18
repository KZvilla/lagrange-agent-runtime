/**
 * FEAT-061 fase 2 — El argv de Docker es la superficie de seguridad del lote.
 *
 * Estos checks no son de estilo: cada uno corresponde a una forma conocida de
 * salirse del contenedor (montar el socket, pedir capacidades, compartir la red
 * del host, montar el volumen de credenciales en la tarea). Si una mutación los
 * deja pasar, el contenedor deja de ser una frontera.
 */
const { check, group, report } = require('./lib/assert.js');
const d = require('../mcp-server/lotes/docker.js');

const nom = d.nombres('lote1', 'tarea1');

group('validación de identificadores', () => {
  check('un id normal pasa', d.validarId('mi-lote_2') === 'mi-lote_2');
  let rechazado = false;
  try { d.validarId('con:dos-puntos'); } catch { rechazado = true; }
  check('un id con ":" se rechaza', rechazado);
  rechazado = false;
  try { d.validarId('con/barra'); } catch { rechazado = true; }
  check('un id con "/" se rechaza', rechazado);
  rechazado = false;
  try { d.validarId('../fuga'); } catch { rechazado = true; }
  check('un id con ".." se rechaza', rechazado);
  rechazado = false;
  try { d.nombres('lote', 'x y'); } catch { rechazado = true; }
  check('un id de tarea con espacio se rechaza', rechazado);
  check('el modelo admite puntos', d.validarOpcionCli('gemini-3.8-flash') === 'gemini-3.8-flash');
  rechazado = false;
  try { d.validarOpcionCli('modelo"; curl malo'); } catch { rechazado = true; }
  check('un modelo con comillas o espacios se rechaza', rechazado);
});

group('argv de una tarea', () => {
  const argv = d.argvTarea({
    nombres: nom,
    rutaCopia: '/mnt/c/copia',
    rutaPedido: '/mnt/c/pedido',
    modelo: 'gemini-3.8-flash',
    effort: 'high',
    idLote: 'lote1',
    expiraEpoch: 1000
  });
  const texto = argv.join(' ');

  check('corre con --rm', argv.includes('--rm'));
  check('usa la red del lote', texto.includes('--network lote-lote1-tarea1-red'));
  check('raíz de solo lectura', argv.includes('--read-only'));
  check('home en tmpfs propio del uid 1001', texto.includes('--tmpfs /home/agy:uid=1001,gid=1001,mode=700'));
  check('sin capacidades', argv.includes('--cap-drop=ALL'));
  check('sin escalada de privilegios', argv.includes('--security-opt=no-new-privileges'));
  check('corre como 1001:1001', texto.includes('--user 1001:1001'));
  check('la copia se monta en /trabajo escribible', texto.includes('-v /mnt/c/copia:/trabajo'));
  check('el pedido se monta RO', texto.includes('-v /mnt/c/pedido:/pedido:ro'));
  check('el token se monta RO', texto.includes('-v lote-lote1-token:/token:ro'));
  check('el proxy es el único egress', texto.includes('HTTPS_PROXY=http://lote-lote1-tarea1-proxy:8888'));
  check('NO_PROXY va vacío', argv.includes('NO_PROXY='));
  check('lleva la etiqueta del lote', texto.includes('--label lagrange.lote=lote1'));
  check('lleva la etiqueta de expiración', texto.includes('--label lagrange.expira=1000'));
  check('el prompt NO viaja en el argv', !texto.includes('PROMPT') || texto.includes('cat /pedido/PROMPT.md'));
  check('adentro se copia el token al home', texto.includes('cp -r /token/. "$HOME/"'));
  check('adentro corre agy con el modelo pedido', texto.includes('--model gemini-3.8-flash'));
});

group('invariantes de seguridad', () => {
  const argv = d.argvTarea({
    nombres: nom, rutaCopia: '/mnt/c/copia', rutaPedido: '/mnt/c/pedido', idLote: 'lote1', expiraEpoch: 1
  });
  check('el argv real no tiene problemas', d.verificarInvariantes(argv).length === 0, JSON.stringify(d.verificarInvariantes(argv)));

  // El problema tiene que nombrar el SOCKET: un montaje del socket también
  // dispara "montaje inesperado", así que comprobar que "hay algún problema"
  // dejaría pasar que la comprobación específica desapareciera.
  const conSocket = [...argv, '-v', '/var/run/docker.sock:/var/run/docker.sock'];
  check('monta docker.sock → lo nombra', d.verificarInvariantes(conSocket).some(p => /socket de Docker/.test(p)),
    JSON.stringify(d.verificarInvariantes(conSocket)));

  const conPrivileged = [...argv, '--privileged'];
  check('--privileged → problema', d.verificarInvariantes(conPrivileged).some(p => /privileged/.test(p)));

  const conCap = [...argv, '--cap-add=SYS_ADMIN'];
  check('--cap-add → problema', d.verificarInvariantes(conCap).some(p => /capacidades/.test(p)));

  const sinReadOnly = argv.filter(a => a !== '--read-only');
  check('sin --read-only → problema', d.verificarInvariantes(sinReadOnly).some(p => /read-only/.test(p)));

  const sinCapDrop = argv.filter(a => a !== '--cap-drop=ALL');
  check('sin --cap-drop=ALL → problema', d.verificarInvariantes(sinCapDrop).some(p => /cap-drop/.test(p)));

  const montajeExtra = [...argv, '-v', '/mnt/c/Users:/host'];
  check('un montaje extra → problema', d.verificarInvariantes(montajeExtra).some(p => /montaje inesperado/.test(p)));

  const tokenRW = argv.map(a => a === 'lote-lote1-token:/token:ro' ? 'lote-lote1-token:/token' : a);
  check('el token montado RW → problema', d.verificarInvariantes(tokenRW).some(p => /solo lectura/.test(p)));

  const enBridge = argv.map((a, i) => (argv[i - 1] === '--network' ? 'bridge' : a));
  check('la tarea en bridge → problema', d.verificarInvariantes(enBridge).some(p => /bridge/.test(p)));

  const conCredenciales = [...argv, '-v', `${d.VOLUMEN_CREDENCIALES}:/trabajo`];
  check('montar el volumen de credenciales → problema', d.verificarInvariantes(conCredenciales).some(p => /credenciales/.test(p)));
});

group('red, proxy y refrescador', () => {
  const red = d.argvCrearRed(nom.red, 'lote1', 5);
  check('la red es --internal', red.includes('--internal'));
  check('la red lleva etiqueta', red.join(' ').includes('--label lagrange.lote=lote1'));

  const proxy = d.argvProxy({ nombreProxy: nom.proxy, nombreRed: nom.red, archivoPermitidos: '/mnt/c/permitidos', idLote: 'lote1', expiraEpoch: 5 });
  check('el proxy monta la allowlist RO', proxy.join(' ').includes('-v /mnt/c/permitidos:/etc/tinyproxy/permitidos:ro'));
  check('el proxy arranca en segundo plano', proxy.includes('-d'));
  check('el proxy NO usa --rm (si no, se pierden sus logs al caerse)', !proxy.includes('--rm'));
  check('el proxy corre como nobody', proxy.join(' ').includes('--user 65534:65534'));
  check('el proxy no tiene capacidades', proxy.includes('--cap-drop=ALL'));
  check('el proxy se conecta a bridge aparte', d.argvConectarBridge(nom.proxy).join(' ') === `network connect bridge ${nom.proxy}`);

  const refresco = d.argvRefrescador({
    nombreContenedor: 'lote-lote1-refrescador', nombreRed: 'r', nombreProxy: 'p', idLote: 'lote1', expiraEpoch: 5, guion: 'echo hola'
  });
  const textoRefresco = refresco.join(' ');
  check('el refrescador SÍ ve el volumen de credenciales', textoRefresco.includes(`-v ${d.VOLUMEN_CREDENCIALES}:/home/agy`));
  check('el refrescador escribe el token del lote', textoRefresco.includes('-v lote-lote1-token:/token'));
  check('el refrescador corre como 1001', textoRefresco.includes('--user 1001:1001'));
  check('el volumen de token se prepara como root y sin red', d.argvPrepararVolumenToken('lote-lote1-token').join(' ') === 'run --rm --user 0:0 --network none -v lote-lote1-token:/token lagrange-lote-agy chown 1001:1001 /token');
});

group('detención y listados', () => {
  check('stop lleva el tope de gracia', d.argvStop('c', 10).join(' ') === 'stop -t 10 c');
  check('wait espera al contenedor', d.argvWait('c').join(' ') === 'wait c');
  check('existe filtra por nombre exacto', d.argvExiste('c').join(' ').includes('name=^c$'));
  for (const tipo of ['contenedores', 'redes', 'volumenes']) {
    check(`listar ${tipo} filtra por la etiqueta`, d.argvListarPorEtiqueta(tipo).join(' ').includes('label=lagrange.lote'));
  }
});

report();
