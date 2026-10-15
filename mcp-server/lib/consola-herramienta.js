/**
 * FEAT-162 — Las acciones de la herramienta MCP `consola`: una sesión orquesta la
 * consola web (tablero, partir, lotes) por su API, con un plan que se ve en vivo
 * en la vista Orquestación. Devuelve `{ ok, texto }`; el texto es para el modelo.
 */
'use strict';

const api = require('./consola-api.js');

const ACCIONES = ['estado', 'rutas', 'abrir', 'pasos', 'terminar', 'llamar', 'esperar'];
const METODOS = ['GET', 'POST'];
const json = (x) => JSON.stringify(x, null, 1);

/** La orquestación abierta de esta sesión (la última no terminada de `quien`), o null. */
async function abiertaDe(opciones) {
  const r = await api.pedir('GET', '/api/orquestaciones', undefined, opciones);
  const quien = r.datos?.quien;
  const o = (r.datos?.orquestaciones || []).find((x) => x.quien === quien && x.estado !== 'terminada') || null;
  return { modo: r.datos?.modo, quien, o };
}

function textoOrquestacion(o) {
  if (!o) return 'Sin orquestación abierta.';
  const pasos = o.pasos.map((p, i) => `${i + 1}. [${p.estado}] ${p.texto} (\`${p.id}\`)${p.enlaces.length ? ` → ${p.enlaces.map((e) => `${e.tipo} ${e.id}`).join(', ')}` : ''}`);
  const pendientes = o.aprobaciones.filter((a) => a.estado === 'pendiente').map((a) => `- \`${a.id}\` ${a.metodo} (${a.ruta}), vence ${a.vence}`);
  return [`Orquestación \`${o.id}\` «${o.titulo}» de ${o.quien} · ${o.estado} · modo ${o.modo}`, ...pasos,
    ...(pendientes.length ? ['Aprobaciones pendientes:', ...pendientes] : [])].join('\n');
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
      return { ok: true, texto: [`Modo: ${ab.modo} · orquesta: ${ab.quien}`, textoOrquestacion(ab.o), '', api.resumirTablero(t.datos?.tareas, l.datos?.lotes)].join('\n') };
    }
    if (a === 'rutas') {
      const r = await api.pedir('GET', '/api/orquestaciones/catalogo', undefined, opciones);
      if (r.status !== 200) return { ok: false, texto: r.datos?.error || `HTTP ${r.status}` };
      const filas = r.datos.rutas.filter((x) => x.permitido !== 'no').map((x) => `${x.metodo} ${x.ruta} · ${x.nucleo} · ${x.nivel}${x.permitido === 'sí' ? '' : ` · ${x.permitido}`}`);
      return { ok: true, texto: [`Modo ${r.datos.modo}. Rutas que podés usar con \`llamar\` (el cuerpo de los POST es JSON):`, ...filas].join('\n') };
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
    if (a === 'llamar') {
      const metodo = String(args.metodo || 'GET').toUpperCase();
      if (!METODOS.includes(metodo)) return { ok: false, texto: 'metodo es GET o POST.' };
      const r = await api.pedir(metodo, String(args.ruta || ''), metodo === 'POST' ? (args.cuerpo ?? {}) : undefined, opciones);
      if (r.status === 202) return { ok: true, texto: `Pendiente de aprobación (\`${r.datos.pendiente}\`): el usuario la decide en la consola, vista Orquestación. Podés esperarla con \`esperar\` (tipo aprobacion).` };
      const texto = json(r.datos);
      return { ok: r.status < 400, texto: `HTTP ${r.status}\n${texto.length > 12_000 ? `${texto.slice(0, 12_000)}\n… (recortado)` : texto}` };
    }
    // esperar
    const { o } = args.tipo === 'aprobacion' ? await abiertaDe(opciones) : { o: null };
    const r = await api.esperar({ tipo: args.tipo, id: String(args.id || ''), orquestacion: o?.id, estados: Array.isArray(args.estados) ? args.estados : [],
      topeMs: Math.max(1, Math.min(600, Number(args.segundos) || 120)) * 1000, ...opciones });
    return { ok: true, texto: `${r.llego ? 'Llegó' : 'Se cumplió el tope'}: estado ${r.estado ?? 'desconocido'}.\n${json(r.datos).slice(0, 4000)}` };
  } catch (err) {
    return { ok: false, texto: `consola: ${err?.message || err}` };
  }
}

module.exports = { ACCIONES, accion };
