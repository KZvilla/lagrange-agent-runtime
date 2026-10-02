import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { validarGuardas, guardaQueFrena, palabrasDe, coincide } from '../hooks/guardas.ts'

/**
 * FEAT-102 — Las guardas: la parte pura (`hooks/guardas.ts`) y el mod (en
 * `hooks/mods.tsx`) con `antigravity.json`, el disco y el reloj simulados. Lo
 * del buzón y el panel responde vacío.
 */

const RAIZ = 'C:/vs work/repo'
const P3 = { secuencia: ['git', 'switch', 'main'], motivo: 'P3: el daemon corre desde este checkout', raiz: RAIZ }
const NODE = { secuencia: ['stop-process', '*', 'node'], motivo: 'mata el daemon y los MCP de Lagrange' }
const { guardas: REGLAS } = validarGuardas([P3, NODE])
const ahora = Date.parse('2026-10-05T00:00:00Z')
const frena = (comando: string, raiz = RAIZ) => guardaQueFrena(REGLAS, { comando, raiz, ahora })

// ------------------------------------------------------------------ puro

test('validarGuardas descarta lo inválido y deja lo válido', () => {
  const r = validarGuardas([
    P3,
    { secuencia: [], motivo: 'x' },
    { secuencia: [''], motivo: 'x' },
    { secuencia: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], motivo: 'x' },
    { secuencia: ['x'.repeat(81)], motivo: 'x' },
    { secuencia: ['*'], motivo: 'solo comodín' },
    { secuencia: ['git'], motivo: 'm'.repeat(201) },
    { secuencia: ['git'], motivo: 'x', vence: 'mañana' },
    { secuencia: ['git'], motivo: 'x', raiz: '' },
    'no es objeto'
  ])
  expect(r.guardas.length).toBe(1)
  expect(r.descartadas).toBe(9)
  expect(validarGuardas('no es array')).toEqual({ guardas: [], descartadas: 0 })
})

test('una palabra con espacios se parte, no se descarta', () => {
  const r = validarGuardas([{ secuencia: ['git push'], motivo: 'major' }])
  expect(r.guardas[0]?.secuencia).toEqual(['git', 'push'])
})

test('palabras enteras y contiguas, sin distinguir mayúsculas', () => {
  expect(frena('git switch main')?.motivo).toBe(P3.motivo)
  expect(frena('GIT Switch MAIN')).not.toBeNull()
  expect(frena('git switch main-nueva')).toBeNull()
  expect(frena('git switch feat/main')).toBeNull()
  expect(frena('git main switch')).toBeNull()
  expect(guardaQueFrena(validarGuardas([{ secuencia: ['rm'], motivo: 'x' }]).guardas, { comando: 'npm run format', raiz: RAIZ, ahora })).toBeNull()
  expect(guardaQueFrena(validarGuardas([{ secuencia: ['git', 'push'], motivo: 'x' }]).guardas, { comando: 'git stash push -m wip', raiz: RAIZ, ahora })).toBeNull()
})

test('envoltorios, comillas, barras invertidas y separadores de shell', () => {
  expect(frena('bash -c "git switch main"')).not.toBeNull()
  expect(frena('git switch ma""in')).not.toBeNull()
  expect(frena('g\\it switch main')).not.toBeNull()
  expect(frena('cd x && git switch main; echo ok')).not.toBeNull()
  expect(frena('(git switch main)')).not.toBeNull()
})

test('el comodín acepta palabras en el medio', () => {
  expect(frena('Stop-Process -Name node -Force')?.motivo).toBe(NODE.motivo)
  expect(frena('Stop-Process node')).not.toBeNull()
  expect(frena('Get-Process node')).toBeNull()
  expect(coincide(['a', '*', 'c'], palabrasDe('c b a'))).toBe(false)
})

test('raiz: otra carpeta no; la misma con \\, mayúsculas y barra final sí', () => {
  expect(frena('git switch main', 'C:/otro')).toBeNull()
  expect(frena('git switch main', 'c:\\VS WORK\\repo\\')).not.toBeNull()
})

test('vence: pasada la fecha no frena', () => {
  const { guardas } = validarGuardas([{ ...P3, vence: '2026-10-09T05:37:00Z' }])
  expect(guardaQueFrena(guardas, { comando: 'git switch main', raiz: RAIZ, ahora })).not.toBeNull()
  expect(guardaQueFrena(guardas, { comando: 'git switch main', raiz: RAIZ, ahora: Date.parse('2026-10-09T05:37:00Z') })).toBeNull()
})

test('un comando de 100 KB contra 8 palabras resuelve rápido', () => {
  const { guardas } = validarGuardas([{ secuencia: ['a', '*', 'b', 'c', '*', 'd', 'e', 'f'], motivo: 'x' }])
  const largo = 'a b c '.repeat(17000)
  const t0 = Date.now()
  guardaQueFrena(guardas, { comando: largo, raiz: RAIZ, ahora })
  expect(Date.now() - t0).toBeLessThan(50)
})

// ------------------------------------------------------------------ mod

type Archivo = { texto: string | null; mtimeMs: number }

function simular(on: On, archivo: Archivo, { home = 'C:/Users/u' }: { home?: string | null } = {}) {
  const visto = { lecturas: 0, logs: [] as string[], corridas: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const cuerpo = String(e.argv[1]).endsWith('buzon.js') ? { sesion: null } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(cuerpo), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: RAIZ }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' && home ? home : undefined }))
  on('fs.stat', ($, e) => (String(e.path).endsWith('antigravity.json') && archivo.texto !== null
    ? { value: { kind: 'file' as const, size: archivo.texto.length, mtimeMs: archivo.mtimeMs, isLink: false } }
    : { deny: 'ENOENT' }))
  on('fs.read', ($, e) => {
    visto.lecturas += 1
    return archivo.texto === null ? { deny: 'ENOENT' } : { value: archivo.texto }
  })
  on('ui.log', ($, e) => { visto.logs.push(String(e.text ?? e)); return { value: undefined } })
  on('tool.call', { tool: 'Bash' }, () => { visto.corridas += 1; return { result: 'ok' } })
  on('tool.call', { tool: 'PowerShell' }, () => { visto.corridas += 1; return { result: 'ok' } })
  return visto
}

const inicio = { cwd: RAIZ, surface: 'terminal' as const, isInteractive: true }
const conGuardas = (lista: unknown[]) => JSON.stringify({ model: 'x', guardas: lista })

test('mod: frena con el motivo y sin la secuencia; lo demás pasa', async ($, on) => {
  const reloj = mock.clock(on, { now: ahora })
  const visto = simular(on, { texto: conGuardas([P3, NODE]), mtimeMs: 1 })
  await $.session.start(inicio)
  await reloj.settle()
  const frenado = await $.tool.call({ tool: 'Bash', command: 'git switch main' } as never)
  expect(String((frenado as { deny?: string }).deny)).toContain('Lagrange · guarda: P3: el daemon corre desde este checkout')
  expect(String((frenado as { deny?: string }).deny).includes('switch main')).toBe(false)
  expect(visto.corridas).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  expect(visto.corridas).toBe(1)
  const ps = await $.tool.call({ tool: 'PowerShell', command: 'Stop-Process -Name node' } as never)
  expect(String((ps as { deny?: string }).deny)).toContain('mata el daemon')
  expect(visto.corridas).toBe(1)
})

test('mod: sin home no lee nada y todo pasa', async ($, on) => {
  const reloj = mock.clock(on, { now: ahora })
  const visto = simular(on, { texto: conGuardas([P3]), mtimeMs: 1 }, { home: null })
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'git switch main' } as never)
  expect(visto.lecturas).toBe(0)
  expect(visto.corridas).toBe(1)
})

test('mod: JSON roto pasa todo y avisa una sola vez', async ($, on) => {
  const reloj = mock.clock(on, { now: ahora })
  const archivo = { texto: '{ roto', mtimeMs: 1 }
  const visto = simular(on, archivo)
  await $.session.start(inicio)
  await reloj.settle()
  archivo.mtimeMs = 2
  await reloj.advance(10_000)
  await $.tool.call({ tool: 'Bash', command: 'git switch main' } as never)
  expect(visto.corridas).toBe(1)
  expect(visto.logs.length).toBe(1)
})

test('mod: un archivo nuevo se recarga en segundo plano y la regla nueva frena', async ($, on) => {
  const reloj = mock.clock(on, { now: ahora })
  const archivo = { texto: conGuardas([]), mtimeMs: 1 }
  const visto = simular(on, archivo)
  await $.session.start(inicio)
  await reloj.settle()
  await $.tool.call({ tool: 'Bash', command: 'git switch main' } as never)
  expect(visto.corridas).toBe(1)
  archivo.texto = conGuardas([P3])
  archivo.mtimeMs = 2
  await reloj.advance(10_000)
  await $.tool.call({ tool: 'Bash', command: 'git switch main' } as never)
  expect(visto.corridas).toBe(1)
  const lecturasAntes = visto.lecturas
  await reloj.advance(30_000)
  expect(visto.lecturas).toBe(lecturasAntes)
})

test('mod: si la tool falla, se ejecuta una sola vez (el motor saltea el hook que falla, no lo reintenta)', async ($, on) => {
  const reloj = mock.clock(on, { now: ahora })
  let llamadas = 0
  on('tool.call', { tool: 'Bash' }, () => { llamadas += 1; throw new Error('falló la tool') })
  simular(on, { texto: conGuardas([P3]), mtimeMs: 1 })
  await $.session.start(inicio)
  await reloj.settle()
  let error: unknown = null
  try { await $.tool.call({ tool: 'Bash', command: 'git status' } as never) } catch (err) { error = err }
  // El motor saltea un hook que lanza: lo que importa es que la guarda no llamó a next dos veces.
  expect(error).not.toBeNull()
  expect(llamadas).toBe(1)
})
