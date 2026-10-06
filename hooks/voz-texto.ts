/**
 * FEAT-119 + FEAT-120 — La voz en la terminal, sin `$`: qué dice el spinner
 * mientras suena una voz y qué frase va en la banda.
 *
 * El MCP escribe `buzones/<sesion>.voz` justo antes de reproducir y lo borra
 * al terminar (`mcp-server/lib/voz-en-curso.js`). Acá solo se lee: el texto es
 * lo que se está diciendo en voz alta, ya saneado por el MCP; igual se le
 * quitan los caracteres de control antes de dibujarlo. Nunca llega al modelo.
 */

export type VozEnCurso = { voz: string; texto: string; desde: number; duracionMs: number; hasta: number }

const CONTROLES = /\u001b\[[0-9;?]*[ -\/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const MAX_VOZ = 40
const MAX_TEXTO = 8000
export const MAX_FRASE = 140

const limpio = (v: unknown, tope: number) => String(v ?? '').replace(CONTROLES, '').trim().slice(0, tope)

/** Del JSON crudo del `.voz` a algo dibujable; `null` si no sirve o ya venció. */
export function leerVoz(crudo: string | null | undefined, ahora: number): VozEnCurso | null {
  if (!crudo) return null
  let j: Record<string, unknown>
  try { j = JSON.parse(crudo) } catch { return null }
  if (!j || typeof j !== 'object') return null
  const desde = Number(j.desde)
  const duracionMs = Number(j.duracionMs)
  const hasta = Number(j.hasta)
  if (![desde, duracionMs, hasta].every(Number.isFinite) || duracionMs <= 0 || hasta < ahora) return null
  const texto = limpio(j.texto, MAX_TEXTO)
  if (!texto) return null
  return { voz: limpio(j.voz, MAX_VOZ) || 'La voz', texto, desde, duracionMs, hasta }
}

/** FEAT-119 — El `message` del spinner, o `null` para dejar el del motor. */
export function mensajeDeVoz(enCurso: boolean, voz: VozEnCurso | null): string | null {
  if (voz) return `🔊 ${voz.voz} está hablando`
  return enCurso ? '🎙 preparando la voz' : null
}

/** Corta una frase larga por la última coma o espacio antes del tope. */
function partir(frase: string): string[] {
  const out: string[] = []
  let resto = frase
  while (resto.length > MAX_FRASE) {
    const ventana = resto.slice(0, MAX_FRASE)
    const coma = ventana.lastIndexOf(',')
    const espacio = ventana.lastIndexOf(' ')
    const corte = coma > MAX_FRASE / 2 ? coma + 1 : espacio > MAX_FRASE / 2 ? espacio : MAX_FRASE
    out.push(resto.slice(0, corte).trim())
    resto = resto.slice(corte).trim()
  }
  if (resto) out.push(resto)
  return out
}

/** FEAT-120 — Las frases del texto: por `.`, `!`, `?`, `…` y saltos de línea; ninguna pasa de MAX_FRASE. */
export function frases(texto: string): string[] {
  const crudas = texto.split(/(?<=[.!?…])\s+|\n+/).map((f) => f.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return crudas.flatMap(partir)
}

/** FEAT-120 — El índice de la frase que suena: cada frase pesa por sus caracteres sobre la duración. */
export function fraseEn(lista: readonly string[], transcurridoMs: number, duracionMs: number): number {
  if (!lista.length) return -1
  const total = lista.reduce((n, f) => n + f.length, 0)
  const avance = Math.min(1, Math.max(0, transcurridoMs / duracionMs)) * total
  let acumulado = 0
  for (let i = 0; i < lista.length; i++) {
    acumulado += lista[i].length
    if (avance < acumulado) return i
  }
  return lista.length - 1
}

/** FEAT-120 — La fila de la banda. */
export function filaDeSubtitulo(voz: VozEnCurso, frase: string): string {
  return `🔊 ${voz.voz}: «${frase}»`
}

const TOOL_VOZ = /^mcp__[^_].*__(say|narrate)$/

/** `say`/`narrate` de un MCP de Lagrange (instalado o de desarrollo). */
export function esToolDeVoz(nombre: unknown): boolean {
  return typeof nombre === 'string' && TOOL_VOZ.test(nombre)
}
