import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { separar, reconocer, mataNode, motivoDe, leerStatus, esLink, unir, relativa, rutasDeWorktrees } from '../hooks/vista-previa.ts'

/**
 * FEAT-112 — La vista previa del daño (en `hooks/mods.tsx`). En el kit, un
 * `{ ask }` del mod corta la cadena de `classic.PreToolUse` antes del hook del
 * test (no hay a quién preguntar y la tool corre igual); un `next(e)` llega a
 * él. Por eso la decisión se mira con `visto.clasicos`: 0 = preguntó, 1 = pasó.
 * El texto del motivo se prueba puro, con `motivoDe`.
 */

// ----------------------------------------------------------------- puro

test('separar: comillas, rutas con espacios, separadores; la barra invertida no escapa', () => {
  expect(separar('git -C "C:/vs work/repo" worktree remove .worktrees/x --force && echo listo')).toEqual([
    ['git', '-C', 'C:/vs work/repo', 'worktree', 'remove', '.worktrees/x', '--force'], ['echo', 'listo']
  ])
  expect(separar("rm -rf 'a b' c; ls | wc -l || true")).toEqual([['rm', '-rf', 'a b', 'c'], ['ls'], ['wc', '-l'], ['true']])
  expect(separar('Remove-Item -Recurse C:\\tmp\\x')).toEqual([['Remove-Item', '-Recurse', 'C:\\tmp\\x']])
})

test('reconocer: los cuatro casos, con opciones en cualquier posición', () => {
  expect(reconocer('git worktree remove .worktrees/x --force')).toEqual([{ tipo: 'worktree', dir: null, ruta: '.worktrees/x', force: true }])
  expect(reconocer('git -C repo worktree remove -f wt')).toEqual([{ tipo: 'worktree', dir: 'repo', ruta: 'wt', force: true }])
  expect(reconocer('rm -rf build "mi carpeta"')).toEqual([{ tipo: 'borrado', dir: null, rutas: ['build', 'mi carpeta'] }])
  expect(reconocer('Remove-Item -Recurse -Force a, b')).toEqual([{ tipo: 'borrado', dir: null, rutas: ['a', 'b'] }])
  expect(reconocer('Remove-Item -LiteralPath "C:/x y" -Recurse')).toEqual([{ tipo: 'borrado', dir: null, rutas: ['C:/x y'] }])
  expect(reconocer('rmdir /s /q viejo')).toEqual([{ tipo: 'borrado', dir: null, rutas: ['viejo'] }])
  expect(reconocer('git push --force origin next/v1')).toEqual([{ tipo: 'push', dir: null, remoto: 'origin', origen: 'next/v1', destino: 'next/v1' }])
  expect(reconocer('git push origin +HEAD:main')).toEqual([{ tipo: 'push', dir: null, remoto: 'origin', origen: 'HEAD', destino: 'main' }])
  expect(reconocer('Get-Process node | Stop-Process -Force')).toEqual([{ tipo: 'node' }])
  // Push forzado sin remoto y con varios refspecs.
  expect(reconocer('git push +main')).toEqual([{ tipo: 'push', dir: null, remoto: null, origen: 'main', destino: 'main' }])
  expect(reconocer('git push origin main +feat').map((c) => (c as { destino: string }).destino)).toEqual(['feat'])
  expect(reconocer('git push -f origin a b').map((c) => (c as { destino: string }).destino)).toEqual(['a', 'b'])
  expect(reconocer('Remove-Item -Recurse /var/log')).toEqual([{ tipo: 'borrado', dir: null, rutas: ['/var/log'] }])
})

test('reconocer: lo que no es destructivo no se mide', () => {
  for (const c of ['git worktree list', 'git worktree add x', 'rm archivo.txt', 'rm -f archivo.txt', 'Remove-Item a.txt', 'git push', 'git push origin next/v1',
    'git push --force-with-lease origin x', 'Get-Process node', 'node scripts/gates.mjs', 'Stop-Process -Id 123', 'npm run gates'])
    expect(reconocer(c)).toEqual([])
  expect(mataNode('taskkill /F /IM node.exe')).toBe(true)
  expect(mataNode('kill -Name node -Force')).toBe(true)
  expect(mataNode('pkill -f node')).toBe(true)
  expect(mataNode('taskkill /PID 123')).toBe(false)
  expect(mataNode('Stop-Process node')).toBe(true)
  expect(mataNode('Stop-Process -ProcessName node')).toBe(true)
  expect(mataNode('Stop-Process -Id 123')).toBe(false)
})

test('leerStatus, esLink, unir, relativa, rutasDeWorktrees', () => {
  expect(leerStatus('!! telegram-bridge/node_modules/\n?? nuevo.txt\n M a.ts\n')).toEqual({ sueltas: ['telegram-bridge/node_modules', 'nuevo.txt'], cambios: 2 })
  expect(esLink('C:/r/x', { isLink: true })).toBe(true)
  expect(esLink('C:/r/x', { isLink: false, realPath: 'C:\\otra\\x' })).toBe(true)
  expect(esLink('C:/r/x', { isLink: false, realPath: 'c:\\R\\x' })).toBe(false)
  expect(unir('C:/vs work/repo', '.worktrees/x/')).toBe('C:/vs work/repo/.worktrees/x')
  expect(unir('C:/repo', 'D:\\otro')).toBe('D:/otro')
  expect(relativa('C:/repo', 'C:/Repo/a/b')).toBe('a/b')
  expect(rutasDeWorktrees('worktree C:/repo\nHEAD abc\n\nworktree C:/repo/.worktrees/x\nbranch refs/heads/f\n')).toEqual(['C:/repo', 'C:/repo/.worktrees/x'])
})

test('motivoDe: el link con su destino, los commits, el node; relativo a la raíz y con tope', () => {
  const m = motivoDe([
    { tipo: 'worktree', ruta: 'C:/repo/.worktrees/x', links: [{ ruta: 'C:/repo/.worktrees/x/telegram-bridge/node_modules', destino: 'C:/repo/telegram-bridge/node_modules' }], cambios: 3, force: true },
    { tipo: 'push', ref: 'origin/main', commits: 2 },
    { tipo: 'node' }
  ], 'C:/repo')
  expect(m.split('\n')).toEqual([
    'Lagrange · vista previa del daño',
    'git worktree remove --force .worktrees/x',
    '⚠ contiene un link: telegram-bridge/node_modules → telegram-bridge/node_modules — --force borra a través de él',
    '3 archivos sin commitear se perderían',
    'git push forzado: 2 commits de origin/main se perderían (según la copia local, sin fetch)',
    'mata todos los node: esta sesión de Claude Code, los MCP de Lagrange, el daemon del bridge y el registrador de P3'
  ])
  const muchos = motivoDe([{ tipo: 'borrado', links: [], versionados: Array.from({ length: 20 }, (_, i) => ({ ruta: `C:/repo/d${i}`, n: 1 })) }], 'C:/repo')
  expect(muchos.split('\n').length).toBe(12)
  expect(muchos).toContain('líneas más')
})

// ----------------------------------------------------------------- mod

type Git = (dir: string, args: string[]) => { code: number; out: string } | 'plazo'
type Stat = { kind: 'file' | 'dir'; isLink?: boolean; realPath?: string }
type Mundo = { git: Git; stat: Record<string, Stat>; guardas?: unknown[] }

const RUN = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
// El motor entrega las rutas con barras invertidas en Windows: se compara sin importar la barra.
const barra = (p: unknown) => String(p).split('\\').join('/')

function simular(on: On, mundo: Mundo) {
  const visto = { corridas: 0, clasicos: 0, git: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const argv = e.argv.map(String)
    if (argv[0] !== 'git') return RUN(JSON.stringify({ sesion: null }))
    const dir = barra(argv[2]), args = argv.slice(3)
    visto.git.push(args.join(' '))
    const r = mundo.git(dir, args)
    return r === 'plazo' ? { deny: 'timeout' } : RUN(r.out, r.code)
  })
  on('fs.stat', ($, e) => {
    const s = mundo.stat[barra(e.path)]
    if (barra(e.path).endsWith('antigravity.json')) return mundo.guardas ? { value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }
    if (!s) return { deny: 'ENOENT' }
    return { value: { kind: s.kind, size: 1, mtimeMs: 1, isLink: Boolean(s.isLink), ...(e.resolve ? { realPath: s.realPath ?? barra(e.path) } : {}) } }
  })
  on('fs.read', () => ({ value: JSON.stringify({ guardas: mundo.guardas ?? [] }) }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('env.get', ($, e) => ({ value: mundo.guardas && e.name === 'USERPROFILE' ? 'C:/home' : undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('classic.PreToolUse', ($, e, next) => { visto.clasicos += 1; return next(e) })
  on('tool.call', { tool: 'Bash' }, () => { visto.corridas += 1; return { result: 'ok' } })
  on('tool.call', { tool: 'PowerShell' }, () => { visto.corridas += 1; return { result: 'ok' } })
  return visto
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const correr = async ($: Parameters<Parameters<typeof test>[1]>[0], on: On, mundo: Mundo, command: string, tool = 'Bash') => {
  const reloj = mock.clock(on, { now: Date.parse('2026-10-04T12:00:00Z') })
  const visto = simular(on, mundo)
  await $.session.start(inicio)
  await reloj.settle()
  const r = await $.tool.call({ tool, command } as never)
  return { visto, r }
}
const pregunto = (v: { clasicos: number }) => v.clasicos === 0
const WT = 'C:/repo/.worktrees/x'
const LISTA = `worktree C:/repo\nHEAD a\n\nworktree ${WT}\nHEAD b\n`
const sinNada: Git = () => ({ code: 0, out: '' })

test('worktree con la junction del incidente → pregunta', async ($, on) => {
  const git: Git = (dir, a) => a[0] === 'worktree' ? { code: 0, out: LISTA } : a[0] === 'status' ? { code: 0, out: '!! telegram-bridge/node_modules/\n' } : { code: 0, out: '' }
  const { visto } = await correr($, on, { git, stat: { [WT]: { kind: 'dir' }, [`${WT}/telegram-bridge/node_modules`]: { kind: 'dir', isLink: true, realPath: 'C:/repo/telegram-bridge/node_modules' } } }, 'git worktree remove .worktrees/x --force')
  expect(pregunto(visto)).toBe(true)
})

test('worktree: si el motor no marcara la junction, realPath la delata → pregunta', async ($, on) => {
  const git: Git = (dir, a) => a[0] === 'worktree' ? { code: 0, out: LISTA } : a[0] === 'status' ? { code: 0, out: '!! telegram-bridge/node_modules/\n' } : { code: 0, out: '' }
  const { visto } = await correr($, on, { git, stat: { [WT]: { kind: 'dir' }, [`${WT}/telegram-bridge/node_modules`]: { kind: 'dir', isLink: false, realPath: 'C:/repo/telegram-bridge/node_modules' } } }, 'git worktree remove .worktrees/x')
  expect(pregunto(visto)).toBe(true)
})

test('worktree sin links ni cambios, aun con --force → pasa', async ($, on) => {
  const limpio: Git = (dir, a) => a[0] === 'worktree' ? { code: 0, out: LISTA } : a[0] === 'status' ? { code: 0, out: '!! dist/\n' } : { code: 0, out: '' }
  const stat = { [WT]: { kind: 'dir' as const }, [`${WT}/dist`]: { kind: 'dir' as const } }
  expect(pregunto((await correr($, on, { git: limpio, stat }, 'git worktree remove --force .worktrees/x')).visto)).toBe(false)
})

test('worktree --force con cambios sin commitear → pregunta', async ($, on) => {
  const git: Git = (dir, a) => a[0] === 'worktree' ? { code: 0, out: LISTA } : a[0] === 'status' ? { code: 0, out: ' M a.ts\n?? b.ts\n' } : { code: 0, out: '' }
  const { visto } = await correr($, on, { git, stat: { [WT]: { kind: 'dir' } } }, 'git worktree remove .worktrees/x --force')
  expect(pregunto(visto)).toBe(true)
})

test('worktree sin --force con cambios → pasa (git mismo se niega)', async ($, on) => {
  const git: Git = (dir, a) => a[0] === 'worktree' ? { code: 0, out: LISTA } : a[0] === 'status' ? { code: 0, out: ' M a.ts\n' } : { code: 0, out: '' }
  const { visto } = await correr($, on, { git, stat: { [WT]: { kind: 'dir' } } }, 'git worktree remove .worktrees/x')
  expect(pregunto(visto)).toBe(false)
})

test('borrado recursivo de una carpeta sin versionados ni links → pasa', async ($, on) => {
  const git: Git = (dir, a) => a[0] === 'rev-parse' ? { code: 0, out: 'C:/repo\n' } : { code: 0, out: '' }
  const { visto } = await correr($, on, { git, stat: { 'C:/repo/build': { kind: 'dir' }, 'C:/repo': { kind: 'dir' } } }, 'rm -rf build')
  expect(pregunto(visto)).toBe(false)
  expect(visto.corridas).toBe(1)
})

test('borrado recursivo con archivos versionados → pregunta', async ($, on) => {
  const git: Git = (dir, a) => a[0] === 'ls-files' ? { code: 0, out: 'src/a.ts\0src/b.ts\0' } : a[0] === 'rev-parse' ? { code: 0, out: 'C:/repo\n' } : { code: 0, out: '' }
  const { visto } = await correr($, on, { git, stat: { 'C:/repo/src': { kind: 'dir' }, 'C:/repo': { kind: 'dir' } } }, 'Remove-Item -Recurse -Force src', 'PowerShell')
  expect(pregunto(visto)).toBe(true)
})

test('borrado fuera de un repo (git sale 128) → pasa; ruta inexistente → pasa', async ($, on) => {
  const fuera: Git = () => ({ code: 128, out: '' })
  expect(pregunto((await correr($, on, { git: fuera, stat: { 'C:/tmp/x': { kind: 'dir' }, 'C:/tmp': { kind: 'dir' } } }, 'rm -rf C:/tmp/x')).visto)).toBe(false)
})

test('borrado de una ruta que no existe → pasa sin medir git', async ($, on) => {
  const { visto } = await correr($, on, { git: sinNada, stat: {} }, 'rm -rf no-existe')
  expect(pregunto(visto)).toBe(false)
  expect(visto.git).toEqual([])
})

test('borrar un link → pregunta', async ($, on) => {
  const { visto } = await correr($, on, { git: sinNada, stat: { 'C:/repo/nm': { kind: 'dir', isLink: true, realPath: 'D:/otro/nm' }, 'C:/repo': { kind: 'dir' } } }, 'rm -rf nm')
  expect(pregunto(visto)).toBe(true)
})

test('push --force que pierde 2 commits → pregunta; rama sin remoto → pasa', async ($, on) => {
  const git: Git = (dir, a) => a[0] === 'rev-parse' && a.includes('--verify') ? { code: 0, out: 'abc\n' } : a[0] === 'rev-list' ? { code: 0, out: '2\n' } : { code: 0, out: 'next/v1\n' }
  expect(pregunto((await correr($, on, { git, stat: {} }, 'git push --force origin next/v1')).visto)).toBe(true)
})

test('push --force de una rama sin copia remota → pasa', async ($, on) => {
  const git: Git = (dir, a) => a[0] === 'rev-parse' && a.includes('--verify') ? { code: 1, out: '' } : { code: 0, out: 'nueva\n' }
  const { visto } = await correr($, on, { git, stat: {} }, 'git push -f origin nueva')
  expect(pregunto(visto)).toBe(false)
})

test('push --force-with-lease → pasa sin medir', async ($, on) => {
  const { visto } = await correr($, on, { git: sinNada, stat: {} }, 'git push --force-with-lease origin x')
  expect(pregunto(visto)).toBe(false)
  expect(visto.git).toEqual([])
})

test('matar node → pregunta siempre, sin medir', async ($, on) => {
  const { visto } = await correr($, on, { git: sinNada, stat: {} }, 'Stop-Process -Name node -Force', 'PowerShell')
  expect(pregunto(visto)).toBe(true)
  expect(visto.git).toEqual([])
})

test('una medición que se pasa de plazo → pregunta igual', async ($, on) => {
  const { visto } = await correr($, on, { git: () => 'plazo', stat: {} }, 'git worktree remove .worktrees/x')
  expect(pregunto(visto)).toBe(true)
})

test('un comando que no se reconoce → pasa sin medir', async ($, on) => {
  const { visto } = await correr($, on, { git: sinNada, stat: {} }, 'git worktree list')
  expect(pregunto(visto)).toBe(false)
  expect(visto.git).toEqual([])
})

test('una guarda de FEAT-102 que niega gana: un comando que sí mediría no mide nada', async ($, on) => {
  const git: Git = (dir, a) => a[0] === 'worktree' ? { code: 0, out: LISTA } : { code: 0, out: '!! telegram-bridge/node_modules/\n' }
  const { visto, r } = await correr($, on, { git, stat: { [WT]: { kind: 'dir' } }, guardas: [{ secuencia: ['git', 'worktree', 'remove'], motivo: 'no quitar worktrees' }] }, 'git worktree remove .worktrees/x --force')
  expect(String((r as { deny?: string }).deny)).toContain('no quitar worktrees')
  expect(visto.corridas).toBe(0)
  expect(visto.git).toEqual([])
})

test('borrado con comodín → pregunta (no se puede medir)', async ($, on) => {
  const { visto } = await correr($, on, { git: sinNada, stat: {} }, 'rm -rf *.log')
  expect(pregunto(visto)).toBe(true)
})

test('worktree con más de 200 entradas sueltas → pregunta, sin truncar en silencio', async ($, on) => {
  const muchas = Array.from({ length: 201 }, (_, i) => `?? f${i}.tmp`).join('\n')
  const git: Git = (dir, a) => a[0] === 'worktree' ? { code: 0, out: LISTA } : a[0] === 'status' ? { code: 0, out: muchas } : { code: 0, out: '' }
  const { visto } = await correr($, on, { git, stat: { [WT]: { kind: 'dir' } } }, 'git worktree remove .worktrees/x')
  expect(pregunto(visto)).toBe(true)
})
