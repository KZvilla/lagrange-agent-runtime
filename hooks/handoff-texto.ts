/**
 * FEAT-118 — El freno de contexto: cuándo avisar que conviene un handoff, el
 * estado de la fila de la banda y su texto. Puro: `mods.tsx` pone las
 * mediciones, el reloj y el botón.
 *
 * El porcentaje es contra la ventana de compactación (la del autocompact), no
 * contra la del modelo: contra esa, un 80 % puede llegar tarde.
 */

import { duracion } from './banda-texto.ts'

export const UMBRALES = [70, 85] as const
/** Por debajo de esto (tras compactar) los umbrales se rearman: un aviso por ciclo de compactación. */
export const REARME = 40
/** Lo que se ve «Handoff guardado» o el error. */
export const VISIBLE_MS = 20_000
const EXITO = 'Resumen (handoff) guardado en '

export type FaseHandoff = 'quieto' | 'generando' | 'listo' | 'error'

export type Handoff = {
  /** Umbrales ya avisados en este ciclo. */
  disparados: number[]
  /** El umbral del aviso visible, o `null` (sin aviso o descartado). */
  aviso: number | null
  /** El último porcentaje medido. */
  pct: number | null
  fase: FaseHandoff
  /** Inicio de `generando`. */
  desde: number
  /** El texto de `listo` o `error`. */
  texto: string
  /** Cuándo vence `listo` o `error`. */
  hasta: number
}

export type FilaHandoff = { texto: string; tono: 'aviso' | 'urgente' | 'normal' | 'ok' | 'error'; botones: boolean }

export function nuevoHandoff(): Handoff {
  return { disparados: [], aviso: null, pct: null, fase: 'quieto', desde: 0, texto: '', hasta: 0 }
}

/** Porcentaje entero de `tokens` sobre `ventana`, o `null` sin datos. */
export function pctDe(tokens: unknown, ventana: unknown): number | null {
  if (typeof tokens !== 'number' || typeof ventana !== 'number' || !Number.isFinite(tokens) || !Number.isFinite(ventana) || tokens < 0 || ventana <= 0) return null
  return Math.round((tokens / ventana) * 100)
}

/**
 * Una medición nueva. Cruzar un umbral no avisado lo avisa (el más alto
 * cruzado, marcando también los de abajo); bajar de `REARME` rearma todo y
 * quita el aviso. Nada más cambia.
 */
export function medir(h: Handoff, pct: number | null): Handoff {
  if (pct === null) return h
  if (pct < REARME) return { ...h, disparados: [], aviso: null, pct }
  const cruzados = UMBRALES.filter((u) => pct >= u)
  const nuevo = cruzados.filter((u) => !h.disparados.includes(u))
  if (!nuevo.length) return { ...h, pct }
  return { ...h, pct, disparados: [...new Set([...h.disparados, ...cruzados])], aviso: Math.max(...nuevo) }
}

/** «Ahora no»: oculta el aviso; vuelve con el próximo umbral o el próximo ciclo. */
export function descartar(h: Handoff): Handoff {
  return { ...h, aviso: null }
}

export function empezar(h: Handoff, ahora: number): Handoff {
  return { ...h, aviso: null, fase: 'generando', desde: ahora, texto: '' }
}

/** `~` en lugar del home, para que la fila no muestre la carpeta del usuario entera. */
export function conTilde(ruta: string, home: string): string {
  const r = ruta.replace(/\\/g, '/')
  const h = home.replace(/\\/g, '/').replace(/\/+$/, '')
  return h && r.toLowerCase().startsWith(h.toLowerCase() + '/') ? '~' + r.slice(h.length) : r
}

/** El fin de `/lagrange-resumen handoff si`: de su texto, solo la primera línea (el pie de costo no va). */
export function terminar(h: Handoff, texto: string, ahora: number, home: string): Handoff {
  const primera = String(texto ?? '').split(/\r?\n/)[0].trim()
  const ok = primera.startsWith(EXITO)
  const mostrado = ok ? `Handoff guardado en ${conTilde(primera.slice(EXITO.length).trim(), home)}` : primera || 'No se generó el handoff.'
  return { ...h, fase: ok ? 'listo' : 'error', texto: mostrado, hasta: ahora + VISIBLE_MS }
}

/** `listo` y `error` vencidos vuelven a `quieto`. */
export function vigente(h: Handoff, ahora: number): Handoff {
  return (h.fase === 'listo' || h.fase === 'error') && ahora >= h.hasta ? { ...h, fase: 'quieto', texto: '' } : h
}

/** ¿Hay fila de handoff que dibujar (y reloj que hacer avanzar)? */
export function hayAviso(h: Handoff, ahora: number): boolean {
  if (h.fase === 'generando') return true
  if (h.fase === 'listo' || h.fase === 'error') return ahora < h.hasta
  return h.aviso !== null
}

export function filaDeHandoff(h: Handoff, ahora: number): FilaHandoff | null {
  if (h.fase === 'generando') return { texto: `Generando handoff… ${duracion(ahora - h.desde)}`, tono: 'normal', botones: false }
  if ((h.fase === 'listo' || h.fase === 'error') && ahora < h.hasta) return { texto: h.texto, tono: h.fase === 'listo' ? 'ok' : 'error', botones: false }
  if (h.aviso === null) return null
  return { texto: `Contexto: ${h.pct ?? h.aviso} % hasta compactar`, tono: h.aviso >= 85 ? 'urgente' : 'aviso', botones: true }
}
