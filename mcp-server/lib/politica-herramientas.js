/**
 * FEAT-162 F3 — Con una orquestación abierta, las herramientas del MCP que equivalen a un «ejecutar» de la consola
 * (agy_lote lanzar, agy_fanout, cast_agent cast/register/unregister/forget/importar) pasan por el mismo modo que la
 * API: `operar` las frena, `pedir` devuelve una aprobación pendiente y `yolo` las deja; todas quedan en el registro.
 *
 * Lo aprobado es exactamente lo que corre: la consola guarda la `huella` (sha256 de los argumentos con las claves
 * ordenados, sin `aprobacion`) y la sesión la consume una vez al volver a llamar con `aprobacion`.
 *
 * Sin consola activa (sin credencial, daemon caído o sin respuesta) la herramienta sigue como antes de F3: sin
 * consola no hay una orquestación que mirar. No es una barrera contra un proceso con acceso al disco.
 */
'use strict';

const crypto = require('node:crypto');
const api = require('./consola-api.js');

/** Lo que pasa por la política, por herramienta (la misma tabla que `HERRAMIENTAS_CON_POLITICA` del servidor). */
const CON_POLITICA = Object.freeze({
  agy_lote: ['lanzar'], agy_fanout: ['lanzar'], cast_agent: ['cast', 'register', 'unregister', 'forget', 'importar']
});

/** La acción de cada herramienta como la ve la política. agy_fanout siempre lanza. */
function accionDe(nombre, args = {}) {
  if (nombre === 'agy_lote') return String(args.accion || 'lanzar');
  if (nombre === 'agy_fanout') return 'lanzar';
  if (nombre === 'cast_agent') return String(args.action || 'cast');
  return '';
}

const pasaPorPolitica = (nombre, accion) => (CON_POLITICA[nombre] || []).includes(accion);

/** JSON con las claves ordenadas: la sesión rearma los argumentos y el orden puede cambiar entre dos llamadas. */
function canonico(v) {
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function huella(args = {}) {
  const { aprobacion, ...resto } = args;
  return crypto.createHash('sha256').update(canonico(resto)).digest('hex');
}

/** Lo que ve el usuario al aprobar: qué y con qué, sin el prompt entero. */
function resumir(nombre, accion, args = {}) {
  const corto = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (nombre === 'cast_agent') {
    if (accion === 'cast') return `cast a ${corto(args.agent, 40)}: ${corto(args.prompt, 200)}`;
    if (accion === 'register') return `registrar ${corto(args.agent, 40)} desde la skill ${corto(args.skill, 60)}${args.read_only === false ? ' (con edición)' : ' (solo lectura)'}`;
    return `${accion} ${corto(args.agent, 40)}`;
  }
  const tareas = Array.isArray(args.tareas) ? args.tareas : Array.isArray(args.tasks) ? args.tasks : [];
  const titulos = tareas.slice(0, 3).map((t) => corto(t?.titulo || t?.title || t?.id || t?.prompt, 50)).join('; ');
  return `${nombre === 'agy_lote' ? `lote ${corto(args.slug, 40)}` : 'fan-out'}: ${tareas.length} tarea${tareas.length === 1 ? '' : 's'}${titulos ? ` (${titulos}${tareas.length > 3 ? '…' : ''})` : ''}`;
}

const sinPolitica = { seguir: true, cerrar: async () => {} };

/**
 * Antes de correr. `{ seguir: true, cerrar(resultado, enlace) }` o `{ seguir: false, error, texto }`.
 * `opciones` va a `consola-api.pedir` (acceso, quien, sesion, fetchImpl en los tests).
 */
async function antesDeHerramienta(nombre, args = {}, opciones = {}) {
  const accion = accionDe(nombre, args);
  if (!pasaPorPolitica(nombre, accion)) return sinPolitica;
  let r;
  try {
    const acceso = opciones.acceso ?? api.leerAcceso();
    r = await api.pedir('POST', '/api/orquestaciones/herramienta', {
      herramienta: nombre, accion, huella: huella(args), resumen: resumir(nombre, accion, args),
      ...(args.aprobacion ? { aprobacion: String(args.aprobacion) } : {})
    }, { ...opciones, acceso });
  } catch {
    // Sin consola (o sin respuesta): no hay orquestación que mirar.
    return sinPolitica;
  }
  if (r.status === 202) {
    const a = r.datos?.pendiente;
    return { seguir: false, error: false, texto: `Pendiente de aprobación (\`${a}\`): con una orquestación abierta en modo pedir, ${nombre} ${accion} espera al usuario (consola, vista Orquestación). Esperala con consola esperar (tipo aprobacion, id ${a}) y volvé a llamar a ${nombre} con aprobacion: "${a}" y exactamente los mismos argumentos.` };
  }
  if (r.status === 200 && r.datos?.libre) return sinPolitica;
  if (r.status === 200 && r.datos?.permitido) {
    const accionId = r.datos.accion;
    return {
      seguir: true,
      cerrar: async (resultado, enlace = null) => {
        if (!accionId) return;
        try {
          await api.pedir('POST', `/api/orquestaciones/herramienta/${encodeURIComponent(accionId)}/resultado`, { resultado, ...(enlace ? { enlace } : {}) }, opciones);
        } catch { /* el registro es un rastro: si la consola no responde, la herramienta ya corrió */ }
      }
    };
  }
  return { seguir: false, error: true, texto: `${nombre} ${accion}: ${r.datos?.error || `la consola respondió ${r.status}`}` };
}

/**
 * Envuelve una llamada a herramienta: consulta la política, corre `correr()` si corresponde y cierra la acción con
 * su resultado (el lote lanzado queda enlazado al paso en curso).
 */
async function conPolitica(nombre, args, correr, opciones = {}) {
  const p = await antesDeHerramienta(nombre, args, opciones);
  if (!p.seguir) return p.error ? { isError: true, content: [{ type: 'text', text: p.texto }] } : { content: [{ type: 'text', text: p.texto }] };
  let resultado;
  try {
    resultado = await correr();
  } catch (err) {
    await p.cerrar('error');
    throw err;
  }
  const enlace = nombre === 'agy_lote' && !resultado?.isError && args.slug ? { tipo: 'lote', id: String(args.slug).trim() } : null;
  await p.cerrar(resultado?.isError ? 'error' : 'ok', enlace);
  return resultado;
}

module.exports = { CON_POLITICA, accionDe, pasaPorPolitica, canonico, huella, resumir, antesDeHerramienta, conPolitica };
