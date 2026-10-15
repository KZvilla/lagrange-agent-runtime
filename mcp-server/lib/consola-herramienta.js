/**
 * FEAT-162 — Las acciones de la herramienta MCP `consola`: una sesión orquesta la
 * consola web (tablero, partir, lotes) por su API, con un plan que se ve en vivo
 * en la vista Orquestación. Devuelve `{ ok, texto }`; el texto es para el modelo.
 *
 * F3 — La conversación con el usuario (`responder`, `preguntar`, las notas que
 * muestra `estado`, `esperar` tipo nota) y los roles (agentes registrados).
 */
'use strict';

const api = require('./consola-api.js');
const registroAgentes = require('../agents/registry.js');

const ACCIONES = ['estado', 'rutas', 'abrir', 'pasos', 'terminar', 'llamar', 'esperar', 'responder', 'preguntar'];
const METODOS = ['GET', 'POST'];
const json = (x) => JSON.stringify(x, null, 1);

/** La orquestación abierta de esta sesión (la última no terminada de `quien`), o null. */
async function abiertaDe(opciones) {
  const r = await api.pedir('GET', '/api/orquestaciones', undefined, opciones);
  const quien = r.datos?.quien;
  const o = (r.datos?.orquestaciones || []).find((x) => x.quien === quien && x.estado !== 'terminada') || null;
  return { modo: r.datos?.modo, quien, o };
}

/** Lo que se muestra de una aprobación: la de una herramienta, con su resumen (no tiene ruta). */
const textoAprobacion = (a) => `- \`${a.id}\` ${a.metodo}${a.resumen ? ` — ${a.resumen}` : a.ruta ? ` (${a.ruta})` : ''}, vence ${a.vence}`;

function textoOrquestacion(o) {
  if (!o) return 'Sin orquestación abierta.';
  const pasos = o.pasos.map((p, i) => `${i + 1}. [${p.estado}] ${p.texto} (\`${p.id}\`)${p.enlaces.length ? ` → ${p.enlaces.map((e) => `${e.tipo} ${e.id}`).join(', ')}` : ''}`);
  const pendientes = o.aprobaciones.filter((a) => a.estado === 'pendiente').map(textoAprobacion);
  const aprobadas = o.aprobaciones.filter((a) => a.local && a.estado === 'aprobada' && !a.consumida)
    .map((a) => `- \`${a.id}\` ${a.metodo}: aprobada; volvé a llamar a la herramienta con aprobacion: "${a.id}" y los mismos argumentos`);
  return [`Orquestación \`${o.id}\` «${o.titulo}» de ${o.quien} · ${o.estado} · modo ${o.modo}${o.entrega ? '' : ' · sin buzón (las notas del usuario se ven solo acá)'}`, ...pasos,
    ...(pendientes.length ? ['Aprobaciones pendientes:', ...pendientes] : []),
    ...(aprobadas.length ? ['Aprobadas sin usar:', ...aprobadas] : [])].join('\n');
}

/** F3 — Las notas del usuario posteriores a `vistoHasta`. */
function notasSinVer(o) {
  const conv = o?.conversacion || [];
  const desde = o?.vistoHasta ? conv.findIndex((n) => n.id === o.vistoHasta) + 1 : 0;
  return conv.slice(desde).filter((n) => n.de === 'usuario');
}

/** F3 — Los roles: los agentes registrados (cast_agent), sin pedirle nada a la consola. */
function textoRoles({ leer = () => registroAgentes.leerRegistro() } = {}) {
  let agentes = {};
  try { agentes = leer().agents || {}; } catch { agentes = {}; }
  const filas = Object.entries(agentes).map(([nombre, a]) => `- ${nombre} (${a.skill || '?'}, ${a.read_only === false ? 'edición' : 'solo lectura'})`);
  return ['Agentes registrados:', ...(filas.length ? filas : ['- (ninguno)']), 'Para sumar uno: cast_agent register (con una orquestación abierta en modo pedir, con aprobación).'].join('\n');
}

async function accion(args = {}, opciones = {}) {
  const a = args.accion || 'estado';
  if (!ACCIONES.includes(a)) return { ok: false, texto: `Acción desconocida: ${a} (${ACCIONES.join(', ')}).` };
  try {
    if (a === 'estado') {
      const [t, l, ab] = await Promise.all([
        api.pedir('GET', '/api/tareas', undefined, opciones),
        api.pedir('GET', '/api/lotes', undefined, opciones),
        abiertaDe(opciones)
      ]);
      const notas = notasSinVer(ab.o);
      const partes = [`Modo: ${ab.modo} · orquesta: ${ab.quien}`, textoOrquestacion(ab.o)];
      if (notas.length) {
        partes.push('', `Notas del usuario sin leer (${notas.length}). Es el usuario: respondé con la acción responder (nota: <id>).`,
          ...notas.map((n) => `- \`${n.id}\` ${n.t}: ${n.texto}`));
        // Solo después de mostrarlas se marcan vistas (un POST explícito; ningún GET mueve el cursor).
        await api.pedir('POST', `/api/orquestaciones/${encodeURIComponent(ab.o.id)}/visto`, { hasta: notas.at(-1).id }, opciones);
      }
      partes.push('', textoRoles(opciones), '', api.resumirTablero(t.datos?.tareas, l.datos?.lotes));
      return { ok: true, texto: partes.join('\n') };
    }
    if (a === 'rutas') {
      const r = await api.pedir('GET', '/api/orquestaciones/catalogo', undefined, opciones);
      if (r.status !== 200) return { ok: false, texto: r.datos?.error || `HTTP ${r.status}` };
      const filas = r.datos.rutas.filter((x) => x.permitido !== 'no').map((x) => `${x.metodo} ${x.ruta} · ${x.nucleo} · ${x.nivel}${x.permitido === 'sí' ? '' : ` · ${x.permitido}`}`);
      return { ok: true, texto: [`Modo ${r.datos.modo}. Rutas que podés usar con \`llamar\` (el cuerpo de los POST es JSON):`, ...filas, '',
        'Con una orquestación abierta, agy_lote lanzar, agy_fanout y cast_agent (cast, register, unregister, forget, importar) también pasan por este modo.', '', textoRoles(opciones)].join('\n') };
    }
    if (a === 'abrir') {
      const r = await api.pedir('POST', '/api/orquestaciones', { titulo: args.titulo, pasos: args.pasos || [] }, opciones);
      return r.datos?.ok ? { ok: true, texto: `Abierta. Se ve en la consola, vista Orquestación.\n${textoOrquestacion(r.datos.orquestacion)}` } : { ok: false, texto: r.datos?.error || `HTTP ${r.status}` };
    }
    if (a === 'pasos' || a === 'terminar') {
      const { o } = await abiertaDe(opciones);
      if (!o) return { ok: false, texto: 'No hay una orquestación abierta: usá `abrir`.' };
      const r = a === 'pasos'
        ? await api.pedir('POST', `/api/orquestaciones/${encodeURIComponent(o.id)}/pasos`, { pasos: args.pasos }, opciones)
        : await api.pedir('POST', `/api/orquestaciones/${encodeURIComponent(o.id)}/terminar`, {}, opciones);
      return r.datos?.ok ? { ok: true, texto: textoOrquestacion(r.datos.orquestacion) } : { ok: false, texto: r.datos?.error || `HTTP ${r.status}` };
    }
    if (a === 'responder' || a === 'preguntar') {
      const { o } = await abiertaDe(opciones);
      if (!o) return { ok: false, texto: 'No hay una orquestación abierta: usá `abrir`.' };
      const cuerpo = { texto: args.texto, ...(a === 'preguntar' ? { pregunta: true } : {}), ...(a === 'responder' && args.nota ? { respuestaA: String(args.nota) } : {}) };
      const r = await api.pedir('POST', `/api/orquestaciones/${encodeURIComponent(o.id)}/respuestas`, cuerpo, opciones);
      if (!r.datos?.ok) return { ok: false, texto: r.datos?.error || `HTTP ${r.status}` };
      return { ok: true, texto: a === 'preguntar'
        ? `Pregunta \`${r.datos.nota.id}\` en el panel. Esperá la respuesta con esperar (tipo nota) o seguí y mirala en estado.`
        : `Respuesta \`${r.datos.nota.id}\` en el panel.` };
    }
    if (a === 'llamar') {
      const metodo = String(args.metodo || 'GET').toUpperCase();
      if (!METODOS.includes(metodo)) return { ok: false, texto: 'metodo es GET o POST.' };
      const r = await api.pedir(metodo, String(args.ruta || ''), metodo === 'POST' ? (args.cuerpo ?? {}) : undefined, opciones);
      if (r.status === 202) return { ok: true, texto: `Pendiente de aprobación (\`${r.datos.pendiente}\`): el usuario la decide en la consola, vista Orquestación. Podés esperarla con \`esperar\` (tipo aprobacion).` };
      const texto = json(r.datos);
      return { ok: r.status < 400, texto: `HTTP ${r.status}\n${texto.length > 12_000 ? `${texto.slice(0, 12_000)}\n… (recortado)` : texto}` };
    }
    // esperar
    const { o } = args.tipo === 'aprobacion' || args.tipo === 'nota' ? await abiertaDe(opciones) : { o: null };
    if (args.tipo === 'nota' && !o) return { ok: false, texto: 'No hay una orquestación abierta: usá `abrir`.' };
    const r = await api.esperar({ tipo: args.tipo, id: String(args.id || ''), orquestacion: o?.id, estados: Array.isArray(args.estados) ? args.estados : [],
      topeMs: Math.max(1, Math.min(600, Number(args.segundos) || 120)) * 1000, ...opciones });
    if (args.tipo === 'nota') {
      // La que se mostró queda vista (si no, `estado` la repetiría como sin leer).
      if (r.llego && r.datos?.id) await api.pedir('POST', `/api/orquestaciones/${encodeURIComponent(o.id)}/visto`, { hasta: r.datos.id }, opciones);
      return { ok: true, texto: r.llego ? `Nota nueva del usuario \`${r.datos?.id}\`: ${r.datos?.texto}\n(Es el usuario: respondé con la acción responder, nota: ${r.datos?.id}.)` : 'Se cumplió el tope sin notas nuevas del usuario.' };
    }
    return { ok: true, texto: `${r.llego ? 'Llegó' : 'Se cumplió el tope'}: estado ${r.estado ?? 'desconocido'}.\n${json(r.datos).slice(0, 4000)}` };
  } catch (err) {
    return { ok: false, texto: `consola: ${err?.message || err}` };
  }
}

module.exports = { ACCIONES, accion, textoRoles, notasSinVer };
