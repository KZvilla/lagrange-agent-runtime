import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'
import type { FotoPanel, FanoutPanel } from '../types'
import { filasDeFoto, textoDeFoto } from './panel-texto.ts'
import { validarGuardas, guardaQueFrena, guardasVigentes, textoDeFreno } from './guardas.ts'
import { FOCOS, leerArgs, ramaDeHead, gitdirDe, promptDeResumen, validarResumen, archivoDeResumen, frontmatter, pieDeCosto, textoDeEstimacion } from './resumen-texto.ts'
import type { Foco, MetaResumen } from './resumen-texto.ts'
import type { Guarda } from './guardas.ts'
import { esToolDeAgy, cierreDe, hayAlgo, filasDeBanda } from './banda-texto.ts'
import type { LlamadaAgy, CierreAgy, Tono } from './banda-texto.ts'
import { PLAZO_GATES_MS, nuevaCorrida, leerArgGates, procesarLinea, partirLineas, finPorCodigo, bloqueDeGates, lineaDeGates, avanceDeGates } from './gates-texto.ts'
import type { CorridaGates, FinGates } from './gates-texto.ts'
import { reconocer, motivoDe, unir, normalizar, mismaRuta, rutasDeWorktrees, leerStatus, esLink, tieneComodin } from './vista-previa.ts'
import type { Caso, CasoWorktree, CasoBorrado, CasoPush, Hallazgo } from './vista-previa.ts'
import { identidadDeConfig, identidadesIguales, sufijoConIdentidad } from './identidad.ts'
import type { Identidad } from './identidad.ts'
import { nuevoHandoff, pctDe, medir, descartar, empezar, terminar, vigente, hayAviso, filaDeHandoff } from './handoff-texto.ts'
import type { Handoff, FilaHandoff } from './handoff-texto.ts'

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
 *
 * BE-093 — La cuota de Claude que mide la sesión (`session.measure`) va a
 * `antigravity-usage.json` con `panel.js cuota-sesion`: sin esto solo la
 * anotaba un `claude -p`, y el panel y el freno leían datos de días.
 *
 * FEAT-109 — La banda de agy sobre el prompt: las llamadas de agy en curso con
 * su reloj, el cierre de cada una (veredicto) por 20 s y las tareas del fan-out
 * con su paso. Redibuja con el tick del panel; no agrega timers.
 *
 * FEAT-114 — `/lagrange-gates`: corre `scripts/gates.mjs` sin turno de Claude y
 * muestra el avance en la sección «Gates» del panel. Solo existe donde está ese
 * script. El veredicto es el código de salida del proceso; el resultado no
 * entra a la conversación (solo una línea en `/lagrange-panel`).
 *
 * FEAT-112 — La vista previa del daño: antes de cuatro comandos destructivos
 * (quitar un worktree, borrar recursivo, push forzado, matar node) mide qué
 * tocarían y, si hay daño, pregunta con el prompt de permisos del motor
 * (`classic.PreToolUse` → `{ ask }`, que pregunta también en modo auto). Si no
 * hay daño, pasa sin preguntar. Las guardas (`tool.call`) niegan antes.
 *
 * FEAT-123 — La identidad de la cuenta (`identidad_sesion`: Spica, Epikouros)
 * al final del spinner. Sin color: `Spinner` no lo expone; el color va en la
 * statusline (`fanout-statusline.js`). Sin configuración, nada cambia.
 *
 * FEAT-118 — El freno de contexto: al cruzar el 70 % y el 85 % de la ventana
 * de compactación, una fila en la banda con «[h] guardar handoff» (corre
 * `generarResumen` con foco handoff, lo mismo que `/lagrange-resumen handoff si`)
 * y «[x] ahora no», solo entre turnos. Una vez por umbral y por ciclo de
 * compactación; sin dígitos de atajo (un «1» suelto lanzaría el fork).
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
    await $.command.register({ name: 'lagrange-panel', description: 'Panel de Lagrange: fan-out, cuota, versiones, agentes, almas, programaciones, guardas y worktrees huérfanos' })
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
      fanoutBanda = fan
      // FEAT-109 — Sin esto la banda mostraba el fan-out del tick anterior.
      $.ui.invalidate('ui.render')
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
      // FEAT-105 — Cada clave a mano: lo que no esté acá se pierde en el refresco.
      const nueva: FotoPanel = {
        fanout: r.fanout ?? null, cuota: r.cuota ?? null, versiones: r.versiones ?? null,
        agentes: r.agentes ?? null, almas: r.almas ?? null, programaciones: r.programaciones ?? null, worktrees: r.worktrees ?? null
      }
      await update($, foto, () => nueva)
      await aplicarFanout(nueva.fanout)
    }
    actual = sesion

    $.clock.every(TICK_PANEL_MS, () => {
      // FEAT-109 — El reloj de la banda avanza con este tick; una vez más al vaciarse, para borrarla.
      void (async () => {
        const ahora = await $.clock.now()
        if (bandaDibujada || bandaViva(ahora) || gatesCorriendo() || hayAviso(handoff, ahora)) $.ui.invalidate('ui.render')
      })().catch(() => {})
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
        // FEAT-109 — El avance fino va a los .agy-progress: sin ellos el paso se congelaba 30 s.
        const progreso = lista.filter((x) => x.name.startsWith('.agy-progress-') && x.name.endsWith('.jsonl') && ahora - x.mtimeMs < RECIENTE_MS)
        const huellaFanout = [...recientes, ...progreso].map((x) => `${x.name}:${x.mtimeMs}`).sort().join('|')
        if (huellaFanout === ultimaHuella && ahora - ultimaCorrida < REFRESCO_FANOUT_MS) return
        ultimaHuella = huellaFanout
        ultimaCorrida = ahora
        const r = await pedirPanel($, 'fanout', root)
        if (r) await aplicarFanout(r.fanout ?? null)
      })().catch(() => {}).finally(() => { ocupado = false })
    })
}

// ----------------------------------------------------------------- banda (FEAT-109)

// Una sola fuente de verdad, en el módulo: un reload la pierde y la banda vuelve
// con la próxima llamada. Nada en `$.state`.
const llamadas = new Map<string, LlamadaAgy>()
let cierres: CierreAgy[] = []
let fanoutBanda: FanoutPanel | null = null
let bandaDibujada = false
let contadorLlamadas = 0

const COLOR_DE_TONO: Record<Tono, string | undefined> = { normal: undefined, ok: 'green', error: 'red', tenue: undefined }

function bandaViva(ahora: number): boolean {
  return hayAlgo({ llamadas: [...llamadas.values()], cierres, fanout: fanoutBanda, ahora })
}

/** Cierra una llamada: la saca de las en curso y deja su cierre. Nunca lanza. */
async function cerrarLlamada($: EngineInterface, clave: string, salida: { texto?: unknown; fallo: boolean }): Promise<void> {
  try {
    const l = llamadas.get(clave)
    llamadas.delete(clave)
    if (!l) return
    const ahora = await $.clock.now()
    cierres = [...cierres.filter((c) => ahora < c.hasta), cierreDe(l.tool, salida, l.desde, ahora)]
    $.ui.invalidate('ui.render')
  } catch {}
}

// ----------------------------------------------------------------- gates (FEAT-114)

// La corrida en curso o la última: variables del módulo, como la banda. Un reload la pierde.
let gates: CorridaGates | null = null
let gatesStream: AsyncGenerator<unknown, unknown> | null = null
let gatesPlazo: { cancel: () => void } | null = null
let gatesRaiz = ''

function gatesCorriendo(): boolean {
  return gates !== null && gates.fin === null
}

/** FEAT-114 — Registra `lagrange-gates` solo si la raíz tiene `scripts/gates.mjs`. */
async function iniciarGates($: EngineInterface): Promise<void> {
  gatesRaiz = await $.session.root()
  if (!(await $.fs.exists(`${gatesRaiz}/scripts/gates.mjs`))) return
  await $.command.register({ name: 'lagrange-gates', description: 'Corre las puertas (scripts/gates.mjs) sin turno de Claude; el avance en el panel de Lagrange. quick: sin el bridge; detener: corta la corrida.' })
}

/** Cierra la corrida una sola vez: libera la bandera, avisa y redibuja. Nunca lanza. */
async function terminarGates($: EngineInterface, c: CorridaGates, fin: FinGates): Promise<void> {
  try {
    if (c.fin) return
    c.fin = fin
    gatesPlazo?.cancel()
    gatesPlazo = null
    if (gates === c) gatesStream = null
    $.ui.toast(`Gates: ${lineaDeGates(c, await $.clock.now())}`)
    $.ui.invalidate('ui.render')
  } catch {}
}

/** Corta a pedido o por plazo: la bandera se libera al momento y el stream se cierra (mata al hijo). */
async function cortarGates($: EngineInterface, c: CorridaGates, estado: 'cortada' | 'detenida'): Promise<void> {
  const stream = gates === c ? gatesStream : null
  await terminarGates($, c, { estado, duracionMs: Math.max(0, (await $.clock.now()) - c.desde), code: null })
  try { void stream?.return(undefined) } catch {}
}

/** El hijo: lee las líneas a medida que llegan; el veredicto sale de `stream.result`. */
async function correrGates($: EngineInterface, c: CorridaGates, argv: string[]): Promise<void> {
  let recibio = false
  try {
    const stream = $.process.spawn({ argv, cwd: gatesRaiz })
    gatesStream = stream as AsyncGenerator<unknown, unknown>
    gatesPlazo = $.clock.after(PLAZO_GATES_MS, () => { void cortarGates($, c, 'cortada') })
    let resto = ''
    for await (const trozo of stream) {
      recibio = true
      if (c.fin) break
      if (trozo.stream !== 'stdout') continue
      const p = partirLineas(resto, trozo.text)
      resto = p.resto
      const ahora = await $.clock.now()
      for (const l of p.lineas) procesarLinea(c, l, ahora)
      $.ui.invalidate('ui.render')
    }
    if (c.fin) return
    if (resto) procesarLinea(c, resto, await $.clock.now())
    const r = await stream.result
    await terminarGates($, c, finPorCodigo(r.code, c.desde, await $.clock.now()))
  } catch {
    const ahora = await $.clock.now().catch(() => c.desde)
    await terminarGates($, c, recibio ? finPorCodigo(null, c.desde, ahora) : { estado: 'no-arranco', duracionMs: Math.max(0, ahora - c.desde), code: null })
  }
}

// ----------------------------------------------------------------- vista previa (FEAT-112)

const MEDIR_MS = 5000
const MAX_SUELTAS = 200

/** git de solo lectura, con plazo; rechaza si no termina a tiempo (el caso queda «sin medir»). */
async function gitLectura($: EngineInterface, dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const r = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: MEDIR_MS })
  return { code: r.exitCode, out: r.stdout }
}

/** Adónde llega una ruta de verdad (links seguidos), o la ruta misma si no se puede saber. */
async function realDe($: EngineInterface, ruta: string): Promise<string> {
  try { return normalizar((await $.fs.stat(ruta, { resolve: true })).realPath ?? ruta) } catch { return ruta }
}

/** De las entradas sueltas (ignoradas o sin seguimiento) de `top`, las que son links. Rutas absolutas. */
async function linksEn($: EngineInterface, top: string, sueltas: string[]): Promise<Array<{ ruta: string; destino: string | null }>> {
  const topReal = await realDe($, top)
  const links: Array<{ ruta: string; destino: string | null }> = []
  // Más de las que se pueden mirar: no se trunca en silencio, el caso queda «sin medir» (pregunta igual).
  if (sueltas.length > MAX_SUELTAS) throw new Error('demasiadas entradas')
  for (const s of sueltas) {
    const abs = unir(top, s)
    try {
      const st = await $.fs.stat(abs, { resolve: true })
      if (esLink(unir(topReal, s), st)) links.push({ ruta: abs, destino: st.realPath ? normalizar(st.realPath) : null })
    } catch {}
  }
  return links
}

async function medirWorktree($: EngineInterface, base: string, c: CasoWorktree): Promise<Hallazgo | null> {
  const lista = await gitLectura($, base, ['worktree', 'list', '--porcelain'])
  const pedida = unir(base, c.ruta)
  const rutas = lista.code === 0 ? rutasDeWorktrees(lista.out) : []
  const fin = '/' + normalizar(c.ruta).toLowerCase()
  let ruta = rutas.find((r) => mismaRuta(r, pedida)) ?? rutas.find((r) => normalizar(r).toLowerCase().endsWith(fin)) ?? null
  if (!ruta) {
    // Sin worktree registrado: si la carpeta existe se mide igual; si no, no hay nada que quitar.
    try { if ((await $.fs.stat(pedida)).kind !== 'dir') return null } catch { return null }
    ruta = pedida
  }
  const st = await gitLectura($, ruta, ['status', '--porcelain', '--ignored'])
  if (st.code !== 0) throw new Error('status')
  const { sueltas, cambios } = leerStatus(st.out)
  const links = await linksEn($, ruta, sueltas)
  return links.length || (c.force && cambios > 0) ? { tipo: 'worktree', ruta, links, cambios, force: c.force } : null
}

async function medirBorrado($: EngineInterface, base: string, c: CasoBorrado): Promise<Hallazgo | null> {
  const links: Array<{ ruta: string; destino: string | null }> = []
  const versionados: Array<{ ruta: string; n: number }> = []
  for (const r of c.rutas) {
    if (tieneComodin(r)) throw new Error('comodín')
    const abs = unir(base, r)
    let st
    try { st = await $.fs.stat(abs, { resolve: true }) } catch { continue }
    const corte = abs.lastIndexOf('/')
    const padreReal = await realDe($, corte > 0 ? abs.slice(0, corte) : '/')
    if (esLink(unir(padreReal, abs.slice(corte + 1)), st)) { links.push({ ruta: abs, destino: st.realPath ? normalizar(st.realPath) : null }); continue }
    // Desde la raíz: sirve para archivos y carpetas. Fuera de un repo, git sale con 128: sin versionados.
    const ls = await gitLectura($, base, ['ls-files', '-z', '--', abs])
    if (ls.code === 0) {
      const n = ls.out.split('\0').filter(Boolean).length
      if (n) versionados.push({ ruta: abs, n })
    }
    if (st.kind === 'dir') {
      const top = await gitLectura($, abs, ['rev-parse', '--show-toplevel'])
      if (top.code === 0) {
        const t = normalizar(top.out.trim())
        const s = await gitLectura($, t, ['status', '--porcelain', '--ignored', '--', abs])
        if (s.code === 0) links.push(...(await linksEn($, t, leerStatus(s.out).sueltas)).filter((l) => !mismaRuta(l.ruta, abs)))
      }
    }
  }
  return links.length || versionados.length ? { tipo: 'borrado', links, versionados } : null
}

async function medirPush($: EngineInterface, base: string, c: CasoPush): Promise<Hallazgo | null> {
  let remoto = c.remoto
  let rama = c.destino
  if (!rama || rama === 'HEAD') rama = (await gitLectura($, base, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()
  if (!remoto) {
    const up = await gitLectura($, base, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    remoto = up.code === 0 ? up.out.trim().split('/')[0] : 'origin'
  }
  const ref = `${remoto}/${rama}`
  // Rama sin copia remota (nueva): no hay commits que perder.
  if ((await gitLectura($, base, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`])).code !== 0) return null
  const desde = c.origen && c.origen !== 'HEAD' ? c.origen : 'HEAD'
  const n = await gitLectura($, base, ['rev-list', '--count', `${desde}..${ref}`])
  if (n.code !== 0) throw new Error('rev-list')
  const commits = Number(n.out.trim())
  return commits > 0 ? { tipo: 'push', ref, commits } : null
}

const ETIQUETA: Record<Caso['tipo'], string> = { worktree: 'git worktree remove', borrado: 'borrado recursivo', push: 'git push forzado', node: 'matar node' }

/** Mide cada caso; una medición que falla o se pasa de plazo deja «sin medir» (pregunta igual). */
async function medirCasos($: EngineInterface, casos: Caso[], raiz: string): Promise<Hallazgo[]> {
  const hallazgos: Hallazgo[] = []
  for (const c of casos) {
    try {
      if (c.tipo === 'node') { hallazgos.push({ tipo: 'node' }); continue }
      const base = c.dir ? unir(raiz, c.dir) : raiz
      const h = c.tipo === 'worktree' ? await medirWorktree($, base, c) : c.tipo === 'borrado' ? await medirBorrado($, base, c) : await medirPush($, base, c)
      if (h) hallazgos.push(h)
    } catch {
      hallazgos.push({ tipo: 'sin-medir', comando: ETIQUETA[c.tipo] })
    }
  }
  return hallazgos
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

// ----------------------------------------------------------------- identidad (FEAT-123)

// La de esta cuenta, o `null`: la reinicia cada `session.start`.
let identidad: Identidad | null = null

/** Por su lado, no dentro de las guardas: si una falla, la otra sigue. Solo presentación: sin avisos. */
async function iniciarIdentidad($: EngineInterface): Promise<void> {
  identidad = null
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) return
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const ruta = `${home}/.claude/antigravity.json`
  let visto = -1
  let ocupado = false
  const cargar = async () => {
    let nueva: Identidad | null = null
    try {
      const mtime = (await $.fs.stat(ruta)).mtimeMs
      if (mtime === visto) return
      visto = mtime
      nueva = identidadDeConfig(JSON.parse(await $.fs.read(ruta)), { configDir, home })
    } catch {
      visto = -1
    }
    if (identidadesIguales(nueva, identidad)) return
    identidad = nueva
    $.ui.invalidate('ui.render')
  }
  await cargar()
  $.clock.every(RECARGA_GUARDAS_MS, () => {
    if (ocupado) return
    ocupado = true
    void cargar().catch(() => {}).finally(() => { ocupado = false })
  })
}

// ----------------------------------------------------------------- handoff (FEAT-118)

const VENTANA_VIGENCIA_MS = 10 * 60_000
const COLOR_DE_HANDOFF: Record<FilaHandoff['tono'], string | undefined> = { aviso: 'yellow', urgente: 'red', normal: undefined, ok: 'green', error: 'red' }

// Lo reinician `session.start` y `session.end` (un `/clear` no dispara `session.start`).
let handoff: Handoff = nuevoHandoff()
let ventanaCompactacion: { tokens: number; en: number } | null = null
let ventanaPidiendo = false
let ultimoContexto: { tokens?: number; window: number } | null = null
let homeHandoff = ''

function reiniciarHandoff(): void {
  handoff = nuevoHandoff()
  ventanaCompactacion = null
  ultimoContexto = null
}

/** Decide con la ventana de compactación si ya está, o con la del modelo mientras tanto (avisa tarde, nunca de más). */
function aplicarContexto($: EngineInterface): void {
  if (!ultimoContexto) return
  handoff = medir(handoff, pctDe(ultimoContexto.tokens, ventanaCompactacion?.tokens ?? ultimoContexto.window))
  $.ui.invalidate('ui.render')
}

/** La ventana de compactación, en segundo plano: un pedido en vuelo, vigente 10 min. Al llegar, recalcula. */
async function pedirVentana($: EngineInterface): Promise<void> {
  const ahora = await $.clock.now()
  if (ventanaPidiendo || (ventanaCompactacion && ahora - ventanaCompactacion.en < VENTANA_VIGENCIA_MS)) return
  ventanaPidiendo = true
  try {
    const raw = (await $.session.usage({ breakdown: 'summary' }))?.context?.breakdown?.rawMaxTokens
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) ventanaCompactacion = { tokens: raw, en: ahora }
  } catch {} finally {
    ventanaPidiendo = false
  }
  aplicarContexto($)
}

/**
 * FEAT-103 — `/lagrange-resumen`: sin `si` solo estima; con `si` hace el fork y guarda a disco. A la conversación
 * vuelve la ruta y el costo, nunca el documento. Fuera del hook porque también la usa el botón de FEAT-118:
 * `$.command.run` desde el mod no pasa por los hooks del propio plugin.
 */
async function generarResumen($: EngineInterface, args: string): Promise<{ text: string }> {
  try {
    const { foco, valido, confirmado } = leerArgs(args)
    if (!valido) return { text: `Foco desconocido: ${foco}. Válidos: ${FOCOS.join(', ')}.` }
    const modelo = await $.session.model()
    if (!confirmado) {
      const uso = await $.session.usage()
      return { text: textoDeEstimacion(foco, uso?.context?.tokens, modelo) }
    }
    const root = await $.session.root()
    const meta: MetaResumen = {
      sessionId: await $.session.id(),
      proyecto: root,
      rama: await leerRama($, root),
      modelo,
      inicio: (await $.session.usage())?.startedAt ?? null,
      fin: await $.clock.now()
    }
    const f = await $.model.fork({ prompt: promptDeResumen(foco as Foco, meta) })
    const pie = pieDeCosto((f as { usage?: Parameters<typeof pieDeCosto>[0] }).usage)
    if (!f.isAnswered) {
      const motivo = (f as { reason?: string }).reason
      const dicho = motivo === 'nothing-to-fork' ? 'todavía no hay conversación para resumir' : `el fork no respondió (${motivo})`
      return { text: `No se generó el resumen: ${dicho}.\n${pie}` }
    }
    const texto = (f as { text: string }).text
    const v = validarResumen(texto)
    if (!v.ok) return { text: `No se guardó el resumen: ${v.motivo}.\n${pie}` }
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    if (!home) return { text: `No se guardó el resumen: no se encontró la carpeta del usuario.\n${pie}` }
    const ruta = archivoDeResumen(home, meta)
    await $.fs.write(ruta, frontmatter(meta) + texto.trim() + '\n')
    return { text: `Resumen (${foco}) guardado en ${ruta}\n${pie}` }
  } catch (err) {
    return { text: `No se pudo generar el resumen: ${err instanceof Error ? err.name : 'error'}.` }
  }
}

/** [h]: corre el resumen de handoff y deja el resultado en la fila. Nunca se queda en «generando». */
async function guardarHandoff($: EngineInterface): Promise<void> {
  if (handoff.fase === 'generando') return
  handoff = empezar(handoff, await $.clock.now())
  $.ui.invalidate('ui.render')
  let texto = ''
  try {
    texto = (await generarResumen($, 'handoff si')).text
  } catch {
    texto = 'No se pudo generar el handoff.'
  }
  handoff = terminar(handoff, texto, await $.clock.now(), homeHandoff)
  $.ui.invalidate('ui.render')
}

// ----------------------------------------------------------------- cuota

type Ventana = { kind: string; percentUsed: number; resetsAt?: string }

/** Los argumentos de `panel.js cuota-sesion` después de la raíz, o `null` sin ventanas de 5 h ni de 7 d. */
function argsDeCuota(ventanas: readonly Ventana[]): string[] | null {
  const de = (kind: string) => ventanas.find((v) => v.kind === kind)
  const par = (v: Ventana | undefined) => (v && Number.isFinite(v.percentUsed)
    ? [String(v.percentUsed), v.resetsAt || '-']
    : ['-', '-'])
  const cinco = par(de('five_hour'))
  const siete = par(de('seven_day'))
  return cinco[0] === '-' && siete[0] === '-' ? null : [...cinco, ...siete]
}

// Una escritura por vez; la lectura que llega mientras corre una queda
// pendiente (la más nueva pisa a la anterior) y se escribe al terminar.
let cuotaEnCurso = false
let cuotaPendiente: string[] | null = null

async function escribirCuota($: EngineInterface): Promise<void> {
  cuotaEnCurso = true
  try {
    while (cuotaPendiente) {
      const args = cuotaPendiente
      cuotaPendiente = null
      try {
        const root = await $.session.root()
        await $.process.run(['node', `${$.plugin.root}/hooks/panel.js`, 'cuota-sesion', root, ...args])
      } catch {}
    }
  } finally {
    cuotaEnCurso = false
  }
}

// ----------------------------------------------------------------- resumen

/** FEAT-103 — La rama de `.git/HEAD` (en un worktree, siguiendo `gitdir:`), o `null`. Nunca lanza. */
async function leerRama($: EngineInterface, root: string): Promise<string | null> {
  try {
    let git = `${root}/.git`
    const st = await $.fs.stat(git)
    if (st.kind === 'file') {
      const dir = gitdirDe(await $.fs.read(git))
      if (!dir) return null
      // git suele escribirla absoluta; si viene relativa, es relativa a la raíz.
      git = /^([a-zA-Z]:)?[\\/]/.test(dir) ? dir : `${root}/${dir}`
    }
    return ramaDeHead(await $.fs.read(`${git}/HEAD`))
  } catch {
    return null
  }
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
  // FEAT-112 — Debajo de los tool.call (una guarda que niega gana antes): mide y, si hay daño, pregunta.
  on('classic.PreToolUse', async ($, e, next) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return next(e)
    const comando = (e as { command?: unknown }).command
    if (typeof comando !== 'string') return next(e)
    // Las guardas niegan en tool.call, que corre antes; esto evita medir si una llegara a quedar debajo.
    if (guardaPara(comando)) return next(e)
    const casos = reconocer(comando)
    if (!casos.length) return next(e)
    const raiz = raizSesion || normalizar(await $.session.root())
    const hallazgos = await medirCasos($, casos, raiz)
    return hallazgos.length ? { ask: motivoDe(hallazgos, raiz) } : next(e)
  })

  // FEAT-102 — La decisión, fuera de `next`: si la tool falla, su error se propaga tal cual.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const g = guardaPara(e.command)
    return g ? { deny: textoDeFreno(g) } : next(e)
  })
  on('tool.call', { tool: 'PowerShell' }, ($, e, next) => {
    const g = guardaPara(e.command)
    return g ? { deny: textoDeFreno(g) } : next(e)
  })

  // FEAT-109 — Observa las tools de agy (el nombre del servidor MCP varía: sin matcher).
  // Lo que devuelve la tool, o su error, sigue tal cual.
  on('tool.call', async ($, e, next) => {
    if (!esToolDeAgy(e.tool)) return next(e)
    const clave = typeof e.tool_use_id === 'string' && e.tool_use_id ? e.tool_use_id : `l${++contadorLlamadas}`
    try {
      llamadas.set(clave, { tool: e.tool, desde: await $.clock.now() })
      $.ui.invalidate('ui.render')
    } catch {}
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } catch (err) {
      await cerrarLlamada($, clave, { fallo: true })
      throw err
    }
    await cerrarLlamada($, clave, { texto: r?.text, fallo: Boolean(r?.deny) || Boolean(r?.isError) })
    return r
  })

  // BE-093 — Observa: la escritura no se espera en la cadena.
  on('session.measure', ($, e, next) => {
    // FEAT-118 — Sincrónico: decide con lo que hay y pide la ventana de compactación en segundo plano.
    try {
      if (e.changed.includes('context') && e.context) {
        ultimoContexto = { tokens: e.context.tokens, window: e.context.window }
        aplicarContexto($)
        void pedirVentana($).catch(() => {})
      }
    } catch {}
    try {
      const args = e.changed.includes('rateLimits') ? argsDeCuota(e.rateLimits) : null
      if (args) {
        cuotaPendiente = args
        if (!cuotaEnCurso) void escribirCuota($)
      }
    } catch {}
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const resultado = await next(e)
    reiniciarHandoff()
    homeHandoff = ((await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined)) || '') as string
    // Cada arranque por su lado: si uno falla, el otro arranca igual.
    await iniciarBuzon($).catch(() => {})
    await iniciarPanel($).catch(() => {})
    await iniciarGates($).catch(() => {})
    await iniciarGuardas($).catch(() => {})
    await iniciarIdentidad($).catch(() => {})
    await $.command.register({
      name: 'lagrange-resumen',
      description: 'Resumen de esta sesión con todo el contexto ($.model.fork), guardado en ~/.claude/session-summaries. Relee la conversación entera: pide confirmación antes de gastar.'
    }).catch(() => {})
    return resultado
  })

  // FEAT-103 — Ver generarResumen.
  on('command.run', { command: 'lagrange-resumen' }, async ($, e) => generarResumen($, e.args))

  on('command.run', { command: 'lagrange-panel' }, async ($) => {
    const sesion = actual
    if (sesion) {
      sesion.abierto = true
      await sesion.refrescar()
    }
    await $.ui.open({ id: PANE, title: 'Lagrange' })
    const ahora = await $.clock.now()
    const texto = textoDeFoto(await read($, foto), ahora, { guardas: guardasVigentes(guardas, { raiz: raizSesion, ahora }) })
    // FEAT-114 — Una sola línea: la cola de las rotas va solo al pane.
    return { text: gates ? `${texto}\n\n**Gates**\n${lineaDeGates(gates, ahora)}` : texto }
  })

  // FEAT-114 — Responde al instante; el hijo sigue en segundo plano.
  on('command.run', { command: 'lagrange-gates' }, async ($, e) => {
    const arg = leerArgGates(e.args)
    if (arg === null) return { text: 'Uso: /lagrange-gates (todas), /lagrange-gates quick (sin el bridge) o /lagrange-gates detener.' }
    const ahora = await $.clock.now()
    if (arg === 'detener') {
      if (!gates || !gatesCorriendo()) return { text: 'No hay puertas corriendo.' }
      await cortarGates($, gates, 'detenida')
      return { text: 'Puertas detenidas.' }
    }
    const abrir = async () => {
      // Como /lagrange-panel, pero sin esperar el refresco de la foto.
      if (actual) { actual.abierto = true; void actual.refrescar().catch(() => {}) }
      await $.ui.open({ id: PANE, title: 'Lagrange' })
    }
    if (gates && gatesCorriendo()) {
      await abrir()
      return { text: `Ya corren las puertas ${avanceDeGates(gates, ahora)}.` }
    }
    const c = nuevaCorrida(arg, ahora)
    gates = c
    void correrGates($, c, ['node', 'scripts/gates.mjs', ...(arg === 'rápidas' ? ['--quick'] : [])])
    await abrir()
    return { text: `Corriendo las puertas (${arg}). El avance, en el panel de Lagrange. Si Claude edita archivos mientras corren, alguna puede fallar sin estar rota.` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (actual) actual.abierto = false
    return next(e)
  })

  // FEAT-123 — La cuenta al final del spinner, sin tocar el resto (la animación y la palabra son del motor).
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!identidad) return next(e)
    return next({ ...e, props: { ...e.props, suffix: sufijoConIdentidad(e.props.suffix, identidad) } })
  })

  // FEAT-118 — `/clear` no dispara `session.start`: sin esto quedaría un aviso sobre una conversación vacía.
  on('session.end', ($, e, next) => {
    reiniciarHandoff()
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // FEAT-109 — La banda: solo en terminal y Desktop, y solo con algo que mostrar.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ahora = await $.clock.now()
    cierres = cierres.filter((c) => ahora < c.hasta)
    const estado = { llamadas: [...llamadas.values()], cierres, fanout: fanoutBanda, ahora }
    handoff = vigente(handoff, ahora)
    const conHandoff = hayAviso(handoff, ahora)
    if (e.surface === 'vscode' || e.surface === 'mobile' || e.props.hasSurvey || (!hayAlgo(estado) && !conHandoff)) {
      bandaDibujada = false
      return next(e)
    }
    // FEAT-118 — Con aviso, una fila menos para agy: el aviso va al final y entra siempre.
    const max = Math.max(1, Math.min(10, e.props.maxRows - 2))
    const fila = conHandoff ? filaDeHandoff(handoff, ahora) : null
    const filas = filasDeBanda({ ...estado, maxFilas: fila ? max - 1 : max })
    const { Box, Text, Button } = $.ui.resolve(e)
    bandaDibujada = true
    return (
      <Box flexDirection="column">
        {filas.map((f) => <Text wrap="truncate-end" color={COLOR_DE_TONO[f.tono]} dimColor={f.tono === 'tenue'}>{f.texto}</Text>)}
        {fila && (
          <Box flexDirection="row" gap={1}>
            <Text wrap="truncate-end" color={COLOR_DE_HANDOFF[fila.tono]}>{fila.texto}</Text>
            {fila.botones && !e.props.isWorking && <Button key="handoff-guardar" hotkey="h" variant="primary" label="guardar handoff" onPress={() => { void guardarHandoff($).catch(() => {}) }} />}
            {fila.botones && !e.props.isWorking && <Button key="handoff-no" hotkey="x" dimColor label="ahora no" onPress={() => { handoff = descartar(handoff); $.ui.invalidate('ui.render') }} />}
            {fila.botones && <Text dimColor>{e.props.isWorking ? 'al terminar el turno' : 'clic, o ctrl+x y Tab'}</Text>}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const ahora = await $.clock.now()
    const bloques = filasDeFoto(await read($, foto), ahora, { guardas: guardasVigentes(guardas, { raiz: raizSesion, ahora }) })
    // FEAT-114 — La sección «Gates», solo si hubo alguna corrida.
    if (gates) bloques.push(bloqueDeGates(gates, ahora))
    return (
      <Box flexDirection="column">
        {bloques.map((b) => (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="cyan">{b.titulo}</Text>
            {/* FEAT-106 — Cada segmento con su estilo; el emoji (soloTexto) no va: acá está el color. */}
            {b.filas.map((fila) => (
              <Text wrap="truncate-end">
                {fila.filter((x) => !x.soloTexto).map((x) => <Text color={x.color} dimColor={x.tenue} bold={x.negrita}>{x.texto}</Text>)}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
