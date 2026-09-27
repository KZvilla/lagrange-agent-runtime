/**
 * SEC-022 §5 — Qué direcciones puede usar la red fuera de loopback.
 *
 * El tráfico entre nodos va en HTTP plano con un token de sesión, así que
 * tiene que ir por un túnel cifrado. No alcanza con mirar el rango:
 * `100.64.0.0/10` es el de Tailscale y también el CGNAT de los proveedores de
 * internet. La regla es por INTERFAZ: la IP tiene que ser de la interfaz de
 * Tailscale, o de la que el usuario nombra como su túnel.
 *
 * `interfaces` y `plataforma` se inyectan en los tests.
 */

import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';

const sinPrefijoV4 = (ip) => String(ip).replace(/^::ffff:/i, '');

function octetos(ip) {
  const v4 = sinPrefijoV4(ip);
  if (!net.isIPv4(v4)) return null;
  return v4.split('.').map(Number);
}

export function esLoopback(ip) {
  const o = octetos(ip);
  if (o) return o[0] === 127;
  return String(ip).toLowerCase() === '::1';
}

/** `0.0.0.0` o `::`: escuchar en todas las interfaces. */
export function esTodas(ip) {
  return ['0.0.0.0', '::', '::0'].includes(String(ip).toLowerCase());
}

/** 100.64.0.0/10 o fd7a:115c:a1e0::/48: los rangos de Tailscale (el v4 lo comparte el CGNAT). */
export function enRangoTailscale(ip) {
  const o = octetos(ip);
  if (o) return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
  return String(ip).toLowerCase().startsWith('fd7a:115c:a1e0:');
}

export function esPrivada(ip) {
  const o = octetos(ip);
  if (o) return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
  return /^f[cd][0-9a-f]{2}:/i.test(String(ip));
}

export function esInterfazTailscale(nombre, plataforma = process.platform) {
  const n = String(nombre || '');
  // En Windows el adaptador puede tener sufijo ("Tailscale Tunnel").
  return plataforma === 'win32' ? /^tailscale/i.test(n) : n === 'tailscale0';
}

/** Nombre de la interfaz que tiene esa IP, o `null`. */
export function interfazDeIp(ip, interfaces = os.networkInterfaces()) {
  const buscada = sinPrefijoV4(ip).toLowerCase();
  for (const [nombre, dirs] of Object.entries(interfaces || {})) {
    for (const d of dirs || []) {
      if (String(d.address).toLowerCase().split('%')[0] === buscada) return nombre;
    }
  }
  return null;
}

export function tieneTailscale(interfaces = os.networkInterfaces(), plataforma = process.platform) {
  return Object.keys(interfaces || {}).some((n) => esInterfazTailscale(n, plataforma) && (interfaces[n] || []).length > 0);
}

/** `<ip>:<puerto>` o `[<ipv6>]:<puerto>`. */
export function parsearEscucha(valor) {
  const s = String(valor || '').trim();
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) || /^([^:]+):(\d+)$/.exec(s);
  if (!m) return null;
  const puerto = Number(m[2]);
  if (!net.isIP(m[1]) || !Number.isInteger(puerto) || puerto < 1 || puerto > 65535) return null;
  return { ip: m[1], puerto };
}

/**
 * §5.2 — ¿Se puede escuchar para nodos en `BRIDGE_NODOS_ESCUCHAR`? Solo si la
 * IP es de la interfaz de Tailscale o de la que nombra
 * `BRIDGE_NODOS_INTERFAZ_CIFRADA`.
 *
 * @returns {{ ok: boolean, ip?: string, puerto?: number, interfaz?: string, error?: string }}
 */
export function validarEscucha(valor, { interfaces = os.networkInterfaces(), plataforma = process.platform, cifrada = '' } = {}) {
  const p = parsearEscucha(valor);
  if (!p) return { ok: false, error: `BRIDGE_NODOS_ESCUCHAR=${valor} no es <ip>:<puerto>.` };
  if (esTodas(p.ip)) return { ok: false, error: `${p.ip} es escuchar en todas las interfaces, incluida la de internet: poné la IP del túnel.` };
  if (esLoopback(p.ip)) return { ok: false, error: 'Loopback no hace falta: los nodos de esta máquina ya entran por la consola.' };
  const interfaz = interfazDeIp(p.ip, interfaces);
  if (!interfaz) return { ok: false, error: `${p.ip} no es una dirección de esta máquina.` };
  if (esInterfazTailscale(interfaz, plataforma)) return { ok: true, ...p, interfaz };
  if (cifrada && interfaz === cifrada) return { ok: true, ...p, interfaz };
  return {
    ok: false,
    error: `${p.ip} es de la interfaz "${interfaz}", que no es un túnel. Usá la IP de Tailscale, o nombrá tu interfaz de WireGuard en BRIDGE_NODOS_INTERFAZ_CIFRADA.`
  };
}

/**
 * §5.3 — ¿Puede un nodo conectarse a esta dirección? Loopback siempre; un
 * rango de Tailscale solo si este nodo tiene Tailscale activo (así una `100.x`
 * de CGNAT no sirve); otra privada solo con la interfaz cifrada presente.
 *
 * @returns {{ ok: boolean, motivo?: string }}
 */
export function direccionAlcanzable(ip, { interfaces = os.networkInterfaces(), plataforma = process.platform, interfazCifrada = '' } = {}) {
  if (esLoopback(ip)) return { ok: true };
  if (enRangoTailscale(ip)) {
    return tieneTailscale(interfaces, plataforma)
      ? { ok: true }
      : { ok: false, motivo: `${ip} es de Tailscale (o de un CGNAT), pero este nodo no tiene Tailscale activo.` };
  }
  if (esPrivada(ip)) {
    if (!interfazCifrada) return { ok: false, motivo: `${ip} es privada: hace falta --interfaz-cifrada <nombre> con la interfaz de tu túnel.` };
    if (!(interfaces || {})[interfazCifrada]?.length) return { ok: false, motivo: `La interfaz ${interfazCifrada} no está activa en este nodo.` };
    return { ok: true };
  }
  return { ok: false, motivo: `${ip} es una dirección pública: el tráfico entre nodos no está cifrado, tiene que ir por un túnel.` };
}

/**
 * §5.3 — Un `lookup` para `node:http` que valida cada dirección en el momento
 * de conectar: sin ventana entre validar y conectar, y un nombre que pasa a
 * resolver a otra cosa corta la conexión.
 */
export function crearLookup(opciones = {}, { resolver = dns.lookup, alRechazar = () => {} } = {}) {
  return (hostname, opts, callback) => {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    resolver(hostname, opts, (err, direccion, familia) => {
      if (err) return callback(err);
      const lista = Array.isArray(direccion) ? direccion : [{ address: direccion, family: familia }];
      for (const d of lista) {
        const r = direccionAlcanzable(d.address, opciones);
        if (!r.ok) {
          alRechazar(hostname, d.address, r.motivo);
          return callback(Object.assign(new Error(`${hostname} resolvió a ${d.address}: ${r.motivo}`), { code: 'EDIRECCIONRECHAZADA' }));
        }
      }
      return Array.isArray(direccion) ? callback(null, direccion) : callback(null, direccion, familia);
    });
  };
}

/**
 * Valida una URL de servidor antes de usarla. Una IP literal se valida acá
 * (`node:http` no llama a `lookup` para IPs); un nombre, resolviéndolo.
 */
export async function validarUrlDeServidor(texto, opciones = {}, { resolver = dns.promises.lookup } = {}) {
  let u;
  try { u = new URL(String(texto)); } catch { return { ok: false, motivo: 'URL inválida.' }; }
  if (u.protocol !== 'http:') return { ok: false, motivo: 'Se espera http:// (el túnel ya cifra).' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return direccionAlcanzable(host, opciones);
  if (host === 'localhost') return { ok: true };
  let dirs;
  try { dirs = await resolver(host, { all: true }); } catch (err) { return { ok: false, motivo: `No se pudo resolver ${host}: ${err.message}` }; }
  for (const d of dirs) {
    const r = direccionAlcanzable(d.address, opciones);
    if (!r.ok) return { ok: false, motivo: `${host} resuelve a ${d.address}: ${r.motivo}` };
  }
  return dirs.length ? { ok: true } : { ok: false, motivo: `${host} no resolvió a ninguna dirección.` };
}
