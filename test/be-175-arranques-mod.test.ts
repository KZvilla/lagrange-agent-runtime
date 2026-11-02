import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * BE-175 — Un arranque que falla deja una línea con el nombre del subsistema y
 * no frena a los demás. El mundo es el mínimo para que los diez arranques
 * corran: buzón sin sesión, metas vacías, sin home, sin gates y sin voz.
 */

const RUN = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const INICIO = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }

type Fallo = 'panel' | 'meta'

function simular(on: On, fallo: Fallo) {
  const visto = { logs: [] as string[], registros: [] as string[], corridas: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const script = String(e.argv[1])
    visto.corridas.push(script)
    if (script.endsWith('mod-voz')) return RUN(JSON.stringify({ voz: null }))
    if (script.endsWith('buzon.js')) return RUN(JSON.stringify({ sesion: null }))
    if (script.endsWith('metas.js')) return RUN(JSON.stringify({ ok: true, metas: [], transiciones: [] }))
    if (script.endsWith('recall-novedades.js')) return RUN(JSON.stringify({ novedades: [] }))
    return RUN(JSON.stringify({ fanout: null }))
  })
  on('command.register', ($, e) => {
    visto.registros.push(e.name)
    if (fallo === 'panel' && e.name === 'lagrange-panel') throw new Error('sin panel')
    if (fallo === 'meta' && e.name === 'meta') throw new Error('sin metas')
    return { value: { command: e.name } }
  })
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  // Sin home: guardas e identidad quedan inertes y no tocan el disco.
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($, e) => { visto.logs.push(e.text); return { value: undefined } })
  return visto
}

test('BE-175: si el panel no arranca, la sesión sigue y el diagnóstico lo nombra', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on, 'panel')
  await $.session.start(INICIO)
  await reloj.settle()

  expect(visto.logs.some((l) => l.includes('panel'))).toBe(true)
  expect(visto.registros).toContain('turno')
  expect(visto.registros).toContain('lagrange-resumen')
  expect(visto.registros).toContain('meta')
})

test('BE-175: un arranque fire-and-forget que rechaza deja diagnóstico y no tumba la sesión', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on, 'meta')
  // Si el rechazo quedara sin manejar, el runner lo reporta como fallo del test.
  await $.session.start(INICIO)
  await reloj.settle()

  expect(visto.logs.some((l) => l.includes('metas'))).toBe(true)
  expect(visto.registros).toContain('lagrange-panel')
})
