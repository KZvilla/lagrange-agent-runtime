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
 *
 * FEAT-213 — Si ComfyUI no responde y se puede levantar, el trabajo espera aparte
 * (`esperando`): la cola sigue con los demás. Una imagen puede tener una base fija
 * (`baseFija`: nunca sale una nueva en su lugar) o una foto que el refinador puede
 * no usar (`fotoOpcional`).
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
const perfilesLib = perezoso('../mcp-server/imagenes/perfiles.js');

export const TOPE_COLA_IMAGENES = 4;
export const TOPE_IMAGENES_TURNO = 4;
// FEAT-213 — Las que esperan que levante ComfyUI tienen su propio tope: no le quitan lugar a las demás.
export const TOPE_ESPERANDO = 4;
const USO_MS = 30 * 1000;
const SIGUE_CON_EL_PROXIMO = new Set(['no-responde', 'no-implementado', 'manual', 'cupo', 'otro-programa']);
const ESPERA_COLGADO_MS = 300 * 1000;
const EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });

/**
 * Crea la cola. Se inyecta:
 * - `registro`: el módulo de tareas (`tarea(id)` y `actualizar`);
 * - `proveedor(id, imagenes)`: el proveedor con la config vigente (ComfyUI, agy, los remotos);
 * - `leerConfig()`: la sección `imagenes` normalizada, leída ahora;
 * - `catalogoDe(url)`: el catálogo de ComfyUI (de su caché) o `null`;
 * - FEAT-218: `catalogoEnCache(url)`: el catálogo que ya está en la caché, sin pedirlo, o `null`;
 * - `refinador`, `vision`, `registrarUso`, `log`, `env` (para las rutas de las almas);
 * - FEAT-213: `comfy` (`comprobar(config)`, `levantar(config)` y `anotarUso(config)` del proceso de ComfyUI), `dirAdjuntos()`,
 *   `fotosEnUso()` (las rutas de las fotos de los turnos abiertos) y `alCambiar(clave)` (una imagen nueva, borrada o podada).
 */
export function crearColaImagenes({
  registro, proveedor, leerConfig = () => disponible.leerImagenes(), refinador = refinadorReal, vision = visionReal,
  catalogoDe = (url) => catalogos.catalogoDe(url), catalogoEnCache = (url) => catalogos.enCache(url), registrarUso = () => {}, log = () => {}, env = process.env, ahora = () => new Date(), manual = undefined,
  comfy = null, dirAdjuntos = () => null, fotosEnUso = () => [], alCambiar = () => {},
  // FEAT-214 — `preparar(datos)` → `{ ok, id }` y `fallo({ tareaId, clave, codigo })`: «Que lo prepare el alma».
  taller = null
}) {
  const pendientes = [];
  const esperando = new Set();
  let relojUso = null;
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

  function cambio(clave) { try { alCambiar(clave); } catch {} }

  /** FEAT-213 — El uso que ve el guardián de ComfyUI: al encolar y cada 30 s mientras haya alguna. */
  function anotarUso() {
    if (!comfy) return;
    const uno = () => { try { comfy.anotarUso(leerConfig()); } catch {} };
    uno();
    if (relojUso) return;
    relojUso = setInterval(() => {
      if (pendientes.length || enCurso || esperando.size) return uno();
      clearInterval(relojUso);
      relojUso = null;
    }, USO_MS);
    relojUso.unref?.();
  }

  function error(job, codigo, extra = {}) {
    // Una sola vez por trabajo: cancelar la que está en curso ya la cerró.
    if (job.cerrado) return;
    job.cerrado = true;
    transicionImagen(job.tareaId, job.n, { estado: 'error', codigo, mensaje: codigos.mensajeDe(codigo, extra), terminada: ahora().toISOString() });
    if (job.destino === 'taller' && taller) { try { taller.fallo({ tareaId: job.tareaId, clave: job.clave, codigo }); } catch {} }
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

  /** FEAT-215 — El número de la imagen de esa alma que es esta foto (por su lugar o por sus bytes), o `null`. */
  function numeroDeFoto(clave, ruta) {
    try {
      let e = indice.porRuta(clave, ruta, env);
      if (!e) {
        const x = reconocer(fs.readFileSync(ruta));
        e = x && x.clave === clave ? indice.leer(clave, x.tareaId, x.n, env) : null;
      }
      return (e && e.num) || null;
    } catch {
      return null;
    }
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
    // FEAT-213 — Una base de afuera de las carpetas de siempre no se lee.
    const permitida = job.foto ? fotoPermitida(job.foto.ruta) : null;
    if (permitida) job.foto = { ...job.foto, ruta: permitida };
    const base = {
      estado: 'generando', pedido: String(job.pedido || '').slice(0, 600), desdeFoto: Boolean(job.desdeFoto), intento: job.intento,
      ancho: 1024, alto: 1024, creada: ahora().toISOString(), terminada: null, codigo: null, mensaje: null,
      sinChequeoZona: undefined, loras: undefined, cambio: undefined, fuerza: undefined,
      ...(job.prompt ? { prompt: job.prompt, negativo: job.negativo || '' } : {})
    };
    // FEAT-215 — De dónde sale: quién la pidió, de cuál es otra versión y, si parte de una imagen del alma, su número.
    const previa = pedidoJob.n ? indice.leer(job.clave, job.tareaId, n, env) : null;
    const origenImagen = job.origenImagen || (previa ? indice.origenDe(previa) : 'alma');
    const deNum = job.deNum || (previa && previa.deNum) || null;
    const baseNum = job.foto ? numeroDeFoto(job.clave, job.foto.ruta) : null;
    Object.assign(base, { origen: origenImagen, deNum: deNum || undefined, baseNum: baseNum || undefined, elegida: undefined });
    transicionImagen(job.tareaId, n, base);
    // Lo privado entra al índice desde el principio: un reintento de una imagen que falló conserva su hilo, su foto y
    // si era de afuera (sin esto, la imagen reintentada no le llegaba al alma en el turno siguiente).
    try {
      indice.actualizar(job.clave, job.tareaId, n, (p) => ({
        ...(p || {}), hilo: job.hilo || (p && p.hilo) || null, externo: Boolean(job.externo),
        fotoRuta: job.foto ? job.foto.ruta : (p && p.fotoRuta) || null, fotoSegura: Boolean(job.foto && job.foto.segura),
        baseFija: Boolean(job.baseFija), fotoOpcional: Boolean(job.fotoOpcional), origen: origenImagen, deNum, baseNum, elegida: null,
        // FEAT-212 §7 — El id de este intento: una descarga vieja no le pega su sha a la imagen nueva.
        telegram: { sha256: null, envio: job.idEnvio },
        creada: (p && p.creada) || ahora().toISOString()
      }), env);
    } catch (err) {
      log(`[imagenes] no se pudo anotar ${job.tareaId}#${n} en el índice: ${err.message}`);
    }
    mapaTelegram = null;
    if (job.foto && !permitida) {
      log(`[imagenes] la foto de ${job.tareaId}#${n} está fuera de su carpeta; no se usa`);
      error(job, 'foto-perdida');
      return { ok: false, codigo: 'foto-perdida', n };
    }
    if (pendientes.length >= TOPE_COLA_IMAGENES) {
      error(job, 'cola-llena');
      return { ok: false, codigo: 'cola-llena', n };
    }
    pendientes.push(job);
    anotarUso();
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
      if (await esperarComfy(job)) return;
      await trabajo(job);
    } catch (err) {
      log(`[imagenes] el trabajo de ${job.tareaId}#${job.n} falló: ${err.message}`);
      error(job, 'error');
    } finally {
      enCurso = null;
      setImmediate(siguiente);
    }
  }

  /**
   * FEAT-213 — ¿ComfyUI es el primero que puede con este trabajo? Una foto que podía no usarse, sin refinar todavía, puede ir a
   * cualquiera de los dos: para levantarlo cuenta (`opcional: true`); para cortarla, solo si una nueva también va a él.
   */
  function primeroComfy(job, config, { opcional = false } = {}) {
    const conFoto = Boolean((job.desdeFoto || (job.fotoOpcional && (opcional || job.caso))) && job.foto);
    const caso = job.caso || (conFoto ? 'variacion' : 'nueva');
    // FEAT-218 — El modelo al que va a caer el trabajo: el de una repetición si todavía puede; si no, el fijo. Con el
    // catálogo de la caché, un modelo que ya no está instalado no cuenta (sin caché, como antes: no se sabe).
    const enCache = job.modelo && config.orden.includes('comfyui') ? catalogoEnCache(config.comfyui.url) : null;
    const modelo = modeloQuePuede(config, job.modelo, caso, enCache || null);
    const d = casosLib.disponiblesDe(config, { desdeFoto: conFoto, catalogo: null, ...opcionesManual, modelo })[caso];
    return Boolean(d && d.proveedores[0] === 'comfyui');
  }

  /** FEAT-218 — `modelo` si el caso usa `comfyui.modelo` y ComfyUI puede con él; si no, `null` (el fijo). */
  function modeloQuePuede(config, modelo, caso, catalogo) {
    if (typeof modelo !== 'string' || !modelo || !casosLib.usaModeloPrincipal(config, caso)) return null;
    return casosLib.estadoComfyui(config, caso, catalogo, { modelo }).puede ? modelo : null;
  }

  /**
   * FEAT-213 — ¿Hay que levantar ComfyUI para este trabajo? Si sí, el trabajo queda en `esperando` y vuelve a la cola cuando
   * ComfyUI responde o la espera se acaba. `true` si quedó esperando (o cerrado).
   */
  async function esperarComfy(job) {
    if (!comfy || job.comfyVisto || job.control.signal.aborted) return false;
    job.comfyVisto = true;
    const config = leerConfig();
    if (!config.comfyui.arranque || !config.comfyui.arranque.carpeta || !config.comfyui.arranque.automatico) return false;
    if (!habilitada(config, job.clave)) return false;
    if (!primeroComfy(job, config, { opcional: true })) return false;
    if ((await comfy.comprobar(config)) !== 'no-responde') return false;
    if (job.control.signal.aborted) return false;
    const promesa = comfy.levantar(config);
    if (!promesa) return false;
    if (esperando.size >= TOPE_ESPERANDO) { error(job, 'cola-llena'); return true; }
    esperando.add(job);
    transicionImagen(job.tareaId, job.n, { mensaje: 'Levantando ComfyUI…' });
    Promise.resolve(promesa).catch(() => null).then(() => {
      if (!esperando.delete(job) || job.cerrado) return;
      transicionImagen(job.tareaId, job.n, { mensaje: null });
      pendientes.unshift(job);
      siguiente();
    });
    return true;
  }

  const habilitada = (config, clave) => disponible.habilitadaPara(config, clave, opcionesManual);

  async function trabajo(job) {
    const signal = job.control.signal;
    let config = leerConfig();
    if (!habilitada(config, job.clave)) return error(job, 'apagadas');
    if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');

    const conFoto = Boolean((job.desdeFoto || job.fotoOpcional) && job.foto);
    const base = conFoto && job.baseFija ? 'fija' : conFoto && job.fotoOpcional ? 'opcional' : null;
    const catalogoPara = async (c) => (c.orden.includes('comfyui') ? await catalogoDe(c.comfyui.url) : null);
    // FEAT-218 — `modelo`: el elegido por el refinador o el de una repetición (si no, el fijo).
    const disponiblesDe = async (c, modelo = null) => casosLib.disponiblesDe(c, { desdeFoto: conFoto, catalogo: await catalogoPara(c), ...opcionesManual, modelo });
    // Si otro proveedor del orden hace imágenes pero no puede ahora (agy en manual), se nombra a cada uno con su motivo.
    const sinCaso = (d) => (base === 'fija' ? error(job, 'sin-base') : d.nueva.afuera.some((a) => a.proveedor !== 'comfyui')
      ? error(job, 'sin-proveedor', { intentos: d.nueva.afuera })
      : error(job, 'sin-caso', { motivo: d.nueva.motivo || '' }));

    // 1. Refinar (salvo que la entrada ya traiga su prompt: «otra versión» y reintentar). Todo pasa por `bajarCaso`.
    let disponibles = await disponiblesDe(config);
    if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');
    let r;
    if (job.prompt || job.instruccion) {
      const pedido = { prompt: job.prompt || '', negativo: job.negativo || '', proporcion: job.proporcion || '1:1', zona: job.zona || '', instruccion: job.instruccion || '', loras: job.loras || [], cambio: job.cambio || null, fuerza: job.fuerza ?? null };
      // Una entrada de antes de 2.19 no tiene caso: sale de si lleva foto.
      const casoPedido = job.caso || (conFoto ? 'variacion' : 'nueva');
      // FEAT-218 — Una repetición de una que eligió el refinador: el mismo modelo, si todavía puede el caso (antes de bajar,
      // así un retoque no se vuelve variación porque el modelo de antes ya no está).
      let modelo = null;
      if (job.modelo) {
        modelo = modeloQuePuede(config, job.modelo, casoPedido, await catalogoPara(config));
        if (modelo) disponibles = await disponiblesDe(config, modelo);
        else log(`[imagenes] ${job.tareaId}/${job.n}: el modelo de antes ya no puede este caso; va el de siempre.`);
      }
      const caso = casosLib.bajarCaso(casoPedido, disponibles, pedido, { base: base === 'fija' });
      if (!caso) return sinCaso(disponibles);
      r = { ...(casosLib.ajustarAlCaso(pedido, caso, disponibles[caso]) || pedido), caso, casoPedido: job.casoPedido || casoPedido, ...(modelo ? { modelo, modeloAuto: true } : {}) };
    } else {
      // FEAT-218 — Los modelos entre los que elige el refinador (o `null`: el fijo, como siempre).
      const candidatos = config.refinar ? casosLib.candidatosDe(config, { desdeFoto: conFoto, catalogo: await catalogoPara(config), ...opcionesManual }) : null;
      r = config.refinar
        ? await refinador.refinar({ pedido: job.pedido, mensaje: job.mensaje, foto: job.foto, disponibles, candidatos, desdeFoto: conFoto, base, fuerzaAutomatica: config.fuerza_automatica !== false, signal, vision, registrarUso, clave: job.clave, origen: job.origen })
        : refinador.sinRefinar(job.pedido, { disponibles, desdeFoto: conFoto, base });
      if (r.cancelado || signal.aborted) return error(job, job.codigoCorte || 'cancelada');
      // Sin refinar cuando debía: que se vea por qué (el prompt sale en el idioma del alma y con el negativo del perfil).
      if (config.refinar && r.refinado === false) log(`[imagenes] ${job.tareaId}/${job.n}: sin refinar (${String(r.motivo || 'sin motivo').slice(0, 200)}); va el texto del alma`);
      if (r.modeloDescartado) log(`[imagenes] ${job.tareaId}/${job.n}: el refinador eligió "${String(r.modeloDescartado).slice(0, 60)}", que no puede este pedido; va el de siempre.`);
      if (r.sinCaso) return sinCaso(disponibles);
    }

    // 2. Generar. Lo disponible se vuelve a mirar: lo que se apagó mientras refinaba vale para esta imagen.
    config = leerConfig();
    if (!habilitada(config, job.clave)) return error(job, 'apagadas');
    // FEAT-218 — El elegido, otra vez: una repetición solo pide que siga pudiendo; una elección de este trabajo, además, que
    // siga entre los candidatos con la casilla prendida.
    let modeloElegido = null;
    if (r.modelo) {
      const sigue = job.modelo || (config.comfyui.modelo_automatico !== false && Array.isArray(config.comfyui.candidatos) && config.comfyui.candidatos.some((c) => perfilesLib.mismoArchivo(c.archivo, r.modelo)));
      modeloElegido = sigue ? modeloQuePuede(config, r.modelo, r.caso, await catalogoPara(config)) : null;
      if (!modeloElegido) log(`[imagenes] ${job.tareaId}/${job.n}: el modelo elegido ya no está o no puede; va el de siempre.`);
    }
    disponibles = await disponiblesDe(config, modeloElegido);
    if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');
    const caso = casosLib.bajarCaso(r.caso, disponibles, r, { base: base === 'fija' });
    if (!caso) return sinCaso(disponibles);
    const d = disponibles[caso];
    // Solo cuenta como elegido si el caso que quedó usa ese modelo y lo hace ComfyUI.
    const modeloAuto = Boolean(modeloElegido && casosLib.usaModeloPrincipal(config, caso) && d.proveedores.includes('comfyui'));
    const hecha = casosLib.ajustarAlCaso(r, caso, d) || r;
    const { prompt, negativo, proporcion, zona, instruccion, loras, cambio: cuanto = null, fuerza = null } = hecha;
    // FEAT-213 — Con una foto que podía no usarse, la entrada dice lo que pasó.
    const desdeFoto = job.fotoOpcional ? conFoto && caso !== 'nueva' : Boolean(job.desdeFoto);
    const casoPedido = r.casoPedido || caso;
    const [ancho, alto] = d.perfil.medidas[proporcion];
    const conComfy = d.proveedores.includes('comfyui');
    // Lo que hace falta para repetirla queda en el índice antes de generar: una que falla también se puede repetir.
    try {
      indice.actualizar(job.clave, job.tareaId, job.n, (p) => (p ? {
        ...p, prompt, negativo, proporcion, caso, casoPedido, zona, instruccion, loras: loras.map((l) => l.clave), perfil: conComfy ? d.perfil.id : null,
        cambio: cuanto, fuerza,
        // FEAT-218 — El modelo elegido, para que «otra versión» y reintentar lo repitan.
        ...(modeloAuto ? { modelo: d.modelo } : {}), modeloAuto
      } : null), env);
    } catch {}
    // FEAT-218 — `modeloAuto: false` explícito: un `true` de un intento anterior de esta `n` no sobrevive.
    transicionImagen(job.tareaId, job.n, { prompt, negativo, ancho, alto, caso, casoPedido, zona: zona || null, instruccion: instruccion || null, perfil: conComfy ? d.perfil.id : null, desdeFoto, cambio: cuanto || undefined, fuerza: fuerza ?? undefined, modeloAuto: false });
    // FEAT-214 — «Que lo prepare el alma»: no se genera. Queda un preparado para abrir en el taller, solo si lo puede ComfyUI.
    if (job.destino === 'taller') return prepararParaElTaller(job, { caso, casoPedido, d, conComfy, conFoto, prompt, negativo, proporcion, ancho, alto, zona, instruccion, loras, cuanto, fuerza, modeloAuto });
    const tmp = indice.dirTmp(job.clave, env);
    fs.mkdirSync(tmp, { recursive: true });
    const intentos = [];
    let hecho = null;
    for (const id of d.proveedores) {
      if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');
      const p = proveedor(id, config);
      if (!p) continue;
      transicionImagen(job.tareaId, job.n, { proveedor: id, ancho, alto });
      job.proveedor = id;
      // FEAT-213 — Si en esa dirección contesta otra cosa, no recibe nada.
      if (id === 'comfyui' && comfy) {
        const estado = await comfy.comprobar(config);
        if (signal.aborted) return error(job, job.codigoCorte || 'cancelada');
        if (estado !== 'ok') { intentos.push({ proveedor: id, codigo: estado }); continue; }
      }
      const destino = path.join(tmp, `${job.tareaId}-${job.n}-${job.intento}-${id}`);
      let g;
      try {
        g = await p.generar({
          caso, modelo: d.modelo, perfil: d.perfil, prompt: id === 'antigravity' ? casosLib.recortarParaAgy(prompt) : prompt, negativo, ancho, alto, semilla: job.semilla, fuerza,
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
    job.proveedor = null;
    if (!hecho) {
      if (base === 'fija') return error(job, 'sin-base');
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
    const externo = Boolean(job.externo) || Boolean(conFoto && !job.foto.segura);
    const previo = indice.leer(job.clave, job.tareaId, job.n, env);
    // FEAT-215 — Su número: el mismo si se reintentó. Sin él, la imagen igual vale.
    let num = (previo && previo.num) || null;
    for (let i = 0; !num && i < 5; i++) {
      // Sin dormir el proceso: si otro tiene el contador, se prueba de nuevo. Al arrancar se numera lo que haya quedado.
      try { num = indice.tomarNumero(job.clave, env, { esperaMs: 0 }); } catch (err) {
        if (i === 4) log(`[imagenes] no se pudo numerar ${job.tareaId}#${job.n}: ${err.message}`);
        else await new Promise((r) => setTimeout(r, 100));
      }
    }
    indice.actualizar(job.clave, job.tareaId, job.n, (p) => ({
      ...(p || {}),
      ...camposDeImagen({
        archivo: final, tipo, foto: job.foto, hilo: job.hilo, externo, sha256: sha, prompt, negativo, proporcion, semilla: hecho.semilla,
        perfil: hecho.proveedor === 'comfyui' ? d.perfil.id : null, proveedor: hecho.proveedor, modelo: hecho.modelo, ancho: hecho.ancho, alto: hecho.alto,
        bytes: bytes.length, cambio: cuanto, fuerza, lorasUsadas: hecho.loras,
        // Con alma_la_ve, la vista queda `pendiente` hasta que la mirada termine: un turno que llega antes no la toma.
        vistaEstado: config.alma_la_ve && !signal.aborted ? 'pendiente' : null, ahora: ahora(), intento: job.intento, num,
        // FEAT-218 — Elegido por el refinador solo si la hizo ComfyUI con ese modelo.
        modeloAuto: modeloAuto && hecho.proveedor === 'comfyui'
      })
    }), env);
    // FEAT-215 — Con una más nueva, la elegida de ese hilo deja de valer.
    if (job.hilo) desmarcar(job.clave, job.hilo);
    // Los intentos anteriores de esa n se borran.
    if (previo && previo.archivo && previo.archivo !== final) { borrarArchivo(job.clave, previo); if (previo.sha256) mapa().delete(previo.sha256); }
    mapa().set(sha, { clave: job.clave, tareaId: job.tareaId, n: job.n, externo });
    transicionImagen(job.tareaId, job.n, {
      estado: 'lista', num: num || undefined, tipo, ancho: hecho.ancho, alto: hecho.alto, proveedor: hecho.proveedor, modelo: hecho.modelo || null,
      semilla: hecho.semilla ?? null, fotoIgnorada: Boolean(hecho.fotoIgnorada || (conFoto && !job.fotoOpcional && caso === 'nueva')), perfil: hecho.proveedor === 'comfyui' ? d.perfil.id : null,
      loras: Array.isArray(hecho.loras) && hecho.loras.length ? hecho.loras : undefined, sinChequeoZona: hecho.sinChequeoZona ? true : undefined, codigo: null, mensaje: null, terminada: ahora().toISOString(),
      modeloAuto: modeloAuto && hecho.proveedor === 'comfyui'
    });
    job.hecha = true;
    podar(job.clave, job);
    cambio(job.clave);
    if (job.envio) Promise.resolve().then(() => job.envio({ ok: true, n: job.n, num, ruta: final, tipo, idEnvio: job.idEnvio, caso })).catch((err) => log(`[imagenes] no se pudo mandar: ${err.message}`));

    // 4. Mirar (§2.1): lo que salió, para el turno siguiente del mismo hilo.
    if (config.alma_la_ve && !signal.aborted) await mirar(job, final, prompt);
  }

  function prepararParaElTaller(job, { caso, casoPedido, d, conComfy, conFoto, prompt, negativo, proporcion, ancho, alto, zona, instruccion, loras, cuanto, fuerza, modeloAuto = false }) {
    if (!taller || !conComfy) return error(job, 'sin-proveedor', { intentos: d.afuera });
    const base = caso !== 'nueva' && conFoto ? { ruta: job.foto.ruta, segura: Boolean(job.foto.segura) } : null;
    let p = null;
    try {
      p = taller.preparar({
        tareaId: job.tareaId, n: job.n, clave: job.clave, caso, casoPedido, perfil: d.perfil.id, modelo: d.modelo, modeloAuto, prompt, negativo, proporcion, ancho, alto,
        zona: zona || '', instruccion: instruccion || '', loras, cambio: cuanto, fuerza, semilla: Number.isInteger(job.semilla) ? job.semilla : null, base,
        // Como al guardar una imagen: de un hilo ya externo, o de una foto de afuera.
        externo: Boolean(job.externo) || Boolean(base && !base.segura), hilo: job.hilo || null
      });
    } catch (err) {
      log(`[imagenes] no se pudo dejar el preparado de ${job.tareaId}#${job.n}: ${err.message}`);
    }
    if (!p || !p.ok) return error(job, 'error');
    job.cerrado = true;
    transicionImagen(job.tareaId, job.n, { estado: 'error', codigo: 'para-el-taller', mensaje: codigos.mensajeDe('para-el-taller'), terminada: ahora().toISOString() });
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

  /** FEAT-213 — Una foto de base que se puede leer: la de los adjuntos o la de la carpeta de imágenes de un alma. */
  const fotoPermitida = (ruta) => indice.fotoPermitida(ruta, { dirAdjuntos: dirAdjuntos(), env });

  // Una vez por imagen: se lista muchas veces.
  const avisadas = new Set();
  function avisarAfuera(e) {
    const k = `${e.tareaId}#${e.n}`;
    if (avisadas.has(k)) return;
    avisadas.add(k);
    log(`[imagenes] el archivo de ${k} está fuera de su carpeta; se saltea`);
  }

  /** Borra el archivo de una entrada, solo si está en la carpeta de su alma. */
  function borrarArchivo(clave, e) {
    const ruta = indice.archivoDe(clave, e, env);
    if (!ruta) { avisarAfuera(e); return false; }
    try { fs.rmSync(ruta, { force: true }); return true; } catch { return false; }
  }

  /** FEAT-214 — El grafo guardado de una imagen del taller (su carpeta), solo si queda en la carpeta de imágenes del alma. */
  function borrarFlujo(clave, e) {
    if (!e || typeof e.flujo !== 'string') return;
    const dir = indice.rutaDentroDe(indice.dirImagenes(clave, env), e.flujo);
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }

  const misma = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

  /** FEAT-213 — ¿Alguien la está usando? La base de una imagen que todavía no está, o la foto de un turno abierto. */
  function enUso(clave, e) {
    if ([...pendientes, ...esperando, enCurso].some((j) => j && j.clave === clave && j.tareaId === e.tareaId && j.n === e.n)) return true;
    const ruta = indice.archivoDe(clave, e, env);
    if (!ruta) return false;
    let abiertas = [];
    try { abiertas = fotosEnUso() || []; } catch {}
    const usadas = [...[...pendientes, ...esperando, enCurso].map((j) => j && j.foto && j.foto.ruta), ...abiertas].filter(Boolean);
    return usadas.some((u) => { let r = u; try { r = fs.realpathSync.native(u); } catch {} return misma(r, ruta); });
  }

  /** El tope por alma (`tope_por_alma`; 0 = nunca): la más vieja se borra; su entrada pasa a `borrada` si la tarea sigue. */
  function podar(clave, actual = null) {
    const tope = leerConfig().tope_por_alma ?? indice.TOPE_POR_ALMA;
    if (!tope) return;
    // La que se acaba de hacer nunca se poda (todavía no se mandó), ni una que alguien está usando.
    const todas = indice.listar(clave, env).filter((e) => e.archivo && !(actual && e.tareaId === actual.tareaId && e.n === actual.n));
    let sobran = todas.length + (actual ? 1 : 0) - tope;
    for (const e of todas) {
      if (sobran <= 0) break;
      if (enUso(clave, e)) continue;
      sobran--;
      // Una que apunta afuera de su carpeta se saltea entera: ni el archivo ni la entrada.
      if (!indice.archivoDe(clave, e, env)) { avisarAfuera(e); continue; }
      borrarArchivo(clave, e);
      const borrada = indice.borrar(clave, e.tareaId, e.n, { sha256: e.sha256 || null, envio: (e.telegram && e.telegram.envio) || null, env, alBorrar: (x) => { borrarFlujo(clave, x); return true; } });
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
    // FEAT-213 — Corta la espera de esa imagen, no el arranque de ComfyUI.
    for (const j of [...esperando]) {
      if (!toca(j)) continue;
      esperando.delete(j);
      j.control.abort();
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
  const tieneAbiertas = (tareaId) => [...pendientes, ...esperando, enCurso].some((j) => j && j.tareaId === tareaId);

  /** FEAT-213 — Las que necesitan a ComfyUI: las que lo esperan, las pendientes que van a él y la que está refinando o haciéndose ahí. */
  function lasDeComfy() {
    const config = leerConfig();
    const actual = enCurso && !enCurso.hecha && (enCurso.proveedor ? enCurso.proveedor === 'comfyui' : primeroComfy(enCurso, config)) ? [enCurso] : [];
    return [...esperando, ...pendientes.filter((j) => primeroComfy(j, config)), ...actual];
  }

  /** FEAT-213 — Al apagar ComfyUI a la fuerza, terminan en error. */
  function cortarLasDeComfy(codigo = 'comfyui-apagado') {
    const todas = lasDeComfy();
    for (const j of todas) {
      esperando.delete(j);
      const i = pendientes.indexOf(j);
      if (i >= 0) pendientes.splice(i, 1);
      j.codigoCorte = codigo;
      j.control.abort();
      error(j, codigo);
    }
    return todas.length;
  }

  /**
   * FEAT-213 — Borra una imagen a pedido del usuario: `'borrada'`, `'no-existe'`, `'cambio'` (hay otro intento) u `'ocupada'`.
   * El archivo y el índice se borran bajo su lock y en el mismo tramo la entrada del turno pasa a `borrada`: un Reintento
   * simultáneo gana o pierde entero.
   */
  function borrarImagen({ clave, tareaId, n, intento }) {
    let previa = null;
    try { previa = indice.leer(clave, tareaId, n, env); } catch { return 'no-existe'; }
    const t = tareaDe(tareaId);
    // La tarea es de otra alma: esa clave no tiene esa imagen.
    if (!previa || (t && claveDe(t) !== clave)) return 'no-existe';
    if (!previa.lista || !previa.archivo) return entradas(tareaId).some((e) => e.n === n && e.estado === 'generando') ? 'ocupada' : 'no-existe';
    if ((previa.intento || 1) !== intento) return 'cambio';
    const abierta = entradas(tareaId).find((e) => e.n === n);
    if ((abierta && abierta.estado === 'generando') || enUso(clave, { ...previa, tareaId, n })) return 'ocupada';
    let motivo = 'ocupada';
    const ok = indice.borrar(clave, tareaId, n, {
      env, intento,
      alBorrar: (e) => {
        if (!e || !e.lista) { motivo = 'cambio'; return false; }
        if (!indice.archivoDe(clave, e, env)) { motivo = 'no-existe'; avisarAfuera({ tareaId, n }); return false; }
        if (!borrarArchivo(clave, { ...e, tareaId, n })) { motivo = 'ocupada'; return false; }
        borrarFlujo(clave, e);
        return true;
      }
    });
    if (!ok) {
      const e = indice.leer(clave, tareaId, n, env);
      return !e ? 'no-existe' : (e.intento || 1) !== intento ? 'cambio' : motivo;
    }
    if (previa.sha256) mapa().delete(previa.sha256);
    if (previa.telegram && previa.telegram.sha256) mapaDeTelegram().delete(previa.telegram.sha256);
    if (t) transicionImagen(tareaId, n, { estado: 'borrada', codigo: null, mensaje: 'La borraste.' });
    return 'borrada';
  }

  /** FEAT-213 — Los bytes de una imagen por su lugar en el índice (la tarea puede no estar). */
  function bytesDelIndice(clave, tareaId, n) {
    let e = null;
    try { e = indice.leer(clave, tareaId, n, env); } catch { return { ok: false, codigo: 404 }; }
    if (!e || !e.lista) return { ok: false, codigo: 404 };
    return bytesDeEntrada(clave, e);
  }

  function bytesDeEntrada(clave, e, tipo = null) {
    const ruta = indice.archivoDe(clave, e, env);
    if (!ruta) { if (e.archivo) avisarAfuera(e); return { ok: false, codigo: 404 }; }
    try {
      const st = fs.statSync(ruta);
      if (!st.isFile() || st.size > 20 * 1024 * 1024) return { ok: false, codigo: 404 };
      return { ok: true, bytes: fs.readFileSync(ruta), tipo: e.tipo || tipo || 'image/png' };
    } catch {
      return { ok: false, codigo: 404 };
    }
  }

  /** Lo que hace falta para repetir una imagen: lo que guardó el índice (o la entrada, si es de antes de 2.19). */
  function repetir(e, priv) {
    const prompt = e.prompt || priv.prompt || '';
    const de = { ...(priv.baseFija ? { baseFija: true } : {}), ...(priv.fotoOpcional ? { fotoOpcional: true } : {}) };
    if (!prompt && !priv.instruccion) return de;
    return {
      ...de, ...(priv.cambio ? { cambio: priv.cambio, fuerza: priv.fuerza ?? null } : {}),
      prompt: priv.prompt || prompt, negativo: priv.negativo ?? e.negativo ?? '', proporcion: priv.proporcion || '1:1',
      ...(priv.caso ? { caso: priv.caso, casoPedido: priv.casoPedido || priv.caso, zona: priv.zona || '', instruccion: priv.instruccion || '', loras: priv.loras || [] } : {}),
      // FEAT-218 — La que eligió el refinador se repite con el mismo modelo (si todavía puede).
      ...(priv.modeloAuto === true && typeof priv.modelo === 'string' && priv.modelo ? { modelo: priv.modelo } : {})
    };
  }

  /** La foto para repetir una imagen: la guardada, `null` si no lleva o `false` si hacía falta y ya no está. */
  function fotoDeNuevo(e, priv) {
    const opcional = Boolean(priv.fotoOpcional) && !priv.caso;
    if (!e.desdeFoto && !opcional) return null;
    const ruta = priv.fotoRuta && fotoPermitida(priv.fotoRuta);
    if (!ruta || !fs.existsSync(ruta)) return opcional ? null : false;
    return { ruta, segura: Boolean(priv.fotoSegura) };
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
    // FEAT-213 — Una borrada no se repite.
    if (e.estado === 'borrada') return { ok: false, codigo: 'no-existe' };
    const foto = fotoDeNuevo(e, priv);
    if (foto === false) return { ok: false, codigo: 'foto-perdida' };
    return encolar({
      tareaId, clave, hilo: priv.hilo || null, pedido: e.pedido, mensaje: '', desdeFoto: e.desdeFoto, foto, externo: Boolean(priv.externo),
      ...repetir(e, priv), semilla: undefined, envio, crearEnvio, origen: 'usuario', origenImagen: 'version', deNum: priv.num || null
    });
  }

  const PEDIDO_VARIAR = 'Otra parecida a esta: la misma escena y el mismo estilo, con pequeñas diferencias.';
  /**
   * FEAT-215 — «Variar esta»: parte de esa imagen. Sin el prompt con que se hizo (el de un retoque describe solo la zona): el refinador
   * la mira y escribe el suyo. Mismos códigos que `otra`.
   */
  function variar(tareaId, n, { envio = null, crearEnvio = null } = {}) {
    const config = leerConfig();
    if (!config.variar) return { ok: false, codigo: 'apagada' };
    const t = tareaDe(tareaId);
    const e = entradas(tareaId).find((x) => x.n === n);
    if (!t || !e || e.estado !== 'lista') return { ok: false, codigo: 'no-existe' };
    if (entradas(tareaId).length >= TOPE_IMAGENES_TURNO) return { ok: false, codigo: 'tope-turno' };
    const clave = claveDe(t);
    const priv = indice.leer(clave, tareaId, n, env);
    const ruta = priv && priv.lista ? indice.archivoDe(clave, priv, env) : null;
    if (!ruta || !fs.existsSync(ruta)) return { ok: false, codigo: 'no-existe' };
    const externo = indice.esExterna(priv);
    return encolar({
      tareaId, clave, hilo: priv.hilo || null, pedido: PEDIDO_VARIAR, mensaje: '', desdeFoto: true, baseFija: true, foto: { ruta, segura: !externo }, externo,
      origenImagen: 'variante', deNum: priv.num || null, envio, crearEnvio, origen: 'usuario'
    });
  }

  /** FEAT-215 — Lo que cambió en la marca «Partir de esta», también en el registro (que avisa). */
  function reflejar(tocadas) {
    for (const x of tocadas) {
      const e = entradas(x.tareaId).find((y) => y.n === x.n);
      if (e) transicionImagen(x.tareaId, x.n, { elegida: x.elegida || undefined });
    }
  }
  function desmarcar(clave, hilo) {
    try {
      const x = indice.listar(clave, env).find((e) => e.hilo === hilo && e.elegida);
      if (x) reflejar(indice.elegir(clave, x.tareaId, x.n, false, env));
    } catch (err) {
      log(`[imagenes] no se pudo desmarcar la elegida: ${err.message}`);
    }
  }

  /** FEAT-215 — «Partir de esta» (o deja de). `{ ok }` o `{ ok: false, codigo: 'apagada' | 'no-existe' | 'sin-hilo' }`. */
  function partir(clave, tareaId, n, si) {
    if (!leerConfig().partir) return { ok: false, codigo: 'apagada' };
    const e = indice.leer(clave, tareaId, n, env);
    if (!e || !e.lista || !indice.archivoDe(clave, e, env)) return { ok: false, codigo: 'no-existe' };
    if (!e.hilo) return { ok: false, codigo: 'sin-hilo' };
    const tocadas = indice.elegir(clave, tareaId, n, si, env, ahora());
    reflejar(tocadas);
    if (tocadas.length) cambio(clave);
    return { ok: true };
  }

  /** §5 — Reintentar una entrada en `error`: la misma `n`, un intento nuevo. */
  function reintentar(tareaId, n, { envio = null } = {}) {
    const t = tareaDe(tareaId);
    const e = entradas(tareaId).find((x) => x.n === n);
    if (!t || !e || e.estado === 'borrada') return { ok: false, codigo: 'no-existe' };
    if (e.estado !== 'error') return { ok: false, codigo: 'no-en-error' };
    const clave = claveDe(t);
    const priv = indice.leer(clave, tareaId, n, env) || {};
    const foto = fotoDeNuevo(e, priv);
    if (foto === false) return { ok: false, codigo: 'foto-perdida' };
    return encolar({
      tareaId, clave, n, intento: (e.intento || 1) + 1, hilo: priv.hilo || null, pedido: e.pedido, mensaje: '', desdeFoto: e.desdeFoto, foto, externo: Boolean(priv.externo),
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
    return priv && priv.archivo ? bytesDeEntrada(claveDe(t), priv, e.tipo) : { ok: false, codigo: 404 };
  }

  /** Al arrancar: vacía los `.tmp/` de todas las almas y arma el mapa `sha256`. */
  function alArrancar(claves = []) {
    for (const c of claves) {
      indice.vaciarTmp(c, env);
      // FEAT-215 — Las de antes reciben su número, una sola vez.
      try {
        for (const x of indice.numerar(c, env)) if (entradas(x.tareaId).some((e) => e.n === x.n)) transicionImagen(x.tareaId, x.n, { num: x.num });
      } catch (err) { log(`[imagenes] no se pudieron numerar las de ${c}: ${err.message}`); }
    }
    // Un nodo (sin claves) no lee el directorio de las almas (FEAT-090 §3.6): mapa vacío.
    mapaSha = claves.length ? null : new Map();
    mapaTelegram = claves.length ? null : new Map();
    if (claves.length) mapa();
  }

  const estadoDeImagenes = () => ({ pendientes: pendientes.length + esperando.size, enCurso: enCurso ? 1 : 0 });

  return { encolar, podar, cancelarImagenes, lasDeComfy, cortarLasDeComfy, avisarAfuera, tieneAbiertas, otra, variar, partir, reintentar, bytesDe, bytesDelIndice, borrarImagen, enUso, reconocer, reconocerTelegram, invalidarMapas, transicionImagen, estadoDeImagenes, alArrancar, _pendientes: pendientes, _esperando: esperando, _primeroComfy: primeroComfy };
}

/**
 * FEAT-214 — Lo que el índice guarda de una imagen terminada. La usan la cola y el taller: no se separan.
 * `foto`: `{ ruta, segura }` o `null`; `ahora`: la hora de la imagen.
 */
export function camposDeImagen({
  archivo, tipo, foto = null, hilo = null, externo, sha256, prompt = '', negativo = '', proporcion = null, semilla = null, perfil = null, proveedor, modelo = null,
  ancho = null, alto = null, bytes, cambio = null, fuerza = null, lorasUsadas = [], vistaEstado = null, ahora = new Date(), intento = 1, num = null,
  modeloAuto = false
}) {
  return {
    archivo, tipo, fotoRuta: foto ? foto.ruta : null, fotoSegura: Boolean(foto && foto.segura),
    hilo: hilo || null, externo: Boolean(externo), sha256, prompt, negativo, proporcion, semilla: semilla ?? null, perfil,
    // FEAT-213 — Lo que muestra la galería cuando la tarea ya no está en el registro.
    proveedor, modelo: modelo || null, ancho, alto, bytes, cambio, fuerza,
    // FEAT-218 — Si el modelo lo eligió el refinador (`false` explícito: el de un intento anterior no sobrevive).
    modeloAuto: modeloAuto === true,
    lorasUsadas: Array.isArray(lorasUsadas) ? lorasUsadas : [],
    lista: true, vista: null, vistaOrden: false, vistaEntregada: false, vistaEstado, vistaDesde: ahora.toISOString(),
    // La hora del archivo nuevo: un reintento de una imagen vieja no queda primero para la poda.
    creada: ahora.toISOString(), intento, num
  };
}

/** La clave del alma de una tarea de charla. */
function claveDe(t) {
  return t && t.sujeto && typeof t.sujeto === 'object' ? (t.sujeto.clave || t.sujeto.id || null) : null;
}

export { claveDe };
