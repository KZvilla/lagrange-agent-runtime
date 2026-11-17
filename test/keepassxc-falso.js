/**
 * FEAT-198 — Un KeePassXC falso que habla el protocolo de KeePassXC-Browser con
 * NaCl de verdad, para los tests. Reproduce lo medido en E0 contra KeePassXC 2.7.12:
 * JSON crudo, nonce incrementado, asociación por conexión (sin `test-associate`,
 * `errorCode 8`), base bloqueada (`errorCode 1` al instante, también con
 * `triggerUnlock`) y el aviso `database-unlocked` por la misma conexión.
 *
 * No es un `.test.js`: `run.js` no lo corre solo.
 */
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const nacl = require('../mcp-server/lib/vendor/tweetnacl.js');

const b64 = (u) => Buffer.from(u).toString('base64');
const deB64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));
function inc(n) { const r = Uint8Array.from(n); for (let i = 0; i < r.length; i++) { r[i] = (r[i] + 1) & 0xff; if (r[i] !== 0) break; } return r; }

function rutaDePrueba() {
  const id = crypto.randomBytes(6).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\lagrange-test-keepassxc-${id}` : path.join(os.tmpdir(), `lagrange-test-kpxc-${id}.sock`);
}

/**
 * `opciones`: `{ bloqueada, entradas: { url: [{ password, ... }] }, asociaciones: { id: idKey },
 *   demoraMs, rechazar: Set<url>, nonceMalo, nombreAsociacion }`.
 */
async function crearKeepassFalso(opciones = {}) {
  const estado = {
    bloqueada: Boolean(opciones.bloqueada),
    entradas: opciones.entradas || {},
    asociaciones: opciones.asociaciones || {},
    grupos: [],
    demoraMs: opciones.demoraMs || 0,
    rechazar: opciones.rechazar || new Set(),
    nonceMalo: Boolean(opciones.nonceMalo),
    pedidos: [],
    conexiones: new Set()
  };
  const claves = nacl.box.keyPair();
  const ruta = rutaDePrueba();

  const servidor = net.createServer((socket) => {
    estado.conexiones.add(socket);
    socket.on('close', () => estado.conexiones.delete(socket));
    socket.on('error', () => {});
    let clientePub = null;
    let asociado = false;
    let buffer = '';
    const responder = (j) => socket.write(JSON.stringify(j));
    const error = (action, code, texto = 'error') => responder({ action, error: texto, errorCode: String(code) });
    const cifrado = (action, nonceDelPedido, interno) => {
      const n = estado.nonceMalo ? nacl.randomBytes(24) : inc(nonceDelPedido);
      const cuerpo = { ...interno, nonce: b64(n), version: '2.7.12', success: 'true' };
      const msg = nacl.box(Buffer.from(JSON.stringify(cuerpo)), n, clientePub, claves.secretKey);
      responder({ action, message: b64(msg), nonce: b64(n) });
    };
    socket.on('data', async (d) => {
      buffer += d.toString('utf8');
      let j;
      try { j = JSON.parse(buffer); buffer = ''; } catch { return; }
      estado.pedidos.push(j.action);
      if (j.action === 'change-public-keys') {
        clientePub = deB64(j.publicKey);
        const n = estado.nonceMalo ? nacl.randomBytes(24) : inc(deB64(j.nonce));
        responder({ action: j.action, publicKey: b64(claves.publicKey), nonce: b64(n), version: '2.7.12', success: 'true' });
        return;
      }
      if (!clientePub) return error(j.action, 3);
      const nonce = deB64(j.nonce);
      const plano = nacl.box.open(deB64(j.message), nonce, clientePub, claves.secretKey);
      if (!plano) return error(j.action, 4);
      const m = JSON.parse(Buffer.from(plano).toString('utf8'));
      if (estado.bloqueada) {
        if (j.triggerUnlock === 'true') estado.pidieronDesbloqueo = (estado.pidieronDesbloqueo || 0) + 1;
        return error(j.action, 1, 'Base de datos no abierta');
      }
      switch (m.action) {
        case 'associate': {
          const id = opciones.nombreAsociacion || 'lagrange-test';
          estado.asociaciones[id] = m.idKey;
          asociado = true;
          return cifrado(m.action, nonce, { id, hash: 'h' });
        }
        case 'test-associate':
          if (estado.asociaciones[m.id] && estado.asociaciones[m.id] === m.key) { asociado = true; return cifrado(m.action, nonce, { id: m.id, hash: 'h' }); }
          return error(m.action, 8);
        case 'get-logins': {
          if (!asociado) return error(m.action, 8);
          if (estado.demoraMs) await new Promise((ok) => setTimeout(ok, estado.demoraMs));
          if (estado.rechazar.has(m.url)) return error(m.action, 6);
          const lista = estado.entradas[m.url] || [];
          if (!lista.length) return error(m.action, 15, 'No se encontraron inicios de sesión');
          return cifrado(m.action, nonce, { count: lista.length, entries: lista.map((e) => ({ login: 'lagrange', name: m.url.replace('lagrange://', ''), group: 'Lagrange', uuid: 'u', stringFields: [], ...e })) });
        }
        case 'get-database-groups':
          if (!asociado) return error(m.action, 8);
          return cifrado(m.action, nonce, { groups: { groups: [{ name: 'Raíz', uuid: 'raiz', children: estado.grupos.map((g) => ({ name: g, uuid: `uuid-${g}`, children: [] })) }] } });
        case 'create-new-group':
          if (!asociado) return error(m.action, 8);
          estado.grupos.push(m.groupName);
          return cifrado(m.action, nonce, { name: m.groupName, uuid: `uuid-${m.groupName}` });
        case 'set-login':
          if (!asociado) return error(m.action, 8);
          estado.entradas[m.url] = [{ password: m.password, group: m.group }];
          estado.ultimoSetLogin = { url: m.url, group: m.group, groupUuid: m.groupUuid };
          return cifrado(m.action, nonce, { count: 0, entries: 0, error: 'success' });
        default:
          return error(m.action, 12);
      }
    });
  });
  await new Promise((ok, mal) => { servidor.once('error', mal); servidor.listen(ruta, ok); });

  return {
    ruta,
    estado,
    /** Desbloquea y avisa por cada conexión abierta, como KeePassXC. */
    desbloquear() {
      estado.bloqueada = false;
      for (const s of estado.conexiones) s.write(JSON.stringify({ action: 'database-unlocked' }));
    },
    cerrar() {
      for (const s of estado.conexiones) s.destroy();
      return new Promise((ok) => servidor.close(() => ok()));
    }
  };
}

/** Una asociación nueva para registrar en el falso: `{ id, idKey }`. */
function asociacionDePrueba(id = 'lagrange-test') {
  return { id, idKey: b64(nacl.box.keyPair().publicKey) };
}

module.exports = { crearKeepassFalso, asociacionDePrueba };
