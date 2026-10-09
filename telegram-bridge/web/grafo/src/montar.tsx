/**
 * FEAT-148 — Punto de entrada de la isla del grafo (compila a public/vendor/grafo.module.js).
 *
 * Contrato con la consola (lo único que ve `ui/vista-tuberias.js`):
 *   const isla = montar(elemento, props);  isla.actualizar(props);  isla.desmontar();
 * `props` son datos planos (ver `PropsGrafo`). La isla no hace fetch ni lee rutas: pinta.
 */
import { render } from 'preact';
import { useMemo } from 'preact/hooks';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { aGrafo } from './convertir';
import { NodoEtapa } from './nodos';
import type { PropsGrafo } from './tipos';

const TIPOS_NODO = { etapa: NodoEtapa };
const ESTADO: Record<string, string> = { ok: 'ok', falla: 'falla', corriendo: 'en curso', pendiente: 'pendiente', omitida: 'omitida' };

function Cola({ props }: { props: PropsGrafo }) {
  const t = props.tuberia;
  if (!t || !t.tareas.length) return null;
  const etapas = t.receta.etapas.filter((e) => e.tipo !== 'humano');
  return (
    <ol class="gn-cola" aria-label="Tareas pasando por el grafo">
      {t.tareas.map((x) => (
        <li key={x.id}>
          <b class="gn-cola-id">{x.id}</b>
          {etapas.map((e) => {
            const et = x.etapas[e.id];
            const estado = et?.estado ?? 'pendiente';
            return <span key={e.id} class={`gn-cola-paso gn-estado-${estado}`}>{e.titulo} {et?.veredicto ?? ESTADO[estado]}</span>;
          })}
        </li>
      ))}
    </ol>
  );
}

function Lienzo({ props }: { props: PropsGrafo }) {
  const grafo = useMemo(() => (props.tuberia ? aGrafo(props.tuberia) : { nodes: [], edges: [] }), [props.tuberia]);
  if (!props.tuberia) return <div class="gn-vacio">Elegí un lote para ver su tubería.</div>;
  return (
    <div class="gn-isla">
      <div class="gn-lienzo">
        <ReactFlow
          nodes={grafo.nodes}
          edges={grafo.edges}
          nodeTypes={TIPOS_NODO}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.3}
          maxZoom={1.6}
          colorMode="dark"
        >
          <Background gap={22} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <Cola props={props} />
    </div>
  );
}

export function montar(el: HTMLElement, inicial: PropsGrafo) {
  const pintar = (p: PropsGrafo) => render(<Lienzo props={p} />, el);
  pintar(inicial);
  return {
    actualizar: pintar,
    desmontar: () => render(null, el)
  };
}
