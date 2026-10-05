import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { MetaPanel } from '../types'
import { progresoDeMeta, detalleDeMeta, metaSinAprobar, filaDeMeta, textoDeMetas, filasDeFoto } from '../hooks/panel-texto.ts'

/**
 * FEAT-126 — `/meta` y la sección «Metas» (en `hooks/mods.tsx` y
 * `hooks/panel-texto.ts`) con el mundo simulado: `metas.js` lo responde el
 * test (la lógica real está en test/metas.test.js), `$.store` es un objeto y
 * `$.ui.ask` es un `tool.call` de `AskUserQuestion` que contesta el test.
 */

const AHORA = Date.parse('2026-10-05T12:00:00Z')
const estado = (extra: Partial<MetaPanel['estado']> = {}): MetaPanel['estado'] =>
  ({ valor: null, cumplida: false, cumplidaEn: null, enRiesgo: false, riesgoDesde: null, medidoEn: null, error: null, ...extra })
const meta = (extra: Partial<MetaPanel> = {}): MetaPanel => ({
  id: 'g_1', nombre: 'Major', tipo: 'conteo', creada: '2026-10-01T12:00:00Z', fin: null, objetivo: 20,
  medir: ['git', 'rev-list', '--count', 'main..next/v1'], riesgo: null, estado: estado({ valor: 5 }), hashes: ['h1'], ...extra
})

// ----------------------------------------------------------------- puro

test('progreso y detalle: conteo, fecha, condición y cumplida', () => {
  expect(progresoDeMeta(meta(), AHORA)).toBe(0.25)
  expect(detalleDeMeta(meta(), AHORA)).toBe('5/20')
  const fecha = meta({ tipo: 'fecha', fin: '2026-10-09T12:00:00Z', medir: null, objetivo: null, hashes: [] })
  expect(progresoDeMeta(fecha, AHORA)).toBe(0.5)
  expect(detalleDeMeta(fecha, AHORA)).toBe('faltan 4 d 0 h')
  expect(detalleDeMeta({ ...fecha, fin: '2026-10-05T15:30:00Z' }, AHORA)).toBe('faltan 3 h 30 min')
  const cond = meta({ tipo: 'condicion', objetivo: null })
  expect(detalleDeMeta(cond, AHORA)).toBe('pendiente')
  expect(progresoDeMeta(meta({ estado: estado({ cumplida: true }) }), AHORA)).toBe(1)
  expect(detalleDeMeta(meta({ estado: estado({ cumplida: true }) }), AHORA)).toBe('cumplida')
})

test('fila: sin aprobar, en riesgo y error; el texto de /meta lleva id y comandos', () => {
  expect(metaSinAprobar(meta(), [])).toBe(true)
  expect(metaSinAprobar(meta(), ['h1'])).toBe(false)
  expect(metaSinAprobar(meta({ hashes: [] }), [])).toBe(false)
  const txt = (m: MetaPanel, p: string[]) => filaDeMeta(m, AHORA, p).map((x) => x.texto).join('')
  expect(txt(meta(), [])).toContain('sin aprobar (/meta aprobar g_1)')
  expect(txt(meta({ estado: estado({ valor: 5, enRiesgo: true }) }), ['h1'])).toContain('⚠ en riesgo')
  expect(txt(meta({ estado: estado({ error: 'salió con 1' }) }), ['h1'])).toContain('salió con 1')
  expect(txt(meta(), ['h1'])).toBe('Major ███░░░░░░░ 5/20')
  const todo = textoDeMetas([meta({ riesgo: ['node', 'r.js'] })], AHORA, ['h1'])
  expect(todo).toContain('g_1 · Major')
  expect(todo).toContain('mide: git rev-list --count main..next/v1')
  expect(todo).toContain('riesgo: node r.js')
  expect(textoDeMetas([], AHORA, [])).toContain('No hay metas')
})

test('panel: la sección «Metas» solo con metas', () => {
  const titulos = (f: unknown) => filasDeFoto(f as never, AHORA, { metasPermitidos: ['h1'] }).map((b) => b.titulo)
  expect(titulos({ fanout: null, cuota: null, versiones: null })).not.toContain('Metas')
  expect(titulos({ fanout: null, cuota: null, versiones: null, metas: [meta()] })).toContain('Metas')
})

// ----------------------------------------------------------------- mod

type Mundo = { metas: MetaPanel[]; transiciones?: Array<{ id: string; nombre: string; tipo: string }>; crear?: Record<string, unknown>; respuesta?: string | null; store?: Record<string, unknown> }

function simular(on: On, mundo: Mundo) {
  const visto = { pedidos: [] as Array<Record<string, unknown>>, toasts: [] as string[], preguntas: [] as string[], store: mundo.store ?? {} as Record<string, unknown> }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const script = String(e.argv[1])
    const out = (v: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(v), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (!script.endsWith('metas.js')) return out(script.endsWith('buzon.js') ? { sesion: null } : {})
    const pedido = JSON.parse(String(e.init?.stdin ?? '{}'))
    visto.pedidos.push(pedido)
    if (pedido.accion === 'crear') return out(mundo.crear ?? { ok: true, meta: meta({ id: 'g_new' }), hashes: ['h_new'] })
    if (pedido.accion === 'borrar') return out({ ok: true, meta: meta(), huerfanos: ['h1'] })
    if (pedido.accion === 'medir') return out({ ok: true, metas: mundo.metas, transiciones: mundo.transiciones ?? [] })
    return out({ ok: true, metas: mundo.metas })
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/p' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.exists', () => ({ value: false }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { visto.toasts.push(String((e as { text?: string }).text ?? e)); return { value: undefined } })
  on('store.get', ($, e) => ({ value: visto.store[e.key] }))
  on('store.set', ($, e) => { visto.store[e.key] = e.value; return { value: undefined } })
  on('tool.call', { tool: 'AskUserQuestion' } as never, ($, e) => {
    const q = (e as unknown as { questions: Array<{ question: string }> }).questions[0].question
    visto.preguntas.push(q)
    if (mundo.respuesta == null) return { deny: 'sin interfaz' } as never
    return { result: { questions: (e as unknown as { questions: unknown }).questions, answers: { [q]: mundo.respuesta } } } as never
  })
  return visto
}

const inicio = { cwd: 'C:/p', surface: 'terminal' as const, isInteractive: true }
const comando = (args: string) => ({ command: 'meta', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never
const texto = (r: unknown) => String((r as { text?: string }).text)

test('mod: al arrancar mide con los aprobados de la cuenta; una transición da un toast', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const visto = simular(on, { metas: [meta()], transiciones: [{ id: 'g_1', nombre: 'Major', tipo: 'cumplida' }], store: { 'metas-permitidos': ['h1'] } })
  await $.session.start(inicio as never)
  await reloj.settle()
  const medir = visto.pedidos.find((p) => p.accion === 'medir')
  expect(medir).toEqual({ cwd: 'C:/p', accion: 'medir', permitidos: ['h1'] })
  expect(visto.toasts).toContain('🎯 Meta «Major» cumplida')
})

test('mod: con metas pendientes vuelve a medir cada 5 min', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const visto = simular(on, { metas: [meta()] })
  await $.session.start(inicio as never)
  await reloj.settle()
  await reloj.advance(5 * 60 * 1000)
  expect(visto.pedidos.filter((p) => p.accion === 'medir').length).toBe(2)
})

test('mod: sin metas pendientes no vuelve a medir', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const visto = simular(on, { metas: [meta({ estado: estado({ cumplida: true }) })] })
  await $.session.start(inicio as never)
  await reloj.settle()
  await reloj.advance(15 * 60 * 1000)
  expect(visto.pedidos.filter((p) => p.accion === 'medir').length).toBe(1)
})

test('mod: /meta conteo crea y aprueba su comando en esta cuenta', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const visto = simular(on, { metas: [], store: { 'metas-permitidos': ['viejo'] } })
  await $.session.start(inicio as never)
  await reloj.settle()
  const r = await $.command.run(comando('conteo "Major" 20 -- git rev-list --count main..next/v1'))
  expect(texto(r)).toContain('Meta g_new «Major» creada; su comando quedó aprobado')
  expect(visto.pedidos.find((p) => p.accion === 'crear')?.args).toBe('conteo "Major" 20 -- git rev-list --count main..next/v1')
  expect(visto.store['metas-permitidos']).toEqual(['viejo', 'h_new'])
})

test('mod: /meta aprobar pregunta con el comando; «Aprobar» lo suma, «No» no', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const mundo: Mundo = { metas: [meta()], respuesta: 'No' }
  const visto = simular(on, mundo)
  await $.session.start(inicio as never)
  await reloj.settle()
  expect(texto(await $.command.run(comando('aprobar g_1')))).toContain('sigue sin aprobar')
  expect(visto.preguntas[0]).toContain('«git rev-list --count main..next/v1» cada 5 min')
  expect(visto.store['metas-permitidos']).toBeUndefined()
  mundo.respuesta = 'Aprobar'
  expect(texto(await $.command.run(comando('aprobar g_1')))).toContain('aprobada en esta cuenta')
  expect(visto.store['metas-permitidos']).toEqual(['h1'])
  expect(texto(await $.command.run(comando('aprobar g_1')))).toContain('ya está aprobada')
  expect(texto(await $.command.run(comando('aprobar g_x')))).toContain('No hay una meta g_x')
})

test('mod: /meta borrar saca los hashes huérfanos; /meta lista; /meta ayuda', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const visto = simular(on, { metas: [meta()], store: { 'metas-permitidos': ['h1', 'otro'] } })
  await $.session.start(inicio as never)
  await reloj.settle()
  expect(texto(await $.command.run(comando('borrar g_1')))).toBe('Meta g_1 borrada.')
  expect(visto.store['metas-permitidos']).toEqual(['otro'])
  expect(texto(await $.command.run(comando('')))).toContain('g_1 · Major')
  expect(texto(await $.command.run(comando('ayuda')))).toContain('--riesgo')
  expect(texto(await $.command.run(comando('cualquiera')))).toContain('Metas del proyecto')
})
