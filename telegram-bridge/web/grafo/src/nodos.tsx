/**
 * FEAT-148 — El nodo de una etapa, a lo ComfyUI: cabecera por tipo, actor, una
 * ficha por tarea y barra de estado. Es DOM (no canvas): enfocable y legible por lectores.
 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ICONO, TEXTO_ESTADO, type DatosNodo } from './convertir';
import type { DatosPuertos } from './libre';

const ORIGEN: Record<string, string> = { receta: 'receta', repo: 'repo', tarea: 'tarea', lote: 'solo este lote' };

const SUBTITULO: Record<string, string> = { entrada: 'lote', escribir: 'confinado', verificar: 'sin red', auditar: 'veredicto', humano: 'vos' };
const MARCA: Record<string, string> = { error: '✕', aviso: '⚠', info: 'i' };
const TEXTO_MARCA: Record<string, string> = { error: 'tiene un error', aviso: 'tiene un aviso', info: 'tiene una nota' };

export function Icono({ estado }: { estado: DatosNodo['estado'] }) {
  return <span class={`gn-icono gn-icono-${estado}`} aria-hidden="true">{ICONO[estado]}</span>;
}

export function NodoEtapa({ data }: NodeProps<Node<DatosNodo>>) {
  const d = data;
  const estado = TEXTO_ESTADO[d.estado] ?? d.estado;
  // FEAT-150 — En vertical el flujo entra por arriba y sale por abajo; los cables de vuelta, por la derecha.
  const entra = d.vertical ? Position.Top : Position.Left;
  const sale = d.vertical ? Position.Bottom : Position.Right;
  const vuelta = d.vertical ? Position.Right : Position.Bottom;
  const etiqueta = d.editor ? `${d.titulo}${d.problema ? `: ${TEXTO_MARCA[d.problema]}` : ''}` : `${d.titulo}: ${estado}`;
  return (
    <div class={`gn gn-${d.tipo} ${d.editor ? 'gn-ed' : `gn-estado-${d.estado}`}${d.seleccionado ? ' gn-sel' : ''}`} aria-label={etiqueta}>
      {d.tipo !== 'entrada' && <Handle type="target" position={entra} isConnectable={false} />}
      <div class="gn-cabecera">
        <span class="gn-punto" aria-hidden="true" />
        <span class="gn-titulo">{d.titulo}</span>
        <span class="gn-sub">{SUBTITULO[d.tipo] ?? ''}</span>
        {d.problema && <span class={`gn-marca gn-marca-${d.problema}`} title={TEXTO_MARCA[d.problema]} aria-hidden="true">{MARCA[d.problema]}</span>}
        {d.editor && <span class="gn-agarre" aria-hidden="true">⠿</span>}
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
                <Icono estado={c.estado} /><span class="gn-chip-id">{c.nombre ?? c.id}</span>{c.veredicto && <b>{c.veredicto}</b>}{c.vuelta && <small class="gn-chip-vuelta">{c.vuelta}</small>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="gn-barra">
        {!d.editor && <Icono estado={d.estado} />}
        <span>{d.tipo === 'humano' ? estado : d.conteo}</span>
        {d.detalle && <span class="gn-barra-der">{d.detalle}</span>}
      </div>
      {d.tipo !== 'humano' && <Handle type="source" position={sale} isConnectable={false} />}
      {/* FEAT-149 F2 — Puertos de los cables de vuelta; en el editor (F3) se conectan a mano. */}
      {(d.tipo === 'verificar' || d.tipo === 'auditar') && <Handle type="source" id="abajo" position={vuelta} isConnectable={!!d.editor} class={d.editor ? 'gn-puerto-vuelta' : undefined} />}
      {d.tipo === 'escribir' && <Handle type="target" id="abajo" position={vuelta} isConnectable={!!d.editor} class={d.editor ? 'gn-puerto-vuelta' : undefined} />}
    </div>
  );
}

const SUB_LIBRE: Record<string, string> = { entrada: 'lote', escribir: 'confinado', verificar: 'sin red', juez: 'compuerta', advisor: 'revisa y devuelve', humano: 'espera tu respuesta', revision: 'vos',
  semaforo: 'reparte en ramas', juntar: 'espera y mergea' };

/**
 * FEAT-149 F4a — Un nodo de una receta de grafo: entra por un puerto (`entra`) y sale por uno
 * por resultado, cada uno con su nombre. Los de falla se distinguen por forma y texto, no solo
 * por color. En el visor de un lote lleva su estado (ícono + texto).
 */
export function NodoPuertos({ data }: NodeProps<Node<DatosPuertos>>) {
  const d = data;
  const entra = d.vertical ? Position.Top : Position.Left;
  const sale = d.vertical ? Position.Bottom : Position.Right;
  const etiqueta = `${d.titulo}${d.textoEstado ? `: ${d.textoEstado}` : ''}${d.problema ? `: ${TEXTO_MARCA[d.problema]}` : ''}`;
  // F4b — El nodo Humano (a mitad de camino) se pinta distinto de Vos (la revisión final).
  const tipoClase = d.tipo === 'juez' ? 'auditar' : (d.tipo === 'revision' ? 'humano' : (d.tipo === 'humano' ? 'consulta' : d.tipo));
  return (
    <div class={`gn gn-libre gn-${tipoClase}${d.estado ? ` gn-estado-${d.estado}` : ' gn-ed'}${d.seleccionado ? ' gn-sel' : ''}${d.atenuado ? ' gn-atenuado' : ''}`} aria-label={etiqueta}>
      {d.tipo !== 'entrada' && <Handle type="target" id="entra" position={entra} isConnectable={d.editor} class="gn-puerto-entra" />}
      <div class="gn-cabecera">
        <span class="gn-punto" aria-hidden="true" />
        <span class="gn-titulo">{d.titulo}</span>
        <span class="gn-sub">{SUB_LIBRE[d.tipo] ?? ''}</span>
        {d.problema && <span class={`gn-marca gn-marca-${d.problema}`} title={TEXTO_MARCA[d.problema]} aria-hidden="true">{MARCA[d.problema]}</span>}
        {d.editor && <span class="gn-agarre" aria-hidden="true">⠿</span>}
      </div>
      <div class="gn-cuerpo">
        {d.notas.map((n) => <div key={n.texto} class="gn-nota" title={n.texto}><span class="gn-nota-texto">{n.texto}</span></div>)}
        {d.puertos.length > 0 && (
          <ul class={`gn-puertos${d.vertical ? ' gn-puertos-fila' : ''}`} aria-label="Salidas">
            {d.puertos.map((p) => (
              <li key={p.id} class={`gn-puerto${p.falla ? ' gn-puerto-falla' : ''}`}>
                <span class="gn-puerto-texto">{p.falla ? '↯ ' : ''}{p.texto}</span>
                <Handle type="source" id={p.id} position={sale} isConnectable={d.editor} class="gn-puerto-sale" />
              </li>
            ))}
          </ul>
        )}
      </div>
      {d.textoEstado && <div class="gn-barra"><span>{d.textoEstado}</span></div>}
    </div>
  );
}
