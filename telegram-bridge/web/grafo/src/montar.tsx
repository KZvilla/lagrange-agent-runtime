/**
 * FEAT-148 — Punto de entrada de la isla del grafo (compila a public/vendor/grafo.module.js).
 *
 * Contrato con la consola (lo único que ve `ui/vista-tuberias.js`):
 *   const isla = montar(elemento, props);  isla.actualizar(props);  isla.desmontar();
 * `props` son datos planos (ver `PropsGrafo`) más un aviso, `alElegir`. La isla no hace
 * fetch, no lee rutas ni conoce acciones: pinta el grafo, su leyenda y el reloj.
 */
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Background, Controls, Panel, ReactFlow, applyNodeChanges, useReactFlow, type Node, type NodeChange } from '@xyflow/react';
import { aGrafo, acomodar, borradorAGrafo, conexionValida, disposicionDe, duracion, ICONO, recetaAGrafo, TEXTO_ESTADO, type DatosNodo } from './convertir';
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

function RelojLote({ reloj, ahora, nombres, elegida, alElegir }: { reloj: Reloj; ahora: number; nombres: Record<string, string>; elegida: string | null; alElegir?: (id: string | null) => void }) {
  const e = escalarReloj(reloj, ahora);
  for (const f of e.filas) if (nombres[f.id]) f.titulo = nombres[f.id];
  // FEAT-149 — Plegable: abierto con pocas tareas; plegado deja más alto al lienzo.
  const [abierto, setAbierto] = useState(e.filas.length <= 6);
  return (
    <details class="gn-reloj" aria-label="Reloj del lote" open={abierto} onToggle={(ev) => setAbierto((ev.currentTarget as HTMLDetailsElement).open)}>
      <summary class="gn-reloj-cab">
        <b>Reloj del lote</b>
        <span>tiempo real <b>{duracion(e.totalMs)}</b>{reloj.finMs == null ? ' (sigue)' : ''}{e.soloFases ? '' : <> · espera entre etapas <b>{duracion(reloj.esperaMs)}</b></>}</span>
        <span class="gn-reloj-ley">
          <span><i class="gn-tramo-muestra gn-tramo-espera" />espera su turno</span>
          {Object.entries(TITULO).map(([k, t]) => <span key={k}><i class={`gn-tramo-muestra gn-tramo-${k}`} />{t}</span>)}
          <span><i class="gn-tramo-muestra gn-tramo-falla" />falló</span>
        </span>
      </summary>
      {e.soloFases && <p class="gn-reloj-nota">Este lote no guardó tiempos por tarea: se ve por fases.</p>}
      <div class="gn-reloj-cuerpo">
        {e.filas.map((f) => (
          <div key={f.id} class={`gn-reloj-fila${elegida ? (elegida === f.id ? ' gn-reloj-elegida' : ' gn-reloj-atenuada') : ''}`}
            onClick={alElegir && !e.soloFases ? () => alElegir(elegida === f.id ? null : f.id) : undefined}
            title={alElegir && !e.soloFases ? (elegida === f.id ? 'Mostrar todas' : 'Resaltar esta tarea') : undefined}>
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
    </details>
  );
}

/**
 * Lo que cambia el dibujo de los nodos, sin el reloj ni el historial: cada sondeo trae un
 * objeto nuevo aunque nada haya cambiado, y React Flow oculta y vuelve a medir los nodos
 * nuevos (el parpadeo). Con la misma huella, los mismos nodos.
 */
function huella(p: PropsGrafo): string {
  const t = p.tuberia ? { ...p.tuberia, reloj: null, historial: null } : null;
  return JSON.stringify([t, p.borrador ?? null, p.seleccion ?? null, p.nombres ?? null, p.notas ?? null, p.tareaElegida ?? null,
    p.receta ?? null, p.problemas ?? null, p.disposicion ?? null, !!p.vertical]);
}

/** FEAT-150 — Candado, restablecer y de dónde sale la disposición. */
function ControlesDisposicion({ candado, texto, alCandado, alRestablecer }: { candado: boolean; texto: string | null; alCandado: (c: boolean) => void; alRestablecer?: () => void }) {
  return (
    <Panel position="top-right" class="gn-disp">
      <button type="button" class={`gn-disp-boton${candado ? ' gn-cerrado' : ''}`} aria-pressed={candado} onClick={() => alCandado(!candado)}
        title={candado ? 'Disposición fija: un dedo mueve el lienzo. Tocá para mover nodos.' : 'Los nodos se arrastran por la cabecera (⠿). Tocá para fijarlos.'}>
        {candado ? '🔒 fija' : '🔓 mover nodos'}
      </button>
      {alRestablecer && texto && <button type="button" class="gn-disp-boton" onClick={alRestablecer} title="Volver al acomodo automático">↺ restablecer</button>}
      {texto && <span class="gn-disp-nota">{texto}</span>}
    </Panel>
  );
}

function Lienzo({ props }: { props: PropsGrafo }) {
  const sel = props.seleccion ?? null;
  const nombres = props.nombres ?? {};
  const medidas = useRef(new Map<string, Node['measured']>());
  const clave = huella(props);
  const grafo = useMemo(() => {
    const notas = props.notas ?? {};
    const g = props.receta ? recetaAGrafo(props.receta, sel, notas, props.problemas ?? {})
      : props.borrador ? borradorAGrafo(props.borrador, sel, notas)
        : props.tuberia ? aGrafo(props.tuberia, sel, nombres, notas, props.tareaElegida ?? null) : { nodes: [], edges: [] };
    // FEAT-150 — Acomodo automático (horizontal o vertical) con la disposición dada encima.
    g.nodes = acomodar(g.nodes, props.disposicion, !!props.vertical).map((n) => ({ ...n, dragHandle: '.gn-cabecera' }));
    // Cuando sí cambia algo, cada nodo conserva su medida anterior: no se oculta para remedirse.
    g.nodes = g.nodes.map((n) => (medidas.current.has(n.id) ? { ...n, measured: medidas.current.get(n.id) } : n));
    return g;
  }, [clave]);
  // Los nodos viven en estado para que arrastrarlos los mueva; un grafo nuevo (otra huella) los reemplaza.
  const [vivos, setVivos] = useState<{ clave: string; nodes: Node<DatosNodo>[] }>({ clave, nodes: grafo.nodes });
  const nodes = vivos.clave === clave ? vivos.nodes : grafo.nodes;
  const actuales = useRef(nodes);
  actuales.current = nodes;
  if (!props.tuberia && !props.borrador && !props.receta) return <div class="gn-vacio">Elegí un lote para ver su tubería.</div>;
  const elegir = props.alElegir;
  const editor = !!props.receta;
  const candado = props.candado ?? true;
  const movible = !candado && !!props.alMover;
  return (
    <div class={`gn-isla${editor ? ' gn-modo-editor' : ''}`}>
      <div class={`gn-lienzo${props.vertical ? ' gn-vertical' : ''}`}>
        <ReactFlow
          nodes={nodes}
          edges={grafo.edges}
          nodeTypes={TIPOS_NODO}
          nodesDraggable={movible}
          nodesConnectable={editor && !!props.alConectar}
          elementsSelectable={editor}
          isValidConnection={(c) => conexionValida(c)}
          onConnect={(c) => { if (conexionValida(c)) props.alConectar?.(c.source as 'verificar' | 'auditar'); }}
          deleteKeyCode={editor && props.alQuitar ? ['Delete', 'Backspace'] : null}
          onEdgesDelete={(es) => { for (const e of es) if (e.id.startsWith('vuelta-')) props.alQuitar?.(e.id); }}
          onNodesChange={(cambios: NodeChange<Node<DatosNodo>>[]) => {
            for (const c of cambios) if (c.type === 'dimensions' && c.dimensions) medidas.current.set(c.id, { width: c.dimensions.width, height: c.dimensions.height });
            setVivos({ clave, nodes: applyNodeChanges(cambios, actuales.current) });
          }}
          onNodeDragStop={(_, n) => {
            const todos = actuales.current.map((x) => (x.id === n.id ? { ...x, position: n.position } : x));
            props.alMover?.(disposicionDe(todos));
          }}
          onNodeClick={(_, n) => elegir?.(n.id === sel ? null : n.id)}
          onEdgeClick={(_, e) => { if (editor && e.id.startsWith('vuelta-')) elegir?.(e.id === sel ? null : e.id); }}
          onPaneClick={() => elegir?.(null)}
          fitView
          fitViewOptions={AJUSTE}
          minZoom={0.3}
          maxZoom={1.6}
          colorMode="dark"
        >
          <Background gap={22} size={1} />
          <Controls showInteractive={false} />
          {props.alCandado && <ControlesDisposicion candado={candado} texto={props.textoAjuste ?? null} alCandado={props.alCandado} alRestablecer={props.alRestablecer} />}
          <Reencuadrar />
        </ReactFlow>
      </div>
      {!editor && <Leyenda />}
      {props.tuberia?.reloj && <RelojLote reloj={props.tuberia.reloj} ahora={props.ahora ?? Date.now()} nombres={nombres} elegida={props.tareaElegida ?? null} alElegir={props.alElegirTarea} />}
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
