'use strict';

/**
 * FEAT-213 §1 — El proceso de ComfyUI: levantarlo, saber de quién es y apagarlo.
 *
 * ComfyUI lo lanza un guardián aparte (`comfyui-keeper.js`), que es su dueño y sobrevive al daemon: corre fuera de su árbol
 * (`Win32_Process.Create`, desde `comfyui-proceso.ps1`). El daemon y el guardián se hablan por archivos de una carpeta durable
 * (`~/.claude/lagrange-comfyui`), porque la del plugin cambia con cada versión:
 *
 * - `pedido-<id>.json`: lo que el guardián tiene que lanzar (o adoptar). Se borra al leerlo;
 * - `estado.json`: lo escribe solo el guardián. Con él se sabe si es nuestro (pid, hora de inicio, url y carpeta);
 * - `guardian.lock`: uno solo. Lo renueva mientras vive: no vence con un arranque lento;
 * - `orden.json`: apagar. `uso.json`: el uso del daemon y los minutos para apagarlo;
 * - `comfyui.log`: lo que escribe ComfyUI (por archivo, así sigue andando si el guardián muere).
 *
 * Solo se apaga el nuestro. Uno que ya respondía en esa dirección es ajeno: se usa y no se toca.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { escribirAtomico } = require('../lib/fs-atomico.js');
const { terminateTree } = require('../lib/process-tree.js');
const { esLoopback } = require('./loopback.js');
const flagsLib = require('./comfyui-flags.js');

const RUTA_KEEPER = path.join(__dirname, '..', 'comfyui-keeper.js');
const RUTA_PS1 = path.join(__dirname, '..', 'comfyui-proceso.ps1');
const AYUDA_MS = 20 * 1000;
const PS_MS = 20 * 1000;
const PEDIDO_MS = 3000;
/** Lo que puede tardar el guardián en tomar el pedido. */
const TOMAR_MS = 20 * 1000;
/** Sin renovar el lock por este tiempo, el guardián no está (aunque otro proceso tenga su pid). */
const LATIDO_VIEJO_MS = 60 * 1000;
/** Un fallo no se reintenta solo por este tiempo. */
const FALLO_MS = 2 * 60 * 1000;
const TOPE_LOG = 2 * 1024 * 1024;

// ─── La carpeta de estado ───

function dirEstado(env = process.env) {
  if (env.LAGRANGE_COMFYUI_DIR) return path.resolve(env.LAGRANGE_COMFYUI_DIR);
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude', 'lagrange-comfyui');
}

function rutasDe(dir) {
  return {
    dir, estado: path.join(dir, 'estado.json'), lock: path.join(dir, 'guardian.lock'), orden: path.join(dir, 'orden.json'),
    uso: path.join(dir, 'uso.json'), log: path.join(dir, 'comfyui.log'), guardianLog: path.join(dir, 'guardian.log')
  };
}

function leerJson(ruta) {
  // En Windows, leer mientras el otro proceso lo reemplaza puede fallar un instante: se prueba de nuevo antes de decir que no está.
  for (let i = 0; i < 3; i++) {
    try {
      const o = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (i < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return null;
}

/** ¿Se escribió hace poco? Un lock que no se puede leer ahora, pero reciente, es de alguien. */
function esReciente(ruta, ahora = Date.now()) {
  try { return ahora - fs.statSync(ruta).mtimeMs < LATIDO_VIEJO_MS; } catch { return false; }
}

function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** El lock del guardián: `null`, o `{ pid, ts, vivo }`. Vivo: su pid existe y lo renueva. */
function leerLock(rutas, ahora = Date.now()) {
  const l = leerJson(rutas.lock);
  return l ? { ...l, vivo: pidVivo(l.pid) && ahora - Number(l.ts || 0) < LATIDO_VIEJO_MS } : null;
}

// ─── La instalación ───

const esArchivo = (r) => { try { return fs.statSync(r).isFile(); } catch { return false; } };

function dentro(raiz, ruta) {
  let real;
  try { real = fs.realpathSync.native(ruta); } catch { return null; }
  const rel = path.relative(raiz, real);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? real : null;
}

/** Qué hay en la carpeta: `{ ok, tipo, python, main, cwd, args }` o `{ ok: false, motivo }` (sin la ruta). */
function resolverInstalacion(carpeta) {
  if (!carpeta) return { ok: false, motivo: 'no hay una carpeta elegida' };
  let raiz;
  try { raiz = fs.realpathSync.native(carpeta); if (!fs.statSync(raiz).isDirectory()) throw new Error('no'); } catch { return { ok: false, motivo: 'la carpeta no existe' }; }
  if (/^[\\/]{2}/.test(raiz)) return { ok: false, motivo: 'la carpeta es de red' };
  const formas = [
    { tipo: 'portable', python: ['python_embeded', 'python.exe'], main: ['ComfyUI', 'main.py'], args: ['-s'], extra: ['--windows-standalone-build'] },
    { tipo: 'entorno', python: ['.venv', 'Scripts', 'python.exe'], main: ['main.py'], args: [], extra: [] },
    { tipo: 'entorno', python: ['venv', 'Scripts', 'python.exe'], main: ['main.py'], args: [], extra: [] }
  ];
  for (const f of formas) {
    const p = path.join(raiz, ...f.python);
    const m = path.join(raiz, ...f.main);
    if (!esArchivo(p) || !esArchivo(m)) continue;
    const python = dentro(raiz, p);
    const main = dentro(raiz, m);
    if (!python || !main) return { ok: false, motivo: 'el Python o main.py quedan fuera de la carpeta' };
    return { ok: true, tipo: f.tipo, python, main, cwd: raiz, args: f.args, extra: f.extra };
  }
  return { ok: false, motivo: `no encontré ComfyUI: hace falta ${formas.map((f) => `${f.python.join('\\')} con ${f.main.join('\\')}`).join(', o ')}` };
}

/** La dirección donde escucha: `{ ok, host, puerto, salud }` o `{ ok: false, motivo }`. */
function escucha(url) {
  if (!esLoopback(url)) return { ok: false, motivo: 'la dirección no es de esta máquina' };
  const u = new URL(url);
  if (u.protocol !== 'http:') return { ok: false, motivo: 'con https no se puede levantar desde acá' };
  const host = u.hostname === '[::1]' ? '::1' : '127.0.0.1';
  const puerto = u.port || '80';
  return { ok: true, host, puerto, salud: `http://${host === '::1' ? '[::1]' : host}:${puerto}` };
}

// ─── El entorno, por lista blanca ───

const PERMITIDAS = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'HF_HOME']);
const PREFIJOS = ['PROGRAMFILES', 'PROCESSOR_', 'CUDA_', 'NVIDIA_', 'PYTORCH_'];

/** El entorno de ComfyUI y de su `--help`: un nodo es código de terceros, nunca ve los secretos del daemon. */
function entornoLimpio(env = process.env) {
  const salida = {};
  for (const [k, v] of Object.entries(env)) {
    const K = k.toUpperCase();
    if (typeof v !== 'string' || /_(KEY|TOKEN|SECRET|PASSWORD)$/.test(K)) continue;
    if (PERMITIDAS.has(K) || PREFIJOS.some((p) => K.startsWith(p))) salida[k] = v;
  }
  // La salida va a un archivo: sin esto, un nodo que imprime un carácter fuera de cp1252 se cae al importarse.
  return { ...salida, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
}

// ─── Sus flags ───

const ayudas = new Map();

function huellaDeAyuda(inst) {
  const partes = [inst.main];
  for (const r of [inst.main, path.join(path.dirname(inst.main), 'comfy', 'cli_args.py')]) {
    try { const st = fs.statSync(r); partes.push(`${st.mtimeMs}:${st.size}`); } catch { partes.push('-'); }
  }
  return partes.join('|');
}

/** Las flags de su versión (`main.py --help`), en caché. `{ ok, flags }` o `{ ok: false, motivo }`. */
async function leerFlags(inst, { ejecutar = execFile, env = process.env } = {}) {
  const huella = huellaDeAyuda(inst);
  const previa = ayudas.get(inst.main);
  if (previa && previa.huella === huella) return previa.promesa;
  const promesa = new Promise((resolve) => {
    let reloj = null;
    const hijo = ejecutar(inst.python, [...inst.args, inst.main, '--help'], { shell: false, windowsHide: true, cwd: inst.cwd, env: entornoLimpio(env), maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, salida) => {
      clearTimeout(reloj);
      const flags = err ? [] : flagsLib.parsearAyuda(salida);
      resolve(flags.length ? { ok: true, flags } : { ok: false, motivo: 'no pude leer sus flags (main.py --help)' });
    });
    // Si vence se mata su árbol: el python.exe de un entorno lanza otro.
    reloj = setTimeout(() => terminateTree(hijo, 1000), AYUDA_MS);
    reloj.unref?.();
  });
  ayudas.set(inst.main, { huella, promesa });
  const r = await promesa;
  if (!r.ok && ayudas.get(inst.main)?.promesa === promesa) ayudas.delete(inst.main);
  return r;
}

/** Los argumentos de Python, con la red al final: el último gana. `catalogo`, las flags de su versión (o `null`: ninguna). */
function armarArgs({ inst, donde, flags, catalogo }) {
  const { usadas, avisos } = catalogo ? flagsLib.filtrar(flags, catalogo) : { usadas: [], avisos: flags.length ? ['No pude leer las flags de esa versión: no se usa ninguna.'] : [] };
  // Cada flag es un solo argumento `--flag` o `--flag=valor`, y ninguna es de las que pone el plugin.
  if (!usadas.every((u) => /^--[A-Za-z][\w-]*(=.*)?$/.test(flagsLib.comoArgumento(u)) && !flagsLib.prohibida(u.flag))) throw new Error('las flags de ComfyUI no son válidas');
  const sinNavegador = catalogo && catalogo.some((f) => f.flag === '--disable-auto-launch') ? ['--disable-auto-launch'] : [];
  return {
    args: [...inst.args, inst.main, ...inst.extra, ...usadas.map(flagsLib.comoArgumento), ...sinNavegador, `--listen=${donde.host}`, `--port=${donde.puerto}`],
    avisos
  };
}

// ─── Windows ───

const POWERSHELL = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Corre `comfyui-proceso.ps1` con `-File` y parámetros (nunca un comando armado con texto). `{ codigo, salida }`. */
function correrPs1(parametros, { ejecutar = execFile, ruta = RUTA_PS1 } = {}) {
  return new Promise((resolve) => {
    ejecutar(POWERSHELL(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ruta, ...parametros], { shell: false, windowsHide: true, timeout: PS_MS, encoding: 'utf8' }, (err, salida) => {
      resolve({ codigo: err ? (Number.isInteger(err.code) ? err.code : 1) : 0, salida: String(salida || '').trim() });
    });
  });
}

/** Lo último de los argumentos es la red de esa url: el guardián no lanza otra cosa. */
function redEsperada(args, url) {
  const d = escucha(url);
  return Boolean(d.ok && Array.isArray(args) && args.at(-2) === `--listen=${d.host}` && args.at(-1) === `--port=${d.puerto}`);
}

/** La hora de inicio de un proceso, como texto, o `null`. */
async function horaDeInicio(pid, { ps1 = correrPs1 } = {}) {
  if (process.platform !== 'win32' || !pidVivo(pid)) return null;
  const r = await ps1(['-Accion', 'inicio', '-ProcId', String(pid)]);
  return r.codigo === 0 && /^\d{10,25}$/.test(r.salida) ? r.salida : null;
}

/** Mata el árbol de `pid` solo si sigue siendo el que empezó a esa hora. */
async function matarArbol(pid, inicio, { ps1 = correrPs1 } = {}) {
  if (process.platform !== 'win32' || !/^\d{10,25}$/.test(String(inicio))) return false;
  const r = await ps1(['-Accion', 'matar', '-ProcId', String(pid), '-Inicio', String(inicio)]);
  return r.codigo === 0;
}

// ─── Saber si responde ───

const ERRORES_DE_CONEXION = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

/** `'ok'`, `'no-responde'`, `'otro-programa'` u `'ocupado'` (aceptó la conexión y no contestó a tiempo). */
async function responde(base, { fetchImpl = globalThis.fetch, tiempoMs = PEDIDO_MS } = {}) {
  try {
    const r = await fetchImpl(`${base}/system_stats`, { signal: AbortSignal.timeout(tiempoMs), redirect: 'manual' });
    const s = r.ok ? await r.json().catch(() => null) : null;
    return s && typeof s.system === 'object' && s.system && Array.isArray(s.devices) ? 'ok' : 'otro-programa';
  } catch (err) {
    if (err && err.name === 'TimeoutError') return 'ocupado';
    const codigo = err && err.cause && err.cause.code;
    return !codigo || ERRORES_DE_CONEXION.has(codigo) ? 'no-responde' : 'otro-programa';
  }
}

/** Cuántos trabajos tiene en su cola, o `null` si no contesta. */
async function colaDe(base, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const r = await fetchImpl(`${base}/queue`, { signal: AbortSignal.timeout(PEDIDO_MS), redirect: 'error' });
    const q = await r.json();
    return (Array.isArray(q.queue_running) ? q.queue_running.length : 0) + (Array.isArray(q.queue_pending) ? q.queue_pending.length : 0);
  } catch {
    return null;
  }
}

// ─── El registro ───

/** Lo que tapa un nodo que imprime una clave: las de otros servicios, las de un encabezado y las de una URL. */
function sinCredenciales(texto) {
  return String(texto || '')
    .replace(/\b(hf|ghp|gho|ghs|github_pat|xox[abprs])_[A-Za-z0-9_]{10,}/g, '$1_[REDACTED]')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{12,}/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token)\s+)?[^\s"',}]+/gi, (_, a, b) => `${a}${b ? `${b} ` : ''}[REDACTED]`)
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|clave)["']?\s*[=:]\s*["']?)[^\s"'&,}]{4,}/gi, '$1[REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** Las líneas que repiten el comando con que se levantó (argv, entorno). */
const ES_COMANDO = /--listen\b|--windows-standalone-build|python(?:\.exe)?["']?[,\s]+["']?(?:-s["']?[,\s]+["']?)?[^\s"']*main\.py/i;

/** Las últimas `n` líneas del log, sin el comando ni credenciales. `limpiar` es lo del proceso (rutas y secretos resueltos). */
function ultimasLineas(ruta, { n = 100, limpiar = (t) => t } = {}) {
  let texto = '';
  try {
    const fd = fs.openSync(ruta, 'r');
    try {
      const tam = fs.fstatSync(fd).size;
      const largo = Math.min(tam, 256 * 1024);
      const buf = Buffer.alloc(largo);
      fs.readSync(fd, buf, 0, largo, tam - largo);
      texto = buf.toString('utf8');
      // La primera puede venir cortada: con el corte a la mitad, un secreto no se reconocería.
      if (largo < tam) texto = texto.slice(texto.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch {
    return [];
  }
  return texto.split(/\r?\n|\r/)
    .map((l) => l.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd())
    .filter((l) => l && !ES_COMANDO.test(l))
    .slice(-n)
    .map((l) => limpiar(sinCredenciales(l)).slice(0, 500));
}

// ─── El control, desde el daemon ───

/**
 * `crearProceso({ … })`: lo que usa el daemon. `limpiar(texto)`: sin rutas ni secretos, para todo lo que sale. Se inyectan
 * `fetchImpl`, `ps1`, `ejecutar`, `lanzar`, `env` y los tiempos en los tests.
 */
function crearProceso({
  env = process.env, dir = dirEstado(env), plataforma = process.platform, fetchImpl = (...a) => globalThis.fetch(...a), ps1 = correrPs1, ejecutar = execFile,
  lanzar = null, limpiar = (t) => t, log = () => {}, ahora = () => Date.now(), esperar = (ms) => new Promise((r) => setTimeout(r, ms)), tiempos = {},
  nodo = process.execPath, alResponder = () => {}
} = {}) {
  const rutas = rutasDe(dir);
  const T = { tomar: TOMAR_MS, sondeo: 1000, apagar: 20 * 1000, fallo: FALLO_MS, ...tiempos };
  const seguro = (t) => limpiar(sinCredenciales(t)).slice(0, 300);
  const base = (config) => String(config.comfyui.url || '').replace(/\/+$/, '');
  const arranqueDe = (config) => config.comfyui.arranque || {};
  // El arranque en vuelo: `{ promesa, desde, hasta }`. Otro pedido se suma a él.
  let enVuelo = null;
  let falloHasta = 0;
  let ultimoError = null;

  const asegurarDir = () => fs.mkdirSync(dir, { recursive: true });

  /** El estado guardado, sin comprobar la hora: solo para decidir si se espera. */
  function guardadoRapido() {
    const e = leerJson(rutas.estado);
    return { e, vivo: Boolean(e && e.proceso && e.proceso.inicio && pidVivo(e.proceso.pid)) };
  }

  let comprobado = { clave: null, vale: false, hasta: 0 };
  let adoptando = null;
  let lanzando = false;
  /**
   * El estado guardado, y si su proceso sigue siendo el nuestro: con su guardián vivo lo dice él; sin guardián (o tras reiniciar la
   * máquina, con el pid de otro), se compara la hora de inicio, como mucho una vez por minuto.
   */
  async function guardado() {
    const { e, vivo } = guardadoRapido();
    if (!vivo) return { e, vivo };
    const lock = leerLock(rutas, ahora());
    if (lock && lock.vivo) return { e, vivo: true };
    const clave = `${e.proceso.pid}:${e.proceso.inicio}`;
    if (comprobado.clave !== clave || ahora() >= comprobado.hasta) {
      comprobado = { clave, vale: (await horaDeInicio(e.proceso.pid, { ps1 })) === e.proceso.inicio, hasta: ahora() + 60 * 1000 };
    }
    return { e, vivo: comprobado.vale };
  }

  const mismaUrl = (a, b) => { const x = escucha(a); const y = escucha(b); return x.ok && y.ok && x.salud === y.salud; };
  const mismaCarpeta = (a, b) => { let x = a; let y = b; try { x = fs.realpathSync.native(a); y = fs.realpathSync.native(b); } catch {} return plataforma === 'win32' ? String(x).toLowerCase() === String(y).toLowerCase() : x === y; };
  const deEstaConfig = (e, config) => mismaUrl(e.url, base(config)) && mismaCarpeta(e.carpeta, arranqueDe(config).carpeta || '');

  /** Dónde preguntar: `localhost` se pregunta en 127.0.0.1, que es donde escucha el nuestro. */
  const salud = (config) => { const d = escucha(base(config)); return d.ok ? d.salud : base(config); };

  /** Lo mira la cola antes de usarlo: `'ok'`, `'no-responde'` u `'otro-programa'`. Uno ocupado sirve: decide el pedido de verdad. */
  async function comprobar(config) {
    const r = await responde(salud(config), { fetchImpl });
    return r === 'ocupado' ? 'ok' : r;
  }

  /** `GET /comfyui`. */
  async function estado(config) {
    const { e, vivo } = await guardado();
    const [r, cola] = await Promise.all([responde(salud(config), { fetchImpl }), colaDe(salud(config), { fetchImpl })]);
    const suyo = vivo && deEstaConfig(e, config);
    // Uno nuestro que se quedó sin guardián: se le pone otro.
    if (vivo && !lanzando) { const lock = leerLock(rutas, ahora()); if (!lock || !lock.vivo) adoptar().catch(() => {}); }
    const inst = arranqueDe(config).carpeta ? resolverInstalacion(arranqueDe(config).carpeta) : null;
    const donde = escucha(base(config));
    const motivoNo = plataforma !== 'win32' ? 'Solo se puede levantar en Windows.' : !inst ? 'Elegí la carpeta de ComfyUI.' : !inst.ok ? `No se puede: ${inst.motivo}.` : !donde.ok ? `No se puede: ${donde.motivo}.` : null;
    const salida = {
      estado: 'apagado', nuestro: vivo, otraConfiguracion: vivo && !suyo, desde: vivo ? e.desde || null : null, cola: r === 'ok' ? cola : null, mensaje: null,
      sePuede: motivoNo === null, motivo: motivoNo ? motivoNo.slice(0, 300) : null, instalacion: inst ? (inst.ok ? inst.tipo : null) : null
    };
    if (suyo && (e.fase === 'levantando' || e.fase === 'apagando')) return { ...salida, estado: r === 'ok' && e.fase === 'levantando' ? 'encendido' : e.fase, mensaje: e.mensaje ? seguro(e.mensaje) : null };
    if (r === 'ok' || r === 'ocupado') return { ...salida, estado: 'encendido', mensaje: r === 'ok' ? null : 'ComfyUI está ocupado y no contesta ahora.' };
    if (enVuelo) return { ...salida, estado: 'levantando' };
    if (vivo && !suyo && r === 'no-responde') return { ...salida, mensaje: 'Hay un ComfyUI levantado con otra configuración.' };
    if (suyo) return { ...salida, estado: 'error', mensaje: 'ComfyUI está abierto pero no responde.' };
    if (r === 'otro-programa') return { ...salida, estado: 'error', mensaje: 'En esa dirección responde otro programa, no ComfyUI.' };
    if (e && e.fase === 'error' && e.mensaje) return { ...salida, estado: 'error', desde: e.desde || null, mensaje: seguro(e.mensaje) };
    if (ultimoError) return { ...salida, estado: 'error', mensaje: ultimoError };
    return salida;
  }

  /** Lanza el guardián con ese pedido y espera a que lo tome. Lanza con un texto fijo. */
  async function lanzarGuardian(pedido) {
    asegurarDir();
    const id = crypto.randomUUID();
    const ruta = path.join(dir, `pedido-${id}.json`);
    // El guardián usa una copia del .ps1: la carpeta del plugin puede irse con una actualización.
    const copia = path.join(dir, path.basename(RUTA_PS1));
    fs.copyFileSync(RUTA_PS1, copia);
    escribirAtomico(ruta, JSON.stringify({ ...pedido, id, dir, ps1: copia }));
    lanzando = true;
    try {
      if (lanzar) await lanzar({ nodo, keeper: RUTA_KEEPER, pedido: ruta });
      else {
        const r = await ps1(['-Accion', 'lanzar', '-Nodo', nodo, '-Guardian', RUTA_KEEPER, '-Pedido', ruta]);
        if (r.codigo !== 0) throw new Error('no pude lanzar el guardián de ComfyUI');
      }
      const fin = ahora() + T.tomar;
      while (ahora() < fin) {
        const e = leerJson(rutas.estado);
        if (e && e.pedido === id) return id;
        await esperar(Math.min(250, T.sondeo));
      }
      throw new Error('el guardián de ComfyUI no arrancó');
    } finally {
      lanzando = false;
      // Si el guardián no lo leyó a tiempo, ya no tiene que lanzarlo.
      try { fs.rmSync(ruta, { force: true }); } catch {}
    }
  }

  /** Si hay un ComfyUI nuestro sin guardián, le pone uno. Lo corre el arranque del daemon. `true` si lo adoptó. */
  function adoptar() {
    if (!adoptando) adoptando = adoptarUna().finally(() => { adoptando = null; });
    return adoptando;
  }

  async function adoptarUna() {
    if (plataforma !== 'win32') return false;
    const { vivo } = await guardado();
    const lock = leerLock(rutas, ahora());
    if (!vivo || (lock && lock.vivo)) return false;
    try { await lanzarGuardian({ modo: 'adoptar' }); return true; } catch (err) { log(`[comfyui] ${err.message}`); return false; }
  }

  async function arrancar(config) {
    const inst = resolverInstalacion(arranqueDe(config).carpeta);
    if (!inst.ok) throw new Error(inst.motivo);
    const donde = escucha(base(config));
    if (!donde.ok) throw new Error(donde.motivo);
    const r = await responde(donde.salud, { fetchImpl });
    // Ocupado: ya hay uno ahí (aceptó la conexión), y no se lanza un segundo.
    if (r === 'ok' || r === 'ocupado') return { ok: true };
    if (r === 'otro-programa') throw new Error('en esa dirección responde otro programa, no ComfyUI');
    const { e, vivo } = await guardado();
    let id = vivo && e.fase === 'levantando' ? e.pedido : null;
    if (vivo && !id) {
      throw new Error(deEstaConfig(e, config) ? 'ComfyUI está abierto pero no responde' : 'hay un ComfyUI levantado con otra configuración');
    }
    if (!id) {
      const f = await leerFlags(inst, { ejecutar, env });
      const { args, avisos } = armarArgs({ inst, donde, flags: arranqueDe(config).flags || [], catalogo: f.ok ? f.flags : null });
      for (const a of avisos) log(`[comfyui] ${a}`);
      anotarAjustes(config);
      id = await lanzarGuardian({ modo: 'levantar', python: inst.python, args, cwd: inst.cwd, env: entornoLimpio(env), url: donde.salud, carpeta: inst.cwd, avisos });
    }
    const fin = ahora() + (arranqueDe(config).espera_s || 120) * 1000;
    for (;;) {
      if ((await responde(donde.salud, { fetchImpl })) === 'ok') return { ok: true };
      const s = leerJson(rutas.estado);
      // Lo apagaron mientras arrancaba: no es un fallo.
      if (s && s.pedido === id && s.fase === 'apagado') return { ok: false, cortado: true };
      if (!s || s.pedido !== id || s.fase === 'error') throw new Error(s && s.mensaje ? s.mensaje : 'ComfyUI se cerró al arrancar');
      if (ahora() >= fin) return { ok: false, sigue: true };
      await esperar(T.sondeo);
    }
  }

  /**
   * Lo levanta y espera (hasta `espera_s`). `null` si no corresponde esperar: un arranque que ya pasó su espera o un fallo de hace
   * menos de 2 minutos (`manual` ignora el fallo). Un solo arranque a la vez.
   */
  function levantar(config, { manual = false } = {}) {
    if (plataforma !== 'win32') return manual ? Promise.resolve({ ok: false, motivo: 'solo se puede levantar en Windows' }) : null;
    if (enVuelo) return enVuelo.promesa;
    if (!manual) {
      if (ahora() < falloHasta) return null;
      const { e, vivo } = guardadoRapido();
      // Sigue levantando después de su espera: las imágenes nuevas no lo esperan.
      if (vivo && e.fase === 'levantando' && ahora() - Date.parse(e.desde || 0) > (arranqueDe(config).espera_s || 120) * 1000) return null;
    }
    const promesa = arrancar(config).then((r) => {
      if (r.ok) { falloHasta = 0; ultimoError = null; try { alResponder(config); } catch {} }
      return r;
    }, (err) => {
      falloHasta = ahora() + T.fallo;
      ultimoError = seguro(`No se pudo levantar ComfyUI: ${err.message}.`);
      log(`[comfyui] ${ultimoError}`);
      return { ok: false, motivo: ultimoError };
    }).finally(() => { enVuelo = null; });
    enVuelo = { promesa };
    return promesa;
  }

  /**
   * Apaga el nuestro. `{ ok }`, o `{ ok: false, codigo, motivo }` con `ajeno`, `apagado` u `ocupado` (tiene trabajos y no es
   * `forzar`). `imagenes()`: cuántas nuestras hay en la cola del daemon.
   */
  async function apagar(config, { forzar = false, imagenes = () => 0, alForzar = () => {} } = {}) {
    let { e, vivo } = await guardado();
    // Un arranque que todavía no tiene proceso: se espera a que lo tenga, para no dejarlo levantarse después.
    const limite = ahora() + T.tomar;
    const arrancando = () => { const l = leerLock(rutas, ahora()); return Boolean(enVuelo || (e && e.fase === 'levantando' && !e.proceso && l && l.vivo)); };
    while (!vivo && arrancando() && ahora() < limite) { await esperar(Math.min(250, T.sondeo)); ({ e, vivo } = await guardado()); }
    if (!vivo) {
      const r = await responde(salud(config), { fetchImpl });
      return r === 'no-responde' ? { ok: false, codigo: 'apagado', motivo: 'ComfyUI ya está apagado.' } : { ok: false, codigo: 'ajeno', motivo: 'Ese ComfyUI no lo levantó Lagrange: se cierra desde donde se abrió.' };
    }
    if (!forzar) {
      const enCola = e.fase === 'levantando' ? 0 : (await colaDe(e.url, { fetchImpl })) || 0;
      if (enCola > 0 || imagenes() > 0) return { ok: false, codigo: 'ocupado', motivo: 'ComfyUI está haciendo una imagen.' };
    } else alForzar();
    const lock = leerLock(rutas, ahora());
    if (lock && lock.vivo) {
      asegurarDir();
      escribirAtomico(rutas.orden, JSON.stringify({ accion: 'apagar', pedido: e.pedido, ts: ahora() }));
      const fin = ahora() + T.apagar;
      while (ahora() < fin) {
        await esperar(Math.min(500, T.sondeo));
        if (!pidVivo(e.proceso.pid)) { ultimoError = null; return { ok: true }; }
      }
    }
    // Sin guardián (o no contestó): lo mata el daemon, con la misma comprobación de la hora.
    if (!(await matarArbol(e.proceso.pid, e.proceso.inicio, { ps1 }))) return { ok: false, codigo: 'error', motivo: 'No se pudo apagar ComfyUI.' };
    if (!lock || !lock.vivo) { try { escribirAtomico(rutas.estado, JSON.stringify({ ...e, fase: 'apagado', proceso: null, mensaje: null })); } catch {} }
    ultimoError = null;
    return { ok: true };
  }

  async function reiniciar(config, opciones = {}) {
    const r = await apagar(config, opciones);
    if (!r.ok && r.codigo !== 'apagado') return r;
    // El arranque anterior termina antes: si no, levantar se sumaría a él.
    if (enVuelo) await enVuelo.promesa;
    falloHasta = 0;
    levantar(config, { manual: true });
    return { ok: true };
  }

  /** El uso del daemon, para que el guardián no lo apague. */
  function anotarUso(config) {
    if (!arranqueDe(config).carpeta) return;
    try { asegurarDir(); escribirAtomico(rutas.uso, JSON.stringify({ ts: ahora(), apagarMin: arranqueDe(config).apagar_min ?? 20 })); } catch {}
  }

  /** Los minutos para apagarlo cambiaron: el guardián los lee en su próxima vuelta, sin contar como uso. */
  function anotarAjustes(config) {
    if (!arranqueDe(config).carpeta) return;
    const u = leerJson(rutas.uso) || {};
    try { asegurarDir(); escribirAtomico(rutas.uso, JSON.stringify({ ts: Number(u.ts) || 0, apagarMin: arranqueDe(config).apagar_min ?? 20 })); } catch {}
  }

  /** `GET /comfyui/flags`. */
  async function flags(config) {
    const inst = resolverInstalacion(arranqueDe(config).carpeta);
    if (!inst.ok) return { ok: false, motivo: inst.motivo };
    const f = await leerFlags(inst, { ejecutar, env });
    return f.ok ? { ok: true, flags: flagsLib.ofrecidas(f.flags) } : f;
  }

  /** Lo que un pedido de Ajustes cambia de `arranque`, contra la carpeta y su versión. `{ ok }` o `{ ok: false, campo, motivo }`. */
  async function validarArranque(config, pedido) {
    const carpeta = pedido.carpeta === undefined ? arranqueDe(config).carpeta : pedido.carpeta;
    if (!carpeta || typeof carpeta !== 'string') return { ok: true };
    const inst = /^[A-Za-z]:[\\/]/.test(carpeta) || plataforma !== 'win32' ? resolverInstalacion(carpeta) : null;
    if (!inst) return { ok: true }; // la forma la rechaza el núcleo
    if (pedido.carpeta !== undefined && !inst.ok) return { ok: false, campo: '.carpeta', motivo: `En esa carpeta ${inst.motivo}.` };
    if (pedido.flags === undefined || pedido.flags === null) return { ok: true };
    const forma = flagsLib.validarForma(pedido.flags);
    if (!forma.ok) return { ok: false, campo: `.flags${forma.campo}`, motivo: `Las flags de ComfyUI: ${forma.motivo}.` };
    if (!forma.flags.length) return { ok: true };
    if (!inst.ok) return { ok: false, campo: '.carpeta', motivo: `En esa carpeta ${inst.motivo}.` };
    const f = await leerFlags(inst, { ejecutar, env });
    if (!f.ok) return { ok: false, campo: '.flags', motivo: `No se pueden comprobar las flags: ${f.motivo}.` };
    const v = flagsLib.validarContra(forma.flags, f.flags);
    return v.ok ? { ok: true } : { ok: false, campo: `.flags${v.campo}`, motivo: `${v.motivo}.` };
  }

  const registro = () => ultimasLineas(rutas.log, { limpiar });

  return { rutas, comprobar, estado, levantar, apagar, reiniciar, adoptar, anotarUso, anotarAjustes, flags, validarArranque, registro, levantando: () => Boolean(enVuelo) };
}

module.exports = {
  RUTA_KEEPER, RUTA_PS1, TOPE_LOG, LATIDO_VIEJO_MS, dirEstado, rutasDe, leerJson, pidVivo, leerLock, resolverInstalacion, escucha, entornoLimpio, leerFlags, armarArgs,
  correrPs1, horaDeInicio, matarArbol, redEsperada, esReciente, responde, colaDe, sinCredenciales, ultimasLineas, crearProceso
};
