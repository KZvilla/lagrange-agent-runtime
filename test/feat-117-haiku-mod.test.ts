import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { clasificar, esCandidata, sumarPaso, sumarSpawn, leerMedicion, textoDeMedicion, MEDICION_VACIA } from '../hooks/haiku-medicion.ts'

/**
 * FEAT-117 fase 1 — La medición de qué pasos podrían ir a Haiku 5.5 (lógica
 * en `hooks/haiku-medicion.ts`, cableado en `hooks/mods.tsx`). Solo cuenta:
 * el modelo de cada paso no cambia.
 */

const USO = (model: string, entrada = 1000, cache = 9000) => ({ input_tokens: entrada, output_tokens: 100, cache_read_input_tokens: cache, cache_creation_input_tokens: 0, model })

// ----------------------------------------------------------------- puro

test('clasificar: cadena de lectura, principal y subagentes', () => {
  expect(clasificar({ tipoAgente: null, enSubagente: false, previas: ['Grep'], pedidas: ['Read', 'Read'] })).toBe('lectura')
  expect(clasificar({ tipoAgente: null, enSubagente: false, previas: null, pedidas: ['Read'] })).toBe('principal')
  expect(clasificar({ tipoAgente: null, enSubagente: false, previas: ['Read'], pedidas: ['Edit'] })).toBe('principal')
  expect(clasificar({ tipoAgente: null, enSubagente: false, previas: ['Read'], pedidas: [] })).toBe('principal')
  expect(clasificar({ tipoAgente: null, enSubagente: false, previas: ['Bash'], pedidas: ['Read'] })).toBe('principal')
  expect(clasificar({ tipoAgente: 'Explore', enSubagente: true, previas: null, pedidas: ['Edit'] })).toBe('sub:Explore')
  expect(clasificar({ tipoAgente: null, enSubagente: true, previas: null, pedidas: [] })).toBe('sub:desconocido')
  expect(esCandidata('lectura') && esCandidata('sub:Explore') && esCandidata('sub:lagrange:agy')).toBe(true)
  expect(esCandidata('principal') || esCandidata('sub:general-purpose')).toBe(false)
})

test('sumar e informar: tokens, caché, modelos y porcentaje candidato', () => {
  let m = sumarPaso(MEDICION_VACIA, 'principal', USO('claude-opus-5-5'), 1000)
  m = sumarPaso(m, 'lectura', USO('claude-opus-5-5'), 2000)
  m = sumarPaso(m, 'lectura', null, 3000)
  m = sumarSpawn(m, 'Explore', 'claude-haiku-5-5', 4000)
  expect(m.desde).toBe(1000)
  expect(m.clases.lectura.pasos).toBe(2)
  expect(m.clases.lectura.cacheLeida).toBe(9000)
  expect(m.clases.lectura.modelos).toEqual({ 'claude-opus-5-5': 1, '?': 1 })
  const t = textoDeMedicion(m, 5000)
  expect(t).toContain('Nada se desvía')
  expect(t).toContain('Candidatos a Haiku 5.5: **50 %**')
  expect(t).toContain('- Explore: claude-haiku-5-5 ×1')
  expect(textoDeMedicion(MEDICION_VACIA, 0)).toContain('Todavía no hay pasos')
  expect(leerMedicion('roto')).toEqual(MEDICION_VACIA)
  expect(leerMedicion({ clases: {}, spawns: {}, desde: 7 }).desde).toBe(7)
})

// ----------------------------------------------------------------- mod

function simular(on: On, store: Record<string, unknown>) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ sesion: null, ok: true, metas: [], transiciones: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/p' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.exists', () => ({ value: false }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => { store[e.key] = e.value; return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: 0 } } as never }))
  on('turn.start', ($, e) => ({ text: e.text, turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
}

const inicio = { cwd: 'C:/p', surface: 'terminal' as const, isInteractive: true }
const haiku = (args = '') => ({ command: 'lagrange-haiku', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never

test('mod: /lagrange-haiku muestra lo acumulado en el store y reiniciar lo vacía', async ($, on) => {
  const reloj = mock.clock(on, { now: 10 * 86_400_000 })
  const previa = sumarPaso(sumarPaso(MEDICION_VACIA, 'lectura', USO('claude-opus-5-5'), 0), 'principal', USO('claude-opus-5-5'), 0)
  const store: Record<string, unknown> = { 'medicion-haiku': previa }
  simular(on, store)
  await $.session.start(inicio as never)
  await reloj.settle()
  const texto = String((await $.command.run(haiku()) as { text?: string }).text)
  expect(texto).toContain('lectura | sí | 1')
  expect(texto).toContain('Candidatos a Haiku 5.5: **50 %**')
  expect(String((await $.command.run(haiku('reiniciar')) as { text?: string }).text)).toContain('reiniciada')
  expect(store['medicion-haiku']).toEqual(MEDICION_VACIA)
})
