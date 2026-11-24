/**
 * FEAT-210 S0 — El paso 2 y su conexión: ComfyUI contra un servidor falso, el proveedor agy de la charla, los
 * remotos, el refinador, el índice privado, el campo `imagenes` del registro, la cola, lo del bot (el pie, `#segura`,
 * la foto del turno, Telegram, `/cancel`) y la API v2 (la proyección, el evento, las rutas, la capacidad, el contrato).
 *
 * Sin red, sin agy y sin ComfyUI: todo se inyecta.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat210-cola-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.LAGRANGE_ALMAS_DIR, { recursive: true });

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indice = require('../mcp-server/imagenes/indice.js');
const refinador = require('../mcp-server/imagenes/refinador.js');
const codigos = require('../mcp-server/imagenes/codigos.js');
const ajustesImagenes = require('../mcp-server/lib/ajustes-imagenes.js');
const sondaVision = require('../mcp-server/imagenes/sonda-vision.js');
const archivos = require('../mcp-server/almas/archivos.js');

const PNG = sondaVision.pngSolido(8, [200, 10, 10]);
const esperarTicks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const hasta = async (cond, ms = 3000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); } return cond(); };
const config = (extra = {}) => ({ ...ajustesImagenes.defectos(), ...extra });

/** Un ComfyUI falso: guarda lo que le piden y responde según el `guion`. */
function comfyFalso(guion = {}) {
  const pedidos = [];
  let historias = 0;
  const cola = { running: [], pending: [] };
  const resp = (cuerpo, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => cuerpo, arrayBuffer: async () => (Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from('')) });
  const fetchImpl = async (url, op = {}) => {
    const u = new URL(url);
    pedidos.push({ ruta: u.pathname, metodo: op.method || 'GET', cuerpo: typeof op.body === 'string' ? JSON.parse(op.body) : op.body || null, query: u.search });
    if (guion.caido) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
    if (u.pathname === '/upload/image') return resp({ name: 'subida.png', subfolder: '' });
    if (u.pathname === '/prompt') {
      if (guion.nodeErrors) return resp({ prompt_id: 'p1', node_errors: { 3: { errors: ['x'] } } });
      if (guion.corriendo) cola.running.push([0, 'p1']);
      return resp({ prompt_id: 'p1', node_errors: {} });
    }
    if (u.pathname.startsWith('/history/')) {
      historias++;
      if (guion.colgarHistoria) return resp({});
      if (historias < (guion.historiasVacias || 1)) return resp({});
      if (guion.errorFlujo) return resp({ p1: { status: { status_str: 'error', completed: false } } });
      return resp({ p1: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'x_00001_.png', subfolder: '', type: 'output' }] }, 12: { images: [{ filename: 'prev.png', type: 'temp' }] } } } });
    }
    if (u.pathname === '/view') return resp(PNG);
    if (u.pathname === '/free') return resp({});
    if (u.pathname === '/queue' && (op.method || 'GET') === 'GET') return resp({ queue_running: cola.running, queue_pending: cola.pending });
    if (u.pathname === '/queue') { cola.pending = []; return resp({}); }
    if (u.pathname === '/interrupt') { if (!guion.noCorta) cola.running = []; return resp({}); }
    if (u.pathname === '/system_stats') return resp({ devices: [{ vram_free: 123 }] });
    return resp({}, { ok: false, status: 404 });
  };
  return { fetchImpl, pedidos, cola, rutas: () => pedidos.map((p) => `${p.metodo} ${p.ruta}`) };
}

/** Un reloj falso: `esperar` adelanta el tiempo en vez de dormir. */
function relojFalso() {
  let t = 1_000_000;
  return { ahora: () => t, esperar: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } };
}

async function main() {
  const tareas = await importar('telegram-bridge/tareas.js');
  const { crearComfyui, probarComfyui, aplicarMarcadores, nodoDeSalida } = await importar('telegram-bridge/imagenes/comfyui.js');
  const agy = await importar('telegram-bridge/imagenes/antigravity.js');
  const { crearRemoto } = await importar('telegram-bridge/imagenes/remotos.js');
  const { crearColaImagenes, claveDe } = await importar('telegram-bridge/imagenes-cola.js');

  const tmp = path.join(raiz, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const cfgComfy = config().comfyui;
  const flujos = ajustesImagenes.flujosEfectivos(config());

  await group('ComfyUI: el camino feliz contra un servidor falso', async () => {
    const f = comfyFalso({ historiasVacias: 2 });
    const r0 = relojFalso();
    const p = crearComfyui({ config: cfgComfy, flujos, fetchImpl: f.fetchImpl, ...r0 });
    const r = await p.generar({ prompt: 'un gato', negativo: 'feo', ancho: 1024, alto: 1024, semilla: 42, destino: path.join(tmp, 'c1') });
    check('termina bien', r.ok, JSON.stringify(r));
    check('escribe el destino con su extensión', r.ok && r.ruta === path.join(tmp, 'c1.png') && fs.existsSync(r.ruta));
    check('la semilla pedida se respeta', r.semilla === 42);
    const prompt = f.pedidos.find((x) => x.ruta === '/prompt');
    const textos = JSON.stringify(prompt.cuerpo.prompt);
    check('los marcadores se reemplazan en el flujo', textos.includes('un gato') && !textos.includes('{{prompt}}'));
    check('{{semilla}} queda como entero', /"seed":42\b/.test(textos) || textos.includes(':42'));
    check('lleva client_id', /^lagrange-/.test(prompt.cuerpo.client_id));
    check('espera /history mientras devuelve {}', f.pedidos.filter((x) => x.ruta.startsWith('/history/')).length >= 2);
    check('baja los bytes de type=output (no el temp)', f.pedidos.some((x) => x.ruta === '/view' && /type=output/.test(x.query) && /x_00001_/.test(x.query)));
    check('libera la GPU al terminar', f.pedidos.some((x) => x.ruta === '/free' && x.cuerpo.unload_models === true));
    const f2 = comfyFalso();
    const fotoRuta = path.join(tmp, 'foto.png'); fs.writeFileSync(fotoRuta, PNG);
    const r2 = await crearComfyui({ config: cfgComfy, flujos, fetchImpl: f2.fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, foto: fotoRuta, destino: path.join(tmp, 'c2') });
    check('…con fotoIgnorada y sin subir la foto', r2.ok && r2.fotoIgnorada === true && !f2.pedidos.some((x) => x.ruta === '/upload/image'));
    const f3 = comfyFalso();
    const conImg2img = { txt2img: flujos.txt2img, img2img: ajustesImagenes.PLANTILLA_IMG2IMG };
    const r3 = await crearComfyui({ config: cfgComfy, flujos: conImg2img, fetchImpl: f3.fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, foto: fotoRuta, destino: path.join(tmp, 'c3') });
    check('con flujo de img2img sube la foto y la usa', r3.ok && !r3.fotoIgnorada && f3.pedidos.some((x) => x.ruta === '/upload/image') && JSON.stringify(f3.pedidos.find((x) => x.ruta === '/prompt').cuerpo).includes('subida.png'));
    const sinLiberar = comfyFalso();
    await crearComfyui({ config: { ...cfgComfy, liberar_gpu: false }, flujos, fetchImpl: sinLiberar.fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'c4') });
    check('liberar_gpu apagado: no llama a /free', !sinLiberar.pedidos.some((x) => x.ruta === '/free'));
    const libre500 = comfyFalso();
    const con500 = async (url, op = {}) => (new URL(url).pathname === '/free' ? { ok: false, status: 500, json: async () => ({}) } : libre500.fetchImpl(url, op));
    const r500 = await crearComfyui({ config: cfgComfy, flujos, fetchImpl: con500, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'c5') });
    check('/free con 500: la imagen igual queda bien (mejor esfuerzo)', r500.ok === true);
  });

  await group('ComfyUI: los errores y el corte', async () => {
    const caido = await crearComfyui({ config: cfgComfy, flujos, fetchImpl: comfyFalso({ caido: true }).fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e1') });
    check('conexión rechazada → no-responde', caido.codigo === 'no-responde');
    const ne = await crearComfyui({ config: cfgComfy, flujos, fetchImpl: comfyFalso({ nodeErrors: true }).fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e2') });
    check('node_errors con claves → fallo-del-flujo', ne.codigo === 'fallo-del-flujo');
    const ef = await crearComfyui({ config: cfgComfy, flujos, fetchImpl: comfyFalso({ errorFlujo: true }).fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e3') });
    check('status_str error → fallo-del-flujo', ef.codigo === 'fallo-del-flujo');
    const roto = path.join(tmp, 'roto.json'); fs.writeFileSync(roto, '{"1":{"inputs":{"text":"sin marcador"},"class_type":"X"}}');
    const sinMarcador = await crearComfyui({ config: cfgComfy, flujos: { txt2img: roto, img2img: null }, fetchImpl: comfyFalso().fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e4') });
    check('un flujo sin {{prompt}} → fallo-del-flujo sin pedir nada', sinMarcador.codigo === 'fallo-del-flujo');
    const remota = await crearComfyui({ config: { ...cfgComfy, url: 'http://192.168.0.2:8188' }, flujos, fetchImpl: comfyFalso().fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e5') });
    check('una url que no es loopback no se usa', remota.ok === false && remota.codigo === 'error');

    // El corte con el prompt corriendo: /interrupt y se confirma por /queue.
    const f = comfyFalso({ colgarHistoria: true, corriendo: true });
    const control = new AbortController();
    const reloj = relojFalso();
    const prom = crearComfyui({ config: cfgComfy, flujos, fetchImpl: f.fetchImpl, ...reloj }).generar({ prompt: 'x', ancho: 64, alto: 64, signal: control.signal, destino: path.join(tmp, 'e6') });
    await esperarTicks(30);
    control.abort();
    const cortado = await prom;
    check('cancelada mientras corre → cancelada', cortado.codigo === 'cancelada' && !cortado.colgado);
    check('corta con /interrupt y el prompt_id', f.pedidos.some((x) => x.ruta === '/interrupt' && x.cuerpo.prompt_id === 'p1'));
    check('confirma con GET /queue después del /interrupt', f.rutas().lastIndexOf('GET /queue') > f.rutas().indexOf('POST /interrupt'));

    // ComfyUI no lo corta: colgado, para que la cola espere.
    const g = comfyFalso({ colgarHistoria: true, corriendo: true, noCorta: true });
    const c2 = new AbortController();
    const prom2 = crearComfyui({ config: cfgComfy, flujos, fetchImpl: g.fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, signal: c2.signal, destino: path.join(tmp, 'e7') });
    await esperarTicks(30);
    c2.abort();
    const colgado = await prom2;
    check('si a los 10 s sigue corriendo → cancelada con colgado', colgado.codigo === 'cancelada' && colgado.colgado === true);

    // Pendiente: se borra de la cola, nunca /interrupt.
    const h = comfyFalso({ colgarHistoria: true });
    h.cola.pending.push([0, 'p1']);
    const c3 = new AbortController();
    const prom3 = crearComfyui({ config: cfgComfy, flujos, fetchImpl: h.fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, signal: c3.signal, destino: path.join(tmp, 'e8') });
    await esperarTicks(30);
    c3.abort();
    await prom3;
    check('pendiente: POST /queue con delete, sin /interrupt', h.pedidos.some((x) => x.ruta === '/queue' && x.metodo === 'POST' && x.cuerpo.delete[0] === 'p1') && !h.pedidos.some((x) => x.ruta === '/interrupt'));

    // Ni pendiente ni corriendo: nunca se interrumpe a ciegas.
    const k = comfyFalso({ colgarHistoria: true });
    const c4 = new AbortController();
    const prom4 = crearComfyui({ config: cfgComfy, flujos, fetchImpl: k.fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, signal: c4.signal, destino: path.join(tmp, 'e9') });
    await esperarTicks(30);
    c4.abort();
    await prom4;
    check('sin el prompt en la cola: ni /interrupt ni delete', !k.pedidos.some((x) => x.ruta === '/interrupt' || (x.ruta === '/queue' && x.metodo === 'POST')));

    // El tiempo: tiempo_s y corta.
    const t = comfyFalso({ colgarHistoria: true, corriendo: true });
    const tarde = await crearComfyui({ config: { ...cfgComfy, tiempo_s: 3 }, flujos, fetchImpl: t.fetchImpl, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e10') });
    check('se pasa de tiempo → tiempo, y corta el prompt', tarde.codigo === 'tiempo' && t.pedidos.some((x) => x.ruta === '/interrupt'));

    // Un pedido que no contesta: el tope por pedido (y el signal del trabajo) lo cortan.
    const colgante = (f, ruta) => async (url, op = {}) => {
      if (new URL(url).pathname.startsWith(ruta)) return new Promise((_, rechazar) => op.signal.addEventListener('abort', () => rechazar(op.signal.reason)));
      return f.fetchImpl(url, op);
    };
    // AbortSignal.timeout no retiene el proceso: en el test, algo tiene que seguir vivo (el daemon lo está).
    const vivo = setInterval(() => {}, 1000);
    const p1 = comfyFalso();
    const sinRespuesta = await crearComfyui({ config: cfgComfy, flujos, fetchImpl: colgante(p1, '/prompt'), pedidoMs: 30, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e11') });
    check('POST /prompt enviado sin respuesta → tiempo y colgado (no pasa a agy)', sinRespuesta.codigo === 'tiempo' && sinRespuesta.colgado === true, JSON.stringify(sinRespuesta));
    const rechazo = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const apagadoAlMandar = await crearComfyui({ config: cfgComfy, flujos, fetchImpl: async () => { throw rechazo; }, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e11b') });
    check('conexión rechazada en /prompt → no-responde (no llegó)', apagadoAlMandar.codigo === 'no-responde', JSON.stringify(apagadoAlMandar));
    const cortadaRed = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const p1b = comfyFalso();
    const resetTrasMandar = await crearComfyui({ config: cfgComfy, flujos, fetchImpl: async (url, op) => { if (new URL(url).pathname === '/prompt') throw cortadaRed; return p1b.fetchImpl(url, op); }, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e11c') });
    check('conexión cortada tras mandar /prompt → tiempo y colgado', resetTrasMandar.codigo === 'tiempo' && resetTrasMandar.colgado === true, JSON.stringify(resetTrasMandar));
    const p2 = comfyFalso({ corriendo: true });
    const historiaMuda = await crearComfyui({ config: cfgComfy, flujos, fetchImpl: colgante(p2, '/history/'), pedidoMs: 30, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e12') });
    check('/history sin respuesta → tiempo, y corta el prompt', historiaMuda.codigo === 'tiempo' && p2.pedidos.some((x) => x.ruta === '/interrupt'), JSON.stringify(historiaMuda));
    const p3 = comfyFalso({ corriendo: true });
    const c5 = new AbortController();
    const prom5 = crearComfyui({ config: cfgComfy, flujos, fetchImpl: colgante(p3, '/history/'), pedidoMs: 60000, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, signal: c5.signal, destino: path.join(tmp, 'e13') });
    await esperarTicks(30);
    c5.abort();
    const cortadaEnVuelo = await prom5;
    check('cancelar con un pedido colgado → cancelada en el momento, y corta', cortadaEnVuelo.codigo === 'cancelada' && p3.pedidos.some((x) => x.ruta === '/interrupt'));
    clearInterval(vivo);

    // El detalle de node_errors va al log sin rutas.
    const logs = [];
    const p4 = comfyFalso();
    const conRuta = async (url, op = {}) => (new URL(url).pathname === '/prompt'
      ? { ok: true, status: 200, json: async () => ({ prompt_id: 'p1', node_errors: { 4: { errors: [{ details: 'ckpt_name: C:\\ComfyUI\\models\\checkpoints\\falta.safetensors y /home/u/modelos/x.bin' }] } } }) }
      : p4.fetchImpl(url, op));
    await crearComfyui({ config: cfgComfy, flujos, fetchImpl: conRuta, log: (l) => logs.push(l), ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e14') });
    const conEspacios = [];
    const p5 = comfyFalso();
    const conRutaEspacios = async (url, op = {}) => (new URL(url).pathname === '/prompt'
      ? { ok: true, status: 200, json: async () => ({ prompt_id: 'p1', node_errors: { 4: { errors: [{ details: 'falta C:\\Program Files\\ComfyUI\\models\\a b.safetensors', extra: '/home/user/My Documents/x.bin' }] } } }) }
      : p5.fetchImpl(url, op));
    await crearComfyui({ config: cfgComfy, flujos, fetchImpl: conRutaEspacios, log: (l) => conEspacios.push(l), ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, destino: path.join(tmp, 'e15') });
    check('rutas con espacios tampoco quedan en el log', conEspacios.length > 0 && !conEspacios.some((l) => /Program|Files|ComfyUI\\|My Documents|home/.test(l)), JSON.stringify(conEspacios));
    // /interrupt anda pero /queue da 503 al confirmar: no se da por cortado.
    const q = comfyFalso({ colgarHistoria: true, corriendo: true });
    let interrumpido = false;
    const queueRoto = async (url, op = {}) => {
      const u = new URL(url);
      if (u.pathname === '/interrupt') interrumpido = true;
      if (interrumpido && u.pathname === '/queue') return { ok: false, status: 503, json: async () => ({}) };
      return q.fetchImpl(url, op);
    };
    const c6 = new AbortController();
    const prom6 = crearComfyui({ config: cfgComfy, flujos, fetchImpl: queueRoto, ...relojFalso() }).generar({ prompt: 'x', ancho: 64, alto: 64, signal: c6.signal, destino: path.join(tmp, 'e16') });
    await esperarTicks(30);
    c6.abort();
    const sinConfirmar = await prom6;
    check('/queue con error tras el /interrupt → colgado, no cortado', sinConfirmar.codigo === 'cancelada' && sinConfirmar.colgado === true, JSON.stringify(sinConfirmar));
    check('node_errors en el log sin rutas', logs.some((l) => l.includes('rechazó el flujo') && l.includes('<ruta>')) && !logs.some((l) => /checkpoints|\/home\//.test(l)), JSON.stringify(logs));
  });

  await group('ComfyUI: marcadores, salida y probar', async () => {
    const flujo = { 1: { class_type: 'KSampler', inputs: { seed: '{{semilla}}', steps: '{{pasos}}', denoise: '{{fuerza}}', text: 'a {{prompt}}' } }, 2: { class_type: 'SaveImage', inputs: {} } };
    const m = aplicarMarcadores(flujo, { semilla: 7, pasos: 30, fuerza: 0.6, prompt: 'gato' });
    check('los enteros quedan enteros y el número, número', m[1].inputs.seed === 7 && m[1].inputs.steps === 30 && m[1].inputs.denoise === 0.6);
    check('el texto se reemplaza dentro de una cadena', m[1].inputs.text === 'a gato');
    check('el flujo original no se toca', flujo[1].inputs.seed === '{{semilla}}');
    check('sin nodo_salida: el primer SaveImage del flujo', nodoDeSalida(flujo, '') === '2');
    check('con nodo_salida: ese', nodoDeSalida(flujo, '1') === '1');
    const ok = await probarComfyui({ url: 'http://127.0.0.1:8188', fetchImpl: comfyFalso().fetchImpl });
    check('probar: ok con la VRAM libre', ok.ok && ok.vramLibre === 123);
    const no = await probarComfyui({ url: 'http://127.0.0.1:8188', fetchImpl: comfyFalso({ caido: true }).fetchImpl });
    check('probar: no responde, con texto fijo', !no.ok && no.codigo === 'no-responde');
    const lejos = await probarComfyui({ url: 'http://10.0.0.5:8188', fetchImpl: comfyFalso().fetchImpl });
    check('probar: una url que no es loopback se rechaza sin pedir', lejos.codigo === 'no-loopback');
  });

  await group('agy de la charla: guardas, args y salida', async () => {
    const fuente = fs.readFileSync(path.join(RAIZ, 'mcp-server', 'index.js'), 'utf8');
    check('ARGS_BASE son los de agy_image', fuente.includes(`const cliArgs = [${agy.ARGS_BASE.map((a) => `'${a}'`).join(', ')}];`));
    check('las tres reglas de imagen son las de agy_image', agy.REGLAS_IMAGEN.every((r) => fuente.includes(`'${r.replace(/'/g, "\\'")}'`)));
    const seguridad = fuente.slice(fuente.indexOf('function buildSecurityRules('), fuente.indexOf('function buildSecurityRules(') + 4000);
    check('las reglas de permisos están en buildSecurityRules', agy.REGLAS_PERMISOS.every((r) => seguridad.includes(r.slice(2, 40))));
    check('el aspecto más cercano', agy.aspectoMasCercano(1024, 576) === '16:9' && agy.aspectoMasCercano(1000, 1000) === '1:1');
    check('dimensiones estimadas: 1024 del lado largo', JSON.stringify(agy.dimensiones('9:16')) === JSON.stringify({ ancho: 576, alto: 1024 }));

    agy.olvidarSlashParaTests();
    const base = { leerAyuda: () => 'usage: agy --disable-slash-commands', estadoCuota: null, revisarCuota: () => null };
    const manual = await agy.crearAntigravity({ ...base, runAgyArgs: async () => { throw new Error('no'); }, enModoManual: () => true }).generar({ prompt: 'x', destino: path.join(tmp, 'a0') });
    check('modo manual → manual, sin lanzar', manual.codigo === 'manual');
    const cancelada = await agy.crearAntigravity({ ...base, runAgyArgs: async () => { throw new Error('no'); }, enModoManual: () => false }).generar({ prompt: 'x', signal: AbortSignal.abort(), destino: path.join(tmp, 'a1') });
    check('signal ya abortado → cancelada, sin lanzar', cancelada.codigo === 'cancelada');

    const imagenAgy = path.join(tmp, 'agy-artefacto.png');
    fs.writeFileSync(imagenAgy, sondaVision.pngSolido(16, [1, 2, 3]));
    const llamadas = [];
    const usos = [];
    const prov = agy.crearAntigravity({
      ...base, enModoManual: () => false, modelo: () => ({ model: 'gemini-x', effortPorDefecto: 'low' }), guardrails: (p) => `[G]\n${p}`, registrarUso: (u) => usos.push(u),
      runAgyArgs: async (args, op) => { llamadas.push({ args, op }); op.onSpawn(() => {}); return { success: true, data: { response: `listo: ${imagenAgy}`, conversation_id: 'c1' } }; }
    });
    const r = await prov.generar({ prompt: 'un perro', ancho: 1024, alto: 1024, foto: path.join(tmp, 'foto.png'), destino: path.join(tmp, 'a2'), origen: 'usuario', rol: 'alma:alya' });
    const args = llamadas[0].args;
    check('agy: termina bien y devuelve la ruta que escribió', r.ok && fs.existsSync(r.ruta), JSON.stringify(r));
    check('agy: con foto, la ignora y lo anota', r.fotoIgnorada === true);
    check('agy: sin semilla (otra versión vuelve a correr el prompt)', r.semilla === null);
    check('agy: lleva ARGS_BASE, --disable-slash-commands, --model y --effort', agy.ARGS_BASE.every((a) => args.includes(a)) && args.includes('--disable-slash-commands') && args[args.indexOf('--model') + 1] === 'gemini-x' && args[args.indexOf('--effort') + 1] === 'low');
    const prompt = args[args.indexOf('-p') + 1];
    check('agy: el prompt va envuelto por los guardrails y con las reglas', prompt.startsWith('[G]') && agy.REGLAS_IMAGEN.every((x) => prompt.includes(x)) && agy.REGLAS_PERMISOS.every((x) => prompt.includes(x)));
    check('agy: el destino queda en el .tmp pedido (un .jpg concreto)', r.ruta.startsWith(path.join(tmp, 'a2')));
    check('agy: el uso con tool imagen_charla', usos.length === 1 && usos[0].tool === 'imagen_charla' && usos[0].motor === 'antigravity' && usos[0].rol === 'alma:alya');

    // La deuda de S0: un abort en la carrera (después del último chequeo, antes de onSpawn) corta al llegar onSpawn; uno
    // después del spawn llama al corte guardado.
    {
      const control = new AbortController();
      let cortesCarrera = 0;
      const carrera = await agy.crearAntigravity({ ...base, enModoManual: () => false,
        runAgyArgs: async (args, op) => { control.abort(); op.onSpawn(() => { cortesCarrera++; }); return { success: false, cancelled: true, error: 'Cancelado.' }; }
      }).generar({ prompt: 'x', signal: control.signal, destino: path.join(tmp, 'a-carrera') });
      check('agy: abort antes de onSpawn → onSpawn corta en el acto y queda cancelada', cortesCarrera === 1 && carrera.codigo === 'cancelada', JSON.stringify({ cortesCarrera, carrera }));
      const control2 = new AbortController();
      let cortesDespues = 0;
      const despues = await agy.crearAntigravity({ ...base, enModoManual: () => false,
        runAgyArgs: async (args, op) => { op.onSpawn(() => { cortesDespues++; }); control2.abort(); return { success: false, cancelled: true, error: 'Cancelado.' }; }
      }).generar({ prompt: 'x', signal: control2.signal, destino: path.join(tmp, 'a-despues') });
      check('agy: abort después del spawn → llama al corte guardado', cortesDespues === 1 && despues.codigo === 'cancelada');
    }
    const sinCuota = await agy.crearAntigravity({ ...base, enModoManual: () => false, runAgyArgs: async () => ({ success: false, error: 'RESOURCE_EXHAUSTED: quota exceeded' }) }).generar({ prompt: 'x', destino: path.join(tmp, 'a3') });
    check('agy sin cuota al generar → cupo', sinCuota.codigo === 'cupo', JSON.stringify(sinCuota));

    // La cuota: una ventana vencida en la captura se refresca antes de rechazar (como la charla).
    const refrescos = [];
    let bloqueada = true;
    // Una ventana registrada para cualquier grupo, mientras siga bloqueada.
    const estadoFalso = { cuotaHastaPorGrupo: () => new Proxy({}, { get: () => (bloqueada ? { hasta: Date.now() + 3600e3, visto_en: Date.now() } : undefined) }) };
    const conRefresco = await agy.crearAntigravity({
      ...base, enModoManual: () => false, modelo: () => ({ model: 'gemini-3-pro', effortPorDefecto: null }), estadoCuota: estadoFalso, revisarCuota: () => null,
      refrescarCuota: async (o) => { refrescos.push(o.grupo); bloqueada = false; return { ok: true }; }, cooldownRefrescos: new Map(),
      runAgyArgs: async () => ({ success: false, error: 'boom' })
    }).generar({ prompt: 'x', destino: path.join(tmp, 'a4') });
    check('agy: con la ventana vencida refresca /usage y no rechaza por cupo', refrescos.length === 1 && conRefresco.codigo !== 'cupo', JSON.stringify({ refrescos, conRefresco }));
  });

  await group('Los remotos: cableados, no generan', async () => {
    const o = crearRemoto('openai');
    const r = await o.generar({});
    check('openai → no-implementado', r.ok === false && r.codigo === 'no-implementado' && r.proveedor === 'openai');
    check('gemini también', (await crearRemoto('gemini').generar({})).codigo === 'no-implementado');
  });

  await group('El refinador', async () => {
    check('parsea con cercos de código', refinador.parsearSalida('```json\n{"prompt":"a"}\n```').prompt === 'a');
    check('un texto sin JSON → null', refinador.parsearSalida('nada') === null);
    const s = refinador.sanear({ prompt: 'x'.repeat(2000), negativo: 'y'.repeat(900), proporcion: '7:3' }, 300);
    check('sanea: prompt al tope, negativo a 300, proporción fuera de lista → 1:1', s.prompt.length === 300 && s.negativo.length === 300 && s.proporcion === '1:1');
    check('sin prompt → null', refinador.sanear({ negativo: 'a' }, 300) === null);
    const sin = refinador.sinRefinar('un gato', 300);
    check('sin refinar: el texto del alma, 1:1 y el negativo genérico', sin.prompt === 'un gato' && sin.proporcion === '1:1' && sin.negativo === refinador.NEGATIVO_GENERICO && sin.refinado === false);
    const llamadas = [];
    const vision = { llamar: async (o) => { llamadas.push(o); return o.partes.imagen ? { ok: false, sinVision: true } : { ok: true, texto: '{"prompt":"refinado","negativo":"n","proporcion":"16:9"}', modelo: 'm' }; } };
    const r = await refinador.refinar({ pedido: 'un gato', mensaje: 'hola', foto: { ruta: '/x.png', descripcion: { ok: true, texto: 'una foto de un gato' } }, vision });
    check('con foto: prueba primero con los bytes', llamadas[0].partes.imagen && llamadas[0].modo === 'refinar');
    check('si falla con la foto, usa la descripción', llamadas.length === 2 && llamadas[1].partes.texto.includes('una foto de un gato') && r.prompt === 'refinado' && r.proporcion === '16:9' && r.conFoto === false);
    const noParsea = await refinador.refinar({ pedido: 'texto del alma', vision: { llamar: async () => ({ ok: true, texto: 'no es json' }) } });
    check('respondió pero no parsea → el texto del alma', noParsea.prompt === 'texto del alma' && noParsea.refinado === false);
    const control = new AbortController(); control.abort();
    const cancel = await refinador.refinar({ pedido: 'x', signal: control.signal, vision: { llamar: async () => ({ ok: false, cancelado: true }) } });
    check('cancelado → { cancelado: true }', cancel.cancelado === true);
  });

  await group('El índice privado', async () => {
    const env = process.env;
    fs.mkdirSync(path.join(process.env.LAGRANGE_ALMAS_DIR, 'alya'), { recursive: true });
    let lanzo = false;
    try { indice.rutaArchivo('alya', '../x', 1, 1, 'png', env); } catch { lanzo = true; }
    check('un tareaId inválido lanza', lanzo);
    lanzo = false;
    try { indice.rutaArchivo('alya', 't_abcd1234', 1, 1, 'exe', env); } catch { lanzo = true; }
    check('una extensión fuera de lista lanza', lanzo);
    const archivo = indice.rutaArchivo('alya', 't_abcd1234', 1, 1, 'png', env);
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, PNG);
    indice.actualizar('alya', 't_abcd1234', 1, () => ({ archivo, hilo: 'h1', lista: true, vista: 'un gato rojo', prompt: 'p', externo: false, sha256: indice.sha256(PNG), creada: '2026-01-01T00:00:00Z' }), env);
    check('vistasPendientes: la de ese hilo', indice.vistasPendientes('alya', 'h1', env).length === 1 && indice.vistasPendientes('alya', 'h2', env).length === 0);
    // Dos escritores intercalados bajo el cerrojo: ninguno pisa al otro.
    await Promise.all([
      Promise.resolve().then(() => indice.actualizar('alya', 't_abcd1234', 1, (p) => ({ ...p, vistaEntregada: true }), env)),
      Promise.resolve().then(() => indice.actualizar('alya', 't_abcd1234', 1, (p) => ({ ...p, vistaOrden: true }), env))
    ]);
    const e = indice.leer('alya', 't_abcd1234', 1, env);
    check('dos escrituras intercaladas conservan los dos campos', e.vistaEntregada === true && e.vistaOrden === true);
    check('entregada: ya no está pendiente', indice.vistasPendientes('alya', 'h1', env).length === 0);
    const mapa = indice.construirMapa(env);
    check('el mapa sha256 → { clave, tareaId, n }', mapa.get(indice.sha256(PNG))?.tareaId === 't_abcd1234');
    fs.mkdirSync(indice.dirTmp('alya', env), { recursive: true });
    fs.writeFileSync(path.join(indice.dirTmp('alya', env), 'basura'), 'x');
    indice.vaciarTmp('alya', env);
    check('vaciarTmp borra .tmp/', !fs.existsSync(indice.dirTmp('alya', env)));
    check('el índice usa el cerrojo de las almas', typeof archivos.conLock === 'function');
  });

  await group('El registro: el campo imagenes', async () => {
    const avisos = [];
    const baja = tareas.suscribir((t, info) => avisos.push({ id: t.id, info }));
    const t = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'hola' });
    tareas.actualizar(t.id, { imagenes: [{ n: 1, estado: 'generando', pedido: 'p'.repeat(500), archivo: '/secreto.png', ruta: '/x' }] });
    const g = tareas.obtener(t.id);
    check('normaliza: sin campos privados', g.imagenes[0].archivo === undefined && g.imagenes[0].ruta === undefined);
    check('normaliza: el pedido al tope de 300', g.imagenes[0].pedido.length === 300);
    check('avisa con cambioImagen', avisos.some((a) => a.id === t.id && a.info.cambioImagen === true));
    check('resumen proyecta { n, estado }', JSON.stringify(tareas.resumen(g).imagenes) === JSON.stringify([{ n: 1, estado: 'generando' }]));
    tareas.actualizar(t.id, { imagenes: [1, 2, 3, 4, 5].map((n) => ({ n, estado: 'lista' })) });
    check('tope de 4 entradas', tareas.obtener(t.id).imagenes.length === 4);
    tareas.actualizar(t.id, { imagenes: [{ n: 0, estado: 'lista' }, { n: 2, estado: 'rara' }] });
    check('entradas sin forma se descartan (y la lista vacía se borra)', tareas.obtener(t.id).imagenes === undefined);
    // El barrido de arranque, también con la tarea cerrada.
    tareas.actualizar(t.id, { estado: 'ok', imagenes: [{ n: 1, estado: 'generando' }, { n: 2, estado: 'lista' }] });
    avisos.length = 0;
    const n = tareas.barrerImagenesAlArrancar(codigos.mensajeDe('interrumpida'));
    const b = tareas.obtener(t.id);
    check('el barrido toca la generando de una tarea en ok', n === 1 && b.imagenes[0].estado === 'error' && b.imagenes[0].codigo === 'interrumpida');
    check('…sin tocar la lista', b.imagenes[1].estado === 'lista');
    check('…y avisa con cambioImagen', avisos.some((a) => a.id === t.id && a.info.cambioImagen));
    check('conImagenAbierta', tareas.conImagenAbierta({ imagenes: [{ estado: 'generando' }] }) && !tareas.conImagenAbierta({ imagenes: [{ estado: 'lista' }] }));
    baja();
  });

  // --------------------------------------------------------------- la cola
  const clave = 'alya';
  const nuevaTarea = () => {
    const t = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave }, pedido: 'hola' });
    tareas.actualizar(t.id, { estado: 'ok' });
    return t.id;
  };
  const registro = { tarea: (id) => tareas.obtener(id), actualizar: (id, c) => tareas.actualizar(id, c) };
  const proveedorFalso = (id, comportamiento) => ({
    id,
    dimensiones: () => ({ ancho: 1024, alto: 768 }),
    llamadas: 0,
    async generar(op) {
      this.llamadas++;
      const r = typeof comportamiento === 'function' ? await comportamiento(op) : comportamiento;
      if (r.ok) { const ruta = `${op.destino}.png`; fs.writeFileSync(ruta, PNG); return { ok: true, ruta, tipo: 'image/png', ancho: 1024, alto: 768, semilla: 5, proveedor: id, modelo: 'm' }; }
      return { proveedor: id, ...r };
    }
  });
  const sinVision = { llamar: async () => ({ ok: false, sinVision: true }) };
  const refinadorFalso = { refinar: async () => ({ prompt: 'refinado', negativo: 'n', proporcion: '4:3', refinado: true }), sinRefinar: refinador.sinRefinar };
  const armarCola = ({ provs, cfg = {}, mirar = null }) => crearColaImagenes({
    registro, proveedor: (id) => provs[id] || null, leerConfig: () => config({ orden: Object.keys(provs), alma_la_ve: false, ...cfg }),
    refinador: refinadorFalso, vision: mirar || sinVision, manual: () => false, env: process.env
  });
  const entrada = (id, n = 1) => (tareas.obtener(id).imagenes || []).find((e) => e.n === n);

  await group('La cola: el camino feliz', async () => {
    const comfy = proveedorFalso('comfyui', { ok: true });
    const envios = [];
    const cola = armarCola({ provs: { comfyui: comfy } });
    const id = nuevaTarea();
    const r = cola.encolar({ tareaId: id, clave, hilo: 'h1', pedido: 'un gato', mensaje: 'hola', envio: async (x) => envios.push(x), origen: 'usuario' });
    check('encolar devuelve { ok, n: 1 }', r.ok && r.n === 1);
    check('la entrada queda generando, 1024 × 1024', entrada(id).estado === 'generando' && entrada(id).ancho === 1024 && entrada(id).alto === 1024);
    await hasta(() => entrada(id).estado === 'lista');
    const e = entrada(id);
    check('termina lista con lo del proveedor', e.estado === 'lista' && e.proveedor === 'comfyui' && e.alto === 768 && e.semilla === 5);
    check('lleva el prompt refinado (público)', e.prompt === 'refinado' && e.negativo === 'n');
    check('la tarea no lleva rutas', !JSON.stringify(tareas.obtener(id)).includes(path.sep + 'imagenes' + path.sep));
    const priv = indice.leer(clave, id, 1);
    check('el índice guarda archivo, hilo y sha256', priv.archivo && fs.existsSync(priv.archivo) && priv.hilo === 'h1' && priv.sha256 === indice.sha256(PNG));
    check('el archivo final es <tareaId>-<n>-<intento>.png', path.basename(priv.archivo) === `${id}-1-1.png`);
    await hasta(() => envios.length === 1);
    check('el envío recibe { ok, n, ruta }', envios[0].ok && envios[0].n === 1 && envios[0].ruta === priv.archivo);
    check('bytesDe da los bytes', cola.bytesDe(id, 1).ok && cola.bytesDe(id, 1).bytes.equals(PNG));
    check('bytesDe de una que no está: 404', cola.bytesDe(id, 9).ok === false);
    check('reconoce los bytes como propios', cola.reconocer(PNG)?.tareaId === id);
    check('claveDe lee sujeto.clave', claveDe(tareas.obtener(id)) === clave);
  });

  await group('La cola: el orden de los proveedores', async () => {
    const comfy = proveedorFalso('comfyui', { ok: false, codigo: 'no-responde' });
    const ag = proveedorFalso('antigravity', { ok: true });
    const cola = armarCola({ provs: { comfyui: comfy, antigravity: ag } });
    const id = nuevaTarea();
    cola.encolar({ tareaId: id, clave, pedido: 'x' });
    await hasta(() => entrada(id).estado !== 'generando');
    check('no-responde pasa al siguiente', entrada(id).estado === 'lista' && entrada(id).proveedor === 'antigravity' && comfy.llamadas === 1);

    const roto = proveedorFalso('comfyui', { ok: false, codigo: 'error' });
    const ag2 = proveedorFalso('antigravity', { ok: true });
    const cola2 = armarCola({ provs: { comfyui: roto, antigravity: ag2 } });
    const id2 = nuevaTarea();
    cola2.encolar({ tareaId: id2, clave, pedido: 'x' });
    await hasta(() => entrada(id2).estado !== 'generando');
    check('un error corta (no gasta cuota de agy)', entrada(id2).estado === 'error' && entrada(id2).codigo === 'error' && ag2.llamadas === 0);

    const cola3 = armarCola({ provs: { comfyui: proveedorFalso('comfyui', { ok: false, codigo: 'no-responde' }), antigravity: proveedorFalso('antigravity', { ok: false, codigo: 'manual' }) } });
    const id3 = nuevaTarea();
    cola3.encolar({ tareaId: id3, clave, pedido: 'x' });
    await hasta(() => entrada(id3).estado !== 'generando');
    check('todos cayeron → sin-proveedor, nombrando a cada uno', entrada(id3).codigo === 'sin-proveedor' && entrada(id3).mensaje === 'ComfyUI no responde; agy está en modo manual.', entrada(id3).mensaje);
  });

  await group('La cola: topes, apagadas y cancelar', async () => {
    // Un proveedor que no termina hasta que lo aborten.
    const lento = proveedorFalso('comfyui', (op) => new Promise((r) => op.signal.addEventListener('abort', () => r({ ok: false, codigo: 'cancelada' }))));
    const cola = armarCola({ provs: { comfyui: lento } });
    const ids = [1, 2, 3, 4, 5, 6].map(() => nuevaTarea());
    // La primera entra en curso; después, cuatro pendientes y la sexta no entra.
    const rs = [cola.encolar({ tareaId: ids[0], clave, pedido: 'x' })];
    await esperarTicks(10);
    for (const id of ids.slice(1)) rs.push(cola.encolar({ tareaId: id, clave, pedido: 'x' }));
    await esperarTicks(10);
    check('una en curso y cuatro pendientes; la sexta → cola-llena', rs.slice(0, 5).every((r) => r.ok) && rs[5].codigo === 'cola-llena' && entrada(ids[5]).codigo === 'cola-llena');
    check('estadoDeImagenes', JSON.stringify(cola.estadoDeImagenes()) === JSON.stringify({ pendientes: 4, enCurso: 1 }));
    check('tieneAbiertas', cola.tieneAbiertas(ids[0]) && cola.tieneAbiertas(ids[3]) && !cola.tieneAbiertas(ids[5]));
    const una = cola.cancelarImagenes({ tareaId: ids[2], n: 1 });
    check('cancelar una sola: la pendiente sale, cancelada', una === 1 && entrada(ids[2]).codigo === 'cancelada' && cola.estadoDeImagenes().pendientes === 3);
    const todas = cola.cancelarImagenes({ codigo: 'apagadas' });
    check('la en curso pasa a error en el acto, sin esperar al proveedor', entrada(ids[0]).estado === 'error' && entrada(ids[0]).codigo === 'apagadas');
    // El proveedor desenrolla después: la cola se vacía cuando termina.
    await hasta(() => cola.estadoDeImagenes().enCurso === 0);
    check('cancelar todas: pendientes y la en curso, con el código pedido', todas === 4 && ids.slice(0, 5).filter((_, i) => i !== 2).every((id) => entrada(id).codigo === 'apagadas'));
    check('la cola queda vacía', JSON.stringify(cola.estadoDeImagenes()) === JSON.stringify({ pendientes: 0, enCurso: 0 }));

    // Un proveedor que ignora el abort y termina bien: lo que devuelve no se guarda ni se manda.
    let soltar;
    const terco = proveedorFalso('comfyui', () => new Promise((r) => { soltar = () => r({ ok: true }); }));
    const envTerco = [];
    const colaT = armarCola({ provs: { comfyui: terco } });
    const idT = nuevaTarea();
    colaT.encolar({ tareaId: idT, clave, pedido: 'x', envio: async (x) => envTerco.push(x) });
    await hasta(() => typeof soltar === 'function');
    colaT.cancelarImagenes({ tareaId: idT });
    check('cancelada en curso: error en el acto', entrada(idT).estado === 'error' && entrada(idT).codigo === 'cancelada');
    soltar();
    await hasta(() => colaT.estadoDeImagenes().enCurso === 0);
    await esperarTicks(10);
    check('el ok tardío no la pasa a lista ni guarda archivo', entrada(idT).estado === 'error' && !indice.leer(clave, idT, 1)?.archivo);
    check('un solo aviso de envío (el de error)', envTerco.length === 1 && envTerco[0].ok === false, JSON.stringify(envTerco));
    check('sin restos en .tmp', !fs.readdirSync(indice.dirTmp(clave)).some((f) => f.startsWith(idT)));

    // Un nodo (alArrancar sin claves) no lee las almas: no reconoce ni las imágenes que existen.
    const nodo = armarCola({ provs: { comfyui: proveedorFalso('comfyui', { ok: true }) } });
    nodo.alArrancar([]);
    check('alArrancar([]): mapa vacío, sin leer las almas', nodo.reconocer(PNG) === null);
    const daemon = armarCola({ provs: { comfyui: proveedorFalso('comfyui', { ok: true }) } });
    daemon.alArrancar([clave]);
    check('alArrancar con claves: sí reconoce las propias', Boolean(daemon.reconocer(PNG)));

    const apagada = armarCola({ provs: { comfyui: proveedorFalso('comfyui', { ok: true }) }, cfg: { activas: false } });
    const idA = nuevaTarea();
    apagada.encolar({ tareaId: idA, clave, pedido: 'x' });
    await hasta(() => entrada(idA).estado !== 'generando');
    check('apagadas al empezar el trabajo → apagadas, sin generar', entrada(idA).codigo === 'apagadas');
    const porAlma = armarCola({ provs: { comfyui: proveedorFalso('comfyui', { ok: true }) }, cfg: { por_alma: { alya: false } } });
    const idP = nuevaTarea();
    porAlma.encolar({ tareaId: idP, clave, pedido: 'x' });
    await hasta(() => entrada(idP).estado !== 'generando');
    check('apagada para esa alma → apagadas', entrada(idP).codigo === 'apagadas');
  });

  await group('La cola: otra versión, reintentar y la mirada', async () => {
    let falla = true;
    const prov = proveedorFalso('comfyui', () => (falla ? { ok: false, codigo: 'tiempo' } : { ok: true }));
    const miradas = [];
    const mirar = { llamar: async (o) => { miradas.push(o); return { ok: true, texto: 'un gato rojo', orden: false, modelo: 'v' }; } };
    const cola = armarCola({ provs: { comfyui: prov }, cfg: { alma_la_ve: true }, mirar });
    const id = nuevaTarea();
    cola.encolar({ tareaId: id, clave, hilo: 'h9', pedido: 'x' });
    await hasta(() => entrada(id).estado !== 'generando');
    check('tiempo corta con su código', entrada(id).codigo === 'tiempo' && entrada(id).mensaje === 'El proveedor tardó demasiado.');
    falla = false;
    const re = cola.reintentar(id, 1);
    check('reintentar: misma n, intento 2', re.ok && re.n === 1 && entrada(id).intento === 2);
    await hasta(() => entrada(id).estado === 'lista');
    check('…y termina lista', entrada(id).estado === 'lista');
    check('reintentar una lista → no-en-error', cola.reintentar(id, 1).codigo === 'no-en-error');
    await hasta(() => indice.leer(clave, id, 1)?.vista);
    check('con alma_la_ve, la mirada guarda la vista en el índice', indice.leer(clave, id, 1).vista === 'un gato rojo' && miradas[0].modo === 'mirar');
    check('la vista queda pendiente para ese hilo', indice.vistasPendientes(clave, 'h9').some((v) => v.tareaId === id));
    const o = cola.otra(id, 1);
    check('otra: n nueva con el mismo prompt', o.ok && o.n === 2);
    await hasta(() => entrada(id, 2)?.estado === 'lista');
    check('…termina lista', entrada(id, 2).estado === 'lista' && entrada(id, 2).prompt === entrada(id, 1).prompt);
    cola.otra(id, 1); cola.otra(id, 1);
    await hasta(() => (tareas.obtener(id).imagenes || []).every((e) => e.estado !== 'generando'));
    check('con 4 entradas, otra → tope-turno', cola.otra(id, 1).codigo === 'tope-turno');
    const apagada = armarCola({ provs: { comfyui: prov }, cfg: { otra_version: false } });
    check('otra_version apagada → apagada', apagada.otra(id, 1).codigo === 'apagada');
    const desdeFoto = nuevaTarea();
    tareas.actualizar(desdeFoto, { imagenes: [{ n: 1, estado: 'error', desdeFoto: true, pedido: 'x', codigo: 'tiempo' }] });
    indice.actualizar(clave, desdeFoto, 1, () => ({ fotoRuta: path.join(raiz, 'no-existe.png') }));
    check('reintentar desdeFoto sin la foto → foto-perdida', cola.reintentar(desdeFoto, 1).codigo === 'foto-perdida');
    check('otra desdeFoto sin la foto → foto-perdida', cola.otra(desdeFoto, 1).codigo === 'foto-perdida');

    // Una tarea con una imagen abierta no se expulsa por el tope del registro.
    const abierta = nuevaTarea();
    tareas.actualizar(abierta, { imagenes: [{ n: 1, estado: 'generando', pedido: 'x' }] });
    for (let i = 0; i < tareas.TOPE_TAREAS + 3; i++) nuevaTarea();
    check('con el registro lleno, la tarea con imagen abierta sigue', Boolean(tareas.obtener(abierta)));
    tareas.actualizar(abierta, { imagenes: [{ n: 1, estado: 'error', pedido: 'x', codigo: 'cancelada' }] });

    // Reintentar conserva la proporción que dio el refinador (4:3), no vuelve a 1:1.
    const pedidasDims = [];
    let fallaDims = true;
    const provDims = { ...proveedorFalso('comfyui', () => (fallaDims ? { ok: false, codigo: 'tiempo' } : { ok: true })), dimensiones: (p) => { pedidasDims.push(p); return { ancho: 1024, alto: 768 }; } };
    const colaDims = armarCola({ provs: { comfyui: provDims } });
    const idDims = nuevaTarea();
    colaDims.encolar({ tareaId: idDims, clave, hilo: 'h10', pedido: 'x' });
    await hasta(() => entrada(idDims).estado === 'error');
    fallaDims = false;
    colaDims.reintentar(idDims, 1);
    await hasta(() => entrada(idDims).estado === 'lista');
    check('reintentar conserva la proporción refinada', pedidasDims.length >= 2 && pedidasDims.every((p) => p === '4:3'), JSON.stringify(pedidasDims));
  });

  await group('La cola: el tope por alma', async () => {
    const clavePoda = 'poda';
    fs.mkdirSync(path.join(process.env.LAGRANGE_ALMAS_DIR, clavePoda), { recursive: true });
    const viejo = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave: clavePoda }, pedido: 'x' });
    tareas.actualizar(viejo.id, { estado: 'ok', imagenes: [{ n: 1, estado: 'lista' }] });
    const arch = indice.rutaArchivo(clavePoda, viejo.id, 1, 1, 'png');
    fs.mkdirSync(path.dirname(arch), { recursive: true });
    fs.writeFileSync(arch, PNG);
    indice.actualizar(clavePoda, viejo.id, 1, () => ({ archivo: arch, creada: '2000-01-01T00:00:00Z' }));
    for (let i = 0; i < indice.TOPE_POR_ALMA - 1; i++) {
      const tid = `t_relleno${String(i).padStart(4, '0')}`;
      const a = indice.rutaArchivo(clavePoda, tid, 1, 1, 'png');
      fs.writeFileSync(a, 'x');
      indice.actualizar(clavePoda, tid, 1, () => ({ archivo: a, creada: `2010-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` }));
    }
    const cola = armarCola({ provs: { comfyui: proveedorFalso('comfyui', { ok: true }) } });
    const t = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave: clavePoda }, pedido: 'x' });
    cola.encolar({ tareaId: t.id, clave: clavePoda, pedido: 'x' });
    await hasta(() => (tareas.obtener(t.id).imagenes || [])[0]?.estado === 'lista');
    await hasta(() => !fs.existsSync(arch));
    check('la 501 borra la más vieja', !fs.existsSync(arch) && indice.leer(clavePoda, viejo.id, 1) === null);
    check('…y su entrada pasa a borrada', tareas.obtener(viejo.id).imagenes[0].estado === 'borrada');
    // Reintentar una imagen vieja con el tope lleno: la nueva no se poda (y llega a mandarse); se va la más vieja de las otras.
    const vieja2 = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave: clavePoda }, pedido: 'x' });
    tareas.actualizar(vieja2.id, { estado: 'ok', imagenes: [{ n: 1, estado: 'error', pedido: 'x', codigo: 'tiempo', prompt: 'p' }] });
    const arch2 = indice.rutaArchivo(clavePoda, vieja2.id, 1, 1, 'png');
    fs.writeFileSync(arch2, PNG);
    indice.actualizar(clavePoda, vieja2.id, 1, () => ({ archivo: arch2, creada: '2000-01-02T00:00:00Z' }));
    const mandadas = [];
    cola.reintentar(vieja2.id, 1, { envio: async (r) => { mandadas.push(r.ruta && fs.existsSync(r.ruta)); } });
    await hasta(() => tareas.obtener(vieja2.id).imagenes[0].estado === 'lista' && mandadas.length === 1);
    check('el reintento de una vieja con el tope lleno sigue lista y se manda', tareas.obtener(vieja2.id).imagenes[0].estado === 'lista' && mandadas[0] === true && indice.leer(clavePoda, vieja2.id, 1)?.archivo);
    check('…y se poda la más vieja de las otras', indice.leer(clavePoda, 't_relleno0000', 1) === null);
  });

  // --------------------------------------------------------------- el bot
  const bot = await importar('telegram-bridge/bot.js');

  await group('El bot: el pie, #segura, la foto y la consigna', async () => {
    const pie = (t) => bot.pieDeMemoria({ aplicadas: [], rechazadas: [], ...t });
    check('el pie: va a hacer una imagen', pie({ imagenPedida: { texto: 'x' } }).includes('🖼️ va a hacer una imagen'));
    check('el pie: el motivo legible del rechazo', pie({ imagenRechazo: 'hilo-externo' }).includes('🖼️ no hizo la imagen: hilo con contenido externo'));
    check('el pie: foto segura', pie({ fotoSegura: 'marcada' }).includes('🔓 foto segura') && !pie({ fotoSegura: 'marcada' }).includes('era tuya'));
    check('el pie: foto segura reconocida', pie({ fotoSegura: 'reconocida' }).includes('🔓 foto segura (era tuya)'));
    check('el pie: foto segura con orden', pie({ fotoSegura: 'marcada', fotoSeguraOrden: true }).includes('🔓 foto segura · traía texto con forma de orden'));
    check('#segura sale del pie', JSON.stringify(bot.marcaSegura('mirá esto #segura')) === JSON.stringify({ texto: 'mirá esto', segura: true }));
    check('#SEGURA también, y sola deja el texto vacío', bot.marcaSegura('#SEGURA').segura && bot.marcaSegura('#SEGURA').texto === '');
    check('#seguras no es la marca', bot.marcaSegura('#seguras').segura === false);
    for (const [pie, texto] of [['mi gata #segura.', 'mi gata.'], ['#segura, mirá', 'mirá'], ['foto (#segura) linda', 'foto linda'], ['¡#segura!', '¡!']]) {
      const m = bot.marcaSegura(pie);
      check(`#segura con puntuación: ${pie}`, m.segura === true && m.texto === texto && !/segura/i.test(m.texto), JSON.stringify(m));
    }
    check('a#segura no es la marca', bot.marcaSegura('a#segura').segura === false);
    const foto = { ruta: path.join(tmp, 'foto.png') };
    const cfg = config();
    check('fotoDelTurno: marcada', bot.fotoDelTurno({ ...foto, segura: true }, cfg).origen === 'marcada');
    check('fotoDelTurno: reconocida por sha256', bot.fotoDelTurno(foto, cfg, { reconocer: () => ({ tareaId: 't' }) }).origen === 'reconocida');
    check('fotoDelTurno: reconocer_propias apagado → de afuera', bot.fotoDelTurno(foto, config({ reconocer_propias: false }), { reconocer: () => ({}) }).segura === false);
    check('fotoDelTurno: fotos_seguras apagado ignora la marca', bot.fotoDelTurno({ ...foto, segura: true }, config({ fotos_seguras: false })).segura === false);
    check('fotoDelTurno: sin marca ni reconocida → de afuera', bot.fotoDelTurno(foto, cfg, { reconocer: () => null }).segura === false);
    check('puedePedirImagen: no en una reacción', bot.puedePedirImagen({ clave: 'alya', diario: { tipo: 'reaccion' } }, cfg) === false);
    check('puedePedirImagen: no en lo programado', bot.puedePedirImagen({ clave: 'alya', programado: 'p1' }, cfg) === false);
    check('puedePedirImagen: apagadas → no', bot.puedePedirImagen({ clave: 'alya' }, config({ activas: false })) === false);
    check('puedePedirImagen: un turno normal con un proveedor → sí', bot.puedePedirImagen({ clave: 'alya' }, config({ orden: ['comfyui'] })) === true);
  });

  await group('El bot: Telegram, cancelar y capacidades', async () => {
    const enviados = [];
    const api = {
      sendPhoto: async (chat, archivo, extra) => { enviados.push(['photo', chat, extra.caption]); if (api.fallaFoto) throw new Error('too big'); return { message_id: 77 }; },
      sendDocument: async (chat, archivo, extra) => { enviados.push(['doc', chat, extra.caption]); if (api.fallaDoc) throw new Error('no'); return { message_id: 78 }; },
      sendMessage: async (chat, texto) => { enviados.push(['msg', chat, texto]); return { message_id: 79 }; }
    };
    const ref = { bot: 'fake', chat: 5 };
    // salidaPara usa el mapa de bots: se registra uno falso con ese id.
    const envio = bot.crearEnvioImagen(null, 5, { tareaId: 't_x' });
    await envio({ ok: true, n: 1, ruta: path.join(tmp, 'foto.png') });
    check('sin salida (ref nula) no rompe', enviados.length === 0);
    check('imagenDelMensaje sin registrar → null', bot.imagenDelMensaje('fake', 5, 77) === null);
    // Un bot registrado de verdad (sin polling), con su API reemplazada.
    const tg = bot.createBot({ token: '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', allowedUserIds: new Set(['1']) });
    Object.assign(tg.api, api);
    const refTg = { bot: '987654321', chat: 5 };
    await bot.crearEnvioImagen(refTg, 5, { tareaId: 't_tg1' })({ ok: true, n: 2, ruta: path.join(tmp, 'foto.png') });
    check('lista: sendPhoto con el pie 🖼️ n', JSON.stringify(enviados.at(-1)) === JSON.stringify(['photo', 5, '🖼️ 2']));
    check('el message_id queda en el mapa', JSON.stringify(bot.imagenDelMensaje('987654321', 5, 77)) === JSON.stringify({ tareaId: 't_tg1', n: 2 }));
    api.fallaFoto = true;
    await bot.crearEnvioImagen(refTg, 5, { tareaId: 't_tg1' })({ ok: true, n: 3, ruta: path.join(tmp, 'foto.png') });
    check('sendPhoto falla → sendDocument', enviados.at(-1)[0] === 'doc' && bot.imagenDelMensaje('987654321', 5, 78)?.n === 3);
    api.fallaDoc = true;
    await bot.crearEnvioImagen(refTg, 5, { tareaId: 't_tg1' })({ ok: true, n: 4, ruta: path.join(tmp, 'foto.png') });
    check('los dos fallan → el mensaje honesto', enviados.at(-1)[2] === '🖼️ La imagen está hecha y guardada, pero no pude mandarla por Telegram.');
    await bot.crearEnvioImagen(refTg, 5)({ ok: false, n: 1, mensaje: 'El proveedor no responde.' });
    check('un error: «No pude hacer la imagen» con el texto fijo', enviados.at(-1)[2] === '🖼️ No pude hacer la imagen: El proveedor no responde.');

    const cola = { cancelarImagenes: (f) => { cola.ultimo = f; return 2; }, tieneAbiertas: () => true, estadoDeImagenes: () => ({ pendientes: 0, enCurso: 0 }) };
    bot.usarColaImagenesParaTests(cola);
    check('cancelarImagenes delega en la cola', bot.cancelarImagenes({ clave: 'alya' }) === 2 && cola.ultimo.clave === 'alya');
    const t = tareas.crear({ carril: 'alma', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'x' });
    tareas.actualizar(t.id, { estado: 'ok' });
    const r = bot.cancelarTarea(t.id);
    check('cancelarTarea con el turno cerrado e imágenes abiertas → imagen', r.ok && r.accion === 'imagen' && cola.ultimo.tareaId === t.id);
    cola.tieneAbiertas = () => false;
    check('…sin imágenes abiertas sigue siendo 409', bot.cancelarTarea(t.id).codigo === 409);
    bot.usarColaImagenesParaTests(null);

    const cap = (cfg) => bot.capacidadesV2({ leerConfig: () => cfg }).capacidades.imagenes;
    check('capacidades.imagenes: activas y un proveedor → true', cap(config({ orden: ['comfyui'] })) === true);
    check('capacidades.imagenes: apagadas → false (la clave está)', cap(config({ activas: false })) === false);
    check('capacidades.imagenes: solo los remotos → false', cap(config({ orden: ['openai', 'gemini'] })) === false);
    check('capacidades.imagenes: config rota → false', bot.capacidadesV2({ leerConfig: () => { throw new Error('x'); } }).capacidades.imagenes === false);

    const fuente = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8');
    check('/cancel del general acepta imagen', fuente.includes("arg !== 'imagen'") && fuente.includes("if (arg === 'imagen') {"));
    check('/cancel sin argumento corta también las imágenes', fuente.includes('const imagenes = arg ? 0 : cancelarImagenes();'));
    check('el bot de alma: /cancel con sus imágenes y /otra', fuente.includes('const imagenes = cancelarImagenes({ clave });') && fuente.includes("if (comando === 'otra') return comandoOtra(ctx);"));
    check('/queue y /status muestran Imágenes', fuente.includes("lineas.push('*Imágenes*'") && fuente.includes('• *Imágenes:* ${lineaImagenes()}'));
    check('la imagen se encola antes de cerrar la tarea', fuente.indexOf('encolarImagenDelTurno(task, turno, ref);') < fuente.indexOf('marcarTarea(task, cierreDeCharla(turno));'));
    check('el arranque barre las imágenes', fuente.includes('registroTareas.barrerImagenesAlArrancar('));
  });

  // La deuda de S0: /cancel imagen (los dos bots) y /cancel a secas llaman a cancelarImagenes del bot; acá con la cola
  // real y un proveedor que se cuelga hasta que lo aborten.
  await group('/cancel imagen de punta a punta, con la cola real', async () => {
    let colgarse = true;
    const abortados = [];
    const prov = proveedorFalso('comfyui', (op) => (colgarse
      ? new Promise((r) => op.signal.addEventListener('abort', () => { abortados.push(true); r({ ok: false, codigo: 'cancelada' }); }, { once: true }))
      : { ok: true }));
    const colaReal = armarCola({ provs: { comfyui: prov } });
    bot.usarColaImagenesParaTests(colaReal);
    try {
      const a = nuevaTarea(); const b = nuevaTarea();
      colaReal.encolar({ tareaId: a, clave, pedido: 'x' });
      await esperarTicks(10);
      colaReal.encolar({ tareaId: b, clave, pedido: 'y' });
      await esperarTicks(10);
      check('una en curso y una pendiente', JSON.stringify(colaReal.estadoDeImagenes()) === JSON.stringify({ pendientes: 1, enCurso: 1 }));
      const otraAlma = bot.cancelarImagenes({ clave: 'marie' });
      check('el /cancel del bot de otra alma no toca estas', otraAlma === 0 && entrada(a).estado === 'generando');
      const n = bot.cancelarImagenes();
      check('/cancel imagen: las dos quedan canceladas', n === 2 && entrada(a).codigo === 'cancelada' && entrada(b).codigo === 'cancelada');
      await hasta(() => colaReal.estadoDeImagenes().enCurso === 0);
      check('al proveedor en curso le llegó el abort', abortados.length === 1);
      colgarse = false;
      const c = nuevaTarea();
      colaReal.encolar({ tareaId: c, clave, pedido: 'z' });
      await hasta(() => entrada(c).estado !== 'generando');
      check('la cola no queda trabada: la siguiente sale', entrada(c).estado === 'lista');
    } finally {
      bot.usarColaImagenesParaTests(null);
    }
  });

  await group('Auditoría 1: vistas, /otra, la consola v1 y la foto reconocida', async () => {
    // Las vistas: entregadas solo después de un turno que terminó bien, y una vez.
    const archivoV = path.join(tmp, 'vista.png'); fs.writeFileSync(archivoV, PNG);
    indice.actualizar('alya', 't_vista1', 1, () => ({ hilo: 'hv', lista: true, archivo: archivoV, vista: 'un gato' }));
    const incluidas = [{ tareaId: 't_vista1', n: 1 }];
    check('la vista está pendiente', indice.vistasPendientes('alya', 'hv').length === 1);
    bot.entregarVistas('alya', { ok: false, cancelled: true, vistasIncluidas: incluidas });
    check('un turno cancelado no la entrega', indice.vistasPendientes('alya', 'hv').length === 1);
    bot.entregarVistas('alya', { ok: true, vistasIncluidas: incluidas });
    check('un turno ok la entrega: el siguiente ya no la recibe', indice.vistasPendientes('alya', 'hv').length === 0);
    indice.actualizar('alya', 't_vista2', 1, () => ({ hilo: 'hw', lista: true, archivo: archivoV, vista: null, vistaEstado: 'pendiente', vistaDesde: new Date().toISOString() }));
    check('con la mirada en curso, el turno siguiente no la toma', indice.vistasPendientes('alya', 'hw').length === 0);
    check('una mirada colgada más de 5 min sale (sin vista)', indice.vistasPendientes('alya', 'hw', process.env, Date.now() + 6 * 60 * 1000).length === 1);
    indice.actualizar('alya', 't_vista2', 1, (p) => ({ ...p, vista: 'un perro', vistaEstado: 'lista' }));
    check('terminada la mirada, sale con su descripción', indice.vistasPendientes('alya', 'hw')[0]?.vista === 'un perro');
    // Normalizado: el CI corre en Windows y hace checkout con CRLF.
    const fuenteBot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8').replace(/\r\n/g, '\n');
    check('el cierre de la charla llama a entregarVistas', fuenteBot.includes('      entregarVistas(task.clave, turno);\n'));

    // /otra: el mapa por bot y chat.
    const pedidas = [];
    let respuestaOtra = { ok: true, n: 3 };
    bot.usarColaImagenesParaTests({ otra: (tareaId, n) => { pedidas.push([tareaId, n]); return respuestaOtra; } });
    const ctxOtra = (chat, mid) => { const r = []; return { r, chat: { id: chat }, me: { id: 987654321 }, message: { reply_to_message: mid ? { message_id: mid } : undefined }, reply: async (t) => { r.push(t); } }; };
    const c1 = ctxOtra(5, 77); await bot.comandoOtra(c1);
    check('/otra respondiendo a la foto pide otra de esa imagen', JSON.stringify(pedidas) === JSON.stringify([['t_tg1', 2]]) && c1.r[0] === '🖼️ Hago otra versión.');
    const c2 = ctxOtra(6, 77); await bot.comandoOtra(c2);
    check('otro chat con el mismo message_id no la encuentra', pedidas.length === 1 && c2.r[0].startsWith('No sé de qué imagen'));
    const c3 = ctxOtra(5, null); await bot.comandoOtra(c3);
    check('/otra sin responder a nada explica cómo', c3.r[0] === 'Respondé con /otra a una imagen que mandé.');
    respuestaOtra = { ok: false, codigo: 'apagada' };
    const c4 = ctxOtra(5, 77); await bot.comandoOtra(c4);
    check('/otra con otra versión apagada lo dice', c4.r[0] === '🖼️ Otra versión está apagada (Ajustes → Imágenes).');
    bot.usarColaImagenesParaTests(null);

    // La consola web v1 no muestra imágenes: ahí no se ofrecen.
    const { CHAT_WEB_LOCAL, CHAT_WEB_TERMINAL } = await importar('telegram-bridge/web/canal.js');
    const cfgUno = config({ orden: ['comfyui'] });
    check('puedePedirImagen: la consola v1 → no', bot.puedePedirImagen({ clave: 'alya', chatId: CHAT_WEB_LOCAL }, cfgUno) === false);
    check('puedePedirImagen: la terminal → sí', bot.puedePedirImagen({ clave: 'alya', chatId: CHAT_WEB_TERMINAL }, cfgUno) === true);
    check('puedePedirImagen: Telegram → sí', bot.puedePedirImagen({ clave: 'alya', chatId: 5 }, cfgUno) === true);

    // La foto reconocida: el alma no oye que el usuario la marcó.
    const { mensajeConFoto } = require('../mcp-server/almas/charla.js');
    const desc = { ok: true, texto: 'un gato', orden: false };
    check('foto marcada: «la marcó como segura»', mensajeConFoto(desc, 'hola', { segura: true }).includes('la marcó como segura'));
    const rec = mensajeConFoto(desc, 'hola', { segura: true, reconocida: true });
    check('foto reconocida: «una imagen que hiciste vos», sin «la marcó»', rec.includes('una imagen que hiciste vos') && !rec.includes('la marcó'));
  });

  // --------------------------------------------------------------- la API v2
  const { memoriaDe, turnoDe, imagenesDe, crearProductoresV2 } = await importar('telegram-bridge/web/v2/productores.js');
  const esquema = await importar('telegram-bridge/web/v2/esquema.js');
  const { rutasMutacionV2 } = await importar('telegram-bridge/web/v2/mutaciones.js');

  await group('API v2: la proyección, el evento y el contrato', async () => {
    const lista = imagenesDe([{ n: 1, estado: 'lista', prompt: 'p'.repeat(1000), negativo: 'n'.repeat(400), mensaje: 'm'.repeat(300), archivo: '/x', semilla: 3, pedido: 'secreto' }, { n: 2, estado: 'nada' }]);
    check('imagenesDe: sin rutas ni campos fuera del esquema', lista.length === 1 && lista[0].archivo === undefined && lista[0].semilla === undefined && lista[0].pedido === undefined);
    check('imagenesDe: los topes (900, 300, 200)', lista[0].prompt.length === 900 && lista[0].negativo.length === 300 && lista[0].mensaje.length === 200);
    const m = memoriaDe({ recordo: 1, imagen: { pedida: 'un gato', rechazo: 'raro' }, fotoSegura: 'marcada' });
    check('memoriaDe: imagen y fotoSegura (un rechazo fuera de lista → null)', m.imagen.pedida === 'un gato' && m.imagen.rechazo === null && m.fotoSegura === 'marcada');
    check('memoriaDe: fotoSegura fuera de lista se descarta', memoriaDe({ fotoSegura: 'otra' }) === null);
    const tarea = { id: 't_abcd1234', estado: 'ok', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'hola', creada: '2026-01-01T00:00:00Z', memoria: { recordo: 0, imagen: { pedida: 'x', rechazo: null }, fotoSegura: 'reconocida' }, imagenes: [{ n: 1, estado: 'generando', ancho: 1024, alto: 1024, intento: 1, creada: '2026-01-01T00:00:00Z', terminada: null, codigo: null, mensaje: null }] };
    const turno = turnoDe(tarea, { recorte: '\n…' });
    const contrato = esquema.cargarContrato();
    const errores = esquema.validar(contrato, 'turno', turno);
    check('el turno con imagenes valida contra el contrato', turno.imagenes && errores.length === 0, errores.join('; '));
    check('…y como evento turno.imagen', esquema.validar(contrato, 'evento:turno.imagen', turno).length === 0);
    check('una entrada con un campo de más no valida', esquema.validar(contrato, 'turno', { ...turno, imagenes: [{ ...turno.imagenes[0], archivo: '/x' }] }).length > 0);
    check('capacidades con imagenes valida', esquema.validar(contrato, 'capacidades', bot.capacidadesV2({ leerConfig: () => config() })).length === 0);
    check('el contrato sigue en 2.0', contrato.version === '2.0');
    check('el contrato tiene capacidades.imagenes y el evento turno.imagen', contrato.agregados.capacidades.properties.capacidades.properties.imagenes.type === 'boolean' && contrato.eventos['turno.imagen'] && contrato.agregados.evento.properties.tipo.enum.includes('turno.imagen'));

    const publicados = [];
    let suscriptor = null;
    const productores = crearProductoresV2({ almacen: { publicar: (tema, tipo, datos) => publicados.push({ tema, tipo, datos }), hayInteres: () => false, alCambiarSuscriptores: () => () => {} }, registro: { suscribir: (fn) => { suscriptor = fn; return () => {}; }, obtener: () => null }, recorte: '\n…' });
    suscriptor(tarea, { cambioImagen: true, cambioEstado: false });
    check('cambioImagen publica turno.imagen con el turno entero (también cerrado)', publicados.some((p) => p.tipo === 'turno.imagen' && p.tema === 'sujeto:alya' && p.datos.imagenes[0].estado === 'generando'));
    productores.cerrar();
  });

  await group('API v2: las rutas de una imagen', async () => {
    const t = tareas.crear({ carril: 'alma', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'x' });
    const pedidos = [];
    const imagenes = {
      bytesDe: (id, n) => (n === 1 ? { ok: true, bytes: PNG, tipo: 'image/png' } : { ok: false }),
      reintentar: (id, n) => { pedidos.push(['re', id, n]); return n === 1 ? { ok: true, n } : { ok: false, codigo: 'foto-perdida' }; },
      otra: (id, n) => { pedidos.push(['otra', id, n]); return { ok: false, codigo: 'tope-turno' }; },
      cancelar: (id, n) => (n === 1 ? 1 : 0),
      probar: async (url) => ({ ok: true, codigo: 'ok', mensaje: 'ComfyUI responde.', url })
    };
    const idem = { porId: () => null };
    const rutas = rutasMutacionV2({ nucleo: {}, cola: {}, ctx: {}, chatTerminal: 'x', registro: tareas, idem, recorte: '\n…', imagenes });
    const llamar = async (metodo, url, cuerpo = {}) => {
      const u = new URL(`http://x${url}`);
      const r = rutas.find((x) => x.metodo === metodo && x.patron.test(u.pathname));
      if (!r) return null;
      const p = r.patron.exec(u.pathname).slice(1).map(decodeURIComponent);
      return r.fn({ p, cuerpo, url: u });
    };
    const bytes = await llamar('GET', `/api/v2/turnos/${t.id}/imagenes/1`);
    check('GET bytes: binario con su tipo', Buffer.isBuffer(bytes.binario) && bytes.tipo === 'image/png');
    check('GET de una que no está lista: 404', (await llamar('GET', `/api/v2/turnos/${t.id}/imagenes/2`)).codigo === 404);
    check('n inválido: 400', (await llamar('GET', `/api/v2/turnos/${t.id}/imagenes/0`)).codigo === 400);
    check('turno que no está: 410', (await llamar('GET', '/api/v2/turnos/t_noexiste1/imagenes/1')).codigo === 410);
    check(':reintentar ok', (await llamar('POST', `/api/v2/turnos/${t.id}/imagenes/1:reintentar`)).ok === true);
    const perdida = await llamar('POST', `/api/v2/turnos/${t.id}/imagenes/2:reintentar`);
    check(':reintentar sin la foto: 409 con el texto', perdida.codigo === 409 && perdida.error === 'La foto ya no está; mandala de nuevo.');
    const tope = await llamar('POST', `/api/v2/turnos/${t.id}/imagenes/1:otra`);
    check(':otra con 4 entradas: 409', tope.codigo === 409 && tope.motivo === 'tope-turno');
    check(':cancelar una: ok imagen', (await llamar('POST', `/api/v2/turnos/${t.id}/imagenes/1:cancelar`)).accion === 'imagen');
    check(':cancelar una que no está: 409', (await llamar('POST', `/api/v2/turnos/${t.id}/imagenes/2:cancelar`)).codigo === 409);
    const prueba = await llamar('POST', '/api/v2/imagenes:probar', { url: 'http://127.0.0.1:9999' });
    check('imagenes:probar pasa la url del cuerpo', prueba.ok && prueba.url === 'http://127.0.0.1:9999');
    check('imagenes:probar con url que no es texto: 400', (await llamar('POST', '/api/v2/imagenes:probar', { url: 5 })).codigo === 400);
    const sinImagenes = rutasMutacionV2({ nucleo: {}, cola: {}, ctx: {}, chatTerminal: 'x', registro: tareas, idem, recorte: '\n…' });
    const r503 = sinImagenes.find((x) => x.patron.test('/api/v2/imagenes:probar'));
    check('sin imágenes en el proceso: 503', (await r503.fn({ p: [], cuerpo: {} })).codigo === 503);
  });

  await group('API v2: la foto con segura', async () => {
    {
      const { crearNucleoWeb: crearN } = await importar('telegram-bridge/web/nucleo.js');
      const { crearIdempotencia } = await importar('telegram-bridge/web/v2/idempotencia.js');
      const real = crearN({ canal: {}, bot: { almasDisponibles: () => [{ clave: 'alya', voz: 'Alya' }] } });
      const despachos = [];
      const nucleoFoto = {
        sujetos: async () => ({ almas: [{ clave: 'alya', voz: 'Alya' }], agentes: [] }),
        validarFoto: (c, b) => real.validarFoto(c, b),
        guardarFoto: () => ({ ok: true, ruta: path.join(tmp, 'foto.png') })
      };
      const colaFoto = { dispatchCharla: async (ctx, o) => { const t = tareas.crear({ carril: 'alma', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'x' }); despachos.push(o); o.alEncolar(t.id); return { ok: true }; } };
      const idemFoto = crearIdempotencia({ registro: tareas });
      const rutasFoto = rutasMutacionV2({ nucleo: nucleoFoto, cola: colaFoto, ctx: {}, chatTerminal: 'x', registro: tareas, idem: idemFoto, recorte: '\n…' });
      const rutaFoto = rutasFoto.find((x) => x.metodo === 'POST' && x.patron.test('/api/v2/sujetos/alya/fotos'));
      const mandar = (cuerpo) => rutaFoto.fn({ p: ['alya'], cuerpo });
      const b64 = PNG.toString('base64');
      const idA = '11111111-1111-4111-8111-111111111111';
      const r1 = await mandar({ idCliente: idA, base64: b64, texto: 'mi gata', segura: true });
      check('POST fotos con segura:true → la charla recibe imagen.segura', r1.ok !== false && despachos[0]?.imagen?.segura === true && despachos[0].imagen.ruta === path.join(tmp, 'foto.png'), JSON.stringify(r1));
      await mandar({ idCliente: idA, base64: b64, texto: 'mi gata', segura: true });
      check('el reenvío con el mismo idCliente no despacha otra vez', despachos.length === 1);
      await mandar({ idCliente: '22222222-2222-4222-8222-222222222222', base64: b64 });
      check('sin segura → imagen.segura false', despachos[1]?.imagen?.segura === false);
      const malo = await mandar({ idCliente: '33333333-3333-4333-8333-333333333333', base64: b64, segura: 'si' });
      check('segura que no es booleana → 400, sin despachar', malo.codigo === 400 && despachos.length === 2);
      // De punta a punta: lo que la ruta despacha es lo que el turno pasa por fotoDelTurno, con la config de ese momento.
      fs.writeFileSync(path.join(tmp, 'foto.png'), PNG);
      const sinReconocer = { reconocer: () => null };
      check('ruta → turno: marcada con fotos_seguras', bot.fotoDelTurno(despachos[0].imagen, config(), sinReconocer).origen === 'marcada');
      check('ruta → turno: fotos_seguras apagada → de afuera', bot.fotoDelTurno(despachos[0].imagen, config({ fotos_seguras: false }), sinReconocer).segura === false);
      check('ruta → turno: sin la marca, de afuera', bot.fotoDelTurno(despachos[1].imagen, config(), sinReconocer).segura === false);
      check('ruta → turno: sin la marca pero con los bytes propios, reconocida', bot.fotoDelTurno(despachos[1].imagen, config(), { reconocer: () => ({ tareaId: 't' }) }).origen === 'reconocida');
    }
    const nucleoFuente = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'web', 'nucleo.js'), 'utf8');
    check('validarFoto acepta segura (booleana)', nucleoFuente.includes("if (segura !== undefined && typeof segura !== 'boolean') return error(400, 'segura tiene que ser true o false.');"));
    const mut = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'web', 'v2', 'mutaciones.js'), 'utf8');
    check('la ruta de fotos pasa segura a la charla', mut.includes('imagen: { ruta, segura: v.segura === true }'));
    const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
    let cortes = 0;
    const nucleo = crearNucleoWeb({ canal: {}, bot: { cancelarCarriles: () => ({ cancelados: [] }), cancelarImagenes: () => { cortes++; return 1; } } });
    check('Frenar todo corta las imágenes', nucleo.cancelar().imagenes === 1 && cortes === 1);
    check('Frenar las charlas corta las imágenes', nucleo.cancelar('alma').imagenes === 1 && cortes === 2);
    check('Frenar los casts no las toca', !('imagenes' in nucleo.cancelar('cast')) && cortes === 2);
    check('guardar Ajustes con imagenes llama al gancho', nucleoFuente.includes('bot.alGuardarImagenes()'));
  });

  await group('La consola web v1: la pestaña Imágenes', async () => {
    const vista = await importar('telegram-bridge/web/public/ui/vista-ajustes.js');
    const d = { versiones: { imagenes: 'v-img' }, almas: [{ clave: 'alya', voz: 'Alya' }], identidades: {}, voz: {}, motores: {}, general: {}, imagenes: { ...config(), por_alma: {} } };
    vista.datos.value = d;
    vista.borrador.value = { identidades: {}, voz: {}, motores: {}, general: {}, imagenes: { activas: true, orden: [...d.imagenes.orden], por_alma: {} } };
    check('sin cambios, nada que guardar', vista.cambiadas.value.length === 0);
    vista.borrador.value = { ...vista.borrador.value, imagenes: { activas: false, orden: ['antigravity'], por_alma: { alya: false } } };
    const pedido = vista.cuerpoDeGuardado();
    check('guardar manda imagenes con su versión, activas, orden y por_alma', JSON.stringify(pedido.imagenes) === JSON.stringify({ versionSeccion: 'v-img', activas: false, orden: ['antigravity'], por_alma: { alya: false } }), JSON.stringify(pedido));
    check('solo esa sección', Object.keys(pedido).length === 1);
    const fuente = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'web', 'public', 'ui', 'vista-ajustes.js'), 'utf8');
    check('la pestaña está en SECCIONES y EDITABLES', fuente.includes("['imagenes', 'Imágenes']") && fuente.includes("const EDITABLES = ['identidades', 'voz', 'motores', 'imagenes', 'general'];"));
    check('se puede quitar y agregar un proveedor', fuente.includes('aria-label=${`Quitar ') && fuente.includes('+ Agregar ${NOMBRE_PROVEEDOR_IMAGEN[p] || p}'));
  });

  report();
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});
