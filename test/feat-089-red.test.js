/**
 * FEAT-089 — Servidor y nodo (§7.1).
 *
 * Servidor y nodo se arman desde los módulos (`web/servidor.js`,
 * `red/servidor-nodos.js`, `red/cliente-nodo.js`), no desde `main()`, en este
 * proceso, con directorios de datos distintos y puertos efímeros. No hay
 * Telegram de verdad: el del servidor es un falso que anota.
 *
 * `notify.js` se prueba en procesos hijos (carga el `.env` al importarse), con
 * un endpoint local falso.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const REPO_ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(REPO_ROOT, 'telegram-bridge');
const imp = (f) => import(pathToFileURL(path.join(BRIDGE, f)).href);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasta(cond, ms = 5000, paso = 20) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await cond()) return true;
    await esperar(paso);
  }
  return false;
}

/** Pedido HTTP crudo, para probar encabezados que el cliente real nunca manda. */
function crudo(base, ruta, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const url = new URL(ruta, base);
    const req = http.request(url, { method, headers }, (res) => {
      const partes = [];
      res.on('data', (d) => partes.push(d));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json = null;
        try { json = JSON.parse(texto); } catch {}
        resolve({ status: res.statusCode, json, texto });
      });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.end(body || undefined);
  });
}

function escuchar(servidor) {
  return new Promise((resolve) => servidor.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${servidor.address().port}`)));
}

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-089-'));
  const dirServidor = path.join(raiz, 'servidor');
  const dirNodo = path.join(raiz, 'nodo');
  fs.mkdirSync(dirServidor, { recursive: true });
  fs.mkdirSync(dirNodo, { recursive: true });

  const { crearCanalWeb, CHAT_WEB_LOCAL } = await imp('web/canal.js');
  const { crearServidorWeb, metodosPermitidos } = await imp('web/servidor.js');
  const { crearServidorNodos } = await imp('red/servidor-nodos.js');
  const { crearNucleoRemoto } = await imp('red/nucleo-remoto.js');
  const { crearClienteNodo, pedirHttp } = await imp('red/cliente-nodo.js');
  const identidad = await imp('red/identidad.js');
  const admin = await imp('red/admin.js');

  // --------------------------------------------------------------- servidor
  const canalServidor = crearCanalWeb();
  const eventosServidor = [];
  canalServidor.suscribir(CHAT_WEB_LOCAL, (e) => eventosServidor.push(e));
  const telegram = { llamadas: [] };
  for (const op of ['mensaje', 'voz', 'archivo', 'quitarBotones']) {
    telegram[op] = async (datos) => { telegram.llamadas.push({ op, ...datos }); return { ok: true }; };
  }
  telegram.preguntar = async (datos) => { telegram.llamadas.push({ op: 'preguntar', ...datos }); return { messageId: 77 }; };
  const logServidor = [];
  const servidorNodos = crearServidorNodos({
    dataDir: dirServidor, canal: canalServidor, chatId: CHAT_WEB_LOCAL, telegram,
    latidoMs: 150, rpcTimeoutMs: 400, log: (l) => logServidor.push(l)
  });
  const TOKEN = 'a'.repeat(48);
  const nucleoLocal = { canal: canalServidor, chatId: CHAT_WEB_LOCAL, tareas: () => ({ tareas: [{ id: 'local-1' }] }) };
  const web = crearServidorWeb({
    nucleo: nucleoLocal, token: TOKEN,
    red: { servidorNodos, nucleoRemoto: (id) => crearNucleoRemoto(servidorNodos.rpc, id), nombreLocal: 'casa' }
  });
  const base = await escuchar(web);
  const conToken = { 'x-lagrange-token': TOKEN };

  // --------------------------------------------------------------- nodo falso
  const llamadasNodo = [];
  let colgar = false;
  const nucleoNodo = {
    tareas: (s, q) => { llamadasNodo.push(['tareas', s, q]); return colgar ? new Promise(() => {}) : { tareas: [{ id: 'remota-1' }] }; },
    diffLote: () => ({ diff: 'x'.repeat(150 * 1024) }),
    estado: () => ({ binario: Buffer.from('no') }),
    cancelarTarea: (id) => { llamadasNodo.push(['cancelarTarea', id]); return { ok: true }; }
  };
  const canalNodo = crearCanalWeb();
  const asksNodo = [];
  const estadosNodo = [];
  const nuevoCliente = (extra = {}) => crearClienteNodo({
    dataDir: dirNodo, nucleo: nucleoNodo, canal: canalNodo, chatId: CHAT_WEB_LOCAL, permitidos: metodosPermitidos(),
    version: 'test', onAskRespondido: (m) => asksNodo.push(m), onEstado: (e) => estadosNodo.push(e),
    backoffMinMs: 30, entreSaludosMs: 30, loteMs: 20, ...extra
  });

  let cliente = null;
  let idNodo = null;
  let nodoJson = null;

  try {
    await group('Emparejamiento (§4, §7.1.1)', async () => {
      await check('unirse rechaza una URL privada sin túnel declarado (SEC-022)',
        await admin.unirse(dirNodo, 'http://192.168.1.5:4518', 'X').then(() => false, (e) => /interfaz-cifrada/.test(e.message)));
      await check('unirse rechaza un nombre inválido ("a]b")',
        await admin.unirse(dirNodo, base, 'X', { nombre: 'a]b' }).then(() => false, (e) => /válido/.test(e.message)));
      const { codigo } = admin.invitar(dirServidor);
      check('el código tiene 12 caracteres sin ambiguos', /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(codigo), codigo);
      const guardado = fs.readFileSync(path.join(dirServidor, 'nodos.json'), 'utf8');
      check('se guarda hasheado, no en claro', !guardado.includes(codigo) && !guardado.includes(identidad.normalizarCodigo(codigo)));
      const r = await admin.unirse(dirNodo, base, codigo.toLowerCase(), { nombre: 'casa-wsl' });
      idNodo = r.id;
      nodoJson = JSON.parse(fs.readFileSync(path.join(dirNodo, 'nodo.json'), 'utf8'));
      check('código válido → claves intercambiadas', nodoJson.clavePublicaServidor && servidorNodos.existeNodo(idNodo) && r.nombre === 'casa-wsl');
      const nodos = JSON.parse(fs.readFileSync(path.join(dirServidor, 'nodos.json'), 'utf8'));
      check('el servidor guarda solo la clave pública del nodo', nodos.nodos[0].clavePublica === nodoJson.clavePublica && !JSON.stringify(nodos).includes(nodoJson.clavePrivada));
      // Mismo código otra vez (desde un directorio limpio).
      const otro = path.join(raiz, 'otro');
      await check('el mismo código otra vez → rechazo',
        await admin.unirse(otro, base, codigo, { nombre: 'otro' }).then(() => false, (e) => /inválido|usado/.test(e.message)));
      // Vencido.
      const vencido = admin.invitar(dirServidor, null, { ahora: Date.now() - 11 * 60_000 });
      await check('un código vencido → rechazo',
        await admin.unirse(path.join(raiz, 'otro2'), base, vencido.codigo, { nombre: 'otro2' }).then(() => false, () => true));
      // 5 fallos invalidan la invitación vigente.
      const buena = admin.invitar(dirServidor);
      for (let i = 0; i < 5; i++) await crudo(base, '/nodo/emparejar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codigo: 'MALO', id: '11111111-1111-4111-8111-111111111111', nombre: 'x', clavePublica: nodoJson.clavePublica }) });
      await check('tras 5 intentos fallidos la invitación queda invalidada',
        await admin.unirse(path.join(raiz, 'otro3'), base, buena.codigo, { nombre: 'otro3' }).then(() => false, () => true));
      check('no quedó nodo.json en los intentos rechazados', !fs.existsSync(path.join(raiz, 'otro', 'nodo.json')) && !fs.existsSync(path.join(raiz, 'otro3', 'nodo.json')));
    });

    await group('Conexión y consola por nodo (§6, §7.1.4, §7.1.8)', async () => {
      cliente = nuevoCliente();
      check('iniciar encuentra nodo.json', cliente.iniciar());
      check('el nodo se conecta', await hasta(() => servidorNodos.conectado(idNodo) && cliente.conectado()));
      const lista = await crudo(base, '/api/nodos', { headers: conToken });
      const suyo = lista.json?.nodos?.find((n) => n.id === idNodo);
      check('/api/nodos lista local y el nodo conectado, con versión',
        lista.json?.nodos?.[0]?.id === 'local' && lista.json.nodos[0].nombre === 'casa' && suyo?.conectado && suyo.version === 'test', JSON.stringify(lista.json));
      const t = await crudo(base, `/api/n/${idNodo}/tareas?q=hola`, { headers: conToken });
      check('ida y vuelta: /api/n/<id>/tareas llega al núcleo del nodo', t.status === 200 && t.json?.tareas?.[0]?.id === 'remota-1', JSON.stringify(t.json));
      check('con los argumentos de la URL', llamadasNodo.some((l) => l[0] === 'tareas' && l[2] === 'hola'));
      const local = await crudo(base, '/api/n/local/tareas', { headers: conToken });
      check('/api/n/local/… es el núcleo local', local.json?.tareas?.[0]?.id === 'local-1');
      const diff = await crudo(base, `/api/n/${idNodo}/lotes/l1/tareas/t1/diff`, { headers: conToken });
      check('una respuesta de 150 KB (diffLote) llega entera', diff.json?.diff?.length === 150 * 1024);
      const bin = await crudo(base, `/api/n/${idNodo}/estado`, { headers: conToken });
      check('una respuesta binaria del nodo cruza como binario (SEC-022)', bin.status === 200 && bin.texto === 'no', String(bin.status));
      const sinNodo = await crudo(base, '/api/n/no-existe/tareas', { headers: conToken });
      check('un nodo que no existe → 404', sinNodo.status === 404);
      const sinCookie = await crudo(base, `/api/n/${idNodo}/tareas`);
      check('/api/n/… exige la sesión de la consola', sinCookie.status === 401);
    });

    await group('Lista permitida (§4.4, §7.1.3)', async () => {
      const permitidos = metodosPermitidos();
      check('incluye los métodos de las rutas GET', ['tareas', 'tarea', 'diffLote', 'lotes', 'almas', 'logs', 'programaciones', 'proveedores', 'buscarProfunda'].every((m) => permitidos.has(m)));
      check('no incluye ninguna mutación', !['cancelarTarea', 'castear', 'mensaje', 'olvidar', 'escucharTarea', 'crearProgramacion', 'guardarMotor', 'lanzarLote', 'descartarLote', 'integrarLote'].some((m) => permitidos.has(m)));
      const mut = await crudo(base, `/api/n/${idNodo}/tareas/t1/cancelar`, { method: 'POST', headers: { ...conToken, 'content-type': 'application/json' }, body: '{}' });
      check('una mutación sobre un nodo que permite lectura → 403', mut.status === 403 && /permite solo lectura/.test(mut.json?.error || ''), JSON.stringify(mut.json));
      check('sin mandarle nada al nodo', !llamadasNodo.some((l) => l[0] === 'cancelarTarea'));
      const fuera = await servidorNodos.rpc(idNodo, 'cancelarTarea', ['t1']);
      check('un pedido con un método fuera de la lista: el nodo lo rechaza', fuera.codigo === 403 && !llamadasNodo.some((l) => l[0] === 'cancelarTarea'), JSON.stringify(fuera));
    });

    await group('Núcleo remoto: timeout, desconectado, cierre en vuelo (§6.2)', async () => {
      colgar = true;
      const lento = await servidorNodos.rpc(idNodo, 'tareas', []);
      check('sin respuesta → 504', lento.codigo === 504, JSON.stringify(lento));
      colgar = false;
      const nadie = await servidorNodos.rpc('00000000-0000-4000-8000-000000000000', 'tareas', []);
      check('nodo desconectado → 503 sin esperar', nadie.codigo === 503);
    });

    let sesion = null;
    const conSesion = () => ({ 'x-lagrange-sesion': sesion });
    await group('Apretón de manos (§3.5, §7.1.0)', async () => {
      const nonceNodo = identidad.nonce();
      const s = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 1, id: idNodo, nonceNodo } });
      check('el saludo viene firmado por el servidor emparejado',
        identidad.verificar(nodoJson.clavePublicaServidor, identidad.textoSaludo(idNodo, nonceNodo, s.datos.nonceServidor), s.datos.firma));
      const cruzada = await pedirHttp(base, '/nodo/sesion', { cuerpo: { id: idNodo, nonceServidor: s.datos.nonceServidor, firma: s.datos.firma } });
      check('una firma del paso 1 presentada en el paso 2 → rechazo', cruzada.status === 401);
      const reusado = await pedirHttp(base, '/nodo/sesion', {
        cuerpo: { id: idNodo, nonceServidor: s.datos.nonceServidor, firma: identidad.firmar(nodoJson.clavePrivada, identidad.textoSesion(idNodo, s.datos.nonceServidor, nonceNodo)) }
      });
      check('un nonceServidor ya usado (aunque la firma sea buena) → rechazo', reusado.status === 401);
      const n2 = identidad.nonce();
      const s2 = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 1, id: idNodo, nonceNodo: n2 } });
      const malNombre = await pedirHttp(base, '/nodo/sesion', {
        cuerpo: { id: idNodo, nonceServidor: s2.datos.nonceServidor, nombre: 'a]b', firma: identidad.firmar(nodoJson.clavePrivada, identidad.textoSesion(idNodo, s2.datos.nonceServidor, n2)) }
      });
      check('una sesión con nombre inválido → rechazo', malNombre.status === 400);
      const n3 = identidad.nonce();
      const s3 = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 1, id: idNodo, nonceNodo: n3 } });
      const ok = await pedirHttp(base, '/nodo/sesion', {
        cuerpo: { id: idNodo, nonceServidor: s3.datos.nonceServidor, firma: identidad.firmar(nodoJson.clavePrivada, identidad.textoSesion(idNodo, s3.datos.nonceServidor, n3)) }
      });
      sesion = ok.datos?.sesion;
      check('con la firma correcta se obtiene una sesión', ok.status === 200 && typeof sesion === 'string' && sesion.length === 64);
      const version = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 7, id: idNodo, nonceNodo: identidad.nonce() } });
      check('un protocolo incompatible → 426 con la versión del servidor (2 desde FEAT-090)', version.status === 426 && version.datos?.protocolo === 2);
      const desconocido = await pedirHttp(base, '/nodo/saludo', { cuerpo: { v: 1, id: '22222222-2222-4222-8222-222222222222', nonceNodo: identidad.nonce() } });
      check('un id desconocido → 401 con motivo', desconocido.status === 401 && desconocido.datos?.motivo === 'desconocido');

      // Un servidor falso (sin la clave privada del emparejado) en otro puerto.
      const recibidos = [];
      const falso = http.createServer((req, res) => {
        const partes = [];
        req.on('data', (d) => partes.push(d));
        req.on('end', () => {
          recibidos.push({ ruta: req.url, cuerpo: Buffer.concat(partes).toString('utf8') });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, servidorId: nodoJson.servidorId, nonceServidor: identidad.nonce(), firma: identidad.firmar(identidad.generarClaves().clavePrivada, 'x') }));
        });
      });
      const baseFalsa = await escuchar(falso);
      const dirImpostor = path.join(raiz, 'impostor');
      fs.mkdirSync(dirImpostor);
      fs.writeFileSync(path.join(dirImpostor, 'nodo.json'), JSON.stringify({ ...nodoJson, servidor: baseFalsa }));
      const estadosImpostor = [];
      const engañado = crearClienteNodo({ dataDir: dirImpostor, nucleo: nucleoNodo, canal: crearCanalWeb(), chatId: CHAT_WEB_LOCAL, permitidos: new Set(), onEstado: (e) => estadosImpostor.push(e), backoffMinMs: 5000, entreSaludosMs: 5000 });
      engañado.iniciar();
      await hasta(() => estadosImpostor.some((e) => e.estado === 'servidor-no-verificado'), 3000);
      await esperar(100);
      engañado.detener();
      falso.close();
      check('ante un servidor falso el nodo corta después del saludo', estadosImpostor.some((e) => e.estado === 'servidor-no-verificado') && recibidos.length === 1 && recibidos[0].ruta === '/nodo/saludo', JSON.stringify(recibidos.map((r) => r.ruta)));
      check('y no le mandó capacidades, eventos ni mensajes', !recibidos.some((r) => /capacidades|eventos|texto/.test(r.cuerpo)));
      check('ningún pedido lleva la clave privada', !recibidos.some((r) => r.cuerpo.includes(nodoJson.clavePrivada)));

      // unirse contra un servidor que no conoce el código.
      const falsoCanje = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, servidorId: 'x', clavePublicaServidor: identidad.generarClaves().clavePublica, prueba: 'AAAA' }));
        });
      });
      const baseCanje = await escuchar(falsoCanje);
      const dirCanje = path.join(raiz, 'canje');
      const canje = await admin.unirse(dirCanje, baseCanje, 'ABCD-EFGH-JKLM', { nombre: 'canje' }).then(() => null, (e) => e.message);
      falsoCanje.close();
      check('unirse contra un servidor que no conoce el código: la prueba no verifica', /no pudo probar/.test(canje || ''), canje);
      check('y no se escribe nodo.json', !fs.existsSync(path.join(dirCanje, 'nodo.json')));
    });

    await group('Seguridad de /nodo/* (§3.1, §7.1.2)', async () => {
      const sin = await crudo(base, '/nodo/eventos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      check('sin sesión → 401', sin.status === 401);
      const otra = await crudo(base, '/nodo/eventos', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lagrange-sesion': 'f'.repeat(64) }, body: '{}' });
      check('con una sesión que no existe → 401', otra.status === 401);
      const origen = await crudo(base, '/nodo/eventos', { method: 'POST', headers: { ...conSesion(), 'content-type': 'application/json', origin: 'http://127.0.0.1:1' }, body: '{}' });
      check('con Origin → 403', origen.status === 403);
      const sitio = await crudo(base, '/nodo/saludo', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' });
      check('con Sec-Fetch-Site → 403 (también sin sesión)', sitio.status === 403);
      const host = await crudo(base, '/nodo/saludo', { method: 'POST', headers: { 'content-type': 'application/json', host: 'evil.example:4518' }, body: '{}' });
      check('Host que no es de loopback → 403', host.status === 403);
      const cookie = await crudo(base, '/nodo/eventos', { method: 'POST', headers: { 'content-type': 'application/json', ...conToken }, body: '{}' });
      check('el token de la consola no sirve de sesión de nodo', cookie.status === 401);
      const grande = await crudo(base, '/nodo/telegram/voz', { method: 'POST', headers: { ...conSesion(), 'content-type': 'application/octet-stream' }, body: Buffer.alloc(21 * 1024 * 1024) });
      check('cuerpo binario de más de 20 MB → corte (413)', grande.status === 413, String(grande.status));
      const respGrande = await crudo(base, `/nodo/respuesta/${'0'.repeat(32)}`, { method: 'POST', headers: { ...conSesion(), 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, resultado: 'x'.repeat(1100 * 1024) }) });
      check('/nodo/respuesta de más de 1 MB → corte (413)', respGrande.status === 413, String(respGrande.status));
      const noEnSolo = crearServidorWeb({ nucleo: nucleoLocal, token: TOKEN });
      const baseSolo = await escuchar(noEnSolo);
      const solo = await crudo(baseSolo, '/nodo/saludo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const nodosSolo = await crudo(baseSolo, '/api/nodos', { headers: conToken });
      noEnSolo.close();
      check('sin rol servidor, /nodo/* no existe (404)', solo.status === 404);
      check('y /api/nodos es solo local (la interfaz no cambia)', nodosSolo.json?.nodos?.length === 1 && nodosSolo.json.nodos[0].id === 'local');
    });

    await group('Eventos del nodo (§6.4, §7.1.5)', async () => {
      eventosServidor.length = 0;
      canalNodo.publicar(CHAT_WEB_LOCAL, { tipo: 'tarea', tarea: { id: 'viva' } });
      check('un evento del canal del nodo se republica en el servidor con nodo',
        await hasta(() => eventosServidor.some((e) => e.tipo === 'tarea' && e.tarea?.id === 'viva' && e.nodo === idNodo)));
      canalNodo.publicar(CHAT_WEB_LOCAL, { tipo: 'parcial', tareaId: 'viva', texto: 'a' }, { efimero: true });
      check('los efímeros también cruzan', await hasta(() => eventosServidor.some((e) => e.tipo === 'parcial' && e.nodo === idNodo)));
      check('y no quedan en el buffer del servidor', !canalServidor.pendientes(CHAT_WEB_LOCAL).some((e) => e.tipo === 'parcial'));
      canalNodo.publicar(CHAT_WEB_LOCAL, { tipo: 'mensaje', texto: 'y'.repeat(600 * 1024) });
      check('un evento de más de 512 KB llega como nodo-resincronizar', await hasta(() => eventosServidor.some((e) => e.tipo === 'nodo-resincronizar' && e.nodo === idNodo)));

      // A mano, con la sesión: duplicados, huecos y arranque nuevo.
      const mandar = (arranque, eventos) => crudo(base, '/nodo/eventos', { method: 'POST', headers: { ...conSesion(), 'content-type': 'application/json' }, body: JSON.stringify({ arranque, eventos }) });
      const e = (seq, tipo = 'tarea') => ({ seq, efimero: false, evento: { tipo, tarea: { id: `m${seq}` } } });
      eventosServidor.length = 0;
      await mandar('A', [e(1), e(2)]);
      await mandar('A', [e(2), e(3)]);
      check('un duplicado se descarta', eventosServidor.filter((x) => x.tarea?.id === 'm2').length === 1 && eventosServidor.some((x) => x.tarea?.id === 'm3'));
      eventosServidor.length = 0;
      await mandar('A', [e(6)]);
      check('un hueco de seq → nodo-resincronizar', eventosServidor.some((x) => x.tipo === 'nodo-resincronizar') && eventosServidor.some((x) => x.tarea?.id === 'm6'));
      eventosServidor.length = 0;
      await mandar('B', [e(1)]);
      check('un arranque nuevo → nodo-resincronizar', eventosServidor[0]?.tipo === 'nodo-resincronizar' && eventosServidor.some((x) => x.tarea?.id === 'm1'));
    });

    await group('Telegram por el servidor (§5, §7.1.6)', async () => {
      telegram.llamadas.length = 0;
      const r = await cliente.mensaje({ texto: 'hola desde el nodo' });
      check('un mensaje del nodo llega al Telegram del servidor, con el nombre del nodo',
        r.ok && !r.encolado && telegram.llamadas.some((l) => l.op === 'mensaje' && l.texto === 'hola desde el nodo' && l.nombre === 'casa-wsl'));
      const conChat = await crudo(base, '/nodo/telegram/mensaje', { method: 'POST', headers: { ...conSesion(), 'content-type': 'application/json' }, body: JSON.stringify({ texto: 'x', chat_id: 999 }) });
      check('un chat_id del nodo se ignora (con aviso en el log)', conChat.status === 200 && !telegram.llamadas.some((l) => l.chat_id || l.chatId) && logServidor.some((l) => /chat_id/.test(l)));
      await cliente.voz(Buffer.from('RIFF'), 'pie 🎙️');
      check('la voz sube binaria, con su pie', telegram.llamadas.some((l) => l.op === 'voz' && l.buffer.toString() === 'RIFF' && l.pie === 'pie 🎙️'));
      await cliente.archivo(Buffer.from('datos'), '../../etc/informe.txt', 'mirá');
      check('el archivo llega con el nombre del encabezado (el servidor lo recorta)', telegram.llamadas.some((l) => l.op === 'archivo' && l.archivo === '../../etc/informe.txt'));

      // Ask de punta a punta, con el nodo conectado.
      const askId = `ask_${'a'.repeat(16)}`;
      const p = await cliente.preguntar({ askId, pregunta: '¿Aplico la migración?', opciones: ['Aprobar', 'Rechazar'], timeoutSeconds: 60 });
      check('preguntar devuelve el messageId del servidor', p.messageId === 77);
      check('el servidor recibe el askId, las opciones y el nodo', telegram.llamadas.some((l) => l.op === 'preguntar' && l.askId === askId && l.nodo === idNodo && l.opciones[1] === 'Rechazar'));
      servidorNodos.askRespondido(idNodo, { askId, respuesta: 'Rechazar', indice: 1, por: 5 });
      check('la respuesta llega al nodo como TEXTO de la opción', await hasta(() => asksNodo.some((a) => a.askId === askId && a.respuesta === 'Rechazar' && a.indice === 1)));
      const malAsk = await crudo(base, '/nodo/telegram/preguntar', { method: 'POST', headers: { ...conSesion(), 'content-type': 'application/json' }, body: JSON.stringify({ askId: 'ask_x', pregunta: 'a', opciones: ['b'] }) });
      check('un askId con otra forma → 400', malAsk.status === 400);
    });

    await group('Sin servidor: cola de mensajes y fallos inmediatos (§5.4)', async () => {
      cliente.detener();
      await hasta(() => !servidorNodos.conectado(idNodo), 3000);
      const offline = nuevoCliente();
      // Sin iniciar: nunca conectó, como un servidor caído.
      const r1 = await offline.mensaje({ texto: 'primero' });
      const r2 = await offline.mensaje({ texto: 'segundo' });
      check('sin conexión, un mensaje se encola', r1.encolado && r2.encolado && offline.colaPendiente() === 2);
      await check('la voz falla enseguida', await offline.voz(Buffer.from('x')).then(() => false, (e) => /no disponible/.test(e.message)));
      await check('preguntar falla enseguida', await offline.preguntar({ askId: `ask_${'b'.repeat(16)}`, pregunta: 'x', opciones: ['a'] }).then(() => false, (e) => /no disponible/.test(e.message)));
      // Un ask respondido mientras el nodo no está: se guarda y se entrega al reconectar.
      servidorNodos.askRespondido(idNodo, { askId: `ask_${'c'.repeat(16)}`, respuesta: 'Aprobar', indice: 0, por: 5, vence: new Date(Date.now() + 60_000).toISOString() });
      const guardado = JSON.parse(fs.readFileSync(path.join(dirServidor, 'nodos.json'), 'utf8'));
      check('el ask queda en asksRemotos', guardado.asksRemotos.some((a) => a.askId === `ask_${'c'.repeat(16)}`));
      telegram.llamadas.length = 0;
      asksNodo.length = 0;
      offline.iniciar();
      check('al reconectar, la cola se manda en orden', await hasta(() => telegram.llamadas.filter((l) => l.op === 'mensaje').length === 2)
        && telegram.llamadas.filter((l) => l.op === 'mensaje').map((l) => l.texto).join(',') === 'primero,segundo', JSON.stringify(telegram.llamadas.map((l) => l.texto)));
      check('con la hora original', telegram.llamadas.filter((l) => l.op === 'mensaje').every((l) => typeof l.hora === 'string'));
      check('y el ask pendiente se entrega', await hasta(() => asksNodo.some((a) => a.respuesta === 'Aprobar')));
      cliente = offline;
    });

    await group('Revocación con el flujo abierto (§4.3)', async () => {
      check('el nodo sigue conectado', await hasta(() => servidorNodos.conectado(idNodo)));
      const quitado = admin.revocar(dirServidor, 'casa-wsl');
      check('revocar lo saca de nodos.json', quitado?.id === idNodo && !servidorNodos.existeNodo(idNodo));
      check('el nodo recibe revocado y borra nodo.json', await hasta(() => !fs.existsSync(path.join(dirNodo, 'nodo.json')), 3000));
      check('y el servidor corta su flujo', !servidorNodos.conectado(idNodo));
      check('el nodo anota el estado revocado', estadosNodo.some((e) => e.estado === 'revocado'));
    });

    await group('Nombre del nodo (§2.1, §7.1.6b)', () => {
      check('hostname con mayúsculas y puntos → slug', identidad.nombrePorDefecto({ hostname: 'Mi.PC_01' }) === 'mi-pc-01');
      check('en WSL lleva -wsl', identidad.nombrePorDefecto({ hostname: 'DESKTOP-AB12', wsl: true }) === 'desktop-ab12-wsl');
      check('un nombre con corchetes no es válido', !identidad.nombreValido('a]b') && !identidad.nombreValido('A') && identidad.nombreValido('casa-wsl'));
    });
  } finally {
    try { cliente?.detener(); } catch {}
    web.close();
  }

  // ------------------------------------------------------------ notify.js en un nodo
  await group('notify.js con enlace.json de nodo (§5.1, §7.1.6)', async () => {
    const dir = path.join(raiz, 'notify');
    fs.mkdirSync(dir);
    const recibidos = [];
    const TOKEN_ENLACE = 'e'.repeat(48);
    const enlace = http.createServer((req, res) => {
      const partes = [];
      req.on('data', (d) => partes.push(d));
      req.on('end', () => {
        const cuerpo = Buffer.concat(partes);
        recibidos.push({ ruta: req.url, token: req.headers['x-lagrange-token'], nombre: req.headers['x-lagrange-nombre'], pie: req.headers['x-lagrange-pie'], cuerpo });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/telegram/preguntar' ? { ok: true, messageId: 5 } : { ok: true }));
      });
    });
    const baseEnlace = await escuchar(enlace);
    fs.writeFileSync(path.join(dir, 'enlace.json'), JSON.stringify({ rol: 'nodo', url: baseEnlace, token: TOKEN_ENLACE, pid: process.pid }));
    const secreto = path.join(dir, 'informe.txt');
    fs.writeFileSync(secreto, 'token=1234567890:AAFakeTokenForTestingOnly_DoNotUseXX fin');
    const wav = path.join(dir, 'nota.wav');
    fs.writeFileSync(wav, Buffer.alloc(64));
    const envHijo = { ...process.env, TELEGRAM_BRIDGE_DATA_DIR: dir, TELEGRAM_BRIDGE_STATE_FILE: path.join(dir, 'state.json') };
    for (const k of ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS', 'TELEGRAM_BOTS', 'TELEGRAM_BRIDGE_ENV_FILE']) delete envHijo[k];
    const NOTIFY = JSON.stringify(pathToFileURL(path.join(BRIDGE, 'notify.js')).href);
    const correrHijo = (codigo) => new Promise((resolve) => {
      const h = spawn(process.execPath, ['--input-type=module', '-e', codigo], { env: envHijo });
      let out = '';
      h.stdout.on('data', (d) => { out += d; });
      h.stderr.on('data', (d) => { out += d; });
      h.on('close', () => resolve(out));
    });
    const salida = await correrHijo(`
      globalThis.fetch = ((real) => async (url, o) => { if (String(url).includes('api.telegram.org')) throw new Error('TOCÓ TELEGRAM'); return real(url, o); })(globalThis.fetch);
      const n = await import(${NOTIFY});
      const r = {};
      r.texto = await n.sendTelegramNotification({ title: 'T', message: 'hola', reaccionable: { alma: 'alya', extracto: 'x' } });
      r.archivo = await n.sendTelegramNotification({ message: 'adjunto', filePath: ${JSON.stringify(secreto)} });
      try { await n.sendTelegramNotification({ message: 'x', filePath: ${JSON.stringify(path.join(dir, '.env'))} }); r.prohibido = 'pasó'; } catch (e) { r.prohibido = e.name + ': ' + e.message; }
      r.voz = await n.sendTelegramVoice({ audioPath: ${JSON.stringify(wav)}, caption: 'pie de voz' });
      r.ask = await n.askTelegramQuestion({ question: '¿Sigo?', options: ['Sí', 'No'], timeoutSeconds: 1 });
      console.log('RESULTADO ' + JSON.stringify(r));
    `);
    const linea = salida.split(/\r?\n/).find((l) => l.startsWith('RESULTADO '));
    const r = linea ? JSON.parse(linea.slice(10)) : null;
    check('el hijo corrió sin tocar la API de Telegram', r && !/TOCÓ TELEGRAM/.test(salida), salida.slice(-600));
    if (!r) return;
    check('el texto va al endpoint local con el token del enlace', recibidos.some((x) => x.ruta === '/telegram/mensaje' && x.token === TOKEN_ENLACE && x.cuerpo.toString().includes('hola')));
    check('un reaccionable viaja al servidor (FEAT-090 §3.5)', r.texto.remoto && recibidos.some((x) => x.ruta === '/telegram/mensaje' && JSON.parse(x.cuerpo).reaccionable?.alma === 'alya'));
    const arch = recibidos.find((x) => x.ruta === '/telegram/archivo');
    check('el adjunto sube con su nombre', arch && decodeURIComponent(arch.nombre) === 'informe.txt');
    check('un secreto en el adjunto llega redactado (en el nodo)', arch && !arch.cuerpo.toString().includes('AAFakeTokenForTestingOnly') && arch.cuerpo.toString().includes('[REDACTED]'), arch?.cuerpo.toString());
    check('una ruta prohibida se rechaza en el nodo', /PolicyViolation|deny|prohib/i.test(r.prohibido), r.prohibido);
    check('la voz sube por /telegram/voz con su pie', recibidos.some((x) => x.ruta === '/telegram/voz' && decodeURIComponent(x.pie) === 'pie de voz' && x.cuerpo.length === 64));
    check('el ask se pide al endpoint local', recibidos.some((x) => x.ruta === '/telegram/preguntar' && JSON.parse(x.cuerpo).opciones[1] === 'No'));
    check('vencido, pide quitar los botones', r.ask.answered === false && recibidos.some((x) => x.ruta === '/telegram/quitar-botones'));

    // Las entradas de la línea de comandos también se desvían.
    // `spawn` y no `spawnSync`: el endpoint falso corre en este proceso.
    recibidos.length = 0;
    const cli = (...args) => new Promise((resolve) => spawn(process.execPath, [path.join(BRIDGE, 'notify.js'), ...args], { env: envHijo }).on('close', resolve));
    await cli('--success', 'listo');
    await cli('--voice', wav);
    check('--success va al endpoint local', recibidos.some((x) => x.ruta === '/telegram/mensaje' && x.cuerpo.toString().includes('listo')));
    check('--voice va al endpoint local', recibidos.some((x) => x.ruta === '/telegram/voz'));

    // Con el ask resuelto en el estado local, `selected` es el texto.
    recibidos.length = 0;
    const hijoAsk = correrHijo(`
      const n = await import(${NOTIFY});
      const r = await n.askTelegramQuestion({ question: '¿Aplico?', options: ['Aprobar', 'Rechazar'], timeoutSeconds: 20 });
      console.log('RESULTADO ' + JSON.stringify(r));
    `);
    await hasta(() => recibidos.some((x) => x.ruta === '/telegram/preguntar'), 10000);
    const askId = JSON.parse(recibidos.find((x) => x.ruta === '/telegram/preguntar').cuerpo).askId;
    const resolver = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const s = await import(${JSON.stringify(pathToFileURL(path.join(BRIDGE, 'state.js')).href)});
      await new Promise((r) => setTimeout(r, 300));
      console.log(JSON.stringify(s.resolvePendingAsk(${JSON.stringify(askId)}, 'Rechazar', 5)));
    `], { env: envHijo, encoding: 'utf8', timeout: 30000 });
    const salidaAsk = await hijoAsk;
    const rAsk = JSON.parse((salidaAsk.split(/\r?\n/).find((l) => l.startsWith('RESULTADO ')) || 'RESULTADO {}').slice(10));
    check('selected devuelve el texto de la opción', rAsk.answered === true && rAsk.selected === 'Rechazar', `${salidaAsk.slice(-300)} ${resolver.stdout}`);

    // Sin enlace.json, o con un pid muerto: como siempre.
    fs.writeFileSync(path.join(dir, 'enlace.json'), JSON.stringify({ rol: 'nodo', url: baseEnlace, token: TOKEN_ENLACE, pid: 999999 }));
    const comoSiempre = await correrHijo(`
      const n = await import(${NOTIFY});
      console.log('ENLACE ' + JSON.stringify(n.enlaceDeNodo()));
    `);
    check('un enlace.json con el daemon muerto no desvía', comoSiempre.includes('ENLACE null'), comoSiempre);
    enlace.close();
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
