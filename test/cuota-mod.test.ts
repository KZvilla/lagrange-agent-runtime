import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * BE-093 — La cuota de Claude que mide la sesión (`session.measure` en
 * `hooks/mods.tsx`) se lanza a `panel.js cuota-sesion`. Lo del buzón responde
 * "sin buzón"; el panel y las guardas no se arrancan (no hay `session.start`).
 */

const OK = { value: { exitCode: 0, stdout: '{"ok":true}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

function simular(on: On, { trabar = false } = {}) {
  const corridas: string[][] = []
  let soltar: (() => void) | null = null
  on('session.root', () => ({ value: 'C:/repo' }))
  // Lo que hace el motor debajo del mod: devolver `{ changed }`.
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('process.run', async ($, e) => {
    const argv = e.argv.map(String)
    if (argv[2] !== 'cuota-sesion') return OK
    corridas.push(argv.slice(3))
    if (trabar && corridas.length === 1) await new Promise<void>((r) => { soltar = r })
    return OK
  })
  return { corridas, soltar: () => soltar?.() }
}

const CONTEXTO = { window: 200_000 }
const R5 = '2026-10-02T23:00:00.000Z'
const R7 = '2026-10-05T10:00:00.000Z'
const medir = (rateLimits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>, changed: string[] = ['rateLimits']) =>
  ({ context: CONTEXTO, rateLimits, changed }) as never

test('una medición con las dos ventanas lanza cuota-sesion con la raíz y los cuatro datos', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const v = simular(on)
  await $.session.measure(medir([{ kind: 'five_hour', percentUsed: 42, resetsAt: R5 }, { kind: 'seven_day', percentUsed: 31, resetsAt: R7 }]))
  await reloj.settle()
  expect(v.corridas).toEqual([['C:/repo', '42', R5, '31', R7]])
})

test('solo la de 7 días: guiones en la de 5 h', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const v = simular(on)
  await $.session.measure(medir([{ kind: 'seven_day', percentUsed: 7 }]))
  await reloj.settle()
  expect(v.corridas).toEqual([['C:/repo', '-', '-', '7', '-']])
})

test('sin cambio de rateLimits, o solo spend_limit, no lanza nada', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const v = simular(on)
  await $.session.measure(medir([{ kind: 'five_hour', percentUsed: 42 }], ['context']))
  await $.session.measure(medir([{ kind: 'spend_limit', percentUsed: 80 }]))
  await reloj.settle()
  expect(v.corridas).toEqual([])
})

test('con una escritura en curso, la última medición se escribe al terminar', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const v = simular(on, { trabar: true })
  await $.session.measure(medir([{ kind: 'five_hour', percentUsed: 10 }]))
  await reloj.settle()
  await $.session.measure(medir([{ kind: 'five_hour', percentUsed: 11 }]))
  await $.session.measure(medir([{ kind: 'five_hour', percentUsed: 12 }]))
  expect(v.corridas.length).toBe(1)
  v.soltar()
  await reloj.settle()
  expect(v.corridas).toEqual([['C:/repo', '10', '-', '-', '-'], ['C:/repo', '12', '-', '-', '-']])
})
