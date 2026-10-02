import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'
import type { FotoPanel, FanoutPanel } from '../types'
import { filasDeFoto, textoDeFoto } from './panel-texto.ts'
import { validarGuardas, guardaQueFrena, textoDeFreno } from './guardas.ts'
import type { Guarda } from './guardas.ts'

/**
 * Los mods de Lagrange para Claude Code, en un solo módulo: el kit admite uno
 * por plugin, un solo `session.start` sin matcher, y `$` no puede pasar a una
 * función importada de otro archivo. Lo que no usa `$` vive aparte
 * (`panel-texto.ts`).
 *
 * FEAT-100 — El aviso del buzón de `mensaje`. Los hooks de `buzon.js` avisan
 * bloqueando el Stop, y al modelo le llega como "Stop hook blocking error".
 * Esto vigila el buzón de la sesión y, cuando llega algo nuevo, encola el aviso
 * con `$.prompt.submit`: entra marcado como mensaje del plugin y nunca se mete
 * en un turno en curso. Mientras late, `buzon.js stop` calla y `espera` no avisa;
 * si el mod se cae, el latido se vence y los hooks vuelven a cargo. Solo el
 * aviso: el texto sale únicamente por la tool `mensaje`. Nunca
 * `$.session.append`, que le llega al modelo como un mensaje del usuario (S3).
 *
 * FEAT-101 — El panel de Lagrange (comando `lagrange-panel`): fan-out, cuota y
 * versiones en un panel lateral, y la línea del fan-out en la status line
 * mientras corre uno. Datos de `hooks/panel.js`; sin fan-out y con el panel
 * cerrado, solo un `fs.list` cada 5 s. Si la status line ya corre
 * `fanout-statusline.js`, no pone el status (saldría dos veces).
 */

// ----------------------------------------------------------------- buzón

type Ubicacion = { sesion: string; jsonl: string; mod: string }

const TICK_BUZON_MS = 3000
const LATIR_CADA_TICKS = 3

async function pedirBuzon($: EngineInterface, modo: 'mod-ubicar' | 'mod-nuevos'): Promise<Record<string, unknown> | null> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/hooks/buzon.js`, modo])
    if (r.exitCode !== 0) return null
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

async function huella($: EngineInterface, ruta: string): Promise<string> {
  try {
    const st = await $.fs.stat(ruta)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'ausente'
  }
}

async function latir($: EngineInterface, u: Ubicacion): Promise<void> {
  try { await $.fs.write(u.mod, JSON.stringify({ ts: await $.clock.now() })) } catch {}
}

async function avisarSiHayNuevos($: EngineInterface): Promise<void> {
  const r = await pedirBuzon($, 'mod-nuevos')
  const aviso = r && typeof r.aviso === 'string' ? r.aviso : null
  if (aviso) await $.prompt.submit({ text: aviso })
}

/** Arranca la vigilancia del buzón (FEAT-100). */
async function iniciarBuzon($: EngineInterface): Promise<void> {
    const u = await pedirBuzon($, 'mod-ubicar')
    if (!u || typeof u.sesion !== 'string' || typeof u.jsonl !== 'string' || typeof u.mod !== 'string') return
    const ubicacion = u as Ubicacion
    await latir($, ubicacion)
    let anterior = await huella($, ubicacion.jsonl)
    let ticks = 0
    let ocupado = false
    // Lo que ya esperaba antes de que el mod cargara.
    void avisarSiHayNuevos($).catch(() => {})
    $.clock.every(TICK_BUZON_MS, () => {
      if (ocupado) return
      ocupado = true
      void (async () => {
        ticks += 1
        if (ticks % LATIR_CADA_TICKS === 0) await latir($, ubicacion)
        const vista = await huella($, ubicacion.jsonl)
        if (vista !== anterior) {
          anterior = vista
          await avisarSiHayNuevos($)
        }
      })().catch(() => {}).finally(() => { ocupado = false })
    })
}

// ----------------------------------------------------------------- panel

const PANE = 'lagrange'
const TICK_PANEL_MS = 5000
const RECIENTE_MS = 10 * 60 * 1000
const REFRESCO_FANOUT_MS = 30 * 1000
const REFRESCO_FOTO_MS = 60 * 1000

const foto = atom({ plugin: 'lagrange', key: 'foto' } as const, null as FotoPanel | null)

type Sesion = {
  abierto: boolean
  refrescar: () => Promise<void>
}

// La sesión vigente: la reinicia cada `session.start` (también al recargar el módulo).
let actual: Sesion | null = null

async function pedirPanel($: EngineInterface, modo: 'fanout' | 'foto', root: string): Promise<Partial<FotoPanel> | null> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/hooks/panel.js`, modo, root])
    if (r.exitCode !== 0) return null
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

/** Arranca el comando, el status y el refresco del panel (FEAT-101). */
async function iniciarPanel($: EngineInterface): Promise<void> {
    await $.command.register({ name: 'lagrange-panel', description: 'Panel de Lagrange: fan-out, cuota y versiones' })
    let statusHabilitado = true
    try {
      const comando = (await $.settings.read())?.statusLine?.command
      if (typeof comando === 'string' && comando.includes('fanout-statusline')) statusHabilitado = false
    } catch {}
    const root = await $.session.root()
    let ocupado = false
    let statusMostrado = false
    let hayFanout = false
    let ultimaHuella = ''
    let ultimaCorrida = 0
    let ultimaFoto = 0
    const sesion: Sesion = { abierto: false, refrescar: async () => {} }

    const aplicarFanout = async (fan: FanoutPanel | null) => {
      hayFanout = Boolean(fan)
      if (statusHabilitado) {
        if (fan?.linea) { await $.ui.status(fan.linea); statusMostrado = true }
        else if (statusMostrado) { await $.ui.status(undefined); statusMostrado = false }
      }
      if (sesion.abierto) await update($, foto, (f) => (f ? { ...f, fanout: fan } : f))
    }

    sesion.refrescar = async () => {
      const r = await pedirPanel($, 'foto', root)
      ultimaFoto = await $.clock.now()
      if (!r) return
      const nueva: FotoPanel = { fanout: r.fanout ?? null, cuota: r.cuota ?? null, versiones: r.versiones ?? null }
      await update($, foto, () => nueva)
      await aplicarFanout(nueva.fanout)
    }
    actual = sesion

    $.clock.every(TICK_PANEL_MS, () => {
      if (ocupado) return
      ocupado = true
      void (async () => {
        const ahora = await $.clock.now()
        if (sesion.abierto && ahora - ultimaFoto >= REFRESCO_FOTO_MS) {
          await sesion.refrescar()
          return
        }
        let lista: Array<{ name: string; mtimeMs: number }> = []
        try { lista = await $.fs.list(`${root}/.claude/worktrees`) } catch {}
        const recientes = lista.filter((x) => x.name.startsWith('.fanout-status-') && x.name.endsWith('.json') && ahora - x.mtimeMs < RECIENTE_MS)
        if (!recientes.length) {
          if (hayFanout) await aplicarFanout(null)
          return
        }
        const huellaFanout = recientes.map((x) => `${x.name}:${x.mtimeMs}`).sort().join('|')
        if (huellaFanout === ultimaHuella && ahora - ultimaCorrida < REFRESCO_FANOUT_MS) return
        ultimaHuella = huellaFanout
        ultimaCorrida = ahora
        const r = await pedirPanel($, 'fanout', root)
        if (r) await aplicarFanout(r.fanout ?? null)
      })().catch(() => {}).finally(() => { ocupado = false })
    })
}

// ----------------------------------------------------------------- guardas

const RECARGA_GUARDAS_MS = 10_000

// Las reglas vigentes y la raíz de la sesión: las reinicia cada `session.start`.
// `tool.call` solo lee esto, en memoria: nada de I/O por comando.
let guardas: Guarda[] = []
let raizSesion = ''

/** FEAT-102 — Carga las guardas de `~/.claude/antigravity.json` y las recarga si el archivo cambia. */
async function iniciarGuardas($: EngineInterface): Promise<void> {
  guardas = []
  raizSesion = await $.session.root()
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) return
  const ruta = `${home}/.claude/antigravity.json`
  let visto = -1
  let avisoRoto = false
  let ocupado = false
  const cargar = async () => {
    let mtime: number
    try { mtime = (await $.fs.stat(ruta)).mtimeMs } catch { guardas = []; visto = -1; return }
    if (mtime === visto) return
    visto = mtime
    let datos: unknown
    try {
      datos = JSON.parse(await $.fs.read(ruta))
    } catch {
      guardas = []
      if (!avisoRoto) { avisoRoto = true; await $.ui.log('lagrange: ~/.claude/antigravity.json no se pudo leer; guardas apagadas') }
      return
    }
    avisoRoto = false
    const lista = datos && typeof datos === 'object' ? (datos as Record<string, unknown>).guardas : undefined
    guardas = validarGuardas(lista).guardas
  }
  await cargar()
  $.clock.every(RECARGA_GUARDAS_MS, () => {
    if (ocupado) return
    ocupado = true
    void cargar().catch(() => {}).finally(() => { ocupado = false })
  })
}

/** La guarda que frena este comando ahora, o `null`. Nunca lanza. */
function guardaPara(comando: unknown): Guarda | null {
  try {
    if (!guardas.length || typeof comando !== 'string') return null
    return guardaQueFrena(guardas, { comando, raiz: raizSesion, ahora: Date.now() })
  } catch {
    return null
  }
}

export const register: Register = (on) => {
  // FEAT-102 — La decisión, fuera de `next`: si la tool falla, su error se propaga tal cual.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const g = guardaPara(e.command)
    return g ? { deny: textoDeFreno(g) } : next(e)
  })
  on('tool.call', { tool: 'PowerShell' }, ($, e, next) => {
    const g = guardaPara(e.command)
    return g ? { deny: textoDeFreno(g) } : next(e)
  })

  on('session.start', async ($, e, next) => {
    const resultado = await next(e)
    // Cada arranque por su lado: si uno falla, el otro arranca igual.
    await iniciarBuzon($).catch(() => {})
    await iniciarPanel($).catch(() => {})
    await iniciarGuardas($).catch(() => {})
    return resultado
  })

  on('command.run', { command: 'lagrange-panel' }, async ($) => {
    const sesion = actual
    if (sesion) {
      sesion.abierto = true
      await sesion.refrescar()
    }
    await $.ui.open({ id: PANE, title: 'Lagrange' })
    const texto = filasDeFoto(await read($, foto)).map((b) => [`**${b.titulo}**`, ...b.filas].join('\n')).join('\n\n')
    return { text: texto }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (actual) actual.abierto = false
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const bloques = filasDeFoto(await read($, foto))
    return (
      <Box flexDirection="column">
        {bloques.map((b) => (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>{b.titulo}</Text>
            {b.filas.map((fila) => <Text wrap="truncate-end">{fila}</Text>)}
          </Box>
        ))}
      </Box>
    )
  })
}
