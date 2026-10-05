import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import casos from './fixtures/identidad-casos.mjs'
import { resolverCuenta, validarIdentidad, identidadDeConfig, etiquetaDe, sufijoConIdentidad } from '../hooks/identidad.ts'

/**
 * FEAT-123 — La copia TS de la regla (`hooks/identidad.ts`) contra la tabla que
 * comparte con `mcp-server/lib/identidad-sesion.js`, y el mod: la cuenta al
 * final del spinner, con `antigravity.json`, el entorno y el reloj simulados.
 */

// ------------------------------------------------------------------ paridad

test('resolverCuenta: la tabla compartida', () => {
  for (const c of casos.resolver) expect(resolverCuenta({ configDir: c.configDir, home: casos.home, cuentas: casos.cuentas })).toBe(c.cuenta)
  for (const c of casos.resolverSinCuentas) {
    for (const cuentas of [undefined, null, 3, []]) expect(resolverCuenta({ configDir: c.configDir, home: casos.home, cuentas })).toBe(c.cuenta)
  }
})

test('validarIdentidad: la tabla compartida', () => {
  for (const c of casos.validar) expect(validarIdentidad(c.crudo)).toEqual(c.identidad)
})

test('identidadDeConfig: la tabla compartida', () => {
  for (const c of casos.deConfig) expect(identidadDeConfig(c.config, { configDir: c.configDir, home: casos.home })).toEqual(c.identidad)
})

test('etiqueta y sufijo: el separador va siempre; con sufijo previo, después de él', () => {
  const spica = { nombre: 'Spica', emblema: '✦', color: null }
  expect(etiquetaDe(spica)).toBe('✦  Spica')
  expect(sufijoConIdentidad(undefined, spica)).toBe(' · ✦  Spica')
  expect(sufijoConIdentidad('', spica)).toBe(' · ✦  Spica')
  expect(sufijoConIdentidad(' · tool calls: 3…', spica)).toBe(' · tool calls: 3… · ✦  Spica')
  expect(sufijoConIdentidad(undefined, { nombre: 'Epikouros', emblema: null, color: 'verde' })).toBe(' · Epikouros')
})

// ------------------------------------------------------------------ mod

const HOME = 'C:/Users/u'
const CONFIG = {
  motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } } },
  identidad_sesion: { principal: { nombre: 'Spica', emblema: '✦', color: 'cian' }, trabajo: { nombre: 'Epikouros', emblema: '☘' } }
}

type Archivo = { texto: string | null; mtimeMs: number }

function simular(on: On, archivo: Archivo, { configDir }: { configDir?: string } = {}) {
  const visto = { props: [] as Array<Record<string, unknown>>, invalidaciones: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? HOME : e.name === 'CLAUDE_CONFIG_DIR' ? configDir : undefined }))
  on('fs.stat', ($, e) => (String(e.path).endsWith('antigravity.json') && archivo.texto !== null
    ? { value: { kind: 'file' as const, size: archivo.texto.length, mtimeMs: archivo.mtimeMs, isLink: false } }
    : { deny: 'ENOENT' }))
  on('fs.read', () => (archivo.texto === null ? { deny: 'ENOENT' } : { value: archivo.texto }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => { visto.invalidaciones += 1; return { value: undefined } })
  // El motor: lo que llega a `next(e)` es lo que dibujaría.
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    visto.props.push({ ...e.props })
    const { Text } = $.ui.resolve(e)
    return <Text>{String(e.props.word ?? '')}</Text>
  })
  return visto
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const SPINNER = { word: 'Thinking', message: '', mode: 'thinking' }
const montar = ($: Parameters<Parameters<typeof test>[1]>[0], props: Record<string, unknown> = SPINNER) =>
  $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Spinner', props } as never)
const ultimo = (visto: { props: Array<Record<string, unknown>> }) => visto.props[visto.props.length - 1]

test('mod: la cuenta principal (sin CLAUDE_CONFIG_DIR) agrega · ✦  Spica; el resto de las props intacto', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { texto: JSON.stringify(CONFIG), mtimeMs: 1 })
  await $.session.start(inicio)
  await reloj.settle()
  await montar($)
  expect(ultimo(visto)).toEqual({ ...SPINNER, suffix: ' · ✦  Spica' })
})

test('mod: con el CLAUDE_CONFIG_DIR de trabajo, · ☘  Epikouros; con sufijo previo, después de él', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { texto: JSON.stringify(CONFIG), mtimeMs: 1 }, { configDir: 'C:\\Users\\u\\.claude-work' })
  await $.session.start(inicio)
  await reloj.settle()
  await montar($, { ...SPINNER, suffix: ' · 3 tools' })
  expect(ultimo(visto).suffix).toBe(' · 3 tools · ☘  Epikouros')
})

test('mod: sin identidad_sesion, sin entrada para la cuenta o con JSON roto, las props llegan intactas', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const archivo: Archivo = { texto: JSON.stringify({ model: 'x' }), mtimeMs: 1 }
  const visto = simular(on, archivo, { configDir: 'D:/otra' })
  await $.session.start(inicio)
  await reloj.settle()
  await montar($)
  expect(ultimo(visto)).toEqual(SPINNER)
  archivo.texto = '{ roto'
  archivo.mtimeMs = 2
  await reloj.advance(10_000)
  await montar($)
  expect(ultimo(visto)).toEqual(SPINNER)
})

test('mod: cambiar la config se ve sin recargar; quitar la clave vuelve a como estaba', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const archivo: Archivo = { texto: JSON.stringify(CONFIG), mtimeMs: 1 }
  const visto = simular(on, archivo)
  await $.session.start(inicio)
  await reloj.settle()
  await montar($)
  expect(ultimo(visto).suffix).toBe(' · ✦  Spica')
  const antes = visto.invalidaciones
  archivo.texto = JSON.stringify({ ...CONFIG, identidad_sesion: { principal: { nombre: 'Spica', emblema: '★' } } })
  archivo.mtimeMs = 2
  await reloj.advance(10_000)
  expect(visto.invalidaciones).toBeGreaterThan(antes)
  await montar($)
  expect(ultimo(visto).suffix).toBe(' · ★  Spica')
  archivo.texto = JSON.stringify({ model: 'x' })
  archivo.mtimeMs = 3
  await reloj.advance(10_000)
  await montar($)
  expect(ultimo(visto)).toEqual(SPINNER)
})
