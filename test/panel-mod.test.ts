import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * FEAT-101 — El panel de Lagrange (en `hooks/mods.tsx`) con el mundo simulado:
 * `panel.js` (process.run), la carpeta de worktrees (fs.list), los settings y
 * el reloj. Lo del buzón (FEAT-100) responde "sin buzón", así no arranca.
 */

const RUN = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const FANOUT = { slug: 'demo', linea: '🔀 fanout demo: 1/2 · 1 ok · 1 corriendo (12s)', tareas: [{ id: 't1', estado: 'ok' }, { id: 't2', estado: 'corriendo' }], terminado: false }
const FOTO = {
  fanout: FANOUT,
  cuota: { antigravity: { grupos: { gemini: { ventana5h: 0.1, ventana7d: 0.25 } }, vistoEn: null }, claude: null, claudePorCuenta: { trabajo: { ventana5h: 0.26, ventana7d: 0.31 } } },
  versiones: { propia: '0.68.0', cuentas: [{ cuenta: 'principal', estado: 'instalado', version: '0.67.11', propia: false, desactualizada: true }] }
}

type Mundo = { statusLine?: string; archivos: Array<{ name: string; mtimeMs: number }>; fanout: unknown; foto?: unknown }

function simular(on: On, mundo: Mundo) {
  const visto = { status: [] as Array<string | undefined>, corridas: [] as string[], abiertos: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const script = String(e.argv[1])
    if (script.endsWith('buzon.js')) return RUN(JSON.stringify({ sesion: null }))
    const modo = String(e.argv[2])
    visto.corridas.push(modo)
    return RUN(JSON.stringify(modo === 'foto' ? (mundo.foto ?? FOTO) : { fanout: mundo.fanout }))
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: mundo.statusLine ? { statusLine: { type: 'command', command: mundo.statusLine } } : {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  // Sin home: las guardas (FEAT-102) quedan inertes y no tocan el disco.
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: mundo.archivos.map((a) => ({ ...a, kind: 'file' as const, size: 1, isLink: false })) }))
  on('ui.status', ($, e) => { visto.status.push(e.text); return { value: undefined } })
  on('ui.open', ($, e) => { visto.abiertos.push(e.id); return { value: { isPlaced: true as const } } })
  return visto
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const COMANDO = { command: 'lagrange-panel', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never

test('lagrange-panel abre el panel y devuelve la foto en texto, sin rutas', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on, { archivos: [], fanout: null })
  await $.session.start(inicio)
  await reloj.settle()
  const r = await $.command.run(COMANDO)
  expect(visto.abiertos).toEqual(['lagrange'])
  expect(visto.corridas).toContain('foto')
  const texto = String((r as { text?: string }).text)
  expect(texto).toContain('**Fan-out**')
  expect(texto).toContain('agy gemini: 5 h 10 % · semana 25 % usado')
  expect(texto).toContain('claude@trabajo: 5 h 26 % · semana 31 % usado')
  expect(texto).toContain('principal: 0.67.11 ⚠ desactualizada')
  expect(texto.includes('C:/')).toBe(false)
})

test('con un fan-out reciente pone la línea en el status, y la limpia una sola vez al terminar', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const mundo: Mundo = { archivos: [{ name: '.fanout-status-demo.json', mtimeMs: 999_000 }], fanout: FANOUT }
  const visto = simular(on, mundo)
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(5000)
  expect(visto.status).toEqual([FANOUT.linea])
  mundo.archivos = []
  await reloj.advance(5000)
  await reloj.advance(5000)
  expect(visto.status).toEqual([FANOUT.linea, undefined])
})

test('si la status line ya corre fanout-statusline, el mod no pone status', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on, { statusLine: 'node "C:/x/lagrange/0.67.11/mcp-server/fanout-statusline.js"', archivos: [{ name: '.fanout-status-demo.json', mtimeMs: 999_000 }], fanout: FANOUT })
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(15_000)
  expect(visto.status).toEqual([])
})

test('sin fan-out y con el panel cerrado no corre panel.js', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on, { archivos: [{ name: '.fanout-status-viejo.json', mtimeMs: 1 }], fanout: null })
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(30_000)
  expect(visto.corridas).toEqual([])
})

test('con el archivo de estado quieto, a lo sumo una corrida de fanout cada 30 s', async ($, on) => {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const visto = simular(on, { archivos: [{ name: '.fanout-status-demo.json', mtimeMs: 999_000 }], fanout: FANOUT })
  await $.session.start(inicio)
  await reloj.settle()
  await reloj.advance(25_000)
  expect(visto.corridas).toEqual(['fanout'])
  await reloj.advance(10_000)
  expect(visto.corridas).toEqual(['fanout', 'fanout'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`el panel dibuja los tres bloques en ${surface}, con "sin datos" donde falta`, async ($, on) => {
    const reloj = mock.clock(on, { now: 1_000_000 })
    simular(on, { archivos: [], fanout: null, foto: { fanout: null, cuota: null, versiones: FOTO.versiones } })
    await $.session.start(inicio)
    await reloj.settle()
    await $.command.run(COMANDO)
    const ui = await $.ui.mount({ plugin: 'lagrange', surface, component: 'Pane', requestId: 'lagrange', props: { title: 'Lagrange', isFocused: false, bodyColumns: 60 } })
    expect(await ui.find({ type: 'Text', text: 'Fan-out' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sin fan-out en curso' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Cuota' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sin datos' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /principal: 0\.67\.11/ })).toBeDefined()
  })
}

// BE-092 — Con el reloj del mod en una fecha fija: la ventana que ya pasó su
// reinicio dice "reiniciada" y cada fila dice de cuándo es el dato.
const AHORA = Date.parse('2026-10-02T12:00:00Z')
const iso = (ms: number) => new Date(AHORA + ms).toISOString()
const H = 3_600_000

test('la cuota vieja: ventana reiniciada y "visto hace", en el comando y en el panel', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const cuota = {
    antigravity: { grupos: { gemini: { ventana5h: 0, ventana7d: 0.25, resetea5h: iso(-H), resetea7d: iso(48 * H) } }, vistoEn: iso(-3 * H) },
    claude: { ventana5h: 0.22, ventana7d: 0.14, resetea5h: iso(-H), resetea7d: iso(48 * H), vistoEn: iso(-9 * 24 * H) },
    claudePorCuenta: { trabajo: { ventana5h: 0.26, ventana7d: 0.31, resetea5h: iso(-H), resetea7d: iso(-H), vistoEn: iso(-20 * 60_000) } }
  }
  simular(on, { archivos: [], fanout: null, foto: { ...FOTO, cuota } })
  await $.session.start(inicio)
  await reloj.settle()
  const texto = String(((await $.command.run(COMANDO)) as { text?: string }).text)
  expect(texto).toContain('agy gemini: 5 h reiniciada · semana 25 % usado (visto hace 3 h)')
  expect(texto).toContain('claude: 5 h reiniciada · semana 14 % usado (visto hace 9 d)')
  expect(texto).toContain('claude@trabajo: 5 h reiniciada · semana reiniciada (visto hace 20 min)')
  const ui = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Pane', requestId: 'lagrange', props: { title: 'Lagrange', isFocused: false, bodyColumns: 120 } })
  expect(await ui.find({ type: 'Text', text: 'claude: 5 h reiniciada · semana 14 % usado (visto hace 9 d)' })).toBeDefined()
})

test('una ventana en 0 % sigue siendo un porcentaje: "usado" no se cae', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const cuota = { antigravity: null, claude: { ventana5h: 0, ventana7d: 0.5, resetea7d: iso(-H) }, claudePorCuenta: null }
  simular(on, { archivos: [], fanout: null, foto: { ...FOTO, cuota } })
  await $.session.start(inicio)
  await reloj.settle()
  const texto = String(((await $.command.run(COMANDO)) as { text?: string }).text)
  expect(texto).toContain('claude: 5 h 0 % · semana reiniciada usado')
  expect(texto.includes('visto hace')).toBe(false)
})
