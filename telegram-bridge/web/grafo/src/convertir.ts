/**
 * FEAT-148 — De la `tuberia` del servidor a nodos y cables de React Flow.
 * Pura: sin DOM ni estado, para poder probarla sola (pruebas/convertir.ts).
 */
import type { Edge, Node } from '@xyflow/react';
import type { Actor, Borrador, Bucle, EstadoEtapa, EtapaReceta, Nota, Tuberia } from './tipos';

export const ANCHO_NODO = 236;
export const SEPARACION = 120;

/** G2.5 — Una tarea dentro de un nodo: su estado en esa etapa y el veredicto, si hay. */
export interface Chip {
  id: string;
  /** Lo que se lee: el título de la tarea, o su id. */
  nombre?: string;
  estado: EstadoEtapa;
  veredicto: string | null;
  /** FEAT-149 F2 — «vuelta 2/3 · falló: juez». */
  vuelta?: string;
}

export interface DatosNodo extends Record<string, unknown> {
  tipo: EtapaReceta['tipo'] | 'entrada';
  titulo: string;
  estado: EstadoEtapa;
  /** Actores distintos que hicieron (o hacen) esta etapa, ya en texto. */
  actores: string[];
  chips: Chip[];
  /** «2/2 ok», «1/2 PASS · 1 en curso», … */
  conteo: string;
  detalle: string | null;
  seleccionado: boolean;
  /** FEAT-149 — Configuración del nodo con su procedencia. */
  notas?: Nota[];
}

export type EstadoCable = 'hecho' | 'corriendo' | 'pendiente' | 'falla' | 'omitida';

export const TEXTO_ESTADO: Record<EstadoEtapa, string> = {
  ok: 'ok', falla: 'falla', corriendo: 'en curso', esperando: 'esperando tu decisión', pendiente: 'pendiente', omitida: 'omitida'
};
/** G2.5 — Ícono por estado: el color nunca va solo. */
export const ICONO: Record<EstadoEtapa, string> = { ok: '✓', corriendo: '◐', pendiente: '◷', esperando: '◷', falla: '✕', omitida: '⊘' };

export function duracion(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function textoActor(a: Actor | undefined): string | null {
  if (!a) return null;
  const t = [a.motor, a.modelo].filter(Boolean).join(' · ');
  return t || null;
}

/** «2 ok · 1 en curso» a partir de los estados por tarea, en el orden en que importan. */
export function contar(estados: EstadoEtapa[]): string {
  if (!estados.length) return 'sin tareas';
  const orden: EstadoEtapa[] = ['corriendo', 'falla', 'esperando', 'ok', 'pendiente', 'omitida'];
  const corto: Record<EstadoEtapa, string> = { ...TEXTO_ESTADO, esperando: 'esperando' };
  const partes = orden
    .map((e) => [e, estados.filter((x) => x === e).length] as const)
    .filter(([, n]) => n > 0)
    .map(([e, n]) => `${n} ${corto[e]}`);
  return `${partes.join(' · ')} de ${estados.length}`;
}

/**
 * G2.5 — La forma del cable sale del estado de la etapa a la que llega: sólido si
 * ya pasó, raya-punto animado si algo pasa ahora, punteado si el flujo no llegó.
 */
export function estadoCable(destino: EstadoEtapa): EstadoCable {
  switch (destino) {
    case 'corriendo': return 'corriendo';
    case 'ok': case 'esperando': return 'hecho';
    case 'falla': return 'falla';
    case 'omitida': return 'omitida';
    default: return 'pendiente';
  }
}

/** La etiqueta del cable: cuántas tareas llegaron; al salir de Auditar, los veredictos. */
export function etiquetaCable(t: Tuberia, destino: string): string | null {
  const n = t.tareas.length;
  if (!n) return null;
  if (destino === 'escribir') return String(n);
  if (destino === 'revision') {
    const v = t.tareas.map((x) => x.etapas.auditar?.veredicto).filter((x): x is string => Boolean(x));
    if (!v.length) return null;
    const cuenta = new Map<string, number>();
    for (const x of v) cuenta.set(x, (cuenta.get(x) ?? 0) + 1);
    return [...cuenta].map(([k, c]) => `${c} ${k}`).join(' · ');
  }
  const llegaron = t.cruces?.[destino];
  return typeof llegaron === 'number' ? `${llegaron} de ${n}` : null;
}

function chipsDeEtapa(t: Tuberia, e: EtapaReceta): Chip[] {
  if (e.tipo === 'humano') {
    // A la revisión llegan las tareas que terminaron la auditoría, con el estado de la revisión.
    if (!['esperando', 'ok'].includes(t.revision.estado)) return [];
    return t.tareas
      .filter((x) => ['ok', 'falla'].includes(x.etapas.auditar?.estado ?? ''))
      .map((x) => ({ id: x.id, estado: t.revision.estado, veredicto: null }));
  }
  return t.tareas
    .filter((x) => x.etapas[e.id])
    .map((x) => ({ id: x.id, estado: x.etapas[e.id].estado, veredicto: x.etapas[e.id].veredicto ?? null }));
}

/**
 * FEAT-149 F2 — Los cables de vuelta (Verificar → Escribir, Auditar → Escribir), por debajo de
 * los nodos. Tres estilos: posible (nadie volvió), usado en el lote, usado por la tarea elegida.
 */
export function cablesDeVuelta(b: Bucle | null | undefined, tareaElegida: string | null = null): Edge[] {
  if (!b || !b.vueltas) return [];
  const lados: [string, 'prueba' | 'juez', boolean, string][] = [['verificar', 'prueba', b.siFalla, 'prueba roja'], ['auditar', 'juez', b.siFail, 'FAIL']];
  return lados.filter(([, , activo]) => activo).map(([origen, motivo, , texto]) => {
    const usados = b.usados?.[motivo] ?? [];
    const estilo = !usados.length ? 'posible' : (tareaElegida && usados.includes(tareaElegida) ? 'elegido' : 'usado');
    const label = `${texto} → reescribir · máx. ${b.vueltas}${usados.length ? ` · ${usados.length} volvi${usados.length === 1 ? 'ó' : 'eron'}` : ''}`;
    return {
      id: `vuelta-${origen}`, source: origen, sourceHandle: 'abajo', target: 'escribir', targetHandle: 'abajo',
      // Escalonado y a distinta profundidad: los dos cables de vuelta (y sus etiquetas) no se pisan.
      type: 'smoothstep', pathOptions: { offset: motivo === 'prueba' ? 34 : 74, borderRadius: 14 },
      animated: estilo === 'elegido', className: `cable-vuelta cable-vuelta-${estilo}`,
      label, labelBgPadding: [6, 2] as [number, number], labelBgBorderRadius: 999, data: { estado: estilo }
    };
  });
}

const textoVuelta = (x: Tuberia['tareas'][number]): string | undefined =>
  x.vueltasMax && (x.vuelta ?? 1) > 1 ? `vuelta ${x.vuelta}/${x.vueltasMax}${x.ultimoFallo ? ` · falló: ${x.ultimoFallo}` : ''}` : undefined;

export function aGrafo(t: Tuberia, seleccion: string | null = null, nombres: Record<string, string> = {}, notas: Record<string, Nota[]> = {}, tareaElegida: string | null = null): { nodes: Node<DatosNodo>[]; edges: Edge[] } {
  const vueltaPorId = new Map(t.tareas.map((x) => [x.id, textoVuelta(x)]));
  const paso = ANCHO_NODO + SEPARACION;
  const nodes: Node<DatosNodo>[] = [{
    id: 'entrada',
    type: 'etapa',
    position: { x: 0, y: 0 },
    data: {
      tipo: 'entrada', titulo: 'Entrada', estado: t.tareas.length ? 'ok' : 'pendiente', actores: [],
      chips: t.tareas.map((x) => ({ id: x.id, ...(nombres[x.id] ? { nombre: nombres[x.id] } : {}), estado: 'ok' as EstadoEtapa, veredicto: null })),
      conteo: `${t.tareas.length} tarea${t.tareas.length === 1 ? '' : 's'}`, detalle: null, seleccionado: seleccion === 'entrada'
    }
  }];
  t.receta.etapas.forEach((e, i) => {
    const esRevision = e.tipo === 'humano';
    const porTarea = esRevision ? [t.revision] : t.tareas.map((x) => x.etapas[e.id]).filter(Boolean);
    const actores = [...new Set(porTarea.map((x) => textoActor(x.actor)).filter((x): x is string => Boolean(x)))];
    const duraciones = porTarea.map((x) => x.duracionMs).filter((x): x is number => typeof x === 'number');
    const ms = e.id === 'escribir' ? t.escrituraMs : (duraciones.length ? Math.max(...duraciones) : null);
    const detalle = esRevision
      ? [t.revision.salida ? `→ ${t.revision.salida}` : null, t.revision.estado === 'esperando' ? null : t.revision.motivo].filter(Boolean).join(' · ') || null
      : (typeof ms === 'number' ? duracion(ms) : null);
    nodes.push({
      id: e.id,
      type: 'etapa',
      position: { x: (i + 1) * paso, y: 0 },
      data: {
        tipo: e.tipo, titulo: e.titulo, estado: t.resumen[e.id] ?? 'pendiente', actores, ...(notas[e.id]?.length ? { notas: notas[e.id] } : {}),
        chips: chipsDeEtapa(t, e).map((c) => ({ ...c, ...(nombres[c.id] ? { nombre: nombres[c.id] } : {}), ...(vueltaPorId.get(c.id) && e.id !== 'revision' ? { vuelta: vueltaPorId.get(c.id) } : {}) })),
        conteo: esRevision ? 'vos' : contar(porTarea.map((x) => x.estado)),
        detalle, seleccionado: seleccion === e.id
      }
    });
  });
  const edges: Edge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const origen = nodes[i - 1];
    const destino = nodes[i];
    const estado = estadoCable(destino.data.estado);
    const label = etiquetaCable(t, destino.id);
    edges.push({
      id: `${origen.id}->${destino.id}`,
      source: origen.id,
      target: destino.id,
      animated: false,
      className: `cable cable-${estado}`,
      ...(label ? { label, labelBgPadding: [6, 2] as [number, number], labelBgBorderRadius: 999 } : {}),
      data: { estado }
    });
  }
  edges.push(...cablesDeVuelta(t.bucle, tareaElegida));
  return { nodes, edges };
}

/**
 * G3 — El borrador de un lote: la receta del lote (fija hasta G4) con los actores
 * elegidos como texto. Nada corrió: los nodos esperan y los cables van punteados.
 */
const ETAPAS_LOTE: { id: string; tipo: EtapaReceta['tipo']; titulo: string }[] = [
  { id: 'escribir', tipo: 'escribir', titulo: 'Escribir' },
  { id: 'verificar', tipo: 'verificar', titulo: 'Verificar' },
  { id: 'auditar', tipo: 'auditar', titulo: 'Auditar' },
  { id: 'revision', tipo: 'humano', titulo: 'Revisión' }
];

export function borradorAGrafo(b: Borrador, seleccion: string | null = null, notas: Record<string, Nota[]> = {}): { nodes: Node<DatosNodo>[]; edges: Edge[] } {
  const paso = ANCHO_NODO + SEPARACION;
  const n = b.tareas.length;
  const chips = (estado: EstadoEtapa, veredicto: (id: string) => string | null = () => null): Chip[] => b.tareas.map((id) => ({ id, estado, veredicto: veredicto(id) }));
  const datos: Record<string, Pick<DatosNodo, 'actores' | 'chips' | 'conteo'>> = {
    escribir: { actores: [b.escribir], chips: chips('pendiente'), conteo: `${n} por escribir` },
    verificar: { actores: [], chips: chips('pendiente', (id) => (b.conPrueba.includes(id) ? 'prueba' : 'sin prueba')), conteo: `${b.conPrueba.length} de ${n} con prueba` },
    auditar: { actores: [b.auditar], chips: chips('pendiente'), conteo: `${n} por auditar` },
    revision: { actores: [], chips: [], conteo: 'vos' }
  };
  const nodes: Node<DatosNodo>[] = [{
    id: 'entrada', type: 'etapa', position: { x: 0, y: 0 },
    data: { tipo: 'entrada', titulo: 'Entrada', estado: n ? 'ok' : 'pendiente', actores: [], chips: chips('ok'), conteo: `${n} tarea${n === 1 ? '' : 's'}`, detalle: null, seleccionado: seleccion === 'entrada' }
  }];
  ETAPAS_LOTE.forEach((e, i) => nodes.push({
    id: e.id, type: 'etapa', position: { x: (i + 1) * paso, y: 0 },
    data: { tipo: e.tipo, titulo: e.titulo, estado: 'pendiente', ...datos[e.id], detalle: e.tipo === 'humano' ? 'integrar o descartar' : null, seleccionado: seleccion === e.id,
      ...(notas[e.id]?.length ? { notas: notas[e.id] } : {}) }
  }));
  const edges: Edge[] = nodes.slice(1).map((d, i) => ({
    id: `${nodes[i].id}->${d.id}`, source: nodes[i].id, target: d.id, animated: false,
    className: 'cable cable-pendiente', ...(i === 0 && n ? { label: String(n), labelBgPadding: [6, 2] as [number, number], labelBgBorderRadius: 999 } : {}), data: { estado: 'pendiente' }
  }));
  edges.push(...cablesDeVuelta(b.bucle));
  return { nodes, edges };
}
