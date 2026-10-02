import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { leerArgs, promptDeResumen, validarResumen, archivoDeResumen, ramaDeHead, gitdirDe, pieDeCosto, textoDeEstimacion } from '../hooks/resumen-texto.ts'

/**
 * FEAT-103 — `/lagrange-resumen`: lo puro (`hooks/resumen-texto.ts`) y el
 * comando (en `hooks/mods.tsx`) con `model.fork`, la sesión y el disco
 * simulados. Lo de los otros mods responde vacío.
 */

const META = { sessionId: '4eee260b-b03c-4980-a783-98b3a917aed2', proyecto: 'C:/repo', rama: 'next/v1', modelo: 'claude-opus-5-5', inicio: Date.parse('2026-10-02T09:00:00Z'), fin: Date.parse('2026-10-02T15:00:00Z') }
const DOCUMENTO = `# Resumen de la sesión\n\n## 1. Resumen ejecutivo\n${'Se trabajó en los mods de Lagrange. '.repeat(20)}\n\n## 2. Decisiones\n- Acumular en next/v1.\n`
const USO = { input_tokens: 69, output_tokens: 755, cache_read_input_tokens: 616675, cache_creation_input_tokens: 220 }

// ------------------------------------------------------------------ puro

test('leerArgs: foco, confirmación con si o sí, y foco inválido', () => {
  expect(leerArgs('')).toEqual({ foco: 'full', valido: true, confirmado: false })
  expect(leerArgs('decisions si')).toEqual({ foco: 'decisions', valido: true, confirmado: true })
  expect(leerArgs('sí handoff')).toEqual({ foco: 'handoff', valido: true, confirmado: true })
  expect(leerArgs('otro').valido).toBe(false)
})

test('el prompt no menciona las secciones del preprocesado y trae los datos verificados', () => {
  const p = promptDeResumen('full', META)
  for (const viejo of ['Final State', 'Derived Facts', 'Session timeline']) expect(p.includes(viejo)).toBe(false)
  expect(p).toContain('Session id: 4eee260b-b03c-4980-a783-98b3a917aed2')
  expect(p).toContain('Rama: next/v1')
  expect(p).toContain('Inicio: 2026-10-02T09:00:00.000Z')
  expect(promptDeResumen('full', { ...META, rama: null, inicio: null })).toContain('Rama: [no disponible]')
  expect(promptDeResumen('handoff', META)).toContain('### 7. Prompt para iniciar la sesión nueva')
})

test('validarResumen: un documento corto o con un solo encabezado no vale', () => {
  expect(validarResumen(DOCUMENTO).ok).toBe(true)
  expect(validarResumen('# corto').ok).toBe(false)
  expect(validarResumen(`# Uno solo\n${'x'.repeat(500)}`).ok).toBe(false)
  expect(validarResumen('').ok).toBe(false)
})

test('archivo con el id saneado, como saveSummary; rama de HEAD y de gitdir', () => {
  expect(archivoDeResumen('C:/Users/u/', META)).toBe('C:/Users/u/.claude/session-summaries/2026-10-02-4eee260b-fork.md')
  expect(archivoDeResumen('C:/Users/u', { ...META, sessionId: '../../x!y' })).toBe('C:/Users/u/.claude/session-summaries/2026-10-02-xy-fork.md')
  expect(ramaDeHead('ref: refs/heads/next/v1\n')).toBe('next/v1')
  expect(ramaDeHead('3f2a9c1e')).toBeNull()
  expect(gitdirDe('gitdir: C:/repo/.git/worktrees/x\n')).toBe('C:/repo/.git/worktrees/x')
})

test('pie de costo y estimación sin tokens', () => {
  expect(pieDeCosto(USO)).toBe('— $.model.fork: 616675 tokens leídos de caché, 289 nuevos, 755 de salida.')
  expect(pieDeCosto(undefined)).toBe('— $.model.fork: 0 tokens leídos de caché, 0 nuevos, 0 de salida.')
  expect(textoDeEstimacion('full', undefined, 'opus')).toContain('[no disponible] tokens')
})

// ------------------------------------------------------------------ mod

type Mundo = { fork: unknown; home?: string | null; tokens?: number }

function simular(on: On, mundo: Mundo) {
  const visto = { forks: 0, escritos: [] as Array<{ path: string; text: string }> }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const cuerpo = String(e.argv[1]).endsWith('buzon.js') ? { sesion: null } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(cuerpo), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('session.id', () => ({ value: META.sessionId }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: META.inicio, context: { tokens: mundo.tokens, window: 1_000_000 }, rateLimits: [] } }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  // El motor normaliza las rutas a las barras de la plataforma.
  const ruta = (p: unknown) => String(p).replace(/\\/g, '/')
  on('fs.stat', ($, e) => (ruta(e.path).endsWith('/.git') ? { value: { kind: 'dir' as const, size: 0, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', ($, e) => (ruta(e.path).endsWith('/.git/HEAD') ? { value: 'ref: refs/heads/next/v1\n' } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => { visto.escritos.push({ path: String(e.path).replace(/\\/g, '/'), text: String(e.text) }); return { value: undefined } })
  // Sin home las guardas quedan inertes; el resumen usa el mismo env.get.
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' && mundo.home ? mundo.home : undefined }))
  on('model.fork', () => { visto.forks += 1; return { value: mundo.fork } })
  return visto
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const comando = (args: string) => ({ command: 'lagrange-resumen', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never
const texto = (r: unknown) => String((r as { text?: string }).text)

test('sin si: solo estima, sin fork', async ($, on) => {
  const reloj = mock.clock(on, { now: META.fin })
  const visto = simular(on, { fork: null, home: 'C:/Users/u', tokens: 616000 })
  await $.session.start(inicio)
  await reloj.settle()
  const r = texto(await $.command.run(comando('decisions')))
  expect(visto.forks).toBe(0)
  expect(r).toContain('~616000 tokens de contexto')
  expect(r).toContain('/lagrange-resumen decisions si')
})

test('con si y un documento válido: lo guarda con frontmatter y devuelve la ruta y el costo, sin el documento', async ($, on) => {
  const reloj = mock.clock(on, { now: META.fin })
  const visto = simular(on, { fork: { isAnswered: true, text: DOCUMENTO, usage: USO }, home: 'C:/Users/u' })
  await $.session.start(inicio)
  await reloj.settle()
  const r = texto(await $.command.run(comando('decisions si')))
  expect(visto.forks).toBe(1)
  expect(visto.escritos.length).toBe(1)
  expect(visto.escritos[0].path).toBe('C:/Users/u/.claude/session-summaries/2026-10-02-4eee260b-fork.md')
  expect(visto.escritos[0].text).toContain('summarized_by: "lagrange-resumen (model.fork)"')
  expect(visto.escritos[0].text).toContain('branch: "next/v1"')
  expect(visto.escritos[0].text).toContain('## 2. Decisiones')
  expect(r).toContain('2026-10-02-4eee260b-fork.md')
  expect(r).toContain('616675 tokens leídos de caché')
  expect(r.includes('Se trabajó en los mods')).toBe(false)
})

test('un documento que no valida no se guarda; el costo igual se ve', async ($, on) => {
  const reloj = mock.clock(on, { now: META.fin })
  const visto = simular(on, { fork: { isAnswered: true, text: '# corto', usage: USO }, home: 'C:/Users/u' })
  await $.session.start(inicio)
  await reloj.settle()
  const r = texto(await $.command.run(comando('si')))
  expect(visto.escritos.length).toBe(0)
  expect(r).toContain('No se guardó el resumen')
  expect(r).toContain('616675 tokens leídos de caché')
})

test('nothing-to-fork: el motivo y el pie, sin escribir', async ($, on) => {
  const reloj = mock.clock(on, { now: META.fin })
  const visto = simular(on, { fork: { isAnswered: false, reason: 'nothing-to-fork', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, home: 'C:/Users/u' })
  await $.session.start(inicio)
  await reloj.settle()
  const r = texto(await $.command.run(comando('full si')))
  expect(visto.escritos.length).toBe(0)
  expect(r).toContain('todavía no hay conversación para resumir')
  expect(r).toContain('— $.model.fork:')
})

test('sin home no escribe; un foco inválido no hace fork', async ($, on) => {
  const reloj = mock.clock(on, { now: META.fin })
  const visto = simular(on, { fork: { isAnswered: true, text: DOCUMENTO, usage: USO }, home: null })
  await $.session.start(inicio)
  await reloj.settle()
  expect(texto(await $.command.run(comando('full si')))).toContain('no se encontró la carpeta del usuario')
  expect(visto.escritos.length).toBe(0)
  const forksAntes = visto.forks
  expect(texto(await $.command.run(comando('nada si')))).toContain('Foco desconocido')
  expect(visto.forks).toBe(forksAntes)
})
