import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { esToolDeAgy, nombreCorto, duracion, filasDeBanda, hayAlgo, cierreDe, CIERRE_MS } from '../hooks/banda-texto.ts'

/**
 * FEAT-109 — La banda de agy sobre el prompt (en `hooks/mods.tsx`), con el
 * mundo simulado: las tools de agy las responde el test, `panel.js` sale por
 * `process.run` y el reloj es el del kit. Las guardas quedan inertes (sin home)
 * y el buzón responde "sin buzón".
 */

const AUDIT = 'mcp__plugin_lagrange_lagrange__agy_audit'
const RUN_DEV = 'mcp__lagrange-dev__agy_run'
const RUN = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Mundo = { archivos: Array<{ name: string; mtimeMs: number }>; fanout: unknown }

function simular(on: On, mundo: Mundo) {
  const visto = { corridas: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const script = String(e.argv[1])
    if (script.endsWith('buzon.js')) return RUN(JSON.stringify({ sesion: null }))
    // FEAT-126 — Sin metas en este mundo.
    if (script.endsWith('metas.js')) return RUN(JSON.stringify({ ok: true, metas: [], transiciones: [] }))
    visto.corridas.push(String(e.argv[2]))
    return RUN(JSON.stringify({ fanout: mundo.fanout }))
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: mundo.archivos.map((a) => ({ ...a, kind: 'file' as const, size: 1, isLink: false })) }))
  on('ui.status', () => ({ value: undefined }))
  // El motor sin nada propio sobre el prompt: lo que dibuja `next(e)` cuando la banda calla.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  return visto
}

/** Una tool de agy que el test termina cuando quiere. */
function toolPendiente(on: On, tool: string) {
  let terminar: (r: unknown) => void = () => {}
  let fallar: (e: unknown) => void = () => {}
  on('tool.call', { tool } as never, () => new Promise((resolve, reject) => { terminar = resolve; fallar = reject }) as never)
  return { terminar: (r: unknown) => terminar(r), fallar: (e: unknown) => fallar(e) }
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const BANDA = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const montar = ($: Parameters<Parameters<typeof test>[1]>[0], surface: 'terminal' | 'desktop' | 'vscode' = 'terminal', props = BANDA) =>
  $.ui.mount({ plugin: 'lagrange', surface, component: 'AbovePrompt', props } as never)

// ----------------------------------------------------------------- puro

test('esToolDeAgy: las siete de agy con cualquier servidor, nada más', () => {
  expect(esToolDeAgy(AUDIT)).toBe(true)
  expect(esToolDeAgy(RUN_DEV)).toBe(true)
  for (const t of ['fanout', 'lote', 'plan', 'review', 'research']) expect(esToolDeAgy(`mcp__x__agy_${t}`)).toBe(true)
  for (const t of ['mcp__plugin_lagrange_lagrange__agy_status', 'mcp__plugin_lagrange_lagrange__agy_usage', 'Bash', 'mcp__otro__run', 'agy_audit', null])
    expect(esToolDeAgy(t)).toBe(false)
  expect(nombreCorto(AUDIT)).toBe('agy_audit')
})

test('duracion y cierreDe', () => {
  expect(duracion(48_000)).toBe('48s')
  expect(duracion(192_000)).toBe('3m12s')
  expect(duracion(3_900_000)).toBe('1h05m')
  expect(cierreDe(AUDIT, { texto: '## Verdict: FAIL', fallo: false }, 0, 10_000)).toEqual({ tool: AUDIT, resultado: 'FAIL', duracionMs: 10_000, hasta: 10_000 + CIERRE_MS })
  expect(cierreDe(AUDIT, { texto: 'sin veredicto', fallo: false }, 0, 1).resultado).toBe('terminó')
  expect(cierreDe(AUDIT, { texto: '## Verdict: PASS', fallo: true }, 0, 1).resultado).toBe('error')
})

test('filasDeBanda: tope de 6 tareas con «+N», campos null omitidos, sin fan-out terminado', () => {
  const ahora = Date.parse('2026-10-03T12:00:00Z')
  const tareas = Array.from({ length: 8 }, (_, i) => ({ id: `t${i + 1}`, estado: i === 0 ? 'corriendo' : 'pendiente', modelo: i === 0 ? 'gemini-3.8-flash' : null, inicio: i === 0 ? '2026-10-03T11:58:20Z' : null, fin: null, paso: i === 0 ? 'run_command' : null }))
  const fanout = { slug: 'demo', linea: null, tareas, terminado: false }
  const filas = filasDeBanda({ llamadas: [], cierres: [], fanout, ahora })
  expect(filas[0].texto).toBe('fanout demo')
  expect(filas[1].texto).toBe('  t1  corriendo   gemini-3.8-flash  run_command  1m40s')
  expect(filas[2]).toEqual({ texto: '  t2  pendiente', tono: 'tenue' })
  expect(filas.length).toBe(1 + 6 + 1)
  expect(filas[7].texto).toBe('  +2')
  expect(filasDeBanda({ llamadas: [], cierres: [], fanout: { ...fanout, terminado: true }, ahora })).toEqual([])
  expect(hayAlgo({ llamadas: [], cierres: [], fanout: { ...fanout, terminado: true }, ahora })).toBe(false)
  expect(filasDeBanda({ llamadas: [], cierres: [], fanout, ahora, maxFilas: 3 }).length).toBe(3)
})

// ----------------------------------------------------------------- mod

for (const surface of ['terminal', 'desktop'] as const) {
  test(`una auditoría muestra su reloj y, al terminar, el veredicto 20 s (${surface})`, async ($, on) => {
    const reloj = mock.clock(on, { now: 1_000_000 })
    simular(on, { archivos: [], fanout: null })
    const tool = toolPendiente(on, AUDIT)
    await $.session.start({ ...inicio, surface })
    await reloj.settle()
    const ui = await montar($, surface)
    expect(await ui.find({ type: 'Text', text: /agy_audit/ })).toBeUndefined()

    const llamada = $.tool.call({ tool: AUDIT, target: 'x' } as never)
    await reloj.settle()
    expect(await ui.find({ type: 'Text', text: 'agy_audit · 0s' })).toBeDefined()
    await reloj.advance(65_000)
    expect(await ui.find({ type: 'Text', text: 'agy_audit · 1m05s' })).toBeDefined()

    tool.terminar({ result: 'informe', text: '# Auditoría\n\n## Verdict: PASS WITH RESERVATIONS\n' })
    const r = await llamada
    expect((r as { text?: string }).text).toContain('PASS WITH RESERVATIONS')
    expect(await ui.find({ type: 'Text', text: 'agy_audit · PASS WITH RESERVATIONS · 1m05s' })).toBeDefined()
    await reloj.advance(CIERRE_MS + 5000)
    expect(await ui.find({ type: 'Text', text: /agy_audit/ })).toBeUndefined()
  })
}

test('si la tool falla, el error llega tal cual y el cierre dice «error»', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  simular(on, { archivos: [], fanout: null })
  const tool = toolPendiente(on, RUN_DEV)
  await $.session.start(inicio)
  await reloj.settle()
  const ui = await montar($)
  const llamada = $.tool.call({ tool: RUN_DEV, prompt: 'x' } as never)
  await reloj.settle()
  tool.terminar({ result: 'agy salió con 1', text: 'agy salió con 1', isError: true })
  const r = await llamada
  expect((r as { isError?: boolean }).isError).toBe(true)
  expect((r as { text?: string }).text).toBe('agy salió con 1')
  expect(await ui.find({ type: 'Text', text: 'agy_run · error · 0s' })).toBeDefined()
})

test('si la tool lanza, la llamada sigue en error y el cierre dice «error»', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  simular(on, { archivos: [], fanout: null })
  const tool = toolPendiente(on, AUDIT)
  await $.session.start(inicio)
  await reloj.settle()
  const ui = await montar($)
  const llamada = $.tool.call({ tool: AUDIT, target: 'x' } as never)
  await reloj.settle()
  tool.fallar(new Error('se cayó el MCP'))
  const r = await llamada.then((v) => ({ v }), (err) => ({ err }))
  // El motor saltea el hook que lanza y responde él (`no implementation`): lo que el
  // mod tiene que garantizar es que la llamada siga terminando en error, no en éxito.
  const fallo = 'err' in r || Boolean((r.v as { isError?: boolean; deny?: string }).isError || (r.v as { deny?: string }).deny)
  expect(fallo).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'agy_audit · error · 0s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'agy_audit · 0s' })).toBeUndefined()
})

test('dos llamadas en paralelo dan dos líneas', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  simular(on, { archivos: [], fanout: null })
  toolPendiente(on, AUDIT)
  toolPendiente(on, RUN_DEV)
  await $.session.start(inicio)
  await reloj.settle()
  const ui = await montar($)
  void $.tool.call({ tool: AUDIT, target: 'x' } as never)
  void $.tool.call({ tool: RUN_DEV, prompt: 'y' } as never)
  await reloj.settle()
  expect(await ui.find({ type: 'Text', text: 'agy_audit · 0s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'agy_run · 0s' })).toBeDefined()
})

test('una tool que no es de agy no dibuja nada', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  simular(on, { archivos: [], fanout: null })
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  await $.session.start(inicio)
  await reloj.settle()
  const ui = await montar($)
  await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  expect(await ui.find({ type: 'Text', text: /·/ })).toBeUndefined()
})

test('con una encuesta en la banda, calla', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  simular(on, { archivos: [], fanout: null })
  toolPendiente(on, AUDIT)
  await $.session.start(inicio)
  await reloj.settle()
  const ui = await montar($, 'terminal', { ...BANDA, hasSurvey: true })
  void $.tool.call({ tool: AUDIT, target: 'x' } as never)
  await reloj.settle()
  expect(await ui.find({ type: 'Text', text: /agy_audit/ })).toBeUndefined()
})

const FANOUT = {
  slug: 'demo', linea: '🔀 fanout demo: 1/2 · 1 ok · 1 corriendo (12s)', terminado: false,
  tareas: [
    { id: 't1', estado: 'ok', modelo: 'gemini-3.8-flash', inicio: null, fin: null },
    { id: 't2', estado: 'corriendo', modelo: 'gemini-3.8-flash', inicio: null, fin: null, paso: 'run_command' }
  ]
}

test('un fan-out en curso muestra cada tarea con su paso, sin repetir los contadores', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  simular(on, { archivos: [{ name: '.fanout-status-demo.json', mtimeMs: 999_000 }], fanout: FANOUT })
  await $.session.start(inicio)
  await reloj.settle()
  const ui = await montar($)
  expect(await ui.find({ type: 'Text', text: 'fanout demo' })).toBeUndefined()
  // El mismo tick que trae el fan-out lo dibuja: sin esperar al siguiente.
  await reloj.advance(5000)
  expect(await ui.find({ type: 'Text', text: 'fanout demo' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /t2 +corriendo +gemini-3\.8-flash +run_command/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeUndefined()
})

test('un .agy-progress nuevo dispara panel.js fanout en el siguiente tick, sin esperar 30 s', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const mundo: Mundo = { archivos: [{ name: '.fanout-status-demo.json', mtimeMs: 999_000 }, { name: '.agy-progress-demo-t2-abc.jsonl', mtimeMs: 999_000 }], fanout: FANOUT }
  const visto = simular(on, mundo)
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(5000)
  expect(visto.corridas).toEqual(['fanout'])
  await reloj.advance(5000)
  expect(visto.corridas).toEqual(['fanout'])
  mundo.archivos = [mundo.archivos[0], { name: '.agy-progress-demo-t2-abc.jsonl', mtimeMs: 1_009_000 }]
  await reloj.advance(5000)
  expect(visto.corridas).toEqual(['fanout', 'fanout'])
})
