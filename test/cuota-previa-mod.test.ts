import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { grupoDe, modelosDelPedido, modeloPorDefecto, restantes, bajo, pregunta, decision, estadoDe, UMBRAL, cuentasClaudeOfrecibles, opcionClaude } from '../hooks/cuota-previa.ts'

/**
 * FEAT-111 — Preguntar antes de lanzar agy con la cuota del grupo baja (en
 * `hooks/mods.tsx`, dentro del hook de FEAT-109). El mundo es simulado: el
 * home y sus archivos los da el test, la tool de agy la responde el test y el
 * diálogo de `$.ui.ask` es un `tool.call` de `AskUserQuestion` que contesta el
 * test (o nadie: entonces el ask rechaza y la llamada pasa).
 */

const AHORA = Date.parse('2026-10-05T12:00:00Z')
const RUN = 'mcp__plugin_lagrange_lagrange__run'
const FANOUT = 'mcp__lagrange-dev__fanout'
const LOTE = 'mcp__plugin_lagrange_lagrange__batch'

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
  expect(modelosDelPedido(RUN, { prompt: 'x' }, 'gemini-3.8-flash')).toEqual({ tool: 'run', modelos: ['gemini-3.8-flash'] })
  expect(modelosDelPedido(RUN, { model: 'claude-sonnet-4-6' }, 'gemini-3.8-flash')?.modelos).toEqual(['claude-sonnet-4-6'])
  expect(modelosDelPedido(FANOUT, { tasks: [{ id: 'a' }, { id: 'b', model: 'gpt-oss-120b-medium' }], model: 'gemini-3.1-pro' }, null))
    .toEqual({ tool: 'fanout', modelos: ['gemini-3.1-pro', 'gpt-oss-120b-medium'] })
  expect(modelosDelPedido(LOTE, { action: 'status' }, 'gemini-3.8-flash')).toBe(null)
  expect(modelosDelPedido(LOTE, { action: 'launch', tasks: [{ id: 'a' }], auditor_model: 'claude-opus-4-6' }, 'gemini-3.8-flash')?.modelos)
    .toEqual(['gemini-3.8-flash', 'claude-opus-4-6'])
  for (const t of ['mcp__lagrange__plan', 'mcp__lagrange__review', 'mcp__lagrange__audit', 'mcp__lagrange__research', 'Bash', 'run', 'mcp__x__run', 'mcp__lagrange__' + 'agy_run'])
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

test('BE-138: Argon es su propio grupo, solo semanal; Gemini bajo no lo frena', () => {
  const conArgon = (argon7d: number, gemini5h = 0.1) => {
    const u = uso({ gemini5h }) as { cuota: { antigravity: { grupos: Record<string, unknown> } } }
    u.cuota.antigravity.grupos.argon = { ventana_5h: null, ventana_7d: argon7d, resetea_5h: null, resetea_7d: '2026-10-12T04:00:00Z' }
    return restantes(u, AHORA)
  }
  expect(grupoDe('gemini-4-argon-high')).toBe('argon')
  expect(conArgon(0.85)?.argon).toMatchObject({ grupo: 'argon', fraccion: 0.15, ventana: 'semanal' })
  expect(bajo(['gemini-4-argon-high'], conArgon(0.01, 0.95))).toBe(null)
  const x = bajo(['gemini-4-argon-high'], conArgon(0.85))!
  expect(pregunta(x, 'run', 1)).toMatch(/^Queda 15 % en el grupo Gemini 4 Argon de agy \(semanal/)
})

test('pregunta y decision: textos, 0 % sin cuota, Seguir pasa, Cancelar y texto libre niegan', () => {
  const x = bajo(['gemini-3.8-flash'], restantes(uso({ gemini5h: 0.92 }), AHORA))!
  expect(pregunta(x, 'run', 1)).toMatch(/^Queda 8 % en el grupo Gemini de agy \(5 h, se renueva a las \d\d:30\)\. Esto lanza un run\. ¿Seguir\?$/)
  expect(pregunta(x, 'fanout', 3)).toContain('Esto lanza 3 tareas (fanout)')
  const cero = bajo(['gemini-3.8-flash'], restantes(uso({ gemini5h: 1 }), AHORA))!
  expect(estadoDe(cero)).toMatch(/^sin cuota en el grupo Gemini/)
  expect(decision('Seguir', x)).toEqual({ pasar: true })
  expect('deny' in decision('Cancelar', x) && decision('Cancelar', x)).toMatchObject({ deny: expect.stringContaining('Cancelado por el usuario: queda 8 %') })
  expect(decision('esperá a las 15', x)).toEqual({ deny: expect.stringContaining('respondió: esperá a las 15') })
})

// ----------------------------------------------------------------- mod

type Mundo = { archivos: Record<string, unknown>; respuesta: string | null; env?: Record<string, string> }

function simular(on: On, mundo: Mundo) {
  const visto = { corrio: 0, preguntas: [] as string[], opciones: [] as string[][] }
  mock.clock(on, { now: AHORA })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ sesion: null }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/u' : mundo.env?.[e.name] }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('fs.read', ($, e) => {
    const ruta = String(e.path).split(String.fromCharCode(92)).join('/') // el motor puede entregarla con barras invertidas
    if (!(ruta in mundo.archivos)) throw new Error('ENOENT')
    return { value: JSON.stringify(mundo.archivos[ruta]) }
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' } as never, ($, e) => {
    const pregunta0 = (e as unknown as { questions: Array<{ question: string; options?: Array<{ label: string }> }> }).questions[0]
    const q = pregunta0.question
    visto.preguntas.push(q)
    visto.opciones.push((pregunta0.options || []).map((o) => o.label))
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
  await $.tool.call({ tool: FANOUT, slug: 's', tasks: [{ id: 'a', prompt: 'x' }, { id: 'b', prompt: 'y' }] } as never)
  expect(visto.preguntas[0]).toContain('Esto lanza 2 tareas (fanout)')
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
  await $.tool.call({ tool: LOTE, action: 'status' } as never)
  expect(visto.preguntas.length).toBe(0)
  expect(visto.corrio).toBe(3)
})

// ----------------------------------------------------------------- FEAT-131

const SONDAS_OK = { cuentas: { trabajo: { ok: true, huella: 'claude 2.1.292 · lagrange 1.5.0' }, rota: { ok: false } } }
const conClaude = (base: unknown, usado: number, vistoHaceMin = 10) => ({
  ...(base as object),
  cuota: { ...((base as { cuota: object }).cuota), 'claude@trabajo': { ventana_5h: usado, resetea_5h: iso(AHORA + 3_600_000), visto_en: iso(AHORA - vistoHaceMin * 60_000) } }
})

test('FEAT-131 puro: un lote con motor claude no mira la cuota de agy de sus tareas', () => {
  expect(modelosDelPedido(LOTE, { action: 'launch', engine: 'claude@trabajo', tasks: [{ id: 'a', model: 'claude-sonnet-5' }] }, 'gemini-3.8-flash')).toEqual({ tool: 'batch', modelos: [] })
  expect(modelosDelPedido(LOTE, { action: 'launch', engine: 'claude@trabajo', tasks: [{ id: 'a' }], auditor_model: 'gemini-3.1-pro' }, null)?.modelos).toEqual(['gemini-3.1-pro'])
})

test('FEAT-131 puro: se ofrece la cuenta con sondas en verde y 5 h sana; si falta un dato, no', () => {
  const u = conClaude(usoAhora(AHORA, 0.95), 0.45)
  expect(cuentasClaudeOfrecibles('batch', SONDAS_OK, u, AHORA)).toEqual(['trabajo'])
  expect(cuentasClaudeOfrecibles('run', SONDAS_OK, u, AHORA)).toEqual([])
  expect(cuentasClaudeOfrecibles('batch', null, u, AHORA)).toEqual([])
  expect(cuentasClaudeOfrecibles('batch', SONDAS_OK, conClaude(usoAhora(AHORA, 0.95), 0.85), AHORA)).toEqual([])
  expect(cuentasClaudeOfrecibles('batch', SONDAS_OK, conClaude(usoAhora(AHORA, 0.95), 0.1, 7 * 60), AHORA)).toEqual([])
  expect(cuentasClaudeOfrecibles('batch', SONDAS_OK, usoAhora(AHORA, 0.95), AHORA)).toEqual([])
  const x = bajo(['gemini-3.8-flash'], restantes(usoAhora(AHORA, 0.95), AHORA))!
  const d = decision(opcionClaude('trabajo'), x, ['trabajo'])
  expect('deny' in d && d.deny).toContain('engine: "claude@trabajo"')
  expect(decision(opcionClaude('trabajo'), x, [])).toEqual({ deny: expect.stringContaining('respondió: Usar claude@trabajo') })
})

test('mod FEAT-131: agy_lote con Gemini bajo ofrece claude@trabajo y elegirlo niega con el relanzamiento', async ($, on) => {
  const mundo = { ...mundoCon(conClaude(usoAhora(AHORA, 0.95), 0.45), opcionClaude('trabajo')), env: { LOCALAPPDATA: 'C:/l' } }
  mundo.archivos['C:/l/antigravity-telegram-bridge/lotes-sondas-claude.json'] = SONDAS_OK
  const visto = simular(on, mundo)
  await $.session.start(inicio as never)
  const r = await $.tool.call({ tool: LOTE, action: 'launch', slug: 's', tasks: [{ id: 'a', prompt: 'x', files: ['a'] }] } as never)
  expect(visto.opciones[0]).toEqual(['Seguir', 'Usar claude@trabajo', 'Cancelar'])
  expect(visto.corrio).toBe(0)
  expect(JSON.stringify(r)).toContain('claude@trabajo')
})
