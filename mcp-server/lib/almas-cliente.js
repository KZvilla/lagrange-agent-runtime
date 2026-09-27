/**
 * FEAT-090 §3.3 — Las almas vistas desde el conector (el MCP de una sesión).
 *
 * En `solo` y `servidor`, las operaciones corren acá, sobre el disco
 * (`almas/operaciones.js`). En `rol = nodo` (lo dice `enlace.json` con el
 * daemon vivo), van al servidor por el endpoint local del nodo: `POST /almas {
 * op, args }` y de ahí a `/nodo/almas`. El directorio local de almas de un nodo
 * no se lee ni se escribe.
 *
 * Todas las operaciones son asíncronas, en los dos caminos, para que quien las
 * llama no sepa cuál le tocó.
 */

const fs = require('fs');
const path = require('path');
const buzones = require('./buzones.js');
const operaciones = require('../almas/operaciones.js');

const TIMEOUT_MS = 30_000;

class ErrorAlmasRemotas extends Error {
  constructor(mensaje, codigo = 502) {
    super(mensaje);
    this.codigo = codigo;
  }
}

/** El endpoint local de un nodo con el daemon vivo, o `null`. */
function enlaceDeNodo({ env = process.env, dataDir = buzones.dataDirPath(env), vivo = buzones.pidVivo } = {}) {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(dataDir, 'enlace.json'), 'utf8'));
    if (e && e.rol === 'nodo' && typeof e.url === 'string' && typeof e.token === 'string' && vivo(e.pid)) return e;
  } catch {}
  return null;
}

const OPS = ['claveExistente', 'existe', 'listar', 'resumenListado', 'identidad', 'contexto', 'ver', 'inventario', 'inventarioAlma', 'inventarioUsuario',
  'anotarDiario', 'olvidar', 'sembrar', 'exportar', 'previsualizarImportacion', 'importar', 'consolidar'];

function crearAlmas({ env = process.env, fetchFn = globalThis.fetch, enlace = () => enlaceDeNodo({ env }) } = {}) {
  async function remota(op, args) {
    const e = enlace();
    if (!e) throw new ErrorAlmasRemotas('Las almas viven en el servidor, y el daemon de este nodo no está corriendo.', 503);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchFn(new URL('/almas', e.url), {
        method: 'POST',
        headers: { 'x-lagrange-token': e.token, 'content-type': 'application/json' },
        body: JSON.stringify({ op, args }),
        signal: ctrl.signal
      });
    } catch (err) {
      throw new ErrorAlmasRemotas(`Las almas viven en el servidor, que no responde (${err.message}).`, 503);
    } finally {
      clearTimeout(t);
    }
    let datos = null;
    try { datos = await res.json(); } catch {}
    if (!res.ok || !datos || datos.ok === false) throw new ErrorAlmasRemotas(datos?.error || `El servidor respondió ${res.status}.`, res.status || 502);
    return datos.resultado;
  }

  function local(op, args) {
    const [a, b, c] = Array.isArray(args) ? args : [];
    switch (op) {
      case 'inventario': {
        const inv = require('../watch-inventory.js');
        return inv.listarAlmas();
      }
      case 'inventarioAlma': return require('../watch-inventory.js').detalleAlma(a);
      case 'inventarioUsuario': return require('../watch-inventory.js').memoriaUsuario();
      case 'consolidar': return operaciones.recibirPendiente(a);
      default: return operaciones[op](a, b, c);
    }
  }

  const api = { enNodo: () => Boolean(enlace()) };
  for (const op of OPS) {
    api[op] = async (...args) => (enlace() ? remota(op, args) : local(op, args));
  }
  return api;
}

/**
 * FEAT-090 §3.3 — Lo que ejecuta el servidor cuando un nodo pide una
 * operación: siempre local, nunca otra vez por la red.
 */
function ejecutarLocal(op, args) {
  if (!OPS.includes(op)) throw new ErrorAlmasRemotas(`Operación de almas desconocida: ${op}.`, 400);
  return crearAlmas({ enlace: () => null })[op](...(Array.isArray(args) ? args : []));
}

module.exports = { crearAlmas, enlaceDeNodo, ejecutarLocal, OPS, ErrorAlmasRemotas };
