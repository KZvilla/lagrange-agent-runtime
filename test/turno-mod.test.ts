import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { nuevoTurno, abrirTool, cerrarTool, contarPaso, cerrarTurno, barra, tiras, porTipo, cabecera, tokensCortos, textoDeTurno, anteriores, TOPE_TOOLS } from '../hooks/turno-texto.ts'
import type { TurnoCerrado } from '../hooks/turno-texto.ts'
import { filasDeFoto } from '../hooks/panel-texto.ts'

/**
 * FEAT-122 — La línea de tiempo del turno (en `hooks/mods.tsx`, dentro del
 * `tool.call` de FEAT-109, y `hooks/turno-texto.ts`) con el reloj del kit:
 * turn.start / tool.call / turn.step / turn.complete los dispara el test.
 */

const USO = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 40_000, model: 'claude-opus-5-5' }

function cerrado(extra: Partial<TurnoCerrado> = {}): TurnoCerrado {
  return { turnId: 't', fin: 0, duracionMs: 100_000, interrumpido: false, requests: 3, tokens: { entrada: 1000, salida: 2000, cacheLeida: 300_000, cacheEscrita: 40_000 }, costo: 0.42, tools: [], extra: 0, ...extra }
}

// ----------------------------------------------------------------- puro

test('tools: paralelas, relativas al inicio, interrumpidas cierran al fin; tope con extra', () => {
  const t = nuevoTurno('a', 1000, 1)
  abrirTool(t, 'x', 'Bash', 2000)
  abrirTool(t, 'y', 'mcp__plugin_lagrange_lagrange__agy_run', 3000)
  cerrarTool(t, 'x', 5000, false)
  contarPaso(t)
  contarPaso(t)
  const c = cerrarTurno(t, { durationMs: 9000, interrumpido: true, costoFinal: 1.25, ahora: 10_000, uso: USO })
  expect(c.tools).toEqual([{ nombre: 'Bash', desdeMs: 1000, duracionMs: 3000, error: false }, { nombre: 'agy_run', desdeMs: 2000, duracionMs: 7000, error: true }])
  expect(c.requests).toBe(2)
  expect(c.costo).toBe(0.25)
  expect(c.tokens).toEqual({ entrada: 1000, salida: 2000, cacheLeida: 300_000, cacheEscrita: 40_000 })
  expect(cerrarTurno(nuevoTurno('b', 0, null), { durationMs: 1, interrumpido: false, costoFinal: 3, ahora: 1, uso: null }).costo).toBe(null)
  const lleno = nuevoTurno('c', 0, null)
  for (let i = 0; i < TOPE_TOOLS + 3; i++) { abrirTool(lleno, `k${i}`, 'Read', i); cerrarTool(lleno, `k${i}`, i + 1, false) }
  expect(lleno.tools.length).toBe(TOPE_TOOLS)
  expect(lleno.extra).toBe(3)
})

test('barra, tiras, por tipo, cabecera y textos', () => {
  expect(barra(0, 50, 100, 10)).toBe('█████░░░░░')
  expect(barra(90, 1, 100, 10)).toBe('░░░░░░░░░█')
  expect(barra(100, 0, 100, 10)).toBe('░░░░░░░░░█')
  const tools = Array.from({ length: 30 }, (_, i) => ({ nombre: i % 2 ? 'Read' : 'Bash', desdeMs: i * 1000, duracionMs: (i + 1) * 100, error: i === 29 }))
  const filas = tiras(cerrado({ tools }))
  expect(filas.length).toBe(26)
  expect(filas[25].texto).toBe('+5 más (1s)')
  // En orden de inicio aunque lleguen en orden de cierre.
  expect(tiras(cerrado({ tools: [tools[3], tools[1]] })).map((f) => f.texto.slice(0, 4))).toEqual(['Read', 'Read'])
  expect(tiras(cerrado({ tools: [{ ...tools[0], nombre: 'Zeta', desdeMs: 5000 }, { ...tools[0], nombre: 'Alfa', desdeMs: 1000 }] })).map((f) => f.texto.slice(0, 4))).toEqual(['Alfa', 'Zeta'])
  expect(filas[24].error).toBe(true)
  expect(tiras(cerrado({ tools }), 8).length).toBe(9)
  expect(porTipo(cerrado({ tools: [tools[0], tools[1], tools[2]] }))).toEqual(['Bash ×2 · 0s', 'Read ×1 · 0s'])
  expect(tokensCortos(340_000)).toBe('340k')
  expect(tokensCortos(1_234_000)).toBe('1,2M')
  expect(cabecera(cerrado())).toBe('Turno de 1m40s · 3 requests · 343k tokens (cache 300k) · $0,42')
  expect(cabecera(cerrado({ costo: null, interrumpido: true, requests: 1 }))).toBe('Turno de 1m40s · 1 request · 343k tokens (cache 300k) · — (interrumpido)')
  expect(textoDeTurno([])).toContain('Todavía no hay turnos')
  expect(anteriores([cerrado({ duracionMs: 1000 }), cerrado({ duracionMs: 2000 }), cerrado()])).toBe('2s · 1s')
  const titulos = (turno: TurnoCerrado | null) => filasDeFoto(null, 0, { turno }).map((b) => b.titulo)
  expect(titulos(null)).not.toContain('Último turno')
  expect(titulos(cerrado())).toContain('Último turno')
})

// ----------------------------------------------------------------- mod

function simular(on: On, costos: number[]) {
  const visto = { costos: [...costos], abiertos: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ sesion: null, ok: true, metas: [], transiciones: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/p' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.exists', () => ({ value: false }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => { visto.abiertos += 1; return { value: undefined } })
  on('store.get', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: visto.costos.shift() ?? 0 } } as never }))
  on('tool.call', { tool: 'Bash' } as never, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
  on('tool.call', { tool: 'Read' } as never, () => { throw new Error('no existe') })
  on('turn.start', ($, e) => ({ text: e.text, turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  return visto
}

const inicio = { cwd: 'C:/p', surface: 'terminal' as const, isInteractive: true }
const comando = { command: 'turno', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never
const completo = (turnId: string, extra: Record<string, unknown> = {}) => ({ turnId, answer: '', durationMs: 4000, isAborted: false, reason: 'answer', usage: USO, ...extra }) as never

test('mod: un turno con tools mide cada una; la que lanza queda con error; costo por diferencia', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000 })
  const visto = simular(on, [0.10, 0.35])
  await $.session.start(inicio as never)
  await reloj.settle()
  // BE-108 — Sin turnos: solo el texto, que explica la recarga; el panel no se abre.
  const vacio = String((await $.command.run(comando) as { text?: string }).text)
  expect(vacio).toContain('desde que cargó el mod (la recarga de plugins lo vacía')
  expect(visto.abiertos).toBe(0)
  await $.turn.start({ text: 'hola', turnId: 'T1' } as never)
  await reloj.advance(500)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await expect($.tool.call({ tool: 'Read', file_path: 'x' } as never)).rejects.toThrow()
  // La tool de un subagente no se cuenta; un turn.complete de subagente no cierra.
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'sub-1' } as never)
  await $.turn.complete(completo('SUB', { agentId: 'sub-1' }))
  expect(String((await $.command.run(comando) as { text?: string }).text)).toContain('Todavía no hay turnos')
  await reloj.advance(3500)
  await $.turn.complete(completo('T1'))
  const texto = String((await $.command.run(comando) as { text?: string }).text)
  expect(texto).toContain('Turno de 4s · 0 requests · 343k tokens (cache 300k) · $0,25')
  expect(texto).toContain('Bash')
  expect(texto).toMatch(/Read .* ✗/)
  expect(texto).toContain('Por tipo: ')
  expect(visto.abiertos).toBe(1)
})

test('mod: un turn.start de subagente (si llegara) no pisa al principal', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000 })
  simular(on, [0, 0, 0, 0])
  await $.session.start(inicio as never)
  await reloj.settle()
  await $.turn.start({ text: 'principal', turnId: 'P' } as never)
  await $.turn.start({ text: '', turnId: 'S' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.turn.complete(completo('S', { agentId: 'sub-1' }))
  await $.turn.complete(completo('P'))
  const texto = String((await $.command.run(comando) as { text?: string }).text)
  expect(texto).toContain('Turno de 4s')
  expect(texto).toContain('Bash')
  // Un fantasma que nunca cerró tampoco se queda con las tools del turno siguiente.
  await $.turn.start({ text: '', turnId: 'S2' } as never)
  await $.turn.start({ text: 'otro', turnId: 'P2' } as never)
  await $.turn.complete(completo('P2'))
  await $.turn.start({ text: 'tercero', turnId: 'P3' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.turn.complete(completo('P3'))
  const ultimo = String((await $.command.run(comando) as { text?: string }).text)
  expect(ultimo.split(String.fromCharCode(10))[1]).toContain('Bash')
})

test('mod: un turn.complete de otro turnId no cierra el abierto', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000 })
  simular(on, [0, 0])
  await $.session.start(inicio as never)
  await reloj.settle()
  await $.turn.start({ text: 'x', turnId: 'A' } as never)
  await $.turn.complete(completo('B'))
  expect(String((await $.command.run(comando) as { text?: string }).text)).toContain('Todavía no hay turnos')
})
