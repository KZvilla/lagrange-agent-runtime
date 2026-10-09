/**
 * FEAT-148 — El nodo de una etapa, a lo ComfyUI: cabecera por tipo, puertos,
 * actores y barra de estado. Es DOM (no canvas): enfocable y legible por lectores.
 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { DatosNodo } from './convertir';

const ESTADO: Record<string, string> = { ok: 'ok', falla: 'falla', corriendo: 'en curso', pendiente: 'pendiente', omitida: 'omitida' };
const SUBTITULO: Record<string, string> = { entrada: 'lote', escribir: 'confinado', verificar: 'sin red', auditar: 'veredicto', humano: 'decisión' };

export function NodoEtapa({ data }: NodeProps<Node<DatosNodo>>) {
  const d = data;
  return (
    <div class={`gn gn-${d.tipo} gn-estado-${d.estado}`} aria-label={`${d.titulo}: ${ESTADO[d.estado] ?? d.estado}`}>
      {d.entradas.length > 0 && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <div class="gn-cabecera">
        <span class="gn-punto" aria-hidden="true" />
        <span class="gn-titulo">{d.titulo}</span>
        <span class="gn-sub">{SUBTITULO[d.tipo] ?? ''}</span>
      </div>
      <div class="gn-puertos">
        <span>{d.entradas.join(' · ')}</span>
        <span>{d.salidas.join(' · ')}</span>
      </div>
      {d.actores.length > 0 && (
        <ul class="gn-actores">
          {d.actores.map((a) => <li key={a}>{a}</li>)}
        </ul>
      )}
      {d.detalle && <div class="gn-detalle">{d.detalle}</div>}
      <div class="gn-barra">
        <span>{ESTADO[d.estado] ?? d.estado}</span>
        <span>{d.conteo}</span>
      </div>
      {d.salidas.length > 0 && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}
