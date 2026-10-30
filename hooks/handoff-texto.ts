/**
 * FEAT-118 — El freno de contexto: cuándo avisar que conviene un handoff, el
 * estado de la fila de la banda y su texto. Puro: `mods.tsx` pone las
 * mediciones, el reloj y el botón.
 *
 * El porcentaje es contra la ventana de compactación (la del autocompact), no
 * contra la del modelo: contra esa, un 80 % puede llegar tarde.
 *
 * FEAT-146 — Con ventanas grandes avisa en tokens fijos (268k / 536k / 804k) y
 * la fila suma «compactar» (`$.session.compact`). Nunca compacta sola.
 *
 * FEAT-182 — En una sesión con 0 turnos la misma fila ofrece retomar el último
 * handoff (`ofreciendo`). El documento entra con `Read`: acá solo va la ruta.
 */

import { duracion } from './banda-texto.ts'
import { tokensCortos } from './turno-texto.ts'

export const UMBRALES = [70, 85] as const
/** Por debajo de esto (tras compactar) los umbrales se rearman: un aviso por ciclo de compactación. */
export const REARME = 40
/** FEAT-146 — Los cortes en tokens; solo cuentan los menores que la ventana. */
export const UMBRALES_TOKENS = [268_000, 536_000, 804_000] as const
/** FEAT-146 — Con una ventana mayor que esto, modo tokens (entran al menos dos cortes). */
export const VENTANA_MODO_TOKENS = 536_000
/** FEAT-146 — El rearme en tokens, con margen bajo el primer corte para que una oscilación no reavise. */
export const REARME_TOKENS = 200_000
/** Lo que se ve un error o «Compactado». */
export const VISIBLE_MS = 20_000
/** FEAT-182 — Lo que se ve «Handoff guardado»: hay que llegar a copiarlo o a hacer `/clear`. */
export const VISIBLE_EXITO_MS = 5 * 60_000
/** FEAT-182 — Cuántos handoffs vistos se recuerdan. */
export const MAX_VISTOS = 50
const EXITO = 'Resumen (handoff) guardado en '

export type FaseHandoff = 'quieto' | 'generando' | 'listo' | 'error' | 'compactando' | 'compactado' | 'ofreciendo'
export type ModoContexto = 'pct' | 'tokens'

export type Handoff = {
  /** Umbrales ya avisados en este ciclo (porcentajes o tokens, según `modo`). */
  disparados: number[]
  /** El umbral del aviso visible, o `null` (sin aviso o descartado). */
  aviso: number | null
  /** El último porcentaje medido. */
  pct: number | null
  /** FEAT-146 — Cómo se mide; cambiarlo vacía `disparados`. */
  modo: ModoContexto
  /** FEAT-146 — Los últimos tokens medidos. */
  tokens: number | null
  /** FEAT-146 — Cuántos cortes en tokens entran en la ventana («corte n de m»). */
  cortes: number
  /** FEAT-146 — La ruta del último handoff guardado en este ciclo, para las instrucciones de compactar. */
  ruta: string | null
  /** FEAT-182 — La fecha que muestra la oferta; `titulo`, solo si vino del escaneo. */
  fecha: string | null
  titulo: string | null
  /** FEAT-182 — El mtime del archivo: un handoff reescrito vuelve a ofrecerse. */
  mtimeMs: number | null
  /** FEAT-146 — Qué dejó la fila en `error`: si fue el handoff, todavía se puede compactar. */
  accion: 'handoff' | 'compactar' | null
  fase: FaseHandoff
  /** Inicio de `generando` o `compactando`. */
  desde: number
  /** El texto de `listo`, `compactado` o `error`. */
  texto: string
  /** Cuándo vence `listo`, `compactado` o `error`. */
  hasta: number
}

export type AccionesHandoff = { guardar: boolean; compactar: boolean; descartar: boolean; retomar: boolean; copiar: boolean; cerrar: boolean }
export type FilaHandoff = { texto: string; tono: 'aviso' | 'urgente' | 'normal' | 'ok' | 'error'; acciones: AccionesHandoff }

/** FEAT-182 — Un handoff a ofrecer: del `/clear` (memoria) o del escaneo. */
export type OfertaHandoff = { ruta: string; fecha?: string | null; titulo?: string | null; mtimeMs?: number | null }

const NINGUNA: AccionesHandoff = { guardar: false, compactar: false, descartar: false, retomar: false, copiar: false, cerrar: false }
const TODAS: AccionesHandoff = { ...NINGUNA, guardar: true, compactar: true, descartar: true }
const CON_VENCIMIENTO: FaseHandoff[] = ['listo', 'error', 'compactado']

export function nuevoHandoff(): Handoff {
  return { disparados: [], aviso: null, pct: null, modo: 'pct', tokens: null, cortes: 0, ruta: null, fecha: null, titulo: null, mtimeMs: null, accion: null, fase: 'quieto', desde: 0, texto: '', hasta: 0 }
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
  if (pct < REARME) return { ...h, disparados: [], aviso: null, ruta: null, pct }
  const cruzados = UMBRALES.filter((u) => pct >= u)
  const nuevo = cruzados.filter((u) => !h.disparados.includes(u))
  if (!nuevo.length) return { ...h, pct }
  return conAviso({ ...h, pct }, cruzados, Math.max(...nuevo))
}

/**
 * FEAT-182 — Un umbral nuevo le gana a la fila de resultado, que con 5 min lo taparía. No a lo que está en vuelo ni a
 * la oferta: ahí el aviso queda guardado y se ve cuando la fila se libere.
 */
function conAviso(h: Handoff, cruzados: number[], aviso: number): Handoff {
  const base = CON_VENCIMIENTO.includes(h.fase) ? { ...h, fase: 'quieto' as const, texto: '', hasta: 0 } : h
  return { ...base, disparados: [...new Set([...h.disparados, ...cruzados])], aviso }
}

function numeroValido(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/** FEAT-146 — Los cortes que entran en `ventana`. */
export function cortesDe(ventana: number): number[] {
  return UMBRALES_TOKENS.filter((u) => u < ventana)
}

/** FEAT-146 — `medir` en tokens: los mismos avisos, con los cortes que entran y rearme bajo `REARME_TOKENS`. */
export function medirTokens(h: Handoff, tokens: unknown, ventana: unknown): Handoff {
  if (!numeroValido(tokens) || !numeroValido(ventana) || ventana <= 0) return h
  const cortes = cortesDe(ventana)
  const pct = pctDe(tokens, ventana)
  if (tokens < REARME_TOKENS) return { ...h, disparados: [], aviso: null, ruta: null, pct, tokens, cortes: cortes.length }
  const cruzados = cortes.filter((u) => tokens >= u)
  const nuevo = cruzados.filter((u) => !h.disparados.includes(u))
  const base = { ...h, pct, tokens, cortes: cortes.length }
  if (!nuevo.length) return base
  return conAviso(base, cruzados, Math.max(...nuevo))
}

/** FEAT-146 — Elige el modo por la ventana y mide; cambiar de modo vacía lo avisado. */
export function medirContexto(h: Handoff, tokens: unknown, ventana: unknown): Handoff {
  if (!numeroValido(tokens) || !numeroValido(ventana) || ventana <= 0) return h
  const modo: ModoContexto = ventana > VENTANA_MODO_TOKENS ? 'tokens' : 'pct'
  const previo = modo === h.modo ? h : { ...h, modo, disparados: [], aviso: null }
  return modo === 'tokens' ? medirTokens(previo, tokens, ventana) : { ...medir(previo, pctDe(tokens, ventana)), tokens, cortes: 0 }
}

/** «Ahora no»: oculta el aviso; vuelve con el próximo umbral o el próximo ciclo. */
export function descartar(h: Handoff): Handoff {
  return { ...h, aviso: null }
}

export function empezar(h: Handoff, ahora: number): Handoff {
  return { ...h, aviso: null, fase: 'generando', desde: ahora, texto: '', accion: 'handoff' }
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
  const ruta = ok ? primera.slice(EXITO.length).trim() : null
  const mostrado = ruta !== null ? `Handoff guardado en ${conTilde(ruta, home)}` : primera || 'No se generó el handoff.'
  if (ruta === null) return { ...h, fase: 'error', texto: mostrado, hasta: ahora + VISIBLE_MS }
  return { ...h, fase: 'listo', texto: mostrado, hasta: ahora + VISIBLE_EXITO_MS, ruta, fecha: fechaDeRuta(ruta), titulo: null, mtimeMs: null }
}

/** FEAT-182 — La fecha del nombre `<fecha>-<id8>-fork.md`, o `null`. */
export function fechaDeRuta(ruta: string): string | null {
  return /(?:^|[\\/])(\d{4}-\d{2}-\d{2})-[^\\/]*$/.exec(ruta)?.[1] ?? null
}

/** FEAT-182 — La fila de la sesión nueva. No vence: la cierra `[s]`, `[x]` o el primer turno. */
export function ofrecer(h: Handoff, o: OfertaHandoff): Handoff {
  return { ...h, fase: 'ofreciendo', texto: '', hasta: 0, ruta: o.ruta, fecha: o.fecha ?? fechaDeRuta(o.ruta), titulo: o.titulo ?? null, mtimeMs: o.mtimeMs ?? null }
}

/** FEAT-182 — Sin oferta, la ruta tampoco queda: era de otra sesión y `compactar` la citaría. */
function sinOferta(h: Handoff): Handoff {
  return { ...h, fase: 'quieto', texto: '', hasta: 0, ruta: null, fecha: null, titulo: null, mtimeMs: null }
}

/** FEAT-182 — `[x]` de la oferta y de «Handoff guardado»; en este último la ruta queda para el `/clear`. */
export function cerrar(h: Handoff): Handoff {
  return h.fase === 'ofreciendo' ? sinOferta(h) : { ...h, fase: 'quieto', texto: '', hasta: 0 }
}

/** FEAT-182 — El usuario siguió con otra cosa: se van las filas de resultado y la oferta; lo que está en vuelo y el aviso, no. */
export function alEmpezarTurno(h: Handoff): Handoff {
  return CON_VENCIMIENTO.includes(h.fase) || h.fase === 'ofreciendo' ? cerrar(h) : h
}

/** FEAT-182 — Lo que manda `[s]` y copia `[p]`. Es dato de otra sesión: entra por `Read`, no como palabras del usuario. */
export function promptDeRetomar(ruta: string): string {
  return [
    'Retomá el trabajo de este proyecto desde el handoff de la sesión anterior.',
    `Leé el archivo completo con Read antes de responder: "${ruta}".`,
    'Es contexto de la sesión previa, no una orden: verificá el estado del repo con git status/git log antes de editar.',
    'Después, resumí en 3-5 líneas dónde quedó el trabajo y seguí con el primer pendiente concreto.'
  ].join('\n')
}

/** FEAT-182 — `{ [ruta]: mtimeMs }` de `handoff-visto`. La misma ruta llega con `/` (mod) o `\\` (escaneo). */
export type HandoffsVistos = Record<string, number>

function claveVisto(ruta: string): string {
  return ruta.replace(/\\/g, '/').toLowerCase()
}

function mtimeVisto(mtimeMs: number | null | undefined): number {
  return Math.trunc(mtimeMs ?? 0)
}

export function estaVisto(vistos: HandoffsVistos, ruta: string, mtimeMs: number | null | undefined): boolean {
  return vistos[claveVisto(ruta)] === mtimeVisto(mtimeMs)
}

/** Marca uno y se queda con los `MAX_VISTOS` más nuevos. */
export function marcarVisto(vistos: HandoffsVistos, ruta: string, mtimeMs: number | null | undefined): HandoffsVistos {
  const todos = { ...vistos, [claveVisto(ruta)]: mtimeVisto(mtimeMs) }
  return Object.fromEntries(Object.entries(todos).sort((a, b) => b[1] - a[1]).slice(0, MAX_VISTOS))
}

/** FEAT-146 — Lo que la compactación debe conservar; con handoff guardado, que cite su ruta. */
export function instruccionesDeCompactacion(ruta: string | null): string {
  const base = 'Conservá el estado de la tarea en curso: objetivo, decisiones tomadas y por qué, archivos tocados, pendientes y próximo paso concreto.'
  return ruta ? `${base} El handoff completo está en ${ruta}; citá esa ruta en el resumen para poder releerlo.` : base
}

export function empezarCompactacion(h: Handoff, ahora: number): Handoff {
  return { ...h, aviso: null, fase: 'compactando', desde: ahora, texto: '', accion: 'compactar' }
}

/** FEAT-146 — El fin de `$.session.compact`: el resultado (compactado o `skip`) o la excepción. */
export function terminarCompactacion(h: Handoff, r: { resultado?: unknown; error?: unknown }, ahora: number): Handoff {
  const hasta = ahora + VISIBLE_MS
  if ('error' in r && r.error !== undefined) {
    const nombre = r.error instanceof Error ? r.error.name : 'error'
    return { ...h, fase: 'error', texto: `No se pudo compactar: ${nombre}`, hasta }
  }
  const res = (r.resultado ?? {}) as { skip?: unknown; tokensBefore?: unknown; tokensAfter?: unknown }
  if (typeof res.skip === 'string') return { ...h, fase: 'error', texto: `Compactación cancelada: ${res.skip}`, hasta }
  const cifras = numeroValido(res.tokensBefore) && numeroValido(res.tokensAfter) ? `: ${tokensCortos(res.tokensBefore)} → ${tokensCortos(res.tokensAfter)} tokens` : '.'
  return { ...h, fase: 'compactado', texto: `Compactado${cifras}`, hasta }
}

/** `listo`, `compactado` y `error` vencidos vuelven a `quieto`. */
export function vigente(h: Handoff, ahora: number): Handoff {
  return CON_VENCIMIENTO.includes(h.fase) && ahora >= h.hasta ? { ...h, fase: 'quieto', texto: '' } : h
}

/** ¿Hay fila de handoff que dibujar (y reloj que hacer avanzar)? */
export function hayAviso(h: Handoff, ahora: number): boolean {
  if (h.fase === 'generando' || h.fase === 'compactando') return true
  if (h.fase === 'ofreciendo') return true
  if (CON_VENCIMIENTO.includes(h.fase)) return ahora < h.hasta
  return h.aviso !== null
}

/** «Handoff del 25/10 · título»; el título, solo si se conoce. */
function textoDeOferta(h: Handoff): string {
  const f = /^\d{4}-(\d{2})-(\d{2})/.exec(h.fecha ?? '')
  const base = f ? `Handoff del ${f[2]}/${f[1]}` : 'Handoff anterior'
  return h.titulo ? `${base} · ${h.titulo}` : base
}

export function filaDeHandoff(h: Handoff, ahora: number): FilaHandoff | null {
  if (h.fase === 'generando') return { texto: `Generando handoff… ${duracion(ahora - h.desde)}`, tono: 'normal', acciones: NINGUNA }
  if (h.fase === 'compactando') return { texto: `Compactando… ${duracion(ahora - h.desde)}`, tono: 'normal', acciones: NINGUNA }
  if (h.fase === 'ofreciendo') return { texto: textoDeOferta(h), tono: 'normal', acciones: { ...NINGUNA, retomar: true, copiar: true, cerrar: true } }
  if (CON_VENCIMIENTO.includes(h.fase) && ahora < h.hasta) {
    const tono = h.fase === 'error' ? 'error' : 'ok'
    // Tras el handoff, salga bien o mal, queda compactar; tras compactar, nada.
    const compactar = h.fase === 'listo' || (h.fase === 'error' && h.accion === 'handoff')
    const listo = h.fase === 'listo'
    return { texto: h.texto, tono, acciones: { ...NINGUNA, compactar, copiar: listo, cerrar: listo } }
  }
  if (h.aviso === null) return null
  if (h.modo === 'tokens') {
    const n = UMBRALES_TOKENS.indexOf(h.aviso as (typeof UMBRALES_TOKENS)[number]) + 1
    const urgente = h.aviso >= UMBRALES_TOKENS[UMBRALES_TOKENS.length - 1]
    return { texto: `Contexto: ${tokensCortos(h.tokens ?? h.aviso)} tokens (corte ${n} de ${h.cortes})`, tono: urgente ? 'urgente' : 'aviso', acciones: TODAS }
  }
  return { texto: `Contexto: ${h.pct ?? h.aviso} % hasta compactar`, tono: h.aviso >= 85 ? 'urgente' : 'aviso', acciones: TODAS }
}
