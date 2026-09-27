/**
 * FEAT-089 §2-§4 — Identidad de la red: nombres de nodo, claves Ed25519,
 * textos firmados del apretón de manos y códigos de invitación. Todo con
 * `node:crypto`, sin dependencias.
 *
 * Las claves viajan y se guardan en base64 de su DER (SPKI la pública, PKCS#8
 * la privada). La privada nunca sale del disco de su dueño ni se loguea.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { leerJson, mutarJson } from './almacen.js';

/** §3.4 — Versión del protocolo. El servidor acepta esta y la anterior. */
export const PROTOCOLO = 1;

/** §2.1 — El nombre viaja como prefijo en Telegram: nada de corchetes, saltos ni HTML. */
export const NOMBRE_VALIDO = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function nombreValido(nombre) {
  return typeof nombre === 'string' && NOMBRE_VALIDO.test(nombre);
}

export function idValido(id) {
  return typeof id === 'string' && ID_VALIDO.test(id);
}

/** Un texto cualquiera (un hostname) a nombre válido. */
export function slugNombre(texto, respaldo = 'nodo') {
  const s = String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return nombreValido(s) ? s : respaldo;
}

/** §2.1 — Por defecto, el hostname con `-wsl` si corre en WSL. */
export function nombrePorDefecto({ hostname = os.hostname(), wsl = false } = {}) {
  const base = slugNombre(hostname);
  if (!wsl) return base;
  return `${base.slice(0, 28).replace(/-+$/g, '')}-wsl`;
}

export function generarClaves() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    clavePublica: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    clavePrivada: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  };
}

export function firmar(clavePrivada, texto) {
  const clave = crypto.createPrivateKey({ key: Buffer.from(clavePrivada, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(texto, 'utf8'), clave).toString('base64');
}

export function verificar(clavePublica, texto, firma) {
  try {
    const clave = crypto.createPublicKey({ key: Buffer.from(String(clavePublica), 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(texto, 'utf8'), clave, Buffer.from(String(firma), 'base64'));
  } catch {
    return false;
  }
}

/** ¿Es una clave pública Ed25519 que se puede usar? */
export function clavePublicaValida(clave) {
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(String(clave), 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

// §3.5 — Un prefijo distinto por paso: la firma de uno no sirve en el otro.
export const textoSaludo = (id, nonceNodo, nonceServidor) => `lagrange-saludo-v1\n${id}\n${nonceNodo}\n${nonceServidor}`;
export const textoSesion = (id, nonceServidor, nonceNodo) => `lagrange-sesion-v1\n${id}\n${nonceServidor}\n${nonceNodo}`;

/** §4.2 — Prueba del servidor en el canje: solo la puede producir quien conoce el código. */
export function pruebaEmparejar(codigo, id, clavePublicaNodo, clavePublicaServidor) {
  return crypto.createHmac('sha256', normalizarCodigo(codigo))
    .update(`lagrange-emparejar-v1\n${id}\n${clavePublicaNodo}\n${clavePublicaServidor}`)
    .digest('base64');
}

export function nonce() {
  return crypto.randomBytes(32).toString('base64');
}

// §4.2 — Base32 sin ambiguos (sin 0, 1, I, O): 12 caracteres ≈ 60 bits.
const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function nuevoCodigo() {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += ALFABETO[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** El código se tipea: guiones, espacios y minúsculas no cuentan. */
export function normalizarCodigo(codigo) {
  return String(codigo ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashCodigo(codigo) {
  return crypto.createHash('sha256').update(normalizarCodigo(codigo)).digest('hex');
}

export function tokenSesion() {
  return crypto.randomBytes(32).toString('hex');
}

// ------------------------------------------------------------------------------
// Archivos (§2.2)
// ------------------------------------------------------------------------------

export const archivosRed = (dataDir) => ({
  servidor: path.join(dataDir, 'servidor.json'),
  nodos: path.join(dataDir, 'nodos.json'),
  nodo: path.join(dataDir, 'nodo.json')
});

export const NODOS_VACIO = Object.freeze({ invitaciones: [], nodos: [], asksRemotos: [] });

/** `servidor.json`, creado la primera vez que hace falta. */
export function identidadServidor(dataDir) {
  const archivo = archivosRed(dataDir).servidor;
  const actual = leerJson(archivo, null);
  if (actual?.servidorId && actual.clavePrivada && actual.clavePublica) return actual;
  return mutarJson(archivo, {}, (d) => {
    if (d.servidorId && d.clavePrivada && d.clavePublica) return d;
    Object.assign(d, { servidorId: crypto.randomUUID(), ...generarClaves() });
    return d;
  });
}

export function leerNodos(dataDir) {
  const d = leerJson(archivosRed(dataDir).nodos, NODOS_VACIO);
  return {
    invitaciones: Array.isArray(d.invitaciones) ? d.invitaciones : [],
    nodos: Array.isArray(d.nodos) ? d.nodos : [],
    asksRemotos: Array.isArray(d.asksRemotos) ? d.asksRemotos : []
  };
}

export function mutarNodos(dataDir, fn) {
  return mutarJson(archivosRed(dataDir).nodos, NODOS_VACIO, (d) => {
    d.invitaciones = Array.isArray(d.invitaciones) ? d.invitaciones : [];
    d.nodos = Array.isArray(d.nodos) ? d.nodos : [];
    d.asksRemotos = Array.isArray(d.asksRemotos) ? d.asksRemotos : [];
    return fn(d);
  });
}

/** `nodo.json` de este nodo, o `null` si no está emparejado. */
export function leerNodoPropio(dataDir) {
  const d = leerJson(archivosRed(dataDir).nodo, null);
  if (!d || !idValido(d.id) || !d.servidor || !d.clavePrivada || !d.clavePublicaServidor) return null;
  return d;
}

/** ¿Es una URL de loopback? Hasta SEC-022 no se acepta otra (§4.2). */
export function urlDeLoopback(texto) {
  try {
    const u = new URL(String(texto));
    if (u.protocol !== 'http:') return false;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
