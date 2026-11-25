/**
 * FEAT-210 §4 — La cola de imágenes de las almas.
 *
 * Aparte de `CARRILES`: un consumidor propio que hace una imagen por vez. El
 * turno no espera: el bot encola la imagen y la entrada `generando` queda en la
 * tarea; el trabajo hace, en orden, revisar que siga habilitada, refinar,
 * generar (probando cada proveedor que puede con ese caso), guardar y mirar.
 *
 * FEAT-212 — Cada pedido tiene un caso (`nueva`, `variacion`, `retoque` o
 * `edicion`). Lo disponible se calcula al empezar y otra vez justo antes de
 * generar, y el caso pasa por `bajarCaso` las dos veces.
 *
 * Toda transición de una entrada pasa por `transicionImagen` (un `actualizar`
 * de la tarea, que avisa con `cambioImagen`). Lo privado (rutas, hilo, vista)
 * va al índice del alma, nunca a la tarea.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Perezosos: importar bot.js (que importa esta cola) no carga la config del MCP (BE-176, «importar no es usar»).
const perezoso = (ruta) => { let m = null; return new Proxy({}, { get: (_, k) => (m ||= require(ruta))[k] }); };
const indice = perezoso('../mcp-server/imagenes/indice.js');
const codigos = perezoso('../mcp-server/imagenes/codigos.js');
const disponible = perezoso('../mcp-server/imagenes/disponible.js');
const refinadorReal = perezoso('../mcp-server/imagenes/refinador.js');
const visionReal = perezoso('../mcp-server/imagenes/vision.js');
const casosLib = perezoso('../mcp-server/imagenes/casos.js');
const catalogos = perezoso('../mcp-server/imagenes/catalogo.js');

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
 * - `catalogoDe(url)`: el catálogo de ComfyUI (de su caché) o `null`;
 * - `refinador`, `vision`, `registrarUso`, `log`, `env` (para las rutas de las almas).
 */
export function crearColaImagenes({
  registro, proveedor, leerConfig = () => disponible.leerImagenes(), refinador = refinadorReal, vision = visionReal,
  catalogoDe = (url) => catalogos.catalogoDe(url), registrarUso = () => {}, log = () => {}, env = process.env, ahora = () => new Date(), manual = undefined
}) {
  const pendientes = [];
  let enCurso = null;
  let colgadoHasta = 0;
  let mapaSha = null;
  let mapaTelegram = null;
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
    // Una sola vez por trabajo: cancelar la que está en curso ya la cerró.
    if (job.cerrado) return;
    job.cerrado = true;
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

  function mapaDeTelegram() {
    if (!mapaTelegram) {
      try { mapaTelegram = indice.construirMapaTelegram(env); } catch { mapaTelegram = new Map(); }
    }
    return mapaTelegram;
  }

  /** FEAT-212 §7 — ¿Estos bytes son el JPEG con que Telegram devolvió una imagen que hizo un alma? */
  function reconocerTelegram(bytes) {
    try { return mapaDeTelegram().get(indice.sha256(bytes)) || null; } catch { return null; }
  }

  /** Los dos mapas se vuelven a armar en la próxima consulta. */
  function invalidarMapas() { mapaSha = null; mapaTelegram = null; }

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
    const job = { intento: 1, ...pedidoJob, n, control: new AbortController(), idEnvio: crypto.randomUUID() };
    if (job.crearEnvio) job.envio = job.crearEnvio(job.clave, n);
    const base = {
      estado: 'generando', pedido: String(job.pedido || '').slice(0, 300), desdeFoto: Boolean(job.desdeFoto), intento: job.intento,
      ancho: 1024, alto: 1024, creada: ahora().toISOString(), terminada: null, codigo: null, mensaje: null,
      sinChequeoZona: undefined, loras: undefined,
      ...(job.prompt ? { prompt: job.prompt, negativo: job.negativo || '' } : {})
    };
    transicionImagen(job.tareaId, n, base);
    // Lo privado entra al índice desde el principio: un reintento de una imagen que falló conserva su hilo, su foto y
    // si era de afuera (sin esto, la imagen reintentada no le llegaba al alma en el turno siguiente).
    try {
      indice.actualizar(job.clave, job.tareaId, n, (p) => ({
        ...(p || {}), hilo: job.hilo || (p && p.hilo) || null, externo: Boolean(job.externo),
        fotoRuta: job.foto ? job.foto.ruta : (p && p.fotoRuta) || null, fotoSegura: Boolean(job.foto && job.foto.segura),
        // FEAT-212 §7 — El id de este intento: una descarga vieja no le pega su sha a la imagen nueva.
        telegram: { sha256: null, envio: job.idEnvio },
        creada: (p && p.creada) || ahora().toISOString()
      }), env);
    } catch (err) {
      log(`[imagenes] no se pudo anotar ${job.tareaId}#${n} en el índice: ${err.message}`);
    }
    mapaTelegram = null;
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

    const conFoto = Boolean(job.desdeFoto && job.foto);
    const disponiblesDe = async (c) => casosLib.disponiblesDe(c, {
      desdeFoto: conFoto, catalogo: c.orden.includes('comfyui') ? await catalogoDe(c.comfyui.url) : null, ...opcionesManual
    });
    // Si otro proveedor del orden hace imágenes pero no puede ahora (agy en manual), se nombra a cada uno con su motivo.
    const sinCaso = (d) => (d.nueva.afuera.some((a) => a.proveedor !== 'comfyui')
      ? error(job, 'sin-proveedor', { intentos: d.nueva.afuera })
      : error(job, 'sin-caso', { motivo: d.nueva.motivo || '' }));

    // 1. Refinar (salvo que la entrada ya traiga su prompt: «otra versión» y reintentar). Todo pasa por `bajarCaso`.
    let disponibles = await disponiblesDe(config);
    if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');
    let r;
    if (job.prompt || job.instruccion) {
      const pedido = { prompt: job.prompt || '', negativo: job.negativo || '', proporcion: job.proporcion || '1:1', zona: job.zona || '', instruccion: job.instruccion || '', loras: job.loras || [] };
      // Una entrada de antes de 2.19 no tiene caso: sale de si lleva foto.
      const casoPedido = job.caso || (conFoto ? 'variacion' : 'nueva');
      const caso = casosLib.bajarCaso(casoPedido, disponibles, pedido);
      if (!caso) return sinCaso(disponibles);
      r = { ...(casosLib.ajustarAlCaso(pedido, caso, disponibles[caso]) || pedido), caso, casoPedido: job.casoPedido || casoPedido };
    } else {
      r = config.refinar
        ? await refinador.refinar({ pedido: job.pedido, mensaje: job.mensaje, foto: job.foto, disponibles, desdeFoto: conFoto, signal, vision, registrarUso, clave: job.clave, origen: job.origen })
        : refinador.sinRefinar(job.pedido, { disponibles, desdeFoto: conFoto });
      if (r.cancelado || signal.aborted) return error(job, job.codigoCorte || 'cancelada');
      // Sin refinar cuando debía: que se vea por qué (el prompt sale en el idioma del alma y con el negativo del perfil).
      if (config.refinar && r.refinado === false) log(`[imagenes] ${job.tareaId}/${job.n}: sin refinar (${String(r.motivo || 'sin motivo').slice(0, 200)}); va el texto del alma`);
      if (r.sinCaso) return sinCaso(disponibles);
    }

    // 2. Generar. Lo disponible se vuelve a mirar: lo que se apagó mientras refinaba vale para esta imagen.
    config = leerConfig();
    if (!habilitada(config, job.clave)) return error(job, 'apagadas');
    disponibles = await disponiblesDe(config);
    if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');
    const caso = casosLib.bajarCaso(r.caso, disponibles, r);
    if (!caso) return sinCaso(disponibles);
    const d = disponibles[caso];
    const hecha = casosLib.ajustarAlCaso(r, caso, d) || r;
    const { prompt, negativo, proporcion, zona, instruccion, loras } = hecha;
    const casoPedido = r.casoPedido || caso;
    const [ancho, alto] = d.perfil.medidas[proporcion];
    const conComfy = d.proveedores.includes('comfyui');
    // Lo que hace falta para repetirla queda en el índice antes de generar: una que falla también se puede repetir.
    try {
      indice.actualizar(job.clave, job.tareaId, job.n, (p) => (p ? {
        ...p, prompt, negativo, proporcion, caso, casoPedido, zona, instruccion, loras: loras.map((l) => l.clave), perfil: conComfy ? d.perfil.id : null
      } : null), env);
    } catch {}
    transicionImagen(job.tareaId, job.n, { prompt, negativo, ancho, alto, caso, casoPedido, zona: zona || null, instruccion: instruccion || null, perfil: conComfy ? d.perfil.id : null });
    const tmp = indice.dirTmp(job.clave, env);
    fs.mkdirSync(tmp, { recursive: true });
    const intentos = [];
    let hecho = null;
    for (const id of d.proveedores) {
      if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');
      const p = proveedor(id, config);
      if (!p) continue;
      transicionImagen(job.tareaId, job.n, { proveedor: id, ancho, alto });
      const destino = path.join(tmp, `${job.tareaId}-${job.n}-${job.intento}-${id}`);
      let g;
      try {
        g = await p.generar({
          caso, modelo: d.modelo, perfil: d.perfil, prompt: id === 'antigravity' ? casosLib.recortarParaAgy(prompt) : prompt, negativo, ancho, alto, semilla: job.semilla,
          foto: caso !== 'nueva' && job.foto ? job.foto.ruta : null, zona, instruccion, loras, signal, destino, origen: job.origen, rol: `alma:${job.clave}`
        });
      } catch (err) {
        log(`[imagenes] ${id} lanzó: ${err.message}`);
        g = { ok: false, codigo: 'error' };
      }
      if (g.colgado) colgadoHasta = Date.now() + ESPERA_COLGADO_MS;
      if (g.ok) { hecho = { ...g, proveedor: id }; break; }
      limpiarTmp(destino);
      if (g.codigo === 'cancelada') return error(job, job.codigoCorte || 'cancelada');
      if (!SIGUE_CON_EL_PROXIMO.has(g.codigo)) return error(job, g.codigo || 'error', g.extra || {});
      intentos.push({ proveedor: id, codigo: g.codigo });
    }
    if (!hecho) {
      const otro = config.orden.some((id) => id !== 'comfyui' && casosLib.declara(id, caso));
      if (!otro && intentos.some((i) => i.proveedor === 'comfyui' && i.codigo === 'no-responde')) return error(job, 'solo-comfyui');
      // Los que ni se probaron (agy en manual, un remoto) también se nombran, en el orden del usuario.
      const todos = [...intentos, ...d.afuera].sort((a, b) => config.orden.indexOf(a.proveedor) - config.orden.indexOf(b.proveedor));
      return error(job, 'sin-proveedor', { intentos: todos });
    }
    // Cortada mientras el proveedor terminaba: lo que devolvió no se guarda ni se manda.
    if (signal.aborted || job.cerrado) { limpiarTmp(hecho.ruta); try { fs.rmSync(hecho.ruta, { force: true }); } catch {} return error(job, job.codigoCorte || 'cancelada'); }

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
      perfil: hecho.proveedor === 'comfyui' ? d.perfil.id : null,
      // Con alma_la_ve, la vista queda `pendiente` hasta que la mirada termine: un turno que llega antes no la toma.
      lista: true, vista: null, vistaOrden: false, vistaEntregada: false,
      vistaEstado: config.alma_la_ve && !signal.aborted ? 'pendiente' : null, vistaDesde: ahora().toISOString(),
      // La hora del archivo nuevo: un reintento de una imagen vieja no queda primero para la poda.
      creada: ahora().toISOString(), intento: job.intento
    }), env);
    // Los intentos anteriores de esa n se borran.
    if (previo && previo.archivo && previo.archivo !== final) { try { fs.rmSync(previo.archivo, { force: true }); } catch {} if (previo.sha256) mapa().delete(previo.sha256); }
    mapa().set(sha, { clave: job.clave, tareaId: job.tareaId, n: job.n });
    transicionImagen(job.tareaId, job.n, {
      estado: 'lista', tipo, ancho: hecho.ancho, alto: hecho.alto, proveedor: hecho.proveedor, modelo: hecho.modelo || null,
      semilla: hecho.semilla ?? null, fotoIgnorada: Boolean(hecho.fotoIgnorada || (conFoto && caso === 'nueva')), perfil: hecho.proveedor === 'comfyui' ? d.perfil.id : null,
      loras: Array.isArray(hecho.loras) && hecho.loras.length ? hecho.loras : undefined, sinChequeoZona: hecho.sinChequeoZona ? true : undefined, codigo: null, mensaje: null, terminada: ahora().toISOString()
    });
    podar(job.clave, job);
    if (job.envio) Promise.resolve().then(() => job.envio({ ok: true, n: job.n, ruta: final, tipo, idEnvio: job.idEnvio })).catch((err) => log(`[imagenes] no se pudo mandar: ${err.message}`));

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
    if (!r.ok) {
      try { indice.actualizar(job.clave, job.tareaId, job.n, (p) => (p ? { ...p, vistaEstado: 'sin-vista' } : null), env); } catch {}
      return;
    }
    try {
      registrarUso(r.porMediador
        ? { tool: 'mediador', motor: 'deepseek', rol: `alma:${job.clave}`, modelo: r.modelo || null, modeloReal: r.modelo || null, esfuerzo: null, conversationId: null, duracion: (Date.now() - inicio) / 1000, usage: r.uso || null, error: null, costoUsd: null, origen: job.origen, cuota: null }
        : { tool: 'mirada_imagen', motor: 'opencode-go', rol: `alma:${job.clave}`, modelo: r.modelo || null, modeloReal: r.modelo || null, esfuerzo: null, conversationId: null, duracion: (Date.now() - inicio) / 1000, usage: r.uso || null, error: null, costoUsd: null, origen: job.origen, cuota: null });
    } catch {}
    try {
      indice.actualizar(job.clave, job.tareaId, job.n, (p) => (p ? { ...p, vista: String(r.texto).slice(0, 600), vistaOrden: Boolean(r.orden), vistaEstado: 'lista' } : null), env);
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
  function podar(clave, actual = null) {
    // La que se acaba de hacer nunca se poda (todavía no se mandó).
    const todas = indice.listar(clave, env).filter((e) => e.archivo && !(actual && e.tareaId === actual.tareaId && e.n === actual.n));
    const sobran = todas.length + (actual ? 1 : 0) - indice.TOPE_POR_ALMA;
    for (let i = 0; i < sobran; i++) {
      const e = todas[i];
      try { fs.rmSync(e.archivo, { force: true }); } catch {}
      const borrada = indice.borrar(clave, e.tareaId, e.n, { sha256: e.sha256 || null, envio: (e.telegram && e.telegram.envio) || null, env });
      // Un Reintento pudo haber escrito otra en la misma `n`: esa no se toca.
      const sigue = borrada ? null : indice.leer(clave, e.tareaId, e.n, env);
      if (!borrada && sigue && sigue.archivo !== e.archivo) continue;
      if (!borrada) log(`[imagenes] no se pudo borrar la entrada de ${e.tareaId}#${e.n} (ocupada); queda para la próxima poda`);
      if (e.sha256) mapa().delete(e.sha256);
      if (e.telegram && e.telegram.sha256) mapaDeTelegram().delete(e.telegram.sha256);
      if (tareaDe(e.tareaId)) transicionImagen(e.tareaId, e.n, { estado: 'borrada', codigo: null, mensaje: 'La imagen ya no está (se borró por el tope).' });
    }
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
      // En el acto (§4): la terminal deja de mostrar «Haciendo la imagen…» sin esperar al proveedor.
      error(enCurso, codigo);
      cuantas++;
    }
    return cuantas;
  }

  /** ¿Tiene imágenes en la cola o en curso este turno? */
  const tieneAbiertas = (tareaId) => pendientes.some((j) => j.tareaId === tareaId) || Boolean(enCurso && enCurso.tareaId === tareaId);

  /** Lo que hace falta para repetir una imagen: lo que guardó el índice (o la entrada, si es de antes de 2.19). */
  function repetir(e, priv) {
    const prompt = e.prompt || priv.prompt || '';
    if (!prompt && !priv.instruccion) return {};
    return {
      prompt: priv.prompt || prompt, negativo: priv.negativo ?? e.negativo ?? '', proporcion: priv.proporcion || '1:1',
      ...(priv.caso ? { caso: priv.caso, casoPedido: priv.casoPedido || priv.caso, zona: priv.zona || '', instruccion: priv.instruccion || '', loras: priv.loras || [] } : {})
    };
  }

  /** §5 — «Otra versión»: la misma imagen con otra semilla, como `n` nueva. `{ ok, n }` o `{ ok: false, codigo }`. */
  function otra(tareaId, n, { envio = null, crearEnvio = null } = {}) {
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
      ...repetir(e, priv), semilla: undefined, envio, crearEnvio, origen: 'usuario'
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
      ...repetir(e, priv),
      // FEAT-212 §5 — Sin la zona no hay qué retocar: va como variación, con el mismo prompt.
      ...(e.codigo === 'zona-no-encontrada' ? { caso: 'variacion', casoPedido: 'retoque', zona: '' } : {}), envio, origen: 'usuario'
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
    // Un nodo (sin claves) no lee el directorio de las almas (FEAT-090 §3.6): mapa vacío.
    mapaSha = claves.length ? null : new Map();
    mapaTelegram = claves.length ? null : new Map();
    if (claves.length) mapa();
  }

  const estadoDeImagenes = () => ({ pendientes: pendientes.length, enCurso: enCurso ? 1 : 0 });

  return { encolar, cancelarImagenes, tieneAbiertas, otra, reintentar, bytesDe, reconocer, reconocerTelegram, invalidarMapas, transicionImagen, estadoDeImagenes, alArrancar, _pendientes: pendientes };
}

/** La clave del alma de una tarea de charla. */
function claveDe(t) {
  return t && t.sujeto && typeof t.sujeto === 'object' ? (t.sujeto.clave || t.sujeto.id || null) : null;
}

export { claveDe };
