/**
 * FEAT-210 §4 — La cola de imágenes de las almas.
 *
 * Aparte de `CARRILES`: un consumidor propio que hace una imagen por vez. El
 * turno no espera: el bot encola la imagen y la entrada `generando` queda en la
 * tarea; el trabajo hace, en orden, revisar que siga habilitada, refinar,
 * generar (probando cada proveedor del orden), guardar y mirar.
 *
 * Toda transición de una entrada pasa por `transicionImagen` (un `actualizar`
 * de la tarea, que avisa con `cambioImagen`). Lo privado (rutas, hilo, vista)
 * va al índice del alma, nunca a la tarea.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const indice = require('../mcp-server/imagenes/indice.js');
const codigos = require('../mcp-server/imagenes/codigos.js');
const disponible = require('../mcp-server/imagenes/disponible.js');
const refinadorReal = require('../mcp-server/imagenes/refinador.js');
const visionReal = require('../mcp-server/imagenes/vision.js');

export const TOPE_COLA_IMAGENES = 4;
export const TOPE_IMAGENES_TURNO = 4;
const SIGUE_CON_EL_PROXIMO = new Set(['no-responde', 'no-implementado', 'manual', 'cupo']);
const ESPERA_COLGADO_MS = 300 * 1000;
const EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });

/**
 * Crea la cola. Se inyecta:
 * - `registro`: el módulo de tareas (`tarea(id)` y `actualizar`);
 * - `proveedor(id, imagenes)`: el proveedor con la config vigente (ComfyUI, agy, los remotos);
 * - `leerConfig()`: la sección `imagenes` normalizada, leída ahora;
 * - `refinador`, `vision`, `registrarUso`, `log`, `env` (para las rutas de las almas).
 */
export function crearColaImagenes({
  registro, proveedor, leerConfig = () => disponible.leerImagenes(), refinador = refinadorReal, vision = visionReal,
  registrarUso = () => {}, log = () => {}, env = process.env, ahora = () => new Date(), manual = undefined
}) {
  const pendientes = [];
  let enCurso = null;
  let colgadoHasta = 0;
  let mapaSha = null;
  const opcionesManual = manual ? { manual } : {};

  const tareaDe = (id) => registro.tarea(id);
  const entradas = (id) => { const t = tareaDe(id); return t && Array.isArray(t.imagenes) ? t.imagenes : []; };

  /** La única transición: cambia la entrada `n` de la tarea (o la agrega) y avisa. */
  function transicionImagen(tareaId, n, cambios) {
    const lista = entradas(tareaId).map((e) => ({ ...e }));
    const i = lista.findIndex((e) => e.n === n);
    if (i >= 0) lista[i] = { ...lista[i], ...cambios };
    else lista.push({ n, ...cambios });
    return registro.actualizar(tareaId, { imagenes: lista });
  }

  function error(job, codigo, extra = {}) {
    transicionImagen(job.tareaId, job.n, { estado: 'error', codigo, mensaje: codigos.mensajeDe(codigo, extra), terminada: ahora().toISOString() });
    if (job.envio) Promise.resolve().then(() => job.envio({ ok: false, n: job.n, codigo, mensaje: codigos.mensajeDe(codigo, extra) })).catch(() => {});
  }

  function mapa() {
    if (!mapaSha) {
      try { mapaSha = indice.construirMapa(env); } catch { mapaSha = new Map(); }
    }
    return mapaSha;
  }

  /** §2.2 — ¿Estos bytes son de una imagen que hizo un alma? */
  function reconocer(bytes) {
    try { return mapa().get(indice.sha256(bytes)) || null; } catch { return null; }
  }

  /**
   * Encola una imagen de un turno. `{ ok, n }` o `{ ok: false, codigo }`. `job`:
   * `{ tareaId, clave, hilo, pedido, mensaje, desdeFoto, foto, externo, envio, origen, semilla?, prompt?, negativo?, intento?, n? }`.
   */
  function encolar(pedidoJob) {
    const t = tareaDe(pedidoJob.tareaId);
    if (!t) return { ok: false, codigo: 'error' };
    const lista = entradas(pedidoJob.tareaId);
    const n = pedidoJob.n || (lista.reduce((m, e) => Math.max(m, e.n), 0) + 1);
    if (!pedidoJob.n && lista.length >= TOPE_IMAGENES_TURNO) return { ok: false, codigo: 'tope-turno' };
    const job = { intento: 1, ...pedidoJob, n, control: new AbortController() };
    const base = {
      estado: 'generando', pedido: String(job.pedido || '').slice(0, 300), desdeFoto: Boolean(job.desdeFoto), intento: job.intento,
      ancho: 1024, alto: 1024, creada: ahora().toISOString(), terminada: null, codigo: null, mensaje: null,
      ...(job.prompt ? { prompt: job.prompt, negativo: job.negativo || '' } : {})
    };
    transicionImagen(job.tareaId, n, base);
    if (pendientes.length >= TOPE_COLA_IMAGENES) {
      error(job, 'cola-llena');
      return { ok: false, codigo: 'cola-llena', n };
    }
    pendientes.push(job);
    Promise.resolve().then(siguiente);
    return { ok: true, n };
  }

  async function siguiente() {
    if (enCurso || !pendientes.length) return;
    // ComfyUI no cortó la anterior: no se manda otra hasta que termine o pasen los 300 s.
    if (colgadoHasta > Date.now()) { setTimeout(siguiente, Math.min(5000, colgadoHasta - Date.now())); return; }
    const job = pendientes.shift();
    enCurso = job;
    try {
      await trabajo(job);
    } catch (err) {
      log(`[imagenes] el trabajo de ${job.tareaId}#${job.n} falló: ${err.message}`);
      error(job, 'error');
    } finally {
      enCurso = null;
      setImmediate(siguiente);
    }
  }

  const habilitada = (config, clave) => disponible.habilitadaPara(config, clave, opcionesManual);

  async function trabajo(job) {
    const signal = job.control.signal;
    let config = leerConfig();
    if (!habilitada(config, job.clave)) return error(job, 'apagadas');
    if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');

    // 1. Refinar (salvo que la entrada ya traiga su prompt: «otra versión» y reintentar).
    let prompt = job.prompt;
    let negativo = job.negativo || '';
    let proporcion = job.proporcion || '1:1';
    if (!prompt) {
      const tope = disponible.topeDelPrompt(config, opcionesManual);
      const r = config.refinar
        ? await refinador.refinar({ pedido: job.pedido, mensaje: job.mensaje, foto: job.foto, tope, signal, vision, registrarUso, clave: job.clave, origen: job.origen })
        : refinador.sinRefinar(job.pedido, tope);
      if (r.cancelado || signal.aborted) return error(job, job.codigoCorte || 'cancelada');
      prompt = r.prompt; negativo = r.negativo; proporcion = r.proporcion;
      job.prompt = prompt; job.negativo = negativo; job.proporcion = proporcion;
      const d = dimsDe(config, proporcion);
      transicionImagen(job.tareaId, job.n, { prompt, negativo, ancho: d.ancho, alto: d.alto });
    }

    // 2. Generar: cada proveedor del orden; los que no pueden pasan al siguiente.
    config = leerConfig();
    if (!habilitada(config, job.clave)) return error(job, 'apagadas');
    const tmp = indice.dirTmp(job.clave, env);
    fs.mkdirSync(tmp, { recursive: true });
    const intentos = [];
    let hecho = null;
    for (const id of config.orden) {
      if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');
      const p = proveedor(id, config);
      if (!p) continue;
      const d = p.dimensiones(proporcion);
      transicionImagen(job.tareaId, job.n, { proveedor: id, ancho: d.ancho, alto: d.alto });
      const destino = path.join(tmp, `${job.tareaId}-${job.n}-${job.intento}-${id}`);
      let r;
      try {
        r = await p.generar({ prompt, negativo, ancho: d.ancho, alto: d.alto, semilla: job.semilla, foto: job.desdeFoto && job.foto ? job.foto.ruta : null, fuerza: 0.6, signal, destino, origen: job.origen, rol: `alma:${job.clave}` });
      } catch (err) {
        log(`[imagenes] ${id} lanzó: ${err.message}`);
        r = { ok: false, codigo: 'error' };
      }
      if (r.colgado) colgadoHasta = Date.now() + ESPERA_COLGADO_MS;
      if (r.ok) { hecho = { ...r, proveedor: id }; break; }
      limpiarTmp(destino);
      if (r.codigo === 'cancelada') return error(job, job.codigoCorte || 'cancelada');
      if (!SIGUE_CON_EL_PROXIMO.has(r.codigo)) return error(job, r.codigo || 'error');
      intentos.push({ proveedor: id, codigo: r.codigo });
    }
    if (!hecho) return error(job, 'sin-proveedor', { intentos });

    // 3. Guardar: se mueve al nombre final, con su archivo de índice.
    const tipo = hecho.tipo || 'image/png';
    const final = indice.rutaArchivo(job.clave, job.tareaId, job.n, job.intento, EXT[tipo] || 'png', env);
    fs.mkdirSync(path.dirname(final), { recursive: true });
    fs.renameSync(hecho.ruta, final);
    const bytes = fs.readFileSync(final);
    const sha = indice.sha256(bytes);
    // La imagen derivada de una foto segura no contamina; de una foto de afuera o de un hilo ya externo, sí.
    const externo = Boolean(job.externo) || Boolean(job.desdeFoto && job.foto && !job.foto.segura);
    const previo = indice.leer(job.clave, job.tareaId, job.n, env);
    indice.actualizar(job.clave, job.tareaId, job.n, (p) => ({
      ...(p || {}), archivo: final, tipo, fotoRuta: job.foto ? job.foto.ruta : null, fotoSegura: Boolean(job.foto && job.foto.segura),
      hilo: job.hilo || null, externo, sha256: sha, prompt, negativo, proporcion, semilla: hecho.semilla ?? null,
      lista: true, vista: null, vistaOrden: false, vistaEntregada: false, creada: (p && p.creada) || ahora().toISOString(), intento: job.intento
    }), env);
    // Los intentos anteriores de esa n se borran.
    if (previo && previo.archivo && previo.archivo !== final) { try { fs.rmSync(previo.archivo, { force: true }); } catch {} if (previo.sha256) mapa().delete(previo.sha256); }
    mapa().set(sha, { clave: job.clave, tareaId: job.tareaId, n: job.n });
    transicionImagen(job.tareaId, job.n, {
      estado: 'lista', tipo, ancho: hecho.ancho, alto: hecho.alto, proveedor: hecho.proveedor, modelo: hecho.modelo || null,
      semilla: hecho.semilla ?? null, fotoIgnorada: Boolean(hecho.fotoIgnorada), codigo: null, mensaje: null, terminada: ahora().toISOString()
    });
    podar(job.clave);
    if (job.envio) Promise.resolve().then(() => job.envio({ ok: true, n: job.n, ruta: final, tipo })).catch((err) => log(`[imagenes] no se pudo mandar: ${err.message}`));

    // 4. Mirar (§2.1): lo que salió, para el turno siguiente del mismo hilo.
    if (config.alma_la_ve && !signal.aborted) await mirar(job, final, prompt);
  }

  async function mirar(job, ruta, prompt) {
    const inicio = Date.now();
    let r;
    try {
      r = await vision.llamar({ partes: { texto: 'Describí esta imagen.', imagen: { ruta } }, modo: 'mirar', signal: job.control.signal });
    } catch (err) {
      r = { ok: false, motivo: err.message };
    }
    if (!r.ok && !r.cancelado) {
      // Sin visión de Go: la del mediador (deepseek-flash), como una foto.
      try {
        const mediador = require('../mcp-server/almas/mediador.js');
        const m = await mediador.describirImagen({ ruta }, { signal: job.control.signal });
        if (m.ok) {
          r = { ok: true, texto: m.texto.slice(0, 600), orden: m.orden, modelo: m.modelo, uso: m.uso, porMediador: true };
        }
      } catch {}
    }
    if (!r.ok) return;
    try {
      registrarUso(r.porMediador
        ? { tool: 'mediador', motor: 'deepseek', rol: `alma:${job.clave}`, modelo: r.modelo || null, modeloReal: r.modelo || null, esfuerzo: null, conversationId: null, duracion: (Date.now() - inicio) / 1000, usage: r.uso || null, error: null, costoUsd: null, origen: job.origen, cuota: null }
        : { tool: 'mirada_imagen', motor: 'opencode-go', rol: `alma:${job.clave}`, modelo: r.modelo || null, modeloReal: r.modelo || null, esfuerzo: null, conversationId: null, duracion: (Date.now() - inicio) / 1000, usage: r.uso || null, error: null, costoUsd: null, origen: job.origen, cuota: null });
    } catch {}
    try {
      indice.actualizar(job.clave, job.tareaId, job.n, (p) => (p ? { ...p, vista: String(r.texto).slice(0, 600), vistaOrden: Boolean(r.orden) } : null), env);
    } catch (err) {
      log(`[imagenes] no se pudo guardar la vista: ${err.message}`);
    }
    void prompt;
  }

  function limpiarTmp(destino) {
    try {
      const dir = path.dirname(destino);
      const base = path.basename(destino);
      for (const f of fs.readdirSync(dir)) if (f.startsWith(base)) fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }

  /** El tope de 500 por alma: la más vieja se borra; su entrada pasa a `borrada` si la tarea sigue. */
  function podar(clave) {
    const todas = indice.listar(clave, env).filter((e) => e.archivo);
    const sobran = todas.length - indice.TOPE_POR_ALMA;
    for (let i = 0; i < sobran; i++) {
      const e = todas[i];
      try { fs.rmSync(e.archivo, { force: true }); } catch {}
      if (e.sha256) mapa().delete(e.sha256);
      indice.borrar(clave, e.tareaId, e.n, env);
      if (tareaDe(e.tareaId)) transicionImagen(e.tareaId, e.n, { estado: 'borrada', codigo: null, mensaje: 'La imagen ya no está (se borró por el tope).' });
    }
  }

  function dimsDe(config, proporcion) {
    const id = disponible.primeroQuePuede(config, opcionesManual);
    const p = id ? proveedor(id, config) : null;
    return p ? p.dimensiones(proporcion) : { ancho: 1024, alto: 1024 };
  }

  /**
   * Cancela imágenes: todas, las de un alma (`clave`), las de un turno (`tareaId`) o una sola (`tareaId` y `n`).
   * Aborta la que esté en curso, saca lo pendiente y pasa cada entrada tocada a `error` con `codigo`. Devuelve cuántas.
   */
  function cancelarImagenes({ clave = null, tareaId = null, n = null, codigo = 'cancelada' } = {}) {
    const toca = (j) => (!clave || j.clave === clave) && (!tareaId || j.tareaId === tareaId) && (n === null || j.n === n);
    let cuantas = 0;
    for (let i = pendientes.length - 1; i >= 0; i--) {
      const j = pendientes[i];
      if (!toca(j)) continue;
      pendientes.splice(i, 1);
      error(j, codigo);
      cuantas++;
    }
    if (enCurso && toca(enCurso)) {
      enCurso.codigoCorte = codigo;
      enCurso.control.abort();
      cuantas++;
    }
    return cuantas;
  }

  /** ¿Tiene imágenes en la cola o en curso este turno? */
  const tieneAbiertas = (tareaId) => pendientes.some((j) => j.tareaId === tareaId) || Boolean(enCurso && enCurso.tareaId === tareaId);

  /** §5 — «Otra versión»: la misma imagen con otra semilla, como `n` nueva. `{ ok, n }` o `{ ok: false, codigo }`. */
  function otra(tareaId, n, { envio = null } = {}) {
    const config = leerConfig();
    if (!config.otra_version) return { ok: false, codigo: 'apagada' };
    const t = tareaDe(tareaId);
    const e = entradas(tareaId).find((x) => x.n === n);
    if (!t || !e) return { ok: false, codigo: 'no-existe' };
    if (entradas(tareaId).length >= TOPE_IMAGENES_TURNO) return { ok: false, codigo: 'tope-turno' };
    const clave = claveDe(t);
    const priv = indice.leer(clave, tareaId, n, env) || {};
    if (e.desdeFoto && priv.fotoRuta && !fs.existsSync(priv.fotoRuta)) return { ok: false, codigo: 'foto-perdida' };
    if (e.desdeFoto && !priv.fotoRuta) return { ok: false, codigo: 'foto-perdida' };
    return encolar({
      tareaId, clave, hilo: priv.hilo || null, pedido: e.pedido, mensaje: '', desdeFoto: e.desdeFoto,
      foto: e.desdeFoto ? { ruta: priv.fotoRuta, segura: Boolean(priv.fotoSegura) } : null, externo: Boolean(priv.externo),
      prompt: e.prompt || priv.prompt, negativo: e.negativo || priv.negativo || '', proporcion: priv.proporcion || '1:1', semilla: undefined, envio, origen: 'usuario'
    });
  }

  /** §5 — Reintentar una entrada en `error`: la misma `n`, un intento nuevo. */
  function reintentar(tareaId, n, { envio = null } = {}) {
    const t = tareaDe(tareaId);
    const e = entradas(tareaId).find((x) => x.n === n);
    if (!t || !e) return { ok: false, codigo: 'no-existe' };
    if (e.estado !== 'error') return { ok: false, codigo: 'no-en-error' };
    const clave = claveDe(t);
    const priv = indice.leer(clave, tareaId, n, env) || {};
    const fotoRuta = priv.fotoRuta || (t.imagenFoto || null);
    if (e.desdeFoto && (!fotoRuta || !fs.existsSync(fotoRuta))) return { ok: false, codigo: 'foto-perdida' };
    return encolar({
      tareaId, clave, n, intento: (e.intento || 1) + 1, hilo: priv.hilo || null, pedido: e.pedido, mensaje: '', desdeFoto: e.desdeFoto,
      foto: e.desdeFoto ? { ruta: fotoRuta, segura: Boolean(priv.fotoSegura) } : null, externo: Boolean(priv.externo),
      ...(e.prompt ? { prompt: e.prompt, negativo: e.negativo || '' } : {}), envio, origen: 'usuario'
    });
  }

  /** Los bytes de una imagen lista (§5). `{ ok, bytes, tipo }` o `{ ok: false, codigo }`. */
  function bytesDe(tareaId, n) {
    const t = tareaDe(tareaId);
    const e = entradas(tareaId).find((x) => x.n === n);
    if (!t || !e || e.estado !== 'lista') return { ok: false, codigo: 404 };
    const priv = indice.leer(claveDe(t), tareaId, n, env);
    if (!priv || !priv.archivo) return { ok: false, codigo: 404 };
    try {
      const st = fs.statSync(priv.archivo);
      if (st.size > 20 * 1024 * 1024) return { ok: false, codigo: 404 };
      return { ok: true, bytes: fs.readFileSync(priv.archivo), tipo: priv.tipo || e.tipo || 'image/png' };
    } catch {
      return { ok: false, codigo: 404 };
    }
  }

  /** Al arrancar: vacía los `.tmp/` de todas las almas y arma el mapa `sha256`. */
  function alArrancar(claves = []) {
    for (const c of claves) indice.vaciarTmp(c, env);
    mapaSha = null;
    mapa();
  }

  const estadoDeImagenes = () => ({ pendientes: pendientes.length, enCurso: enCurso ? 1 : 0 });

  return { encolar, cancelarImagenes, tieneAbiertas, otra, reintentar, bytesDe, reconocer, transicionImagen, estadoDeImagenes, alArrancar, _pendientes: pendientes };
}

/** La clave del alma de una tarea de charla. */
function claveDe(t) {
  return t && t.sujeto && typeof t.sujeto === 'object' ? (t.sujeto.clave || t.sujeto.id || null) : null;
}

export { claveDe };
