/**
 * FEAT-162 F2 — De una orquestación (el `resumen` de telegram-bridge/orquestaciones.js) a
 * nodos y aristas de React Flow. Pura: la isla la pinta, la prueba la ejercita.
 *
 * Tres filas: arriba el orquestador y los pasos en orden; debajo de cada paso, apilados,
 * sus tarjetas, lotes y la aprobación pendiente; abajo, un nodo por subagente (el agente o
 * el alma de cada tarjeta, el modelo de cada lote), centrado bajo lo suyo y sin encimarse.
 */
import type { Edge, Node } from '@xyflow/react';

export type EstadoPaso = 'pendiente' | 'en_curso' | 'hecho' | 'fallo';
export interface Enlace { tipo: 'tarjeta' | 'lote'; id: string }
export interface Paso { id: string; texto: string; estado: EstadoPaso; enlaces: Enlace[] }
export interface Aprobacion { id: string; metodo: string; ruta: string; estado: string; vence?: string; local?: boolean; resumen?: string }
export interface Orquestacion {
  id: string; quien: string; titulo: string; modo: string; estado: 'activa' | 'frenada' | 'terminada';
  pasos: Paso[]; aprobaciones: Aprobacion[]; acciones?: unknown[];
}
export type Sujeto = { tipo: 'alma'; clave: string; voz?: string } | { tipo: 'agente'; nombre: string } | { tipo: string; [k: string]: unknown } | null;
export interface InfoTarjeta { titulo: string | null; estado: string; sujeto: Sujeto; noExiste?: boolean }
export interface InfoLote { titulo: string | null; estado: string; modelo: string | null; noExiste?: boolean }
export interface DatosOrquestacion {
  orquestacion: Orquestacion;
  tarjetas: Record<string, InfoTarjeta>;
  lotes: Record<string, InfoLote>;
}

export type TipoNodo = 'quien' | 'paso' | 'hijo' | 'aprob' | 'sub';
export interface DatosNodoOrq {
  [k: string]: unknown;
  tipo: TipoNodo;
  titulo: string;
  sub?: string;
  estado: string;
  /** hijo: a dónde lleva el clic. */
  enlace?: Enlace;
  /** aprob: la aprobación. */
  aprobacion?: Aprobacion;
  /** sub: cuántas cosas tiene y si alguna corre. */
  cuenta?: number;
  corriendo?: boolean;
}

export const COLUMNA = 215;
export const X0 = 80;
export const Y_PASOS = 120;
export const Y_HIJOS = 300;
export const PASO_HIJO = 80;
/** Una aprobación es más alta (botones): la pila usa la altura de cada tipo, no un paso fijo. */
export const PASO_APROB = 112;
export const SEPARACION_SUB = 190;

const CORRE = new Set(['en_curso', 'en_cola', 'corriendo', 'preparando', 'escribiendo', 'verificando', 'auditando']);
const TERMINA = new Set(['ok', 'hecho', 'integrado', 'para revisar']);

/** La clave de un sujeto (la misma regla que `claveDeSujeto` de la consola), o null sin sujeto. */
export function claveDeSujeto(s: Sujeto): string | null {
  if (!s || typeof s !== 'object') return null;
  if (s.tipo === 'alma' && typeof (s as { clave?: unknown }).clave === 'string') return `alma:${(s as { clave: string }).clave}`;
  if (s.tipo === 'agente' && typeof (s as { nombre?: unknown }).nombre === 'string') return `agente:${(s as { nombre: string }).nombre}`;
  return null;
}

const nombreDeSujeto = (s: Sujeto): string => (s && s.tipo === 'alma' ? String((s as { voz?: string; clave: string }).voz || (s as { clave: string }).clave) : String((s as { nombre?: string })?.nombre ?? '?'));

/** El estado de un hijo, para pintar y para la arista que llega. */
export function estadoDeHijo(e: Enlace, d: DatosOrquestacion): string {
  const info = e.tipo === 'tarjeta' ? d.tarjetas[e.id] : d.lotes[e.id];
  if (!info) return 'cargando';
  if (info.noExiste) return 'no_existe';
  return info.estado;
}

export function orquestacionAGrafo(d: DatosOrquestacion): { nodes: Node<DatosNodoOrq>[]; edges: Edge[] } {
  const o = d.orquestacion;
  const nodes: Node<DatosNodoOrq>[] = [];
  const edges: Edge[] = [];
  const activa = o.estado === 'activa';
  nodes.push({ id: 'quien', type: 'orq', position: { x: X0, y: Y_PASOS }, data: { tipo: 'quien', titulo: o.quien, sub: 'orquesta', estado: activa ? 'en_curso' : o.estado } });

  const pendientes = o.aprobaciones.filter((a) => a.estado === 'pendiente');
  // Una aprobación pendiente va bajo el paso en curso (o el primero sin hacer).
  const conAprob = o.pasos.find((p) => p.estado === 'en_curso') ?? o.pasos.find((p) => p.estado === 'pendiente') ?? o.pasos.at(-1);
  const subs = new Map<string, { titulo: string; sub: string; xs: number[]; encargos: Set<string>; corriendo: boolean; hijos: string[] }>();
  /** BE-131 — La misma tarjeta en dos pasos (crear → partir) es un nodo por paso, con id propio. */
  const usados = new Set<string>();

  let altoMax = 0;
  /** Las aprobaciones pendientes bajo una columna, apiladas desde `y`; devuelve la y siguiente. */
  const ponerAprobaciones = (x: number, desde: string, y0: number, previo: string | null): number => {
    let y = y0;
    let anterior = previo;
    for (const a of pendientes) {
      const idA = `aprob:${a.id}`;
      nodes.push({ id: idA, type: 'orq', position: { x, y }, data: { tipo: 'aprob', titulo: a.resumen ? `${a.metodo} — ${a.resumen.slice(0, 80)}` : a.metodo, sub: a.local ? 'Herramienta · espera tu aprobación' : 'Espera tu aprobación', estado: 'pendiente', aprobacion: a } });
      edges.push({ id: `e:${anterior ?? desde}>${idA}`, source: anterior ?? desde, sourceHandle: 'abajo', target: idA, type: 'smoothstep', animated: true, className: 'go-arista go-arista-en_curso' });
      anterior = idA;
      y += PASO_APROB;
    }
    return y;
  };
  // Sin pasos, las aprobaciones cuelgan del orquestador (si no, no se verían).
  if (!o.pasos.length && pendientes.length) altoMax = ponerAprobaciones(X0, 'quien', Y_HIJOS, null) - Y_HIJOS;

  o.pasos.forEach((p, i) => {
    const x = X0 + COLUMNA * (i + 1);
    const idPaso = `paso:${p.id}`;
    nodes.push({ id: idPaso, type: 'orq', position: { x, y: Y_PASOS }, data: { tipo: 'paso', titulo: p.texto, sub: `Paso ${i + 1}`, estado: p.estado } });
    const previo = i === 0 ? 'quien' : `paso:${o.pasos[i - 1].id}`;
    edges.push({ id: `e:${previo}>${idPaso}`, source: previo, target: idPaso, type: 'smoothstep', animated: p.estado === 'en_curso', className: `go-arista go-arista-${p.estado}` });

    let k = 0;
    let y = Y_HIJOS;
    let anterior: string | null = null;
    for (const e of p.enlaces) {
      const base = `${e.tipo}:${e.id}`;
      let idHijo = usados.has(base) ? `${base}@${p.id}` : base;
      // Repetida en el mismo paso (el servidor no lo deja, pero la función es pura): un contador.
      for (let n = 2; usados.has(idHijo); n++) idHijo = `${base}@${p.id}#${n}`;
      usados.add(idHijo);
      const estado = estadoDeHijo(e, d);
      const info = e.tipo === 'tarjeta' ? d.tarjetas[e.id] : d.lotes[e.id];
      const titulo = info?.noExiste ? 'ya no existe' : (info?.titulo || e.id);
      nodes.push({ id: idHijo, type: 'orq', position: { x, y }, data: { tipo: 'hijo', titulo, sub: `${e.tipo === 'tarjeta' ? 'Tarjeta' : 'Lote'} · ${e.id}`, estado, enlace: e } });
      edges.push({ id: `e:${anterior ?? idPaso}>${idHijo}`, source: anterior ?? idPaso, sourceHandle: 'abajo', target: idHijo, type: 'smoothstep', animated: CORRE.has(estado), className: `go-arista go-arista-${TERMINA.has(estado) ? 'hecho' : CORRE.has(estado) ? 'en_curso' : 'pendiente'}` });
      // El subagente: el agente o el alma de la tarjeta; el modelo del lote.
      let clave: string | null = null;
      let tituloSub = '';
      let subSub = '';
      if (e.tipo === 'tarjeta' && info && !info.noExiste) {
        const s = (info as InfoTarjeta).sujeto;
        clave = claveDeSujeto(s);
        tituloSub = clave ? nombreDeSujeto(s) : '';
        subSub = s?.tipo === 'alma' ? 'alma' : 'agente';
      } else if (e.tipo === 'lote' && info && !info.noExiste) {
        const modelo = (info as InfoLote).modelo;
        clave = modelo ? `lote:${modelo}` : null;
        tituloSub = modelo || '';
        subSub = 'lote';
      }
      if (clave) {
        const s = subs.get(clave) ?? { titulo: tituloSub, sub: subSub, xs: [], encargos: new Set<string>(), corriendo: false, hijos: [] };
        s.xs.push(x);
        s.encargos.add(base);
        s.corriendo ||= CORRE.has(estado);
        s.hijos.push(idHijo);
        subs.set(clave, s);
      }
      anterior = idHijo;
      y += PASO_HIJO;
      k += 1;
    }
    if (p === conAprob) y = ponerAprobaciones(x, idPaso, y, anterior);
    altoMax = Math.max(altoMax, y - Y_HIJOS);
  });

  // Los subagentes: centrados bajo lo suyo, separados de izquierda a derecha.
  const ySub = Y_HIJOS + Math.max(altoMax, PASO_HIJO) + 90;
  const ordenados = [...subs.entries()].map(([clave, s]) => ({ clave, ...s, x: s.xs.reduce((a, b) => a + b, 0) / s.xs.length }))
    .sort((a, b) => a.x - b.x || a.clave.localeCompare(b.clave));
  let ultimaX = -Infinity;
  for (const s of ordenados) {
    const x = Math.max(s.x, ultimaX + SEPARACION_SUB);
    ultimaX = x;
    const id = `sub:${s.clave}`;
    nodes.push({ id, type: 'orq', position: { x, y: ySub }, data: { tipo: 'sub', titulo: s.titulo, sub: s.sub, estado: s.corriendo ? 'en_curso' : 'pendiente', cuenta: s.encargos.size, corriendo: s.corriendo } });
    // Por el costado derecho del hijo: bajando por el medio atravesaría a los de abajo.
    for (const h of s.hijos) edges.push({ id: `e:${h}>${id}`, source: h, sourceHandle: 'lado', target: id, type: 'smoothstep', animated: s.corriendo, className: `go-arista go-arista-${s.corriendo ? 'en_curso' : 'pendiente'} go-arista-sub` });
  }
  return { nodes, edges };
}

/**
 * Cuándo festejar: `'corto'` si un paso pasó a hecho, `'grande'` si la orquestación terminó con
 * todos sus pasos hechos, `null` si no. Nunca en el primer render (`previo` null) ni con reduced-motion.
 */
export function debeFestejar(previo: Orquestacion | null, actual: Orquestacion, reducido: boolean): 'corto' | 'grande' | null {
  if (reducido || !previo || previo.id !== actual.id) return null;
  const todos = actual.pasos.length > 0 && actual.pasos.every((p) => p.estado === 'hecho');
  if (actual.estado === 'terminada' && previo.estado !== 'terminada' && todos) return 'grande';
  const antes = new Map(previo.pasos.map((p) => [p.id, p.estado]));
  return actual.pasos.some((p) => p.estado === 'hecho' && antes.has(p.id) && antes.get(p.id) !== 'hecho') ? 'corto' : null;
}
