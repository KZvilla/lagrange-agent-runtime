import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { leerVoz, mensajeDeVoz, frases, fraseEn, filaDeSubtitulo, esToolDeVoz, MAX_FRASE } from '../hooks/voz-texto.ts'

/**
 * FEAT-119 + FEAT-120 — La voz en la terminal (en `hooks/mods.tsx`): el
 * spinner dice quién habla y la banda lleva los subtítulos mientras un
 * `say`/`narrate` con `local_playback` suena. El aviso del MCP
 * (`voz-<claudePid>.json`) lo da el test por `fs.read`; `buzon.js mod-voz`
 * por `process.run`; el reloj es el del kit.
 */

const SAY = 'mcp__plugin_lagrange_lagrange__say'
const RUTA = 'C:/datos/buzones/voz-4242.json'
const RUN = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const TEXTO = 'Hola Cris. Terminé la auditoría y salió bien. Mañana seguimos con el release.'

// ----------------------------------------------------------------- puro

test('leerVoz: sanea, descarta lo vencido o roto', () => {
  const ESC = String.fromCharCode(27)
  const crudo = JSON.stringify({ voz: `Alya${ESC}[31m`, texto: `hola${String.fromCharCode(7)}`, desde: 1000, duracionMs: 5000, hasta: 8000 })
  expect(leerVoz(crudo, 2000)).toEqual({ voz: 'Alya', texto: 'hola', desde: 1000, duracionMs: 5000, hasta: 8000 })
  expect(leerVoz(crudo, 9000)).toBe(null)
  expect(leerVoz('no es json', 0)).toBe(null)
  expect(leerVoz(JSON.stringify({ voz: 'A', texto: 'x', desde: 0, duracionMs: 0, hasta: 9 }), 0)).toBe(null)
  expect(leerVoz(JSON.stringify({ voz: '', texto: 'x', desde: 0, duracionMs: 1, hasta: 9 }), 0)?.voz).toBe('La voz')
  expect(leerVoz(JSON.stringify({ voz: 'v'.repeat(80), texto: 'x', desde: 0, duracionMs: 1, hasta: 9 }), 0)?.voz.length).toBe(40)
})

test('mensajeDeVoz, esToolDeVoz y la fila', () => {
  const v = { voz: 'Alya', texto: 't', desde: 0, duracionMs: 1, hasta: 2 }
  expect(mensajeDeVoz(true, v)).toBe('🔊 Alya está hablando')
  expect(mensajeDeVoz(true, null)).toBe('🎙 preparando la voz')
  expect(mensajeDeVoz(false, null)).toBe(null)
  expect(esToolDeVoz(SAY)).toBe(true)
  expect(esToolDeVoz('mcp__lagrange-dev__narrate')).toBe(true)
  for (const t of ['mcp__x__agy_run', 'say', 'mcp__x__say_algo', null]) expect(esToolDeVoz(t)).toBe(false)
  expect(filaDeSubtitulo(v, 'hola')).toBe('🔊 Alya: «hola»')
})

test('frases y fraseEn: por puntuación, tope de largo, peso por caracteres', () => {
  expect(frases(TEXTO)).toEqual(['Hola Cris.', 'Terminé la auditoría y salió bien.', 'Mañana seguimos con el release.'])
  expect(frases('uno\n\ndos')).toEqual(['uno', 'dos'])
  const larga = frases(('palabra, ').repeat(40))
  expect(larga.every((f) => f.length <= MAX_FRASE)).toBe(true)
  expect(larga.length).toBeGreaterThan(1)
  const f = frases(TEXTO)
  // 10 + 34 + 31 = 75 caracteres sobre 10 s.
  expect(fraseEn(f, 0, 10_000)).toBe(0)
  expect(fraseEn(f, 2_000, 10_000)).toBe(1)
  expect(fraseEn(f, 9_000, 10_000)).toBe(2)
  expect(fraseEn(f, 99_000, 10_000)).toBe(2)
  expect(fraseEn([], 0, 1)).toBe(-1)
})

// ----------------------------------------------------------------- mod

type Mundo = { aviso: string | null; lecturas: number }

function simular(on: On, mundo: Mundo) {
  const visto = { spinner: [] as Array<Record<string, unknown>> }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const script = String(e.argv[1])
    if (script.endsWith('buzon.js')) return RUN(JSON.stringify(e.argv[2] === 'mod-voz' ? { voz: RUTA } : { sesion: null }))
    if (script.endsWith('metas.js')) return RUN(JSON.stringify({ ok: true, metas: [], transiciones: [] }))
    return RUN('{}')
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.read', ($, e) => {
    const ruta = String(e.path).split(String.fromCharCode(92)).join('/')
    if (ruta !== RUTA) return { deny: 'ENOENT' }
    mundo.lecturas += 1
    return mundo.aviso === null ? { deny: 'ENOENT' } : { value: mundo.aviso }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    visto.spinner.push({ ...e.props })
    const { Text } = $.ui.resolve(e)
    return <Text>{String(e.props.message ?? e.props.word ?? '')}</Text>
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  return visto
}

/** Un `say` que el test termina cuando quiere. */
function sayPendiente(on: On) {
  let terminar: (r: unknown) => void = () => {}
  on('tool.call', { tool: SAY } as never, () => new Promise((resolve) => { terminar = resolve }) as never)
  return { terminar: () => terminar({ result: 'ok', text: 'listo' }) }
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const BANDA = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const SPINNER = { word: 'Thinking', message: null, suffix: '…', mode: 'tool-use' }

test('mod: say con local_playback → «preparando», después quién habla y los subtítulos; al terminar vuelve todo', async ($, on) => {
  const reloj = mock.clock(on, { now: 100_000 })
  const mundo: Mundo = { aviso: null, lecturas: 0 }
  const visto = simular(on, mundo)
  const say = sayPendiente(on)
  await $.session.start(inicio)
  await reloj.settle()

  const llamada = $.tool.call({ tool: SAY, text: TEXTO, local_playback: true } as never)
  await reloj.settle()
  const spinner = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Spinner', props: SPINNER } as never)
  expect(await spinner.find({ type: 'Text', text: '🎙 preparando la voz' })).toBeDefined()

  // El MCP avisa que empieza a sonar: 10 s de audio.
  mundo.aviso = JSON.stringify({ voz: 'Alya', texto: TEXTO, desde: 101_000, duracionMs: 10_000, hasta: 113_000, pid: 1 })
  await reloj.advance(1000)
  const banda = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'AbovePrompt', props: BANDA } as never)
  expect(await banda.find({ type: 'Text', text: '🔊 Alya: «Hola Cris.»' })).toBeDefined()
  const spinner2 = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Spinner', props: SPINNER } as never)
  expect(await spinner2.find({ type: 'Text', text: '🔊 Alya está hablando' })).toBeDefined()

  // Leído una vez: el resto lo cuenta el reloj.
  const leidas = mundo.lecturas
  await reloj.advance(3000)
  expect(mundo.lecturas).toBe(leidas)
  const banda2 = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'AbovePrompt', props: BANDA } as never)
  expect(await banda2.find({ type: 'Text', text: '🔊 Alya: «Terminé la auditoría y salió bien.»' })).toBeDefined()

  say.terminar()
  await llamada
  await reloj.settle()
  const banda3 = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'AbovePrompt', props: BANDA } as never)
  expect(await banda3.find({ type: 'Text', text: /🔊/ })).toBeUndefined()
  const spinner3 = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Spinner', props: SPINNER } as never)
  expect(await spinner3.find({ type: 'Text', text: 'Thinking' })).toBeDefined()
  // Sin voz en curso el tick se canceló: no se lee más.
  const despues = mundo.lecturas
  await reloj.advance(5000)
  expect(mundo.lecturas).toBe(despues)
  expect(visto.spinner.length).toBeGreaterThan(0)
})

test('mod: sin local_playback no cambia nada ni lee el disco', async ($, on) => {
  const reloj = mock.clock(on, { now: 100_000 })
  const mundo: Mundo = { aviso: JSON.stringify({ voz: 'Alya', texto: TEXTO, desde: 100_000, duracionMs: 10_000, hasta: 112_000 }), lecturas: 0 }
  simular(on, mundo)
  const say = sayPendiente(on)
  await $.session.start(inicio)
  await reloj.settle()
  const llamada = $.tool.call({ tool: SAY, text: TEXTO } as never)
  await reloj.advance(2000)
  const spinner = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Spinner', props: SPINNER } as never)
  expect(await spinner.find({ type: 'Text', text: 'Thinking' })).toBeDefined()
  expect(mundo.lecturas).toBe(0)
  say.terminar()
  await llamada
})
