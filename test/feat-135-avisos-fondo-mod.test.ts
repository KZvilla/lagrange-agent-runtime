import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { CuotaPanel, FanoutPanel, LoteAviso, MensajeBanda } from '../types'
import { avisosFanout, avisosLotes, avisosCuota, avisosMensajes, tiposDe } from '../hooks/avisos-fondo.ts'

/**
 * FEAT-135 — Avisos de fondo: la lógica pura (`hooks/avisos-fondo.ts`) y el
 * cableado en `hooks/mods.tsx` con el mundo simulado (`panel.js avisos`,
 * `panel.js fanout`, la carpeta de worktrees y el reloj).
 */

const AHORA = Date.parse('2026-10-07T18:00:00Z')
const EN_1H = '2026-10-07T19:00:00Z'
const HACE_1M = '2026-10-07T17:59:00Z'

const fan = (terminado: boolean, estados = ['ok', 'ok']): FanoutPanel => ({
  slug: 'demo', linea: 'x', terminado, tareas: estados.map((estado, i) => ({ id: `t${i}`, estado, inicio: '2026-10-07T17:00:00Z' }))
})
const lote = (estado: string, extra: Partial<LoteAviso> = {}): LoteAviso => ({ id: 'L1', motor: null, estado, creado: '2026-10-07T17:00:00Z', total: 3, listas: 2, ...extra })
const cuota = (p5: number, reset = EN_1H, extra: Partial<CuotaPanel> = {}): CuotaPanel => ({
  antigravity: null, claude: null, claudePorCuenta: { trabajo: { ventana5h: p5, ventana7d: 0.3, resetea5h: reset, resetea7d: '2026-10-09T00:00:00Z' } }, ...extra
})
const msg = (id: string, texto = 'hola'): MensajeBanda => ({ id, seq: 1, de: { nodo: 'local', nombre: 'Cris' }, respuestaA: null, creado: null, texto })
const quien = (m: MensajeBanda) => m.de.nombre

// ----------------------------------------------------------------- puro

test('fan-out: la línea de base no avisa; terminar avisa una vez; lo propio no avisa', () => {
  const base = avisosFanout(undefined, fan(false), false)
  expect(base.avisos).toEqual([])
  const fin = avisosFanout(base.estado, fan(true, ['ok', 'error']), false)
  expect(fin.avisos.map((a) => a.texto)).toEqual(['⚠️ Fan-out «demo»: 1/2 ok · 1 con error'])
  expect(avisosFanout(fin.estado, fan(true, ['ok', 'error']), false).avisos).toEqual([])
  // Desaparece y vuelve el mismo terminado: ya se avisó.
  const sinFan = avisosFanout(fin.estado, null, false)
  expect(avisosFanout(sinFan.estado, fan(true, ['ok', 'error']), false).avisos).toEqual([])
  expect(avisosFanout(base.estado, fan(true), true).avisos).toEqual([])
  expect(avisosFanout(base.estado, fan(true), false).avisos[0].texto).toBe('✅ Fan-out «demo»: 2/2 ok')
  // Ya terminado en la línea de base: no avisa nunca.
  const yaTerminado = avisosFanout(undefined, fan(true), false)
  expect(avisosFanout(yaTerminado.estado, fan(true), false).avisos).toEqual([])
})

test('lotes: de activo a final avisa; descartado e integrado no; uno nuevo ya terminado sí', () => {
  const base = avisosLotes(undefined, [lote('corriendo')], false)
  expect(base.avisos).toEqual([])
  const fin = avisosLotes(base.estado, [lote('para revisar', { motor: 'claude@trabajo' })], false)
  expect(fin.avisos.map((a) => a.texto)).toEqual(['📦 Lote «L1» (claude@trabajo): para revisar · 2/3 para revisar'])
  expect(avisosLotes(fin.estado, [lote('para revisar')], false).avisos).toEqual([])
  expect(avisosLotes(fin.estado, [lote('descartado')], false).avisos).toEqual([])
  expect(avisosLotes(base.estado, [lote('fallido')], false).avisos[0].texto).toContain('⚠️ Lote «L1»: fallido')
  expect(avisosLotes(base.estado, [lote('para revisar')], true).avisos).toEqual([])
  const nuevo = lote('interrumpido', { id: 'L2', creado: '2026-10-07T17:30:00Z' })
  expect(avisosLotes(base.estado, [lote('corriendo'), nuevo], false).avisos.length).toBe(1)
  // Un archivo apartado con el mismo id (otro `creado`) no se confunde.
  expect(avisosLotes(base.estado, [lote('corriendo'), lote('descartado', { creado: '2026-09-01T00:00:00Z' })], false).avisos).toEqual([])
})

test('cuota: la propia avisa el cruce del 90 % una vez por ventana; la liberación, por reloj', () => {
  const base = avisosCuota(undefined, cuota(0.5), AHORA, 'claude@trabajo')
  expect(base.avisos).toEqual([])
  const cruce = avisosCuota(base.estado, cuota(0.91), AHORA, 'claude@trabajo')
  expect(cruce.avisos.length).toBe(1)
  expect(cruce.avisos[0].texto).toMatch(/^⚠️ claude@trabajo al 91 % \(5 h\) · vuelve \d\d:\d\d$/)
  // Oscila: ni otro cruce ni una liberación falsa.
  const baja = avisosCuota(cruce.estado, cuota(0.86), AHORA, 'claude@trabajo')
  expect(baja.avisos).toEqual([])
  const sube = avisosCuota(baja.estado, cuota(0.93), AHORA, 'claude@trabajo')
  expect(sube.avisos).toEqual([])
  // El archivo no cambió, pero la ventana venció.
  const libre = avisosCuota(sube.estado, cuota(0.93), Date.parse(EN_1H) + 1000, 'claude@trabajo')
  expect(libre.avisos.map((a) => a.texto)).toEqual(['🔋 claude@trabajo: ventana de 5 h liberada'])
  expect(avisosCuota(libre.estado, cuota(0.93), Date.parse(EN_1H) + 61_000, 'claude@trabajo').avisos).toEqual([])
})

test('cuota: otra cuenta y agy solo avisan la liberación; con la de 7 días agotada, nada', () => {
  const otra = avisosCuota(avisosCuota(undefined, cuota(0.2), AHORA, 'claude').estado, cuota(0.95), AHORA, 'claude')
  expect(otra.avisos).toEqual([])
  expect(avisosCuota(otra.estado, cuota(0.1, EN_1H), AHORA, 'claude').avisos.map((a) => a.texto)).toEqual(['🔋 claude@trabajo: ventana de 5 h liberada'])
  const agy = (p: number): CuotaPanel => ({ antigravity: { grupos: { gemini: { ventana5h: p, ventana7d: 0.1, resetea5h: EN_1H } }, vistoEn: null }, claude: null, claudePorCuenta: null })
  const agotada = avisosCuota(avisosCuota(undefined, agy(0.5), AHORA, null).estado, agy(0.96), AHORA, null)
  expect(agotada.avisos).toEqual([])
  expect(avisosCuota(agotada.estado, agy(0.92), AHORA, null).avisos).toEqual([])
  expect(avisosCuota(agotada.estado, agy(0.2), AHORA, null).avisos.map((a) => a.texto)).toEqual(['🔋 agy «gemini» disponible otra vez'])
  const semana = (p: number): CuotaPanel => ({ antigravity: null, claude: { ventana5h: p, ventana7d: 0.97, resetea5h: EN_1H, resetea7d: '2026-10-09T00:00:00Z' }, claudePorCuenta: null })
  const s1 = avisosCuota(undefined, semana(0.95), AHORA, null)
  expect(avisosCuota(s1.estado, semana(0.95), Date.parse(EN_1H) + 1000, null).avisos).toEqual([])
  // Una ventana ya vencida en la línea de base no se cuenta como agotada.
  const vieja = avisosCuota(undefined, cuota(0.99, HACE_1M), AHORA, 'claude@trabajo')
  expect(avisosCuota(vieja.estado, cuota(0.99, HACE_1M), AHORA + 60_000, 'claude@trabajo').avisos).toEqual([])
})

test('mensajes: los nuevos sin despachar avisan, recortados; la línea de base no', () => {
  const base = avisosMensajes(undefined, [msg('a')], [], quien)
  expect(base.avisos).toEqual([])
  const largo = 'una línea\nmuy   larga '.repeat(10)
  const r = avisosMensajes(base.estado, [msg('a'), msg('b', largo), msg('c')], ['c'], quien)
  expect(r.avisos.length).toBe(1)
  expect(r.avisos[0].texto.startsWith('📨 Cris: «una línea muy larga una línea')).toBe(true)
  expect(r.avisos[0].texto.endsWith('…»')).toBe(true)
  expect(r.avisos[0].texto.includes('\n')).toBe(false)
})

test('tipos: lista conocida, sin dato todos', () => {
  expect([...tiposDe(['lotes', 'x'])]).toEqual(['lotes'])
  expect([...tiposDe([])]).toEqual([])
  expect(tiposDe(null).size).toBe(4)
})

// ----------------------------------------------------------------- mod

const RUN = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Mundo = { lotes: LoteAviso[]; cuota: CuotaPanel | null; tipos?: string[]; archivos: Array<{ name: string; mtimeMs: number }>; fanout: FanoutPanel | null }

function simular(on: On, mundo: Mundo) {
  const visto = { toasts: [] as string[], avisos: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const script = String(e.argv[1])
    if (script.endsWith('buzon.js')) return RUN(JSON.stringify({ sesion: null }))
    if (script.endsWith('metas.js')) return RUN(JSON.stringify({ ok: true, metas: [], transiciones: [] }))
    const modo = String(e.argv[2])
    if (modo === 'red') return RUN(JSON.stringify({ red: null }))
    if (modo === 'avisos') { visto.avisos++; return RUN(JSON.stringify({ lotes: mundo.lotes, cuota: mundo.cuota, propia: 'claude@trabajo', tipos: mundo.tipos ?? ['fanout', 'lotes', 'cuota', 'mensajes'] })) }
    return RUN(JSON.stringify({ fanout: mundo.fanout }))
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: mundo.archivos.map((a) => ({ ...a, kind: 'file' as const, size: 1, isLink: false })) }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { visto.toasts.push(e.text); return { value: undefined } })
  return visto
}

const FANOUT = 'mcp__plugin_lagrange_lagrange__agy_fanout'
const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }

test('mod: un lote de otra sesión que termina avisa; con background_toasts sin lotes, no', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const mundo: Mundo = { lotes: [lote('corriendo')], cuota: null, archivos: [], fanout: null }
  const visto = simular(on, mundo)
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(21_000)
  expect(visto.avisos).toBe(1)
  expect(visto.toasts).toEqual([])
  mundo.lotes = [lote('para revisar')]
  await reloj.advance(60_000)
  expect(visto.toasts).toEqual(['📦 Lote «L1»: para revisar · 2/3 para revisar'])
  mundo.tipos = ['cuota']
  mundo.lotes = [lote('para revisar'), lote('corriendo', { id: 'L2' })]
  await reloj.advance(60_000)
  mundo.lotes = [lote('para revisar'), lote('fallido', { id: 'L2' })]
  await reloj.advance(60_000)
  expect(visto.toasts.length).toBe(1)
})

test('mod: la cuota propia cruza el 90 % y después se libera', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const mundo: Mundo = { lotes: [], cuota: cuota(0.5), archivos: [], fanout: null }
  const visto = simular(on, mundo)
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(21_000)
  mundo.cuota = cuota(0.92)
  await reloj.advance(60_000)
  expect(visto.toasts.length).toBe(1)
  expect(visto.toasts[0]).toContain('⚠️ claude@trabajo al 92 %')
  await reloj.advance(60 * 60_000)
  expect(visto.toasts.at(-1)).toBe('🔋 claude@trabajo: ventana de 5 h liberada')
  expect(visto.toasts.length).toBe(2)
})

test('mod: un fan-out que termina avisa; si esta sesión lo está esperando, no', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const mundo: Mundo = { lotes: [], cuota: null, archivos: [{ name: '.fanout-status-demo.json', mtimeMs: AHORA - 1000 }], fanout: fan(false) }
  const visto = simular(on, mundo)
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(21_000)
  mundo.fanout = fan(true)
  mundo.archivos = [{ name: '.fanout-status-demo.json', mtimeMs: AHORA + 22_000 }]
  await reloj.advance(5_000)
  expect(visto.toasts).toEqual(['✅ Fan-out «demo»: 2/2 ok'])
})

test('mod: con una llamada agy_fanout en curso, su fin no avisa (ni al rato de cerrarse)', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const mundo: Mundo = { lotes: [], cuota: null, archivos: [{ name: '.fanout-status-demo.json', mtimeMs: AHORA - 1000 }], fanout: fan(false) }
  const visto = simular(on, mundo)
  let terminar: (r: unknown) => void = () => {}
  on('tool.call', { tool: FANOUT } as never, () => new Promise((resolve) => { terminar = resolve }) as never)
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(21_000)
  const llamada = $.tool.call({ tool: FANOUT, tasks: [] } as never)
  await reloj.settle()
  terminar({ result: 'ok', text: 'listo' })
  await llamada
  mundo.fanout = fan(true)
  mundo.archivos = [{ name: '.fanout-status-demo.json', mtimeMs: AHORA + 22_000 }]
  await reloj.advance(5_000)
  await reloj.advance(5_000)
  expect(visto.toasts).toEqual([])
})
