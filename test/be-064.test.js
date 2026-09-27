/**
 * BE-064 — "Escuchar" una tarea de un nodo sin voz la lee el servidor con la suya.
 *
 * Tres tramos: el nodo marca `sinVoz` (bot.escucharTexto y nucleo), el servidor
 * trae la tarea y la lee (bot.escucharPrestado), y la consola del servidor une
 * las dos cosas sobre una red armada, como en SEC-022.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'be-064-'));
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(raiz, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });

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
const escuchar = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

async function main() {
  const bot = await imp('bot.js');
  const { crearCanalWeb, CHAT_WEB_LOCAL } = await imp('web/canal.js');
  const srv = await imp('web/servidor.js');
  const { crearServidorNodos } = await imp('red/servidor-nodos.js');
  const { crearNucleoRemoto } = await imp('red/nucleo-remoto.js');
  const { crearClienteNodo } = await imp('red/cliente-nodo.js');
  const admin = await imp('red/admin.js');
  const warnOriginal = console.warn;
  console.warn = () => {};

  await group('BE-064 — el nodo marca sinVoz solo cuando no tiene voz', async () => {
    const wav = path.join(raiz, 'a.wav');
    let pedido = null;
    const con = (r) => bot.usarEjecutoresDePrueba({ sintetizar: async (o) => { pedido = o; return typeof r === 'function' ? r() : r; } });
    con({ ok: false, motivo: 'setup_required' });
    const a = await bot.escucharTexto({ texto: 'hola' });
    check('setup_required → sinVoz', a.ok === false && a.sinVoz === true && a.codigo === 503, JSON.stringify(a));
    con({ ok: false, motivo: 'provider_unavailable' });
    check('provider_unavailable → sinVoz', (await bot.escucharTexto({ texto: 'hola' })).sinVoz === true);
    con({ ok: false, motivo: 'profile_missing' });
    const pm = await bot.escucharTexto({ texto: 'hola', voz: 'Alya' });
    check('profile_missing (un alma con su voz en un nodo sin Voicebox) → sinVoz, con el motivo', pm.sinVoz === true && pm.motivo === 'profile_missing');
    for (const m of ['model_not_downloaded', 'compatibility_unknown', 'sample_missing', 'invalid_setup']) {
      con({ ok: false, motivo: m });
      check(`${m} → sinVoz`, (await bot.escucharTexto({ texto: 'hola' })).sinVoz === true);
    }
    con({ ok: false, motivo: 'generacion' });
    const c = await bot.escucharTexto({ texto: 'hola' });
    check('un fallo de la voz no es sinVoz', c.ok === false && !('sinVoz' in c) && c.codigo === 502, JSON.stringify(c));
    for (const m of ['carga', 'sin_archivo', 'vram_blocked', 'texto_vacio']) {
      con({ ok: false, motivo: m });
      const x = await bot.escucharTexto({ texto: 'hola' });
      check(`${m} no es sinVoz`, x.ok === false && !('sinVoz' in x), JSON.stringify(x));
    }
    con(() => { fs.writeFileSync(wav, Buffer.alloc(10, 3)); return { ok: true, wavPath: wav, perfil: 'Diego Alvarez' }; });
    const d = await bot.escucharTexto({ texto: 'hola', voz: 'Alya', vozPorDefecto: true });
    check('con voz: el audio, y borra el archivo', d.ok && d.audio.length === 10 && !fs.existsSync(wav));
    check('pasa la voz y vozPorDefecto a sintetizar', pedido.voz === 'Alya' && pedido.vozPorDefecto === true && pedido.texto === 'hola');
    con(() => { fs.writeFileSync(wav, Buffer.alloc(1)); return { ok: true, wavPath: wav }; });
    await bot.escucharTexto({ texto: 'hola' });
    check('sin vozPorDefecto no lo manda', !('vozPorDefecto' in pedido));
    bot.usarEjecutoresDePrueba({});
    const fuente = fs.readFileSync(path.join(BRIDGE, 'web', 'nucleo.js'), 'utf8');
    check('nucleo.escucharTarea deja pasar sinVoz', /r\.sinVoz \? \{ \.\.\.error\(r\.codigo, r\.error\), sinVoz: true \}/.test(fuente));
    const botSrc = fs.readFileSync(path.join(BRIDGE, 'bot.js'), 'utf8');
    check('escucharTarea delega en escucharTexto', /return escucharTexto\(\{ texto: t\.resultado,/.test(botSrc));
  });

  await group('BE-064 — escucharPrestado trae la tarea y la valida', async () => {
    const llamadas = [];
    const tareas = {
      t1: { ok: true, tarea: { sujeto: { tipo: 'agente', nombre: 'lector' }, estado: 'ok', resultado: 'El resumen.' } },
      t2: { ok: true, tarea: { sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' }, estado: 'ok', resultado: 'Hola.' } },
      t3: { ok: true, tarea: { sujeto: { tipo: 'agente' }, estado: 'en_curso', resultado: null } },
      t4: { ok: true, tarea: { sujeto: null, estado: 'ok', resultado: 'x' } }
    };
    const rpc = async (nodo, metodo, args) => { llamadas.push([nodo, metodo, ...args]); return tareas[args[0]] || { codigo: 404, ok: false, error: 'No existe esa tarea.' }; };
    const leidos = [];
    const prestar = bot.escucharPrestado({ rpc, escuchar: async (o) => { leidos.push(o); return { ok: true, audio: Buffer.alloc(5) }; } });
    const a = await prestar('n1', 't1');
    check('pide la tarea por RPC de lectura', llamadas[0][0] === 'n1' && llamadas[0][1] === 'tarea' && llamadas[0][2] === 't1');
    check('un cast: el resultado, voz por defecto del servidor', a.ok && leidos[0].texto === 'El resumen.' && leidos[0].voz === null && leidos[0].vozPorDefecto === true && leidos[0].etiqueta === 'n1/t1');
    await prestar('n1', 't2');
    check('un alma: con su voz', leidos[1].voz === 'Alya' && leidos.length === 2);
    leidos.length = 0;
    const reintento = bot.escucharPrestado({ rpc, escuchar: async (o) => { leidos.push(o); return o.voz ? { ok: false, codigo: 503, error: 'profile_missing', sinVoz: true, motivo: 'profile_missing' } : { ok: true, audio: Buffer.alloc(2) }; } });
    const r2 = await reintento('n1', 't2');
    check('si el servidor tampoco tiene la voz del alma, usa la suya', r2.ok && leidos.length === 2 && leidos[0].voz === 'Alya' && leidos[1].voz === null && leidos[1].vozPorDefecto === true);
    leidos.length = 0;
    const falla = bot.escucharPrestado({ rpc, escuchar: async (o) => { leidos.push(o); return { ok: false, codigo: 502, error: 'La voz falló al generar el audio.' }; } });
    const r3 = await falla('n1', 't2');
    check('un fallo al generar no reintenta', r3.codigo === 502 && leidos.length === 1);
    leidos.length = 0;
    const sinProveedor = bot.escucharPrestado({ rpc, escuchar: async (o) => { leidos.push(o); return { ok: false, codigo: 503, error: 'x', sinVoz: true, motivo: 'provider_unavailable' }; } });
    await sinProveedor('n1', 't2');
    check('sin proveedor en el servidor tampoco reintenta', leidos.length === 1);
    leidos.length = 0;
    await prestar('n1', 't1');
    check('un cast sin voz no reintenta', leidos.length === 1);
    const antes = leidos.length;
    const c = await prestar('n1', 't3');
    check('sin respuesta terminada → 400 sin leer', c.codigo === 400 && leidos.length === antes);
    check('ni charla ni cast → 400', (await prestar('n1', 't4')).codigo === 400);
    const e = await prestar('n1', 'tx');
    check('el error del nodo pasa', e.codigo === 404 && /No existe/.test(e.error));
  });

  // ------------------------------------------------------------ red armada
  const dirServidor = path.join(raiz, 'servidor');
  const dirNodo = path.join(raiz, 'nodo');
  fs.mkdirSync(dirServidor, { recursive: true });
  const canal = crearCanalWeb();
  const servidorNodos = crearServidorNodos({ dataDir: dirServidor, canal, chatId: CHAT_WEB_LOCAL, latidoMs: 150, rpcTimeoutMs: 1500, rpcTimeoutVozMs: 4000 });
  const TOKEN = 't'.repeat(48);
  const lineas = [];
  const logOriginal = console.log;
  console.log = (...a) => { const l = a.join(' '); if (l.startsWith('[remoto]')) lineas.push(l); else logOriginal(...a); };
  let prestado = null;
  const web = srv.crearServidorWeb({
    nucleo: { canal, chatId: CHAT_WEB_LOCAL }, token: TOKEN,
    red: { servidorNodos, nucleoRemoto: (id) => crearNucleoRemoto(servidorNodos.rpc, id), nombreLocal: 'casa',
      escucharPrestado: async (nodo, tid) => { prestado = [nodo, tid]; return tid === 'mal' ? { ok: false, codigo: 503, error: 'Tampoco hay voz acá.' } : { ok: true, audio: Buffer.alloc(700, 9) }; } }
  });
  const base = await escuchar(web);
  const { codigo } = admin.invitar(dirServidor);
  const { id } = await admin.unirse(dirNodo, base, codigo, { nombre: 'casa-wsl' });
  let respuestaNodo = null;
  const nucleoNodo = new Proxy({}, {
    get: (_, m) => (typeof m !== 'string' ? undefined
      : m === 'escucharTarea' ? async () => respuestaNodo
        : m === 'tarea' ? (tid) => (tid === 't1' ? { ok: true, tarea: { id: 't1', sujeto: { tipo: 'agente', nombre: 'lector' }, estado: 'ok', resultado: 'Resumen del nodo.' } } : { codigo: 404, ok: false, error: 'No existe esa tarea.' })
          : () => ({ ok: true }))
  });
  const nuevoCliente = (permite) => crearClienteNodo({
    dataDir: dirNodo, nucleo: nucleoNodo, canal: crearCanalWeb(), chatId: CHAT_WEB_LOCAL, permitidos: srv.metodosPermitidos(),
    permite, backoffMinMs: 30, entreSaludosMs: 30, log: () => {}
  });
  let cliente = nuevoCliente('ejecutar');
  const escucharRemoto = (t) => crudo(base, `/api/n/${id}/tareas/${t}/escuchar`, { method: 'POST', headers: { 'x-lagrange-token': TOKEN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' });

  try {
    cliente.iniciar();
    check('el nodo se conecta con ejecutar', await hasta(() => servidorNodos.conectado(id) && servidorNodos.permiteDe(id) === 'ejecutar'));
    await group('BE-064 — la consola del servidor: voz prestada cuando el nodo no tiene', async () => {
      respuestaNodo = { codigo: 503, ok: false, error: 'No se pudo generar el audio (setup_required).', sinVoz: true };
      const a = await escucharRemoto('t1');
      check('sinVoz → audio del servidor', a.status === 200 && /audio\/wav/.test(a.tipo || '') && a.buf.length === 700, `${a.status} ${a.tipo} ${a.buf?.length}`);
      check('con el nodo y la tarea', prestado && prestado[0] === id && prestado[1] === 't1');
      check('y queda en el log, en una línea', lineas.filter((l) => l.includes('escucharTarea')).length === 1 && lineas.some((l) => /escucharTarea → sin voz en el nodo \(No se pudo generar el audio \(setup_required\)\.\), voz del servidor: ok/.test(l)), lineas.join(' | '));
      prestado = null;
      respuestaNodo = { codigo: 502, ok: false, error: 'La voz falló al generar el audio.' };
      const b = await escucharRemoto('t1');
      check('un fallo de la voz del nodo no se presta', b.status === 502 && prestado === null, `${b.status}`);
      respuestaNodo = { binario: Buffer.alloc(300, 1), tipo: 'audio/wav' };
      const c = await escucharRemoto('t1');
      check('con voz en el nodo, su audio', c.status === 200 && c.buf.length === 300 && prestado === null);
      respuestaNodo = { codigo: 503, ok: false, error: 'setup_required', sinVoz: true };
      const d = await escucharRemoto('mal');
      check('si el servidor tampoco puede, su error', d.status === 503 && /Tampoco hay voz/.test(d.json?.error || ''), JSON.stringify(d.json));
    });
    await group('BE-064 — sin permiso no se presta la voz (SEC-022 va antes)', async () => {
      cliente.detener();
      await hasta(() => !servidorNodos.conectado(id), 2000);
      const cOperar = nuevoCliente('operar');
      cOperar.iniciar();
      check('el nodo vuelve con operar', await hasta(() => servidorNodos.conectado(id) && servidorNodos.permiteDe(id) === 'operar'));
      prestado = null;
      respuestaNodo = { codigo: 503, ok: false, error: 'setup_required', sinVoz: true };
      const r = await escucharRemoto('t1');
      check('operar: 403 y escucharPrestado no se llama', r.status === 403 && prestado === null, `${r.status} ${JSON.stringify(prestado)}`);
      cOperar.detener();
      await hasta(() => !servidorNodos.conectado(id), 2000);
      cliente = nuevoCliente('ejecutar');
      cliente.iniciar();
      check('y vuelve con ejecutar', await hasta(() => servidorNodos.conectado(id) && servidorNodos.permiteDe(id) === 'ejecutar'));
    });

    await group('BE-064 — escucharPrestado real por el RPC real (el nodo deja pasar "tarea")', async () => {
      const leidos = [];
      const prestar = bot.escucharPrestado({ rpc: servidorNodos.rpc, escuchar: async (o) => { leidos.push(o); return { ok: true, audio: Buffer.alloc(4) }; } });
      const a = await prestar(id, 't1');
      check('trae la tarea del nodo y la lee', a.ok && leidos.length === 1 && leidos[0].texto === 'Resumen del nodo.', JSON.stringify(a));
      const b = await prestar(id, 't9');
      check('una tarea que no existe en el nodo → su 404', b.codigo === 404 && leidos.length === 1, JSON.stringify(b));
    });

    await group('BE-064 — sin escucharPrestado (daemon viejo o sin red), como antes', async () => {
      const web2 = srv.crearServidorWeb({ nucleo: { canal, chatId: CHAT_WEB_LOCAL }, token: TOKEN,
        red: { servidorNodos, nucleoRemoto: (x) => crearNucleoRemoto(servidorNodos.rpc, x), nombreLocal: 'casa' } });
      const base2 = await escuchar(web2);
      respuestaNodo = { codigo: 503, ok: false, error: 'No se pudo generar el audio (setup_required).', sinVoz: true };
      const r = await crudo(base2, `/api/n/${id}/tareas/t1/escuchar`, { method: 'POST', headers: { 'x-lagrange-token': TOKEN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' });
      check('devuelve el 503 del nodo', r.status === 503 && /setup_required/.test(r.json?.error || ''));
      web2.close();
    });
  } finally {
    cliente.detener();
    web.close();
    console.log = logOriginal;
    console.warn = warnOriginal;
  }
  report();
  fs.rmSync(raiz, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
