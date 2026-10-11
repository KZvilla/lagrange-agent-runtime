/**
 * FEAT-154 — Los harness desde la consola: la versión real de cada imagen (etiqueta, con respaldo en `--version`),
 * el build con una versión exacta y su salida limpia, el marcador que frena lotes en los dos procesos, la tarjeta de
 * Proveedores con el desvío, los trabajos de la consola (uno a la vez, la guarda de lotes, el SSE) y las rutas.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert.js');
const I = require('../mcp-server/lotes/imagenes.js');
const P = require('../mcp-server/lib/proveedores.js');
const { crearServicioLotes } = require('../mcp-server/lotes/servicio.js');
const { crearRegistro, ESTADOS_ACTIVOS, ESPERANDO_HUMANO } = require('../mcp-server/lotes/registro.js');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'f154-'));
const BRIDGE = path.join(__dirname, '..', 'telegram-bridge');
const imp = (rel) => import(pathToFileURL(path.join(BRIDGE, rel)).href);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT = '123456789:AAHfalsoFalsoFalsoFalsoFalsoFalso12345';
const redactarBot = (x) => String(x).replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[BOT]');

/** Un Docker falso: `respuestas` por prefijo de argv; anota cada llamada. */
function dockerFalso(respuestas) {
  const llamadas = [];
  const docker = async (args) => {
    llamadas.push(args);
    for (const [prefijo, r] of respuestas) if (args.join(' ').startsWith(prefijo)) return typeof r === 'function' ? r(args) : r;
    return { code: 0, stdout: '', stderr: '' };
  };
  docker.llamadas = llamadas;
  return docker;
}

/** Un `spawn` falso que emite `trozos` por stdout/stderr y cierra con `code` (o nunca, si `code` es null). */
function spawnFalso(trozos, code = 0) {
  const vistos = [];
  const impl = (bin, args) => {
    vistos.push([bin, ...args]);
    const hijo = new EventEmitter();
    hijo.stdout = new EventEmitter();
    hijo.stderr = new EventEmitter();
    hijo.kill = () => { hijo.matado = true; setImmediate(() => hijo.emit('close', null)); };
    setImmediate(() => {
      for (const [canal, t] of trozos) hijo[canal].emit('data', Buffer.from(t));
      if (code !== null) hijo.emit('close', code);
    });
    impl.hijo = hijo;
    return hijo;
  };
  impl.vistos = vistos;
  return impl;
}

(async () => {
  await group('versión fijada y construida', async () => {
    check('lee el ARG real de los dos Dockerfiles', /^\d+\.\d+\.\d+$/.test(I.versionFijada('agy')) && /^\d+\.\d+\.\d+$/.test(I.versionFijada('claude')));
    const dir = path.join(raiz, 'imagenes');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Dockerfile.agy'), 'FROM x\nARG AGY_VERSION=9.8.7\n');
    check('ARG de un directorio dado; sin archivo, null', I.versionFijada('agy', { dir }) === '9.8.7' && I.versionFijada('claude', { dir }) === null);
    check('harness desconocido se rechaza', (() => { try { I.versionFijada('opencode'); return false; } catch { return true; } })());
    check('los dos Dockerfiles escriben la etiqueta desde su ARG', ['agy', 'claude'].every((h) => {
      const d = I.HARNESS[h];
      return fs.readFileSync(path.join(I.DIR_IMAGENES, d.dockerfile), 'utf8').includes(`LABEL ${I.ETIQUETA}="\${${d.arg}}"`);
    }));

    const conEtiqueta = dockerFalso([['image inspect', { code: 0, stdout: JSON.stringify({ [I.ETIQUETA]: '1.3.3' }) }]]);
    const a = await I.versionConstruida(conEtiqueta, 'agy');
    check('la etiqueta gana y no arranca un contenedor', a.version === '1.3.3' && a.fuente === 'etiqueta' && !conEtiqueta.llamadas.some((x) => x[0] === 'run'));
    const vieja = dockerFalso([['image inspect', { code: 0, stdout: 'null' }], ['run', { code: 0, stdout: '2.1.296 (Claude Code)\n' }]]);
    const b = await I.versionConstruida(vieja, 'claude');
    check('sin etiqueta, `--version` sin red', b.version === '2.1.296' && b.fuente === 'binario' && vieja.llamadas[1].join(' ').includes('--network none lagrange-lote-claude claude --version'));
    const sinImagen = dockerFalso([['image inspect', { code: 1, stderr: 'Error: No such image: lagrange-lote-agy' }]]);
    check('sin imagen: null', (await I.versionConstruida(sinImagen, 'agy')) === null);
    const caido = dockerFalso([['image inspect', { code: 1, stderr: 'Cannot connect to the Docker daemon' }]]);
    check('Docker caído: lanza (la tarjeta dice que no se pudo leer)', await I.versionConstruida(caido, 'agy').then(() => false, () => true));

    let ahora = 0;
    const contador = dockerFalso([['image inspect', { code: 0, stdout: JSON.stringify({ [I.ETIQUETA]: '1.3.3' }) }]]);
    const lector = I.crearLectorImagenes({ docker: contador, ahora: () => ahora });
    await lector.leer('agy');
    await lector.leer('agy');
    const tras = contador.llamadas.length;
    lector.invalidar();
    await lector.leer('agy');
    ahora = 61000;
    await lector.leer('agy');
    check('el lector cachea 60 s y se invalida', tras === 1 && contador.llamadas.length === 3);
  });

  await group('build', async () => {
    const argv = I.argvBuild('agy', '1.3.4', '/mnt/c/x/imagenes');
    check('argv exacto con un solo --build-arg', JSON.stringify(argv) === JSON.stringify(['build', '-f', '/mnt/c/x/imagenes/Dockerfile.agy', '--build-arg', 'AGY_VERSION=1.3.4', '-t', 'lagrange-lote-agy', '/mnt/c/x/imagenes'])
      && argv.filter((x) => x === '--build-arg').length === 1);
    check('una versión que no es x.y.z se rechaza', ['1.3', '1.3.4; rm -rf /', '', null, 'latest'].every((v) => { try { I.argvBuild('claude', v, '/c'); return false; } catch { return true; } }));

    const lineas = [];
    const sp = spawnFalso([['stdout', '#1 paso uno\n#2 Authorization: Bearer abc.def-ghi\n#3 tok'], ['stdout', 'en ya29.abcdefghijklmnop\n'], ['stderr', `bot ${BOT}\n`], ['stdout', 'sin salto']]);
    const r = await I.correrBuild(['build'], { alLinea: (x) => lineas.push(x), redactar: redactarBot, spawnImpl: sp });
    const todo = lineas.join('\n');
    check('corre wsl -e docker build', sp.vistos[0].slice(0, 4).join(' ') === 'wsl -e docker build');
    check('entrega por líneas, también las partidas y la última sin salto', r.code === 0 && lineas.includes('#1 paso uno') && lineas.some((l) => l.startsWith('#3 tok')) && lineas.includes('sin salto'), todo);
    check('sin Bearer, ya29 ni token de bot', !/abc\.def-ghi|ya29\.abcdef|AAHfalso/.test(todo) && /\[REDACTADO\]|REDACTADO/.test(todo) && todo.includes('[BOT]'), todo);

    const colgado = spawnFalso([['stdout', 'arranca\n']], null);
    let terminado = null;
    const t = await I.correrBuild(['build'], { alLinea: () => {}, spawnImpl: colgado, timeoutMs: 30, terminar: (h) => { terminado = h; h.kill(); } });
    check('el timeout corta el árbol y da 124', t.code === 124 && terminado === colgado.hijo);
    // Auditoría r1 (MAJOR): sin `terminar` explícito, el corte es terminateTree (en Windows `kill()` deja WSL vivo).
    const fuenteImagenes = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'lotes', 'imagenes.js'), 'utf8');
    check('por defecto corta con terminateTree', /terminar = terminateTree/.test(fuenteImagenes) && /require\('\.\.\/lib\/process-tree\.js'\)/.test(fuenteImagenes) && !/c\.kill\(\)/.test(fuenteImagenes));

    const docker = dockerFalso([['image inspect', { code: 0, stdout: JSON.stringify({ [I.ETIQUETA]: '1.3.3' }) }]]);
    const distinta = await I.construirImagen({ docker, aWsl: async () => '/ctx', harness: 'agy', version: '1.3.4', spawnImpl: spawnFalso([]) });
    check('si la imagen no dice la versión pedida: falla', !distinta.ok && distinta.construida === '1.3.3' && /se pidió 1\.3\.4/.test(distinta.motivo));
    const bien = await I.construirImagen({ docker, aWsl: async () => '/ctx', harness: 'agy', version: '1.3.3', spawnImpl: spawnFalso([]) });
    check('con la versión pedida: ok', bien.ok && bien.construida === '1.3.3');
    const roto = await I.construirImagen({ docker, aWsl: async () => '/ctx', harness: 'agy', version: '1.3.3', spawnImpl: spawnFalso([], 1) });
    check('build con error: falla con el código', !roto.ok && /código 1/.test(roto.motivo));
  });

  await group('marcador de construcción', async () => {
    const dir = path.join(raiz, 'datos-marcador');
    check('sin directorio de datos no hay marcador', I.marcadorVivo(null) === null);
    const soltar = I.tomarMarcador(dir, 'claude');
    check('tomado: vivo con el harness y este pid', I.marcadorVivo(dir)?.harness === 'claude' && I.marcadorVivo(dir).pid === process.pid);
    check('un segundo intento se rechaza', (() => { try { I.tomarMarcador(dir, 'agy'); return false; } catch (e) { return /claude/.test(e.message); } })());
    soltar();
    check('soltado: no queda', I.marcadorVivo(dir) === null && !fs.existsSync(I.rutaMarcador(dir)));
    fs.writeFileSync(I.rutaMarcador(dir), JSON.stringify({ harness: 'agy', pid: 999999, inicio: 'x' }));
    check('con el proceso muerto no cuenta y se borra', I.marcadorVivo(dir, { estaVivo: () => false }) === null && !fs.existsSync(I.rutaMarcador(dir)));
    fs.writeFileSync(I.rutaMarcador(dir), JSON.stringify({ harness: 'agy', pid: 999999, inicio: 'x' }));
    const otra = I.tomarMarcador(dir, 'agy', { estaVivo: () => false });
    check('uno huérfano no impide tomarlo', I.marcadorVivo(dir)?.pid === process.pid);
    otra();
    fs.writeFileSync(I.rutaMarcador(dir), '');
    check('ilegible y recién escrito: cuenta como vivo', I.marcadorVivo(dir)?.harness === '?');
    check('ilegible y viejo: quedó roto, se borra', I.marcadorVivo(dir, { ahora: () => Date.now() + 60000 }) === null && !fs.existsSync(I.rutaMarcador(dir)));

    // El preflight de los lotes (daemon y MCP) lo lee.
    const registro = crearRegistro({ dir: path.join(raiz, 'reg') });
    const docker = dockerFalso([]);
    const servicio = crearServicioLotes({ registro, docker, aWsl: async (x) => x, dirDatos: dir });
    const antes = (await servicio.chequearEntorno({})).find((c) => c.id === 'imagen-en-construccion');
    const suelta = I.tomarMarcador(dir, 'agy');
    const durante = (await servicio.chequearEntorno({})).find((c) => c.id === 'imagen-en-construccion');
    suelta();
    check('preflight: en verde sin marcador, en rojo con él', antes?.ok === true && durante?.ok === false && /reconstruyendo la imagen de agy/.test(durante.motivo), JSON.stringify(durante));
    const sinDatos = crearServicioLotes({ registro, docker, aWsl: async (x) => x, dirDatos: null });
    check('un servicio sin directorio de datos no se rompe', (await sinDatos.chequearEntorno({})).find((c) => c.id === 'imagen-en-construccion')?.ok === true);
  });

  await group('tarjetas de Proveedores', async () => {
    const releases = (v) => JSON.stringify([{ tag_name: `v${v}`, body: '- x', published_at: '2026-10-10T00:00:00Z' }]);
    const pedir = async (url) => new Response(url.includes('manifests') ? JSON.stringify({ version: '1.3.4' }) : releases('2.1.297'), { status: 200 });
    const base = { versionInstalada: () => '1.3.3', pedir, uso: () => null, plataforma: 'windows_amd64', versionClaude: () => '2.1.296', imagenClaude: () => '2.1.296', versionLagrange: '1.19.0' };
    const con = (imagenHarness) => P.crearProveedores({ ...base, imagenHarness }).lista();
    const desvio = async (fijada, construida) => (await con(async () => ({ fijada, construida: construida ? { version: construida, fuente: 'etiqueta' } : null })))[1].imagen;
    const sin = await desvio('2.1.296', null);
    check('sin construir', sin.desvio === 'sin-construir' && sin.construida === null && sin.fijada === '2.1.296');
    check('distinta de la fijada', (await desvio('2.1.296', '2.1.297')).desvio === 'distinta-de-la-fijada');
    const atras = await desvio('2.1.296', '2.1.296');
    check('atrás de la última (si la hay)', atras.desvio === 'atras-de-la-ultima' && atras.version === '2.1.296' && atras.ultima, JSON.stringify(atras));
    const [agy] = await con(async (h) => ({ fijada: '1.3.3', construida: { version: h === 'agy' ? '1.3.4' : '2.1.297', fuente: 'etiqueta' } }));
    check('agy también tiene imagen', agy.imagen && agy.imagen.construida.version === '1.3.4' && agy.imagen.desvio === 'distinta-de-la-fijada');
    const [, caida] = await con(async () => { throw new Error('el servicio de lotes no está disponible'); });
    check('Docker caído: error, sin desvío, y la versión fijada sigue', caida.imagen.error && caida.imagen.desvio === null && caida.imagen.version === '2.1.296');
    const [agySin, claudeSin] = await P.crearProveedores(base).lista();
    const sondasViejas = () => ({ cuentas: { principal: { ok: true, huella: 'claude 2.1.296 · lagrange 1.19.0', en: '2026-10-10T00:00:00Z' } } });
    const [, sinImagen] = await P.crearProveedores({ ...base, sondasClaude: sondasViejas, imagenHarness: async () => ({ fijada: '2.1.296', construida: null }) }).lista();
    const [, conImagen] = await P.crearProveedores({ ...base, sondasClaude: sondasViejas, imagenHarness: async () => ({ fijada: '2.1.296', construida: { version: '2.1.296', fuente: 'etiqueta' } }) }).lista();
    check('sin imagen construida ninguna sonda está vigente; con ella, sí', sinImagen.sondas[0].vigente === false && conImagen.sondas[0].vigente === true);
    check('sin imagenHarness: agy sin imagen y Claude como en FEAT-137', agySin.imagen === null && claudeSin.imagen.version === '2.1.296' && claudeSin.imagen.atrasada === false);
  });

  const { crearTrabajosHarness } = await imp('web/harness.js');

  await group('trabajos de la consola', async () => {
    const eventos = [];
    const canal = { publicar: (chatId, e, o = {}) => eventos.push({ chatId, ...e, efimero: Boolean(o.efimero) }) };
    const dir = path.join(raiz, 'datos-trabajos');
    let impiden = [];
    let invalidado = 0;
    let liberar;
    const construcciones = [];
    const construir = (o) => {
      construcciones.push(o);
      for (let i = 0; i < 70; i++) o.alLinea(`paso ${i} Bearer secreto123`);
      return new Promise((r) => { liberar = r; });
    };
    let ultima = '1.3.4';
    const sondeos = [];
    const h = crearTrabajosHarness({
      canal, chatId: 'web', imagenes: I, lector: { invalidar: () => invalidado++ }, docker: async () => ({}), aWsl: async (x) => x, dirDatos: dir,
      lotesQueImpiden: () => impiden, ultimaDe: async () => ultima, redactar: redactarBot, esperaGuardaMs: 0, construir,
      validarCuenta: (c) => { if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(c) || c === 'nadie') throw new Error(`la cuenta ${c} no está declarada en motores.cuentas`); },
      sondar: async (c) => { sondeos.push(c); return { ok: true, huella: 'claude 2.1.296 · lagrange 1.19.0', detalle: [{ id: 'E1', ok: true, detalle: 'init' }, { id: 'E2', ok: true, detalle: 'canario' }] }; }
    });

    check('harness o versión inválidos: 400', (await h.construir({ harness: 'opencode', version: 'fijada' })).codigo === 400
      && (await h.construir({ harness: 'agy', version: '1.3.4' })).codigo === 400);
    ultima = null;
    check('«ultima» sin dato conocido: 409 y no toma el marcador', (await h.construir({ harness: 'agy', version: 'ultima' })).codigo === 409 && I.marcadorVivo(dir) === null);
    ultima = '1.3.4';
    impiden = ['lote-a', 'lote-b'];
    const frenado = await h.construir({ harness: 'claude', version: 'fijada' });
    check('con lotes corriendo o esperando: 409 con sus ids y suelta el marcador', frenado.codigo === 409 && frenado.lotes.join() === 'lote-a,lote-b' && I.marcadorVivo(dir) === null && !construcciones.length);
    impiden = [];

    const r = await h.construir({ harness: 'agy', version: 'ultima' });
    check('«ultima» se resuelve en el servidor', r.ok && r.trabajo.version === '1.3.4' && construcciones[0].version === '1.3.4' && construcciones[0].harness === 'agy');
    check('mientras construye, el marcador está tomado', I.marcadorVivo(dir)?.harness === 'agy');
    check('un segundo pedido: 409', (await h.construir({ harness: 'claude', version: 'fijada' })).codigo === 409 && (await h.sondear({ cuenta: 'principal' })).codigo === 409);
    const lineas = eventos.filter((e) => e.tipo === 'harness:linea');
    check('cada línea sale efímera y limpia', lineas.length === 70 && lineas.every((e) => e.efimero) && !lineas.some((e) => /secreto123/.test(e.texto)));
    const estado = h.estado();
    check('el estado guarda solo las últimas 60 líneas', estado.corriendo && estado.trabajo.lineas.length === 60 && estado.trabajo.lineas[59].startsWith('paso 69'));
    liberar({ ok: true, construida: '1.3.4', motivo: null });
    await espera(20);
    const final = eventos.filter((e) => e.tipo === 'harness:estado');
    check('los estados no son efímeros: corriendo y listo', final.length === 2 && final.every((e) => !e.efimero) && final[1].trabajo.estado === 'listo' && !('lineas' in final[1].trabajo));
    check('al terminar: suelta el marcador e invalida la caché', I.marcadorVivo(dir) === null && invalidado === 1 && !h.estado().corriendo && h.estado().trabajo.estado === 'listo');

    check('sondear: cuenta inválida o no declarada da 400', (await h.sondear({ cuenta: '../x' })).codigo === 400 && (await h.sondear({ cuenta: 'nadie' })).codigo === 400 && (await h.sondear({})).codigo === 400);
    const s = await h.sondear({ cuenta: 'principal' });
    await espera(20);
    const ult = h.estado().trabajo;
    check('sondear: una línea por sonda y en verde', s.ok && sondeos.join() === 'principal' && ult.estado === 'listo' && ult.lineas.some((l) => l.startsWith('PASS  E1')) && ult.resultado.huella.startsWith('claude'));
  });

  await group('guarda con lotes reales del registro', () => {
    check('esperando humano no es activo, por eso se suma a mano', !ESTADOS_ACTIVOS.includes(ESPERANDO_HUMANO) && ESPERANDO_HUMANO === 'esperando humano');
    const bot = fs.readFileSync(path.join(BRIDGE, 'bot.js'), 'utf8');
    check('el daemon frena con activos y con esperando humano', /\[\.\.\.ESTADOS_ACTIVOS_LOTES, ESPERANDO_HUMANO_LOTES\]\.includes\(l\.estado\)/.test(bot));
  });

  await group('núcleo, rutas y consola', async () => {
    const { crearNucleoWeb } = await imp('web/nucleo.js');
    const srv = await imp('web/servidor.js');
    const sinLotes = crearNucleoWeb({ canal: { publicar() {}, pendientes: () => [], suscribir: () => () => {} }, bot: {}, almas: {}, workspaces: () => [] });
    check('sin servicio de lotes: 503', sinLotes.trabajoHarness().codigo === 503 && (await sinLotes.construirImagen({})).codigo === 503 && (await sinLotes.sondearCuenta({})).codigo === 503);
    const conHarness = crearNucleoWeb({ canal: { publicar() {}, pendientes: () => [], suscribir: () => () => {} }, bot: {}, almas: {}, workspaces: () => [],
      harness: { estado: () => ({ ok: true, trabajo: null }), construir: async () => ({ ok: false, codigo: 409, error: 'hay lotes', lotes: ['l1'] }), sondear: async () => ({ ok: true, trabajo: { id: 't' } }) } });
    const r409 = await conHarness.construirImagen({ harness: 'agy', version: 'fijada' });
    check('el 409 de la guarda llega con los ids', r409.codigo === 409 && r409.lotes[0] === 'l1');
    check('construir y sondear son ejecutar; el GET, lectura', srv.nivelDe('construirImagen', [{}]) === 'ejecutar' && srv.nivelDe('sondearCuenta', [{}]) === 'ejecutar'
      && srv.metodosPermitidos().has('trabajoHarness') && srv.nivelDe('trabajoHarness', []) === 'lectura');
    check('un nodo que permite operar no alcanza', !srv.nivelAlcanza('operar', srv.nivelDe('construirImagen', [{}])));
    const ui = fs.readFileSync(path.join(BRIDGE, 'web', 'public', 'ui', 'harness-acciones.js'), 'utf8');
    check('la consola filtra los eventos por nodo y no hace polling', /\(e\.nodo \|\| 'local'\) === \(nodo\.value \|\| 'local'\)/.test(ui) && !/setInterval/.test(ui));
    check('la consola pide «fijada» o «ultima», nunca una versión', /api\('\/api\/harness\/construir', \{ harness, version \}\)/.test(ui) && /useState\('fijada'\)/.test(ui));
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  report();
})();
