/**
 * FEAT-154 — Las imágenes de los harness de lotes (agy y Claude Code): qué
 * versión fija el repo, cuál trae la imagen construida y cómo reconstruirla.
 * Lo usan el CLI (`npm run lotes -- imagenes…`), la tarjeta de Proveedores y
 * la consola.
 *
 * La versión construida sale de una etiqueta que cada Dockerfile escribe
 * después de comprobar el binario (`io.lagrange.harness.version`). Leerla es
 * un `docker image inspect`: no arranca ningún contenedor. Una imagen anterior
 * a la etiqueta se pregunta con `<bin> --version`, sin red.
 *
 * Mientras se construye queda un marcador en el directorio de datos del bridge
 * (`lotes-construyendo.json`). El preflight de `servicio.js` lo lee: así ni el
 * daemon ni el MCP de una sesión arrancan o reanudan un lote con la imagen a
 * medio cambiar. Un marcador cuyo proceso murió no cuenta y se borra.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { IMAGEN_AGY, IMAGEN_CLAUDE, sanitizarSalida } = require('./docker.js');
const { pidVivo } = require('./bloqueo.js');
const { terminateTree } = require('../lib/process-tree.js');

const DIR_IMAGENES = path.join(__dirname, 'imagenes');
const ETIQUETA = 'io.lagrange.harness.version';
const VERSION = /^\d+\.\d+\.\d+$/;
const MARCADOR = 'lotes-construyendo.json';
const TIMEOUT_BUILD_MS = 15 * 60 * 1000;
const TOPE_LINEA = 500;
// Un marcador ilegible más viejo que esto no se está escribiendo: quedó roto (apagón a mitad de la escritura).
const MARCADOR_ROTO_MS = 10000;

const HARNESS = Object.freeze({
  agy: Object.freeze({ nombre: 'Antigravity CLI', imagen: IMAGEN_AGY, dockerfile: 'Dockerfile.agy', arg: 'AGY_VERSION', bin: 'agy' }),
  claude: Object.freeze({ nombre: 'Claude Code', imagen: IMAGEN_CLAUDE, dockerfile: 'Dockerfile.claude', arg: 'CLAUDE_CODE_VERSION', bin: 'claude' })
});

function harnessValido(h) {
  if (!Object.prototype.hasOwnProperty.call(HARNESS, h)) throw new Error(`harness desconocido: ${JSON.stringify(String(h)).slice(0, 40)} (agy o claude)`);
  return HARNESS[h];
}

/** La versión del `ARG <X>_VERSION=` del Dockerfile, o null. */
function versionFijada(h, { dir = DIR_IMAGENES } = {}) {
  const d = harnessValido(h);
  try {
    const m = new RegExp(`^ARG\\s+${d.arg}=(\\d+\\.\\d+\\.\\d+)\\s*$`, 'm').exec(fs.readFileSync(path.join(dir, d.dockerfile), 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * `{ version, fuente: 'etiqueta'|'binario' }`, o null si la imagen no existe.
 * Lanza si Docker no responde (la tarjeta lo muestra como «no se pudo leer»).
 */
async function versionConstruida(docker, h) {
  const d = harnessValido(h);
  const r = await docker(['image', 'inspect', '-f', '{{json .Config.Labels}}', d.imagen], { permitirFallo: true, timeoutMs: 20000 });
  if (r.code !== 0) {
    if (/no such (image|object)/i.test(String(r.stderr || ''))) return null;
    throw new Error(`no se pudo leer la imagen ${d.imagen}: ${sanitizarSalida(r.stderr).trim().slice(0, 200)}`);
  }
  let etiquetas = null;
  try { etiquetas = JSON.parse(String(r.stdout || '').trim() || 'null'); } catch {}
  const v = etiquetas && typeof etiquetas[ETIQUETA] === 'string' ? etiquetas[ETIQUETA].trim() : '';
  if (VERSION.test(v)) return { version: v, fuente: 'etiqueta' };
  const b = await docker(['run', '--rm', '--network', 'none', d.imagen, d.bin, '--version'], { permitirFallo: true, timeoutMs: 60000 });
  const m = /(\d+\.\d+\.\d+)/.exec(String(b.stdout || ''));
  return b.code === 0 && m ? { version: m[1], fuente: 'binario' } : null;
}

/** El argv de `docker build` (sin `wsl -e docker`). `contexto` es la ruta del directorio de imágenes en WSL. */
function argvBuild(h, version, contexto) {
  const d = harnessValido(h);
  if (!VERSION.test(String(version || ''))) throw new Error(`versión inválida para ${d.bin}: ${JSON.stringify(String(version)).slice(0, 40)}`);
  return ['build', '-f', `${contexto}/${d.dockerfile}`, '--build-arg', `${d.arg}=${version}`, '-t', d.imagen, contexto];
}

/** Una línea de la salida, sin credenciales y acotada. `redactar` suma la redacción del bridge (tokens de bot). */
function limpiarLinea(linea, redactar = (x) => x) {
  return redactar(sanitizarSalida(String(linea || '').replace(/\r/g, ''))).slice(0, TOPE_LINEA);
}

/**
 * Corre `wsl -e docker build …` y entrega la salida por líneas. Resuelve con
 * `{ code }`; con timeout corta el árbol del proceso (`terminateTree`: en
 * Windows `kill()` solo mataría `wsl.exe`) y da code 124.
 */
function correrBuild(argv, { alLinea = () => {}, redactar, timeoutMs = TIMEOUT_BUILD_MS, spawnImpl = spawn, terminar = terminateTree, wslBin = 'wsl' } = {}) {
  return new Promise((resolve) => {
    let hijo;
    try {
      hijo = spawnImpl(wslBin, ['-e', 'docker', ...argv], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      alLinea(limpiarLinea(`no se pudo arrancar docker build: ${err.message}`, redactar));
      return resolve({ code: 1 });
    }
    const resto = { out: '', err: '' };
    const consumir = (clave) => (chunk) => {
      const partes = (resto[clave] + String(chunk)).split('\n');
      resto[clave] = partes.pop();
      for (const p of partes) if (p.trim()) alLinea(limpiarLinea(p, redactar));
    };
    hijo.stdout?.on('data', consumir('out'));
    hijo.stderr?.on('data', consumir('err'));
    let vencido = false;
    const timer = setTimeout(() => {
      vencido = true;
      alLinea(`se cortó: pasaron ${Math.round(timeoutMs / 60000)} min`);
      try { terminar(hijo); } catch {}
    }, timeoutMs);
    let listo = false;
    const fin = (code) => {
      if (listo) return;
      listo = true;
      clearTimeout(timer);
      for (const clave of ['out', 'err']) if (resto[clave].trim()) alLinea(limpiarLinea(resto[clave], redactar));
      resolve({ code: vencido ? 124 : (typeof code === 'number' ? code : 1) });
    };
    hijo.on('error', (err) => { alLinea(limpiarLinea(`docker build: ${err.message}`, redactar)); fin(1); });
    hijo.on('close', fin);
  });
}

/**
 * Construye la imagen de un harness con una versión exacta y comprueba que la
 * imagen resultante diga esa versión. `{ ok, version, construida, motivo }`.
 */
async function construirImagen({ docker, aWsl, harness, version, alLinea = () => {}, redactar, dir = DIR_IMAGENES, ...opciones }) {
  const d = harnessValido(harness);
  const contexto = await aWsl(dir);
  const argv = argvBuild(harness, version, contexto);
  alLinea(`docker build ${d.imagen} con ${d.arg}=${version}`);
  const r = await correrBuild(argv, { alLinea, redactar, ...opciones });
  if (r.code !== 0) return { ok: false, version, construida: null, motivo: r.code === 124 ? 'el build pasó el tiempo límite' : `docker build terminó con código ${r.code}` };
  let construida = null;
  try { construida = await versionConstruida(docker, harness); } catch (err) { return { ok: false, version, construida: null, motivo: err.message }; }
  if (!construida || construida.version !== version) {
    return { ok: false, version, construida: construida?.version || null, motivo: `la imagen dice ${construida?.version || 'nada'}, se pidió ${version}` };
  }
  return { ok: true, version, construida: construida.version, motivo: null };
}

/**
 * Lo que lee la tarjeta de Proveedores, con caché: cada recarga de la consola
 * no tiene que ir a Docker. `invalidar()` al terminar un build.
 */
function crearLectorImagenes({ docker, ttlMs = 60000, ahora = Date.now, dir = DIR_IMAGENES } = {}) {
  const cache = new Map();
  return {
    async leer(h) {
      harnessValido(h);
      const c = cache.get(h);
      if (c && ahora() - c.cuando < ttlMs) {
        if (c.error) throw new Error(c.error);
        return c.valor;
      }
      const fijada = versionFijada(h, { dir });
      try {
        const valor = { fijada, construida: await versionConstruida(docker, h) };
        cache.set(h, { cuando: ahora(), valor });
        return valor;
      } catch (err) {
        cache.set(h, { cuando: ahora(), error: err.message });
        throw err;
      }
    },
    invalidar() { cache.clear(); }
  };
}

// ------------------------------------------------------------------ marcador

function rutaMarcador(dirDatos) {
  return path.join(dirDatos, MARCADOR);
}

/** El marcador vigente `{ harness, pid, inicio }`, o null. Uno con el proceso muerto se borra. */
function marcadorVivo(dirDatos, { fsImpl = fs, estaVivo = pidVivo, ahora = Date.now } = {}) {
  if (!dirDatos) return null;
  const ruta = rutaMarcador(dirDatos);
  let datos;
  try { datos = JSON.parse(fsImpl.readFileSync(ruta, 'utf8')); } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    // Ilegible: se está escribiendo justo ahora (wx + write no es atómico) y cuenta como vivo; pero si ya es viejo,
    // quedó roto y se borra (si no, trabaría los lotes hasta que alguien lo borre a mano).
    let mtime = null;
    try { mtime = fsImpl.statSync(ruta).mtimeMs; } catch {}
    if (mtime !== null && ahora() - mtime > MARCADOR_ROTO_MS) {
      try { fsImpl.rmSync(ruta, { force: true }); } catch {}
      return null;
    }
    return { harness: '?', pid: null, inicio: null };
  }
  if (datos && Number.isInteger(datos.pid) && estaVivo(datos.pid)) return datos;
  try { fsImpl.rmSync(ruta, { force: true }); } catch {}
  return null;
}

/** Toma el marcador o lanza si otro proceso lo tiene. Devuelve la función que lo suelta. */
function tomarMarcador(dirDatos, harness, { fsImpl = fs, pid = process.pid, estaVivo = pidVivo, ahora = () => new Date() } = {}) {
  harnessValido(harness);
  const ruta = rutaMarcador(dirDatos);
  fsImpl.mkdirSync(dirDatos, { recursive: true });
  for (let intento = 0; intento < 2; intento++) {
    try {
      fsImpl.writeFileSync(ruta, JSON.stringify({ harness, pid, inicio: ahora().toISOString() }), { flag: 'wx' });
      return () => { try { fsImpl.rmSync(ruta, { force: true }); } catch {} };
    } catch (err) {
      // BE-050 — En Windows un archivo borrándose da EPERM en vez de EEXIST.
      if (!err || (err.code !== 'EEXIST' && err.code !== 'EPERM')) throw err;
      const otro = marcadorVivo(dirDatos, { fsImpl, estaVivo });
      if (otro) throw new Error(`ya se está reconstruyendo la imagen de ${otro.harness}`);
    }
  }
  throw new Error('no se pudo tomar el marcador de construcción');
}

module.exports = {
  HARNESS, ETIQUETA, DIR_IMAGENES, MARCADOR, TIMEOUT_BUILD_MS,
  harnessValido, versionFijada, versionConstruida, argvBuild, limpiarLinea, correrBuild, construirImagen, crearLectorImagenes,
  rutaMarcador, marcadorVivo, tomarMarcador
};
