#!/usr/bin/env node
'use strict';

/**
 * FEAT-213 §1 — El guardián de ComfyUI: lo lanza (o adopta uno nuestro), escribe el estado y lo apaga.
 *
 * Uso: `node comfyui-keeper.js <pedido.json>`. Lo crea `comfyui-proceso.ps1` fuera del árbol del daemon: cerrar o reiniciar el
 * daemon no lo toca. Si el guardián muere, ComfyUI sigue (su salida va a un archivo) y otro guardián lo adopta.
 *
 * Solo toca el proceso que lanzó o adoptó, con su hora de inicio.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const px = require('./imagenes/comfyui-proceso.js');
const { escribirAtomico } = require('./lib/fs-atomico.js');

const CICLO_MS = Number(process.env.LAGRANGE_COMFYUI_CICLO_MS) || 1000;
const LATIDO_MS = 5000;
const MIRAR_USO_MS = Number(process.env.LAGRANGE_COMFYUI_USO_MS) || 60 * 1000;
/** Un arranque que nunca responde. */
const ARRANQUE_MAX_MS = Number(process.env.LAGRANGE_COMFYUI_ARRANQUE_MS) || 30 * 60 * 1000;
const MINUTO_MS = Number(process.env.LAGRANGE_COMFYUI_MINUTO_MS) || 60 * 1000;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pedido = px.leerJson(process.argv[2]);
  if (!pedido || !pedido.id || !pedido.dir) return 1;
  try { fs.rmSync(process.argv[2], { force: true }); } catch {}
  const rutas = px.rutasDe(pedido.dir);
  // El .ps1 sale de la carpeta durable: la del plugin puede irse con una actualización mientras este proceso sigue.
  const ps1 = (parametros) => px.correrPs1(parametros, { ruta: pedido.ps1 });
  fs.mkdirSync(rutas.dir, { recursive: true });
  const log = (t) => {
    try {
      try { if (fs.statSync(rutas.guardianLog).size > 256 * 1024) fs.truncateSync(rutas.guardianLog, 0); } catch {}
      fs.appendFileSync(rutas.guardianLog, `[${new Date().toISOString()}] [${process.pid}] ${t}\n`);
    } catch {}
  };

  // Un solo guardián. El lock se publica entero (un enlace a un archivo ya escrito): nadie lo lee a medias. Se roba solo si su dueño
  // no está o dejó de renovarlo; uno que no se puede leer ahora es de alguien, salvo que sea viejo.
  const propio = `${rutas.lock}.${process.pid}`;
  const tomar = () => {
    for (let i = 0; i < 3; i++) {
      try {
        fs.writeFileSync(propio, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        try { fs.linkSync(propio, rutas.lock); } catch (err) {
          if (err.code === 'EEXIST') throw err;
          fs.writeFileSync(rutas.lock, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
        }
        return true;
      } catch (err) { if (err.code !== 'EEXIST') return false; } finally { try { fs.rmSync(propio, { force: true }); } catch {} }
      const l = px.leerLock(rutas);
      if (l ? l.vivo : px.esReciente(rutas.lock)) return false;
      try { fs.unlinkSync(rutas.lock); } catch {}
    }
    return false;
  };
  /** ¿Lo tiene otro? Si el archivo no está, se vuelve a tomar; si no se puede leer ahora, sigue siendo mío. */
  const perdido = () => {
    const l = px.leerJson(rutas.lock);
    if (l) return l.pid !== process.pid;
    return !fs.existsSync(rutas.lock) && !tomar();
  };
  const conseguir = async () => { if (!tomar()) return false; await esperar(Math.min(250, CICLO_MS * 2)); return !perdido(); };
  // Al reiniciar, el guardián anterior puede estar terminando.
  let tengo = await conseguir();
  for (let i = 0; i < 30 && !tengo; i++) { await esperar(300); tengo = await conseguir(); }
  if (!tengo) { log('ya hay un guardián; salgo'); return 0; }
  const soltar = () => { const l = px.leerJson(rutas.lock); if (l && l.pid === process.pid) try { fs.unlinkSync(rutas.lock); } catch {} };

  const previo = px.leerJson(rutas.estado);
  let estado;
  const guardar = (cambios) => {
    estado = { ...estado, ...cambios, guardian: process.pid, actualizado: new Date().toISOString() };
    try { escribirAtomico(rutas.estado, JSON.stringify(estado)); } catch (err) { log(`no se pudo escribir el estado: ${err.code || 'error'}`); }
  };

  let hijo = null;
  let salida = null; // el código con que salió el que lancé
  if (pedido.modo === 'adoptar') {
    if (!previo || !previo.proceso || !px.pidVivo(previo.proceso.pid)) { soltar(); return 0; }
    if ((await px.horaDeInicio(previo.proceso.pid, { ps1 })) !== previo.proceso.inicio) { log('el proceso guardado es otro; no se adopta'); soltar(); return 0; }
    estado = previo;
    // La fase la dice la salud: uno que quedó «apagando» sigue siendo nuestro.
    guardar({ pedido: pedido.id, fase: previo.fase === 'levantando' ? 'levantando' : 'encendido', mensaje: null });
    log(`adopté ComfyUI (${previo.proceso.pid})`);
  } else {
    // Al levantar, el log anterior queda de respaldo.
    try { if (fs.statSync(rutas.log).size) { fs.rmSync(`${rutas.log}.1`, { force: true }); fs.renameSync(rutas.log, `${rutas.log}.1`); } } catch {}
    try { fs.rmSync(rutas.orden, { force: true }); } catch {}
    const desde = new Date().toISOString();
    estado = { version: 1, pedido: pedido.id, fase: 'levantando', proceso: null, url: pedido.url, carpeta: pedido.carpeta, desde, mensaje: Array.isArray(pedido.avisos) && pedido.avisos.length ? pedido.avisos.join(' ') : null };
    let fd = null;
    try {
      // 'a' abre solo para agregar: la rotación puede vaciar el archivo en marcha y lo que sigue se escribe al final.
      fd = fs.openSync(rutas.log, 'a');
      hijo = spawn(pedido.python, pedido.args, { cwd: pedido.cwd, env: pedido.env, shell: false, windowsHide: true, detached: true, stdio: ['ignore', fd, fd] });
    } catch (err) {
      guardar({ fase: 'error', mensaje: `no se pudo lanzar (${err.code || 'error'})` });
      soltar();
      return 0;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    const fallo = await new Promise((r) => { hijo.once('error', (err) => r(err)); hijo.once('spawn', () => r(null)); });
    if (fallo) { guardar({ fase: 'error', mensaje: `no se pudo lanzar (${fallo.code || 'error'})` }); soltar(); return 0; }
    hijo.once('exit', (codigo) => { salida = codigo === null ? -1 : codigo; });
    hijo.unref();
    const inicio = await px.horaDeInicio(hijo.pid, { ps1 });
    if (!inicio && salida === null) {
      // Sin su hora no se puede decir que es nuestro: no se deja suelto.
      try { hijo.kill(); } catch {}
      guardar({ fase: 'error', mensaje: 'no pude leer la hora de inicio del proceso' });
      soltar();
      return 0;
    }
    guardar({ proceso: inicio ? { pid: hijo.pid, inicio } : null });
    log(`lancé ComfyUI (${hijo.pid})`);
  }

  const proceso = estado.proceso;
  const vivo = () => (hijo ? salida === null : px.pidVivo(proceso.pid));
  const matar = async () => {
    guardar({ fase: 'apagando', mensaje: null });
    const ok = await px.matarArbol(proceso.pid, proceso.inicio, { ps1 });
    for (let i = 0; i < 20 && vivo(); i++) await esperar(250);
    return ok || !vivo();
  };
  const terminar = (cambios) => { guardar({ proceso: null, ...cambios }); soltar(); };

  const arranque = Date.parse(estado.desde) || Date.now();
  let ultimoUso = Date.now();
  let ultimoTrabajo = null;
  let latido = 0;
  let mirada = Date.now();

  /** ¿Se usó desde la última vez? Su cola, su historial o lo que anotó el daemon. `null` si no contestó. */
  const mirarUso = async () => {
    const u = px.leerJson(rutas.uso);
    if (u && Number.isFinite(u.ts) && u.ts > ultimoUso) ultimoUso = u.ts;
    const cola = await px.colaDe(estado.url);
    if (cola === null) return null;
    if (cola > 0) ultimoUso = Date.now();
    try {
      const r = await fetch(`${estado.url}/history?max_items=1`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      const id = Object.keys(await r.json()).pop() || '';
      if (ultimoTrabajo !== null && id !== ultimoTrabajo) ultimoUso = Date.now();
      ultimoTrabajo = id;
    } catch { return null; }
    return cola;
  };
  const minutos = () => { const u = px.leerJson(rutas.uso); return u && Number.isInteger(u.apagarMin) ? u.apagarMin : 20; };
  const pasado = () => minutos() > 0 && Date.now() - ultimoUso > minutos() * MINUTO_MS;

  for (;;) {
    if (perdido()) {
      // Si el otro lo adoptó, es de él. Si levantó otro, este quedaría suelto.
      const e = px.leerJson(rutas.estado);
      const suyo = Boolean(e && e.proceso && proceso && e.proceso.pid === proceso.pid);
      log(`otro guardián tomó el lugar; salgo${suyo ? '' : ' y apago el mío'}`);
      if (!suyo && proceso && vivo()) await px.matarArbol(proceso.pid, proceso.inicio, { ps1 });
      return 0;
    }
    const t = Date.now();
    if (t - latido >= LATIDO_MS) {
      latido = t;
      try { escribirAtomico(rutas.lock, JSON.stringify({ pid: process.pid, ts: t })); } catch {}
      try {
        if (fs.statSync(rutas.log).size > px.TOPE_LOG) { fs.copyFileSync(rutas.log, `${rutas.log}.1`); fs.truncateSync(rutas.log, 0); }
      } catch {}
    }
    if (!proceso || !vivo()) {
      const lineas = px.ultimasLineas(rutas.log, { n: 3 }).join(' / ');
      log(`ComfyUI se cerró${salida === null ? '' : ` (código ${salida})`}`);
      terminar(estado.fase === 'levantando' || salida
        ? { fase: 'error', mensaje: `ComfyUI se cerró${estado.fase === 'levantando' ? ' al arrancar' : ''}${salida === null ? '' : ` (código ${salida})`}${lineas ? `: ${lineas}` : ''}`.slice(0, 600) }
        : { fase: 'apagado', mensaje: null });
      return 0;
    }
    const orden = px.leerJson(rutas.orden);
    if (orden) {
      try { fs.rmSync(rutas.orden, { force: true }); } catch {}
      if (orden.accion === 'apagar' && orden.pedido === estado.pedido) {
        log('me pidieron apagarlo');
        if (await matar()) { terminar({ fase: 'apagado', mensaje: null }); return 0; }
        guardar({ fase: 'encendido', mensaje: 'no se pudo apagar' });
      }
    }
    if (estado.fase === 'levantando') {
      if ((await px.responde(estado.url)) === 'ok') {
        ultimoUso = Date.now();
        guardar({ fase: 'encendido', mensaje: null });
        log('ComfyUI responde');
      } else if (Date.now() - arranque > ARRANQUE_MAX_MS) {
        log('nunca respondió; lo apago');
        if (await matar()) { terminar({ fase: 'error', mensaje: 'ComfyUI arrancó pero nunca respondió' }); return 0; }
        // No se pudo: sigue siendo nuestro, con su pid, y se vuelve a intentar.
        log('no se pudo apagar');
        guardar({ fase: 'error', mensaje: 'ComfyUI arrancó pero nunca respondió, y no se pudo apagar' });
        mirada = Date.now();
      }
    } else if (estado.fase === 'error') {
      if (t - mirada >= MIRAR_USO_MS) {
        mirada = t;
        if ((await px.responde(estado.url)) === 'ok') guardar({ fase: 'encendido', mensaje: null });
        else {
          const mensaje = estado.mensaje;
          if (await matar()) { terminar({ fase: 'error', mensaje: 'ComfyUI arrancó pero nunca respondió' }); return 0; }
          guardar({ fase: 'error', mensaje });
        }
      }
    } else if (t - mirada >= MIRAR_USO_MS) {
      mirada = t;
      await mirarUso();
      // Justo antes de apagar se mira otra vez: con algo en su cola, o sin respuesta, no se apaga.
      if (pasado() && (await mirarUso()) === 0 && pasado()) {
        log('sin uso; lo apago');
        if (await matar()) { terminar({ fase: 'apagado', mensaje: null }); return 0; }
        guardar({ fase: 'encendido', mensaje: null });
      }
    }
    await esperar(CICLO_MS);
  }
}

if (require.main === module) {
  main().then((c) => process.exit(c || 0), (err) => {
    try {
      const p = px.leerJson(process.argv[2]);
      if (p && p.dir) fs.appendFileSync(path.join(p.dir, 'guardian.log'), `[${new Date().toISOString()}] falló: ${err.message}\n`);
    } catch {}
    process.exit(1);
  });
}
