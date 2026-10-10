/**
 * SEC-022 — Permisos por nodo y salida de loopback (§8.1).
 *
 * Servidor y nodo armados desde los módulos, como en FEAT-089. El nivel lo
 * fija el nodo (`permite`); el servidor anticipa. Las interfaces de red y el
 * resolvedor de nombres se inyectan.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const BRIDGE = path.join(__dirname, '..', 'telegram-bridge');
const imp = (f) => import(pathToFileURL(path.join(BRIDGE, f)).href);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 5000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) { if (await cond()) return true; await esperar(20); }
  return false;
}
function crudo(base, ruta, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = http.request(new URL(ruta, base), { method, headers }, (res) => {
      const partes = [];
      res.on('data', (d) => partes.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(partes);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json, buf, tipo: res.headers['content-type'] });
      });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.end(body || undefined);
  });
}
const escuchar = (s, puerto = 0, ip = '127.0.0.1') => new Promise((r) => s.listen(puerto, ip, () => r(`http://${ip}:${s.address().port}`)));

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-022-'));
  const { crearCanalWeb, CHAT_WEB_LOCAL } = await imp('web/canal.js');
  const srv = await imp('web/servidor.js');
  const { crearServidorNodos } = await imp('red/servidor-nodos.js');
  const { crearNucleoRemoto } = await imp('red/nucleo-remoto.js');
  const { crearClienteNodo, pedirHttp, resumenDeArgs } = await imp('red/cliente-nodo.js');
  const identidad = await imp('red/identidad.js');
  const admin = await imp('red/admin.js');
  const dirs = await imp('red/direcciones.js');
  const { crearServidorListener, arrancarListenerNodos } = await imp('red/listener-nodos.js');

  await group('Tabla de niveles (§3.1, §8.1.1)', () => {
    const mut = srv.metodosDeMutacion();
    const tabla = new Set(Object.keys(srv.NIVEL_DE_MUTACION));
    check('toda ruta mutacion tiene nivel', [...mut].every((m) => tabla.has(m)), [...mut].filter((m) => !tabla.has(m)).join(', '));
    check('la tabla no tiene métodos que no sean de mutaciones', [...tabla].every((m) => mut.has(m)), [...tabla].filter((m) => !mut.has(m)).join(', '));
    // FEAT-138 sumó moverTarjeta (operar).
    // FEAT-138 sumó moverTarjeta; FEAT-149, crearReceta y versionReceta (operar); F3, revisarReceta (lectura) y comprobarReceta (operar);
    // F4b, responderLote (ejecutar).
    check('son 38', mut.size === 38, String(mut.size));
    check('ningún método de una ruta GET tiene nivel de mutación', [...srv.metodosPermitidos()].every((m) => !tabla.has(m)));
    check('crearTarjeta sin lanzar → operar', srv.nivelDe('crearTarjeta', [{ titulo: 'x' }]) === 'operar');
    check('crearTarjeta con lanzar: true → ejecutar', srv.nivelDe('crearTarjeta', [{ titulo: 'x', lanzar: true }]) === 'ejecutar');
    check('descartarLote → ejecutar', srv.nivelDe('descartarLote', ['l1', {}]) === 'ejecutar');
    check('integrarLote → ejecutar (FEAT-108)', srv.nivelDe('integrarLote', ['l1', {}]) === 'ejecutar');
    check('tareas → lectura; un método desconocido → null', srv.nivelDe('tareas', []) === 'lectura' && srv.nivelDe('borrarTodo', []) === null);
    // La interfaz frena antes lo que pide ejecutar: su lista de rutas tiene que cubrir los métodos de ese nivel.
    // FEAT-136 — La tabla vive en ui/nucleo.js (`export const RUTAS_EJECUTAR = [...]`).
    const appJs = fs.readFileSync(path.join(BRIDGE, 'web', 'public', 'ui', 'nucleo.js'), 'utf8');
    const trozo = appJs.slice(appJs.indexOf('const RUTAS_EJECUTAR = ['), appJs.indexOf('];', appJs.indexOf('const RUTAS_EJECUTAR = [')) + 2);
    const rutasEjecutar = new Function(`${trozo.replace('const RUTAS_EJECUTAR =', 'return')}`)();
    const muestras = { mensaje: '/api/almas/a/mensaje', castear: '/api/cast', reintentarTarea: '/api/tareas/t/reintentar', escucharTarea: '/api/tareas/t/escuchar', prepararVoz: '/api/voz/preparar',
      lanzarTarjeta: '/api/tarjetas/t/lanzar', partirTarjeta: '/api/tarjetas/t/partir', lanzarLote: '/api/tarjetas/t/lote', descartarLote: '/api/lotes/l/descartar', integrarLote: '/api/lotes/l/integrar', responderLote: '/api/lotes/l/tareas/t/responder', guardarMotor: '/api/motores/rol', crearProgramacion: '/api/programaciones' };
    const ejecutar = Object.entries(srv.NIVEL_DE_MUTACION).filter(([, n]) => n === 'ejecutar').map(([m]) => m);
    check('la interfaz conoce la ruta de cada método de ejecutar', ejecutar.every((m) => muestras[m] && rutasEjecutar.some((r) => r.test(muestras[m]))), ejecutar.filter((m) => !muestras[m] || !rutasEjecutar.some((r) => r.test(muestras[m]))).join(', '));
    check('y no marca como ejecutar una ruta de operar', !rutasEjecutar.some((r) => r.test('/api/tareas/t/cancelar') || r.test('/api/tarjetas/t/editar') || r.test('/api/programaciones/p/pausar')));
    check('los niveles son acumulativos', srv.nivelAlcanza('ejecutar', 'operar') && srv.nivelAlcanza('operar', 'lectura') && !srv.nivelAlcanza('operar', 'ejecutar') && !srv.nivelAlcanza('raro', 'lectura'));
  });

  // ------------------------------------------------------------ red armada
  const dirServidor = path.join(raiz, 'servidor');
  const dirNodo = path.join(raiz, 'nodo');
  fs.mkdirSync(dirServidor, { recursive: true });
  const canal = crearCanalWeb();
  const servidorNodos = crearServidorNodos({ dataDir: dirServidor, canal, chatId: CHAT_WEB_LOCAL, latidoMs: 150, rpcTimeoutMs: 1500, rpcTimeoutVozMs: 4000 });
  const TOKEN = 't'.repeat(48);
  const lineasServidor = [];
  const logOriginal = console.log;
  console.log = (...a) => { const l = a.join(' '); if (l.startsWith('[remoto]')) lineasServidor.push(l); else logOriginal(...a); };
  const web = srv.crearServidorWeb({
    nucleo: { canal, chatId: CHAT_WEB_LOCAL }, token: TOKEN,
    red: { servidorNodos, nucleoRemoto: (id) => crearNucleoRemoto(servidorNodos.rpc, id), nombreLocal: 'casa' }
  });
  const base = await escuchar(web);
  const { codigo } = admin.invitar(dirServidor);
  const { id } = await admin.unirse(dirNodo, base, codigo, { nombre: 'casa-wsl' });

  const llamadas = [];
  let demoraVoz = 0;
  const nucleoNodo = new Proxy({}, {
    get: (_, m) => {
      if (typeof m !== 'string') return undefined;
      if (m === 'escucharTarea') return async (t) => { llamadas.push([m, t]); await esperar(demoraVoz); return { binario: Buffer.alloc(1000, 7), tipo: 'audio/wav' }; };
      if (m === 'tareas') return async () => { llamadas.push([m]); await esperar(demoraVoz); return { tareas: [] }; };
      return (...args) => { llamadas.push([m, ...args]); return { ok: true }; };
    }
  });
  const lineasNodo = [];
  let cliente = null;
  const conectar = async (permite) => {
    cliente?.detener();
    await hasta(() => !servidorNodos.conectado(id), 2000);
    cliente = crearClienteNodo({
      dataDir: dirNodo, nucleo: nucleoNodo, canal: crearCanalWeb(), chatId: CHAT_WEB_LOCAL, permitidos: srv.metodosPermitidos(),
      permite, backoffMinMs: 30, entreSaludosMs: 30, log: (l) => lineasNodo.push(l)
    });
    cliente.iniciar();
    return hasta(() => servidorNodos.conectado(id) && servidorNodos.permiteDe(id) === permite);
  };
  const conToken = { 'x-lagrange-token': TOKEN };
  const mutar = (ruta, cuerpo = {}) => crudo(base, `/api/n/${id}${ruta}`, { method: 'POST', headers: { ...conToken, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(cuerpo) });

  try {
    await group('El nodo es la autoridad (§3.2, §8.1.2)', async () => {
      check('conecta con permite lectura', await conectar('lectura'));
      llamadas.length = 0;
      const r1 = await servidorNodos.rpc(id, 'cancelarTarea', ['t1']);
      check('lectura: cancelarTarea directo al nodo → 403 sin efecto', r1.codigo === 403 && /no permite operar/.test(r1.error) && !llamadas.length, JSON.stringify(r1));

      check('conecta con permite operar', await conectar('operar'));
      llamadas.length = 0;
      const ok1 = await servidorNodos.rpc(id, 'cancelarTarea', ['t1']);
      const ok2 = await servidorNodos.rpc(id, 'crearTarjeta', [{ titulo: 'x' }]);
      check('operar: cancelarTarea y crearTarjeta sin lanzar pasan', ok1.ok && ok2.ok && llamadas.length === 2);
      const no1 = await servidorNodos.rpc(id, 'lanzarTarjeta', ['t1']);
      const no2 = await servidorNodos.rpc(id, 'crearTarjeta', [{ titulo: 'x', lanzar: true }]);
      const no3 = await servidorNodos.rpc(id, 'descartarLote', ['l1', { confirmacion: 'l1' }]);
      check('operar: lanzarTarjeta, crearTarjeta con lanzar y descartarLote → 403 (aunque el servidor no anticipe)', [no1, no2, no3].every((r) => r.codigo === 403) && llamadas.length === 2);

      check('conecta con permite ejecutar', await conectar('ejecutar'));
      llamadas.length = 0;
      const todos = await Promise.all([['lanzarTarjeta', ['t1']], ['crearTarjeta', [{ lanzar: true }]], ['descartarLote', ['l1', {}]], ['cancelarTarea', ['t1']]].map(([m, a]) => servidorNodos.rpc(id, m, a)));
      check('ejecutar: pasan todos', todos.every((r) => r.ok) && llamadas.length === 4);
    });

    await group('Argumentos, anticipo, registro y binario (§3.2-§4, §8.1.2b-6)', async () => {
      llamadas.length = 0;
      lineasNodo.length = 0;
      lineasServidor.length = 0;
      await mutar('/almas/alya/mensaje', { texto: 'secreto del pedido' });
      await mutar('/cancelar', { carril: 'alma' });
      await mutar('/tareas/archivar', { ids: ['a1', 'a2'] });
      check('mensaje llega con los mismos argumentos', llamadas.some((l) => l[0] === 'mensaje' && l[1] === 'alya' && l[2] === 'secreto del pedido'));
      check('cancelar llega con el carril', llamadas.some((l) => l[0] === 'cancelar' && l[1] === 'alma'));
      check('archivarTareas llega con la lista de ids', llamadas.some((l) => l[0] === 'archivarTareas' && JSON.stringify(l[1]) === '["a1","a2"]'));
      check('cada acción remota deja una línea en el log del nodo', lineasNodo.some((l) => /^\[remoto\] mensaje alya … desde .+ → ok$/.test(l)) && lineasNodo.some((l) => /\[remoto\] archivarTareas \[a1,a2\]/.test(l)), lineasNodo.join(' | '));
      check('y en el del servidor', lineasServidor.some((l) => /\[remoto\] .+ mensaje → ok/.test(l)), lineasServidor.join(' | '));
      check('sin el texto del pedido', ![...lineasNodo, ...lineasServidor].some((l) => l.includes('secreto del pedido')));
      check('el resumen no incluye textos', resumenDeArgs(['t1', 'hola mundo', { id: 'x', pedido: 'no' }]) === 't1 … {id=x}');

      const bin = await mutar('/tareas/t1/escuchar');
      check('escucharTarea remoto con ejecutar devuelve el audio', bin.status === 200 && /audio\/wav/.test(bin.tipo || '') && bin.buf.length === 1000, `${bin.status} ${bin.tipo}`);
      demoraVoz = 2200;
      const lenta = await mutar('/tareas/t1/escuchar');
      check('una síntesis que tarda más que el timeout general no se corta', lenta.status === 200);
      demoraVoz = 4500;
      const muyLenta = await mutar('/tareas/t1/escuchar');
      check('pasado su propio límite → 504', muyLenta.status === 504, String(muyLenta.status));
      demoraVoz = 0;
      const sesion = await sesionManual();
      const grande = await crudo(base, `/nodo/respuesta/${'1'.repeat(32)}`, { method: 'POST', headers: { 'x-lagrange-sesion': sesion, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(21 * 1024 * 1024) });
      check('una respuesta binaria de más de 20 MB → corte', grande.status === 413, String(grande.status));

      check('conecta con permite lectura otra vez', await conectar('lectura'));
      llamadas.length = 0;
      const anticipo = await mutar('/tareas/t1/cancelar');
      check('el servidor anticipa: 403 sin RPC', anticipo.status === 403 && /permite solo lectura/.test(anticipo.json?.error || '') && !llamadas.length, JSON.stringify(anticipo.json));
      const nodos = await crudo(base, '/api/nodos', { headers: conToken });
      check('/api/nodos incluye permite', nodos.json.nodos.find((n) => n.id === id)?.permite === 'lectura');
    });

    await group('Pedidos en vuelo al cortarse el flujo (§8.1.11)', async () => {
      demoraVoz = 8000;
      const t0 = Date.now();
      const enVuelo = servidorNodos.rpc(id, 'tareas', []);
      await esperar(50);
      cliente.detener();
      const r = await enVuelo;
      demoraVoz = 0;
      check('la pestaña recibe 503 enseguida', r.codigo === 503 && Date.now() - t0 < 1400, `${r.codigo} en ${Date.now() - t0} ms`);
    });

    async function sesionManual() {
      const nodoJson = JSON.parse(fs.readFileSync(path.join(dirNodo, 'nodo.json'), 'utf8'));
      const n = identidad.nonce();
      const s = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 1, id, nonceNodo: n } });
      const r = await pedirHttp(base, '/nodo/sesion', { cuerpo: { id, nonceServidor: s.datos.nonceServidor, firma: identidad.firmar(nodoJson.clavePrivada, identidad.textoSesion(id, s.datos.nonceServidor, n)) } });
      return r.datos.sesion;
    }

    await group('Apretón de manos reforzado (§8.1.10)', async () => {
      const nodoJson = JSON.parse(fs.readFileSync(path.join(dirNodo, 'nodo.json'), 'utf8'));
      const otro = path.join(raiz, 'otro');
      const { codigo: c2 } = admin.invitar(dirServidor);
      const { id: id2 } = await admin.unirse(otro, base, c2, { nombre: 'otro' });
      const nOtro = identidad.nonce();
      const sOtro = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 1, id: id2, nonceNodo: nOtro } });
      const cruzado = await pedirHttp(base, '/nodo/sesion', { cuerpo: { id, nonceServidor: sOtro.datos.nonceServidor, firma: identidad.firmar(nodoJson.clavePrivada, identidad.textoSesion(id, sOtro.datos.nonceServidor, nOtro)) } });
      check('sesion con un nonceServidor de otro id → rechazo', cruzado.status === 401);
      const saludos = [];
      for (let i = 0; i < 5; i++) {
        const n = identidad.nonce();
        saludos.push({ n, s: await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 1, id, nonceNodo: n } }) });
      }
      const firmaDe = (x) => identidad.firmar(nodoJson.clavePrivada, identidad.textoSesion(id, x.s.datos.nonceServidor, x.n));
      const viejo = await pedirHttp(base, '/nodo/sesion', { cuerpo: { id, nonceServidor: saludos[0].s.datos.nonceServidor, firma: firmaDe(saludos[0]) } });
      const nuevo = await pedirHttp(base, '/nodo/sesion', { cuerpo: { id, nonceServidor: saludos[4].s.datos.nonceServidor, firma: firmaDe(saludos[4]) } });
      check('el quinto saludo del mismo id descarta el nonce más viejo', viejo.status === 401 && nuevo.status === 200);

      admin.revocar(dirServidor, 'otro');
      const estados = [];
      const huerfano = crearClienteNodo({ dataDir: otro, nucleo: {}, canal: null, chatId: CHAT_WEB_LOCAL, permitidos: new Set(), backoffMinMs: 20, entreSaludosMs: 20, onEstado: (e) => estados.push(e) });
      huerfano.iniciar();
      const bajo = await hasta(() => estados.some((e) => e.estado === 'desconocido-para-el-servidor'), 4000);
      huerfano.detener();
      check('tres 401 desconocido seguidos → marca el estado y baja el ritmo', bajo);
      check('y no borra nodo.json', fs.existsSync(path.join(otro, 'nodo.json')));
    });

    await group('Límites por IP (§5.4, §8.1.9)', async () => {
      const dirLim = path.join(raiz, 'limites');
      fs.mkdirSync(dirLim);
      const sn = crearServidorNodos({ dataDir: dirLim, canal, chatId: CHAT_WEB_LOCAL });
      const wl = srv.crearServidorWeb({ nucleo: { canal, chatId: CHAT_WEB_LOCAL }, token: TOKEN, red: { servidorNodos: sn, nucleoRemoto: () => ({}) } });
      const bl = await escuchar(wl);
      const { codigo: c3 } = admin.invitar(dirLim);
      const { id: id3 } = await admin.unirse(path.join(raiz, 'lim-nodo'), bl, c3, { nombre: 'lim' });
      let ultimo = null;
      let exitosos = 0;
      for (let i = 0; i < 61; i++) {
        ultimo = await pedirHttp(bl, '/nodo/saludo', { cuerpo: { v: 1, id: id3, nonceNodo: identidad.nonce() } });
        if (ultimo.status === 200) exitosos++;
      }
      check('el pedido 61 sin sesión en un minuto → 429, aunque los otros fueran saludos exitosos', exitosos === 59 && ultimo.status === 429, `${exitosos} ${ultimo.status}`);
      wl.close();

      const dirLim2 = path.join(raiz, 'limites2');
      fs.mkdirSync(dirLim2);
      const sn2 = crearServidorNodos({ dataDir: dirLim2, canal, chatId: CHAT_WEB_LOCAL });
      const wl2 = srv.crearServidorWeb({ nucleo: { canal, chatId: CHAT_WEB_LOCAL }, token: TOKEN, red: { servidorNodos: sn2, nucleoRemoto: () => ({}) } });
      const bl2 = await escuchar(wl2);
      const claves = identidad.generarClaves();
      const estados = [];
      for (let i = 0; i < 11; i++) {
        const r = await pedirHttp(bl2, '/nodo/emparejar', { cuerpo: { codigo: 'MALO', id: '33333333-3333-4333-8333-333333333333', nombre: 'x', clavePublica: claves.clavePublica } });
        estados.push(r.status);
      }
      check('el intento fallido 11 de emparejar → 429', estados.slice(0, 10).every((s) => s === 403) && estados[10] === 429, estados.join(','));
      wl2.close();
    });
  } finally {
    cliente?.detener();
    console.log = logOriginal;
    web.close();
  }

  await group('Listener de nodos (§5.1-§5.2, §8.1.7)', async () => {
    const win = { 'Tailscale Tunnel': [{ address: '100.101.1.2' }], Ethernet: [{ address: '100.70.0.5' }], 'Wi-Fi': [{ address: '192.168.1.20' }], wg0: [{ address: '10.8.0.2' }] };
    const lin = { tailscale0: [{ address: '100.99.0.1' }], eth0: [{ address: '100.64.0.9' }] };
    const v = (valor, interfaces, plataforma, cifrada = '') => dirs.validarEscucha(valor, { interfaces, plataforma, cifrada });
    check('IP de la interfaz Tailscale (Windows, con sufijo) → arranca', v('100.101.1.2:4520', win, 'win32').ok);
    check('IP de tailscale0 (Linux) → arranca', v('100.99.0.1:4520', lin, 'linux').ok);
    check('100.x en una interfaz Ethernet (CGNAT del proveedor) → no arranca', !v('100.70.0.5:4520', win, 'win32').ok && !v('100.64.0.9:4520', lin, 'linux').ok);
    check('una privada en wg0 declarada como cifrada → arranca', v('10.8.0.2:4520', win, 'win32', 'wg0').ok);
    check('en Wi-Fi → no, aunque se declare otra cifrada', !v('192.168.1.20:4520', win, 'win32', 'wg0').ok);
    check('0.0.0.0, loopback o una IP ajena → no', !v('0.0.0.0:4520', win, 'win32').ok && !v('127.0.0.1:4520', win, 'win32').ok && !v('100.100.100.100:4520', win, 'win32').ok);
    check('el error nombra la interfaz', /Ethernet/.test(v('100.70.0.5:4520', win, 'win32').error));
    check('sin BRIDGE_NODOS_ESCUCHAR no existe', (await arrancarListenerNodos({ env: {}, servidorNodos: null })) === null);
    check('con una IP que no es de túnel no arranca', (await arrancarListenerNodos({ env: { BRIDGE_NODOS_ESCUCHAR: '100.70.0.5:4520' }, servidorNodos: null, interfaces: win, plataforma: 'win32' })) === null);

    // El servidor del listener, en loopback para probar sus reglas.
    const libre = http.createServer();
    const puerto = Number(new URL(await escuchar(libre)).port);
    await new Promise((r) => libre.close(r));
    const atendidos = [];
    const falso = { atender: async (req, res, url) => { atendidos.push(url.pathname); res.writeHead(200); res.end('{}'); } };
    const ls = crearServidorListener({ servidorNodos: falso, ip: '127.0.0.1', puerto, nombres: ['casa.ts.net'] });
    const bl = await escuchar(ls, puerto);
    const api = await crudo(bl, '/api/tareas');
    const login = await crudo(bl, '/login?t=x');
    check('/api/tareas y /login → 404', api.status === 404 && login.status === 404);
    const hostMalo = await crudo(bl, '/nodo/saludo', { method: 'POST', headers: { host: 'otra.cosa:1' } });
    check('un Host que no es la IP ni un nombre permitido → 403', hostMalo.status === 403);
    const porNombre = await crudo(bl, '/nodo/saludo', { method: 'POST', headers: { host: `casa.ts.net:${puerto}` } });
    check('un nombre de BRIDGE_NODOS_NOMBRES pasa a /nodo/*', porNombre.status === 200 && atendidos.includes('/nodo/saludo'));
    ls.close();
  });

  await group('unirse y conexión (§5.3, §8.1.8)', async () => {
    const sinTs = { interfaces: { Ethernet: [{ address: '192.168.1.5' }] }, plataforma: 'win32' };
    const conTs = { interfaces: { 'Tailscale': [{ address: '100.80.0.2' }], wg0: [{ address: '10.8.0.3' }] }, plataforma: 'win32' };
    const resolverA = (ip) => async () => [{ address: ip, family: 4 }];
    const u = (url, red, interfazCifrada = '', resolver) => dirs.validarUrlDeServidor(url, { ...red, interfazCifrada }, resolver ? { resolver } : {});
    check('una URL que resuelve a pública → rechazo', !(await u('http://servidor.example:4520', conTs, '', resolverA('8.8.8.8'))).ok);
    check('una 100.x sin interfaz de Tailscale local → rechazo', !(await u('http://100.80.0.1:4520', sinTs)).ok);
    check('la misma con Tailscale activo → sirve', (await u('http://100.80.0.1:4520', conTs)).ok);
    check('MagicDNS (*.ts.net → 100.x) sirve', (await u('http://casa.tail1.ts.net:4520', conTs, '', resolverA('100.80.0.1'))).ok);
    check('privada sin --interfaz-cifrada → rechazo', !(await u('http://10.8.0.1:4520', conTs)).ok);
    check('privada con --interfaz-cifrada presente → sirve', (await u('http://10.8.0.1:4520', conTs, 'wg0')).ok);
    check('loopback siempre sirve', (await u('http://127.0.0.1:4518', sinTs)).ok);
    await check('unirse no escribe nada si la dirección no sirve',
      await admin.unirse(path.join(raiz, 'publico'), 'http://8.8.8.8:4520', 'X', { red: { direcciones: sinTs } }).then(() => false, (e) => /pública/.test(e.message) && !fs.existsSync(path.join(raiz, 'publico', 'nodo.json'))));

    let vuelta = 0;
    const resolver = (h, o, cb) => { vuelta++; cb(null, vuelta === 1 ? '100.80.0.1' : '8.8.4.4', 4); };
    const rechazos = [];
    const lookup = dirs.crearLookup(conTs, { resolver, alRechazar: (h, ip) => rechazos.push(ip) });
    const primera = await new Promise((r) => lookup('casa.ts.net', {}, (err, ip) => r({ err, ip })));
    const segunda = await new Promise((r) => lookup('casa.ts.net', {}, (err, ip) => r({ err, ip })));
    check('el lookup deja pasar la dirección del túnel', !primera.err && primera.ip === '100.80.0.1');
    check('si en la segunda conexión resuelve a otra cosa, la rechaza en el lookup', segunda.err?.code === 'EDIRECCIONRECHAZADA' && rechazos.includes('8.8.4.4'));
  });

  await group('BRIDGE_NODO_PERMITE inválido (§8.1.4)', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { planDeArranque } = await import(${JSON.stringify(pathToFileURL(path.join(BRIDGE, 'bot.js')).href)});
      console.log('RESULTADO ' + JSON.stringify([planDeArranque({ BRIDGE_ROL: 'nodo', BRIDGE_NODO_PERMITE: 'todo' }), planDeArranque({ BRIDGE_ROL: 'nodo', BRIDGE_NODO_PERMITE: ' Operar ' }), planDeArranque({ BRIDGE_ROL: 'nodo' })]));
    `], { encoding: 'utf8', timeout: 30000, env: { ...process.env, TELEGRAM_BRIDGE_DATA_DIR: raiz, TELEGRAM_BRIDGE_STATE_FILE: path.join(raiz, 'state.json') } });
    const linea = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RESULTADO '));
    const [malo, bien, nada] = linea ? JSON.parse(linea.slice(10)) : [];
    check('un valor inválido arranca en lectura y lo avisa', malo?.permite === 'lectura' && malo.avisos.some((a) => /BRIDGE_NODO_PERMITE=todo/.test(a)), r.stderr?.slice(-300));
    check('se normaliza', bien?.permite === 'operar');
    check('por defecto, lectura', nada?.permite === 'lectura');
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
