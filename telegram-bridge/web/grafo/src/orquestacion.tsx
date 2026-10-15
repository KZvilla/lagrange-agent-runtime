/**
 * FEAT-162 F2 — La orquestación como grafo vivo: el orquestador, sus pasos, lo que tocó cada
 * paso (tarjetas, lotes, la aprobación pendiente) y los subagentes que trabajan para él.
 *
 * Contrato con la consola (`ui/vista-orquestacion.js`), igual que `montar`:
 *   const isla = montarOrquestacion(elemento, props);  isla.actualizar(props);  isla.desmontar();
 * La isla no hace fetch: pinta lo que le pasan y avisa con `alAprobar`, `alRechazar` y `alAbrir`.
 */
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { debeFestejar, orquestacionAGrafo, type DatosNodoOrq, type DatosOrquestacion, type Enlace, type Orquestacion } from './orquestacion-convertir';
import { crearFestejo } from './festejo';

export interface PropsOrquestacion extends DatosOrquestacion {
  alAprobar?: (aprobacion: string) => void;
  alRechazar?: (aprobacion: string) => void;
  alAbrir?: (enlace: Enlace) => void;
}

const TEXTO_ESTADO: Record<string, string> = {
  pendiente: 'pendiente', en_curso: 'en curso', hecho: 'hecho', fallo: 'falló', activa: 'activa', frenada: 'frenada', terminada: 'terminada',
  por_hacer: 'por hacer', en_cola: 'en cola', ok: 'terminó', error: 'con error', cancelada: 'cancelada', cargando: 'cargando…', no_existe: 'ya no existe'
};
const ARMADO_MS = 4000;

/** Como `BotonDosPasos` de la consola: el primer clic arma («¿…? Clic de nuevo», vence a los 4 s), el segundo confirma. */
function DosPasos({ texto, armado, clase, alConfirmar, nivel }: { texto: string; armado: string; clase: string; alConfirmar: () => void; nivel?: string }) {
  const [listo, setListo] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <button type="button" class={`go-boton ${clase}${listo ? ' armado' : ''} nodrag`} data-nivel={nivel} onClick={(e) => {
      e.stopPropagation();
      if (!listo) { setListo(true); t.current = setTimeout(() => setListo(false), ARMADO_MS); return; }
      clearTimeout(t.current); setListo(false); alConfirmar();
    }}>{listo ? armado : texto}</button>
  );
}

type Acciones = Pick<PropsOrquestacion, 'alAprobar' | 'alRechazar' | 'alAbrir'>;

function NodoOrq({ data }: NodeProps<Node<DatosNodoOrq>>) {
  const d = data;
  // Las acciones llegan en los datos de cada nodo: nada global que retenga closures ni se pise entre grafos.
  const acciones = (d.acciones ?? {}) as Acciones;
  const estado = TEXTO_ESTADO[d.estado] ?? d.estado;
  const entrada = d.tipo !== 'quien';
  const abrir = d.enlace && d.estado !== 'no_existe' ? () => acciones.alAbrir?.(d.enlace!) : undefined;
  return (
    <div class={`go go-${d.tipo} go-estado-${d.estado}`} aria-label={`${d.sub ? `${d.sub}: ` : ''}${d.titulo} (${estado})`}
      role={abrir ? 'button' : undefined} tabIndex={abrir ? 0 : undefined} onClick={abrir}
      onKeyDown={abrir ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } } : undefined}>
      {entrada && <Handle type="target" position={d.tipo === 'paso' ? Position.Left : Position.Top} isConnectable={false} />}
      {d.tipo === 'quien' && <span class="go-avatar" aria-hidden="true">{d.titulo.charAt(0).toUpperCase()}</span>}
      <div class="go-cab"><span class="go-punto" aria-hidden="true" />{d.sub && <span class="go-sub">{d.sub}</span>}</div>
      <div class="go-titulo">{d.titulo}</div>
      {d.tipo === 'sub' && <div class="go-cuenta">{d.cuenta === 1 ? '1 encargo' : `${d.cuenta} encargos`}{d.corriendo ? ' · trabajando' : ''}</div>}
      {d.tipo === 'hijo' && <div class="go-estado">{estado}</div>}
      {d.tipo === 'aprob' && d.aprobacion && (
        <div class="go-acciones">
          <DosPasos texto="Rechazar" armado="¿Rechazar? Clic de nuevo" clase="" alConfirmar={() => acciones.alRechazar?.(d.aprobacion!.id)} />
          <DosPasos texto="Aprobar" armado="¿Ejecutarlo? Clic de nuevo" clase="go-pri" nivel="ejecutar" alConfirmar={() => acciones.alAprobar?.(d.aprobacion!.id)} />
        </div>
      )}
      {(d.tipo === 'quien' || d.tipo === 'paso') && <Handle type="source" position={Position.Right} isConnectable={false} />}
      {(d.tipo === 'hijo' || d.tipo === 'aprob') && <Handle id="abajo" type="source" position={Position.Bottom} isConnectable={false} />}
      {(d.tipo === 'paso' || d.tipo === 'quien') && <Handle id="abajo" type="source" position={Position.Bottom} isConnectable={false} />}
      {d.tipo === 'hijo' && <Handle id="lado" type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}

const TIPOS = { orq: NodoOrq };

/** Reencuadra cuando cambia la cantidad de nodos (entran pasos, tarjetas o subagentes). */
function Encuadre({ cuantos }: { cuantos: number }) {
  const { fitView } = useReactFlow();
  const previo = useRef(cuantos);
  useEffect(() => {
    if (previo.current === cuantos) return;
    previo.current = cuantos;
    const t = setTimeout(() => { void fitView({ padding: 0.15, duration: 250 }); }, 60);
    return () => clearTimeout(t);
  }, [cuantos, fitView]);
  return null;
}

const coloresDelTema = () => {
  const css = getComputedStyle(document.documentElement);
  return ['--acento', '--ok', '--t0'].map((v) => css.getPropertyValue(v).trim()).filter(Boolean);
};

function Grafo({ props }: { props: PropsOrquestacion }) {
  const grafo = useMemo(() => {
    const g = orquestacionAGrafo(props);
    const acciones: Acciones = { alAprobar: props.alAprobar, alRechazar: props.alRechazar, alAbrir: props.alAbrir };
    // BE-131 — Sin selección ni arrastre, React Flow les pone pointer-events: none y un clic real los atraviesa
    // (Aprobar, Rechazar, abrir). Su `node.style` va después y lo pisa.
    return { edges: g.edges, nodes: g.nodes.map((n) => ({ ...n, style: { ...n.style, pointerEvents: 'all' as const }, data: { ...n.data, acciones } })) };
  }, [props]);
  const previa = useRef<Orquestacion | null>(null);
  const festejo = useRef<ReturnType<typeof crearFestejo> | null>(null);
  useEffect(() => () => festejo.current?.cerrar(), []);
  useEffect(() => {
    const reducido = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cual = debeFestejar(previa.current, props.orquestacion, reducido);
    previa.current = props.orquestacion;
    if (!cual) return;
    festejo.current ??= crearFestejo(coloresDelTema);
    festejo.current.festejar(cual);
  }, [props.orquestacion]);
  return (
    <div class="go-lienzo">
      <ReactFlow nodes={grafo.nodes} edges={grafo.edges} nodeTypes={TIPOS} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
        fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.3} maxZoom={1.5} colorMode="system">
        <Background gap={22} size={1} />
        <Controls showInteractive={false} />
        <Encuadre cuantos={grafo.nodes.length} />
      </ReactFlow>
    </div>
  );
}

export function montarOrquestacion(el: HTMLElement, inicial: PropsOrquestacion) {
  const pintar = (p: PropsOrquestacion) => render(<ReactFlowProvider><Grafo props={p} /></ReactFlowProvider>, el);
  pintar(inicial);
  return { actualizar: pintar, desmontar: () => render(null, el) };
}
