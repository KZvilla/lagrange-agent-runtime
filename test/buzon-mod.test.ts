import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * FEAT-100 — El mod del buzón (en `hooks/mods.tsx`) con el mundo simulado:
 * `buzon.js` (process.run), el disco (fs.stat / fs.write) y el reloj.
 *
 * `test:mod` carga `mods.tsx` entero, también el panel (FEAT-101): acá sus
 * llamadas se responden vacías y solo se cuentan las corridas de `buzon.js`.
 */

type Mundo = {
  ubicar: Record<string, unknown>
  avisos: Array<string | null>
  huellas: Array<{ mtimeMs: number; size: number } | null>
}

function simular(on: On, mundo: Mundo) {
  const visto = { submits: [] as string[], appends: 0, latidos: [] as string[], corridas: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    // Lo del panel: sin fan-out ni datos.
    if (!String(e.argv[1]).endsWith('buzon.js')) return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const modo = String(e.argv[2])
    visto.corridas.push(modo)
    const cuerpo = modo === 'mod-ubicar' ? mundo.ubicar : { aviso: mundo.avisos.shift() ?? null }
    return { value: { exitCode: 0, stdout: JSON.stringify(cuerpo), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => {
    const h = mundo.huellas.length > 1 ? mundo.huellas.shift() : mundo.huellas[0]
    if (!h) return { deny: 'ENOENT' }
    return { value: { kind: 'file' as const, size: h.size, mtimeMs: h.mtimeMs, isLink: false } }
  })
  on('command.register', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/p' }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  // El motor normaliza la ruta a las barras de la plataforma.
  on('fs.write', ($, e) => { visto.latidos.push(String(e.path).replace(/\\/g, '/')); return { value: undefined } })
  on('prompt.submit', ($, e) => { visto.submits.push(e.text); return { text: e.text } })
  on('session.append', ($, e) => { visto.appends += 1; return { message: e.message, uuid: 'x' } })
  return visto
}

const UBICADO = { sesion: 's1', jsonl: 'C:/b/s1.jsonl', mod: 'C:/b/s1.mod' }
const inicio = { cwd: 'C:/p', surface: 'terminal' as const, isInteractive: true }

test('un mensaje nuevo en el buzón se avisa con prompt.submit, nunca con session.append', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000 })
  const visto = simular(on, {
    ubicar: UBICADO,
    // El arranque no trae nada; el tick que ve el .jsonl cambiado sí.
    avisos: [null, '📨 Tenés 1 mensaje de otros agentes (de pc/spica).'],
    huellas: [{ mtimeMs: 1, size: 10 }, { mtimeMs: 2, size: 20 }]
  })
  await $.session.start(inicio)
  await reloj.settle()
  expect(visto.latidos).toEqual(['C:/b/s1.mod'])
  await reloj.advance(3000)
  expect(visto.submits).toEqual(['📨 Tenés 1 mensaje de otros agentes (de pc/spica).'])
  expect(visto.appends).toBe(0)
})

test('sin cambios en el .jsonl no corre buzon.js en cada tick', async ($, on) => {
  const reloj = mock.clock(on)
  const visto = simular(on, { ubicar: UBICADO, avisos: [null], huellas: [{ mtimeMs: 1, size: 10 }] })
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(12_000)
  // mod-ubicar y la mirada inicial; ningún mod-nuevos por los ticks sin cambios.
  expect(visto.corridas).toEqual(['mod-ubicar', 'mod-nuevos'])
  expect(visto.submits).toEqual([])
})

test('re-late cada tres ticks', async ($, on) => {
  const reloj = mock.clock(on)
  const visto = simular(on, { ubicar: UBICADO, avisos: [null], huellas: [{ mtimeMs: 1, size: 10 }] })
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(9000)
  expect(visto.latidos.length).toBe(2)
})

test('sin buzón para esta sesión no late ni vigila: los hooks quedan a cargo', async ($, on) => {
  const reloj = mock.clock(on)
  const visto = simular(on, { ubicar: { sesion: null }, avisos: [], huellas: [null] })
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(10_000)
  expect(visto.latidos).toEqual([])
  expect(visto.corridas).toEqual(['mod-ubicar'])
  expect(visto.submits).toEqual([])
})
