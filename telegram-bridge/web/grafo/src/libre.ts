/**
 * FEAT-149 F4a — Del grafo de una receta (`grafo-v1`) a nodos y cables de React Flow: un nodo por
 * nodo con un puerto de salida por resultado, una arista por puerto y, si tiene «al agotar», un
 * cable punteado más desde el mismo puerto. Pura (sin DOM): se prueba en pruebas/libre.ts.
 *
 * El acomodo automático va por capas (distancia desde la Entrada sin contar los cables de vuelta);
 * la disposición guardada gana, como en la clásica. «Resaltar recorrido» atenúa lo que no está en
 * ningún camino que pase por el elemento elegido (lo que no está antes ni después de él).
 */
import type { Edge, Node } from '@xyflow/react';
import { ANCHO_NODO, SEPARACION, ICONO, TEXTO_ESTADO } from './convertir';
import type { Disposicion, EstadoEtapa, GrafoReceta, Nota, Severidad, Vivo } from './tipos';

export const PUERTOS: Record<string, string[]> = {
  entrada: ['sale'], escribir: ['ok', 'sin-cambios', 'error'], verificar: ['pasa', 'falla', 'error'], juez: ['pass', 'fail', 'error'],
  // F4b — Advisor y Humano.
  advisor: ['aprobado', 'corregir', 'humano', 'error'], humano: ['corregir', 'aprobar', 'cancelar'], revision: [],
  // F4c — Semáforo (una arista por rama, todas desde `rama`) y Juntar.
  semaforo: ['rama'], juntar: ['listo', 'conflicto', 'insuficiente', 'error']
};
export const TEXTO_PUERTO: Record<string, string> = {
  sale: 'sale', ok: 'ok', 'sin-cambios': 'sin cambios', error: 'error', pasa: 'pasa', falla: 'falla', pass: 'PASS', fail: 'FAIL',
  aprobado: 'aprobado', corregir: 'corregir', humano: 'pedir humano', aprobar: 'aprobar', cancelar: 'cancelar',
  rama: 'ramas', listo: 'listo', conflicto: 'conflicto', insuficiente: 'insuficiente'
};
export const TITULO_TIPO: Record<string, string> = { entrada: 'Entrada', escribir: 'Escribir', verificar: 'Verificar', juez: 'Juez', advisor: 'Advisor', humano: 'Humano', revision: 'Vos',
  semaforo: 'Semáforo', juntar: 'Juntar' };
// F4b — `corregir` y `cancelar` no son éxito: se dibujan como salida de falla (forma y texto, no solo color).
// F4c — Un conflicto o ramas insuficientes al juntar tampoco son éxito.
const FALLA = new Set(['falla', 'fail', 'error', 'sin-cambios', 'corregir', 'cancelar', 'conflicto', 'insuficiente']);
const PASO_FILA = 230;

export interface DatosPuertos extends Record<string, unknown> {
  tipo: string;
  titulo: string;
  puertos: { id: string; texto: string; falla: boolean }[];
  notas: Nota[];
  seleccionado: boolean;
  atenuado: boolean;
  editor: boolean;
  vertical?: boolean;
  problema?: Severidad;
  estado?: EstadoEtapa;
  textoEstado?: string;
}

/**
 * Capa de cada nodo: el camino más largo desde la Entrada sin contar los cables que vuelven (los
 * que cierran un ciclo en un recorrido en profundidad). Así un nodo queda después de todo lo que
 * lo alimenta: el Juez detrás de Verificar aunque Escribir también llegue directo a él.
 */
export function capas(g: GrafoReceta): Record<string, number> {
  const ids = Object.keys(g.nodos);
  const entrada = ids.find((id) => g.nodos[id].tipo === 'entrada');
  const capa: Record<string, number> = {};
  if (!entrada) { ids.forEach((id, i) => { capa[id] = i; }); return capa; }
  const salidas = (id: string) => g.aristas.filter((a) => a.desde === id).flatMap((a) => [a.hacia, ...(a.alAgotar ? [a.alAgotar] : [])]).filter((h) => g.nodos[h]);
  // Recorrido en profundidad: un cable a un nodo todavía abierto vuelve (se ignora); el resto se ordena.
  const estado = new Map<string, number>();
  const orden: string[] = [];
  const adelante = new Map<string, string[]>();
  const visitar = (id: string) => {
    estado.set(id, 1);
    const siguientes: string[] = [];
    for (const h of salidas(id)) {
      if (estado.get(h) === 1) continue;
      siguientes.push(h);
      if (!estado.get(h)) visitar(h);
    }
    adelante.set(id, siguientes);
    estado.set(id, 2);
    orden.push(id);
  };
  visitar(entrada);
  capa[entrada] = 0;
  for (const id of orden.reverse()) for (const h of adelante.get(id) ?? []) capa[h] = Math.max(capa[h] ?? 0, (capa[id] ?? 0) + 1);
  const max = Math.max(0, ...Object.values(capa));
  for (const id of ids) if (capa[id] == null) capa[id] = max + 1;
  // Revisión siempre al final: es donde termina todo.
  for (const id of ids) if (g.nodos[id].tipo === 'revision') capa[id] = Math.max(capa[id], max);
  return capa;
}

/** Lo que está antes o después de `sel` (nodo o arista): los caminos que pasan por ahí. El resto se atenúa. */
export function enCamino(g: GrafoReceta, sel: string | null): { nodos: Set<string>; aristas: Set<string> } | null {
  if (!sel) return null;
  const arista = g.aristas.find((a) => a.id === sel);
  if (!arista && !g.nodos[sel]) return null;
  const salidas = (id: string) => g.aristas.filter((a) => a.desde === id).flatMap((a) => [a.hacia, ...(a.alAgotar ? [a.alAgotar] : [])]);
  const entradas = (id: string) => g.aristas.filter((a) => a.hacia === id || a.alAgotar === id).map((a) => a.desde);
  const alcance = (desde: string[], vecinos: (id: string) => string[]) => {
    const vistos = new Set<string>(desde);
    const pila = [...desde];
    while (pila.length) for (const v of vecinos(pila.pop() as string)) if (!vistos.has(v)) { vistos.add(v); pila.push(v); }
    return vistos;
  };
  const antes = alcance(arista ? [arista.desde] : [sel], entradas);
  const despues = alcance(arista ? [arista.hacia, ...(arista.alAgotar ? [arista.alAgotar] : [])] : [sel], salidas);
  const nodos = new Set([...antes, ...despues]);
  const aristas = new Set(g.aristas.filter((a) => (antes.has(a.desde) && (antes.has(a.hacia) || a.id === sel)) || (despues.has(a.desde) && despues.has(a.hacia))).map((a) => a.id));
  if (arista) aristas.add(arista.id);
  return { nodos, aristas };
}

export interface OpcionesLibre {
  seleccion?: string | null;
  notas?: Record<string, Nota[]>;
  problemas?: Record<string, Severidad>;
  editor?: boolean;
  resaltar?: boolean;
  vivo?: Vivo | null;
  tareaElegida?: string | null;
  disposicion?: Disposicion | null;
  vertical?: boolean;
}

export function libreAGrafo(g: GrafoReceta, o: OpcionesLibre = {}): { nodes: Node<DatosPuertos>[]; edges: Edge[] } {
  const sel = o.seleccion ?? null;
  const camino = o.resaltar ? enCamino(g, sel?.replace(/~agotar$/, '') ?? null) : null;
  const capa = capas(g);
  const fila: Record<number, number> = {};
  const vivo = o.vivo ? (o.tareaElegida && o.vivo.tareas[o.tareaElegida] ? o.vivo.tareas[o.tareaElegida] : o.vivo) : null;
  const contadores = o.vivo && o.tareaElegida ? o.vivo.tareas[o.tareaElegida]?.contadores ?? {} : {};
  const nodes: Node<DatosPuertos>[] = Object.entries(g.nodos).map(([id, n]) => {
    const c = capa[id];
    const f = (fila[c] = (fila[c] ?? -1) + 1);
    const auto = o.vertical ? { x: f * (ANCHO_NODO + 40), y: c * PASO_FILA } : { x: c * (ANCHO_NODO + SEPARACION), y: f * PASO_FILA };
    const d = o.disposicion?.[id];
    const estado = vivo?.nodos[id];
    return {
      id, type: 'puertos', position: Array.isArray(d) ? { x: d[0], y: d[1] } : auto, deletable: !!o.editor && n.tipo !== 'entrada', dragHandle: '.gn-cabecera',
      data: {
        tipo: n.tipo, titulo: n.titulo || TITULO_TIPO[n.tipo] || n.tipo,
        puertos: (PUERTOS[n.tipo] ?? []).map((p) => ({ id: p, texto: TEXTO_PUERTO[p] ?? p, falla: FALLA.has(p) })),
        notas: o.notas?.[id] ?? [], seleccionado: sel === id, atenuado: !!camino && !camino.nodos.has(id), editor: !!o.editor, vertical: !!o.vertical,
        ...(o.problemas?.[id] ? { problema: o.problemas[id] } : {}),
        ...(estado ? { estado, textoEstado: `${ICONO[estado]} ${TEXTO_ESTADO[estado]}` } : {})
      }
    };
  });
  const edges: Edge[] = [];
  for (const a of g.aristas) {
    const vuelve = capa[a.hacia] <= capa[a.desde];
    const usos = vivo?.aristas[a.id] ?? 0;
    const cuenta = a.tope != null ? (o.vivo ? ` · ${contadores[a.id] ?? (o.tareaElegida ? 0 : '–')}/${a.tope}` : ` · máx ${a.tope}`) : '';
    const atenuada = !!camino && !camino.aristas.has(a.id);
    const clase = ['cable', 'cable-libre', FALLA.has(a.puerto) ? 'cable-falla-puerto' : '', vivo ? (usos ? 'cable-hecho' : 'cable-pendiente') : 'cable-receta',
      sel === a.id ? 'cable-sel' : '', atenuada ? 'cable-atenuado' : '', o.problemas?.[a.id] ? `cable-problema-${o.problemas[a.id]}` : ''].filter(Boolean).join(' ');
    edges.push({
      id: a.id, source: a.desde, sourceHandle: a.puerto, target: a.hacia, targetHandle: 'entra', type: vuelve ? 'smoothstep' : 'default',
      // El nombre del puerto ya está en el nodo: la etiqueta solo va si dice algo más (tope, contador, usos).
      label: cuenta || (vivo && usos > 1) ? `${TEXTO_PUERTO[a.puerto] ?? a.puerto}${cuenta}${!cuenta && usos > 1 ? ` · ×${usos}` : ''}` : undefined, className: clase, selectable: !!o.editor || !!o.resaltar, deletable: !!o.editor, selected: sel === a.id,
      ...(vuelve ? { pathOptions: { offset: 36, borderRadius: 14 } } : {}), data: { arista: a.id }
    } as Edge);
    if (a.alAgotar) {
      edges.push({
        id: `${a.id}~agotar`, source: a.desde, sourceHandle: a.puerto, target: a.alAgotar, targetHandle: 'entra', type: 'smoothstep',
        label: 'al agotar', className: `cable cable-libre cable-agotar${sel === `${a.id}~agotar` || sel === a.id ? ' cable-sel' : ''}${atenuada ? ' cable-atenuado' : ''}`,
        selectable: !!o.editor || !!o.resaltar, deletable: false, pathOptions: { offset: 56, borderRadius: 14 }, data: { arista: a.id, agotar: true }
      } as Edge);
    }
  }
  return { nodes, edges };
}

/** El id de la arista de la receta detrás de un cable (el de «al agotar» es la misma arista). */
export const aristaDeCable = (id: string): string => id.replace(/~agotar$/, '');
