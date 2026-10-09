/**
 * FEAT-148 — El nodo de una etapa, a lo ComfyUI: cabecera por tipo, actor, una
 * ficha por tarea y barra de estado. Es DOM (no canvas): enfocable y legible por lectores.
 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ICONO, TEXTO_ESTADO, type DatosNodo } from './convertir';

const ORIGEN: Record<string, string> = { receta: 'receta', repo: 'repo', tarea: 'tarea', lote: 'solo este lote' };

const SUBTITULO: Record<string, string> = { entrada: 'lote', escribir: 'confinado', verificar: 'sin red', auditar: 'veredicto', humano: 'vos' };

export function Icono({ estado }: { estado: DatosNodo['estado'] }) {
  return <span class={`gn-icono gn-icono-${estado}`} aria-hidden="true">{ICONO[estado]}</span>;
}

export function NodoEtapa({ data }: NodeProps<Node<DatosNodo>>) {
  const d = data;
  const estado = TEXTO_ESTADO[d.estado] ?? d.estado;
  return (
    <div class={`gn gn-${d.tipo} gn-estado-${d.estado}${d.seleccionado ? ' gn-sel' : ''}`} aria-label={`${d.titulo}: ${estado}`}>
      {d.tipo !== 'entrada' && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <div class="gn-cabecera">
        <span class="gn-punto" aria-hidden="true" />
        <span class="gn-titulo">{d.titulo}</span>
        <span class="gn-sub">{SUBTITULO[d.tipo] ?? ''}</span>
      </div>
      <div class="gn-cuerpo">
        {d.actores.map((a) => <div key={a} class="gn-actor" title={a}>{a}</div>)}
        {(d.notas ?? []).map((n) => (
          <div key={n.texto} class="gn-nota" title={n.origen ? `${n.texto} · de ${ORIGEN[n.origen]}` : n.texto}>
            <span class="gn-nota-texto">{n.texto}</span>{n.origen && <span class={`gn-origen gn-origen-${n.origen}`}>{ORIGEN[n.origen]}</span>}
          </div>
        ))}
        {d.chips.length > 0 && (
          <ul class="gn-chips">
            {d.chips.map((c) => (
              <li key={c.id} class={`gn-chip gn-estado-${c.estado}`} title={`${c.nombre ?? c.id}: ${TEXTO_ESTADO[c.estado]}${c.veredicto ? ` · ${c.veredicto}` : ''}`}>
                <Icono estado={c.estado} /><span class="gn-chip-id">{c.nombre ?? c.id}</span>{c.veredicto && <b>{c.veredicto}</b>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="gn-barra">
        <Icono estado={d.estado} />
        <span>{d.tipo === 'humano' ? estado : d.conteo}</span>
        {d.detalle && <span class="gn-barra-der">{d.detalle}</span>}
      </div>
      {d.tipo !== 'humano' && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}
