import type { FotoPanel, VentanaCuota } from '../types'

/**
 * FEAT-101 — La foto del panel en filas de texto, sin `$`: la dibuja el Pane y
 * la devuelve el comando `lagrange-panel`. Las cuotas guardan la fracción usada
 * (agy la invierte desde "% restante" en `cuota-agy.js`).
 */

const pct = (v: number | null | undefined) => (typeof v === 'number' ? `${Math.round(v * 100)} %` : '—')
const fecha = (s: string | null | undefined) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : null)

// BE-092 — Una ventana que ya pasó su reinicio no tiene porcentaje que valga, y
// cada fila dice de cuándo es el dato.
function hace(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`
}

function ventana(v: VentanaCuota, ahora: number, vistoEn: string | null | undefined): string {
  const valor = (frac: number | null, resetea: string | null | undefined) => {
    const r = fecha(resetea)
    return r !== null && ahora >= r ? 'reiniciada' : pct(frac)
  }
  const v5 = valor(v.ventana5h, v.resetea5h)
  const v7 = valor(v.ventana7d, v.resetea7d)
  const usado = v5.endsWith('%') || v7.endsWith('%') ? ' usado' : ''
  const visto = fecha(vistoEn)
  return `5 h ${v5} · semana ${v7}${usado}${visto !== null ? ` (visto hace ${hace(ahora - visto)})` : ''}`
}

export function filasDeFoto(f: FotoPanel | null, ahora: number): Array<{ titulo: string; filas: string[] }> {
  const fan = f?.fanout
  const fanout = fan
    ? [fan.linea ?? `fan-out ${fan.slug ?? ''}`, ...fan.tareas.map((t) => `  ${t.estado} · ${t.id}`)]
    : ['sin fan-out en curso']
  const c = f?.cuota
  const cuota: string[] = []
  if (c?.antigravity) for (const [g, v] of Object.entries(c.antigravity.grupos)) cuota.push(`agy ${g}: ${ventana(v, ahora, c.antigravity.vistoEn)}`)
  if (c?.claude) cuota.push(`claude: ${ventana(c.claude, ahora, c.claude.vistoEn)}`)
  if (c?.claudePorCuenta) for (const [cuenta, v] of Object.entries(c.claudePorCuenta)) cuota.push(`claude@${cuenta}: ${ventana(v, ahora, v.vistoEn)}`)
  const v = f?.versiones
  const versiones = v
    ? [
        `esta copia: ${v.propia ?? '?'}`,
        ...v.cuentas.map((x) => `${x.cuenta}${x.propia ? ' (esta sesión)' : ''}: ${x.version ?? x.estado}${x.desactualizada ? ' ⚠ desactualizada' : ''}`)
      ]
    : []
  return [
    { titulo: 'Fan-out', filas: fanout },
    { titulo: 'Cuota', filas: cuota.length ? cuota : ['sin datos'] },
    { titulo: 'Versiones', filas: versiones.length ? versiones : ['sin datos'] }
  ]
}

export function textoDeFoto(f: FotoPanel | null, ahora: number): string {
  return filasDeFoto(f, ahora).map((b) => [`**${b.titulo}**`, ...b.filas].join('\n')).join('\n\n')
}
