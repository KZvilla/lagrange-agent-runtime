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
  // FEAT-106 — Barras, % y el emoji del peor uso; nombres alineados.
  expect(texto).toContain('🟢 agy gemini      5h █░░░░░░░░░ 10% · 7d ███░░░░░░░ 25%')
  expect(texto).toContain('🟢 claude@trabajo  5h ███░░░░░░░ 26% · 7d ███░░░░░░░ 31%')
  expect(texto.includes('\x1b')).toBe(false)
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
  // §8 — La columna de 7d mide lo que "░░░░░░░░░░ reiniciada": las celdas más cortas se rellenan.
  const col7 = '░░░░░░░░░░ reiniciada'.length
  expect(texto).toContain(`🟢 agy gemini      5h ░░░░░░░░░░ reiniciada · 7d ${'███░░░░░░░ 25%'.padEnd(col7)}  (visto hace 3 h)`)
  expect(texto).toContain(`🟢 claude          5h ░░░░░░░░░░ reiniciada · 7d ${'█░░░░░░░░░ 14%'.padEnd(col7)}  (visto hace 9 d)`)
  expect(texto).toContain('⚪ claude@trabajo  5h ░░░░░░░░░░ reiniciada · 7d ░░░░░░░░░░ reiniciada  (visto hace 20 min)')
  const ui = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Pane', requestId: 'lagrange', props: { title: 'Lagrange', isFocused: false, bodyColumns: 120 } })
  // FEAT-106 — En el Pane cada segmento es un Text con su estilo.
  expect(await ui.find({ type: 'Text', text: '░░░░░░░░░░ reiniciada' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '14%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '(visto hace 9 d)' })).toBeDefined()
})

// FEAT-106 — Un 0 % es un porcentaje: barra vacía con "0%", distinto de "reiniciada" y de "—".
test('una ventana en 0 % sigue siendo un porcentaje, distinto de reiniciada y de sin dato', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const cuota = { antigravity: null, claude: { ventana5h: 0, ventana7d: 0.5, resetea7d: iso(-H) }, claudePorCuenta: { trabajo: { ventana5h: null, ventana7d: null } } }
  simular(on, { archivos: [], fanout: null, foto: { ...FOTO, cuota } })
  await $.session.start(inicio)
  await reloj.settle()
  const texto = String(((await $.command.run(COMANDO)) as { text?: string }).text)
  expect(texto).toContain('🟢 claude          5h ░░░░░░░░░░ 0% · 7d ░░░░░░░░░░ reiniciada')
  // §8 — "—" se rellena al ancho de "░░░░░░░░░░ 0%"; la de 7d no (fin de fila, sin "visto").
  expect(texto).toContain(`⚪ claude@trabajo  5h ${'—'.padEnd('░░░░░░░░░░ 0%'.length)} · 7d —\n`)
  expect(texto.includes('visto hace')).toBe(false)
})

// FEAT-106 — Umbrales del emoji y colores en el Pane.
test('el emoji sigue al peor uso y el Pane pinta por umbral, sin el emoji', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const cuota = {
    antigravity: { grupos: { gemini: { ventana5h: 0.8, ventana7d: 0.1 }, claude_gpt: { ventana5h: 0.95, ventana7d: 0.2 } }, vistoEn: iso(-7 * H) },
    claude: { ventana5h: 0.4, ventana7d: 0.6 }, claudePorCuenta: null
  }
  simular(on, { archivos: [], fanout: null, foto: { ...FOTO, cuota, almas: null } })
  await $.session.start(inicio)
  await reloj.settle()
  const texto = String(((await $.command.run(COMANDO)) as { text?: string }).text)
  expect(texto).toContain('🟠 agy gemini ')
  // BE-102 — El grupo se muestra con su nombre, no con la clave interna.
  expect(texto).toContain('🔴 agy claude/gpt ')
  expect(texto.includes('claude_gpt')).toBe(false)
  expect(texto).toContain('🟡 claude ')
  const ui = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Pane', requestId: 'lagrange', props: { title: 'Lagrange', isFocused: false, bodyColumns: 120 } })
  // El Text del segmento: el más interno con ese texto (el de la fila lo contiene y va antes en el orden del documento).
  const segmento = async (texto: string) => (await ui.findAll({ type: 'Text', text: texto })).filter((x) => x.text === texto).pop()?.props ?? {}
  expect((await segmento('████░░░░░░')).color).toBe('green')
  expect((await segmento('████████░░')).color).toBe('#ff8700')
  expect((await segmento('██████████')).color).toBe('red')
  const titulo = await segmento('Cuota')
  expect(titulo.bold).toBe(true)
  expect(titulo.color).toBe('cyan')
  const viejo = await segmento('(visto hace 7 h)')
  expect(viejo.color).toBe('yellow')
  expect(viejo.dimColor).toBeFalsy()
  expect((await segmento('sin datos')).dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /🟠|🔴|🟡|🟢/ })).toBeUndefined()
})

// FEAT-105 — Las secciones nuevas sobreviven al refresco (sesion.refrescar
// arma la foto clave por clave) y salen en el comando y en el panel.
const NUEVAS = {
  agentes: { estado: 'ok' as const, sesiones: [{ nodo: 'casa', nombre: 'spica', proyecto: 'repo', desde: '2026-10-02T21:50:00Z', silenciada: false }, { nodo: 'wsl', nombre: 'otra', proyecto: null, desde: '2026-10-02T22:40:00Z', silenciada: true }] },
  almas: { pendientes: 2, cuarentena: 1 },
  programaciones: { proximas: [{ titulo: 'resumen diario', proxima: '2026-10-03T09:00:00Z' }], activas: 1, pausadas: 2 },
  worktrees: [{ nombre: 'be-093', vacia: true }, { nombre: 'feat-x', vacia: false }]
}

test('las secciones nuevas sobreviven al refresco y salen en el comando y en el panel', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  simular(on, { archivos: [], fanout: null, foto: { ...FOTO, ...NUEVAS } })
  await $.session.start(inicio)
  await reloj.settle()
  const texto = String(((await $.command.run(COMANDO)) as { text?: string }).text)
  for (const t of ['**Agentes**', 'casa/spica · repo · desde', 'wsl/otra · ? · desde', '(no recibe)', '**Almas**', '2 pendientes de consolidar · 1 en cuarentena', '**Programaciones**', '· resumen diario', '1 activas · 2 pausadas', '**Guardas**', 'ninguna', '**Worktrees huérfanos**', 'be-093 (vacía)', 'feat-x']) {
    expect(texto).toContain(t)
  }
  const ui = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Pane', requestId: 'lagrange', props: { title: 'Lagrange', isFocused: false, bodyColumns: 120 } })
  expect(await ui.find({ type: 'Text', text: 'Agentes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'be-093 (vacía)' })).toBeDefined()
})

test('sin worktrees huérfanos la sección no aparece; sin enlace lo dice; una sección caída dice "sin datos"', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  simular(on, { archivos: [], fanout: null, foto: { ...FOTO, agentes: { estado: 'sin-enlace', sesiones: [] }, almas: null, programaciones: { proximas: [], activas: 0, pausadas: 0 }, worktrees: [] } })
  await $.session.start(inicio)
  await reloj.settle()
  const texto = String(((await $.command.run(COMANDO)) as { text?: string }).text)
  expect(texto.includes('Worktrees')).toBe(false)
  expect(texto).toContain('daemon sin enlace')
  expect(texto).toContain('**Almas**\nsin datos')
  expect(texto).toContain('0 activas · 0 pausadas')
})

// FEAT-106 §8 — Columnas alineadas: "· 7d" y "(visto hace" en la misma posición en todas las filas.
test('las columnas de la cuota quedan alineadas y el relleno no lleva color', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const cuota = {
    antigravity: { grupos: { gemini: { ventana5h: 0.1, ventana7d: 0.25, resetea5h: iso(-H) } }, vistoEn: iso(-H) },
    claude: { ventana5h: 0.48, ventana7d: 0.2, vistoEn: iso(-H) },
    claudePorCuenta: { trabajo: { ventana5h: null, ventana7d: null, vistoEn: iso(-H) } }
  }
  simular(on, { archivos: [], fanout: null, foto: { ...FOTO, cuota } })
  await $.session.start(inicio)
  await reloj.settle()
  const texto = String(((await $.command.run(COMANDO)) as { text?: string }).text)
  const filas = texto.split('**Cuota**\n')[1].split('\n\n')[0].split('\n')
  expect(filas.length).toBe(3)
  // Desde el nombre: el emoji del comienzo mide distinto en UTF-16 (🟢 son 2 unidades, ⚪ una) aunque en pantalla ocupen lo mismo.
  const pos = (marca: string) => filas.map((f) => { const desde = f.slice(f.indexOf(' ') + 1); return desde.indexOf(marca) })
  expect(new Set(pos('· 7d')).size).toBe(1)
  expect(new Set(pos('(visto hace')).size).toBe(1)
  const ui = await $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'Pane', requestId: 'lagrange', props: { title: 'Lagrange', isFocused: false, bodyColumns: 120 } })
  const pct = (await ui.findAll({ type: 'Text', text: '48%' })).filter((x) => x.text === '48%').pop()
  expect(pct?.props.color).toBe('green')
})
