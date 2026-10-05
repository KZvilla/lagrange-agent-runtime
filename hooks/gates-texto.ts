/**
 * FEAT-114 — `/lagrange-gates`, sin `$`: leer lo que imprime `scripts/gates.mjs`
 * y armar la sección «Gates» del panel y su línea de resumen.
 *
 * El veredicto lo da el código de salida del proceso, nunca el texto: esto solo
 * cuenta las líneas para mostrar el avance. La cola de las rotas va al pane y
 * nunca a la línea de texto, que es la que lee el modelo en `/lagrange-panel`.
 */

import type { Bloque, Segmento } from './panel-texto.ts'
import { duracion } from './banda-texto.ts'

export type ModoGates = 'todas' | 'rápidas'

export type FinGates = {
  estado: 'ok' | 'rotas' | 'cortada' | 'detenida' | 'no-arranco'
  duracionMs: number
  code: number | null
}

export type CorridaGates = {
  modo: ModoGates
  desde: number
  /** Cuándo llegó la última línea PASS/FAIL: la puerta en curso arrancó ahí. */
  ultimaLinea: number
  puertas: Array<{ nombre: string; ok: boolean }>
  /** La línea `N/M puertas en verde` de gates.mjs, si llegó. */
  total: { verdes: number; total: number } | null
  /** Las últimas líneas de cada rota (lo que gates.mjs imprime tras `=== nombre (exit N) ===`). */
  cola: string[]
  enCola: boolean
  fin: FinGates | null
}

/** Una corrida se corta si pasa de esto; las puertas tardan ~6 min. */
export const PLAZO_GATES_MS = 20 * 60 * 1000

const MAX_COLA = 40
const MAX_LARGO_LINEA = 300

export function nuevaCorrida(modo: ModoGates, desde: number): CorridaGates {
  return { modo, desde, ultimaLinea: desde, puertas: [], total: null, cola: [], enCola: false, fin: null }
}

/** El argumento del comando: el modo, `detener` o inválido. */
export function leerArgGates(args: unknown): ModoGates | 'detener' | null {
  const a = String(args ?? '').trim().toLowerCase()
  if (a === '') return 'todas'
  if (a === 'quick') return 'rápidas'
  if (a === 'detener') return 'detener'
  return null
}

/** Aplica una línea completa de la salida de gates.mjs a la corrida. */
export function procesarLinea(c: CorridaGates, linea: string, ahora: number): void {
  const l = linea.replace(/\r$/, '')
  const m = /^(PASS|FAIL) {2}(.+)$/.exec(l)
  if (m && !c.enCola) {
    c.puertas.push({ nombre: m[2].trim(), ok: m[1] === 'PASS' })
    c.ultimaLinea = ahora
    return
  }
  const t = /^(\d+)\/(\d+) puertas en verde/.exec(l)
  if (t && !c.enCola) {
    c.total = { verdes: Number(t[1]), total: Number(t[2]) }
    return
  }
  if (/^=== .+ \(exit \d+\) ===$/.test(l)) c.enCola = true
  if (c.enCola && c.cola.length < MAX_COLA) c.cola.push(l.length > MAX_LARGO_LINEA ? `${l.slice(0, MAX_LARGO_LINEA)}…` : l)
}

/**
 * Parte un trozo en líneas completas: devuelve las líneas y el resto sin salto,
 * que se junta con el próximo trozo (spawn entrega lo que llega, no líneas).
 */
export function partirLineas(resto: string, trozo: string): { lineas: string[]; resto: string } {
  const todo = resto + trozo
  const partes = todo.split('\n')
  return { lineas: partes.slice(0, -1), resto: partes[partes.length - 1] }
}

/** El fin por código de salida: 0 es verde, cualquier otro o una señal (`null`) es rotas. */
export function finPorCodigo(code: number | null, desde: number, ahora: number): FinGates {
  return { estado: code === 0 ? 'ok' : 'rotas', duracionMs: Math.max(0, ahora - desde), code }
}

// La línea `N/M puertas en verde` de gates.mjs manda sobre lo contado: es su propio resumen.
function cuenta(c: CorridaGates): { verdes: number; total: number } {
  return c.total ?? { verdes: c.puertas.filter((p) => p.ok).length, total: c.puertas.length }
}

function resumen(c: CorridaGates): { texto: string; color?: string } | null {
  if (!c.fin) return null
  const { verdes, total } = cuenta(c)
  switch (c.fin.estado) {
    case 'ok': return { texto: `${verdes}/${total} en verde`, color: 'green' }
    case 'rotas': {
      const rotas = total - verdes
      // Manda el código: si el texto dice todo verde pero salió distinto de 0, se dice el código.
      return { texto: rotas > 0 ? `${verdes}/${total} · ${rotas} ${rotas === 1 ? 'rota' : 'rotas'}` : `${verdes}/${total} · salió con código ${c.fin.code ?? 'señal'}`, color: 'red' }
    }
    case 'cortada': return { texto: 'cortadas por plazo', color: 'red' }
    case 'detenida': return { texto: 'detenidas', color: 'yellow' }
    case 'no-arranco': return { texto: 'No se pudo lanzar gates.mjs', color: 'red' }
  }
}

/** La sección «Gates» del pane: avance, resumen y, si hubo rotas, su cola. */
export function bloqueDeGates(c: CorridaGates, ahora: number): Bloque {
  const filas: Segmento[][] = []
  const lleva = c.fin ? c.fin.duracionMs : ahora - c.desde
  filas.push([{ texto: `${c.modo} · ${duracion(lleva)}`, tenue: true }])
  for (const p of c.puertas) filas.push([{ texto: p.ok ? '✔ ' : '✘ ', color: p.ok ? 'green' : 'red' }, { texto: p.nombre }])
  if (!c.fin) filas.push([{ texto: `… puerta ${c.puertas.length + 1} · ${duracion(ahora - c.ultimaLinea)}`, tenue: true }])
  const r = resumen(c)
  if (r) filas.push([{ texto: r.texto, color: r.color, negrita: true }])
  if (c.fin && c.fin.estado !== 'ok') for (const l of c.cola) filas.push([{ texto: l, tenue: true }])
  return { titulo: 'Gates', filas }
}

/** El avance de una corrida en curso, para la respuesta del comando. */
export function avanceDeGates(c: CorridaGates, ahora: number): string {
  return `(${c.modo}): ${c.puertas.length} terminadas, ${duracion(ahora - c.desde)}`
}

/** Una sola línea, sin la cola: la que va al texto de `/lagrange-panel` y al toast. */
export function lineaDeGates(c: CorridaGates, ahora: number): string {
  if (!c.fin) return `corriendo (${c.modo}): ${c.puertas.length} terminadas, ${duracion(ahora - c.desde)}`
  return `${resumen(c)?.texto ?? ''} (${c.modo}) · ${duracion(c.fin.duracionMs)}`
}
