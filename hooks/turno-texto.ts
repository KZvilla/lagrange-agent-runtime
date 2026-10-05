/**
 * FEAT-122 — La línea de tiempo del turno, sin `$`: qué se anota de cada tool
 * y de cada request, y cómo se dibuja (una tira por tool, el resumen por tipo
 * y la cabecera con tiempo, requests, tokens y costo).
 *
 * Solo el loop principal: la tool de un subagente no se cuenta aparte (su
 * tiempo es el de la tool `Agent` que lo lanzó). El costo es el del turno
 * entero (lo que sumó la sesión entre el inicio y el fin): repartirlo por tool
 * sería inventarlo.
 */
import { nombreCorto, duracion } from './banda-texto.ts'

// Locales: la línea de tiempo vive en una variable del mod (UI efímera), no en `$.state`.
export type ToolTurno = { nombre: string; desdeMs: number; duracionMs: number; error: boolean }
export type Tokens = { entrada: number; salida: number; cacheLeida: number; cacheEscrita: number }
export type TurnoCerrado = {
  turnId: string
  fin: number
  duracionMs: number
  interrumpido: boolean
  requests: number
  tokens: Tokens
  costo: number | null
  tools: ToolTurno[]
  extra: number
}

export const TOPE_TOOLS = 200
export const TOPE_FILAS = 25
export const TOPE_FILAS_PANEL = 8
export const TURNOS_GUARDADOS = 5
const ANCHO_BARRA = 40
const ANCHO_NOMBRE = 16

export type TurnoEnCurso = {
  turnId: string
  desde: number
  costoInicial: number | null
  tools: ToolTurno[]
  abiertas: Record<string, { nombre: string; desde: number }>
  extra: number
  requests: number
}

export function nuevoTurno(turnId: string, desde: number, costoInicial: number | null): TurnoEnCurso {
  return { turnId, desde, costoInicial, tools: [], abiertas: {}, extra: 0, requests: 0 }
}

export function abrirTool(t: TurnoEnCurso, clave: string, tool: string, ahora: number): void {
  t.abiertas[clave] = { nombre: nombreCorto(tool), desde: ahora }
}

export function cerrarTool(t: TurnoEnCurso, clave: string, ahora: number, error: boolean): void {
  const a = t.abiertas[clave]
  if (!a) return
  delete t.abiertas[clave]
  if (t.tools.length >= TOPE_TOOLS) { t.extra += 1; return }
  t.tools.push({ nombre: a.nombre, desdeMs: Math.max(0, a.desde - t.desde), duracionMs: Math.max(0, ahora - a.desde), error })
}

type Uso = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null | undefined

/** Solo cuenta: los tokens los trae sumados `turn.complete`. */
export function contarPaso(t: TurnoEnCurso): void {
  t.requests += 1
}

export function tokensDe(uso: Uso): Tokens {
  return {
    entrada: Number(uso?.input_tokens) || 0,
    salida: Number(uso?.output_tokens) || 0,
    cacheLeida: Number(uso?.cache_read_input_tokens) || 0,
    cacheEscrita: Number(uso?.cache_creation_input_tokens) || 0
  }
}

/** Cierra el turno: las tools que quedaron abiertas (interrumpidas) cuentan hasta el fin. */
export function cerrarTurno(t: TurnoEnCurso, { durationMs, interrumpido, costoFinal, ahora, uso }: { durationMs: number; interrumpido: boolean; costoFinal: number | null; ahora: number; uso: Uso }): TurnoCerrado {
  for (const clave of Object.keys(t.abiertas)) cerrarTool(t, clave, ahora, true)
  const costo = t.costoInicial !== null && costoFinal !== null ? Math.max(0, costoFinal - t.costoInicial) : null
  return { turnId: t.turnId, fin: ahora, duracionMs: Math.max(0, durationMs), interrumpido, requests: t.requests, tokens: tokensDe(uso), costo, tools: t.tools, extra: t.extra }
}

export function tokensCortos(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function cabecera(t: TurnoCerrado): string {
  const total = t.tokens.entrada + t.tokens.salida + t.tokens.cacheLeida + t.tokens.cacheEscrita
  const costo = t.costo === null ? '—' : `$${t.costo.toFixed(2).replace('.', ',')}`
  const req = `${t.requests} request${t.requests === 1 ? '' : 's'}`
  return `Turno de ${duracion(t.duracionMs)} · ${req} · ${tokensCortos(total)} tokens (cache ${tokensCortos(t.tokens.cacheLeida)}) · ${costo}${t.interrumpido ? ' (interrumpido)' : ''}`
}

/** `░░░████░░░`: dónde empezó y cuánto duró, sobre el largo del turno; al menos una celda. */
export function barra(desdeMs: number, duracionMs: number, totalMs: number, ancho = ANCHO_BARRA): string {
  const total = Math.max(1, totalMs)
  const ini = Math.min(ancho - 1, Math.floor((desdeMs / total) * ancho))
  const largo = Math.max(1, Math.min(ancho - ini, Math.round((duracionMs / total) * ancho)))
  return '░'.repeat(ini) + '█'.repeat(largo) + '░'.repeat(ancho - ini - largo)
}

export type FilaTira = { texto: string; error: boolean }

/** Una tira por tool en orden de inicio; con más de 25, las 25 más largas y `+N más`. */
export function tiras(t: TurnoCerrado, tope = TOPE_FILAS): FilaTira[] {
  const total = Math.max(t.duracionMs, ...t.tools.map((x) => x.desdeMs + x.duracionMs))
  let elegidas = t.tools
  let fuera: ToolTurno[] = []
  if (t.tools.length > tope) {
    const largas = new Set([...t.tools].sort((a, b) => b.duracionMs - a.duracionMs).slice(0, tope))
    elegidas = t.tools.filter((x) => largas.has(x))
    fuera = t.tools.filter((x) => !largas.has(x))
  }
  const filas = elegidas.map((x) => ({ texto: `${x.nombre.slice(0, ANCHO_NOMBRE).padEnd(ANCHO_NOMBRE)} ${barra(x.desdeMs, x.duracionMs, total)} ${duracion(x.duracionMs)}`, error: x.error }))
  const resto = fuera.length + t.extra
  if (resto > 0) filas.push({ texto: `+${resto} más (${duracion(fuera.reduce((s, x) => s + x.duracionMs, 0))}${t.extra ? ', sin detalle' : ''})`, error: false })
  return filas
}

/** `Bash ×7 · 41s`, por tiempo total. */
export function porTipo(t: TurnoCerrado): string[] {
  const m = new Map<string, { n: number; ms: number }>()
  for (const x of t.tools) {
    const v = m.get(x.nombre) ?? { n: 0, ms: 0 }
    v.n += 1
    v.ms += x.duracionMs
    m.set(x.nombre, v)
  }
  return [...m.entries()].sort((a, b) => b[1].ms - a[1].ms).map(([n, v]) => `${n} ×${v.n} · ${duracion(v.ms)}`)
}

/** Los anteriores, del más nuevo al más viejo, en una línea. */
export function anteriores(turnos: readonly TurnoCerrado[]): string {
  return turnos.slice(0, -1).reverse().map((x) => duracion(x.duracionMs)).join(' · ')
}

/** Lo que responde `/turno`. */
export function textoDeTurno(turnos: readonly TurnoCerrado[]): string {
  const t = turnos[turnos.length - 1]
  if (!t) return 'Todavía no hay turnos cerrados en esta sesión.'
  const previos = anteriores(turnos)
  return [cabecera(t), ...tiras(t).map((f) => (f.error ? `${f.texto} ✗` : f.texto)), '', `Por tipo: ${porTipo(t).join(' · ') || 'sin tools'}`, ...(previos ? [`Anteriores: ${previos}`] : [])].join(String.fromCharCode(10))
}
