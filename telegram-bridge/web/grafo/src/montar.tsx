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
import { Background, Controls, Panel, ReactFlow, applyNodeChanges, useReactFlow, type Node, type NodeChange, type ReactFlowInstance } from '@xyflow/react';
import { aGrafo, acomodar, borradorAGrafo, conexionValida, disposicionDe, duracion, ICONO, recetaAGrafo, TEXTO_ESTADO, type DatosNodo } from './convertir';
import { NodoEtapa, NodoPuertos } from './nodos';
import { TIPOS_ARISTA } from './aristas';
import { escalarReloj } from './reloj';
import { aristaDeCable, libreAGrafo, type DatosPuertos } from './libre';
import type { EstadoEtapa, Menu, PropsGrafo, Reloj } from './tipos';

const TIPOS_NODO = { etapa: NodoEtapa, puertos: NodoPuertos };
type Datos = DatosNodo | DatosPuertos;
const MANTENER_MS = 500;
const TOLERANCIA_PX = 8;

/**
 * FEAT-149 F4a — Menú contextual sin librería: el evento `contextmenu` (clic derecho; en Android
 * también lo dispara mantener apretado), mantener apretado propio (táctil o lápiz, ~500 ms, se
 * cancela si el dedo se mueve más de 8 px o se levanta antes) y el teclado (tecla de menú o
 * Shift+F10 sobre lo elegido). La isla solo avisa dónde y sobre qué (`alMenu`), con la posición
 * en pantalla y en el lienzo; el menú lo pinta la consola.
 */
function GestosMenu({ alMenu, sel }: { alMenu: (m: Menu | null) => void; sel: string | null }) {
  const { screenToFlowPosition } = useReactFlow();
  const elegido = useRef(sel);
  elegido.current = sel;
  useEffect(() => {
    const el = document.querySelector('.gn-lienzo') as HTMLElement | null;
    if (!el) return;
    const pedir = (x: number, y: number, objetivo: Element | null) => {
      const it = objetivo?.closest('.react-flow__node, .react-flow__edge') as HTMLElement | null;
      const tipo = !it ? 'lienzo' : (it.classList.contains('react-flow__node') ? 'nodo' : 'arista');
      const id = it?.dataset.id ?? null;
      alMenu({ tipo, id: id && tipo === 'arista' ? aristaDeCable(id) : id, x, y, posicion: screenToFlowPosition({ x, y }) });
    };
    let reloj: ReturnType<typeof setTimeout> | undefined;
    let inicio: { x: number; y: number; objetivo: Element | null } | null = null;
    // Si el mantener apretado propio ya abrió el menú, el `contextmenu` del sistema que llega después no lo repite.
    let ultimoToque = 0;
    const derecho = (e: MouseEvent) => {
      e.preventDefault();
      if (Date.now() - ultimoToque < 800) return;
      pedir(e.clientX, e.clientY, e.target as Element);
    };
    const abajo = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      inicio = { x: e.clientX, y: e.clientY, objetivo: e.target as Element };
      clearTimeout(reloj);
      reloj = setTimeout(() => { if (inicio) { ultimoToque = Date.now(); pedir(inicio.x, inicio.y, inicio.objetivo); } inicio = null; }, MANTENER_MS);
    };
    const mueve = (e: PointerEvent) => { if (inicio && Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y) > TOLERANCIA_PX) { clearTimeout(reloj); inicio = null; } };
    const suelta = () => { clearTimeout(reloj); inicio = null; };
    const tecla = (e: KeyboardEvent) => {
      if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
      e.preventDefault();
      const s = elegido.current;
      const objetivo = s ? el.querySelector(`[data-id="${CSS.escape(s)}"]`) : null;
      const r = (objetivo ?? el).getBoundingClientRect();
      pedir(r.left + r.width / 2, r.top + r.height / 2, objetivo);
    };
    el.addEventListener('contextmenu', derecho);
    el.addEventListener('pointerdown', abajo);
    el.addEventListener('pointermove', mueve);
    el.addEventListener('pointerup', suelta);
    el.addEventListener('pointercancel', suelta);
    // En captura: un nodo con foco no deja subir sus teclas (React Flow las consume).
    el.addEventListener('keydown', tecla, true);
    return () => {
      clearTimeout(reloj);
      el.removeEventListener('contextmenu', derecho);
      el.removeEventListener('pointerdown', abajo);
      el.removeEventListener('pointermove', mueve);
      el.removeEventListener('pointerup', suelta);
      el.removeEventListener('pointercancel', suelta);
      el.removeEventListener('keydown', tecla, true);
    };
  }, [alMenu, screenToFlowPosition]);
  return null;
}
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
    <details class="gn-reloj" aria-label="Reloj del batch" open={abierto} onToggle={(ev) => setAbierto((ev.currentTarget as HTMLDetailsElement).open)}>
      <summary class="gn-reloj-cab">
        <b>Reloj del batch</b>
        <span>tiempo real <b>{duracion(e.totalMs)}</b>{reloj.finMs == null ? ' (sigue)' : ''}{e.soloFases ? '' : <> · espera entre etapas <b>{duracion(reloj.esperaMs)}</b></>}</span>
        <span class="gn-reloj-ley">
          <span><i class="gn-tramo-muestra gn-tramo-espera" />espera su turno</span>
          {Object.entries(TITULO).map(([k, t]) => <span key={k}><i class={`gn-tramo-muestra gn-tramo-${k}`} />{t}</span>)}
          <span><i class="gn-tramo-muestra gn-tramo-falla" />falló</span>
        </span>
      </summary>
      {e.soloFases && <p class="gn-reloj-nota">Este batch no guardó tiempos por tarea: se ve por fases.</p>}
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
    p.receta ?? null, p.problemas ?? null, p.disposicion ?? null, !!p.vertical, p.grafo ?? null, p.vivo ?? null, !!p.resaltar]);
}

/** FEAT-150 — Candado, restablecer y de dónde sale la disposición. */
function ControlesDisposicion({ candado, texto, alCandado, alRestablecer }: { candado: boolean; texto: string | null; alCandado: (c: boolean) => void; alRestablecer?: () => void }) {
  return (
    <Panel position="top-right" className="gn-disp">
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
    // F4a — Un grafo libre trae su propio acomodo (por capas) con la disposición encima.
    if (props.grafo) {
      const l = libreAGrafo(props.grafo, { seleccion: sel, notas, problemas: props.problemas ?? {}, editor: !!props.alConectarPuerto, resaltar: !!props.resaltar,
        vivo: props.vivo ?? null, tareaElegida: props.tareaElegida ?? null, disposicion: props.disposicion, vertical: !!props.vertical });
      return { nodes: l.nodes.map((n) => (medidas.current.has(n.id) ? { ...n, measured: medidas.current.get(n.id) } : n)), edges: l.edges };
    }
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
  const [vivos, setVivos] = useState<{ clave: string; nodes: Node<Datos>[] }>({ clave, nodes: grafo.nodes });
  const nodes = vivos.clave === clave ? vivos.nodes : grafo.nodes;
  const actuales = useRef(nodes);
  actuales.current = nodes;
  const instancia = useRef<ReactFlowInstance | null>(null);
  if (!props.tuberia && !props.borrador && !props.receta && !props.grafo) return <div class="gn-vacio">Elegí un batch para ver su pipeline.</div>;
  const elegir = props.alElegir;
  const libre = !!props.grafo;
  const editor = !!props.receta || (libre && !!props.alConectarPuerto);

  const candado = props.candado ?? true;
  const movible = !candado && !!props.alMover;
  return (
    <div class={`gn-isla${editor ? ' gn-modo-editor' : ''}`}>
      <div class={`gn-lienzo${props.vertical ? ' gn-vertical' : ''}`}>
        <ReactFlow
          nodes={nodes}
          edges={grafo.edges}
          nodeTypes={TIPOS_NODO}
          edgeTypes={TIPOS_ARISTA}
          nodesDraggable={movible}
          nodesConnectable={editor && (libre || !!props.alConectar)}
          elementsSelectable={editor || (libre && !!props.resaltar)}
          isValidConnection={(c) => (libre ? !!c.sourceHandle && c.targetHandle === 'entra' && c.source !== c.target : conexionValida(c))}
          onConnect={(c) => {
            if (libre) { if (c.source && c.sourceHandle && c.target && c.source !== c.target) props.alConectarPuerto?.({ desde: c.source, puerto: c.sourceHandle, hacia: c.target }); return; }
            if (conexionValida(c)) props.alConectar?.(c.source as 'verificar' | 'auditar');
          }}
          onInit={(i) => { instancia.current = i as unknown as ReactFlowInstance; }}
          // FEAT-156 — Un cable que se suelta en el vacío (sin nodo destino): la consola abre la paleta ahí, filtrada.
          onConnectEnd={libre && props.alSoltarCable ? (ev, estado) => {
            if (estado.toNode || !estado.fromNode || !estado.fromHandle?.id || estado.fromHandle.type !== 'source') return;
            const p = 'changedTouches' in ev ? ev.changedTouches[0] : ev;
            if (!p) return;
            const posicion = instancia.current ? instancia.current.screenToFlowPosition({ x: p.clientX, y: p.clientY }) : null;
            props.alSoltarCable?.({ desde: estado.fromNode.id, puerto: estado.fromHandle.id, x: p.clientX, y: p.clientY, posicion });
          } : undefined}
          deleteKeyCode={editor && (props.alQuitar || props.alQuitarElemento) ? ['Delete', 'Backspace'] : null}
          onEdgesDelete={(es) => { if (!libre) for (const e of es) if (e.id.startsWith('vuelta-')) props.alQuitar?.(e.id); }}
          onDelete={({ nodes: ns, edges: es }) => {
            if (!libre) return;
            // Quitar un nodo ya quita sus aristas: se avisa el nodo solo (un paso de deshacer, no uno por arista).
            if (ns.length) { for (const n of ns) props.alQuitarElemento?.({ tipo: 'nodo', id: n.id }); return; }
            for (const e of es) props.alQuitarElemento?.({ tipo: 'arista', id: e.id });
          }}
          // Solo un paneo o zoom del usuario cierra el menú: un reencuadre automático (fitView) llega sin evento.
          onMoveStart={props.alMenu ? (ev) => { if (ev) props.alMenu?.(null); } : undefined}
          onNodesChange={(cambios: NodeChange<Node<Datos>>[]) => {
            for (const c of cambios) if (c.type === 'dimensions' && c.dimensions) medidas.current.set(c.id, { width: c.dimensions.width, height: c.dimensions.height });
            setVivos({ clave, nodes: applyNodeChanges(cambios, actuales.current) });
          }}
          onNodeDragStop={(_, n) => {
            const todos = actuales.current.map((x) => (x.id === n.id ? { ...x, position: n.position } : x));
            props.alMover?.(disposicionDe(todos));
          }}
          onNodeClick={(_, n) => elegir?.(n.id === sel ? null : n.id)}
          onEdgeClick={(_, e) => {
            if (libre) { const id = aristaDeCable(e.id); elegir?.(id === sel ? null : id); return; }
            if (editor && e.id.startsWith('vuelta-')) elegir?.(e.id === sel ? null : e.id);
          }}
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
          {props.alMenu && <GestosMenu alMenu={props.alMenu} sel={sel} />}
        </ReactFlow>
      </div>
      {!editor && !libre && <Leyenda />}
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
