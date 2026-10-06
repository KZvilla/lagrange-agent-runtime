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
  vivo = buzones.pidVivo,
  // BE-066 — Cuándo arrancó este MCP: entre dos vivos de la misma sesión, manda el más nuevo.
  inicio = Date.now() - Math.round(process.uptime() * 1000),
  // FEAT-129 — Evento `mensaje` en la base de conocimiento. Nunca el texto.
  anotarEvento = () => {}
} = {}) {
  const idClaude = String(env.CLAUDE_CODE_SESSION_ID || '');
  // BE-066 — Si otro MCP vivo ya tiene esta sesión y no es del mismo Claude,
  // este proceso heredó la variable (un test, un MCP lanzado a mano desde la
  // sesión): va como sesión manual y no le pisa el alta ni los punteros.
  const previa = buzones.sesionValida(idClaude) ? buzones.leerAlta(dataDir, idClaude) : null;
  // Con el mismo PID pero otro Claude no es este MCP: es un PID reusado.
  const ajena = Boolean(previa && previa.claudePid !== ppid && (previa.mcpPid === pid || vivo(previa.mcpPid)));
  const bajoClaude = buzones.sesionValida(idClaude) && !ajena;
  const alta = {
    sesion: bajoClaude ? idClaude : `x${crypto.randomBytes(8).toString('hex')}`,
    host,
    cwd,
    mcpPid: pid,
    // Claude Code lanza el MCP por stdio sin intermediario: su `ppid` es el
    // `CLAUDE_PID` que ven los hooks (sonda S2).
    claudePid: bajoClaude && Number.isInteger(ppid) && ppid > 1 ? ppid : null,
    // BE-112 — Siempre: bajo Codex o a mano es el único padre que el daemon puede mirar.
    padrePid: Number.isInteger(ppid) && ppid > 1 ? ppid : null,
    nombre: null,
    inicio
  };
  /** BE-066 — Si esta alta de disco es de otro MCP vivo que arrancó después, o a la vez (empate: se queda el que estaba). */
  const deUnoMasNuevo = (otra) => Boolean(otra && otra.mcpPid !== alta.mcpPid && vivo(otra.mcpPid) && Number(otra.inicio || 0) >= alta.inicio);
  /** BE-066 — Si esta alta de disco es de otro MCP vivo (sea cual sea su generación). */
  const deOtroVivo = (otra) => Boolean(otra && otra.mcpPid !== alta.mcpPid && vivo(otra.mcpPid));
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
      const datos = await res.json();
      // El código HTTP, sin que aparezca al serializar la respuesta.
      if (datos && typeof datos === 'object') Object.defineProperty(datos, 'estado', { value: res.status, enumerable: false });
      return datos;
    } finally {
      clearTimeout(t);
    }
  }

  const noRegistrada = (r) => Boolean(r && r.ok === false && (r.estado === 403 || r.estado === 404) && /no está registrada/.test(String(r.error || '')));

  /**
   * BE-066 — Un pedido en nombre de esta sesión. Si el daemon ya no la conoce
   * (la dio de baja otro proceso, o la barrió), vuelve a darla de alta y
   * reintenta una vez. El reintento es seguro: el daemon no aceptó el primero.
   */
  async function pedirComoSesion(enlace, metodo, ruta, cuerpo) {
    const r = await pedir(enlace, metodo, ruta, cuerpo);
    if (!noRegistrada(r)) return r;
    registradoEn = null;
    let nuevo = null;
    try { nuevo = await asegurar(); } catch { return r; }
    return nuevo ? pedir(nuevo, metodo, ruta, cuerpo) : r;
  }

  /** Alta idempotente. Se repite si el daemon cambió (se reinició). */
  async function asegurar() {
    const enlace = leerEnlace(dataDir, { vivo });
    if (!enlace) return null;
    if (registradoEn !== enlace.pid) {
      const r = await pedir(enlace, 'POST', '/sesiones/alta', alta);
      if (!r || !r.ok) throw new Error(r?.error || 'El daemon rechazó el alta.');
      alta.nombre = r.sesion.nombre;
      // BE-066 — Si un MCP más nuevo de esta sesión ya la tiene (el daemon se la
      // dejó, o sus punteros están en disco), este no los pisa.
      if (!r.ajena) buzones.escribirPunteros(dataDir, alta, { salvo: deUnoMasNuevo });
      registradoEn = enlace.pid;
    } else if (punterosPerdidos()) {
      // BE-066 — Un MCP viejo que cerró tarde los borró: se rehacen, salvo que otro vivo los haya tomado en el medio.
      buzones.escribirPunteros(dataDir, alta, { salvo: deOtroVivo });
    }
    return enlace;
  }

  /**
   * BE-066 — Si faltan los punteros de esta sesión o quedaron de un MCP muerto.
   * Nunca los de otro MCP vivo: si otro los tiene, la sesión ya es suya.
   */
  function punterosPerdidos() {
    const enDisco = buzones.leerAlta(dataDir, alta.sesion);
    if (enDisco && enDisco.mcpPid !== alta.mcpPid) return !vivo(enDisco.mcpPid);
    if (!enDisco) return true;
    if (!alta.claudePid) return false;
    let p = null;
    try { p = JSON.parse(fs.readFileSync(buzones.rutaPuntero(dataDir, alta.claudePid), 'utf8')); } catch {}
    // Un puntero a otra sesión del mismo Claude no se toca.
    return !p || (p.sesion === alta.sesion && p.mcpPid !== alta.mcpPid && !vivo(p.mcpPid));
  }

  /** Al cerrar el MCP: los punteros se borran ya; la baja, si se puede. */
  function baja() {
    buzones.borrarPunteros(dataDir, alta);
    const enlace = leerEnlace(dataDir, { vivo });
    // BE-066 — Con el pid: si otro MCP ya retomó la sesión, el daemon no la da de baja.
    if (enlace && registradoEn) pedir(enlace, 'POST', '/sesiones/baja', { sesion: alta.sesion, mcpPid: alta.mcpPid }).catch(() => {});
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
    const r = await pedirComoSesion(enlace, 'POST', '/mensajes', { de: alta.sesion, ...cuerpo });
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
  /** FEAT-129 — Sin el texto del mensaje: solo a quién y cuántos bytes. Nunca lanza. */
  function anotar(campos) {
    const destino = campos.para ? `a ${campos.para}` : `respuesta a ${campos.respuestaA}`;
    try { anotarEvento({ tipo: 'mensaje', texto: `${alta.nombre || 'esta sesión'} ${destino} (${campos.bytes} bytes)`, ...campos }); } catch {}
  }

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
      case 'enviar': {
        if (!args.para || !args.texto) return { ok: false, texto: 'Hacen falta `para` y `texto`.' };
        const r = await enviarYEsperar(enlace, { para: args.para, texto: args.texto }, args.esperar);
        if (r.ok) anotar({ para: String(args.para), bytes: Buffer.byteLength(String(args.texto), 'utf8') });
        return r;
      }
      case 'responder': {
        if (!args.id || !args.texto) return { ok: false, texto: 'Hacen falta `id` y `texto`.' };
        const r = await enviarYEsperar(enlace, { respuestaA: args.id, texto: args.texto }, args.esperar);
        if (r.ok) anotar({ respuestaA: String(args.id), bytes: Buffer.byteLength(String(args.texto), 'utf8') });
        return r;
      }
      case 'leer':
        return { ok: true, texto: formatearLectura(buzones.tomarParaLeer(dataDir, alta.sesion, { todos: args.todos === true })) };
      case 'nombre': {
        const r = await pedirComoSesion(enlace, 'POST', '/sesiones/nombre', { sesion: alta.sesion, nombre: args.nombre });
        if (!r?.ok) return { ok: false, texto: r?.error || 'No se pudo cambiar el nombre.' };
        alta.nombre = r.sesion.nombre;
        // BE-066 — Solo si los punteros siguen siendo de este MCP.
        buzones.escribirPunteros(dataDir, alta, { salvo: deOtroVivo });
        return { ok: true, texto: `Esta sesión ahora se llama ${r.sesion.nodo}/${r.sesion.nombre}.` };
      }
      case 'silenciar': {
        const r = await pedirComoSesion(enlace, 'POST', '/sesiones/silenciar', { sesion: alta.sesion, si: args.si !== false });
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
