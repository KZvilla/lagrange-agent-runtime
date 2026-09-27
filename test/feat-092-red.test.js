/**
 * FEAT-092 pasos 5-7 — Mensajes entre agentes de distintos nodos, la voz del
 * servidor para un nodo sin Voicebox y la lista de la red en la consola (§11.1).
 *
 * Servidor (`casa-win`) y nodo (`casa-wsl`) reales en este proceso, cada uno con
 * su registro de sesiones y su directorio de buzones. Nada sale de un
 * directorio temporal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-092-red-'));
fs.writeFileSync(path.join(raiz, '.env'), 'ALLOWED_USER_IDS=555000111\n');
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(raiz, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos-servidor');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
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

async function main() {
  const buzones = require('../mcp-server/lib/buzones.js');
  const { vozDelServidor } = require('../mcp-server/lib/voz-remota.js');
  const botMod = await imp('bot.js');
  const { crearRegistro } = await imp('mensajes.js');
  const { crearCanalWeb, CHAT_WEB_LOCAL } = await imp('web/canal.js');
  const srv = await imp('web/servidor.js');
  const { crearServidorNodos } = await imp('red/servidor-nodos.js');
  const { crearNucleoRemoto } = await imp('red/nucleo-remoto.js');
  const { crearClienteNodo, pedirHttp } = await imp('red/cliente-nodo.js');
  const { arrancarEnlaceLocal } = await imp('red/enlace-local.js');
  const identidad = await imp('red/identidad.js');
  const admin = await imp('red/admin.js');

  const dirServidor = process.env.TELEGRAM_BRIDGE_DATA_DIR;
  const dirNodo = path.join(raiz, 'datos-nodo');
  let permiteServidor = 'lectura';
  let permiteNodo = 'lectura';

  // ------------------------------------------------------------ voz (falsa)
  const notas = [];
  const telegramFalso = { voz: async (x) => { notas.push(x); return { ok: true }; } };
  const sintetizarFalso = async ({ texto }) => {
    const wav = path.join(raiz, `v-${notas.length}-${Date.now()}.wav`);
    fs.writeFileSync(wav, `WAV:${texto}`);
    return { ok: true, wavPath: wav, perfil: 'Alya', proveedor: 'falso' };
  };

  // ------------------------------------------------------------ servidor
  let mensajesRed = null;
  const regServidor = crearRegistro({
    dataDir: dirServidor,
    nodo: 'casa-win',
    remoto: { enviar: (s) => mensajesRed.rutear(s), agentes: async () => mensajesRed.agentes() },
    permite: () => permiteServidor,
    vivo: () => true
  });
  const canal = crearCanalWeb();
  let servidorNodos = null;
  mensajesRed = botMod.mensajesParaNodos({ registro: regServidor, red: () => servidorNodos, nombreLocal: 'casa-win' });
  servidorNodos = crearServidorNodos({
    dataDir: dirServidor, canal, chatId: CHAT_WEB_LOCAL, rpcTimeoutMs: 3000,
    mensajes: mensajesRed,
    vozNarrar: botMod.vozParaNodos({ telegram: telegramFalso, sintetizar: sintetizarFalso, log: () => {} }),
    alDesconectar: (id) => mensajesRed.olvidar(id)
  });
  const web = srv.crearServidorWeb({ nucleo: { canal, chatId: CHAT_WEB_LOCAL }, token: 'w'.repeat(48), red: { servidorNodos, nucleoRemoto: (id) => crearNucleoRemoto(servidorNodos.rpc, id) } });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${web.address().port}`;

  // ------------------------------------------------------------ nodo
  const { codigo } = admin.invitar(dirServidor);
  const { id: idNodo } = await admin.unirse(dirNodo, base, codigo, { nombre: 'casa-wsl' });
  // Un segundo nodo emparejado que nunca se conecta.
  const { codigo: codigo2 } = admin.invitar(dirServidor);
  await admin.unirse(path.join(raiz, 'datos-apagado'), base, codigo2, { nombre: 'apagado' });

  let regNodo = null;
  const cliente = crearClienteNodo({
    dataDir: dirNodo, nucleo: {}, canal: null, chatId: CHAT_WEB_LOCAL, permitidos: new Set(),
    onMensaje: (s) => regNodo.recibir(s),
    // Como en bot.js: al conectarse sube la lista (un alta anterior no llegó).
    onEstado: (campos) => { if (campos.conectado && regNodo) cliente.sesiones(regNodo.lista()).catch(() => {}); },
    backoffMinMs: 30, entreSaludosMs: 30
  });
  regNodo = crearRegistro({
    dataDir: dirNodo,
    nodo: () => cliente.nombre(),
    remoto: { enviar: (s) => cliente.mensajeAgente(s), agentes: () => cliente.agentes() },
    permite: () => permiteNodo,
    alCambiar: () => { cliente.sesiones(regNodo.lista()).catch(() => {}); },
    vivo: () => true
  });
  cliente.iniciar();
  await hasta(() => servidorNodos.conectado(idNodo));

  regServidor.alta({ sesion: 'sA', cwd: '/w/win-app', mcpPid: process.pid, claudePid: 900 });
  regNodo.alta({ sesion: 'sB', cwd: '/l/wsl-app', mcpPid: process.pid });
  await hasta(() => mensajesRed.agentes().some((s) => s.nodo === 'casa-wsl'));

  const enlace = await arrancarEnlaceLocal({ registro: regNodo, dataDir: dirNodo, rol: 'nodo', telegram: cliente });
  const enlaceJson = JSON.parse(fs.readFileSync(path.join(dirNodo, 'enlace.json'), 'utf8'));

  const sesionDeNodo = async () => {
    const nodoJson = JSON.parse(fs.readFileSync(path.join(dirNodo, 'nodo.json'), 'utf8'));
    const n = identidad.nonce();
    const s = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: identidad.PROTOCOLO, id: idNodo, nonceNodo: n } });
    return (await pedirHttp(base, '/nodo/sesion', { cuerpo: { id: idNodo, nonceServidor: s.datos.nonceServidor, firma: identidad.firmar(nodoJson.clavePrivada, identidad.textoSesion(idNodo, s.datos.nonceServidor, n)) } })).datos;
  };

  try {
    await group('Lista de la red (§4.3, §5.1)', async () => {
      const lista = mensajesRed.agentes();
      check('el servidor ve sus sesiones y las del nodo, con el nombre de nodo que él sabe', lista.some((s) => s.nodo === 'casa-win' && s.nombre === 'win-app') && lista.some((s) => s.nodo === 'casa-wsl' && s.nombre === 'wsl-app'), JSON.stringify(lista));
      const desdeNodo = await regNodo.listaRed();
      check('el nodo ve la de acá y la del servidor, sin repetir la suya', desdeNodo.sesiones.filter((s) => s.nodo === 'casa-wsl').length === 1 && desdeNodo.sesiones.some((s) => s.nodo === 'casa-win' && s.nombre === 'win-app'), JSON.stringify(desdeNodo));
      const porEnlace = await fetch(new URL('/sesiones', enlaceJson.url), { headers: { 'x-lagrange-token': enlaceJson.token } }).then((r) => r.json());
      check('el endpoint local (accion: agentes) devuelve la red', porEnlace.ok && porEnlace.sesiones.some((s) => s.nodo === 'casa-win'));
      await cliente.sesiones([{ nombre: 'MAL NOMBRE' }, { nombre: 'ok', host: 'h'.repeat(200), extra: 'z', entrega: 'raro' }]);
      const saneada = mensajesRed.agentes().filter((s) => s.nodo === 'casa-wsl');
      check('lo que manda un nodo se sanea: nombres válidos, campos conocidos y con tope',
        saneada.length === 1 && saneada[0].nombre === 'ok' && saneada[0].host.length === 64 && !('extra' in saneada[0]) && saneada[0].entrega === 'manual', JSON.stringify(saneada));
      await cliente.sesiones(regNodo.lista());
    });

    await group('Del servidor a un nodo, con el permiso del destino (§5.2, §6.1)', async () => {
      permiteNodo = 'operar';
      const r1 = await regServidor.enviar({ de: 'sA', para: 'casa-wsl/wsl-app', texto: 'hola' });
      check('a un nodo con operar no le llega: error claro', r1.ok === false && r1.codigo === 403 && /casa-wsl no acepta mensajes de otros nodos/.test(r1.error), JSON.stringify(r1));
      check('y el buzón queda vacío', buzones.leerMensajes(dirNodo, 'sB').length === 0);
      permiteNodo = 'ejecutar';
      const r2 = await regServidor.enviar({ de: 'sA', para: 'casa-wsl/wsl-app', texto: 'corré los tests' });
      const enB = buzones.leerMensajes(dirNodo, 'sB');
      check('con ejecutar, queda en el buzón del destino', r2.ok && enB.length === 1 && enB[0].texto === 'corré los tests', JSON.stringify(r2));
      check('el `de` lo pone el origen: casa-win/win-app', enB[0].de.nodo === 'casa-win' && enB[0].de.nombre === 'win-app' && enB[0].para === 'casa-wsl/wsl-app');
      check('dice cómo lo va a ver', /cuando lea su buzón/.test(r2.como));
    });

    await group('Del nodo al servidor, y la respuesta (§5.2, §6.3)', async () => {
      const original = buzones.leerMensajes(dirNodo, 'sB')[0];
      permiteServidor = 'lectura';
      const r1 = await regNodo.enviar({ de: 'sB', respuestaA: original.id, texto: 'van 3 fallas' });
      check('el servidor también aplica su BRIDGE_NODO_PERMITE', r1.codigo === 403 && /casa-win no acepta/.test(r1.error), JSON.stringify(r1));
      permiteServidor = 'ejecutar';
      const r2 = await regNodo.enviar({ de: 'sB', respuestaA: original.id, texto: 'van 3 fallas' });
      const enA = buzones.leerMensajes(dirServidor, 'sA');
      check('una respuesta va a quien mandó el original, en otro nodo', r2.ok && r2.para === 'casa-win/win-app' && enA.some((m) => m.respuestaA === original.id && m.cadena === 1 && m.de.nodo === 'casa-wsl'), JSON.stringify(r2));
      check('con `hooks`, dice que la despierta', /al terminar su turno/.test(r2.como));
      regServidor.silenciar('sA', true);
      const r3 = await regNodo.enviar({ de: 'sB', para: 'casa-win/win-app', texto: 'x' });
      check('una sesión silenciada no recibe', r3.codigo === 409, JSON.stringify(r3));
      regServidor.silenciar('sA', false);
    });

    await group('Sin cola: error inmediato (§5.1)', async () => {
      const inexistente = await regNodo.enviar({ de: 'sB', para: 'casa-win/nadie', texto: 'x' });
      check('a una sesión inexistente de otro nodo, 404', inexistente.codigo === 404, JSON.stringify(inexistente));
      const sinNodo = await regServidor.enviar({ de: 'sA', para: 'no-existe/x', texto: 'x' });
      check('a un nodo que no está en la red, 404', sinNodo.codigo === 404 && /No hay un nodo no-existe/.test(sinNodo.error));
      const apagado = await regServidor.enviar({ de: 'sA', para: 'apagado/x', texto: 'x' });
      check('a un nodo desconectado, 503 ya', apagado.codigo === 503 && /apagado está desconectado/.test(apagado.error), JSON.stringify(apagado));
      const invalido = regNodo.enviar({ de: 'sB', para: 'Casa/x', texto: 'x' });
      check('un destino con forma inválida no sale', invalido.codigo === 400);
    });

    await group('Frenos en el origen (§6.3)', async () => {
      const t = Date.now();
      buzones.agregar(dirNodo, 'sB', { id: 'm_00000000aa', de: { nodo: 'casa-win', sesion: 'sA', nombre: 'win-app' }, para: 'casa-wsl/wsl-app', texto: 'x', respuestaA: null, cadena: 9, creado: new Date(t).toISOString() }, t);
      const r = regNodo.enviar({ de: 'sB', respuestaA: 'm_00000000aa', texto: 'otra vuelta' });
      check('cadena 10 se rechaza antes de salir', r.codigo === 429 && /10 idas y vueltas/.test(r.error));
      const recibido = regNodo.recibir({ id: 'm_00000000bb', de: { nodo: 'casa-win', sesion: 'sA', nombre: 'win-app' }, para: 'casa-wsl/wsl-app', texto: 'x', respuestaA: null, cadena: 10, creado: '' });
      check('y un sobre con cadena 10 que llega igual se rechaza en el destino', recibido.codigo === 400);
    });

    await group('El servidor verifica el remitente (§5.2)', async () => {
      const ses = await sesionDeNodo();
      const falso = await pedirHttp(base, '/nodo/mensajes', { encabezados: { 'x-lagrange-sesion': ses.sesion }, cuerpo: { sobre: { id: 'm_00000000cc', de: { nodo: 'casa-win', sesion: 'sA', nombre: 'win-app' }, para: 'casa-win/win-app', texto: 'suplantado', respuestaA: null, cadena: 0, creado: '' } } });
      check('un `de.nodo` que no es el de la conexión → 403', falso.status === 403 && /no es este nodo/.test(falso.datos.error), JSON.stringify(falso.datos));
      check('y no llegó nada', !buzones.leerMensajes(dirServidor, 'sA').some((m) => m.texto === 'suplantado'));
      check('el apretón de manos declara la voz del servidor', Array.isArray(ses.capacidades) && ses.capacidades.includes('voz') && cliente.capacidadesServidor().includes('voz'));
      const mismo = regServidor.recibir({ id: 'm_00000000dd', de: { nodo: 'casa-win', sesion: 'sA', nombre: 'win-app' }, para: 'casa-win/win-app', texto: 'x', respuestaA: null, cadena: 0, creado: '' });
      check('un sobre "de otro nodo" con el nombre propio se rechaza', mismo.codigo === 400);
    });

    await group('La voz del servidor para un nodo sin Voicebox (§8)', async () => {
      const r = await vozDelServidor({ texto: 'Listo, ya quedó.', voz: 'Alya', alma: 'alya', enlace: () => enlaceJson });
      check('el nodo delega y la nota sale del servidor', r?.ok === true && r.perfil === 'Alya' && notas.length === 1, JSON.stringify(r));
      check('con el nombre del nodo y el audio sintetizado', notas[0].nombre === 'casa-wsl' && notas[0].buffer.toString() === 'WAV:Listo, ya quedó.');
      check('con reaccionable si trae alma', notas[0].reaccionable?.alma === 'alya' && notas[0].reaccionable.extracto === 'Listo, ya quedó.');
      check('el wav temporal se borra', !fs.readdirSync(raiz).some((f) => f.endsWith('.wav')));
      check('en un conector que no es de un nodo no aplica (null)', (await vozDelServidor({ texto: 'x', enlace: () => null })) === null);
      const fuente = fs.readFileSync(path.join(REPO, 'mcp-server', 'index.js'), 'utf8');
      check('con reproducción local no se delega (el audio sonaría en otra máquina)', /if \(sendTelegram && !localPlayback\) \{\r?\n\s+const clave[^\n]*\r?\n\s+const v = await vozDelServidor/.test(fuente));
      check('las tres narraciones sin audio pasan la voz y el modo', (fuente.match(/voz: typeof args\.voice === 'string' \? args\.voice : null,/g) || []).length === 3);

      // Una a la vez, tope 5 en espera; si el servidor tampoco puede, error claro.
      let soltar;
      const lento = () => new Promise((res) => { soltar = res; });
      let enCurso = 0; let maximo = 0;
      const voz = botMod.vozParaNodos({
        telegram: telegramFalso, tope: 2, log: () => {},
        sintetizar: async (o) => { enCurso++; maximo = Math.max(maximo, enCurso); await lento(); enCurso--; return sintetizarFalso(o); }
      });
      const p1 = voz({ nombre: 'n', texto: 'uno' });
      const p2 = voz({ nombre: 'n', texto: 'dos' });
      const p3 = voz({ nombre: 'n', texto: 'tres' });
      const p4 = await voz({ nombre: 'n', texto: 'cuatro' });
      check('con la cola llena, 429', p4.codigo === 429);
      for (let i = 0; i < 3; i++) { await hasta(() => Boolean(soltar)); const s = soltar; soltar = null; s(); await esperar(10); }
      const res = await Promise.all([p1, p2, p3]);
      check('de a una por vez, y todas salen', maximo === 1 && res.every((x) => x.ok));
      const falla = await botMod.vozParaNodos({ telegram: telegramFalso, log: () => {}, sintetizar: async () => ({ ok: false, motivo: 'provider_unavailable' }) })({ nombre: 'n', texto: 'x' });
      check('si el servidor tampoco tiene voz, error con el motivo', falla.ok === false && /El servidor tampoco pudo sintetizar/.test(falla.error));
    });

    await group('Consola: agentes en la red (§9)', () => {
      const vista = botMod.sesionesWeb();
      check('la vista de sesiones trae la lista `red`', Array.isArray(vista.red));
      const app = fs.readFileSync(path.join(BRIDGE, 'web', 'public', 'app.js'), 'utf8');
      check('y la consola la pinta, sin mensajes', app.includes("tabla('Agentes en la red'") && !/Agentes en la red[^\n]*texto/.test(app));
    });

    await group('Nodo desconectado (§5.1)', async () => {
      cliente.detener();
      await hasta(() => !servidorNodos.conectado(idNodo));
      check('al desconectarse, sus sesiones salen de la lista de la red', !mensajesRed.agentes().some((s) => s.nodo === 'casa-wsl'));
      const r = await regNodo.enviar({ de: 'sB', para: 'casa-win/win-app', texto: 'x' });
      check('desde un nodo sin servidor, error inmediato', r.ok === false && r.codigo === 503 && /No se pudo llegar a casa-win/.test(r.error), JSON.stringify(r));
      const lista = await regNodo.listaRed();
      check('y agentes muestra las de acá con el aviso', lista.sesiones.length === 1 && /Solo las de este nodo/.test(lista.aviso || ''));
    });
  } finally {
    cliente.detener();
    try { enlace?.servidor.close(); } catch {}
    web.close();
  }
  fs.rmSync(raiz, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
