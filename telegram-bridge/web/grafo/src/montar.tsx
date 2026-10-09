/**
 * FEAT-148 — Punto de entrada de la isla del grafo (compila a public/vendor/grafo.module.js).
 *
 * Contrato con la consola (lo único que ve `ui/vista-tuberias.js`):
 *   const isla = montar(elemento, props);  isla.actualizar(props);  isla.desmontar();
 * `props` son datos planos (ver `PropsGrafo`) más un aviso, `alElegir`. La isla no hace
 * fetch, no lee rutas ni conoce acciones: pinta el grafo, su leyenda y el reloj.
 */
import { render } from 'preact';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { Background, Controls, ReactFlow, useReactFlow } from '@xyflow/react';
import { aGrafo, duracion, ICONO, TEXTO_ESTADO } from './convertir';
import { NodoEtapa } from './nodos';
import { escalarReloj } from './reloj';
import type { EstadoEtapa, PropsGrafo, Reloj } from './tipos';

const TIPOS_NODO = { etapa: NodoEtapa };
const TITULO: Record<string, string> = { escribir: 'Escribir', verificar: 'Verificar', auditar: 'Auditar' };

const AJUSTE = { padding: 0.12 };

/**
 * Si el lienzo cambia de ancho (se abre o cierra el inspector, cambia la ventana),
 * se vuelve a encuadrar: React Flow solo encuadra al montar.
 */
function Reencuadrar() {
  const { fitView } = useReactFlow();
  const ancho = useRef(0);
  useEffect(() => {
    const el = document.querySelector('.gn-lienzo');
    if (!el || typeof ResizeObserver === 'undefined') return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (!ancho.current || Math.abs(w - ancho.current) < 8) { ancho.current = w; return; }
      ancho.current = w;
      clearTimeout(t);
      t = setTimeout(() => { void fitView({ ...AJUSTE, duration: 200 }); }, 120);
    });
    ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [fitView]);
  return null;
}

function Leyenda() {
  const cables: [string, string][] = [['hecho', 'pasó'], ['corriendo', 'pasa ahora'], ['pendiente', 'todavía no llegó'], ['falla', 'falló'], ['omitida', 'omitida']];
  const estados: EstadoEtapa[] = ['ok', 'corriendo', 'pendiente', 'esperando', 'falla', 'omitida'];
  return (
    <div class="gn-leyenda" aria-label="Leyenda">
      <span class="gn-ley-grupo"><b>Flujo</b>
        {cables.map(([k, t]) => (
          <span key={k} class="gn-ley-item"><svg width="30" height="6" aria-hidden="true"><path d="M1 3 L29 3" class={`gn-ley-cable cable-${k}`} /></svg>{t}</span>
        ))}
      </span>
      <span class="gn-ley-grupo"><b>Estados</b>
        {estados.map((e) => <span key={e} class={`gn-ley-item gn-estado-${e}`}><span class={`gn-icono gn-icono-${e}`} aria-hidden="true">{ICONO[e]}</span>{e === 'esperando' ? 'tu decisión' : TEXTO_ESTADO[e]}</span>)}
      </span>
    </div>
  );
}

function RelojLote({ reloj, ahora }: { reloj: Reloj; ahora: number }) {
  const e = escalarReloj(reloj, ahora);
  return (
    <section class="gn-reloj" aria-label="Reloj del lote">
      <div class="gn-reloj-cab">
        <b>Reloj del lote</b>
        <span>tiempo real <b>{duracion(e.totalMs)}</b>{reloj.finMs == null ? ' (sigue)' : ''}{e.soloFases ? '' : <> · espera entre etapas <b>{duracion(reloj.esperaMs)}</b></>}</span>
        <span class="gn-reloj-ley">
          <span><i class="gn-tramo-muestra gn-tramo-espera" />espera su turno</span>
          {Object.entries(TITULO).map(([k, t]) => <span key={k}><i class={`gn-tramo-muestra gn-tramo-${k}`} />{t}</span>)}
          <span><i class="gn-tramo-muestra gn-tramo-falla" />falló</span>
        </span>
      </div>
      {e.soloFases && <p class="gn-reloj-nota">Este lote no guardó tiempos por tarea: se ve por fases.</p>}
      <div class="gn-reloj-cuerpo">
        {e.filas.map((f) => (
          <div key={f.id} class="gn-reloj-fila">
            <span class="gn-reloj-id" title={f.titulo}>{f.titulo}</span>
            <span class="gn-reloj-pista">
              {e.marcas.map((m) => <i key={m.texto} class="gn-reloj-guia" style={{ left: `${m.pos}%` }} />)}
              {f.segmentos.map((s, i) => (
                <span key={i} class={`gn-tramo gn-tramo-${s.tipo === 'espera' ? 'espera' : s.etapa}${s.tipo === 'falla' ? ' gn-tramo-falla' : ''}${s.sigue ? ' gn-tramo-sigue' : ''}`}
                  style={{ left: `${s.izq}%`, width: `${s.ancho}%` }}
                  title={`${s.tipo === 'espera' ? `espera antes de ${TITULO[s.etapa] ?? s.etapa}` : TITULO[s.etapa] ?? s.etapa}${s.tipo === 'falla' ? ' (falló)' : ''} · ${duracion(s.ms)}${s.sigue ? ' (sigue)' : ''}`} />
              ))}
              {e.ahora != null && <i class="gn-reloj-ahora" style={{ left: `${e.ahora}%` }} />}
            </span>
          </div>
        ))}
        <div class="gn-reloj-fila gn-reloj-eje" aria-hidden="true">
          <span class="gn-reloj-id" />
          <span class="gn-reloj-pista">{e.marcas.map((m) => <span key={m.texto} style={{ left: `${m.pos}%` }}>{m.texto}</span>)}</span>
        </div>
      </div>
    </section>
  );
}

function Lienzo({ props }: { props: PropsGrafo }) {
  const sel = props.seleccion ?? null;
  const grafo = useMemo(() => (props.tuberia ? aGrafo(props.tuberia, sel) : { nodes: [], edges: [] }), [props.tuberia, sel]);
  if (!props.tuberia) return <div class="gn-vacio">Elegí un lote para ver su tubería.</div>;
  const elegir = props.alElegir;
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
          onNodeClick={(_, n) => elegir?.(n.id === sel ? null : n.id)}
          onPaneClick={() => elegir?.(null)}
          fitView
          fitViewOptions={AJUSTE}
          minZoom={0.3}
          maxZoom={1.6}
          colorMode="dark"
        >
          <Background gap={22} size={1} />
          <Controls showInteractive={false} />
          <Reencuadrar />
        </ReactFlow>
      </div>
      <Leyenda />
      {props.tuberia.reloj && <RelojLote reloj={props.tuberia.reloj} ahora={props.ahora ?? Date.now()} />}
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
