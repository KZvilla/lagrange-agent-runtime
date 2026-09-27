/**
 * FEAT-089 §4 — Las operaciones de `npm run bridge:nodo`, como funciones que se
 * pueden probar. Escriben archivos del directorio de datos; el daemon los lee
 * en el próximo pedido (servidor) o en el próximo arranque (nodo).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  nombreValido, nombrePorDefecto, generarClaves, pruebaEmparejar, nuevoCodigo, hashCodigo,
  leerNodos, mutarNodos, leerNodoPropio, archivosRed
} from './identidad.js';
import { validarUrlDeServidor, parsearEscucha } from './direcciones.js';
import { escribirJson, borrarJson, leerJson } from './almacen.js';
import { pedirHttp } from './cliente-nodo.js';

export const VIGENCIA_CODIGO_MS = 10 * 60_000;

/** `invitar [nombre]` (servidor): un código de un solo uso, guardado hasheado. */
export function invitar(dataDir, nombre = null, { ahora = Date.now() } = {}) {
  if (nombre !== null && !nombreValido(nombre)) throw new Error(`"${nombre}" no es un nombre válido (a-z, 0-9 y guiones, hasta 32).`);
  const codigo = nuevoCodigo();
  const vence = new Date(ahora + VIGENCIA_CODIGO_MS).toISOString();
  mutarNodos(dataDir, (d) => {
    if (nombre && d.nodos.some((n) => n.nombre === nombre)) throw new Error(`Ya hay un nodo llamado ${nombre}.`);
    d.invitaciones = d.invitaciones.filter((i) => Date.parse(i.vence) > ahora);
    d.invitaciones.push({ hashCodigo: hashCodigo(codigo), nombre, vence, intentos: 0 });
    return true;
  });
  return { codigo, vence };
}

/**
 * SEC-022 §5.5 — La regla de firewall para la segunda dirección. Lagrange no
 * la crea: es configuración de seguridad del sistema y la hace el usuario.
 */
export function ayudaFirewall(escuchar) {
  const p = parsearEscucha(escuchar);
  if (!p) return null;
  return [
    `Para que los nodos de otras máquinas lleguen a ${escuchar}, abrí el puerto solo para Tailscale:`,
    '',
    '  Windows (PowerShell como administrador):',
    `    New-NetFirewallRule -DisplayName "Lagrange nodos" -Direction Inbound -Protocol TCP -LocalPort ${p.puerto} -LocalAddress ${p.ip} -RemoteAddress 100.64.0.0/10 -Action Allow`,
    '',
    '  Linux (ufw):',
    `    sudo ufw allow in on tailscale0 to ${p.ip} port ${p.puerto} proto tcp`,
    '',
    'Lagrange no crea la regla por su cuenta.'
  ].join('\n');
}

/** `listar` (servidor): lo que dice `nodos.json`, más la conexión si el daemon responde. */
export function listar(dataDir) {
  return leerNodos(dataDir).nodos.map((n) => ({
    id: n.id, nombre: n.nombre, version: n.version || null, ultimaConexion: n.ultimaConexion || null, creado: n.creado
  }));
}

/** `revocar <nombre|id>` (servidor). El daemon corta el flujo en su próximo latido. */
export function revocar(dataDir, quien) {
  let quitado = null;
  mutarNodos(dataDir, (d) => {
    quitado = d.nodos.find((n) => n.id === quien || n.nombre === quien) || null;
    if (!quitado) return false;
    d.nodos = d.nodos.filter((n) => n !== quitado);
    d.asksRemotos = d.asksRemotos.filter((a) => a.nodo !== quitado.id);
    return true;
  });
  return quitado;
}

/**
 * `unirse <url> <codigo> [--nombre N]` (nodo). Genera el par de claves, canjea
 * el código y verifica la prueba del servidor: si no verifica, no se escribe
 * nada (un servidor falso no conoce el código).
 */
export async function unirse(dataDir, url, codigo, { nombre = null, wsl = false, interfazCifrada = '', pedir = pedirHttp, red = {} } = {}) {
  // SEC-022 §5.3 — Loopback, o una dirección que este nodo alcanza por su túnel.
  const destino = await validarUrlDeServidor(url, { interfazCifrada, ...red.direcciones }, red.resolver ? { resolver: red.resolver } : {});
  if (!destino.ok) throw new Error(`No se puede usar ${url}: ${destino.motivo}`);
  const nombreFinal = nombre ?? nombrePorDefecto({ wsl });
  if (!nombreValido(nombreFinal)) throw new Error(`"${nombreFinal}" no es un nombre válido (a-z, 0-9 y guiones, hasta 32).`);
  if (leerNodoPropio(dataDir)) throw new Error('Este nodo ya está emparejado. Para cambiar de servidor: `npm run bridge:nodo -- salir` primero.');
  const base = new URL(url).origin;
  const id = crypto.randomUUID();
  const claves = generarClaves();
  const r = await pedir(base, '/nodo/emparejar', { cuerpo: { codigo, id, nombre: nombreFinal, clavePublica: claves.clavePublica } });
  if (r.status !== 200 || !r.datos?.ok) throw new Error(r.datos?.error || `El servidor respondió ${r.status}.`);
  const { servidorId, clavePublicaServidor, prueba } = r.datos;
  const esperada = pruebaEmparejar(codigo, id, claves.clavePublica, clavePublicaServidor);
  if (typeof prueba !== 'string' || prueba.length !== esperada.length
    || !crypto.timingSafeEqual(Buffer.from(prueba), Buffer.from(esperada))) {
    throw new Error('El servidor no pudo probar que conoce el código: no es el que emitió la invitación. No se guardó nada.');
  }
  const nodo = { id, nombre: r.datos.nombre || nombreFinal, servidor: base, servidorId, clavePublicaServidor, ...claves, ...(interfazCifrada ? { interfazCifrada } : {}) };
  escribirJson(archivosRed(dataDir).nodo, nodo);
  return { id, nombre: nodo.nombre, servidor: base };
}

/** `estado` (nodo): emparejamiento y conexión (lo que el daemon anota en `enlace.json`). */
export function estado(dataDir) {
  const nodo = leerNodoPropio(dataDir);
  const enlace = leerJson(path.join(dataDir, 'enlace.json'), null);
  let vivo = false;
  if (enlace && Number.isInteger(enlace.pid)) {
    try { process.kill(enlace.pid, 0); vivo = true; } catch (err) { vivo = err.code === 'EPERM'; }
  }
  return {
    emparejado: Boolean(nodo),
    id: nodo?.id || null,
    nombre: nodo?.nombre || null,
    servidor: nodo?.servidor || null,
    daemonVivo: vivo && enlace?.rol === 'nodo',
    conectado: vivo && enlace?.conectado === true,
    estado: vivo ? enlace?.estado || null : null
  };
}

/** `salir` (nodo): borra `nodo.json`. El servidor lo sigue listando hasta un `revocar`. */
export function salir(dataDir) {
  return borrarJson(archivosRed(dataDir).nodo);
}

export function existeNodoJson(dataDir) {
  return fs.existsSync(archivosRed(dataDir).nodo);
}
