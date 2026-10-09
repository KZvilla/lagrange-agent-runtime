/**
 * FEAT-148 G2.5 — Del `reloj` del servidor a filas y posiciones (en %) para dibujarlo.
 * Pura, como convertir.ts. Los tramos y las esperas ya vienen derivados del servidor:
 * acá solo se escalan.
 */
import type { Reloj, Tramo } from './tipos';

export interface Segmento {
  etapa: string;
  tipo: 'trabajo' | 'espera' | 'falla';
  /** Posición y ancho en % del total. */
  izq: number;
  ancho: number;
  ms: number;
  sigue: boolean;
}

export interface Fila {
  id: string;
  titulo: string;
  segmentos: Segmento[];
}

export interface Marca {
  pos: number;
  texto: string;
}

export interface Escala {
  totalMs: number;
  filas: Fila[];
  marcas: Marca[];
  /** Posición (%) de la línea "ahora", solo si el lote sigue. */
  ahora: number | null;
  /** Sin tiempos por tarea (lotes viejos): solo las fases del lote. */
  soloFases: boolean;
}

const PASOS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);

function textoMarca(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}` : `${s / 60}m`;
  return `${Math.floor(s / 3600)}h${s % 3600 ? String(Math.round((s % 3600) / 60)).padStart(2, '0') : ''}`;
}

/** Cada cuánto va una marca del eje: el paso más chico que deja 8 marcas o menos. */
export function pasoDeMarcas(totalMs: number): number {
  return PASOS.find((p) => totalMs / p <= 8) ?? PASOS[PASOS.length - 1];
}

export function escalarReloj(r: Reloj, ahora: number): Escala {
  const fin = r.finMs ?? Math.max(ahora, r.inicioMs);
  const totalMs = Math.max(fin - r.inicioMs, 1000);
  const pos = (t: number) => Math.min(100, Math.max(0, ((t - r.inicioMs) / totalMs) * 100));
  const seg = (x: Tramo): Segmento => {
    const hasta = x.hasta ?? fin;
    return { etapa: x.etapa, tipo: x.tipo ?? 'trabajo', izq: pos(x.desde), ancho: Math.max(pos(hasta) - pos(x.desde), 0.4), ms: Math.max(hasta - x.desde, 0), sigue: x.hasta == null };
  };
  const escribir = r.fases.find((f) => f.etapa === 'escribir');
  const soloFases = !r.tareas.length;
  const filas: Fila[] = soloFases
    ? [{ id: 'lote', titulo: 'Lote (por fases)', segmentos: r.fases.map(seg) }]
    : [
        ...(escribir ? [{ id: 'escribir', titulo: 'Escribir (todas)', segmentos: [seg(escribir)] }] : []),
        ...r.tareas.map((t) => ({ id: t.id, titulo: t.id, segmentos: t.tramos.map(seg) }))
      ];
  const paso = pasoDeMarcas(totalMs);
  const marcas: Marca[] = [];
  for (let t = 0; t <= totalMs; t += paso) marcas.push({ pos: (t / totalMs) * 100, texto: textoMarca(t) });
  return { totalMs, filas, marcas, ahora: r.finMs == null ? pos(ahora) : null, soloFases };
}
