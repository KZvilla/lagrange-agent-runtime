/**
 * FEAT-210 §7 — El proveedor ComfyUI: una imagen con un flujo local, por su API HTTP.
 *
 * Solo local (la URL es de loopback). El flujo es un JSON en formato API con
 * marcadores (`{{prompt}}`, `{{semilla}}`…) que se reemplazan sobre el JSON ya
 * parseado, valor por valor: un prompt con comillas o llaves no rompe nada.
 *
 * Cancelar nunca interrumpe a ciegas: primero `GET /queue`, y solo se corta el
 * prompt que es nuestro (en la cola, `delete`; corriendo, `/interrupt` con su
 * `prompt_id`, confirmado después).
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Perezoso: importar bot.js no carga la config del MCP (BE-176).
let libAjustes = null;
const ajustesImagenes = new Proxy({}, { get: (_, k) => (libAjustes ||= require('../../mcp-server/lib/ajustes-imagenes.js'))[k] });

const ESPERA_HISTORIA_MS = 1000;
const ESPERA_COLA_MS = 500;
const CONFIRMAR_MS = 10 * 1000;
const PRUEBA_MS = 5000;
// Cada pedido HTTP tiene su tope: un ComfyUI que acepta la conexión y no contesta no deja la cola trabada.
const PEDIDO_MS = 30 * 1000;
const TOPE_BYTES = 20 * 1024 * 1024;
const NUMERICOS = new Set(['semilla', 'ancho', 'alto', 'pasos']);

/** Las dimensiones de una proporción, en múltiplos de 64 alrededor de 1 megapíxel. */
const DIMENSIONES = Object.freeze({
  '1:1': [1024, 1024], '3:4': [896, 1152], '4:3': [1152, 896], '16:9': [1344, 768], '9:16': [768, 1344]
});
function dimensiones(proporcion) {
  const [ancho, alto] = DIMENSIONES[proporcion] || DIMENSIONES['1:1'];
  return { ancho, alto };
}

/** Reemplaza los marcadores sobre el flujo parseado. Un valor que es exactamente `{{numérico}}` queda como número. */
function aplicarMarcadores(valor, datos) {
  if (typeof valor === 'string') {
    const solo = /^\{\{(\w+)\}\}$/.exec(valor);
    if (solo && solo[1] in datos) {
      const v = datos[solo[1]];
      if (NUMERICOS.has(solo[1])) return Math.round(Number(v));
      if (solo[1] === 'fuerza') return Number(v);
      return v == null ? '' : String(v);
    }
    return valor.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in datos ? String(datos[k] ?? '') : m));
  }
  if (Array.isArray(valor)) return valor.map((v) => aplicarMarcadores(v, datos));
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, aplicarMarcadores(v, datos)]));
  return valor;
}

/** El nodo de salida: el configurado, o el primer `SaveImage` del flujo enviado. */
function nodoDeSalida(flujo, configurado) {
  if (configurado) return String(configurado);
  for (const [id, nodo] of Object.entries(flujo)) if (nodo && nodo.class_type === 'SaveImage') return id;
  return null;
}

const tipoDe = (nombre) => (/\.png$/i.test(nombre) ? 'image/png' : /\.webp$/i.test(nombre) ? 'image/webp' : /\.jpe?g$/i.test(nombre) ? 'image/jpeg' : 'image/png');
const extDe = (tipo) => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' })[tipo] || 'png';

/**
 * Crea el proveedor. `config` es `imagenes.comfyui` normalizada; `flujos` los efectivos (`flujosEfectivos`).
 * `fetchImpl`, `esperar` y `log` se inyectan en los tests.
 */
export function crearComfyui({ config, flujos, fetchImpl = globalThis.fetch, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, ahora = () => Date.now(), pedidoMs = PEDIDO_MS }) {
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
  // El detalle de un error de ComfyUI va al log sin rutas (un checkpoint o un modelo las traen).
  const sinRutas = (t) => String(t)
    .replace(/[A-Za-z]:(?:[\\/]+[^\\/"'\n]+)+/g, '<ruta>')
    .replace(/(?:[\\/]+[^\\/"'\n:]+){2,}/g, '<ruta>');

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
    try { await post('/free', { unload_models: true, free_memory: true }); } catch (err) { log(`[imagenes] ComfyUI /free falló: ${err.message}`); }
  }

  /** `generar({ prompt, negativo, ancho, alto, semilla, foto, fuerza, signal, destino })` → la interfaz de §3. */
  async function generar({ prompt, negativo = '', ancho, alto, semilla, foto = null, fuerza = 0.6, signal, destino }) {
    const fin = (codigo, extra = {}) => ({ ok: false, codigo, proveedor: 'comfyui', modelo: config.modelo, ...extra });
    if (!ajustesImagenes.esLoopback(base)) return fin('error');
    if (signal && signal.aborted) return fin('cancelada');
    // El flujo: img2img con una foto y un flujo para eso; si no, txt2img (y la foto se ignora, anotado).
    const usaFoto = Boolean(foto && flujos.img2img);
    const leido = ajustesImagenes.leerFlujo(usaFoto ? flujos.img2img : flujos.txt2img, { img2img: usaFoto });
    if (!leido.ok) return fin('fallo-del-flujo', { detalle: leido.motivo });
    const seed = Number.isInteger(semilla) ? semilla : crypto.randomInt(0, 2 ** 31);
    const datos = { prompt, negativo, modelo: config.modelo, semilla: seed, ancho, alto, pasos: config.pasos, fuerza };
    let id = null;
    let resultado;
    const tope = ahora() + config.tiempo_s * 1000;
    try {
      if (usaFoto) {
        const bytes = fs.readFileSync(foto);
        const form = new FormData();
        form.append('image', new Blob([bytes]), `lagrange-${crypto.randomBytes(6).toString('hex')}.png`);
        form.append('type', 'input');
        form.append('overwrite', 'true');
        const subida = await json('/upload/image', { method: 'POST', body: form, signal });
        datos.foto = subida.subfolder ? `${subida.subfolder}/${subida.name}` : subida.name;
      }
      const flujo = aplicarMarcadores(leido.flujo, datos);
      const salida = nodoDeSalida(flujo, config.nodo_salida);
      const r = await post('/prompt', { prompt: flujo, client_id: `lagrange-${crypto.randomBytes(4).toString('hex')}` }, signal);
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
        if (entrada && entrada.status && entrada.status.status_str === 'error') return fin('fallo-del-flujo');
        if (entrada && entrada.status && entrada.status.completed) { resultado = entrada; break; }
        await esperar(ESPERA_HISTORIA_MS);
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
      return { ok: true, ruta, tipo, ancho, alto, semilla: seed, proveedor: 'comfyui', modelo: config.modelo, fotoIgnorada: Boolean(foto && !usaFoto) };
    } catch (err) {
      // Cortado a mitad de un pedido: si ya estaba en la cola de ComfyUI, se corta ahí también.
      if (signal && signal.aborted) {
        const c = id ? await cancelarPrompt(id) : { colgado: false };
        return fin('cancelada', { colgado: c.colgado });
      }
      // Un pedido sin respuesta: antes de mandar el flujo, como si no corriera; después, se acabó el tiempo.
      if (err && err.name === 'TimeoutError') {
        if (!id) return fin('no-responde');
        const c = await cancelarPrompt(id);
        return fin('tiempo', { colgado: c.colgado });
      }
      // Conexión rechazada: ComfyUI no está corriendo; el bucle prueba el siguiente.
      if (!id && (err.cause && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND'].includes(err.cause.code) || err.name === 'TypeError')) return fin('no-responde');
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

  return { id: 'comfyui', generar, dimensiones, cancelarPrompt };
}

/**
 * `POST /api/v2/imagenes:probar`: `GET /system_stats` (5 s). `{ ok, codigo, mensaje, vramLibre? }` con textos fijos.
 * La `url` tiene que ser loopback.
 */
export async function probarComfyui({ url, fetchImpl = globalThis.fetch }) {
  if (!ajustesImagenes.esLoopback(url)) return { ok: false, codigo: 'no-loopback', mensaje: 'La URL de ComfyUI tiene que ser de esta máquina (127.0.0.1, localhost o [::1]).' };
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), PRUEBA_MS);
  try {
    const r = await fetchImpl(`${String(url).replace(/\/+$/, '')}/system_stats`, { signal: control.signal });
    if (!r.ok) return { ok: false, codigo: 'error', mensaje: `ComfyUI respondió con un error (${r.status}).` };
    const s = await r.json();
    const dev = Array.isArray(s.devices) ? s.devices[0] : null;
    const vramLibre = dev && Number.isFinite(dev.vram_free) ? dev.vram_free : null;
    return { ok: true, codigo: 'ok', mensaje: 'ComfyUI responde.', ...(vramLibre !== null ? { vramLibre } : {}) };
  } catch {
    return { ok: false, codigo: 'no-responde', mensaje: 'ComfyUI no responde en esa dirección.' };
  } finally {
    clearTimeout(reloj);
  }
}

export { DIMENSIONES, dimensiones, aplicarMarcadores, nodoDeSalida };
