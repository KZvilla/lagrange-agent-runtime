/**
 * FEAT-109 — La banda de agy sobre el prompt, sin `$`: qué tools son de agy,
 * el veredicto de una auditoría y las filas que se dibujan.
 *
 * De las tools unitarias (`agy_run`, `agy_audit`…) solo se sabe que corren y
 * desde cuándo: no dejan nada en disco. Del fan-out y los lotes, lo que trae
 * `panel.js fanout` (estado, modelo, paso y tiempos por tarea).
 */

import type { FanoutPanel } from '../types'

export type LlamadaAgy = { tool: string; desde: number }

export type ResultadoAgy = 'PASS' | 'PASS WITH RESERVATIONS' | 'FAIL' | 'terminó' | 'error'

export type CierreAgy = { tool: string; resultado: ResultadoAgy; duracionMs: number; hasta: number }

export type Tono = 'normal' | 'ok' | 'error' | 'tenue'

export type FilaBanda = { texto: string; tono: Tono }

/** Cuánto queda la línea de cierre después de terminar una llamada. */
export const CIERRE_MS = 20_000

const MAX_TAREAS = 6

// El nombre del servidor MCP cambia según cómo se cargó el plugin
// (`plugin_lagrange_lagrange`, `lagrange-dev`): se mira solo el final.
const TOOL_AGY = /^mcp__[^_].*__agy_(run|audit|plan|review|research|fanout|lote)$/

// La misma regex que `parsearVeredicto` en `mcp-server/lotes/auditor.js`, que el
// mod no puede importar (CommonJS con Node). `test/banda-texto.test.js` las compara.
const VEREDICTO = /^## Verdict:\s*(PASS WITH RESERVATIONS|PASS|FAIL)\s*$/mi

export function esToolDeAgy(nombre: unknown): boolean {
  return typeof nombre === 'string' && TOOL_AGY.test(nombre)
}

/** `mcp__plugin_lagrange_lagrange__agy_audit` → `agy_audit`. */
export function nombreCorto(tool: string): string {
  const i = tool.lastIndexOf('__')
  return i >= 0 ? tool.slice(i + 2) : tool
}

/** El veredicto del texto de una auditoría, o `null` si no lo trae. */
export function veredictoDe(texto: unknown): 'PASS' | 'PASS WITH RESERVATIONS' | 'FAIL' | null {
  const m = VEREDICTO.exec(String(texto ?? ''))
  return m ? (m[1].toUpperCase() as 'PASS' | 'PASS WITH RESERVATIONS' | 'FAIL') : null
}

/** El cierre de una llamada que terminó: veredicto, «terminó» o «error». */
export function cierreDe(tool: string, { texto, fallo }: { texto?: unknown; fallo: boolean }, desde: number, ahora: number): CierreAgy {
  const resultado: ResultadoAgy = fallo ? 'error' : veredictoDe(texto) ?? 'terminó'
  return { tool, resultado, duracionMs: Math.max(0, ahora - desde), hasta: ahora + CIERRE_MS }
}

/** `48s`, `3m12s`, `1h05m`. */
export function duracion(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function tonoDe(resultado: string): Tono {
  if (resultado === 'PASS' || resultado === 'PASS WITH RESERVATIONS' || resultado === 'ok') return 'ok'
  if (resultado === 'FAIL' || resultado === 'error') return 'error'
  return 'normal'
}

function tiempoDeTarea(t: { estado: string; inicio?: string | null; fin?: string | null }, ahora: number): string | null {
  const inicio = t.inicio ? Date.parse(t.inicio) : NaN
  if (!Number.isFinite(inicio)) return null
  const fin = t.fin ? Date.parse(t.fin) : NaN
  if (Number.isFinite(fin)) return duracion(fin - inicio)
  return t.estado === 'corriendo' || t.estado === 'reintentando' ? duracion(ahora - inicio) : null
}

/** ¿Hay algo que dibujar? Sin esto la banda devuelve `next(e)`. */
export function hayAlgo({ llamadas, cierres, fanout, ahora }: { llamadas: LlamadaAgy[]; cierres: CierreAgy[]; fanout: FanoutPanel | null; ahora: number }): boolean {
  return llamadas.length > 0 || cierres.some((c) => ahora < c.hasta) || Boolean(fanout && !fanout.terminado && fanout.tareas.length)
}

/**
 * Las filas de la banda: llamadas en curso, cierres vigentes y el fan-out en
 * curso. Sin contadores en el encabezado del fan-out: ya los da la status line.
 */
export function filasDeBanda({ llamadas, cierres, fanout, ahora, maxFilas }: { llamadas: LlamadaAgy[]; cierres: CierreAgy[]; fanout: FanoutPanel | null; ahora: number; maxFilas?: number }): FilaBanda[] {
  const filas: FilaBanda[] = []
  for (const l of llamadas) filas.push({ texto: `${nombreCorto(l.tool)} · ${duracion(ahora - l.desde)}`, tono: 'normal' })
  for (const c of cierres) {
    if (ahora >= c.hasta) continue
    filas.push({ texto: `${nombreCorto(c.tool)} · ${c.resultado} · ${duracion(c.duracionMs)}`, tono: tonoDe(c.resultado) })
  }
  if (fanout && !fanout.terminado && fanout.tareas.length) {
    filas.push({ texto: `fanout ${fanout.slug ?? ''}`.trim(), tono: 'normal' })
    const ancho = Math.max(...fanout.tareas.slice(0, MAX_TAREAS).map((t) => t.id.length))
    for (const t of fanout.tareas.slice(0, MAX_TAREAS)) {
      const partes = [t.id.padEnd(ancho), t.estado.padEnd(10), t.modelo, t.paso, tiempoDeTarea(t, ahora)].filter((x): x is string => Boolean(x))
      filas.push({ texto: `  ${partes.join('  ').trimEnd()}`, tono: t.estado === 'pendiente' ? 'tenue' : tonoDe(t.estado) })
    }
    const resto = fanout.tareas.length - MAX_TAREAS
    if (resto > 0) filas.push({ texto: `  +${resto}`, tono: 'tenue' })
  }
  return maxFilas !== undefined && maxFilas >= 0 ? filas.slice(0, maxFilas) : filas
}
