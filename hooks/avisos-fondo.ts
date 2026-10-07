import type { FanoutPanel, CuotaPanel, VentanaCuota, MensajeBanda, LoteAviso } from '../types'

/**
 * FEAT-135 — Avisos de fondo: lo que termina o cambia mientras se mira otra
 * cosa (un fan-out, un lote, una cuota, un mensaje). Puro: cada fuente compara
 * su estado anterior con el nuevo y devuelve los avisos y el estado a guardar.
 *
 * Sin estado anterior (`undefined`) la vista es la línea de base: no avisa. Así
 * un reload del mod (las variables del módulo vuelven a cero) no repite nada.
 */

export type TipoAviso = 'fanout' | 'lotes' | 'cuota' | 'mensajes'
export const TIPOS_AVISO: TipoAviso[] = ['fanout', 'lotes', 'cuota', 'mensajes']
export type Aviso = { tipo: TipoAviso; texto: string; timeoutMs: number }
export type Resultado<E> = { avisos: Aviso[]; estado: E }

const FIN_MS = 8_000
const CUOTA_MS = 6_000
const TOPE_TEXTO = 60
const TOPE_RECORDADOS = 50

const dos = (n: number) => String(n).padStart(2, '0')
function hora(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${dos(d.getHours())}:${dos(d.getMinutes())}`
}

// ----------------------------------------------------------------- fan-out

export type EstadoFanout = { clave: string | null; terminado: boolean; avisados: string[] }

/** La corrida: el slug y el inicio de su primera tarea (un slug se reusa entre corridas). */
function claveDeFanout(f: FanoutPanel): string {
  return `${f.slug ?? '?'}|${f.tareas[0]?.inicio ?? ''}`
}

/** Un fan-out que pasa a terminado. `propia`: lo lanzó esta sesión y su resultado ya llega por la tool. */
export function avisosFanout(previo: EstadoFanout | undefined, f: FanoutPanel | null, propia: boolean): Resultado<EstadoFanout> {
  const clave = f ? claveDeFanout(f) : null
  const terminado = Boolean(f?.terminado)
  const avisados = previo?.avisados ?? []
  const estado: EstadoFanout = { clave, terminado, avisados }
  if (!f || !terminado || previo === undefined) {
    if (f && terminado) estado.avisados = [...avisados, clave as string].slice(-TOPE_RECORDADOS)
    return { avisos: [], estado }
  }
  if (avisados.includes(clave as string) || (previo.clave === clave && previo.terminado)) return { avisos: [], estado }
  estado.avisados = [...avisados, clave as string].slice(-TOPE_RECORDADOS)
  if (propia) return { avisos: [], estado }
  const total = f.tareas.length
  const ok = f.tareas.filter((t) => t.estado === 'ok').length
  const malas = total - ok
  const texto = `${malas ? '⚠️' : '✅'} Fan-out «${f.slug ?? '?'}»: ${ok}/${total} ok${malas ? ` · ${malas} con error` : ''}`
  return { avisos: [{ tipo: 'fanout', texto, timeoutMs: FIN_MS }], estado }
}

// ----------------------------------------------------------------- lotes

const LOTE_ACTIVO = new Set(['corriendo', 'verificando', 'auditando'])
// `descartado` e `integrado` los decide el usuario: no se avisan.
const LOTE_AVISABLE = new Set(['para revisar', 'fallido', 'interrumpido'])

export type EstadoLotes = Record<string, string>

const claveDeLote = (l: LoteAviso) => `${l.id}|${l.creado ?? ''}`

/** Un lote que sale de un estado activo, o uno nuevo que aparece ya terminado. */
export function avisosLotes(previo: EstadoLotes | undefined, lotes: LoteAviso[], propia: boolean): Resultado<EstadoLotes> {
  const estado: EstadoLotes = {}
  const avisos: Aviso[] = []
  for (const l of lotes) {
    const clave = claveDeLote(l)
    estado[clave] = l.estado
    if (previo === undefined || propia || !LOTE_AVISABLE.has(l.estado)) continue
    const antes = previo[clave]
    if (antes !== undefined && !LOTE_ACTIVO.has(antes)) continue
    const motor = l.motor ? ` (${l.motor})` : ''
    const icono = l.estado === 'para revisar' ? '📦' : '⚠️'
    avisos.push({ tipo: 'lotes', texto: `${icono} Lote «${l.id}»${motor}: ${l.estado} · ${l.listas}/${l.total} para revisar`, timeoutMs: FIN_MS })
  }
  return { avisos, estado }
}

// ----------------------------------------------------------------- cuota

// Claude avisa desde el 90 % (la propia, también el cruce); agy desde el 95 %.
const UMBRAL_CLAUDE = 0.9
const UMBRAL_AGY = 0.95
// Histéresis: bajo el umbral pero sobre esto, con la ventana vigente, sigue agotada.
const LIBRE = 0.8

export type EstadoCuota = { agotadas: Record<string, string | null>; cruces: string[] }

type Entrada = { nombre: string; texto: string; v: VentanaCuota; umbral: number }

function entradasDe(c: CuotaPanel | null): Entrada[] {
  const r: Entrada[] = []
  if (!c) return r
  for (const [g, v] of Object.entries(c.antigravity?.grupos ?? {})) r.push({ nombre: `agy ${g}`, texto: `agy «${g}»`, v, umbral: UMBRAL_AGY })
  if (c.claude) r.push({ nombre: 'claude', texto: 'claude', v: c.claude, umbral: UMBRAL_CLAUDE })
  for (const [cuenta, v] of Object.entries(c.claudePorCuenta ?? {})) r.push({ nombre: `claude@${cuenta}`, texto: `claude@${cuenta}`, v, umbral: UMBRAL_CLAUDE })
  return r
}

const vigente = (iso: string | null | undefined, ahora: number) => {
  const t = iso ? Date.parse(iso) : NaN
  return !Number.isFinite(t) || t > ahora
}

/**
 * Una cuota agotada que se libera (por todas las cuentas), y el cruce del 90 %
 * de la cuenta de esta sesión (`propia`, p. ej. `claude@trabajo`), una vez por
 * ventana. La liberación se decide con el reloj: el archivo no cambia hasta que
 * una sesión mida de nuevo, pero la ventana vence a su hora. Con la de 7 días
 * también agotada no hay liberación que avisar.
 */
export function avisosCuota(previo: EstadoCuota | undefined, c: CuotaPanel | null, ahora: number, propia: string | null): Resultado<EstadoCuota> {
  const agotadas: Record<string, string | null> = { ...(previo?.agotadas ?? {}) }
  const cruces = [...(previo?.cruces ?? [])]
  const avisos: Aviso[] = []
  for (const e of entradasDe(c)) {
    const p5 = e.v.ventana5h
    if (typeof p5 !== 'number') continue
    const reset = e.v.resetea5h ?? null
    const alta = p5 >= e.umbral && vigente(reset, ahora)
    const semana = typeof e.v.ventana7d === 'number' && e.v.ventana7d >= e.umbral && vigente(e.v.resetea7d, ahora)
    if (alta) {
      agotadas[e.nombre] = reset
      const cruce = `${e.nombre}|${reset ?? ''}`
      if (e.nombre === propia && !cruces.includes(cruce)) {
        cruces.push(cruce)
        const vuelve = hora(reset)
        if (previo !== undefined) avisos.push({ tipo: 'cuota', texto: `⚠️ ${e.texto} al ${Math.round(p5 * 100)} % (5 h)${vuelve ? ` · vuelve ${vuelve}` : ''}`, timeoutMs: CUOTA_MS })
      }
      continue
    }
    if (!(e.nombre in agotadas)) continue
    const libre = p5 < LIBRE || !vigente(reset, ahora) || !vigente(agotadas[e.nombre], ahora)
    if (!libre || semana) continue
    delete agotadas[e.nombre]
    if (previo !== undefined) {
      const texto = e.nombre.startsWith('agy ') ? `🔋 ${e.texto} disponible otra vez` : `🔋 ${e.texto}: ventana de 5 h liberada`
      avisos.push({ tipo: 'cuota', texto, timeoutMs: CUOTA_MS })
    }
  }
  return { avisos, estado: { agotadas, cruces: cruces.slice(-TOPE_RECORDADOS) } }
}

// ----------------------------------------------------------------- mensajes

export type EstadoMensajes = string[]

function recortar(texto: string): string {
  const t = texto.replace(/\s+/g, ' ').trim()
  return t.length > TOPE_TEXTO ? `${t.slice(0, TOPE_TEXTO - 1)}…` : t
}

/** Un mensaje nuevo en la banda (del teléfono o de otro agente) que todavía no se despachó. */
export function avisosMensajes(previo: EstadoMensajes | undefined, mensajes: MensajeBanda[], listos: string[], remitente: (m: MensajeBanda) => string): Resultado<EstadoMensajes> {
  const estado = mensajes.map((m) => m.id)
  if (previo === undefined) return { avisos: [], estado }
  const vistos = new Set(previo)
  const avisos = mensajes
    .filter((m) => !vistos.has(m.id) && !listos.includes(m.id))
    .map((m): Aviso => ({ tipo: 'mensajes', texto: `📨 ${remitente(m)}: «${recortar(m.texto)}»`, timeoutMs: FIN_MS }))
  return { avisos, estado }
}

// ----------------------------------------------------------------- filtro

/** `background_toasts` como lo devuelve `panel.js avisos`: una lista de tipos; lo desconocido se ignora. */
export function tiposDe(valor: unknown): Set<TipoAviso> {
  if (!Array.isArray(valor)) return new Set(TIPOS_AVISO)
  return new Set(valor.filter((x): x is TipoAviso => TIPOS_AVISO.includes(x as TipoAviso)))
}
