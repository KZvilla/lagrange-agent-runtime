import type { FotoPanel, VentanaCuota } from '../types'

/**
 * FEAT-101 — La foto del panel en filas de texto, sin `$`: la dibuja el Pane y
 * la devuelve el comando `lagrange-panel`. Las cuotas guardan la fracción usada
 * (agy la invierte desde "% restante" en `cuota-agy.js`).
 */

const pct = (v: number | null | undefined) => (typeof v === 'number' ? `${Math.round(v * 100)} %` : '—')
const ventana = (v: VentanaCuota) => `5 h ${pct(v.ventana5h)} · semana ${pct(v.ventana7d)} usado`

export function filasDeFoto(f: FotoPanel | null): Array<{ titulo: string; filas: string[] }> {
  const fan = f?.fanout
  const fanout = fan
    ? [fan.linea ?? `fan-out ${fan.slug ?? ''}`, ...fan.tareas.map((t) => `  ${t.estado} · ${t.id}`)]
    : ['sin fan-out en curso']
  const c = f?.cuota
  const cuota: string[] = []
  if (c?.antigravity) for (const [g, v] of Object.entries(c.antigravity.grupos)) cuota.push(`agy ${g}: ${ventana(v)}`)
  if (c?.claude) cuota.push(`claude: ${ventana(c.claude)}`)
  if (c?.claudePorCuenta) for (const [cuenta, v] of Object.entries(c.claudePorCuenta)) cuota.push(`claude@${cuenta}: ${ventana(v)}`)
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

export function textoDeFoto(f: FotoPanel | null): string {
  return filasDeFoto(f).map((b) => [`**${b.titulo}**`, ...b.filas].join('\n')).join('\n\n')
}
