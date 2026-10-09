/**
 * FEAT-148 — La forma de `tuberia` que devuelve GET /api/lotes/:id
 * (`proyectarTuberia` en mcp-server/lotes/receta-lote.js). La isla solo la pinta:
 * nunca deriva estados.
 */
export type EstadoEtapa = 'pendiente' | 'corriendo' | 'ok' | 'falla' | 'omitida';
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

export interface Tuberia {
  receta: { id: string; version: number; etapas: EtapaReceta[] };
  estado: string | null;
  escrituraMs: number | null;
  resumen: Record<string, EstadoEtapa>;
  tareas: { id: string; etapas: Record<string, Etapa> }[];
  revision: Etapa;
  historial: { estado: string | null; cuando: string | null; motivo: string | null }[];
}

/** Lo que la consola le pasa a la isla (contrato de `montar`). */
export interface PropsGrafo {
  lote: { id: string; estado: string } | null;
  tuberia: Tuberia | null;
}
