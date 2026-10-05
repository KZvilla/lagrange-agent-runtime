import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { nuevoHandoff, pctDe, medir, descartar, empezar, terminar, vigente, hayAviso, filaDeHandoff, conTilde, VISIBLE_MS } from '../hooks/handoff-texto.ts'

/**
 * FEAT-118 — El freno de contexto: la parte pura (`hooks/handoff-texto.ts`) y
 * el mod (en `hooks/mods.tsx`): `session.measure`, la ventana de compactación
 * del breakdown, la fila con botones en la banda y `/lagrange-resumen handoff si`
 * con el fork simulado.
 */

const HOME = 'C:/Users/u'

// ------------------------------------------------------------------ puro

test('pctDe: entero, y null sin datos', () => {
  expect(pctDe(72_000, 100_000)).toBe(72)
  expect(pctDe(undefined, 100_000)).toBe(null)
  expect(pctDe(1, 0)).toBe(null)
  expect(pctDe(-1, 10)).toBe(null)
})

test('medir: 69 no avisa; 70 avisa; 75 no repite; 85 avisa; 90 no repite; bajo 40 rearma', () => {
  let h = medir(nuevoHandoff(), 69)
  expect(h.aviso).toBe(null)
  h = medir(h, 70)
  expect(h.aviso).toBe(70)
  h = descartar(medir(h, 75))
  expect(h.aviso).toBe(null)
  h = medir(h, 80)
  expect(h.aviso).toBe(null)
  h = medir(h, 85)
  expect(h.aviso).toBe(85)
  h = descartar(medir(h, 90))
  expect(h.aviso).toBe(null)
  h = medir(h, 39)
  expect(h.disparados).toEqual([])
  h = medir(h, 72)
  expect(h.aviso).toBe(70)
  expect(medir(h, null)).toBe(h)
})

test('medir: saltar de 30 a 90 avisa el 85 y marca los dos', () => {
  const h = medir(medir(nuevoHandoff(), 30), 90)
  expect(h.aviso).toBe(85)
  expect(h.disparados).toEqual([70, 85])
})

test('terminar: solo la primera línea; éxito con ~; error con su texto; vence a los 20 s', () => {
  const ok = terminar(empezar(nuevoHandoff(), 0), 'Resumen (handoff) guardado en C:\\Users\\u\\.claude\\session-summaries\\x.md\n— $.model.fork: 1 tokens', 1000, HOME)
  expect(ok.fase).toBe('listo')
  expect(ok.texto).toBe('Handoff guardado en ~/.claude/session-summaries/x.md')
  const mal = terminar(empezar(nuevoHandoff(), 0), 'No se generó el resumen: el fork no respondió (x).\n— pie', 1000, HOME)
  expect(mal.fase).toBe('error')
  expect(mal.texto).toBe('No se generó el resumen: el fork no respondió (x).')
  expect(terminar(nuevoHandoff(), '', 0, HOME).texto).toBe('No se generó el handoff.')
  expect(hayAviso(ok, 1000 + VISIBLE_MS - 1)).toBe(true)
  expect(vigente(ok, 1000 + VISIBLE_MS).fase).toBe('quieto')
  expect(conTilde('D:/otro/x.md', HOME)).toBe('D:/otro/x.md')
})

test('filaDeHandoff: botones solo en el aviso; 85 es urgente', () => {
  expect(filaDeHandoff(medir(nuevoHandoff(), 72), 0)).toEqual({ texto: 'Contexto al 72 % de la compactación', tono: 'aviso', botones: true })
  expect(filaDeHandoff(medir(nuevoHandoff(), 88), 0)?.tono).toBe('urgente')
  expect(filaDeHandoff(empezar(nuevoHandoff(), 0), 65_000)).toEqual({ texto: 'Generando handoff… 1m05s', tono: 'normal', botones: false })
  expect(filaDeHandoff(nuevoHandoff(), 0)).toBe(null)
})

// ------------------------------------------------------------------ mod

const DOCUMENTO = `# Handoff\n\n## 1. Objetivo y estado\n${'Se trabajó en los mods de Lagrange. '.repeat(20)}\n\n## 2. Próximos pasos\n- Seguir.\n`

type Mundo = { fork?: unknown; ventana?: number | null; fallaUsage?: boolean }

function simular(on: On, mundo: Mundo) {
  const visto = { usos: 0, forks: 0, escritos: [] as string[], comandos: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: (e as { sessionId?: string }).sessionId }) as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('process.run', ($, e) => {
    const cuerpo = String(e.argv[1]).endsWith('buzon.js') ? { sesion: null } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(cuerpo), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('session.id', () => ({ value: '4eee260b-0000' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', ($, e) => {
    visto.usos += 1
    if (mundo.fallaUsage) return { deny: 'sin breakdown' }
    const breakdown = (e as { breakdown?: boolean }).breakdown && mundo.ventana ? { rawMaxTokens: mundo.ventana } : undefined
    return { value: { startedAt: 0, context: { tokens: 1, window: 1_000_000, breakdown }, rateLimits: [] } as never }
  })
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', ($, e) => { visto.escritos.push(String(e.path).replace(/\\/g, '/')); return { value: undefined } })
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? HOME : undefined }))
  on('model.fork', () => { visto.forks += 1; return { value: mundo.fork ?? { isAnswered: false, reason: 'nothing-to-fork', usage: {} } } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  return visto
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const BANDA = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const montar = ($: Parameters<Parameters<typeof test>[1]>[0], props = BANDA) =>
  $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'AbovePrompt', props } as never)
const medicion = (tokens: number, window = 1_000_000) => ({ context: { tokens, window }, rateLimits: [], changed: ['context'] }) as never

test('mod: cruzar el 70 % de la ventana de compactación dibuja la fila con [h] y [x]; otra medición no la duplica', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  // 150k de 1M es 15 % del modelo, pero 75 % de la ventana de compactación.
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  const ui = await montar($)
  expect((await ui.find({ type: 'Text', text: /Contexto al 75 % de la compactación/ }))).toBeDefined()
  expect(await ui.find({ key: 'handoff-guardar' })).toBeDefined()
  expect(await ui.find({ key: 'handoff-no' })).toBeDefined()
  await $.session.measure(medicion(152_000))
  await reloj.settle()
  expect(visto.usos).toBe(1)
  const ui2 = await montar($)
  expect((await ui2.find({ type: 'Text', text: /Contexto al 76 %/ }))).toBeDefined()
})

test('mod: sin breakdown decide con la ventana del modelo (avisa tarde, nunca de más)', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { fallaUsage: true })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeUndefined()
  await $.session.measure(medicion(720_000))
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeDefined()
})

test('mod: [x] oculta la fila', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  const ui = await montar($)
  await ui.press({ key: 'handoff-no' })
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeUndefined()
})

test('mod: [h] corre lagrange-resumen con «handoff si» una vez y deja la ruta con ~', async ($, on) => {
  const reloj = mock.clock(on, { now: Date.parse('2026-10-04T05:00:00Z') })
  const visto = simular(on, { ventana: 200_000, fork: { isAnswered: true, text: DOCUMENTO, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } } })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  const ui = await montar($)
  await ui.press({ key: 'handoff-guardar' })
  await reloj.settle()
  expect(visto.forks).toBe(1)
  expect(visto.escritos.length).toBe(1)
  expect(visto.escritos[0]).toContain('/.claude/session-summaries/')
  const despues = await montar($)
  expect(await despues.find({ type: 'Text', text: /^Handoff guardado en ~\/\.claude\/session-summaries\/.*\.md$/ })).toBeDefined()
  expect(await despues.find({ key: 'handoff-guardar' })).toBeUndefined()
  await reloj.advance(VISIBLE_MS + 5000)
  expect(await (await montar($)).find({ type: 'Text', text: /Handoff guardado/ })).toBeUndefined()
})

test('mod: un fork que no responde deja el error en la fila, sin el pie de costo', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  await (await montar($)).press({ key: 'handoff-guardar' })
  await reloj.settle()
  const ui = await montar($)
  expect(await ui.find({ type: 'Text', text: /^No se generó el resumen: todavía no hay conversación para resumir\.$/ })).toBeDefined()
})

test('mod: /clear (session.end) quita el aviso', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeDefined()
  await $.session.end({ reason: 'clear', sessionId: '4eee260b-0000' } as never)
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeUndefined()
})

test('mod: con la banda llena, agy cede una fila y el aviso entra al final', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  on('tool.call', { tool: 'mcp__plugin_lagrange_lagrange__agy_run' } as never, () => new Promise(() => {}) as never)
  await $.session.start(inicio)
  await reloj.settle()
  for (let i = 0; i < 3; i++) void $.tool.call({ tool: 'mcp__plugin_lagrange_lagrange__agy_run', prompt: String(i) } as never)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  // maxRows 4 → 2 filas: una de agy y el aviso.
  const ui = await montar($, { ...BANDA, maxRows: 4 })
  const agy = await ui.findAll({ type: 'Text', text: /^agy_run · / })
  expect(agy.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Contexto al 75 %/ })).toBeDefined()
})

test('mod: durante un turno la fila se ve sin botones (el fork espera a que termine)', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  const ui = await montar($, { ...BANDA, isWorking: true })
  expect(await ui.find({ type: 'Text', text: /Contexto al 75 %/ })).toBeDefined()
  expect(await ui.find({ key: 'handoff-guardar' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'al terminar el turno' })).toBeDefined()
})

test('mod: la pista entre turnos dice cómo llegar a los botones (clic o el acorde ctrl+x y Tab)', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  expect(await (await montar($)).find({ type: 'Text', text: 'clic, o ctrl+x y Tab' })).toBeDefined()
})
