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

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', (d) => {
      total += d.length;
      if (total > TOPE_CUERPO) { reject(Object.assign(new Error('Cuerpo demasiado grande.'), { codigo: 413 })); req.destroy(); return; }
      partes.push(d);
    });
    req.on('end', () => {
      if (!partes.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(partes).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(Object.assign(new Error('JSON inválido.'), { codigo: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function crearServidorEnlace({ registro, token }) {
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
      if (req.method === 'GET' && ruta === '/sesiones') return json(200, { ok: true, sesiones: registro.lista() });
      if (req.method !== 'POST') return json(405, { ok: false, error: 'Método no permitido.' });
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return json(415, { ok: false, error: 'Se espera JSON.' });
      const c = await leerCuerpo(req);
      let r;
      if (ruta === '/sesiones/alta') r = registro.alta(c);
      else if (ruta === '/sesiones/baja') r = registro.baja(c.sesion);
      else if (ruta === '/sesiones/nombre') r = registro.renombrar(c.sesion, c.nombre);
      else if (ruta === '/sesiones/silenciar') r = registro.silenciar(c.sesion, c.si);
      else if (ruta === '/mensajes') r = registro.enviar({ de: c.de, para: c.para, texto: c.texto, respuestaA: c.respuestaA });
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
 * `{ servidor, url, archivo }`, o `null` si no pudo escuchar (el bot sigue).
 */
export function arrancarEnlaceLocal({ registro, dataDir, rol = 'solo', log = () => {} }) {
  const token = crypto.randomBytes(24).toString('hex');
  const servidor = crearServidorEnlace({ registro, token });
  const archivo = path.join(dataDir, 'enlace.json');
  return new Promise((resolve) => {
    servidor.once('error', (err) => {
      log(`[enlace] No se pudo levantar el endpoint local: ${err.message}. Sin mensajes entre sesiones.`);
      resolve(null);
    });
    servidor.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${servidor.address().port}`;
      try {
        fs.writeFileSync(archivo, JSON.stringify({ rol, url, token, pid: process.pid, actualizado: new Date().toISOString() }, null, 2), { mode: 0o600 });
      } catch (err) {
        log(`[enlace] No se pudo escribir enlace.json: ${err.message}.`);
      }
      servidor.on('close', () => {
        try {
          if (JSON.parse(fs.readFileSync(archivo, 'utf8')).pid === process.pid) fs.unlinkSync(archivo);
        } catch {}
      });
      resolve({ servidor, url, archivo });
    });
  });
}
