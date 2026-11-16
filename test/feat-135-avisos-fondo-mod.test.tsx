import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { CuotaPanel, FanoutPanel, LoteAviso, MensajeBanda, InformeBanda } from '../types'
import { avisosFanout, avisosLotes, avisosCuota, avisosMensajes, avisosInformes, tiposDe } from '../hooks/avisos-fondo.ts'

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

test('informes: la línea de base no avisa; un informe estable nuevo avisa una sola vez', () => {
  const inf = (id: string, extra: Partial<InformeBanda> = {}): InformeBanda => ({
    id, tipo: 'audit', modo: 'plan', veredicto: 'PASS', propio: false, ...extra
  })
  const base = avisosInformes(undefined, [inf('aaaaaa')])
  expect(base.avisos).toEqual([])
  const nuevo = avisosInformes(base.estado, [inf('aaaaaa'), inf('bbbbbb', { tipo: 'review', veredicto: null })])
  expect(nuevo.avisos.map((a) => a.texto)).toEqual(['📋 Informe bbbbbb listo (review)'])
  expect(avisosInformes(nuevo.estado, [inf('aaaaaa'), inf('bbbbbb', { tipo: 'review', veredicto: null })]).avisos).toEqual([])
})

test('tipos: lista conocida, sin dato todos', () => {
  expect([...tiposDe(['lotes', 'x'])]).toEqual(['lotes'])
  expect([...tiposDe([])]).toEqual([])
  expect(tiposDe(null).size).toBe(5)
})

// ----------------------------------------------------------------- mod

const RUN = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Mundo = { lotes: LoteAviso[]; cuota: CuotaPanel | null; tipos?: string[]; archivos: Array<{ name: string; mtimeMs: number }>; fanout: FanoutPanel | null; informes?: InformeBanda[]; env?: Record<string, string | undefined>; files?: Record<string, { content: string; mtimeMs: number }> }

function simular(on: On, mundo: Mundo) {
  const visto = { toasts: [] as string[], avisos: 0, avisosArgvs: [] as unknown[][], prompts: [] as string[], buzonCmds: [] as unknown[][] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const script = String(e.argv[1])
    if (script.endsWith('buzon.js')) {
      visto.buzonCmds.push(e.argv)
      return RUN(JSON.stringify({ sesion: null }))
    }
    if (script.endsWith('metas.js')) return RUN(JSON.stringify({ ok: true, metas: [], transiciones: [] }))
    const modo = String(e.argv[2])
    if (modo === 'red') return RUN(JSON.stringify({ red: null }))
    if (modo === 'avisos') {
      visto.avisos++
      visto.avisosArgvs.push(e.argv)
      return RUN(JSON.stringify({ lotes: mundo.lotes, cuota: mundo.cuota, propia: 'claude@trabajo', tipos: mundo.tipos ?? ['fanout', 'lotes', 'cuota', 'mensajes', 'informes'], informes: mundo.informes ?? [] }))
    }
    return RUN(JSON.stringify({ fanout: mundo.fanout }))
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('env.get', ($, e) => ({ value: mundo.env?.[e.name] }))
  on('fs.stat', ($, e) => {
    const f = mundo.files?.[e.path] ?? mundo.files?.[e.path.replace(/\\/g, '/')]
    if (!f) return { deny: 'ENOENT' }
    return { value: { kind: 'file' as const, mtimeMs: f.mtimeMs, size: f.content.length, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const f = mundo.files?.[e.path] ?? mundo.files?.[e.path.replace(/\\/g, '/')]
    if (!f) return { deny: 'ENOENT' }
    return { value: f.content }
  })
  on('fs.list', () => ({ value: mundo.archivos.map((a) => ({ ...a, kind: 'file' as const, size: 1, isLink: false })) }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { visto.toasts.push(e.text); return { value: undefined } })
  on('prompt.submit', ($, e) => { const text = (e as { text?: string }).text || ''; visto.prompts.push(text); return { text } })
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

// BE-166 - Avanzar 60 min de reloj simulado dispara los avisos de fondo: con la
// máquina cargada el test pasaba de los 5 s por defecto (medido: 5092,74 ms en
// la puerta test:mod). No es lento por un bug: es mucho reloj.
test('mod: la cuota propia cruza el 90 % y después se libera', { timeoutMs: 30_000 }, async ($, on) => {
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

test('mod FEAT-194: informes pasa --pid-padre, toastea una vez, nunca dispara prompt.submit solo y AbovePrompt respeta F16', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const cfgPath = 'C:/home/.claude/antigravity.json'
  const mundo: Mundo = {
    lotes: [],
    cuota: null,
    archivos: [],
    fanout: null,
    informes: [],
    env: { USERPROFILE: 'C:/home' },
    files: { [cfgPath]: { content: JSON.stringify({ agy_auto_recoger: false }), mtimeMs: 1 } }
  }
  const visto = simular(on, mundo)
  on('ui.log', () => ({ value: undefined }))
  // Claude Code 2.1.310 (CI) exige implementación de ui.render cuando next(e) llega al fondo.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return <Box><Text>__motor__</Text></Box>
  })
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(21_000)
  await reloj.settle()
  expect(visto.avisosArgvs[0]?.includes('--pid-padre')).toBe(true)

  mundo.informes = [{ id: 'a1b2c3', tipo: 'audit', modo: 'plan', veredicto: 'PASS', propio: true }]
  await reloj.advance(60_000)
  await reloj.settle()
  expect(visto.toasts).toEqual(['📋 Informe a1b2c3 listo (audit · PASS)'])
  expect(visto.prompts).toEqual([])

  // Render con propio pendiente y autoRecoger=false -> muestra fila con [a]/[d].
  const ui = await $.ui.render({ component: 'AbovePrompt', props: { isWorking: false, maxRows: 10, hasSurvey: false }, surface: 'terminal' } as never)
  expect(JSON.stringify(ui)).toContain('a1b2c3')

  // F16: con isWorking=true o agy_auto_recoger=true, AbovePrompt pasa de largo (return next(e) -> nodo del motor).
  const trabajando = await $.ui.render({ component: 'AbovePrompt', props: { isWorking: true, maxRows: 10, hasSurvey: false }, surface: 'terminal' } as never)
  expect(JSON.stringify(trabajando)).toContain('__motor__')
  expect(JSON.stringify(trabajando)).not.toContain('a1b2c3')

  // Botones [a] recoger y [d] descartar limpian la banda optimísticamente, llaman mod-pedido-estado y [a] envía prompt.
  const montado = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'AbovePrompt', props: { isWorking: false, maxRows: 10, hasSurvey: false } } as never)
  await montado.press({ key: 'pedido-recoger' })
  await reloj.settle()
  expect(visto.buzonCmds.some((a) => a.includes('mod-pedido-estado') && a.includes('a1b2c3') && a.includes('recogido'))).toBe(true)
  expect(visto.prompts.length).toBe(1)
  expect(visto.prompts[0]).toContain('pedido: "a1b2c3"')

  mundo.informes = [{ id: 'a1b2c3', tipo: 'audit', modo: 'plan', veredicto: 'PASS', propio: true }, { id: 'd4e5f6', tipo: 'review', modo: null, veredicto: null, propio: true }]
  await reloj.advance(60_000)
  await reloj.settle()
  const montado2 = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'AbovePrompt', props: { isWorking: false, maxRows: 10, hasSurvey: false } } as never)
  await montado2.press({ key: 'pedido-descartar' })
  await reloj.settle()
  expect(visto.buzonCmds.some((a) => a.includes('mod-pedido-estado') && a.includes('d4e5f6') && a.includes('descartado'))).toBe(true)
  expect(visto.prompts.length).toBe(1) // [d] nunca envía prompt

  mundo.files![cfgPath] = { content: JSON.stringify({ agy_auto_recoger: true }), mtimeMs: 2 }
  await reloj.advance(11_000)
  await reloj.settle()
  const enAuto = await $.ui.render({ component: 'AbovePrompt', props: { isWorking: false, maxRows: 10, hasSurvey: false }, surface: 'terminal' } as never)
  expect(JSON.stringify(enAuto)).toContain('__motor__')
  expect(JSON.stringify(enAuto)).not.toContain('d4e5f6')
})

test('mod FEAT-195: [a] recoger manda el texto que armó panel.js (cola de auditorías), sin deducir la tool', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const cfgPath = 'C:/home/.claude/antigravity.json'
  const recoger = 'Recogé el informe de la auditoría c0ffee con `auditoria` (`accion: "recoger"`, `id: "c0ffee"`, `esperar_segundos: 0`).'
  const mundo: Mundo = {
    lotes: [],
    cuota: null,
    archivos: [],
    fanout: null,
    informes: [],
    env: { USERPROFILE: 'C:/home' },
    files: { [cfgPath]: { content: JSON.stringify({ agy_auto_recoger: false }), mtimeMs: 1 } }
  }
  const visto = simular(on, mundo)
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return <Box><Text>__motor__</Text></Box>
  })
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(21_000)
  await reloj.settle()
  mundo.informes = [{ id: 'c0ffee', tipo: 'audit', modo: 'plan', veredicto: 'FAIL', propio: true, recoger }]
  await reloj.advance(60_000)
  await reloj.settle()
  const montado = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'AbovePrompt', props: { isWorking: false, maxRows: 10, hasSurvey: false } } as never)
  await montado.press({ key: 'pedido-recoger' })
  await reloj.settle()
  expect(visto.prompts).toEqual([recoger])
  expect(visto.prompts[0]).not.toContain('pedido:')
})
