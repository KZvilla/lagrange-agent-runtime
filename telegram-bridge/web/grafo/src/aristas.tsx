/**
 * Las aristas del grafo con la etiqueta en HTML (EdgeLabelRenderer), no en SVG: el fondo de una
 * etiqueta SVG se mide una sola vez al pintar y, si la fuente mono llega después, el texto se sale
 * del borde. En HTML la caja se ajusta sola al texto.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

type Opciones = { offset?: number; borderRadius?: number };

function Etiqueta({ texto, x, y }: { texto: unknown; x: number; y: number }) {
  if (texto == null || texto === '') return null;
  return (
    <EdgeLabelRenderer>
      <div class="gn-arista-etiqueta" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>{String(texto)}</div>
    </EdgeLabelRenderer>
  );
}

/** Las de avance (curva). */
export function AristaCurva(p: EdgeProps) {
  const [path, x, y] = getBezierPath(p);
  return <><BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={p.style} interactionWidth={p.interactionWidth} /><Etiqueta texto={p.label} x={x} y={y} /></>;
}

/** Las de vuelta (escalonadas, con su profundidad en `pathOptions`). */
export function AristaEscalon(p: EdgeProps & { pathOptions?: Opciones }) {
  const [path, x, y] = getSmoothStepPath({ ...p, offset: p.pathOptions?.offset, borderRadius: p.pathOptions?.borderRadius });
  return <><BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={p.style} interactionWidth={p.interactionWidth} /><Etiqueta texto={p.label} x={x} y={y} /></>;
}

export const TIPOS_ARISTA = { default: AristaCurva, smoothstep: AristaEscalon };
