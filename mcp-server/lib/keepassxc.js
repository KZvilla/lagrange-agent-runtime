'use strict';

/**
 * FEAT-198 — Cliente mínimo del protocolo de KeePassXC-Browser, hablado directo con
 * el socket de KeePassXC (sin el proxy de native messaging).
 *
 * Protocolo: https://github.com/keepassxreboot/keepassxc-browser/blob/develop/keepassxc-protocol.md
 * Lo confirmado contra KeePassXC 2.7.12 real (E0, 2026-11-17):
 * - Windows: named pipe `\\.\pipe\org.keepassxc.KeePassXC.BrowserServer_<USERNAME>`;
 * - JSON crudo, sin prefijo de largo; los avisos sin pedido (`database-unlocked`)
 *   pueden llegar pegados a una respuesta;
 * - cada respuesta trae el nonce del pedido incrementado (little-endian);
 * - la asociación vale por conexión: sin `test-associate` en la misma conexión,
 *   todo pedido da `errorCode 8`;
 * - con la base bloqueada, todo menos `change-public-keys` da `errorCode 1` al
 *   instante, también con `triggerUnlock`; al desbloquear llega `database-unlocked`.
 *
 * Linux y macOS usan el mismo protocolo por un socket Unix; sus rutas salen de las
 * fuentes de KeePassXC y no pasaron por E0.
 *
 * Nada de lo que sale de acá (errores, avisos) lleva valores ni payloads del
 * protocolo, ni cifrados ni en claro: solo la acción, la entrada y un código.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const nacl = require('./vendor/tweetnacl.js');
const { escribirAtomico } = require('./fs-atomico.js');

const NOMBRE_SERVIDOR = 'org.keepassxc.KeePassXC.BrowserServer';
const ESQUEMA = 'lagrange://';
const GRUPO = 'Lagrange';
// Un pedido que puede mostrar un diálogo: el usuario puede tardar en verlo (no
// suena ni roba el foco, E0), así que la espera es larga.
const TIMEOUT_DIALOGO_MS = 120000;
// Sin diálogo posible (intercambio de claves, `test-associate`): corto.
const TIMEOUT_CORTO_MS = 5000;
// Pasado esto sin respuesta, se avisa que KeePassXC espera al usuario.
const AVISO_ESPERA_MS = 2000;
const RE_ENTRADA = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Códigos de error de KeePassXC (src/browser/BrowserAction.h).
const CODIGOS = Object.freeze({
  1: 'bloqueada',
  5: 'sin-respuesta',
  6: 'rechazado',
  8: 'sin-asociacion',
  9: 'protocolo',
  10: 'protocolo',
  15: 'sin-entrada',
  19: 'rechazado'
});

const MOTIVOS = Object.freeze({
  'sin-keepassxc': 'KeePassXC no está abierto o no tiene la integración con navegador activada',
  bloqueada: 'la base de KeePassXC está bloqueada: desbloqueala',
  'sin-asociacion': 'Lagrange no está asociado con esta base de KeePassXC (corré `node scripts/secretos.mjs asociar`)',
  'sin-entrada': 'KeePassXC no tiene la entrada o se negó el acceso',
  ambigua: 'KeePassXC devolvió más de una entrada para la misma URL',
  rechazado: 'KeePassXC rechazó el pedido',
  'sin-respuesta': 'KeePassXC no respondió a tiempo (¿un diálogo sin contestar?)',
  timeout: 'KeePassXC no respondió a tiempo (¿un diálogo sin contestar?)',
  protocolo: 'KeePassXC respondió algo que no se pudo validar',
  'entrada-invalida': 'el nombre de la entrada no es válido (minúsculas, números, punto, guion y guion bajo)'
});

class ErrorKeepassxc extends Error {
  constructor(codigo, { accion = null, entrada = null } = {}) {
    const donde = entrada ? ` (entrada ${entrada})` : '';
    super(`${MOTIVOS[codigo] || 'error de KeePassXC'}${donde}`);
    this.name = 'ErrorKeepassxc';
    this.codigo = codigo;
    this.accion = accion;
    this.entrada = entrada;
  }
}

const b64 = (u) => Buffer.from(u).toString('base64');
const deB64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));

/** El nonce incrementado como entero little-endian (`sodium_increment`). */
function incrementarNonce(n) {
  const r = Uint8Array.from(n);
  for (let i = 0; i < r.length; i++) {
    r[i] = (r[i] + 1) & 0xff;
    if (r[i] !== 0) break;
  }
  return r;
}

function iguales(a, b) {
  return a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/**
 * Las rutas donde puede estar el socket, en orden. `LAGRANGE_KEEPASSXC_SOCKET`
 * manda (la usan los tests y quien tenga una instalación rara).
 */
function rutasDelSocket(env = process.env, plataforma = process.platform) {
  const explicita = String(env.LAGRANGE_KEEPASSXC_SOCKET || '').trim();
  if (explicita) return [explicita];
  if (plataforma === 'win32') {
    const usuario = env.USERNAME || os.userInfo().username;
    return [`\\\\.\\pipe\\${NOMBRE_SERVIDOR}_${usuario}`];
  }
  const rutas = [];
  const runtime = String(env.XDG_RUNTIME_DIR || '').trim();
  if (runtime) {
    rutas.push(path.join(runtime, 'app', 'org.keepassxc.KeePassXC', NOMBRE_SERVIDOR));
    rutas.push(path.join(runtime, NOMBRE_SERVIDOR));
  }
  rutas.push(path.join(String(env.TMPDIR || os.tmpdir()), NOMBRE_SERVIDOR));
  return rutas;
}

/** Separa los JSON completos de `texto`; devuelve `{ mensajes, resto }`. */
function separarJson(texto) {
  const mensajes = [];
  let profundidad = 0;
  let inicio = -1;
  let enCadena = false;
  let escape = false;
  let corte = 0;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enCadena) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') enCadena = false;
      continue;
    }
    if (c === '"') enCadena = true;
    else if (c === '{') { if (profundidad === 0) inicio = i; profundidad++; }
    else if (c === '}' && profundidad > 0) {
      profundidad--;
      if (profundidad === 0) { mensajes.push(texto.slice(inicio, i + 1)); corte = i + 1; }
    }
  }
  return { mensajes, resto: texto.slice(corte) };
}

function conectar(rutas, timeoutMs) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const intentar = () => {
      if (i >= rutas.length) { reject(new ErrorKeepassxc('sin-keepassxc')); return; }
      const ruta = rutas[i++];
      const socket = net.connect(ruta);
      const reloj = setTimeout(() => { socket.destroy(); intentar(); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(reloj); socket.removeAllListeners('error'); resolve(socket); });
      socket.once('error', () => { clearTimeout(reloj); socket.destroy(); intentar(); });
    };
    intentar();
  });
}

/**
 * Una conexión con el intercambio de claves hecho. `pedir(interno)` cifra, manda y
 * espera la respuesta de esa acción; los avisos sin pedido van a `alAviso`.
 */
async function abrirSesion({ env = process.env, timeoutMs = TIMEOUT_CORTO_MS, alAviso = null } = {}) {
  const socket = await conectar(rutasDelSocket(env), timeoutMs);
  const clientID = b64(nacl.randomBytes(24));
  const claves = nacl.box.keyPair();
  let publicaServidor = null;
  let buffer = '';
  let espera = null;
  let cerrado = false;

  const fallar = (err) => {
    if (!espera) return;
    const e = espera;
    espera = null;
    clearTimeout(e.reloj);
    clearTimeout(e.aviso);
    e.reject(err);
  };

  socket.setEncoding('utf8');
  socket.on('data', (trozo) => {
    buffer += trozo;
    if (buffer.length > 1024 * 1024) { fallar(new ErrorKeepassxc('protocolo')); socket.destroy(); return; }
    const { mensajes, resto } = separarJson(buffer);
    buffer = resto;
    for (const texto of mensajes) {
      let m;
      try { m = JSON.parse(texto); } catch { fallar(new ErrorKeepassxc('protocolo')); continue; }
      if (espera && m && m.action === espera.accion) {
        const e = espera;
        espera = null;
        clearTimeout(e.reloj);
        clearTimeout(e.aviso);
        e.resolve(m);
      } else if (m && typeof m.action === 'string' && typeof alAviso === 'function') {
        try { alAviso(m.action); } catch {}
      }
    }
  });
  const alCerrar = () => { cerrado = true; fallar(new ErrorKeepassxc('sin-keepassxc')); };
  socket.on('close', alCerrar);
  socket.on('error', alCerrar);

  function enviar(accion, sobre, { timeout = timeoutMs, avisoEspera = null } = {}) {
    if (cerrado) return Promise.reject(new ErrorKeepassxc('sin-keepassxc', { accion }));
    if (espera) return Promise.reject(new Error('keepassxc: un pedido a la vez por sesión'));
    return new Promise((resolve, reject) => {
      espera = {
        accion, resolve, reject,
        reloj: setTimeout(() => fallar(new ErrorKeepassxc('timeout', { accion })), timeout),
        aviso: typeof avisoEspera === 'function' ? setTimeout(() => { try { avisoEspera(); } catch {} }, AVISO_ESPERA_MS) : null
      };
      socket.write(JSON.stringify(sobre));
    });
  }

  // Intercambio de claves: sin cifrar, sin diálogo.
  const nonce0 = nacl.randomBytes(24);
  const r0 = await enviar('change-public-keys', {
    action: 'change-public-keys', publicKey: b64(claves.publicKey), nonce: b64(nonce0), clientID
  }).catch((err) => { socket.destroy(); throw err; });
  if (r0.success !== 'true' || !r0.publicKey || !iguales(deB64(r0.nonce), incrementarNonce(nonce0))) {
    socket.destroy();
    throw new ErrorKeepassxc('protocolo', { accion: 'change-public-keys' });
  }
  publicaServidor = deB64(r0.publicKey);
  if (publicaServidor.length !== nacl.box.publicKeyLength) {
    socket.destroy();
    throw new ErrorKeepassxc('protocolo', { accion: 'change-public-keys' });
  }

  /**
   * Manda `interno` cifrado y devuelve la respuesta descifrada. Un error de
   * KeePassXC (sin cifrar, con `errorCode`) se lanza como `ErrorKeepassxc`.
   */
  async function pedir(interno, { extra = {}, timeout = timeoutMs, avisoEspera = null, entrada = null } = {}) {
    const accion = interno.action;
    const nonce = nacl.randomBytes(24);
    const mensaje = nacl.box(Buffer.from(JSON.stringify(interno), 'utf8'), nonce, publicaServidor, claves.secretKey);
    const r = await enviar(accion, { action: accion, message: b64(mensaje), nonce: b64(nonce), clientID, ...extra }, { timeout, avisoEspera });
    if (r.errorCode !== undefined || r.error) {
      throw new ErrorKeepassxc(CODIGOS[Number(r.errorCode)] || 'rechazado', { accion, entrada });
    }
    if (!r.message || !iguales(deB64(r.nonce), incrementarNonce(nonce))) throw new ErrorKeepassxc('protocolo', { accion, entrada });
    const plano = nacl.box.open(deB64(r.message), deB64(r.nonce), publicaServidor, claves.secretKey);
    if (!plano) throw new ErrorKeepassxc('protocolo', { accion, entrada });
    let j;
    try { j = JSON.parse(Buffer.from(plano).toString('utf8')); } catch { throw new ErrorKeepassxc('protocolo', { accion, entrada }); }
    if (!iguales(deB64(j.nonce), incrementarNonce(nonce))) throw new ErrorKeepassxc('protocolo', { accion, entrada });
    return j;
  }

  return {
    clientID,
    publicKey: b64(claves.publicKey),
    pedir,
    cerrar() { cerrado = true; socket.destroy(); }
  };
}

// --- La asociación (D5) ---

/** `<bridgeDataDir>/keepassxc.json`, sin importar `paths.js` (ESM): misma regla. */
function rutaAsociacion(env = process.env) {
  const explicito = String(env.TELEGRAM_BRIDGE_DATA_DIR || '').trim();
  if (explicito) return path.join(path.resolve(explicito), 'keepassxc.json');
  const base = process.platform === 'win32'
    ? (env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'));
  return path.join(base, 'antigravity-telegram-bridge', 'keepassxc.json');
}

/** `{ id, idKey }` o `null`. */
function leerAsociacion(env = process.env) {
  try {
    const a = JSON.parse(fs.readFileSync(rutaAsociacion(env), 'utf8'));
    if (typeof a?.id === 'string' && a.id && typeof a?.idKey === 'string' && deB64(a.idKey).length === 32) return { id: a.id, idKey: a.idKey };
  } catch {}
  return null;
}

function guardarAsociacion(asociacion, env = process.env) {
  escribirAtomico(rutaAsociacion(env), `${JSON.stringify({ version: 1, id: asociacion.id, idKey: asociacion.idKey }, null, 2)}\n`, { mode: 0o600 });
}

// --- Operaciones ---

function validarEntrada(entrada) {
  if (!RE_ENTRADA.test(String(entrada || ''))) throw new ErrorKeepassxc('entrada-invalida');
  return String(entrada);
}

const urlDe = (entrada) => `${ESQUEMA}${validarEntrada(entrada)}`;

/** `test-associate` en esta conexión. Con `desbloquear`, pide a KeePassXC que muestre el desbloqueo. */
async function probarAsociacion(sesion, asociacion, { desbloquear = false } = {}) {
  if (!asociacion) throw new ErrorKeepassxc('sin-asociacion');
  const r = await sesion.pedir(
    { action: 'test-associate', id: asociacion.id, key: asociacion.idKey },
    { extra: desbloquear ? { triggerUnlock: 'true' } : {} }
  );
  if (r.success !== 'true') throw new ErrorKeepassxc('sin-asociacion', { accion: 'test-associate' });
}

/**
 * Lee el valor de `lagrange://<entrada>`. Abre y cierra su propia conexión.
 * `alEsperar({ entrada })` se llama si KeePassXC tarda (un diálogo de acceso).
 */
async function leerSecreto(entrada, { env = process.env, asociacion = leerAsociacion(env), timeoutMs = TIMEOUT_DIALOGO_MS, alEsperar = null } = {}) {
  const url = urlDe(entrada);
  const sesion = await abrirSesion({ env });
  try {
    await probarAsociacion(sesion, asociacion);
    const r = await sesion.pedir(
      { action: 'get-logins', url, submitUrl: url, keys: [{ id: asociacion.id, key: asociacion.idKey }] },
      { timeout: timeoutMs, entrada, avisoEspera: typeof alEsperar === 'function' ? () => alEsperar({ entrada }) : null }
    );
    const entradas = Array.isArray(r.entries) ? r.entries : [];
    if (entradas.length === 0) throw new ErrorKeepassxc('sin-entrada', { accion: 'get-logins', entrada });
    if (entradas.length > 1) throw new ErrorKeepassxc('ambigua', { accion: 'get-logins', entrada });
    const valor = typeof entradas[0].password === 'string' ? entradas[0].password : '';
    if (!valor) throw new ErrorKeepassxc('sin-entrada', { accion: 'get-logins', entrada });
    return valor;
  } catch (err) {
    if (err instanceof ErrorKeepassxc && !err.entrada) err.entrada = entrada;
    throw err;
  } finally {
    sesion.cerrar();
  }
}

/**
 * Espera a que la base se desbloquee: pide el desbloqueo una vez y espera
 * `database-unlocked` con la conexión abierta. Resuelve `true` al desbloquear,
 * `false` si pasa `timeoutMs`. No reintenta con diálogos en bucle.
 */
async function esperarDesbloqueo({ env = process.env, asociacion = leerAsociacion(env), timeoutMs = 10 * 60 * 1000 } = {}) {
  let avisar;
  const desbloqueada = new Promise((resolve) => { avisar = resolve; });
  const sesion = await abrirSesion({ env, alAviso: (accion) => { if (accion === 'database-unlocked') avisar(true); } });
  let reloj;
  try {
    try {
      await probarAsociacion(sesion, asociacion, { desbloquear: true });
      return true; // ya estaba desbloqueada
    } catch (err) {
      if (!(err instanceof ErrorKeepassxc) || err.codigo !== 'bloqueada') throw err;
    }
    const vencida = new Promise((resolve) => { reloj = setTimeout(() => resolve(false), timeoutMs); });
    return await Promise.race([desbloqueada, vencida]);
  } finally {
    clearTimeout(reloj);
    sesion.cerrar();
  }
}

/** `associate`: KeePassXC muestra el diálogo y el usuario le pone nombre. Devuelve `{ id, idKey }`. */
async function asociar({ env = process.env, timeoutMs = TIMEOUT_DIALOGO_MS } = {}) {
  const sesion = await abrirSesion({ env });
  try {
    const id = nacl.box.keyPair();
    const r = await sesion.pedir({ action: 'associate', key: sesion.publicKey, idKey: b64(id.publicKey) }, { timeout: timeoutMs });
    if (r.success !== 'true' || typeof r.id !== 'string' || !r.id) throw new ErrorKeepassxc('rechazado', { accion: 'associate' });
    return { id: r.id, idKey: b64(id.publicKey) };
  } finally {
    sesion.cerrar();
  }
}

/** El uuid del grupo `Lagrange` en la raíz, creándolo si falta (`create-new-group` puede mostrar un diálogo). */
async function grupoLagrange(sesion, { timeoutMs = TIMEOUT_DIALOGO_MS } = {}) {
  const g = await sesion.pedir({ action: 'get-database-groups' });
  const raices = g?.groups?.groups || [];
  for (const raiz of raices) {
    const hijo = (raiz.children || []).find((c) => c.name === GRUPO);
    if (hijo?.uuid) return hijo.uuid;
  }
  const r = await sesion.pedir({ action: 'create-new-group', groupName: GRUPO }, { timeout: timeoutMs });
  if (!r.uuid) throw new ErrorKeepassxc('rechazado', { accion: 'create-new-group' });
  return r.uuid;
}

/**
 * Crea `lagrange://<entrada>` en el grupo `Lagrange` y la relee para confirmar:
 * la respuesta de `set-login` trae `error: "success"` (E0) y no alcanza.
 */
async function guardarSecreto(entrada, valor, { env = process.env, asociacion = leerAsociacion(env), timeoutMs = TIMEOUT_DIALOGO_MS } = {}) {
  const url = urlDe(entrada);
  const sesion = await abrirSesion({ env });
  try {
    await probarAsociacion(sesion, asociacion);
    const groupUuid = await grupoLagrange(sesion, { timeoutMs });
    await sesion.pedir({
      action: 'set-login', url, submitUrl: url, id: asociacion.id, nonce: b64(nacl.randomBytes(24)),
      login: 'lagrange', password: String(valor), group: GRUPO, groupUuid, uuid: '', downloadFavicon: 'false'
    }, { timeout: timeoutMs, entrada });
  } finally {
    sesion.cerrar();
  }
  const releido = await leerSecreto(entrada, { env, asociacion, timeoutMs });
  if (releido !== String(valor)) throw new ErrorKeepassxc('protocolo', { accion: 'set-login', entrada });
}

module.exports = {
  ESQUEMA, GRUPO, MOTIVOS, TIMEOUT_DIALOGO_MS, TIMEOUT_CORTO_MS, AVISO_ESPERA_MS, RE_ENTRADA,
  ErrorKeepassxc, incrementarNonce, separarJson, rutasDelSocket, rutaAsociacion,
  abrirSesion, leerAsociacion, guardarAsociacion, probarAsociacion,
  leerSecreto, esperarDesbloqueo, asociar, guardarSecreto
};
