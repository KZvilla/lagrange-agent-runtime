/**
 * FEAT-089 §3-§6 — Lo que el servidor atiende de sus nodos, bajo `/nodo/*`.
 *
 * Lo monta `web/servidor.js` antes del chequeo de cookie: el mismo puerto de la
 * consola, nada nuevo que abrir. Este módulo no conoce la consola ni Telegram:
 * recibe el canal donde republicar los eventos y un proveedor `telegram` con
 * las cinco operaciones acotadas que un nodo puede pedir (§5.2).
 *
 * Seguridad (§3.1): `Host` de loopback (lo chequea `atender` antes), nada con
 * `Origin` o `Sec-Fetch-Site` (un navegador no habla con esto), autenticación
 * mutua con Ed25519 (§3.5) y después un token de sesión en un encabezado, nunca
 * cookie ni URL. Topes de cuerpo por ruta, leídos en streaming.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  PROTOCOLO, nombreValido, idValido, clavePublicaValida, firmar, verificar, textoSaludo, textoSesion,
  pruebaEmparejar, nonce, hashCodigo, tokenSesion, identidadServidor, leerNodos, mutarNodos, archivosRed
} from './identidad.js';

const require = createRequire(import.meta.url);
const { tokenCoincide } = require('../../mcp-server/lib/seguridad-http.js');

export const TOPE_JSON = 64 * 1024;
export const TOPE_GRANDE = 1024 * 1024;
export const TOPE_BINARIO = 20 * 1024 * 1024;
const NONCE_VIGENCIA_MS = 30_000;
const NONCES_POR_NODO = 4;
const GRACIA_SESION_MS = 5 * 60_000;
const SESION_MAX_MS = 24 * 60 * 60_000;
const LATIDO_MS = 25_000;
const RPC_TIMEOUT_MS = 30_000;
const INTENTOS_CODIGO = 5;
const ASK_ID = /^ask_[0-9a-f]{16}$/;

class ErrorNodo extends Error {
  constructor(codigo, mensaje, extra = {}) {
    super(mensaje);
    this.codigo = codigo;
    this.extra = extra;
  }
}

function leerCuerpo(req, tope) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let cortado = false;
    req.on('data', (d) => {
      if (cortado) return;
      total += d.length;
      if (total > tope) {
        cortado = true;
        reject(new ErrorNodo(413, 'Cuerpo demasiado grande.'));
        req.resume();
        return;
      }
      partes.push(d);
    });
    req.on('end', () => { if (!cortado) resolve(Buffer.concat(partes)); });
    req.on('error', reject);
  });
}

async function leerJsonDe(req, tope = TOPE_JSON) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new ErrorNodo(415, 'Se espera application/json.');
  const crudo = await leerCuerpo(req, tope);
  if (!crudo.length) return {};
  try {
    const v = JSON.parse(crudo.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new ErrorNodo(400, 'JSON inválido.');
  }
}

function encabezado(req, nombre) {
  const v = req.headers[nombre];
  if (typeof v !== 'string') return '';
  try { return decodeURIComponent(v); } catch { return ''; }
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {object} o.canal        canal de la consola del servidor (web/canal.js)
 * @param {string} o.chatId       el chat de la consola (`CHAT_WEB_LOCAL`)
 * @param {object} [o.telegram]   { mensaje, voz, archivo, preguntar, quitarBotones }
 */
export function crearServidorNodos({
  dataDir,
  canal,
  chatId,
  telegram = null,
  log = () => {},
  ahora = () => Date.now(),
  latidoMs = LATIDO_MS,
  rpcTimeoutMs = RPC_TIMEOUT_MS
}) {
  const identidad = identidadServidor(dataDir);
  const nonces = new Map();        // nonceServidor → { id, nonceNodo, vence }
  const sesiones = new Map();      // token → { id, creada, graciaHasta, flujoAbierto }
  const conexiones = new Map();    // id → { res, token, latido }
  const pendientes = new Map();    // rpcId → { id, resolve, timer }
  const ultimos = new Map();       // id → { arranque, seq }

  // §4.3 — `nodos.json` lo escribe un comando aparte: se relee en cada saludo y
  // pedido autenticado, con caché por mtime.
  let cacheNodos = null;
  const nodos = () => {
    let firma = 'no';
    try { const st = fs.statSync(archivosRed(dataDir).nodos); firma = `${st.mtimeMs}:${st.size}`; } catch {}
    if (!cacheNodos || cacheNodos.firma !== firma) cacheNodos = { firma, datos: leerNodos(dataDir) };
    return cacheNodos.datos;
  };
  const nodoPorId = (id) => nodos().nodos.find((n) => n.id === id) || null;
  const invalidarCache = () => { cacheNodos = null; };

  function escribirFlujo(id, mensaje) {
    const c = conexiones.get(id);
    if (!c) return false;
    try {
      c.res.write(`data: ${JSON.stringify({ v: PROTOCOLO, ...mensaje })}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  function cerrarConexion(id, { revocado = false } = {}) {
    const c = conexiones.get(id);
    if (!c) return;
    if (revocado) escribirFlujo(id, { tipo: 'revocado' });
    conexiones.delete(id);
    clearInterval(c.latido);
    try { c.res.end(); } catch {}
    const s = sesiones.get(c.token);
    if (s) { s.flujoAbierto = false; s.graciaHasta = ahora() + GRACIA_SESION_MS; }
    if (revocado) for (const [t, ses] of sesiones) if (ses.id === id) sesiones.delete(t);
    // §6.2 — Lo que estaba en vuelo se contesta ya: ni pestañas colgadas ni promesas acumuladas.
    for (const [rid, p] of pendientes) {
      if (p.id !== id) continue;
      clearTimeout(p.timer);
      pendientes.delete(rid);
      p.resolve({ codigo: 503, ok: false, error: 'Nodo desconectado.' });
    }
  }

  /** §4.3 — Un nodo que ya no está en `nodos.json` pierde la sesión y el flujo. */
  function revisarRevocados() {
    invalidarCache();
    const vigentes = new Set(nodos().nodos.map((n) => n.id));
    for (const id of [...conexiones.keys()]) {
      if (!vigentes.has(id)) {
        log(`[red] Nodo ${id} revocado: se corta su flujo.`);
        cerrarConexion(id, { revocado: true });
      }
    }
    for (const [t, s] of sesiones) if (!vigentes.has(s.id)) sesiones.delete(t);
  }

  function sesionDe(req) {
    const token = req.headers['x-lagrange-sesion'];
    if (typeof token !== 'string' || !token) return null;
    for (const [t, s] of sesiones) {
      if (!tokenCoincide(t, token)) continue;
      const vigente = ahora() < s.creada + SESION_MAX_MS && (s.flujoAbierto || ahora() < s.graciaHasta);
      if (!vigente) { sesiones.delete(t); return null; }
      if (!nodoPorId(s.id)) { revisarRevocados(); return null; }
      return { token: t, ...s };
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Sin sesión: emparejar, saludo, sesión
  // --------------------------------------------------------------------------

  async function emparejar(req) {
    const c = await leerJsonDe(req);
    if (!idValido(c.id) || !clavePublicaValida(c.clavePublica)) throw new ErrorNodo(400, 'Datos de emparejamiento inválidos.');
    if (c.nombre !== undefined && !nombreValido(c.nombre)) throw new ErrorNodo(400, 'Nombre de nodo inválido (a-z, 0-9 y guiones, hasta 32).');
    const hash = hashCodigo(c.codigo);
    const r = mutarNodos(dataDir, (d) => {
      const t = ahora();
      d.invitaciones = d.invitaciones.filter((i) => Date.parse(i.vence) > t && (i.intentos || 0) < INTENTOS_CODIGO);
      const inv = d.invitaciones.find((i) => typeof i.hashCodigo === 'string' && i.hashCodigo.length === hash.length
        && crypto.timingSafeEqual(Buffer.from(i.hashCodigo), Buffer.from(hash)));
      if (!inv) {
        // Un intento fallido no se sabe de qué invitación era: cuenta para todas las vigentes.
        for (const i of d.invitaciones) i.intentos = (i.intentos || 0) + 1;
        d.invitaciones = d.invitaciones.filter((i) => i.intentos < INTENTOS_CODIGO);
        return { error: 403 };
      }
      const nombre = inv.nombre || c.nombre;
      if (!nombreValido(nombre)) return { error: 400, mensaje: 'Falta un nombre válido para el nodo.' };
      if (d.nodos.some((n) => n.nombre === nombre && n.id !== c.id)) return { error: 409, mensaje: `Ya hay un nodo llamado ${nombre}.` };
      d.invitaciones = d.invitaciones.filter((i) => i !== inv);
      d.nodos = d.nodos.filter((n) => n.id !== c.id);
      d.nodos.push({ id: c.id, nombre, clavePublica: c.clavePublica, creado: new Date(t).toISOString(), ultimaConexion: null, version: null, capacidades: [] });
      return { nombre };
    });
    invalidarCache();
    if (r.error === 403) throw new ErrorNodo(403, 'Código inválido, vencido o ya usado.');
    if (r.error) throw new ErrorNodo(r.error, r.mensaje);
    log(`[red] Nodo emparejado: ${r.nombre} (${c.id}).`);
    return {
      servidorId: identidad.servidorId,
      clavePublicaServidor: identidad.clavePublica,
      nombre: r.nombre,
      prueba: pruebaEmparejar(c.codigo, c.id, c.clavePublica, identidad.clavePublica)
    };
  }

  async function saludo(req) {
    const c = await leerJsonDe(req);
    const v = Number(c.v);
    if (!(v === PROTOCOLO || (v === PROTOCOLO - 1 && v >= 1))) {
      throw new ErrorNodo(426, `Protocolo ${c.v} incompatible: el servidor habla ${PROTOCOLO}. Actualizá Lagrange en el nodo.`, { protocolo: PROTOCOLO });
    }
    if (!idValido(c.id) || typeof c.nonceNodo !== 'string' || c.nonceNodo.length < 40 || c.nonceNodo.length > 64) {
      throw new ErrorNodo(400, 'Saludo inválido.');
    }
    invalidarCache();
    if (!nodoPorId(c.id)) throw new ErrorNodo(401, 'Nodo desconocido.', { motivo: 'desconocido' });
    const nonceServidor = nonce();
    const t = ahora();
    for (const [n, e] of nonces) if (e.vence <= t) nonces.delete(n);
    const propios = [...nonces].filter(([, e]) => e.id === c.id);
    while (propios.length >= NONCES_POR_NODO) nonces.delete(propios.shift()[0]);
    nonces.set(nonceServidor, { id: c.id, nonceNodo: c.nonceNodo, vence: t + NONCE_VIGENCIA_MS });
    return {
      servidorId: identidad.servidorId,
      nonceServidor,
      firma: firmar(identidad.clavePrivada, textoSaludo(c.id, c.nonceNodo, nonceServidor))
    };
  }

  async function sesion(req) {
    const c = await leerJsonDe(req);
    const pendiente = typeof c.nonceServidor === 'string' ? nonces.get(c.nonceServidor) : null;
    // Se borra al usarlo, salga bien o mal: un nonce no se reintenta.
    if (pendiente) nonces.delete(c.nonceServidor);
    if (!pendiente || pendiente.vence <= ahora() || pendiente.id !== c.id) throw new ErrorNodo(401, 'Nonce inválido, vencido o ya usado.');
    const nodo = nodoPorId(c.id);
    if (!nodo) throw new ErrorNodo(401, 'Nodo desconocido.', { motivo: 'desconocido' });
    if (!verificar(nodo.clavePublica, textoSesion(c.id, c.nonceServidor, pendiente.nonceNodo), c.firma)) {
      throw new ErrorNodo(401, 'Firma inválida.');
    }
    if (c.nombre !== undefined && !nombreValido(c.nombre)) throw new ErrorNodo(400, 'Nombre de nodo inválido.');
    const capacidades = Array.isArray(c.capacidades) ? c.capacidades.filter((x) => typeof x === 'string' && x.length <= 32).slice(0, 16) : [];
    const version = typeof c.version === 'string' ? c.version.slice(0, 32) : null;
    mutarNodos(dataDir, (d) => {
      const n = d.nodos.find((x) => x.id === c.id);
      if (!n) return false;
      if (c.nombre && c.nombre !== n.nombre && !d.nodos.some((x) => x.nombre === c.nombre && x.id !== c.id)) n.nombre = c.nombre;
      n.capacidades = capacidades;
      n.version = version;
      n.ultimaConexion = new Date(ahora()).toISOString();
      return true;
    });
    invalidarCache();
    const token = tokenSesion();
    const t = ahora();
    sesiones.set(token, { id: c.id, arranque: typeof c.arranque === 'string' ? c.arranque.slice(0, 64) : null, creada: t, graciaHasta: t + GRACIA_SESION_MS, flujoAbierto: false });
    return { sesion: token, vence: new Date(t + SESION_MAX_MS).toISOString() };
  }

  // --------------------------------------------------------------------------
  // Con sesión
  // --------------------------------------------------------------------------

  function abrirFlujo(req, res, s) {
    cerrarConexion(s.id);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    res.flushHeaders();
    const latido = setInterval(() => {
      revisarRevocados();
      if (conexiones.get(s.id)?.res === res) { try { res.write(': latido\n\n'); } catch {} }
    }, latidoMs);
    latido.unref?.();
    conexiones.set(s.id, { res, token: s.token, latido });
    const ses = sesiones.get(s.token);
    if (ses) ses.flujoAbierto = true;
    res.on('close', () => { if (conexiones.get(s.id)?.res === res) cerrarConexion(s.id); });
    log(`[red] Nodo ${nodoPorId(s.id)?.nombre || s.id} conectado.`);
    // §5.3 — Respuestas de asks que llegaron mientras no estaba.
    const t = ahora();
    const entregar = [];
    mutarNodos(dataDir, (d) => {
      const antes = d.asksRemotos.length;
      d.asksRemotos = d.asksRemotos.filter((a) => {
        if (a.nodo !== s.id) return true;
        if (!a.vence || Date.parse(a.vence) > t) entregar.push(a);
        return false;
      });
      return d.asksRemotos.length !== antes;
    });
    invalidarCache();
    for (const a of entregar) escribirFlujo(s.id, { tipo: 'ask-respondido', askId: a.askId, respuesta: a.respuesta, indice: a.indice, por: a.por });
  }

  async function eventos(req, s) {
    const c = await leerJsonDe(req, TOPE_GRANDE);
    const arranque = typeof c.arranque === 'string' ? c.arranque : '';
    const lista = Array.isArray(c.eventos) ? c.eventos : [];
    const resincronizar = () => canal.publicar(chatId, { tipo: 'nodo-resincronizar', nodo: s.id });
    let ultimo = ultimos.get(s.id);
    if (ultimo && ultimo.arranque !== arranque) { resincronizar(); ultimo = null; }
    let avisado = false;
    for (const e of lista) {
      const seq = Number(e?.seq);
      if (!Number.isInteger(seq) || !e.evento || typeof e.evento !== 'object') continue;
      if (ultimo && seq <= ultimo.seq) continue; // duplicado
      if (ultimo && seq > ultimo.seq + 1 && !avisado) { resincronizar(); avisado = true; }
      ultimo = { arranque, seq };
      const { seq: _s, ts: _t, nodo: _n, ...evento } = e.evento;
      if (evento.tipo === 'nodo-resincronizar') { resincronizar(); continue; }
      canal.publicar(chatId, { ...evento, nodo: s.id }, { efimero: e.efimero === true });
    }
    if (ultimo) ultimos.set(s.id, ultimo);
    return { ok: true };
  }

  async function respuesta(req, s, rid) {
    const c = await leerJsonDe(req, TOPE_GRANDE);
    const p = pendientes.get(rid);
    if (!p || p.id !== s.id) return { ok: true, descartada: true };
    clearTimeout(p.timer);
    pendientes.delete(rid);
    if (c.ok === true) p.resolve(c.resultado ?? {});
    else p.resolve({ codigo: Number(c.codigo) || 502, ok: false, error: String(c.error || 'El nodo devolvió un error.') });
    return { ok: true };
  }

  function exigirTelegram(op) {
    if (!telegram || typeof telegram[op] !== 'function') throw new ErrorNodo(503, 'Este servidor no tiene Telegram.');
    return telegram[op];
  }

  async function rutaTelegram(req, s, op) {
    const nombre = nodoPorId(s.id)?.nombre || s.id;
    if (op === 'mensaje') {
      const c = await leerJsonDe(req);
      if (c.chat_id !== undefined || c.chatId !== undefined) log(`[red] ${nombre} mandó un chat_id: se ignora, el destino lo decide el servidor.`);
      if (typeof c.texto !== 'string' || !c.texto.trim()) throw new ErrorNodo(400, 'Falta el texto.');
      return (await exigirTelegram('mensaje')({ nodo: s.id, nombre, texto: c.texto.slice(0, 32_000), hora: typeof c.hora === 'string' ? c.hora : null })) || { ok: true };
    }
    if (op === 'voz' || op === 'archivo') {
      const buffer = await leerCuerpo(req, TOPE_BINARIO);
      if (!buffer.length) throw new ErrorNodo(400, 'Cuerpo vacío.');
      const pie = encabezado(req, 'x-lagrange-pie').slice(0, 4000);
      if (op === 'voz') return (await exigirTelegram('voz')({ nodo: s.id, nombre, buffer, pie })) || { ok: true };
      return (await exigirTelegram('archivo')({ nodo: s.id, nombre, buffer, pie, archivo: encabezado(req, 'x-lagrange-nombre') })) || { ok: true };
    }
    if (op === 'preguntar') {
      const c = await leerJsonDe(req);
      const opciones = Array.isArray(c.opciones) ? c.opciones.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.slice(0, 64)).slice(0, 8) : [];
      if (!ASK_ID.test(String(c.askId)) || typeof c.pregunta !== 'string' || !c.pregunta.trim() || opciones.length === 0) {
        throw new ErrorNodo(400, 'Pregunta inválida.');
      }
      const timeoutSeconds = Math.min(Math.max(Number(c.timeoutSeconds) || 300, 10), 3600);
      return exigirTelegram('preguntar')({ nodo: s.id, nombre, askId: c.askId, pregunta: c.pregunta.slice(0, 3500), opciones, timeoutSeconds });
    }
    if (op === 'quitar-botones') {
      const c = await leerJsonDe(req);
      if (!ASK_ID.test(String(c.askId))) throw new ErrorNodo(400, 'askId inválido.');
      return (await exigirTelegram('quitarBotones')({ nodo: s.id, askId: c.askId })) || { ok: true };
    }
    throw new ErrorNodo(404, 'No existe.');
  }

  /**
   * Atiende un pedido a `/nodo/*`. `atender` de la consola ya chequeó el `Host`.
   */
  async function atender(req, res, url) {
    const json = (codigo, datos) => {
      res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(datos));
    };
    try {
      if (req.headers.origin || req.headers['sec-fetch-site']) return json(403, { ok: false, error: 'Este endpoint no atiende navegadores.' });
      const ruta = url.pathname;
      if (req.method === 'POST' && ruta === '/nodo/emparejar') return json(200, { ok: true, ...(await emparejar(req)) });
      if (req.method === 'POST' && ruta === '/nodo/saludo') return json(200, { ok: true, ...(await saludo(req)) });
      if (req.method === 'POST' && ruta === '/nodo/sesion') return json(200, { ok: true, ...(await sesion(req)) });

      const s = sesionDe(req);
      if (!s) { req.resume(); return json(401, { ok: false, error: 'Sin sesión.' }); }

      if (req.method === 'GET' && ruta === '/nodo/flujo') return abrirFlujo(req, res, s);
      if (req.method !== 'POST') return json(405, { ok: false, error: 'Método no permitido.' });
      if (ruta === '/nodo/eventos') return json(200, await eventos(req, s));
      const m = /^\/nodo\/respuesta\/([0-9a-f]{32})$/.exec(ruta);
      if (m) return json(200, await respuesta(req, s, m[1]));
      const t = /^\/nodo\/telegram\/(mensaje|voz|archivo|preguntar|quitar-botones)$/.exec(ruta);
      if (t) {
        const r = await rutaTelegram(req, s, t[1]);
        const { codigo = 200, ...resto } = r || {};
        return json(codigo, { ok: codigo < 400, ...resto });
      }
      req.resume();
      return json(404, { ok: false, error: 'No existe.' });
    } catch (err) {
      const codigo = err instanceof ErrorNodo ? err.codigo : 500;
      if (codigo === 500) log(`[red] ${req.method} ${url.pathname}: ${err?.stack || err}`);
      if (res.headersSent) return res.end();
      return json(codigo, { ok: false, error: codigo === 500 ? 'Error interno.' : err.message, ...(err.extra || {}) });
    }
  }

  /** §6.2 — Un método del núcleo de un nodo. Resuelve siempre, nunca lanza. */
  function rpc(id, metodo, args = []) {
    if (!conexiones.has(id)) return Promise.resolve({ codigo: 503, ok: false, error: 'Nodo desconectado.' });
    const rid = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendientes.delete(rid);
        resolve({ codigo: 504, ok: false, error: 'El nodo no respondió.' });
      }, rpcTimeoutMs);
      timer.unref?.();
      pendientes.set(rid, { id, resolve, timer });
      if (!escribirFlujo(id, { tipo: 'pedido', id: rid, metodo, args })) {
        clearTimeout(timer);
        pendientes.delete(rid);
        resolve({ codigo: 503, ok: false, error: 'Nodo desconectado.' });
      }
    });
  }

  /** §5.3 — La respuesta de un ask de un nodo: por el flujo, o guardada para el próximo saludo. */
  function askRespondido(id, { askId, respuesta: texto, indice, por, vence = null }) {
    if (escribirFlujo(id, { tipo: 'ask-respondido', askId, respuesta: texto, indice, por })) return { entregado: true };
    mutarNodos(dataDir, (d) => {
      d.asksRemotos = d.asksRemotos.filter((a) => a.askId !== askId);
      d.asksRemotos.push({ nodo: id, askId, respuesta: texto, indice, por, vence });
      return true;
    });
    invalidarCache();
    return { entregado: false };
  }

  function listaNodos() {
    return nodos().nodos.map((n) => ({
      id: n.id,
      nombre: n.nombre,
      conectado: conexiones.has(n.id),
      version: n.version || null,
      capacidades: n.capacidades || [],
      ultimaConexion: n.ultimaConexion || null
    }));
  }

  function existeNodo(id) {
    return Boolean(nodoPorId(id));
  }

  function cerrar() {
    for (const id of [...conexiones.keys()]) cerrarConexion(id);
  }

  return { atender, rpc, askRespondido, listaNodos, existeNodo, revisarRevocados, cerrar, conectado: (id) => conexiones.has(id) };
}
