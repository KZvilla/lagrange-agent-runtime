/**
 * FEAT-089 §5.1 / FEAT-092 §4.4 — Endpoint local del daemon para el conector
 * (el MCP de cada sesión). En este paso lo usan solo los mensajes entre
 * sesiones, y se levanta en todos los roles.
 *
 * Puerto elegido por el sistema, solo 127.0.0.1, `Host` de loopback, token por
 * arranque en `enlace.json` (como `web-token.json`) y sin navegador: un pedido
 * con `Origin` o `Sec-Fetch-Site` se rechaza. Solo JSON, con tope.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tokenCoincide, hostEsLoopback } = require('../../mcp-server/lib/seguridad-http.js');

const TOPE_CUERPO = 16 * 1024;
// FEAT-089 §5.1 — Lo que el conector de un nodo manda a Telegram por acá.
const TOPE_TELEGRAM_JSON = 64 * 1024;
const TOPE_TELEGRAM_BINARIO = 20 * 1024 * 1024;
// FEAT-090 §3.3 — Un sobre de exportación entra holgado.
const TOPE_ALMAS = 1024 * 1024;
// FEAT-092 §8 — El texto final de una narración, con la voz y el alma.
const TOPE_VOZ = 16 * 1024;

function leerCrudo(req, tope) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', (d) => {
      total += d.length;
      if (total > tope) { reject(Object.assign(new Error('Cuerpo demasiado grande.'), { codigo: 413 })); req.destroy(); return; }
      partes.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

async function leerCuerpo(req, tope = TOPE_CUERPO) {
  const crudo = await leerCrudo(req, tope);
  if (!crudo.length) return {};
  try {
    const v = JSON.parse(crudo.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    throw Object.assign(new Error('JSON inválido.'), { codigo: 400 });
  }
}

function encabezado(req, nombre) {
  const v = req.headers[nombre];
  if (typeof v !== 'string') return '';
  try { return decodeURIComponent(v); } catch { return ''; }
}

/**
 * FEAT-089 §5 — `/telegram/*` del endpoint local, solo en un nodo: pasa lo del
 * conector al cliente de la red. Sin cliente (rol solo o servidor), 404.
 */
async function rutaTelegram(req, ruta, telegram) {
  const op = ruta.slice('/telegram/'.length);
  if (op === 'voz' || op === 'archivo') {
    const buffer = await leerCrudo(req, TOPE_TELEGRAM_BINARIO);
    if (!buffer.length) throw Object.assign(new Error('Cuerpo vacío.'), { codigo: 400 });
    const pie = encabezado(req, 'x-lagrange-pie');
    let reaccionable = null;
    try { reaccionable = JSON.parse(encabezado(req, 'x-lagrange-reaccionable') || 'null'); } catch {}
    return op === 'voz' ? telegram.voz(buffer, pie, reaccionable) : telegram.archivo(buffer, encabezado(req, 'x-lagrange-nombre'), pie);
  }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw Object.assign(new Error('Se espera JSON.'), { codigo: 415 });
  const c = await leerCuerpo(req, TOPE_TELEGRAM_JSON);
  if (op === 'mensaje') return telegram.mensaje({ texto: String(c.texto || ''), reaccionable: c.reaccionable || null });
  if (op === 'preguntar') return telegram.preguntar({ askId: c.askId, pregunta: c.pregunta, opciones: c.opciones, timeoutSeconds: c.timeoutSeconds });
  if (op === 'quitar-botones') return telegram.quitarBotones(c.askId);
  throw Object.assign(new Error('No existe.'), { codigo: 404 });
}

export function crearServidorEnlace({ registro, token, telegram = null }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('El enlace local necesita un token de al menos 32 caracteres.');
  return http.createServer(async (req, res) => {
    const json = (codigo, datos) => {
      res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(datos));
    };
    if (!hostEsLoopback(req)) return json(403, { ok: false, error: 'Solo loopback.' });
    if (req.headers.origin || req.headers['sec-fetch-site']) return json(403, { ok: false, error: 'Este endpoint no atiende navegadores.' });
    if (!tokenCoincide(token, req.headers['x-lagrange-token'])) return json(401, { ok: false, error: 'Token inválido.' });

    const ruta = new URL(req.url, 'http://127.0.0.1').pathname;
    try {
      // FEAT-092 §5.1 — `accion: agentes`: las de este nodo y las de la red.
      if (req.method === 'GET' && ruta === '/sesiones') {
        const r = registro.listaRed ? await registro.listaRed() : { sesiones: registro.lista() };
        return json(200, { ok: true, ...r });
      }
      if (req.method !== 'POST') return json(405, { ok: false, error: 'Método no permitido.' });
      // FEAT-090 §4 — `bridge:nodo -- migrar-almas`: lo hace el daemon del nodo.
      if (ruta === '/almas/migrar') {
        if (!telegram?.migrarAlmas) return json(404, { ok: false, error: 'Este daemon no es un nodo.' });
        try {
          const c = await leerCuerpo(req, TOPE_CUERPO);
          return json(200, { ok: true, informe: await telegram.migrarAlmas({ simular: c.simular === true }) });
        } catch (err) {
          return json(err.codigo || 502, { ok: false, error: err.message });
        }
      }
      // FEAT-090 §3.3 — Las almas del conector de un nodo van al servidor.
      if (ruta === '/almas') {
        if (!telegram?.almas) return json(404, { ok: false, error: 'Este daemon no es un nodo: las almas están acá.' });
        try {
          const c = await leerCuerpo(req, TOPE_ALMAS);
          return json(200, { ok: true, resultado: await telegram.almas(String(c.op || ''), Array.isArray(c.args) ? c.args : []) });
        } catch (err) {
          return json(err.codigo || 502, { ok: false, error: err.message });
        }
      }
      // FEAT-092 §8 — Un nodo sin Voicebox le pide la voz al servidor.
      if (ruta === '/voz/narrar') {
        if (!telegram?.vozNarrar) return json(404, { ok: false, error: 'Este daemon no es un nodo: la voz es la de acá.' });
        try {
          const c = await leerCuerpo(req, TOPE_VOZ);
          return json(200, { ok: true, ...((await telegram.vozNarrar({ texto: String(c.texto || ''), voz: typeof c.voz === 'string' ? c.voz : null, modo: typeof c.modo === 'string' ? c.modo : null, idioma: typeof c.idioma === 'string' ? c.idioma : null, alma: typeof c.alma === 'string' ? c.alma : null })) || {}) });
        } catch (err) {
          return json(err.codigo || 502, { ok: false, error: err.message });
        }
      }
      if (ruta.startsWith('/telegram/')) {
        if (!telegram) return json(404, { ok: false, error: 'Este daemon no es un nodo: Telegram va directo.' });
        try {
          return json(200, { ok: true, ...((await rutaTelegram(req, ruta, telegram)) || {}) });
        } catch (err) {
          return json(err.codigo || 502, { ok: false, error: err.message });
        }
      }
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return json(415, { ok: false, error: 'Se espera JSON.' });
      const c = await leerCuerpo(req);
      let r;
      if (ruta === '/sesiones/alta') r = registro.alta(c);
      else if (ruta === '/sesiones/baja') r = registro.baja(c.sesion, Number.isInteger(c.mcpPid) ? { mcpPid: c.mcpPid } : { soloSiMuerto: true });
      else if (ruta === '/sesiones/nombre') r = registro.renombrar(c.sesion, c.nombre);
      else if (ruta === '/sesiones/silenciar') r = registro.silenciar(c.sesion, c.si);
      else if (ruta === '/mensajes') r = await registro.enviar({ de: c.de, para: c.para, texto: c.texto, respuestaA: c.respuestaA });
      else return json(404, { ok: false, error: 'Ruta desconocida.' });
      const { codigo = 200, ...resto } = r;
      return json(r.ok ? 200 : codigo, resto);
    } catch (err) {
      return json(err.codigo || 500, { ok: false, error: err.codigo ? err.message : 'Error interno.' });
    }
  });
}

/**
 * Levanta el enlace y escribe `enlace.json` en el directorio de datos. Al
 * cerrar lo borra, solo si sigue siendo de este proceso. Resuelve con
 * `{ servidor, url, archivo, actualizar }`, o `null` si no pudo escuchar (el bot sigue).
 *
 * FEAT-089 — En un nodo, `telegram` es el cliente de la red, y `actualizar`
 * anota en `enlace.json` si está conectado al servidor (lo lee
 * `bridge:nodo estado`).
 */
export function arrancarEnlaceLocal({ registro, dataDir, rol = 'solo', telegram = null, log = () => {} }) {
  const token = crypto.randomBytes(24).toString('hex');
  const servidor = crearServidorEnlace({ registro, token, telegram });
  const archivo = path.join(dataDir, 'enlace.json');
  let contenido = null;
  let extra = {};
  const escribir = () => {
    if (!contenido) return;
    try {
      fs.writeFileSync(archivo, JSON.stringify({ ...contenido, ...extra, actualizado: new Date().toISOString() }, null, 2), { mode: 0o600 });
    } catch (err) {
      log(`[enlace] No se pudo escribir enlace.json: ${err.message}.`);
    }
  };
  const actualizar = (campos) => {
    extra = { ...extra, ...campos };
    escribir();
  };
  return new Promise((resolve) => {
    servidor.once('error', (err) => {
      log(`[enlace] No se pudo levantar el endpoint local: ${err.message}. Sin mensajes entre sesiones.`);
      resolve(null);
    });
    servidor.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${servidor.address().port}`;
      contenido = { rol, url, token, pid: process.pid };
      escribir();
      servidor.on('close', () => {
        try {
          if (JSON.parse(fs.readFileSync(archivo, 'utf8')).pid === process.pid) fs.unlinkSync(archivo);
        } catch {}
      });
      resolve({ servidor, url, archivo, actualizar });
    });
  });
}
