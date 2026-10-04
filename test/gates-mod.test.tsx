import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { nuevaCorrida, procesarLinea, partirLineas, leerArgGates, lineaDeGates, bloqueDeGates, finPorCodigo, PLAZO_GATES_MS } from '../hooks/gates-texto.ts'

/**
 * FEAT-114 — `/lagrange-gates` (en `hooks/mods.tsx`) con el mundo simulado: la
 * salida de `scripts/gates.mjs` la entrega un canal del test por `process.spawn`,
 * trozo a trozo, y el código de salida es el valor de retorno del stream.
 */

// La salida real de gates.mjs (todas verdes, modo --quick), como la imprime.
const QUICK_VERDE = [
  'PASS  unit (narrate)', 'PASS  npm test', 'PASS  release:check', 'PASS  test:mcp', 'PASS  validate', 'PASS  test:mod',
  '', '----------------------------------------------------',
  '    0  unit (narrate)       23.3s', '    0  npm test             303.5s',
  '----------------------------------------------------', '6/6 puertas en verde (modo --quick)'
]
const UNA_ROTA = [
  'PASS  unit (narrate)', 'FAIL  npm test', 'PASS  release:check',
  '', '----------------------------------------------------', '    1  npm test             12.0s',
  '----------------------------------------------------', '2/3 puertas en verde',
  '', '=== npm test (exit 1) ===', '  FAIL  algo se rompió', 'esperado 1, vino 2'
]

// ----------------------------------------------------------------- puro

test('procesarLinea: puertas en orden, el total y la cola de las rotas; ignora la tabla', () => {
  const c = nuevaCorrida('rápidas', 0)
  QUICK_VERDE.forEach((l, i) => procesarLinea(c, l, i))
  expect(c.puertas.map((p) => p.nombre)).toEqual(['unit (narrate)', 'npm test', 'release:check', 'test:mcp', 'validate', 'test:mod'])
  expect(c.puertas.every((p) => p.ok)).toBe(true)
  expect(c.total).toEqual({ verdes: 6, total: 6 })
  expect(c.cola).toEqual([])
  const r = nuevaCorrida('todas', 0)
  UNA_ROTA.forEach((l) => procesarLinea(r, l, 0))
  expect(r.puertas.map((p) => p.ok)).toEqual([true, false, true])
  expect(r.cola).toEqual(['=== npm test (exit 1) ===', '  FAIL  algo se rompió', 'esperado 1, vino 2'])
})

test('procesarLinea: una línea PASS dentro de la cola no cuenta como puerta; la cola tiene tope', () => {
  const c = nuevaCorrida('todas', 0)
  for (const l of ['FAIL  npm test', '=== npm test (exit 1) ===', 'PASS  no es una puerta', ...Array.from({ length: 60 }, (_, i) => `línea ${i}`)]) procesarLinea(c, l, 0)
  expect(c.puertas.length).toBe(1)
  expect(c.cola.length).toBe(40)
})

test('partirLineas junta una línea cortada entre dos trozos', () => {
  const a = partirLineas('', 'PASS  unit (narrate)\nPASS  np')
  expect(a).toEqual({ lineas: ['PASS  unit (narrate)'], resto: 'PASS  np' })
  expect(partirLineas(a.resto, 'm test\n')).toEqual({ lineas: ['PASS  npm test'], resto: '' })
})

test('leerArgGates y lineaDeGates', () => {
  expect(leerArgGates('')).toBe('todas')
  expect(leerArgGates(' QUICK ')).toBe('rápidas')
  expect(leerArgGates('detener')).toBe('detener')
  expect(leerArgGates('todo')).toBe(null)
  const c = nuevaCorrida('todas', 0)
  UNA_ROTA.forEach((l) => procesarLinea(c, l, 0))
  c.fin = finPorCodigo(1, 0, 72_000)
  expect(lineaDeGates(c, 72_000)).toBe('2/3 · 1 rota (todas) · 1m12s')
  // La cola va al pane, nunca a la línea.
  expect(lineaDeGates(c, 72_000).includes('esperado')).toBe(false)
  expect(bloqueDeGates(c, 72_000).filas.some((f) => f.some((s) => s.texto === 'esperado 1, vino 2'))).toBe(true)
})

// ----------------------------------------------------------------- mod

type Pieza = { stream: 'stdout' | 'stderr'; text: string } | { fin: { code: number | null; signal: string | null } } | { error: string }

/** La salida del hijo, entregada cuando el test quiere. */
function canal() {
  const cola: Pieza[] = []
  let despertar: (() => void) | null = null
  const empujar = (p: Pieza) => { cola.push(p); const d = despertar; despertar = null; d?.() }
  const estado = { cerrado: false }
  async function* leer() {
    try {
      while (true) {
        while (!cola.length) await new Promise<void>((r) => { despertar = r })
        const p = cola.shift()!
        if ('fin' in p) return p.fin
        if ('error' in p) throw new Error(p.error)
        yield p
      }
    } finally {
      // Se cierra por return() (lo que mata al hijo en el motor) o por terminar.
      estado.cerrado = true
    }
  }
  return {
    estado,
    salida: (texto: string) => empujar({ stream: 'stdout', text: texto }),
    fin: (code: number | null) => empujar({ fin: { code, signal: code === null ? 'SIGTERM' : null } }),
    fallar: (msg: string) => empujar({ error: msg }),
    leer
  }
}

const RUN = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function simular(on: On, { hayGates = true } = {}) {
  const visto = { comandos: [] as string[], argv: [] as string[][], toasts: [] as string[], abiertos: [] as string[], canales: [] as ReturnType<typeof canal>[], existe: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => RUN(JSON.stringify(String(e.argv[1]).endsWith('buzon.js') ? { sesion: null } : { fanout: null, cuota: null, versiones: null })))
  on('process.spawn', async function* ($, e) {
    visto.argv.push([...e.argv])
    const c = canal()
    visto.canales.push(c)
    const fin = yield* c.leer()
    return { value: fin }
  } as never)
  // El motor entrega la ruta normalizada (con barras invertidas en Windows): se compara sin importar la barra.
  on('fs.exists', ($, e) => { const p = String(e.path).split('\\').join('/'); visto.existe.push(p); return { value: hayGates && p.endsWith('scripts/gates.mjs') } })
  on('command.register', ($, e) => { visto.comandos.push(e.name); return { value: { command: e.name } } })
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { visto.toasts.push(String((e as { text?: string }).text ?? e)); return { value: undefined } })
  on('ui.open', ($, e) => { visto.abiertos.push(e.id); return { value: { isPlaced: true as const } } })
  return visto
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const comando = (args: string, command = 'lagrange-gates') => ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never
const PANE_PROPS = { title: 'Lagrange', isFocused: false, bodyColumns: 80 }
const texto = (r: unknown) => String((r as { text?: string }).text)

test('sin scripts/gates.mjs el comando no se registra', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on, { hayGates: false })
  await $.session.start(inicio)
  await reloj.settle()
  expect(visto.comandos).toContain('lagrange-panel')
  expect(visto.comandos.includes('lagrange-gates')).toBe(false)
})

test('responde al instante con el modo, abre el panel y lanza gates.mjs; quick agrega --quick', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on)
  await $.session.start(inicio)
  await reloj.settle()
  expect(visto.existe).toEqual(['C:/repo/scripts/gates.mjs'])
  expect(visto.comandos).toContain('lagrange-gates')
  const r = await $.command.run(comando('quick'))
  expect(texto(r)).toContain('Corriendo las puertas (rápidas)')
  expect(texto(r)).toContain('alguna puede fallar sin estar rota')
  expect(visto.argv).toEqual([['node', 'scripts/gates.mjs', '--quick']])
  expect(visto.abiertos).toEqual(['lagrange'])
})

test('un argumento inválido no lanza nada', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on)
  await $.session.start(inicio)
  await reloj.settle()
  expect(texto(await $.command.run(comando('todo')))).toContain('Uso:')
  expect(visto.argv).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`las filas aparecen a medida que llegan, el reloj avanza y al final queda N/M y un toast (${surface})`, async ($, on) => {
    const reloj = mock.clock(on, { now: 1_000_000 })
    const visto = simular(on)
    await $.session.start({ ...inicio, surface })
    await reloj.settle()
    await $.command.run(comando('quick'))
    const ui = await $.ui.mount({ plugin: 'lagrange', surface, component: 'Pane', requestId: 'lagrange', props: PANE_PROPS })
    const c = visto.canales[0]
    c.salida('PASS  unit (narrate)\nPASS  np')
    await reloj.settle()
    expect(await ui.find({ type: 'Text', text: 'unit (narrate)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'npm test' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '… puerta 2 · 0s' })).toBeDefined()
    await reloj.advance(10_000)
    expect(await ui.find({ type: 'Text', text: '… puerta 2 · 10s' })).toBeDefined()
    c.salida(`m test\n${QUICK_VERDE.slice(2).join('\n')}\n`)
    c.fin(0)
    await reloj.settle()
    expect(await ui.find({ type: 'Text', text: 'npm test' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '6/6 en verde' })).toBeDefined()
    expect(visto.toasts).toEqual(['Gates: 6/6 en verde (rápidas) · 10s'])
  })
}

test('manda el código: el texto dice todo verde pero salió 1', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on)
  await $.session.start(inicio)
  await reloj.settle()
  await $.command.run(comando('quick'))
  visto.canales[0].salida(QUICK_VERDE.join('\n') + '\n')
  visto.canales[0].fin(1)
  await reloj.settle()
  expect(visto.toasts[0]).toContain('6/6 · salió con código 1')
})

test('terminar por señal (code null) cuenta como rota', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on)
  await $.session.start(inicio)
  await reloj.settle()
  await $.command.run(comando(''))
  visto.canales[0].salida('PASS  unit (narrate)\n')
  visto.canales[0].fin(null)
  await reloj.settle()
  expect(visto.toasts[0]).toContain('salió con código señal')
})

test('si el hijo no arranca, lo dice', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on)
  await $.session.start(inicio)
  await reloj.settle()
  await $.command.run(comando(''))
  visto.canales[0].fallar('ENOENT node')
  await reloj.settle()
  expect(visto.toasts[0]).toContain('No se pudo lanzar gates.mjs')
})

test('un segundo comando mientras corre no lanza otro; detener corta y libera', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on)
  await $.session.start(inicio)
  await reloj.settle()
  await $.command.run(comando(''))
  visto.canales[0].salida('PASS  unit (narrate)\n')
  await reloj.settle()
  expect(texto(await $.command.run(comando('')))).toBe('Ya corren las puertas (todas): 1 terminadas, 0s.')
  expect(visto.argv.length).toBe(1)
  expect(texto(await $.command.run(comando('detener')))).toBe('Puertas detenidas.')
  expect(visto.toasts[0]).toContain('detenidas')
  // El stream se cierra (en el motor, eso mata al hijo). Con un generador nativo el
  // return() espera a la próxima salida del hijo: límite conocido, la bandera ya se liberó.
  visto.canales[0].salida('PASS  npm test\n')
  await reloj.settle()
  expect(visto.canales[0].estado.cerrado).toBe(true)
  expect(texto(await $.command.run(comando('detener')))).toBe('No hay puertas corriendo.')
  await $.command.run(comando('quick'))
  expect(visto.argv.length).toBe(2)
})

test('pasado el plazo se corta, lo dice y libera', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on)
  await $.session.start(inicio)
  await reloj.settle()
  await $.command.run(comando(''))
  await reloj.advance(PLAZO_GATES_MS + 1000)
  expect(visto.toasts[0]).toContain('cortadas por plazo')
  await $.command.run(comando(''))
  expect(visto.argv.length).toBe(2)
})

test('/lagrange-panel suma una sola línea de Gates, sin la cola de las rotas', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on)
  await $.session.start(inicio)
  await reloj.settle()
  await $.command.run(comando(''))
  visto.canales[0].salida(UNA_ROTA.join('\n') + '\n')
  visto.canales[0].fin(1)
  await reloj.settle()
  const t = texto(await $.command.run(comando('', 'lagrange-panel')))
  expect(t).toContain('**Gates**\n2/3 · 1 rota (todas)')
  expect(t.includes('esperado 1, vino 2')).toBe(false)
  const ui = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Pane', requestId: 'lagrange', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'esperado 1, vino 2' })).toBeDefined()
})
