/**
 * FEAT-148 — De la `tuberia` del servidor a nodos y cables de React Flow.
 * Pura: sin DOM ni estado, para poder probarla sola (test/convertir.test.ts).
 */
import type { Edge, Node } from '@xyflow/react';
import type { Actor, EstadoEtapa, EtapaReceta, Tuberia } from './tipos';

export const ANCHO_NODO = 250;
export const SEPARACION = 70;

export interface DatosNodo extends Record<string, unknown> {
  tipo: EtapaReceta['tipo'] | 'entrada';
  titulo: string;
  estado: EstadoEtapa;
  /** Actores distintos que hicieron (o hacen) esta etapa, ya en texto. */
  actores: string[];
  /** «2/2 ok», «1/2 PASS · 1 en curso», … */
  conteo: string;
  detalle: string | null;
  entradas: string[];
  salidas: string[];
}

export type EstadoCable = 'hecho' | 'corriendo' | 'pendiente';

const TEXTO: Record<EstadoEtapa, string> = { ok: 'ok', falla: 'falla', corriendo: 'en curso', pendiente: 'pendiente', omitida: 'omitida' };

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
  const orden: EstadoEtapa[] = ['corriendo', 'falla', 'ok', 'pendiente', 'omitida'];
  const partes = orden
    .map((e) => [e, estados.filter((x) => x === e).length] as const)
    .filter(([, n]) => n > 0)
    .map(([e, n]) => `${n} ${TEXTO[e]}`);
  return `${partes.join(' · ')} de ${estados.length}`;
}

/** El color de un cable sale del estado de la etapa a la que llega. */
export function estadoCable(destino: EstadoEtapa): EstadoCable {
  if (destino === 'corriendo') return 'corriendo';
  if (destino === 'ok' || destino === 'falla') return 'hecho';
  return 'pendiente';
}

const ENTRADAS: Record<string, string[]> = { escribir: ['tareas'], verificar: ['commit'], auditar: ['commit + prueba'], humano: ['auditadas'] };
const SALIDAS: Record<string, string[]> = { escribir: ['commit'], verificar: ['resultado'], auditar: ['veredicto'] };

export function aGrafo(t: Tuberia): { nodes: Node<DatosNodo>[]; edges: Edge[] } {
  const paso = ANCHO_NODO + SEPARACION;
  const nodes: Node<DatosNodo>[] = [{
    id: 'entrada',
    type: 'etapa',
    position: { x: 0, y: 0 },
    data: {
      tipo: 'entrada', titulo: 'Entrada', estado: t.tareas.length ? 'ok' : 'pendiente', actores: [],
      conteo: `${t.tareas.length} tarea${t.tareas.length === 1 ? '' : 's'}`,
      detalle: t.tareas.map((x) => x.id).join(' · ') || null, entradas: [], salidas: ['tareas']
    }
  }];
  t.receta.etapas.forEach((e, i) => {
    const esRevision = e.tipo === 'humano';
    const porTarea = esRevision ? [t.revision] : t.tareas.map((x) => x.etapas[e.id]).filter(Boolean);
    const actores = [...new Set(porTarea.map((x) => textoActor(x.actor)).filter((x): x is string => Boolean(x)))];
    const duraciones = porTarea.map((x) => x.duracionMs).filter((x): x is number => typeof x === 'number');
    const ms = e.id === 'escribir' ? t.escrituraMs : (duraciones.length ? Math.max(...duraciones) : null);
    const veredictos = porTarea.map((x) => x.veredicto).filter(Boolean);
    const detalle = esRevision
      ? [t.revision.salida ? `→ ${t.revision.salida}` : null, t.revision.motivo].filter(Boolean).join(' · ') || null
      : [veredictos.length ? veredictos.join(' / ') : null, typeof ms === 'number' ? duracion(ms) : null].filter(Boolean).join(' · ') || null;
    nodes.push({
      id: e.id,
      type: 'etapa',
      position: { x: (i + 1) * paso, y: 0 },
      data: {
        tipo: e.tipo, titulo: e.titulo, estado: t.resumen[e.id] ?? 'pendiente', actores,
        conteo: esRevision ? 'vos' : contar(porTarea.map((x) => x.estado)),
        detalle, entradas: ENTRADAS[e.tipo] ?? [], salidas: esRevision ? (e.salidas ?? []) : (SALIDAS[e.tipo] ?? [])
      }
    });
  });
  const edges: Edge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const origen = nodes[i - 1];
    const destino = nodes[i];
    const estado = estadoCable(destino.data.estado);
    edges.push({
      id: `${origen.id}->${destino.id}`,
      source: origen.id,
      target: destino.id,
      animated: estado === 'corriendo',
      className: `cable cable-${estado}`,
      data: { estado }
    });
  }
  return { nodes, edges };
}
