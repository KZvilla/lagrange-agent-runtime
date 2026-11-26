/**
 * FEAT-210 §7 — El proveedor ComfyUI: una imagen con un flujo local, por su API HTTP.
 *
 * Solo local (la URL es de loopback). El flujo es un JSON en formato API con
 * marcadores (`{{prompt}}`, `{{semilla}}`…) que se reemplazan sobre el JSON ya
 * parseado, valor por valor: un prompt con comillas o llaves no rompe nada.
 *
 * FEAT-212 — El flujo lo resuelve `resolverFlujo` (el propio del perfil o la
 * plantilla del plugin para ese caso), y los datos salen del perfil del modelo.
 * Los huecos de LoRA sin usar se puentean, y en un retoque se chequea la máscara.
 *
 * Cancelar nunca interrumpe a ciegas: primero `GET /queue`, y solo se corta el
 * prompt que es nuestro (en la cola, `delete`; corriendo, `/interrupt` con su
 * `prompt_id`, confirmado después).
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { sinRutas } from './sanear-texto.js';
import { chequearMascara, TOPE_MASCARA } from './mascara.js';

const require = createRequire(import.meta.url);
// Perezoso: importar bot.js no carga la config del MCP (BE-176).
const perezoso = (ruta) => { let m = null; return new Proxy({}, { get: (_, k) => (m ||= require(ruta))[k] }); };
const ajustesImagenes = perezoso('../../mcp-server/lib/ajustes-imagenes.js');
const flujosLib = perezoso('../../mcp-server/imagenes/flujos.js');
const casosLib = perezoso('../../mcp-server/imagenes/casos.js');
const perfilesLib = perezoso('../../mcp-server/imagenes/perfiles.js');
const catalogos = perezoso('../../mcp-server/imagenes/catalogo.js');

const ESPERA_HISTORIA_MS = 1000;
const ESPERA_COLA_MS = 500;
const CONFIRMAR_MS = 10 * 1000;
const PRUEBA_MS = 5000;
// Cada pedido HTTP tiene su tope: un ComfyUI que acepta la conexión y no contesta no deja la cola trabada.
const PEDIDO_MS = 30 * 1000;
const TOPE_BYTES = 20 * 1024 * 1024;

/** El cuerpo de una respuesta, o `null` si pasa el tope (se corta mientras llega). */
async function leerHasta(r, tope) {
  if (!r.body || typeof r.body.getReader !== 'function') {
    const bytes = Buffer.from(await r.arrayBuffer());
    return bytes.length > tope ? null : bytes;
  }
  const lector = r.body.getReader();
  const partes = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) return Buffer.concat(partes);
    total += value.byteLength;
    if (total > tope) { try { await lector.cancel(); } catch {} return null; }
    partes.push(Buffer.from(value));
  }
}

/** Las medidas de un PNG (su cabecera), o `null`. */
function medidasDe(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const ancho = bytes.readUInt32BE(16);
  const alto = bytes.readUInt32BE(20);
  return ancho > 0 && alto > 0 && ancho <= 16384 && alto <= 16384 ? { ancho, alto } : null;
}

const tipoDe = (nombre) => (/\.png$/i.test(nombre) ? 'image/png' : /\.webp$/i.test(nombre) ? 'image/webp' : /\.jpe?g$/i.test(nombre) ? 'image/jpeg' : 'image/png');
const extDe = (tipo) => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' })[tipo] || 'png';

// FEAT-214 — Lo que usa también el taller.
export { TOPE_BYTES, leerHasta, medidasDe, tipoDe, extDe };

/**
 * FEAT-214 — Los datos de los marcadores de un pedido: lo del perfil (muestreo y carga) y lo del pedido. La semilla, la que
 * viene o una al azar.
 */
export function datosDe({ caso = 'nueva', modelo, perfil, prompt = '', negativo = '', ancho, alto, semilla, fuerza = null, zona = '', instruccion = '', catalogo = null, marcadores = [] }) {
  const seed = Number.isInteger(semilla) ? semilla : crypto.randomInt(0, 2 ** 31);
  const m = perfil.muestreo;
  const datos = {
    prompt, negativo, semilla: seed, ancho, alto, pasos: m.pasos, cfg: m.cfg, guia: m.guia, sampler: m.sampler, scheduler: m.scheduler, fuerza: caso === 'retoque' ? m.fuerzaRetoque : caso === 'variacion' && Number.isFinite(fuerza) ? fuerza : m.fuerza,
    ...casosLib.comoLosLista(casosLib.valoresDeCarga(modelo, perfil), catalogo)
  };
  if (caso === 'retoque') datos.zona = zona;
  if (caso === 'edicion') {
    datos.instruccion = instruccion;
    // Un flujo de edición que solo tiene {{prompt}} recibe la instrucción ahí.
    if (!marcadores.includes('instruccion')) datos.prompt = instruccion;
  }
  return datos;
}

/**
 * FEAT-214 — Arma el flujo de un pedido sin mandarlo: resuelve cuál (o la `plantilla` del taller), pone los LoRAs que sigue
 * teniendo ComfyUI y puentea los huecos libres. Los marcadores todavía no se aplican (falta la base).
 * `{ ok, resuelto, datos, armado, usadas }` o `{ ok: false, codigo, detalle?, extra? }`.
 */
export function armarPedido({ seccion, caso = 'nueva', modelo, perfil, pedido = {}, loras = [], catalogo = null, plantilla = null, resolverFlujo = (s, p, c) => flujosLib.resolverFlujo(s, p, c), log = () => {} }) {
  const resuelto = plantilla ? flujosLib.resolverPlantillaTaller(perfil, plantilla) : resolverFlujo(seccion, perfil, caso);
  if (!resuelto.ok) return { ok: false, codigo: 'fallo-del-flujo', detalle: resuelto.motivo };
  const datos = datosDe({ ...pedido, caso: plantilla ? 'variacion' : caso, modelo, perfil, catalogo, marcadores: resuelto.marcadores });
  // Un LoRA que ya no está en ComfyUI se saltea (solo con un catálogo válido se sabe).
  const usadas = [];
  for (const l of loras.slice(0, resuelto.huecos.length)) {
    const archivo = catalogo ? perfilesLib.enLista(catalogo.loras, l.archivo) : l.archivo;
    if (!archivo) { log(`[imagenes] El LoRA "${l.clave}" no está en ComfyUI; se saltea.`); continue; }
    usadas.push({ ...l, archivo });
  }
  usadas.forEach((l, i) => { datos[`lora_${i + 1}`] = l.archivo; datos[`lora_${i + 1}_fuerza`] = l.fuerza; });
  const armado = flujosLib.puentear(resuelto.flujo, resuelto.huecos, usadas.length);
  const usaFoto = plantilla ? true : caso !== 'nueva';
  const falta = flujosLib.marcadorFaltante(armado, usaFoto ? { ...datos, foto: 'x' } : datos);
  if (falta) return { ok: false, codigo: 'flujo-marcador', extra: { marcador: falta } };
  return { ok: true, resuelto, datos, armado, usadas };
}

/** FEAT-214 — Sube una foto al `input` de ComfyUI con un nombre al azar. El nombre como lo usa un `LoadImage`. */
export async function subirBase({ json, foto, signal }) {
  const bytes = fs.readFileSync(foto);
  const form = new FormData();
  form.append('image', new Blob([bytes]), `lagrange-${crypto.randomBytes(6).toString('hex')}.png`);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const subida = await json('/upload/image', { method: 'POST', body: form, signal });
  return subida.subfolder ? `${subida.subfolder}/${subida.name}` : subida.name;
}

/**
 * Crea el proveedor. `config` es la sección `imagenes` entera (normalizada); `resolverFlujo(config, perfil, caso)`, quien
 * dice qué flujo se usa. `fetchImpl`, `esperar` y `log` se inyectan en los tests.
 */
export function crearComfyui({ config: seccion, resolverFlujo = (s, p, c) => flujosLib.resolverFlujo(s, p, c), catalogoDe = (url) => catalogos.enCache(url), fetchImpl = globalThis.fetch, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, ahora = () => Date.now(), pedidoMs = PEDIDO_MS, idCliente = () => `lagrange-${crypto.randomBytes(4).toString('hex')}` }) {
  const config = seccion.comfyui;
  const base = String(config.url || ajustesImagenes.URL_COMFYUI).replace(/\/+$/, '');
  // El `signal` del trabajo (si viene) más el tope del pedido.
  const pedir = async (ruta, { signal, ...opciones } = {}) => fetchImpl(`${base}${ruta}`, {
    ...opciones, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(pedidoMs)]) : AbortSignal.timeout(pedidoMs)
  });
  const json = async (ruta, opciones = {}) => {
    const r = await pedir(ruta, opciones);
    if (!r.ok) throw Object.assign(new Error(`ComfyUI ${r.status}`), { status: r.status });
    return r.json();
  };
  const post = (ruta, cuerpo, signal) => json(ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo), signal });

  /** ¿En qué parte de la cola está `id`? `'pendiente'`, `'corriendo'` o `null`. */
  async function dondeEsta(id) {
    const q = await json('/queue');
    const tiene = (lista) => Array.isArray(lista) && lista.some((e) => Array.isArray(e) ? e.includes(id) : e && e.prompt_id === id);
    if (tiene(q.queue_running)) return 'corriendo';
    if (tiene(q.queue_pending)) return 'pendiente';
    return null;
  }

  /**
   * Corta nuestro prompt, nunca otro. `{ cortado, colgado }`: `colgado` si a los 10 s sigue corriendo (ComfyUI no lo
   * cortó); la cola espera a que termine antes de mandar otra imagen.
   */
  async function cancelarPrompt(id) {
    let donde = null;
    const fin = ahora() + CONFIRMAR_MS;
    // La carrera entre POST /prompt y su aparición en la cola: se mira cada 500 ms hasta 10 s.
    while (ahora() < fin) {
      try { donde = await dondeEsta(id); } catch { donde = null; }
      if (donde) break;
      await esperar(ESPERA_COLA_MS);
    }
    if (!donde) return { cortado: false, colgado: false };
    try {
      if (donde === 'pendiente') await post('/queue', { delete: [id] });
      else await post('/interrupt', { prompt_id: id });
    } catch (err) {
      log(`[imagenes] ComfyUI no aceptó el corte: ${err.message}`);
    }
    // Se confirma con /queue (no se adivina la versión de ComfyUI).
    const hasta = ahora() + CONFIRMAR_MS;
    while (ahora() < hasta) {
      // Solo un /queue que contestó sin el prompt confirma el corte; un error sigue esperando.
      let d = null;
      try { d = await dondeEsta(id); } catch { d = 'desconocido'; }
      if (!d) return { cortado: true, colgado: false };
      await esperar(ESPERA_COLA_MS);
    }
    log('[imagenes] ComfyUI no cortó la imagen pedida; la cola espera a que termine.');
    return { cortado: false, colgado: true };
  }

  async function liberarGpu() {
    if (!config.liberar_gpu) return;
    // /free responde 200 sin cuerpo: no se lee como JSON.
    try {
      const r = await pedir('/free', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
      if (!r.ok) log(`[imagenes] ComfyUI /free falló: ComfyUI ${r.status}`);
    } catch (err) { log(`[imagenes] ComfyUI /free falló: ${err.message}`); }
  }

  /** El error que dio ComfyUI al correr un flujo: `{ nodo, clase, mensaje }` o `null`. Nunca viaja: va al log. */
  function errorDe(entrada) {
    const m = entrada && entrada.status && Array.isArray(entrada.status.messages) ? entrada.status.messages : [];
    const e = m.find((x) => Array.isArray(x) && x[0] === 'execution_error' && x[1] && typeof x[1] === 'object');
    return e ? { nodo: String(e[1].node_id ?? ''), clase: String(e[1].node_type || ''), mensaje: String(e[1].exception_message || '') } : null;
  }

  /** Baja la máscara que dejó el flujo y mira si marca algo: `'ok'`, `'vacia'`, `'cubre'`, `'ilegible'` o `null` si no hay. */
  async function mirarMascara(resultado, nodo, signal) {
    const img = resultado.outputs && resultado.outputs[nodo] && Array.isArray(resultado.outputs[nodo].images) ? resultado.outputs[nodo].images[0] : null;
    if (!img || !img.filename) return null;
    try {
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'temp' });
      const v = await pedir(`/view?${q}`, { signal });
      if (!v.ok) return 'ilegible';
      const bytes = await leerHasta(v, TOPE_MASCARA);
      return bytes ? chequearMascara(bytes) : 'ilegible';
    } catch (err) {
      if (signal && signal.aborted) throw err;
      return 'ilegible';
    }
  }

  /**
   * `generar({ caso, modelo, perfil, prompt, negativo, ancho, alto, semilla, foto, zona, instruccion, loras, signal, destino })` → la interfaz de §3.
   * `loras`: `[{ clave, archivo, fuerza }]`, en el orden de los huecos.
   */
  async function generar({ caso = 'nueva', modelo, perfil, prompt, negativo = '', ancho, alto, semilla, fuerza = null, foto = null, zona = '', instruccion = '', loras = [], signal, destino }) {
    const fin = (codigo, extra = {}) => ({ ok: false, codigo, proveedor: 'comfyui', modelo, ...extra });
    if (!ajustesImagenes.esLoopback(base)) return fin('error');
    if (signal && signal.aborted) return fin('cancelada');
    const usaFoto = caso !== 'nueva';
    if (usaFoto && !foto) return fin('error');
    const catalogo = catalogoDe(base);
    const a = armarPedido({ seccion, caso, modelo, perfil, pedido: { prompt, negativo, ancho, alto, semilla, fuerza, zona, instruccion }, loras, catalogo, resolverFlujo, log });
    if (!a.ok) return fin(a.codigo, { ...(a.detalle ? { detalle: a.detalle } : {}), ...(a.extra ? { extra: a.extra } : {}) });
    const { resuelto, datos, armado, usadas } = a;
    const seed = datos.semilla;
    const retoque = caso === 'retoque' && resuelto.salidaMascara && config.chequeo_zona !== false;
    const zonaFallida = (estado) => fin('zona-no-encontrada', { extra: { zona, cubre: estado === 'cubre' } });
    let id = null;
    // Desde que el flujo sale para /prompt, ComfyUI pudo haberlo aceptado aunque no conteste.
    let enviado = false;
    let resultado;
    const tope = ahora() + config.tiempo_s * 1000;
    try {
      if (usaFoto) datos.foto = await subirBase({ json, foto, signal });
      const flujo = flujosLib.aplicarMarcadores(armado, datos);
      const salida = resuelto.salida;
      enviado = true;
      const r = await post('/prompt', { prompt: flujo, client_id: idCliente() }, signal);
      if ((r.node_errors && Object.keys(r.node_errors).length) || r.error) {
        log(`[imagenes] ComfyUI rechazó el flujo: ${sinRutas(JSON.stringify(r.error || r.node_errors)).slice(0, 300)}`);
        return fin('fallo-del-flujo');
      }
      id = r.prompt_id;
      // /history mientras está en la cola o corriendo devuelve {}.
      for (;;) {
        if (signal && signal.aborted) { const c = await cancelarPrompt(id); return fin('cancelada', { colgado: c.colgado }); }
        if (ahora() > tope) { const c = await cancelarPrompt(id); return fin('tiempo', { colgado: c.colgado }); }
        const h = await json(`/history/${encodeURIComponent(id)}`, { signal });
        const entrada = h && h[id];
        if (entrada && entrada.status && entrada.status.status_str === 'error') {
          const e = errorDe(entrada);
          if (e) log(`[imagenes] ComfyUI falló en el nodo ${e.nodo} (${e.clase.replace(/[^A-Za-z0-9_ ]/g, '').slice(0, 40)}): ${sinRutas(e.mensaje).slice(0, 300)}`);
          // Un retoque que falla después de la máscara: si la máscara quedó vacía, esa es la causa.
          if (retoque) { const estado = await mirarMascara(entrada, resuelto.salidaMascara, signal); if (estado === 'vacia' || estado === 'cubre') return zonaFallida(estado); }
          if (e && caso === 'retoque' && flujosLib.ramaDeMascara(resuelto.flujo, resuelto.salidaMascara).has(e.nodo)) return fin('mascara-fallo', { extra: { clase: e.clase } });
          return fin('fallo-del-flujo');
        }
        if (entrada && entrada.status && entrada.status.completed) { resultado = entrada; break; }
        await esperar(ESPERA_HISTORIA_MS);
      }
      let sinChequeoZona = false;
      if (retoque) {
        const estado = await mirarMascara(resultado, resuelto.salidaMascara, signal);
        if (estado === 'vacia' || estado === 'cubre') return zonaFallida(estado);
        if (estado !== 'ok') { sinChequeoZona = true; log('[imagenes] No se pudo leer la máscara del retoque: sigue sin chequeo de zona.'); }
      }
      const imagenes = salida && resultado.outputs && resultado.outputs[salida] ? resultado.outputs[salida].images || [] : [];
      const img = imagenes.find((i) => i.type === 'output');
      if (!img) return fin('fallo-del-flujo');
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: 'output' });
      const v = await pedir(`/view?${q}`, { signal });
      if (!v.ok) return fin('error');
      const bytes = Buffer.from(await v.arrayBuffer());
      if (!bytes.length || bytes.length > TOPE_BYTES) return fin('error');
      const tipo = tipoDe(img.filename);
      const ruta = `${destino}.${extDe(tipo)}`;
      fs.writeFileSync(ruta, bytes);
      // Un retoque o una edición conservan el tamaño de la foto: las medidas son las del archivo, no las pedidas.
      const real = medidasDe(bytes) || { ancho, alto };
      return { ok: true, ruta, tipo, ancho: real.ancho, alto: real.alto, semilla: seed, proveedor: 'comfyui', modelo, fotoIgnorada: false, loras: usadas.map((l) => ({ clave: l.clave, fuerza: l.fuerza })), ...(sinChequeoZona ? { sinChequeoZona: true } : {}) };
    } catch (err) {
      // Cortado a mitad de un pedido: si ya estaba en la cola de ComfyUI, se corta ahí también.
      if (signal && signal.aborted) {
        const c = id ? await cancelarPrompt(id) : { colgado: enviado };
        return fin('cancelada', { colgado: c.colgado });
      }
      // El flujo salió y no hubo respuesta: sin prompt_id no se puede cortar ni confirmar; la cola espera (colgado).
      if (enviado && !id && (err && err.name === 'TimeoutError' || err.cause && ['ECONNRESET', 'UND_ERR_SOCKET'].includes(err.cause.code))) {
        log('[imagenes] ComfyUI no contestó al flujo enviado; puede seguir haciéndolo, la cola espera.');
        return fin('tiempo', { colgado: true });
      }
      // Un pedido sin respuesta: antes de mandar el flujo, como si no corriera; después, se acabó el tiempo.
      if (err && err.name === 'TimeoutError') {
        if (!id) return fin('no-responde');
        const c = await cancelarPrompt(id);
        return fin('tiempo', { colgado: c.colgado });
      }
      // Conexión rechazada: ComfyUI no está corriendo; el bucle prueba el siguiente.
      if (!id && !enviado && (err.cause && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND'].includes(err.cause.code) || err.name === 'TypeError')) return fin('no-responde');
      if (!id && enviado && err.cause && ['ECONNREFUSED', 'ENOTFOUND'].includes(err.cause.code)) return fin('no-responde');
      log(`[imagenes] ComfyUI falló: ${sinRutas(err.message)}`);
      return fin('error');
    } finally {
      if (id) {
        // Antes de /free, que salga de la cola (hasta 10 s).
        const hasta = ahora() + CONFIRMAR_MS;
        while (ahora() < hasta) {
          let d = null;
          try { d = await dondeEsta(id); } catch { break; }
          if (!d) break;
          await esperar(ESPERA_COLA_MS);
        }
        await liberarGpu();
      }
    }
  }

  return { id: 'comfyui', generar, cancelarPrompt };
}

/**
 * `POST /api/v2/imagenes:probar`: `GET /system_stats` (5 s). `{ ok, codigo, mensaje, vramLibre? }` con textos fijos.
 * La `url` tiene que ser loopback. FEAT-212 — Con `config` (la sección guardada) suma `catalogo` y `casos`, pidiendo el catálogo de nuevo.
 */
export async function probarComfyui({ url, fetchImpl = globalThis.fetch, config = null }) {
  const r = await probarConexion({ url, fetchImpl });
  if (!r.ok || !config) return r;
  const catalogo = await catalogos.catalogoDe(url, { forzar: true, fetchImpl });
  const casos = {};
  for (const caso of casosLib.CASOS) {
    const e = casosLib.estadoComfyui(config, caso, catalogo);
    const faltan = [...e.faltan.archivos, ...e.faltan.nodos];
    casos[caso] = {
      estado: !catalogo ? 'sin-catalogo' : e.puede ? 'disponible' : 'faltan', faltan: e.faltan, faltanLoras: e.faltanLoras,
      motivo: e.motivo && !faltan.length ? e.motivo : null, modelo: e.modelo, perfil: e.perfil.id, nombre: e.resuelto ? e.resuelto.nombre : null
    };
  }
  return { ...r, catalogo: catalogos.publico(catalogo), casos };
}

async function probarConexion({ url, fetchImpl }) {
  if (!ajustesImagenes.esLoopback(url)) return { ok: false, codigo: 'no-loopback', mensaje: 'La URL de ComfyUI tiene que ser de esta máquina (127.0.0.1, localhost o [::1]).' };
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), PRUEBA_MS);
  try {
    const r = await fetchImpl(`${String(url).replace(/\/+$/, '')}/system_stats`, { signal: control.signal });
    if (!r.ok) return { ok: false, codigo: 'error', mensaje: `ComfyUI respondió con un error (${r.status}).` };
    const s = await r.json();
    // FEAT-213 — Todas las versiones traen `system` y `devices`: otra cosa no es ComfyUI.
    if (!s || typeof s.system !== 'object' || !s.system || !Array.isArray(s.devices)) return { ok: false, codigo: 'otro-programa', mensaje: 'En esa dirección responde otro programa, no ComfyUI.' };
    const dev = Array.isArray(s.devices) ? s.devices[0] : null;
    const vramLibre = dev && Number.isFinite(dev.vram_free) ? dev.vram_free : null;
    return { ok: true, codigo: 'ok', mensaje: 'ComfyUI responde.', ...(vramLibre !== null ? { vramLibre } : {}) };
  } catch {
    return { ok: false, codigo: 'no-responde', mensaje: 'ComfyUI no responde en esa dirección.' };
  } finally {
    clearTimeout(reloj);
  }
}

export const aplicarMarcadores = (valor, datos) => flujosLib.aplicarMarcadores(valor, datos);
