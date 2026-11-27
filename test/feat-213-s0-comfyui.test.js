/**
 * FEAT-213 S0 — El proceso de ComfyUI: la carpeta, el entorno, las flags de su versión, el registro y, en Windows, el guardián de
 * verdad con un ComfyUI de mentira (un `main.py` que corre con node): levantar, esperar, morir antes, un solo arranque, adoptar,
 * otra configuración, el pid de otro, uno ajeno, la cola, forzar, la inactividad y un arranque que nunca responde.
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const raiz = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'feat213 comfy & co-')));
process.env.LAGRANGE_COMFYUI_DIR = path.join(raiz, 'estado por defecto');
process.env.PRUEBA_DE_TOKEN = 'secreto-del-daemon';
process.env.DEEPSEEK_API_KEY = 'secreto-del-daemon';
process.env.CUDA_API_KEY = 'secreto-del-daemon';
process.env.CUDA_VISIBLE_DEVICES = '0';

const { check, group, report } = require('./lib/assert');
const px = require('../mcp-server/imagenes/comfyui-proceso.js');
const F = require('../mcp-server/imagenes/comfyui-flags.js');

const WIN = process.platform === 'win32';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const hasta = async (cond, ms = 15000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (await cond()) return true; await esperar(60); } return cond(); };
const puertoLibre = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const AYUDA = `usage: main.py [-h] [--listen [IP]] [--port PORT] [--auto-launch]
               [--disable-auto-launch] [--cuda-malloc |
               --disable-cuda-malloc] [--preview-method [none,auto,latent2rgb]]
               [--cache-ram [GB ...] | --cache-lru CACHE_LRU | --cache-none]
               [--gpu-only | --highvram | --lowvram | --cpu]
               [--reserve-vram RESERVE_VRAM] [--fast [FAST ...]]
               [--hashing {md5,sha1}] [--front-end-root FRONT_END_ROOT]
               [--quick-test-for-ci]

options:
  -h, --help            show this help message and exit
  --listen [IP]         Specify the IP address to listen on (default:
                        127.0.0.1).
  --port PORT           Set the listen port.
  --auto-launch         Launch.
  --disable-auto-launch
                        Disable auto launching the browser.
  --cuda-malloc         Enable.
  --disable-cuda-malloc
                        Disable.
  --preview-method [none,auto,latent2rgb]
                        Default preview method.
  --cache-ram [GB ...]  RAM pressure.
  --cache-lru CACHE_LRU
                        LRU caching.
  --cache-none          None.
  --gpu-only            Store and run everything
                        on the GPU.
  --highvram            High.
  --lowvram             Low.
  --cpu                 CPU.
  --reserve-vram RESERVE_VRAM
                        Reserve.
  --fast [FAST ...]     Fast.
  --hashing {md5,sha1}  Hash.
  --front-end-root FRONT_END_ROOT
                        Path.
  --quick-test-for-ci   CI.
`;

// El ComfyUI de mentira: lo corre node con el nombre de Python.
const MAIN = `
const fs = require('fs'), http = require('http'), path = require('path');
if (process.argv.includes('--help')) { process.stdout.write(fs.readFileSync(path.join(__dirname, 'ayuda.txt'), 'utf8')); process.exit(0); }
const modo = () => { try { return fs.readFileSync(path.join(__dirname, 'modo.txt'), 'utf8').trim(); } catch { return ''; } };
fs.writeFileSync(path.join(__dirname, 'visto.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid, veces: (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'visto.json'))).veces + 1; } catch { return 1; } })() }));
console.log('cargando, token=hf_abcdefghijklmnop123');
if (modo() === 'muere') { console.error('RuntimeError: no entra en la GPU'); process.exit(3); }
const arg = (n) => process.argv.find((a) => a.startsWith(n + '=')).slice(n.length + 1);
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0]; const j = (o) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
  if (u === '/system_stats') return j({ system: { comfyui_version: '0.0' }, devices: [] });
  if (u === '/queue') return j({ queue_running: modo() === 'ocupado' ? [[0, 'x']] : [], queue_pending: [] });
  if (u === '/history') return j(modo() === 'usando' ? { ['p' + Date.now()]: {} } : {});
  r.statusCode = 404; r.end();
});
if (modo() === 'nunca') setInterval(() => {}, 1000);
else setTimeout(() => srv.listen(Number(arg('--port')), arg('--listen'), () => console.log('To see the GUI go to')), modo() === 'lento' ? 2500 : 50);
`;

/** Una instalación de mentira, con entorno propio. */
function instalacion(nombre, { venv = '.venv' } = {}) {
  const dir = path.join(raiz, nombre);
  fs.mkdirSync(path.join(dir, venv, 'Scripts'), { recursive: true });
  const py = path.join(dir, venv, 'Scripts', 'python.exe');
  try { fs.linkSync(process.execPath, py); } catch { fs.copyFileSync(process.execPath, py); }
  fs.writeFileSync(path.join(dir, 'main.py'), MAIN);
  fs.writeFileSync(path.join(dir, 'ayuda.txt'), AYUDA);
  return dir;
}
const configDe = (carpeta, puerto, extra = {}) => ({ comfyui: { url: `http://127.0.0.1:${puerto}`, arranque: { carpeta, automatico: true, apagar_min: 20, espera_s: 20, flags: [], ...extra } } });

async function main() {
  await group('La carpeta', () => {
    const inst = px.resolverInstalacion(instalacion('con entorno'));
    check('con .venv', inst.ok && inst.tipo === 'entorno' && inst.extra.length === 0);
    check('con venv', px.resolverInstalacion(instalacion('con venv', { venv: 'venv' })).ok);
    const p = path.join(raiz, 'portable'); fs.mkdirSync(path.join(p, 'python_embeded'), { recursive: true }); fs.mkdirSync(path.join(p, 'ComfyUI'));
    fs.writeFileSync(path.join(p, 'python_embeded', 'python.exe'), ''); fs.writeFileSync(path.join(p, 'ComfyUI', 'main.py'), '');
    const port = px.resolverInstalacion(p);
    check('portable: -s y --windows-standalone-build, y arranca en la raíz', port.ok && port.tipo === 'portable' && port.args[0] === '-s' && port.extra[0] === '--windows-standalone-build' && port.cwd === p);
    const vacia = path.join(raiz, 'vacia'); fs.mkdirSync(vacia);
    const nada = px.resolverInstalacion(vacia);
    check('sin nada: lo que buscó, sin la ruta', !nada.ok && /python_embeded/.test(nada.motivo) && !nada.motivo.includes(raiz));
    check('una que no existe, sin la ruta', !px.resolverInstalacion(path.join(raiz, 'no-existe')).ok && !px.resolverInstalacion(path.join(raiz, 'no-existe')).motivo.includes('no-existe') && !px.resolverInstalacion(null).ok);
    const sale = path.join(raiz, 'sale'); fs.mkdirSync(sale); fs.writeFileSync(path.join(sale, 'main.py'), '');
    let hay = true;
    try { fs.symlinkSync(path.join(raiz, 'con entorno', '.venv'), path.join(sale, '.venv'), 'junction'); } catch { hay = false; }
    check('un enlace que sale de la carpeta', !hay || (!px.resolverInstalacion(sale).ok && /fuera/.test(px.resolverInstalacion(sale).motivo)));
  });

  await group('La red, el entorno y los argumentos', () => {
    check('127.0.0.1, localhost y [::1]', px.escucha('http://127.0.0.1:8188').host === '127.0.0.1' && px.escucha('http://localhost:8188').salud === 'http://127.0.0.1:8188' && px.escucha('http://[::1]:8188').host === '::1' && px.escucha('http://[::1]:8188').salud === 'http://[::1]:8188');
    check('https y otra máquina no', !px.escucha('https://127.0.0.1:8188').ok && !px.escucha('http://10.0.0.1:8188').ok && !px.escucha('x').ok);
    const env = px.entornoLimpio({ Path: 'a', SystemRoot: 'b', DEEPSEEK_API_KEY: 'x', CUDA_API_KEY: 'x', HF_TOKEN: 'x', HF_HOME: 'c', CUDA_VISIBLE_DEVICES: '0', TELEGRAM_BOT_TOKEN: 'x', 'ProgramFiles(x86)': 'd', ProgramFiles: 'e', OTRA: 'x', NODE_OPTIONS: 'x', PYTHONPATH: 'x', PROCESSOR_LEVEL: '6' });
    check('la lista blanca, sin secretos', JSON.stringify(Object.keys(env).sort()) === JSON.stringify(['CUDA_VISIBLE_DEVICES', 'HF_HOME', 'PROCESSOR_LEVEL', 'PYTHONIOENCODING', 'PYTHONUNBUFFERED', 'Path', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot'].sort()), Object.keys(env).join());
    const cat = F.parsearAyuda(AYUDA);
    const por = Object.fromEntries(cat.map((f) => [f.flag, f]));
    check('la ayuda: con valor, sin valor, opcional y con opciones', por['--lowvram'].valor === 'no' && por['--reserve-vram'].valor === 'si' && por['--fast'].valor === 'opcional' && por['--preview-method'].opciones.join() === 'none,auto,latent2rgb' && por['--hashing'].opciones.join() === 'md5,sha1');
    check('…los grupos y la ayuda entera', por['--lowvram'].grupo === por['--cpu'].grupo && por['--lowvram'].grupo !== por['--cache-lru'].grupo && por['--cache-ram'].grupo === por['--cache-lru'].grupo && por['--reserve-vram'].grupo === null && por['--gpu-only'].ayuda === 'Store and run everything on the GPU.');
    check('las ofrecidas, sin las prohibidas', !F.ofrecidas(cat).some((f) => ['--listen', '--port', '--front-end-root', '--quick-test-for-ci', '--auto-launch', '--help'].includes(f.flag)) && F.ofrecidas(cat).some((f) => f.flag === '--cpu'));
    const vale = (l) => F.validarContra(F.validarForma(l).flags, cat);
    check('contra su versión', vale([{ flag: '--lowvram' }, { flag: '--reserve-vram', valor: '1' }]).ok && !vale([{ flag: '--lowvram' }, { flag: '--cpu' }]).ok && !vale([{ flag: '--lis', valor: '0.0.0.0' }]).ok && !vale([{ flag: '--lowvram', valor: '1' }]).ok && !vale([{ flag: '--reserve-vram' }]).ok && !vale([{ flag: '--preview-method', valor: 'raro' }]).ok && vale([{ flag: '--fast' }]).ok && vale([{ flag: '--fast', valor: 'x' }]).ok);
    const inst = { args: ['-s'], main: 'M', extra: ['--windows-standalone-build'] };
    const r = px.armarArgs({ inst, donde: px.escucha('http://localhost:8188'), flags: [{ flag: '--cpu', valor: null }, { flag: '--ya-no-esta', valor: 'x' }, { flag: '--cache-lru', valor: '5" --listen=0.0.0.0' }], catalogo: cat });
    check('el argv: una que desapareció se saltea, un valor es un solo argumento y la red va al final', JSON.stringify(r.args) === JSON.stringify(['-s', 'M', '--windows-standalone-build', '--cpu', '--cache-lru=5" --listen=0.0.0.0', '--disable-auto-launch', '--listen=127.0.0.1', '--port=8188']) && r.avisos.length === 1 && /ya-no-esta/.test(r.avisos[0]), JSON.stringify(r));
    check('sin poder leer su ayuda: ninguna flag, con aviso', px.armarArgs({ inst, donde: px.escucha('http://127.0.0.1:1'), flags: [{ flag: '--cpu', valor: null }], catalogo: null }).args.length === 5);
    check('la red del pedido', px.redEsperada(['x', '--listen=127.0.0.1', '--port=8188'], 'http://127.0.0.1:8188') && !px.redEsperada(['--listen=127.0.0.1', '--port=8188', '--listen=0.0.0.0'], 'http://127.0.0.1:8188') && !px.redEsperada(null, 'http://127.0.0.1:8188'));
    check('una ayuda que no es argparse', F.parsearAyuda('Traceback…').length === 0);
  });

  await group('El registro', () => {
    const ruta = path.join(raiz, 'x.log');
    fs.writeFileSync(ruta, ['x'.repeat(10), 'HF_TOKEN=hf_abcdefghijklmnop', 'Authorization: Bearer abcdef123456789', 'GET https://x.com/a?token=abc123456&b=1', 'https://yo:miclave@x.com/', '{"api_key": "AKLJSDLKJ"}', 'sk-no', 'C:\\py\\python.exe -s ComfyUI\\main.py --windows-standalone-build', "argv: ['--listen=127.0.0.1']", '\u001b[32mverde\u001b[0m', 'Bearer eyJhbGciOiJIUzI1', 'AIzaSyA1234567890abcdefghij', ''].join('\n'));
    const l = px.ultimasLineas(ruta, { limpiar: (t) => t.replace('sk-no', '[sk]') });
    const todo = l.join('\n');
    check('sin credenciales de nadie', !/hf_abc|abcdef123|abc123456|miclave|AKLJ|eyJhb|AIzaSy/.test(todo), todo);
    check('sin la línea de comandos ni colores, y con lo del proceso', !/main\.py|--listen/.test(todo) && l.includes('verde') && l.includes('[sk]') && l.includes('x'.repeat(10)));
    fs.writeFileSync(ruta, Array.from({ length: 400 }, (_, i) => `linea ${i}`).join('\n'));
    check('las últimas 100', px.ultimasLineas(ruta).length === 100 && px.ultimasLineas(ruta).at(-1) === 'linea 399');
    fs.writeFileSync(ruta, `${'a'.repeat(300 * 1024)}hf_abcdefghijklmnop\nfin\n`);
    check('una línea cortada por el tope no sale a medias', px.ultimasLineas(ruta).join() === 'fin');
    check('sin log, nada', px.ultimasLineas(path.join(raiz, 'no.log')).length === 0);
  });

  await group('Responde, no responde u otro programa', async () => {
    const r = (f) => px.responde('http://127.0.0.1:1', { fetchImpl: f });
    const j = (o, ok = true) => async () => ({ ok, json: async () => o });
    check('ok', await r(j({ system: {}, devices: [] })) === 'ok');
    check('otro programa', await r(j({ hola: 1 })) === 'otro-programa' && await r(j({}, false)) === 'otro-programa' && await r(async () => ({ ok: true, json: async () => { throw new Error('html'); } })) === 'otro-programa');
    check('no responde', await r(async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }) === 'no-responde');
    check('ocupado: aceptó y no contestó', await r(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }) === 'ocupado');
    const p = px.crearProceso({ fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } });
    check('para la cola, uno ocupado sirve', await p.comprobar(configDe(null, 1)) === 'ok');
    const deUrl = []; const pl = px.crearProceso({ fetchImpl: async (u) => { deUrl.push(u); return { ok: true, json: async () => ({ system: {}, devices: [] }) }; } });
    await pl.comprobar({ comfyui: { url: 'http://localhost:8188', arranque: {} } });
    check('con localhost se pregunta en 127.0.0.1', deUrl[0] === 'http://127.0.0.1:8188/system_stats');
    const ocu = px.crearProceso({ plataforma: 'win32', lanzar: async () => { throw new Error('no tenía que lanzar'); }, fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } });
    const co = configDe(instalacion('ocupada'), 1);
    check('uno ajeno ocupado está encendido, y no se lanza un segundo', (await ocu.estado(co)).estado === 'encendido' && (await ocu.levantar(co, { manual: true })).ok === true);
    const otroSo = px.crearProceso({ plataforma: 'linux', fetchImpl: async () => { throw new TypeError('x'); } });
    check('fuera de Windows no se levanta', otroSo.levantar(configDe('/x', 1)) === null && (await otroSo.levantar(configDe('/x', 1), { manual: true })).ok === false && (await otroSo.estado(configDe('/x', 1))).sePuede === false);
  });

  if (!WIN) { report(); return; }

  // ------------------------------------------------------------- el guardián de verdad
  let n = 0;
  const TIEMPOS = { LAGRANGE_COMFYUI_CICLO_MS: '100', LAGRANGE_COMFYUI_USO_MS: '300', LAGRANGE_COMFYUI_MINUTO_MS: '1000', LAGRANGE_COMFYUI_ARRANQUE_MS: '4000' };
  const guardianes = [];
  const montar = async (nombre, { modo = '', extra = {} } = {}) => {
    const carpeta = instalacion(`${nombre} & co`);
    fs.writeFileSync(path.join(carpeta, 'modo.txt'), modo);
    const dir = path.join(raiz, `estado ${n++}`);
    const config = configDe(carpeta, await puertoLibre(), extra);
    const logs = [];
    // Sin el CIM (lo prueba la máquina): el guardián se lanza directo, con el mismo archivo de pedido.
    const lanzar = async ({ nodo, keeper, pedido }) => { const h = spawn(nodo, [keeper, pedido], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...TIEMPOS } }); h.unref(); guardianes.push(h.pid); };
    const crear = (x = {}) => px.crearProceso({ dir, lanzar, log: (l) => logs.push(l), limpiar: (t) => t.split(raiz).join('<ruta>'), tiempos: { sondeo: 100, ...(x.tiempos || {}) }, ...x });
    const visto = () => { try { return JSON.parse(fs.readFileSync(path.join(carpeta, 'visto.json'), 'utf8')); } catch { return null; } };
    const modoDe = (m) => fs.writeFileSync(path.join(carpeta, 'modo.txt'), m);
    return { carpeta, dir, config, logs, crear, p: crear(), visto, modoDe };
  };

  await group('Levantar, el entorno del hijo y apagar', async () => {
    const m = await montar('uno', { extra: { flags: [{ flag: '--lowvram', valor: null }, { flag: '--reserve-vram', valor: '1.5' }] } });
    check('apagado, se puede', (await m.p.estado(m.config)).estado === 'apagado' && (await m.p.estado(m.config)).sePuede === true);
    let respondio = 0;
    const p = m.crear({ alResponder: () => { respondio++; } });
    const a = p.levantar(m.config); const b = p.levantar(m.config);
    check('dos pedidos, un solo arranque', a === b);
    const r = await a;
    check('levanta', r.ok === true && respondio === 1, JSON.stringify([r, m.logs]));
    const v = m.visto();
    check('una sola vez, con sus flags y la red', v.veces === 1 && v.argv.join(' ') === `--lowvram --reserve-vram=1.5 --disable-auto-launch --listen=127.0.0.1 --port=${new URL(m.config.comfyui.url).port}`, v.argv.join(' '));
    check('el entorno del hijo, sin secretos', !JSON.stringify(v.env).includes('secreto-del-daemon') && v.env.CUDA_VISIBLE_DEVICES === '0');
    check('corre en su carpeta', v.cwd === m.carpeta);
    await hasta(async () => px.leerJson(p.rutas.estado).fase === 'encendido');
    const e = await p.estado(m.config);
    check('encendido y nuestro', e.estado === 'encendido' && e.nuestro && !e.otraConfiguracion && e.cola === 0 && e.desde);
    check('nada del estado muestra rutas', !JSON.stringify(e).includes(raiz));
    check('levantar de nuevo no lanza otro', (await p.levantar(m.config)).ok === true && m.visto().veces === 1);
    check('el registro, sin el token', p.registro().some((l) => /cargando/.test(l)) && !p.registro().join().includes('hf_abc'));
    check('los pedidos no quedan en el disco', !fs.readdirSync(m.dir).some((f) => f.startsWith('pedido-')));
    // Otra configuración.
    const otra = { comfyui: { ...m.config.comfyui, url: `http://127.0.0.1:${await puertoLibre()}` } };
    const eo = await p.estado(otra);
    check('con otra url: hay uno con otra configuración', eo.estado === 'apagado' && eo.nuestro && eo.otraConfiguracion && /otra configuración/.test(eo.mensaje));
    check('…y no levanta un segundo', (await p.levantar(otra, { manual: true })).ok === false && m.visto().veces === 1);
    // La cola.
    m.modoDe('ocupado');
    const oc = await p.apagar(m.config);
    check('con algo en su cola: ocupado', oc.ok === false && oc.codigo === 'ocupado' && px.pidVivo(v.pid));
    m.modoDe('');
    check('con una imagen nuestra en la cola del daemon: ocupado', (await p.apagar(m.config, { imagenes: () => 1 })).codigo === 'ocupado');
    let forzo = 0;
    m.modoDe('ocupado');
    const ap = await p.apagar(m.config, { forzar: true, imagenes: () => 1, alForzar: () => { forzo++; } });
    check('forzar lo apaga y corta las suyas', ap.ok && forzo === 1 && !px.pidVivo(v.pid));
    await hasta(async () => !fs.existsSync(p.rutas.lock));
    check('apagado, sin error', (await p.estado(m.config)).estado === 'apagado' && px.leerJson(p.rutas.estado).fase === 'apagado');
    check('apagar otra vez', (await p.apagar(m.config)).codigo === 'apagado');
    m.modoDe('');
    check('reiniciar lo levanta', (await p.reiniciar(m.config)).ok && await hasta(async () => (await p.estado(m.config)).estado === 'encendido') && m.visto().veces === 2);
    const pid2 = m.visto().pid;
    check('reiniciar apaga y levanta', (await p.reiniciar(m.config)).ok && await hasta(async () => m.visto().veces === 3 && (await p.estado(m.config)).estado === 'encendido') && !px.pidVivo(pid2));
    await hasta(async () => px.leerJson(p.rutas.estado).fase === 'encendido');
    check('apagar', (await p.apagar(m.config)).ok === true);
  });

  await group('El guardián muere y otro lo adopta', async () => {
    const m = await montar('dos');
    await m.p.levantar(m.config);
    await hasta(async () => px.leerJson(m.p.rutas.estado).fase === 'encendido');
    const { guardian } = px.leerJson(m.p.rutas.estado);
    const { pid } = m.visto();
    process.kill(guardian);
    await hasta(async () => !px.pidVivo(guardian));
    check('ComfyUI sigue vivo sin su guardián', px.pidVivo(pid) && (await px.responde(m.config.comfyui.url)) === 'ok');
    const nuevo = m.crear();
    check('el daemon nuevo lo ve como nuestro', (await nuevo.estado(m.config)).nuestro === true);
    check('y lo adopta', await nuevo.adoptar() === true && px.leerLock(nuevo.rutas).vivo);
    check('adoptar dos veces no pone otro', await nuevo.adoptar() === false);
    check('el adoptado se apaga', (await nuevo.apagar(m.config)).ok === true && !px.pidVivo(pid));
    // Sin guardián, lo apaga el daemon.
    await hasta(async () => !fs.existsSync(nuevo.rutas.lock));
    await nuevo.levantar(m.config);
    const e2 = px.leerJson(nuevo.rutas.estado); process.kill(e2.guardian); await hasta(async () => !px.pidVivo(e2.guardian));
    check('sin guardián, lo apaga el daemon', (await nuevo.apagar(m.config)).ok === true && !px.pidVivo(m.visto().pid) && (await nuevo.estado(m.config)).estado === 'apagado');
  });

  await group('El pid de otro y uno ajeno', async () => {
    const m = await montar('tres');
    const otro = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.mkdirSync(m.dir, { recursive: true });
    fs.writeFileSync(m.p.rutas.estado, JSON.stringify({ version: 1, pedido: 'x', fase: 'encendido', proceso: { pid: otro.pid, inicio: '131111111111111111' }, url: m.config.comfyui.url, carpeta: m.carpeta, desde: '2026-01-01T00:00:00Z' }));
    check('un pid reutilizado no es nuestro', (await m.p.estado(m.config)).nuestro === false);
    check('no se adopta ni se apaga', await m.p.adoptar() === false && (await m.p.apagar(m.config, { forzar: true })).ok === false && px.pidVivo(otro.pid));
    const hora = await px.horaDeInicio(otro.pid);
    check('la hora de inicio se lee', /^\d+$/.test(hora));
    check('matar con otra hora no mata', await px.matarArbol(otro.pid, '131111111111111111') === false && px.pidVivo(otro.pid));
    check('matar con la suya sí', await px.matarArbol(otro.pid, hora) === true && await hasta(async () => !px.pidVivo(otro.pid)));
    // Uno ajeno en esa dirección.
    const puerto = new URL(m.config.comfyui.url).port;
    const ajeno = spawn(process.execPath, [path.join(m.carpeta, 'main.py'), '--listen=127.0.0.1', `--port=${puerto}`], { stdio: 'ignore' });
    await hasta(async () => (await px.responde(m.config.comfyui.url)) === 'ok');
    const e = await m.p.estado(m.config);
    check('uno ajeno: encendido, no nuestro', e.estado === 'encendido' && e.nuestro === false);
    check('no se apaga, ni con forzar', (await m.p.apagar(m.config, { forzar: true })).codigo === 'ajeno' && px.pidVivo(ajeno.pid));
    check('levantar lo usa', (await m.p.levantar(m.config)).ok === true && px.pidVivo(ajeno.pid));
    ajeno.kill();
    await hasta(async () => !px.pidVivo(ajeno.pid));
    // Otro programa en el puerto.
    const http = require('node:http').createServer((q, r) => r.end('hola')); const puerto2 = await puertoLibre(); await new Promise((r) => http.listen(puerto2, '127.0.0.1', r));
    m.config.comfyui.url = `http://127.0.0.1:${puerto2}`;
    const eo = await m.p.estado(m.config);
    check('otro programa en el puerto: error, y no se levanta', eo.estado === 'error' && /otro programa/.test(eo.mensaje) && (await m.p.levantar(m.config, { manual: true })).ok === false && await m.p.comprobar(m.config) === 'otro-programa');
    await new Promise((r) => http.close(r));
  });

  await group('Los arranques que salen mal', async () => {
    const m = await montar('cuatro', { modo: 'muere' });
    const r = await m.p.levantar(m.config);
    check('muere antes: el error con sus últimas líneas, sin el token', r.ok === false && /código 3/.test(r.motivo) && /no entra en la GPU/.test(r.motivo) && !r.motivo.includes('hf_abc'), r.motivo);
    check('el estado lo dice', (await m.p.estado(m.config)).estado === 'error');
    check('un fallo no se reintenta solo', m.p.levantar(m.config) === null);
    m.modoDe('');
    check('a mano sí', (await m.p.levantar(m.config, { manual: true })).ok === true && (await m.p.estado(m.config)).estado === 'encendido');
    await hasta(async () => px.leerJson(m.p.rutas.estado).fase === 'encendido');
    await m.p.apagar(m.config);
    const l = await montar('cinco', { modo: 'lento', extra: { espera_s: 1 } });
    const t = Date.now();
    const lr = await l.p.levantar(l.config);
    check('más lento que la espera: sigue, sin error', lr.ok === false && lr.sigue === true && Date.now() - t < 2500 && (await l.p.estado(l.config)).estado === 'levantando');
    check('una imagen nueva no lo espera', l.p.levantar(l.config) === null);
    const otro = l.crear();
    check('otro pedido a mano se suma, sin lanzar otro', (await otro.levantar({ comfyui: { ...l.config.comfyui, arranque: { ...l.config.comfyui.arranque, espera_s: 20 } } }, { manual: true })).ok === true && l.visto().veces === 1);
    await hasta(async () => px.leerJson(l.p.rutas.estado).fase === 'encendido');
    await l.p.apagar(l.config);
    const c = await montar('seis', { modo: 'nunca', extra: { espera_s: 20 } });
    const enVuelo = c.p.levantar(c.config);
    await hasta(async () => px.leerJson(c.p.rutas.estado)?.fase === 'levantando' && c.visto());
    check('Apagar corta un arranque', (await c.p.apagar(c.config)).ok === true && (await enVuelo).cortado === true && (await c.p.estado(c.config)).estado === 'apagado');
    await hasta(async () => !fs.existsSync(c.p.rutas.lock));
    const nu = await c.p.levantar(c.config, { manual: true });
    check('uno que nunca responde: lo mata y queda en error', nu.ok === false && /nunca respondió/.test(nu.motivo) && !px.pidVivo(c.visto().pid) && await hasta(async () => !fs.existsSync(c.p.rutas.lock)), JSON.stringify(nu));
    const mala = { comfyui: { ...c.config.comfyui, arranque: { ...c.config.comfyui.arranque, carpeta: path.join(raiz, 'vacia') } } };
    check('una carpeta sin ComfyUI', (await c.p.levantar(mala, { manual: true })).ok === false && (await c.p.estado(mala)).sePuede === false);
    check('con https dice por qué', /https/.test((await c.p.estado({ comfyui: { ...c.config.comfyui, url: 'https://127.0.0.1:1' } })).motivo));
  });

  await group('La inactividad', async () => {
    // En estos tests un «minuto» es un segundo.
    const m = await montar('siete', { extra: { apagar_min: 1 }, modo: 'lento' });
    await m.p.levantar(m.config);
    const { pid } = m.visto();
    check('el arranque no cuenta como inactividad', px.pidVivo(pid));
    check('sin uso se apaga solo', await hasta(async () => !px.pidVivo(pid), 8000));
    await hasta(async () => !fs.existsSync(m.p.rutas.lock));
    check('…y queda apagado, sin error', (await m.p.estado(m.config)).estado === 'apagado');
    for (const [que, modo] of [['con algo en su cola', 'ocupado'], ['con un trabajo nuevo en su historial', 'usando']]) {
      m.modoDe('');
      await m.p.levantar(m.config, { manual: true }); m.modoDe(modo);
      const v = m.visto();
      await esperar(2500);
      check(`${que} no se apaga`, px.pidVivo(v.pid));
      m.modoDe('');
      await m.p.apagar(m.config, { forzar: true });
      await hasta(async () => !fs.existsSync(m.p.rutas.lock));
    }
    await m.p.levantar(m.config, { manual: true });
    const v = m.visto(); const fin = Date.now() + 2500;
    while (Date.now() < fin) { m.p.anotarUso(m.config); await esperar(200); }
    check('el uso que anota el daemon cuenta', px.pidVivo(v.pid));
    m.p.anotarAjustes({ comfyui: { ...m.config.comfyui, arranque: { ...m.config.comfyui.arranque, apagar_min: 0 } } });
    await esperar(2500);
    check('apagar_min 0: nunca, y cambia sin reiniciar', px.pidVivo(v.pid));
    m.p.anotarAjustes(m.config);
    check('…y al revés', await hasta(async () => !px.pidVivo(v.pid), 8000));
  });

  await group('El lock del guardián', async () => {
    const m = await montar('diez');
    await m.p.levantar(m.config);
    await hasta(async () => px.leerJson(m.p.rutas.estado).fase === 'encendido');
    const { pid } = m.visto(); const { guardian } = px.leerJson(m.p.rutas.estado);
    check('el .ps1 que usa es la copia durable', fs.existsSync(path.join(m.dir, 'comfyui-proceso.ps1')));
    fs.writeFileSync(m.p.rutas.lock, '');
    await esperar(500);
    check('un lock que no se puede leer no lo hace salir', px.pidVivo(guardian) && px.pidVivo(pid));
    fs.rmSync(m.p.rutas.lock, { force: true });
    check('si se lo borran, lo vuelve a tomar', await hasta(async () => px.leerLock(m.p.rutas)?.pid === guardian) && px.pidVivo(guardian));
    fs.writeFileSync(m.p.rutas.lock, '{');
    const otro = path.join(m.dir, 'pedido-x.json');
    fs.writeFileSync(otro, JSON.stringify({ id: 'x', dir: m.dir, modo: 'adoptar', ps1: path.join(m.dir, 'comfyui-proceso.ps1') }));
    const h = spawn(process.execPath, [px.RUTA_KEEPER, otro], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ...TIEMPOS } });
    await hasta(async () => !fs.existsSync(otro));
    check('el pedido se borra al leerlo', !fs.existsSync(otro));
    await esperar(800);
    check('otro guardián no roba un lock reciente a medio escribir', px.leerJson(m.p.rutas.estado).guardian === guardian && px.pidVivo(guardian) && px.pidVivo(pid));
    h.kill();
    // Otro guardián que levantó uno distinto: el suyo no queda suelto.
    const e = px.leerJson(m.p.rutas.estado);
    fs.writeFileSync(m.p.rutas.estado, JSON.stringify({ ...e, proceso: null }));
    fs.writeFileSync(m.p.rutas.lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    check('si otro tomó el lugar sin adoptarlo, apaga el suyo', await hasta(async () => !px.pidVivo(pid) && !px.pidVivo(guardian)));
    fs.rmSync(m.p.rutas.lock, { force: true });
  });

  await group('No se pudo apagar', async () => {
    const m = await montar('once', { modo: 'nunca', extra: { espera_s: 20 } });
    const enVuelo = m.p.levantar(m.config, { manual: true });
    await hasta(async () => Boolean(px.leerJson(m.p.rutas.estado)?.proceso));
    const ps = path.join(m.dir, 'comfyui-proceso.ps1'); const bueno = fs.readFileSync(ps);
    fs.writeFileSync(ps, 'exit 1');
    check('el arranque termina en error', (await enVuelo).ok === false);
    const e = px.leerJson(m.p.rutas.estado); const { pid } = m.visto();
    check('si no se pudo matar, sigue siendo nuestro, con su pid', e.fase === 'error' && e.proceso.pid === pid && px.pidVivo(pid) && px.leerLock(m.p.rutas).vivo, JSON.stringify(e));
    fs.writeFileSync(ps, bueno);
    check('…y lo vuelve a intentar', await hasta(async () => !px.pidVivo(pid)) && await hasta(async () => px.leerJson(m.p.rutas.estado).proceso === null));
  });

  await group('El log se rota en marcha', async () => {
    const m = await montar('ocho');
    await m.p.levantar(m.config);
    await hasta(async () => px.leerJson(m.p.rutas.estado).fase === 'encendido');
    fs.appendFileSync(m.p.rutas.log, 'a'.repeat(px.TOPE_LOG + 10));
    check('a los 2 MB queda un respaldo y sigue', await hasta(async () => fs.existsSync(`${m.p.rutas.log}.1`) && fs.statSync(m.p.rutas.log).size < 1000, 12000));
    await m.p.apagar(m.config);
  });

  await group('validarArranque', async () => {
    const m = await montar('nueve');
    const v = (x) => m.p.validarArranque(m.config, x);
    check('flags de su versión', (await v({ flags: [{ flag: '--lowvram' }] })).ok === true);
    check('una que no está, con su campo', (await v({ flags: [{ flag: '--cpu' }, { flag: '--no-esta' }] })).campo === '.flags.1.flag');
    check('una carpeta sin ComfyUI', (await v({ carpeta: path.join(raiz, 'vacia') })).campo === '.carpeta');
    check('lo demás no se mira', (await v({ apagar_min: 3 })).ok === true && (await v({ carpeta: null })).ok === true && (await v({ flags: [] })).ok === true);
    const f = await m.p.flags(m.config);
    check('GET flags: las que se pueden poner', f.ok && f.flags.some((x) => x.flag === '--lowvram') && !f.flags.some((x) => x.flag === '--listen'));
  });

  for (const g of guardianes) { try { process.kill(g); } catch {} }
  report();
}

// Las instalaciones de mentira llevan una copia de node (unos 80 MB cada una): la carpeta se borra al terminar, también si falla.
const limpiar = () => { try { fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (err) { console.error('no se pudo borrar ' + raiz + ': ' + err.message); } };
main().then(limpiar, (err) => { console.error(err); limpiar(); process.exit(1); });
