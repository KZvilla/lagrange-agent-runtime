/**
 * FEAT-090 — Almas en el servidor (§10.1).
 *
 * En este proceso: el servidor (con las almas en `almasServidor`) y el nodo
 * (su cliente de red y su endpoint local). El conector del nodo corre en un
 * proceso hijo con OTRO directorio de almas (`almasNodo`), para comprobar que
 * lo que ve es lo del servidor y que su directorio local no cambia.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const { temporalQueSeBorra } = require('./lib/temporales');
// BE-076 — Se borra al salir, también si la suite falla.
const raiz = temporalQueSeBorra('feat-090-');
const almasServidor = path.join(raiz, 'almas-servidor');
const almasNodo = path.join(raiz, 'almas-nodo');
fs.writeFileSync(path.join(raiz, '.env'), 'ALLOWED_USER_IDS=555000111\n');
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(raiz, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos-servidor');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');
process.env.LAGRANGE_ALMAS_DIR = almasServidor;
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });

const REPO = path.join(__dirname, '..');
const BRIDGE = path.join(REPO, 'telegram-bridge');
const imp = (f) => import(pathToFileURL(path.join(BRIDGE, f)).href);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 5000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) { if (await cond()) return true; await esperar(20); }
  return false;
}
function arbol(dir) {
  const salida = {};
  const recorrer = (d) => {
    let entradas = [];
    try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const ruta = path.join(d, e.name);
      if (e.isDirectory()) recorrer(ruta);
      else salida[path.relative(dir, ruta)] = crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
    }
  };
  recorrer(dir);
  return salida;
}

async function main() {
  const semilla = require('../mcp-server/almas/semilla.js');
  const recuerdos = require('../mcp-server/almas/recuerdos.js');
  const rutasAlmas = require('../mcp-server/almas/rutas.js');
  const operaciones = require('../mcp-server/almas/operaciones.js');
  const perfil = (name, personality) => ({ name, personality, language: 'es' });
  semilla.sembrar('alya', perfil('Alya', 'Tsundere del servidor'));
  recuerdos.aplicar(rutasAlmas.rutasDe('alya').memoria, 'm', [{ tipo: 'agregar', texto: 'recuerdo del servidor' }], recuerdos.TOPE_MEMORIA);
  // El nodo tiene su propia Alya (distinta) y otra alma que el servidor no tiene.
  const envNodo = { ...process.env, LAGRANGE_ALMAS_DIR: almasNodo };
  const sembrarEnNodo = () => new Promise((r) => {
    const h = spawn(process.execPath, ['-e', `
      const s = require(${JSON.stringify(path.join(REPO, 'mcp-server/almas/semilla.js'))});
      const rec = require(${JSON.stringify(path.join(REPO, 'mcp-server/almas/recuerdos.js'))});
      const ru = require(${JSON.stringify(path.join(REPO, 'mcp-server/almas/rutas.js'))});
      s.sembrar('alya', { name: 'Alya', personality: 'la del nodo', language: 'es' });
      s.sembrar('diego', { name: 'Diego', personality: 'calmo', language: 'es' });
      rec.aplicar(ru.rutasDe('alya').memoria, 'm', [{ tipo: 'agregar', texto: 'recuerdo del servidor' }, { tipo: 'agregar', texto: 'solo en el nodo' }], rec.TOPE_MEMORIA);
    `], { env: envNodo });
    h.on('close', r);
  });
  await sembrarEnNodo();

  const botMod = await imp('bot.js');
  const { crearCanalWeb, CHAT_WEB_LOCAL } = await imp('web/canal.js');
  const srv = await imp('web/servidor.js');
  const { crearServidorNodos } = await imp('red/servidor-nodos.js');
  const { crearNucleoRemoto } = await imp('red/nucleo-remoto.js');
  const { crearClienteNodo, pedirHttp } = await imp('red/cliente-nodo.js');
  const { arrancarEnlaceLocal } = await imp('red/enlace-local.js');
  const { crearReplicas } = await imp('red/replicas.js');
  const identidad = await imp('red/identidad.js');
  const admin = await imp('red/admin.js');

  // ------------------------------------------------ servidor + nodo reales
  const dirServidor = process.env.TELEGRAM_BRIDGE_DATA_DIR;
  const dirNodo = path.join(raiz, 'datos-nodo');
  const canal = crearCanalWeb();
  const lanzados = [];
  const servidorNodos = crearServidorNodos({ dataDir: dirServidor, canal, chatId: CHAT_WEB_LOCAL, almas: botMod.almasParaNodos({ lanzar: (a) => lanzados.push(a) }), rpcTimeoutMs: 2000 });
  const web = srv.crearServidorWeb({ nucleo: { canal, chatId: CHAT_WEB_LOCAL }, token: 'w'.repeat(48), red: { servidorNodos, nucleoRemoto: (id) => crearNucleoRemoto(servidorNodos.rpc, id) } });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${web.address().port}`;
  const { codigo } = admin.invitar(dirServidor);
  const { id: idNodo } = await admin.unirse(dirNodo, base, codigo, { nombre: 'casa-wsl' });
  const cliente = crearClienteNodo({ dataDir: dirNodo, nucleo: {}, canal: null, chatId: CHAT_WEB_LOCAL, permitidos: new Set(), backoffMinMs: 30, entreSaludosMs: 30 });
  cliente.iniciar();
  await hasta(() => servidorNodos.conectado(idNodo));
  const registro = { lista: () => [], alta: () => ({ ok: true }), baja: () => ({ ok: true }), renombrar: () => ({ ok: true }), silenciar: () => ({ ok: true }), enviar: () => ({ ok: true }) };
  const enlace = await arrancarEnlaceLocal({ registro, dataDir: dirNodo, rol: 'nodo', telegram: cliente });

  /** El conector del nodo, en otro proceso con su directorio de almas. */
  const conector = (codigoJs) => new Promise((resolve) => {
    const h = spawn(process.execPath, ['-e', `
      (async () => {
        const { crearAlmas } = require(${JSON.stringify(path.join(REPO, 'mcp-server/lib/almas-cliente.js'))});
        const a = crearAlmas();
        const r = {};
        try { ${codigoJs} } catch (e) { r.error = e.message; r.codigo = e.codigo; }
        console.log('RESULTADO ' + JSON.stringify(r));
      })();
    `], { env: { ...envNodo, TELEGRAM_BRIDGE_DATA_DIR: dirNodo } });
    let out = '';
    h.stdout.on('data', (d) => { out += d; });
    h.stderr.on('data', (d) => { out += d; });
    h.on('close', () => {
      const l = out.split(/\r?\n/).find((x) => x.startsWith('RESULTADO '));
      resolve(l ? JSON.parse(l.slice(10)) : { error: out.slice(-400) });
    });
  });

  try {
    await group('Operaciones: directa y por el camino remoto (§3.2, §10.1.1, §10.1.3)', async () => {
      const antes = arbol(almasNodo);
      const r = await conector(`
        r.enNodo = a.enNodo();
        r.listar = await a.listar();
        r.identidad = await a.identidad('alya');
        r.contexto = await a.contexto('alya');
        r.ver = await a.ver('alya');
        r.resumen = await a.resumenListado();
        r.inventario = await a.inventario();
      `);
      check('el conector del nodo se sabe nodo', r.enNodo === true, JSON.stringify(r).slice(0, 300));
      check('listar da las almas del servidor, no las del nodo', JSON.stringify(r.listar) === JSON.stringify(operaciones.listar()) && !r.listar.includes('diego'), JSON.stringify(r.listar));
      check('identidad remota = directa', r.identidad?.texto === operaciones.identidad('alya').texto && /servidor/.test(r.identidad.texto));
      check('contexto remoto = directo', r.contexto === operaciones.contexto('alya'));
      check('ver remoto = directo', JSON.stringify(r.ver) === JSON.stringify(operaciones.ver('alya')));
      check('resumen remoto = directo', JSON.stringify(r.resumen) === JSON.stringify(operaciones.resumenListado()));
      check('el inventario también es el del servidor', r.inventario?.almas?.some((x) => x.clave === 'alya') && !r.inventario.almas.some((x) => x.clave === 'diego'));
      check('el directorio local de almas del nodo no cambió', JSON.stringify(arbol(almasNodo)) === JSON.stringify(antes));
      const raro = await conector(`await a.consolidar === undefined; r.x = await (async () => { const res = await fetch(new URL('/almas', require('fs').readFileSync ? JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(dirNodo, 'enlace.json'))}, 'utf8')).url : ''), { method: 'POST', headers: { 'x-lagrange-token': JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(dirNodo, 'enlace.json'))}, 'utf8')).token, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'borrarTodo', args: [] }) }); return res.status; })();`);
      check('una operación fuera de la tabla → rechazada', raro.x === 400, JSON.stringify(raro));
      const sesion = await (async () => {
        const nodoJson = JSON.parse(fs.readFileSync(path.join(dirNodo, 'nodo.json'), 'utf8'));
        const n = identidad.nonce();
        const s = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 2, id: idNodo, nonceNodo: n } });
        return (await pedirHttp(base, '/nodo/sesion', { cuerpo: { id: idNodo, nonceServidor: s.datos.nonceServidor, firma: identidad.firmar(nodoJson.clavePrivada, identidad.textoSesion(idNodo, s.datos.nonceServidor, n)) } })).datos.sesion;
      })();
      const grande = await pedirHttp(base, '/nodo/almas', { encabezados: { 'x-lagrange-sesion': sesion }, cuerpo: { op: 'listar', args: ['x'.repeat(1100 * 1024)] } });
      check('más de 1 MB → 413', grande.status === 413, String(grande.status));
      const v1 = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 1, id: idNodo, nonceNodo: identidad.nonce() } });
      check('un nodo con protocolo 1 sigue entrando a un servidor con 2 (§10.1.14)', v1.status === 200 && identidad.PROTOCOLO === 2);
    });

    await group('Permiso de almas por nodo (§3.3, §10.1.12)', async () => {
      const escritura = await conector(`r.diario = await a.anotarDiario('alya', { superficie: 'narracion', resumen: 'desde el nodo' });`);
      check('con lectura, anotarDiario → 403 con el nombre del nodo', escritura.codigo === 403 && /casa-wsl no tiene permiso para escribir almas/.test(escritura.error || ''), JSON.stringify(escritura));
      for (const op of ['olvidar', 'sembrar', 'importar', 'consolidar']) {
        const r = await conector(`r.x = await a.${op}(${op === 'sembrar' ? "{ name: 'Nuevo' }" : op === 'consolidar' ? "{ clave: 'alya', turnos: [] }" : "'alya', 'm1'"});`);
        check(`con lectura, ${op} → 403`, r.codigo === 403, JSON.stringify(r));
      }
      admin.nivelDeAlmas(dirServidor, 'casa-wsl', 'escritura');
      const ok = await conector(`r.diario = await a.anotarDiario('alya', { superficie: 'narracion', resumen: 'desde el nodo' });`);
      const diario = require('../mcp-server/almas/diario.js').ultimas('alya', 3);
      check('con escritura pasa, y el diario registra el nodo', ok.diario?.ok === true && diario.some((e) => e.resumen === 'desde el nodo' && e.nodo === 'casa-wsl'), JSON.stringify(diario.slice(-1)));
    });

    await group('Consolidación de la charla de voz (§3.4, §10.1.5)', async () => {
      const dirPend = path.join(raiz, 'pendientes');
      fs.mkdirSync(dirPend, { recursive: true });
      const escribir = (n, obj) => fs.writeFileSync(path.join(dirPend, n), typeof obj === 'string' ? obj : JSON.stringify(obj));
      escribir('a.json', { clave: 'alya', streamId: 's1', turnos: [{ rol: 'usuario', texto: 'hola' }] });
      const caido = { conectado: () => false, almas: async () => { throw new Error('no'); } };
      await botMod.subirPendientes({ cliente: caido, dir: dirPend, log: () => {} });
      check('con el servidor caído el pendiente queda en el nodo', fs.existsSync(path.join(dirPend, 'a.json')));
      escribir('b.json', { clave: 'nadie', streamId: 's2', turnos: [] });
      escribir('c.json', '{roto');
      const r = await botMod.subirPendientes({ cliente, dir: dirPend, log: () => {} });
      check('al reconectar sube, el servidor lo consolida y el nodo lo borra', r.subidos === 1 && !fs.existsSync(path.join(dirPend, 'a.json')) && lanzados.length === 1 && fs.existsSync(lanzados[0]));
      check('uno inválido queda en rechazados/ y no se reintenta', fs.existsSync(path.join(dirPend, 'rechazados', 'b.json')) && fs.existsSync(path.join(dirPend, 'rechazados', 'c.json')));
      admin.nivelDeAlmas(dirServidor, 'casa-wsl', 'lectura');
      escribir('d.json', { clave: 'alya', streamId: 's3', turnos: [] });
      await botMod.subirPendientes({ cliente, dir: dirPend, log: () => {} });
      check('sin permiso de escritura queda en .pendientes (no en rechazados)', fs.existsSync(path.join(dirPend, 'd.json')) && !fs.existsSync(path.join(dirPend, 'rechazados', 'd.json')));

      // BE-074 — La subida al conectar y la del intervalo no se pisan: el servidor
      // no deduplica, y dos a la vez consolidarían el mismo pendiente dos veces.
      fs.rmSync(path.join(dirPend, 'd.json'), { force: true });
      escribir('e.json', { clave: 'alya', streamId: 's4', turnos: [] });
      let subidas = 0;
      let soltar;
      const lento = { conectado: () => true, almas: async () => { subidas++; await new Promise((ok) => { soltar = ok; }); } };
      const primera = botMod.subirPendientes({ cliente: lento, dir: dirPend, log: () => {} });
      const segunda = await botMod.subirPendientes({ cliente: lento, dir: dirPend, log: () => {} });
      check('una segunda subida mientras corre la primera no hace nada', segunda.enCurso === true && segunda.subidos === 0, JSON.stringify(segunda));
      soltar();
      const r1 = await primera;
      check('y el pendiente se sube una sola vez', subidas === 1 && r1.subidos === 1 && !fs.existsSync(path.join(dirPend, 'e.json')), `${subidas} ${JSON.stringify(r1)}`);
      const tercera = await botMod.subirPendientes({ cliente: lento, dir: dirPend, log: () => {} });
      check('terminada la primera, el candado se suelta', !tercera.enCurso, JSON.stringify(tercera));
    });

    await group('Servidor caído (§3.7, §10.1.4)', async () => {
      const muerto = await conector(`
        require('fs').writeFileSync(${JSON.stringify(path.join(raiz, 'enlace-muerto.json'))}, '');
        const { crearAlmas } = require(${JSON.stringify(path.join(REPO, 'mcp-server/lib/almas-cliente.js'))});
        const b = crearAlmas({ enlace: () => ({ url: 'http://127.0.0.1:1', token: 'x' }) });
        try { await b.identidad('alya'); } catch (e) { r.error = e.message; r.codigo = e.codigo; }
      `);
      check('sin servidor, la operación lanza un error claro (la narración lo convierte en aviso)', muerto.codigo === 503 && /viven en el servidor/.test(muerto.error || ''), JSON.stringify(muerto));
    });

    await group('reaccionable desde un nodo (§3.5, §10.1.6)', async () => {
      const enviados = [];
      const apiFalsa = () => ({ sendMessage: async (c, t) => { enviados.push({ c, t }); return { message_id: 321, chat: { id: c } }; }, sendVoice: async (c) => ({ message_id: 654, chat: { id: c } }) });
      const lista = () => [
        { nombre: 'general', botId: '1234567890', general: true, vinculo: { tipo: 'servidor' }, usuarios: new Set(['555000111']) },
        { nombre: 'alya', botId: '2223334445', general: false, vinculo: { tipo: 'alma', ref: 'alya' }, usuarios: new Set(['555000111']) }
      ];
      process.env.ALLOWED_USER_IDS = '555000111';
      const tg = botMod.telegramParaNodos({ lista, apiDeBot: apiFalsa });
      await tg.mensaje({ nombre: 'casa-wsl', texto: 'hola', reaccionable: { alma: 'alya', extracto: 'hola' } });
      const stateMod = await imp('state.js');
      const reg = stateMod.getReaccionable(321, { bot: '2223334445', chat: 555000111 });
      check('el servidor lo registra con el botId del bot del alma', reg?.alma === 'alya' && reg.modalidad === 'texto', JSON.stringify(reg));
      await check('con un alma que el servidor no tiene, el reenvío responde error', await tg.mensaje({ nombre: 'casa-wsl', texto: 'x', reaccionable: { alma: 'nadie', extracto: 'x' } }).then(() => false, (e) => e.codigo === 400));
    });

    await group('Daemon en rol nodo (§3.6, §10.1.7)', async () => {
      const anotados = [];
      botMod.resetRuntimeState();
      botMod.usarRedParaTests({ rol: 'nodo', cliente: { almas: async (op, args) => { anotados.push({ op, args }); return { ok: true }; } } });
      check('almasDisponibles() vacío', botMod.almasDisponibles().length === 0);
      const tareas = await imp('tareas.js');
      const prop = tareas.proponerTarjeta({ clave: 'alya', titulo: 'propuesta', pedido: 'algo' });
      const armado = botMod.armarNucleo({ logFile: path.join(raiz, 'daemon.log') });
      await armado.nucleo.borrarTarjeta(prop.tarea.id);
      await esperar(50);
      check('descartar una propuesta de alma manda anotarDiario al servidor', anotados.some((a) => a.op === 'anotarDiario' && a.args[0] === 'alya' && a.args[1].tipo === 'tablero:descartada'));
      armado.cerrar();
      const t = tareas.crearTarjeta({ titulo: 'x', pedido: 'y', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' } });
      const lanzada = await botMod.lanzarTarjetaWeb(t.tarea?.id ?? t.id);
      check('lanzar una tarjeta de alma en un nodo → 409 con el mensaje', lanzada?.codigo === 409 && /viven en el servidor/.test(lanzada.error || ''), JSON.stringify(lanzada));
      check('resolverAlma en un nodo contesta que las almas viven en el servidor', botMod.resolverAlma('alya').error === botMod.ALMAS_EN_SERVIDOR);
      check('las rutas de almas no están en la lista de un nodo', botMod.METODOS_DE_ALMAS.every((m) => ['almas', 'memoria', 'buscarProfunda', 'hiloAlma', 'diarioAlma', 'recordar', 'olvidar', 'hiloNuevo', 'mensaje'].includes(m)) && botMod.METODOS_DE_ALMAS.includes('almas'));
      const fuente = fs.readFileSync(path.join(BRIDGE, 'bot.js'), 'utf8');
      const usos = (fuente.match(/almasDisponibles\(\)/g) || []).length;
      check('los usos de almasDisponibles() en bot.js son los de la tabla del §3.6 (una definición + 9 usos)', usos === 10, String(usos));
      botMod.resetRuntimeState();
    });

    await group('Ruteo de Telegram (§5.1, §10.1.8)', () => {
      const red = { nodoPorAlias: () => null, nodoPorNombre: (n) => (n === 'casa-wsl' ? { id: idNodo } : null), existeNodo: () => true, nombreDe: () => 'casa-wsl' };
      const ctx = (texto, extra = {}) => ({ me: { id: 1234567890 }, chat: { id: 555000111, type: 'private' }, message: { text: texto, ...extra }, update: {} });
      const vinculoNodo = { tipo: 'nodo', ref: 'casa-wsl' };
      check('/charla por el bot de un nodo lo atiende el servidor', botMod.destinoDelUpdate(ctx('/charla hola'), { red, vinculo: vinculoNodo }) === null);
      check('/alma también', botMod.destinoDelUpdate(ctx('/alma'), { red, vinculo: vinculoNodo }) === null);
      check('/cancel alma al servidor, /cancel al nodo', botMod.destinoDelUpdate(ctx('/cancel alma'), { red, vinculo: vinculoNodo }) === null && botMod.destinoDelUpdate(ctx('/cancel'), { red, vinculo: vinculoNodo })?.id === idNodo);
    });

    await group('Migración (§4, §10.1.9)', async () => {
      const portableNodo = await conector(`
        const p = require(${JSON.stringify(path.join(REPO, 'mcp-server/almas/portable.js'))});
        r.alya = p.exportarAlma('alya', { incluirDiario: true });
        r.diego = p.exportarAlma('diego', { incluirDiario: true });
      `);
      const antes = arbol(almasServidor);
      const sim = operaciones.migrarAlma(portableNodo.diego, 'diego', { nodo: 'casa-wsl', simular: true });
      check('--simular no escribe nada', sim.simulado && JSON.stringify(arbol(almasServidor)) === JSON.stringify(antes));
      const nueva = operaciones.migrarAlma(portableNodo.diego, 'diego', { nodo: 'casa-wsl' });
      check('un alma nueva se crea', nueva.accion === 'creada' && fs.existsSync(rutasAlmas.rutasDe('diego').alma));
      const existente = operaciones.migrarAlma(portableNodo.alya, 'alya', { nodo: 'casa-wsl' });
      const textoServidor = fs.readFileSync(rutasAlmas.rutasDe('alya').alma, 'utf8');
      check('un alma existente con identidad distinta: la del servidor no se toca y la del nodo queda aparte',
        existente.identidadEnConflicto && /servidor/.test(textoServidor) && fs.existsSync(`${rutasAlmas.rutasDe('alya').alma}.nodo-casa-wsl`));
      const entradas = recuerdos.entradas(recuerdos.leer(rutasAlmas.rutasDe('alya').memoria, 'm')).map((e) => e.texto);
      check('las entradas se suman sin repetir', entradas.filter((e) => e === 'recuerdo del servidor').length === 1 && entradas.includes('solo en el nodo'));
      const otraVez = operaciones.migrarAlma(portableNodo.alya, 'alya', { nodo: 'casa-wsl' });
      check('correrla dos veces no duplica', otraVez.sumadas === 0);

      const tareas = await imp('tareas.js');
      const prog = await imp('programaciones.js');
      botMod.resetRuntimeState();
      const confirmadas = [];
      let fallar = true;
      botMod.usarRedParaTests({ rol: 'nodo', cliente: { almas: async (op, args) => {
        if (op === 'migrarTarjeta') { if (fallar) throw new Error('servidor caído'); confirmadas.push(args[0]); return { id: 'srv-1' }; }
        if (op === 'migrarProgramacion') { confirmadas.push(args[0]); return { id: 'srv-p' }; }
        return { accion: 'sumada', sumadas: 0 };
      } } });
      const tar = tareas.crearTarjeta({ titulo: 'de alya', pedido: 'p', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' } });
      const idTar = tar.tarea?.id ?? tar.id;
      const pr = prog.crear({ titulo: 'guardia', pedido: 'p', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' }, horario: 'cada 1h' }).programacion;
      const inf1 = await botMod.migrarAlmasDeNodo({});
      check('una tarjeta que el servidor no confirma no se borra del nodo', tareas.obtener(idTar) && inf1.errores.some((e) => e.includes(idTar)));
      fallar = false;
      const inf2 = await botMod.migrarAlmasDeNodo({});
      check('confirmada, se borra del nodo', !tareas.obtener(idTar) && inf2.tarjetas.some((t) => t.enServidor === 'srv-1'));
      check('la programación de alma pasa aunque falle una tarjeta, y se borra', !prog.obtener(pr.id) && inf1.programaciones.some((p) => p.id === pr.id && p.enServidor === 'srv-p'));
      botMod.resetRuntimeState();
    });

    await group('Réplica de lectura y vista conjunta (§6.4, §6.5, §10.1.10)', async () => {
      const dirRep = path.join(raiz, 'replicas-srv');
      let replicas = crearReplicas({ dataDir: dirRep, guardarCadaMs: 0 });
      replicas.aplicar(idNodo, { tipo: 'tarea', tarea: { id: 't_1', titulo: 'uno', estado: 'en_curso' } });
      replicas.aplicar(idNodo, { tipo: 'tarea', tarea: { id: 't_2', titulo: 'dos', estado: 'por_hacer' } });
      replicas.aplicar(idNodo, { tipo: 'tarea_borrada', id: 't_2' });
      replicas.aplicar(idNodo, { tipo: 'programacion', programacion: { id: 'p_1', titulo: 'cron' } });
      check('los eventos actualizan la réplica', replicas.de(idNodo).tareas.map((t) => t.id).join() === 't_1' && replicas.de(idNodo).programaciones.length === 1);
      replicas.rearmar(idNodo, { tareas: [{ id: 't_9', titulo: 'nueva', estado: 'en_curso' }], programaciones: [], workspaces: [{ id: 'w1', name: 'solo-wsl' }] });
      check('el rearmado la reemplaza entera', replicas.de(idNodo).tareas.map((t) => t.id).join() === 't_9');
      replicas.guardarYa();
      replicas = crearReplicas({ dataDir: dirRep });
      check('un reinicio del servidor la conserva', replicas.de(idNodo).tareas[0]?.id === 't_9' && replicas.de(idNodo).workspaces[0]?.name === 'solo-wsl');
      const fuente = fs.readFileSync(path.join(BRIDGE, 'bot.js'), 'utf8');
      const escrituras = (fuente.match(/replicasRed\??\.(aplicar|rearmar)\(/g) || []).length;
      check('ninguna acción del servidor escribe la réplica (solo los eventos y el rearmado)', escrituras === 2, String(escrituras));
      const redFalsa = { listaNodos: () => [{ id: idNodo, nombre: 'casa-wsl', conectado: false }] };
      const vista = botMod.vistaRed('tablero', { red: redFalsa, replicas });
      const remota = vista.tareas.find((t) => t.id === 't_9');
      check('/api/red/tablero muestra un nodo desconectado con su última vista y lo en curso sin conexión', remota?.sinConexion === true && remota.ultimaVista && /\[casa-wsl · sin conexión\]/.test(remota.titulo));
    });

    await group('Tablero de un alma sobre los nodos (§6.6, §10.1.11)', async () => {
      const replicas = crearReplicas({});
      replicas.rearmar(idNodo, { tareas: [{ id: 't_remota', titulo: 'arreglar el build', estado: 'por_hacer', creadaPor: 'alma:alya', propuesta: true, notasRecientes: [{ autor: 'usuario', texto: 'dale, pero sin tocar la API' }] }], workspaces: [{ id: 'w1', name: 'solo-wsl' }] });
      const rpcs = [];
      const red = {
        conectados: new Set([idNodo]),
        listaNodos() { return [{ id: idNodo, nombre: 'casa-wsl', conectado: this.conectados.has(idNodo) }]; },
        nombreDe: () => 'casa-wsl',
        conectado(id) { return this.conectados.has(id); },
        rpc: async (id, metodo, args) => { rpcs.push({ id, metodo, args }); return metodo === 'proponerTarjetaDeAlma' ? { ok: false, codigo: 403 } : { ok: true }; }
      };
      botMod.resetRuntimeState();
      botMod.usarRedParaTests({ rol: 'servidor', servidorNodos: red, replicas });
      const vista = botMod.resumenTableroParaAlma('alya');
      check('el resumen incluye la tarjeta de otro nodo con su nombre, sin pedirle nada', /t_remota .*en casa-wsl/.test(vista.texto) && rpcs.length === 0, vista.texto);
      check('con las notas de sus propias tarjetas', vista.texto.includes('sin tocar la API') && vista.nodos.get('t_remota') === idNodo);
      botMod.aplicarTableroDeAlma({ clave: 'alya', idsVistos: vista.ids, nodosVistos: vista.nodos, operaciones: [{ tipo: 'nota', tarjeta: 't_remota', texto: 'ok, sin la API' }] });
      await esperar(30);
      check('una nota va al nodo de la tarjeta', rpcs.some((r) => r.metodo === 'anotarDeAlma' && r.args[0] === 't_remota' && r.args[2] === 'alya'));
      red.conectados.clear();
      const r2 = botMod.aplicarTableroDeAlma({ clave: 'alya', idsVistos: vista.ids, nodosVistos: vista.nodos, operaciones: [{ tipo: 'nota', tarjeta: 't_remota', texto: 'otra' }] });
      check('a un nodo desconectado, la nota se rechaza con el motivo', r2.rechazos.some((m) => /casa-wsl sin conexión/.test(m)));
      botMod.resetRuntimeState();
    });
  } finally {
    cliente.detener();
    try { enlace?.servidor.close(); } catch {}
    web.close();
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
