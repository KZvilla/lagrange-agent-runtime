import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { grupoDe, modelosDelPedido, modeloPorDefecto, restantes, bajo, pregunta, decision, estadoDe, UMBRAL } from '../hooks/cuota-previa.ts'

/**
 * FEAT-111 — Preguntar antes de lanzar agy con la cuota del grupo baja (en
 * `hooks/mods.tsx`, dentro del hook de FEAT-109). El mundo es simulado: el
 * home y sus archivos los da el test, la tool de agy la responde el test y el
 * diálogo de `$.ui.ask` es un `tool.call` de `AskUserQuestion` que contesta el
 * test (o nadie: entonces el ask rechaza y la llamada pasa).
 */

const AHORA = Date.parse('2026-10-05T12:00:00Z')
const RUN = 'mcp__plugin_lagrange_lagrange__agy_run'
const FANOUT = 'mcp__lagrange-dev__agy_fanout'
const LOTE = 'mcp__plugin_lagrange_lagrange__agy_lote'

function uso({ gemini5h = 0.1, gemini7d = 0.1, claude5h = 0, visto = '2026-10-05T11:50:00Z', reset5h = '2026-10-05T14:30:00Z' } = {}) {
  return {
    cuota: {
      antigravity: {
        visto_en: visto,
        grupos: {
          gemini: { ventana_5h: gemini5h, ventana_7d: gemini7d, resetea_5h: reset5h, resetea_7d: '2026-10-07T02:00:00Z' },
          claude_gpt: { ventana_5h: claude5h, ventana_7d: 0, resetea_5h: '2026-10-05T15:00:00Z', resetea_7d: '2026-10-12T00:00:00Z' }
        }
      }
    }
  }
}

// ----------------------------------------------------------------- puro

test('grupoDe y modelosDelPedido: las tres tools, nada más; lote solo al lanzar', () => {
  expect(grupoDe('gemini-3.8-flash')).toBe('gemini')
  expect(grupoDe('Claude-Sonnet-4-6')).toBe('claude_gpt')
  expect(grupoDe('gpt-oss-120b-medium')).toBe('claude_gpt')
  expect(grupoDe('otro')).toBe(null)
  expect(grupoDe(null)).toBe(null)
  expect(modelosDelPedido(RUN, { prompt: 'x' }, 'gemini-3.8-flash')).toEqual({ tool: 'agy_run', modelos: ['gemini-3.8-flash'] })
  expect(modelosDelPedido(RUN, { model: 'claude-sonnet-4-6' }, 'gemini-3.8-flash')?.modelos).toEqual(['claude-sonnet-4-6'])
  expect(modelosDelPedido(FANOUT, { tareas: [{ id: 'a' }, { id: 'b', modelo: 'gpt-oss-120b-medium' }], modelo: 'gemini-3.1-pro' }, null))
    .toEqual({ tool: 'agy_fanout', modelos: ['gemini-3.1-pro', 'gpt-oss-120b-medium'] })
  expect(modelosDelPedido(LOTE, { accion: 'estado' }, 'gemini-3.8-flash')).toBe(null)
  expect(modelosDelPedido(LOTE, { accion: 'lanzar', tareas: [{ id: 'a' }], modelo_auditor: 'claude-opus-4-6' }, 'gemini-3.8-flash')?.modelos)
    .toEqual(['gemini-3.8-flash', 'claude-opus-4-6'])
  for (const t of ['mcp__x__agy_plan', 'mcp__x__agy_review', 'mcp__x__agy_audit', 'mcp__x__agy_research', 'Bash', 'agy_run'])
    expect(modelosDelPedido(t, {}, 'gemini-3.8-flash')).toBe(null)
})

test('modeloPorDefecto: proyecto, global, AGY_MODEL', () => {
  expect(modeloPorDefecto({ model: 'p' }, { model: 'g' }, 'e')).toBe('p')
  expect(modeloPorDefecto({}, { model: 'g' }, 'e')).toBe('g')
  expect(modeloPorDefecto(null, null, 'e')).toBe('e')
  expect(modeloPorDefecto(null, { model: ' ' }, undefined)).toBe(null)
})

test('restantes: la ventana más baja; una vencida se renovó; dato viejo o roto no decide', () => {
  const r = restantes(uso({ gemini5h: 0.85, gemini7d: 0.3 }), AHORA)!
  expect(r.gemini?.ventana).toBe('5 h')
  expect(Math.round((r.gemini?.fraccion ?? 0) * 100)).toBe(15)
  expect(r.gemini?.resetea).toBe(Date.parse('2026-10-05T14:30:00Z'))
  const renovada = restantes(uso({ gemini5h: 0.99, gemini7d: 0.5, reset5h: '2026-10-05T11:00:00Z' }), AHORA)!
  expect(renovada.gemini?.ventana).toBe('semanal')
  expect(renovada.gemini?.fraccion).toBe(0.5)
  expect(restantes(uso({ visto: '2026-10-05T11:29:00Z' }), AHORA)).toBe(null)
  expect(restantes({}, AHORA)).toBe(null)
  expect(restantes(null, AHORA)).toBe(null)
})

test('bajo: umbral estricto del 20 %, el grupo con menos primero; sin grupo conocido no mira', () => {
  const de = (g5h: number, c5h = 0) => restantes(uso({ gemini5h: g5h, claude5h: c5h }), AHORA)
  expect(UMBRAL).toBe(0.2)
  expect(bajo(['gemini-3.8-flash'], de(0.81))?.grupo).toBe('gemini')
  expect(bajo(['gemini-3.8-flash'], de(0.8))).toBe(null)
  expect(bajo(['claude-sonnet-4-6'], de(0.95))).toBe(null)
  expect(bajo(['gemini-3.8-flash', 'claude-sonnet-4-6'], de(0.85, 0.95))?.grupo).toBe('claude_gpt')
  expect(bajo([null, 'otro'], de(1))).toBe(null)
  expect(bajo(['gemini-3.8-flash'], null)).toBe(null)
})

test('pregunta y decision: textos, 0 % sin cuota, Seguir pasa, Cancelar y texto libre niegan', () => {
  const x = bajo(['gemini-3.8-flash'], restantes(uso({ gemini5h: 0.92 }), AHORA))!
  expect(pregunta(x, 'agy_run', 1)).toMatch(/^Queda 8 % en el grupo Gemini de agy \(5 h, se renueva a las \d\d:30\)\. Esto lanza un agy_run\. ¿Seguir\?$/)
  expect(pregunta(x, 'agy_fanout', 3)).toContain('Esto lanza 3 tareas (agy_fanout)')
  const cero = bajo(['gemini-3.8-flash'], restantes(uso({ gemini5h: 1 }), AHORA))!
  expect(estadoDe(cero)).toMatch(/^sin cuota en el grupo Gemini/)
  expect(decision('Seguir', x)).toEqual({ pasar: true })
  expect('deny' in decision('Cancelar', x) && decision('Cancelar', x)).toMatchObject({ deny: expect.stringContaining('Cancelado por el usuario: queda 8 %') })
  expect(decision('esperá a las 15', x)).toEqual({ deny: expect.stringContaining('respondió: esperá a las 15') })
})

// ----------------------------------------------------------------- mod

type Mundo = { archivos: Record<string, unknown>; respuesta: string | null }

function simular(on: On, mundo: Mundo) {
  const visto = { corrio: 0, preguntas: [] as string[] }
  mock.clock(on, { now: AHORA })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ sesion: null }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/u' : undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('fs.read', ($, e) => {
    const ruta = String(e.path).split(String.fromCharCode(92)).join('/') // el motor puede entregarla con barras invertidas
    if (!(ruta in mundo.archivos)) throw new Error('ENOENT')
    return { value: JSON.stringify(mundo.archivos[ruta]) }
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' } as never, ($, e) => {
    const q = (e as unknown as { questions: Array<{ question: string }> }).questions[0].question
    visto.preguntas.push(q)
    if (mundo.respuesta === null) return { deny: 'sin interfaz' } as never
    return { result: { questions: (e as unknown as { questions: unknown }).questions, answers: { [q]: mundo.respuesta } } } as never
  })
  for (const tool of [RUN, FANOUT, LOTE]) on('tool.call', { tool } as never, () => { visto.corrio++; return { result: { content: [{ type: 'text', text: 'ok' }] } } as never })
  return visto
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const iso = (ms: number) => new Date(ms).toISOString()
/** El uso con fechas relativas al reloj del kit: visto hace 10 min, la de 5 h se renueva en 2 h. */
const usoAhora = (ahora: number, g5h: number, vistoHaceMin = 10) => uso({ gemini5h: g5h, visto: iso(ahora - vistoHaceMin * 60_000), reset5h: iso(ahora + 2 * 3_600_000) })
const mundoCon = (u: unknown, respuesta: string | null): Mundo => ({
  archivos: { 'C:/u/.claude/antigravity.json': { model: 'gemini-3.8-flash' }, 'C:/u/.claude/antigravity-usage.json': u },
  respuesta
})

test('mod: cuota de Gemini al 8 % + «Cancelar» → deny con el motivo, la tool no corre', async ($, on) => {
  const visto = simular(on, mundoCon(usoAhora(AHORA, 0.92), 'Cancelar'))
  await $.session.start(inicio as never)
  const r = await $.tool.call({ tool: RUN, prompt: 'hacé algo' } as never)
  expect(visto.preguntas.length).toBe(1)
  expect(visto.preguntas[0]).toContain('Queda 8 % en el grupo Gemini')
  expect(visto.corrio).toBe(0)
  expect(JSON.stringify(r)).toContain('Cancelado por el usuario')
})

test('mod: «Seguir» corre la tool', async ($, on) => {
  const visto = simular(on, mundoCon(usoAhora(AHORA, 0.92), 'Seguir'))
  await $.session.start(inicio as never)
  await $.tool.call({ tool: FANOUT, slug: 's', tareas: [{ id: 'a', prompt: 'x' }, { id: 'b', prompt: 'y' }] } as never)
  expect(visto.preguntas[0]).toContain('Esto lanza 2 tareas (agy_fanout)')
  expect(visto.corrio).toBe(1)
})

test('mod: sin nadie que responda (claude -p) la tool corre igual', async ($, on) => {
  const visto = simular(on, mundoCon(usoAhora(AHORA, 0.92), null))
  await $.session.start(inicio as never)
  await $.tool.call({ tool: RUN, prompt: 'x' } as never)
  expect(visto.corrio).toBe(1)
})

test('mod: cuota sana, dato viejo o agy_lote estado no preguntan', async ($, on) => {
  const ahora = AHORA
  const mundo = mundoCon(usoAhora(ahora, 0.5), 'Cancelar')
  const visto = simular(on, mundo)
  await $.session.start(inicio as never)
  await $.tool.call({ tool: RUN, prompt: 'x' } as never)
  mundo.archivos['C:/u/.claude/antigravity-usage.json'] = usoAhora(ahora, 0.99, 31)
  await $.tool.call({ tool: RUN, prompt: 'x' } as never)
  mundo.archivos['C:/u/.claude/antigravity-usage.json'] = usoAhora(ahora, 0.99)
  await $.tool.call({ tool: LOTE, accion: 'estado' } as never)
  expect(visto.preguntas.length).toBe(0)
  expect(visto.corrio).toBe(3)
})
