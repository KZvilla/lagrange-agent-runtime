import { test, expect } from 'claude-code/testing'
import { pronostico, filasDeFoto } from '../hooks/panel-texto.ts'

/**
 * FEAT-124 — El pronóstico de cuota en las filas del panel (`hooks/panel-texto.ts`):
 * «· despeja HH:MM» con la ventana de más uso en ≥ 75 % y su reinicio por venir.
 */

const AHORA = Date.parse('2026-10-05T12:00:00Z')
const H = 60 * 60 * 1000
const v = (pct: number | null, resetea: number | null) => ({ celda: [], pct, resetea })
const hora = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const dia = (ms: number) => { const d = new Date(ms); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}` }

test('pronóstico: umbral 75, hora local o día, empate al reinicio más tardío', () => {
  expect(pronostico([v(74, AHORA + H), v(10, AHORA + 100 * H)], AHORA)).toBe(null)
  const p = pronostico([v(75, AHORA + 2 * H), v(10, AHORA + 100 * H)], AHORA)
  expect(p).toEqual({ texto: `  · despeja ${hora(AHORA + 2 * H)}`, color: '#ff8700' })
  expect(pronostico([v(20, AHORA + 2 * H), v(92, AHORA + 50 * H)], AHORA)).toEqual({ texto: `  · despeja el ${dia(AHORA + 50 * H)}`, color: 'red' })
  // Empate: recién se despeja cuando se renuevan las dos.
  expect(pronostico([v(80, AHORA + 2 * H), v(80, AHORA + 5 * H)], AHORA)?.texto).toBe(`  · despeja ${hora(AHORA + 5 * H)}`)
  // Reiniciada o sin dato: nada; el reinicio pasado tampoco cuenta.
  expect(pronostico([v(null, null), v(null, null)], AHORA)).toBe(null)
  expect(pronostico([v(95, AHORA - H), v(10, AHORA + H)], AHORA)).toBe(null)
  // La ventana que decide el punto (92 %) sin reinicio conocido: no se pronostica con la otra (80 %).
  expect(pronostico([v(92, null), v(80, AHORA + 2 * H)], AHORA)).toBe(null)
})

test('en el panel: la fila con uso alto lo suma; el dato viejo con reinicio futuro también', () => {
  const foto = {
    fanout: null,
    versiones: null,
    cuota: {
      antigravity: {
        vistoEn: new Date(AHORA - 10 * H).toISOString(),
        grupos: {
          gemini: { ventana5h: 0.82, ventana7d: 0.62, resetea5h: new Date(AHORA + 2 * H).toISOString(), resetea7d: new Date(AHORA + 40 * H).toISOString() },
          claude_gpt: { ventana5h: 0.1, ventana7d: 0.1, resetea5h: new Date(AHORA + 2 * H).toISOString(), resetea7d: new Date(AHORA + 40 * H).toISOString() }
        }
      },
      claude: null,
      claudePorCuenta: null
    }
  }
  const cuota = filasDeFoto(foto as never, AHORA).find((b) => b.titulo === 'Cuota')!
  const textos = cuota.filas.map((f) => f.map((x) => x.texto).join(''))
  expect(textos[0]).toContain('(visto hace 10 h)')
  expect(textos[0].endsWith(`  · despeja ${hora(AHORA + 2 * H)}`)).toBe(true)
  expect(textos[1]).not.toContain('despeja')
})
