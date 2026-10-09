/**
 * FEAT-148 — La forma de `tuberia` que devuelve GET /api/lotes/:id
 * (`proyectarTuberia` en mcp-server/lotes/receta-lote.js). La isla solo la pinta:
 * nunca deriva estados.
 */
export type EstadoEtapa = 'pendiente' | 'corriendo' | 'esperando' | 'ok' | 'falla' | 'omitida';
export type TipoEtapa = 'escribir' | 'verificar' | 'auditar' | 'humano';

export interface Actor {
  motor: string | null;
  modelo: string | null;
}

export interface Etapa {
  estado: EstadoEtapa;
  actor?: Actor;
  duracionMs?: number | null;
  motivo?: string | null;
  veredicto?: string | null;
  salida?: string | null;
}

export interface EtapaReceta {
  id: string;
  tipo: TipoEtapa;
  titulo: string;
  salidas?: string[];
}

/** G2.5 — Un tramo del reloj, en ms epoch; `hasta: null` = sigue. */
export interface Tramo {
  etapa: string;
  desde: number;
  hasta: number | null;
  tipo?: 'trabajo' | 'espera' | 'falla';
}

export interface Reloj {
  inicioMs: number;
  finMs: number | null;
  fases: Tramo[];
  tareas: { id: string; tramos: Tramo[] }[];
  esperaMs: number;
}

export interface Tuberia {
  receta: { id: string; version: number; etapas: EtapaReceta[] };
  estado: string | null;
  escrituraMs: number | null;
  resumen: Record<string, EstadoEtapa>;
  /** G2.5 — Cuántas tareas llegaron a cada etapa (la etiqueta del cable que entra). */
  cruces?: Record<string, number>;
  tareas: { id: string; etapas: Record<string, Etapa> }[];
  revision: Etapa;
  reloj?: Reloj | null;
  historial: { estado: string | null; cuando: string | null; motivo: string | null }[];
}

/**
 * Lo que la consola le pasa a la isla (contrato de `montar`). Datos planos, más un
 * único aviso: `alElegir` cuando se elige un nodo (o se suelta, con null). La isla
 * no hace fetch, no conoce rutas ni acciones.
 */
export interface PropsGrafo {
  lote: { id: string; estado: string } | null;
  tuberia: Tuberia | null;
  /** El id de la etapa elegida (o 'entrada'), o null. */
  seleccion?: string | null;
  alElegir?: (id: string | null) => void;
  /** Epoch ms del último sondeo: la línea "ahora" del reloj en un lote activo. */
  ahora?: number;
  /** Nombre legible por id de tarea (el título de la tarjeta); sin él, se ve el id. */
  nombres?: Record<string, string>;
  /** G3 — Un lote todavía sin lanzar: se dibuja la receta con los actores elegidos, en texto. */
  borrador?: Borrador | null;
  /** FEAT-149 — Líneas de configuración por etapa (skill, comandos, criterio), con su procedencia. */
  notas?: Record<string, Nota[]>;
}

export type Origen = 'receta' | 'repo' | 'tarea' | 'lote';

export interface Nota {
  texto: string;
  origen?: Origen;
}

export interface Borrador {
  tareas: string[];
  /** Las tareas que declaran prueba (las otras se ven "sin prueba" en Verificar). */
  conPrueba: string[];
  escribir: string;
  auditar: string;
}
