/**
 * SEC-022 §5.1 — La segunda dirección del servidor, solo para nodos de otra
 * máquina. La consola se queda en loopback: por acá solo existe `/nodo/*`, con
 * el mismo manejador (`servidor-nodos.js`), y todo lo demás responde 404. Un
 * `http.Server` escucha en una sola dirección, por eso es otro servidor y no
 * la consola expuesta con un filtro por origen.
 */

import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import { validarEscucha } from './direcciones.js';

const hostDe = (ip, puerto) => `${net.isIPv6(ip) ? `[${ip}]` : ip}:${puerto}`.toLowerCase();

/**
 * El servidor HTTP, sin escuchar todavía. `Host` tiene que ser `<ip>:<puerto>`
 * o uno de `nombres` (con o sin el puerto): es el chequeo que en la consola
 * hace `hostEsLoopback`.
 */
export function crearServidorListener({ servidorNodos, ip, puerto, nombres = [] }) {
  const permitidos = new Set([hostDe(ip, puerto)]);
  for (const n of nombres) {
    const limpio = String(n).trim().toLowerCase();
    if (!limpio) continue;
    permitidos.add(limpio);
    permitidos.add(`${limpio}:${puerto}`);
  }
  return http.createServer((req, res) => {
    const json = (codigo, datos) => {
      res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(datos));
    };
    if (!permitidos.has(String(req.headers.host || '').toLowerCase())) { req.resume(); return json(403, { ok: false, error: 'Host no permitido.' }); }
    let url;
    try { url = new URL(req.url, 'http://nodo.invalid'); } catch { req.resume(); return json(400, { ok: false, error: 'URL inválida.' }); }
    if (!url.pathname.startsWith('/nodo/')) { req.resume(); return json(404, { ok: false, error: 'No existe.' }); }
    servidorNodos.atender(req, res, url).catch(() => { try { res.end(); } catch {} });
  });
}

/**
 * Arranca la segunda dirección si `BRIDGE_NODOS_ESCUCHAR` está puesto y su IP
 * es de un túnel (§5.2). Nunca tumba el daemon: si no puede, lo dice y sigue.
 * Resuelve con `{ servidor, url }` o `null`.
 */
export function arrancarListenerNodos({ env = process.env, servidorNodos, interfaces = os.networkInterfaces(), plataforma = process.platform, log = () => {} }) {
  const valor = String(env.BRIDGE_NODOS_ESCUCHAR || '').trim();
  if (!valor) return Promise.resolve(null);
  const v = validarEscucha(valor, { interfaces, plataforma, cifrada: String(env.BRIDGE_NODOS_INTERFAZ_CIFRADA || '').trim() });
  if (!v.ok) {
    log(`[red] No se abre la dirección para nodos: ${v.error}`);
    return Promise.resolve(null);
  }
  const nombres = String(env.BRIDGE_NODOS_NOMBRES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const servidor = crearServidorListener({ servidorNodos, ip: v.ip, puerto: v.puerto, nombres });
  return new Promise((resolve) => {
    servidor.once('error', (err) => {
      log(`[red] No se pudo escuchar para nodos en ${valor}: ${err.message}.`);
      resolve(null);
    });
    servidor.listen(v.puerto, v.ip, () => {
      log(`[red] Nodos de otras máquinas: http://${hostDe(v.ip, v.puerto)} (interfaz ${v.interfaz}). Hace falta una regla de firewall (npm run bridge:nodo -- invitar la muestra).`);
      resolve({ servidor, url: `http://${hostDe(v.ip, v.puerto)}` });
    });
  });
}
