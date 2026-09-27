'use strict';

/**
 * FEAT-092 — El lado del MCP de los mensajes entre sesiones: se da de alta en
 * el daemon de su entorno (por el endpoint local de `enlace.json`), deja los
 * punteros para que sus hooks encuentren el buzón, y atiende la herramienta
 * `mensaje`. La lectura va directo al buzón (con su lock): es de esta sesión.
 *
 * `sesion` es el `CLAUDE_CODE_SESSION_ID` con el que arrancó el MCP; sin él
 * (Codex, o un MCP lanzado a mano) se genera uno y la sesión queda `manual`: su
 * MCP no sabe cuál es el proceso de sus hooks (sonda S3).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const buzones = require('./buzones.js');

const TIMEOUT_PEDIDO_MS = 10000;
const TOPE_ESPERA_S = 600;
const INTERVALO_ESPERA_MS = 1000;
const SIN_DAEMON = 'El daemon de Lagrange no está corriendo en este entorno: sin él no hay mensajes entre sesiones. Arrancalo con `npm run bridge:daemon:start` desde el clon.';

function leerEnlace(dataDir, { vivo = buzones.pidVivo } = {}) {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(dataDir, 'enlace.json'), 'utf8'));
    if (e && typeof e.url === 'string' && typeof e.token === 'string' && vivo(e.pid)) return e;
  } catch {}
  return null;
}

function crearCliente({
  env = process.env,
  dataDir = buzones.dataDirPath(env),
  pid = process.pid,
  ppid = process.ppid,
  cwd = process.cwd(),
  host = os.hostname(),
  fetchFn = globalThis.fetch,
  dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
  vivo = buzones.pidVivo
} = {}) {
  const idClaude = String(env.CLAUDE_CODE_SESSION_ID || '');
  const bajoClaude = buzones.sesionValida(idClaude);
  const alta = {
    sesion: bajoClaude ? idClaude : `x${crypto.randomBytes(8).toString('hex')}`,
    host,
    cwd,
    mcpPid: pid,
    // Claude Code lanza el MCP por stdio sin intermediario: su `ppid` es el
    // `CLAUDE_PID` que ven los hooks (sonda S2).
    claudePid: bajoClaude && Number.isInteger(ppid) && ppid > 1 ? ppid : null,
    nombre: null
  };
  let registradoEn = null;

  async function pedir(enlace, metodo, ruta, cuerpo) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_PEDIDO_MS);
    try {
      const res = await fetchFn(`${enlace.url}${ruta}`, {
        method: metodo,
        headers: { 'x-lagrange-token': enlace.token, ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: ctrl.signal
      });
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /** Alta idempotente. Se repite si el daemon cambió (se reinició). */
  async function asegurar() {
    const enlace = leerEnlace(dataDir, { vivo });
    if (!enlace) return null;
    if (registradoEn !== enlace.pid) {
      const r = await pedir(enlace, 'POST', '/sesiones/alta', alta);
      if (!r || !r.ok) throw new Error(r?.error || 'El daemon rechazó el alta.');
      alta.nombre = r.sesion.nombre;
      buzones.escribirPunteros(dataDir, alta);
      registradoEn = enlace.pid;
    }
    return enlace;
  }

  /** Al cerrar el MCP: los punteros se borran ya; la baja, si se puede. */
  function baja() {
    buzones.borrarPunteros(dataDir, alta);
    const enlace = leerEnlace(dataDir, { vivo });
    if (enlace && registradoEn) pedir(enlace, 'POST', '/sesiones/baja', { sesion: alta.sesion }).catch(() => {});
  }

  function formatearLectura({ mensajes, quedan }) {
    if (!mensajes.length) return 'No hay mensajes nuevos de otros agentes.';
    const partes = mensajes.map(buzones.encuadrar);
    if (quedan > 0) partes.push(`Hay ${quedan} mensaje${quedan === 1 ? '' : 's'} más sin leer: volvé a llamar con accion: leer.`);
    return partes.join('\n\n═══\n\n');
  }

  async function esperarRespuesta(id, segundos) {
    const limite = Date.now() + Math.min(TOPE_ESPERA_S, Math.max(0, Number(segundos) || 0)) * 1000;
    // BE-057 — Mientras espera, los hooks no avisan por esta respuesta: la entrega esta llamada.
    try { buzones.anotarEsperando(dataDir, alta.sesion, id, limite + 5000); } catch {}
    try {
      while (Date.now() < limite) {
        const m = buzones.tomarRespuesta(dataDir, alta.sesion, id);
        if (m) return m;
        await dormir(INTERVALO_ESPERA_MS);
      }
      return null;
    } finally {
      buzones.quitarEsperando(dataDir, alta.sesion, id);
    }
  }

  async function enviarYEsperar(enlace, cuerpo, esperar) {
    const r = await pedir(enlace, 'POST', '/mensajes', { de: alta.sesion, ...cuerpo });
    if (!r || !r.ok) return { ok: false, texto: `No se envió: ${r?.error || 'error desconocido'}` };
    let texto = `Entregado a ${r.para} (id ${r.id}). Lo va a ver ${r.como}.`;
    if (esperar > 0) {
      const respuesta = await esperarRespuesta(r.id, esperar);
      texto += respuesta
        ? `\n\nRespuesta:\n\n${buzones.encuadrar(respuesta)}`
        : `\n\nNo respondió en ${Math.min(TOPE_ESPERA_S, esperar)} s. Si contesta después, lo vas a ver con accion: leer.`;
    }
    return { ok: true, texto };
  }

  /** La herramienta `mensaje`. Devuelve `{ ok, texto }`. */
  async function accion(args = {}) {
    let enlace;
    try {
      enlace = await asegurar();
    } catch (err) {
      return { ok: false, texto: `No se pudo registrar esta sesión: ${err.message}` };
    }
    if (!enlace) return { ok: false, texto: SIN_DAEMON };

    switch (args.accion) {
      case 'agentes': {
        const r = await pedir(enlace, 'GET', '/sesiones');
        if (!r?.ok) return { ok: false, texto: r?.error || 'No se pudo leer la lista.' };
        const filas = r.sesiones.map((s) => {
          const yo = s.nombre === alta.nombre ? ' ← esta sesión' : '';
          const estado = s.silenciada ? 'no recibe' : s.entrega === 'hooks' ? 'recibe' : 'recibe (solo con leer)';
          return `- ${s.nodo}/${s.nombre} · ${s.proyecto || '?'} · ${s.host || '?'} · desde ${s.desde} · ${estado}${yo}`;
        });
        const texto = filas.length ? filas.join('\n') : 'No hay sesiones registradas.';
        // FEAT-092 §5.1 — Si el servidor no respondió, son solo las de este nodo.
        return { ok: true, texto: r.aviso ? `${texto}\n⚠️ ${r.aviso}` : texto };
      }
      case 'enviar':
        if (!args.para || !args.texto) return { ok: false, texto: 'Hacen falta `para` y `texto`.' };
        return enviarYEsperar(enlace, { para: args.para, texto: args.texto }, args.esperar);
      case 'responder':
        if (!args.id || !args.texto) return { ok: false, texto: 'Hacen falta `id` y `texto`.' };
        return enviarYEsperar(enlace, { respuestaA: args.id, texto: args.texto }, args.esperar);
      case 'leer':
        return { ok: true, texto: formatearLectura(buzones.tomarParaLeer(dataDir, alta.sesion, { todos: args.todos === true })) };
      case 'nombre': {
        const r = await pedir(enlace, 'POST', '/sesiones/nombre', { sesion: alta.sesion, nombre: args.nombre });
        if (!r?.ok) return { ok: false, texto: r?.error || 'No se pudo cambiar el nombre.' };
        alta.nombre = r.sesion.nombre;
        buzones.escribirPunteros(dataDir, alta);
        return { ok: true, texto: `Esta sesión ahora se llama ${r.sesion.nodo}/${r.sesion.nombre}.` };
      }
      case 'silenciar': {
        const r = await pedir(enlace, 'POST', '/sesiones/silenciar', { sesion: alta.sesion, si: args.si !== false });
        if (!r?.ok) return { ok: false, texto: r?.error || 'No se pudo.' };
        return { ok: true, texto: r.sesion.silenciada ? 'Esta sesión ya no recibe mensajes.' : 'Esta sesión vuelve a recibir mensajes.' };
      }
      default:
        return { ok: false, texto: 'accion tiene que ser agentes, enviar, leer, responder, nombre o silenciar.' };
    }
  }

  return { alta, asegurar, baja, accion };
}

module.exports = { crearCliente, leerEnlace, SIN_DAEMON };
