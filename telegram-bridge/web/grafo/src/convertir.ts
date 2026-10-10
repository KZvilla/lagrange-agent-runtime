/**
 * FEAT-148 — De la `tuberia` del servidor a nodos y cables de React Flow.
 * Pura: sin DOM ni estado, para poder probarla sola (pruebas/convertir.ts).
 */
import type { Edge, Node } from '@xyflow/react';
import type { Actor, Borrador, Bucle, Disposicion, EstadoEtapa, EtapaReceta, Nota, RecetaEditor, Severidad, Tuberia } from './tipos';

export const ANCHO_NODO = 236;
export const SEPARACION = 120;
/** FEAT-150 — El paso entre nodos en el acomodo vertical (lienzo angosto). */
export const PASO_VERTICAL = 240;

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
  /** FEAT-150 — Acomodo vertical: los puertos van arriba y abajo, los de vuelta a la derecha. */
  vertical?: boolean;
  /** F3 — En el editor: sin estados de ejecución, con la marca del peor problema. */
  editor?: boolean;
  problema?: Severidad;
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
export function cablesDeVuelta(b: Bucle | null | undefined, tareaElegida: string | null = null, editor = false): Edge[] {
  // En el editor se dibuja también el bucle sin vueltas: es el error que hay que ver («sin tope»).
  if (!b || (!b.vueltas && !editor)) return [];
  const lados: [string, 'prueba' | 'juez', boolean, string][] = [['verificar', 'prueba', b.siFalla, 'prueba roja'], ['auditar', 'juez', b.siFail, 'FAIL']];
  return lados.filter(([, , activo]) => activo).map(([origen, motivo, , texto]) => {
    const usados = b.usados?.[motivo] ?? [];
    const estilo = !usados.length ? 'posible' : (tareaElegida && usados.includes(tareaElegida) ? 'elegido' : 'usado');
    const label = `${texto} → reescribir · ${b.vueltas ? `máx. ${b.vueltas}` : 'sin tope'}${usados.length ? ` · ${usados.length} volvi${usados.length === 1 ? 'ó' : 'eron'}` : ''}`;
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

/**
 * FEAT-150 — El acomodo: horizontal (el de siempre) o vertical para el lienzo angosto. Una
 * posición de `disposicion` (de la receta o del dispositivo) gana sobre la automática de ese nodo.
 */
export function acomodar<T extends Record<string, unknown>>(nodes: Node<T>[], disposicion: Disposicion | null | undefined, vertical = false): Node<T>[] {
  return nodes.map((n, i) => {
    const d = disposicion?.[n.id];
    const auto = vertical ? { x: 0, y: i * PASO_VERTICAL } : { x: i * (ANCHO_NODO + SEPARACION), y: 0 };
    const position = Array.isArray(d) && d.length === 2 && d.every((v) => Number.isFinite(v)) ? { x: d[0], y: d[1] } : auto;
    return { ...n, position, data: { ...n.data, vertical } };
  });
}

/** FEAT-150 — Las posiciones de los nodos, redondeadas, para guardarlas. */
export function disposicionDe(nodes: Pick<Node, 'id' | 'position'>[]): Disposicion {
  return Object.fromEntries(nodes.map((n) => [n.id, [Math.round(n.position.x), Math.round(n.position.y)] as [number, number]]));
}

/** F3 — Solo dos cables se pueden dibujar a mano: de Verificar o del juez, por abajo, a Escribir. */
export function conexionValida(c: { source: string | null; target: string | null; sourceHandle?: string | null; targetHandle?: string | null }): boolean {
  return c.target === 'escribir' && c.targetHandle === 'abajo' && (c.source === 'verificar' || c.source === 'auditar') && c.sourceHandle === 'abajo';
}

const PESO: Record<Severidad, number> = { error: 3, aviso: 2, info: 1 };
/** F3 — El peor problema por elemento, de la lista del servidor. */
export function peoresProblemas(lista: { severidad: Severidad; ir?: { nodo?: string; cable?: string } | null }[]): Record<string, Severidad> {
  const salida: Record<string, Severidad> = {};
  for (const p of lista) {
    const id = p.ir?.nodo ?? p.ir?.cable;
    if (!id || !PESO[p.severidad]) continue;
    if (!salida[id] || PESO[p.severidad] > PESO[salida[id]]) salida[id] = p.severidad;
  }
  return salida;
}

/**
 * F3 — La receta en el editor: los cinco nodos sin tareas, con su configuración (notas), y los
 * cables de vuelta que pide (también el que no tiene tope). Sin estados de ejecución.
 */
export function recetaAGrafo(r: RecetaEditor, seleccion: string | null = null, notas: Record<string, Nota[]> = {}, problemas: Record<string, Severidad> = {}): { nodes: Node<DatosNodo>[]; edges: Edge[] } {
  const filas: { id: string; tipo: DatosNodo['tipo']; titulo: string; actores: string[]; conteo: string }[] = [
    { id: 'entrada', tipo: 'entrada', titulo: 'Entrada', actores: [], conteo: 'tablero o lista de tareas' },
    { id: 'escribir', tipo: 'escribir', titulo: 'Escribir', actores: [r.escribir], conteo: 'agente · confinado' },
    { id: 'verificar', tipo: 'verificar', titulo: 'Verificar', actores: [], conteo: 'corta en el primero que falla' },
    { id: 'auditar', tipo: 'auditar', titulo: 'Juez', actores: [r.auditar], conteo: 'PASS / FAIL' },
    { id: 'revision', tipo: 'humano', titulo: 'Vos', actores: [], conteo: 'integrar o descartar' }
  ];
  const nodes: Node<DatosNodo>[] = filas.map((f, i) => ({
    id: f.id, type: 'etapa', position: { x: i * (ANCHO_NODO + SEPARACION), y: 0 }, deletable: false, dragHandle: '.gn-cabecera',
    data: { tipo: f.tipo, titulo: f.titulo, estado: 'pendiente', actores: f.actores, chips: [], conteo: f.conteo, detalle: null, seleccionado: seleccion === f.id,
      editor: true, ...(problemas[f.id] ? { problema: problemas[f.id] } : {}), ...(notas[f.id]?.length ? { notas: notas[f.id] } : {}) }
  }));
  const edges: Edge[] = nodes.slice(1).map((d, i) => ({
    id: `${nodes[i].id}->${d.id}`, source: nodes[i].id, target: d.id, animated: false, deletable: false, selectable: false, className: 'cable cable-receta', data: { estado: 'receta' }
  }));
  for (const e of cablesDeVuelta(r.bucle, null, true)) {
    edges.push({ ...e, selected: seleccion === e.id, deletable: true, selectable: true,
      className: `${e.className}${seleccion === e.id ? ' cable-sel' : ''}${problemas[e.id] ? ` cable-problema-${problemas[e.id]}` : ''}` });
  }
  return { nodes, edges };
}
