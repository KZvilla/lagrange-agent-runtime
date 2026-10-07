import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'
import type { FotoPanel, FanoutPanel, BandejaBanda, MetaPanel, RedPanel, CuotaPanel, LoteAviso } from '../types'
import { filasDeFoto, textoDeFoto, textoDeMetas, avisosDeRed } from './panel-texto.ts'
import type { AvisoRed } from './panel-texto.ts'
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
import { textoFinal, visibles, filasDeMensaje, remitente, avisoParaClaude, bloqueDeRespuestas, pedidoDeRecall, filaDeNovedad, novedadesDe } from './bandeja-texto.ts'
import { nuevoTurno, abrirTool, cerrarTool, contarPaso, cerrarTurno, textoDeTurno, TURNOS_GUARDADOS } from './turno-texto.ts'
import type { TurnoEnCurso, TurnoCerrado } from './turno-texto.ts'
import { leerVoz, mensajeDeVoz, frases, fraseEn, filaDeSubtitulo, esToolDeVoz } from './voz-texto.ts'
import type { VozEnCurso } from './voz-texto.ts'
import { clasificar, sumarPaso, sumarSpawn, leerMedicion, textoDeMedicion, MEDICION_VACIA } from './haiku-medicion.ts'
import type { Medicion } from './haiku-medicion.ts'
import { avisosFanout, avisosLotes, avisosCuota, avisosMensajes, tiposDe } from './avisos-fondo.ts'
import type { Aviso, TipoAviso, EstadoFanout, EstadoLotes, EstadoCuota, EstadoMensajes } from './avisos-fondo.ts'
import { modelosDelPedido, modeloPorDefecto, restantes, bajo, pregunta, decision, SEGUIR, CANCELAR, cuentasClaudeOfrecibles, opcionClaude } from './cuota-previa.ts'

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
 *
 * FEAT-111 — Antes de un `agy_run`, `agy_fanout` o `agy_lote` (lanzar), si la
 * cuota guardada del grupo de sus modelos tiene menos del 20 % (dato de menos
 * de 30 min), pregunta «Seguir / Cancelar» con `$.ui.ask`. Sin interfaz
 * (`claude -p`) o sin dato, pasa. Va dentro del hook de FEAT-109, antes de
 * anotar la llamada: una cancelación no deja fila en la banda.
 *
 * FEAT-115 — «Banda primero»: un mensaje de otra sesión aparece en la banda
 * (quién y el texto, para el usuario) sin despertar a Claude, con «[r]
 * responder» (un Input; sale por `buzon.js mod-responder` con un rótulo
 * informativo), «[c] pasar a Claude» (el aviso de siempre, sin el texto) y
 * «[l] más tarde» (queda para `mensaje leer`). Lo respondido se le cuenta a
 * Claude en el próximo prompt del usuario. Con el mod vivo, los hooks
 * `prompt`/`stop`/`espera` de `buzon.js` callan.
 *
 * FEAT-116 — Al arrancar, si otra cuenta modificó notas de memoria de este
 * proyecto desde la última marca (`$.store`, «recall-visto»), una fila con
 * «[t] traer» (le pide a Claude el recall, sin nombres de archivo) y «[n]
 * ahora no». Una vez por sesión; nada se copia solo.
 *
 * FEAT-126 — `/meta`: metas del proyecto (fecha, conteo, condición; riesgo
 * opcional), compartidas entre cuentas en la base de conocimiento. Los
 * comandos corren cada 5 min por `hooks/metas.js` SOLO si esta cuenta los
 * aprobó (hashes en `$.store` «metas-permitidos»): el archivo es compartido.
 * Sección «Metas» del panel (desde `panel.js`) y un toast por transición.
 *
 * FEAT-122 — La línea de tiempo del turno: cada tool del loop principal (sin
 * `agentId`) con su inicio y duración, los requests, los tokens (sumados por
 * `turn.complete`) y el costo (lo que sumó `cost.usd` de la sesión). Los
 * últimos 5 en una variable del módulo; sección «Último turno» del panel y
 * `/turno` con el detalle.
 */

// ----------------------------------------------------------------- buzón

type Ubicacion = { sesion: string; jsonl: string; mod: string }

const TICK_BUZON_MS = 3000
const LATIR_CADA_TICKS = 3

async function pedirBuzon($: EngineInterface, modo: 'mod-ubicar' | 'mod-mensajes'): Promise<Record<string, unknown> | null> {
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

/** FEAT-115 — Los pendientes sin entregar van a la banda; no se despierta a Claude. */
async function traerMensajes($: EngineInterface): Promise<void> {
  const r = await pedirBuzon($, 'mod-mensajes')
  if (!r || !Array.isArray(r.mensajes)) return
  const mensajes = r.mensajes as BandejaBanda['mensajes']
  await update($, bandeja, (b) => ({ ...b, mensajes }))
  $.ui.invalidate('ui.render')
  // FEAT-135 — El primer pedido (lo que ya esperaba) es la línea de base.
  const { listos } = await read($, bandeja)
  const r2 = avisosMensajes(estadoMensajesAv, mensajes, listos, remitente)
  estadoMensajesAv = r2.estado
  avisar($, r2.avisos)
}

/** FEAT-115 — Despacha un mensaje de la banda (pasado a Claude, para más tarde o respondido). */
async function despachar($: EngineInterface, id: string, extra: Partial<BandejaBanda> = {}): Promise<void> {
  await update($, bandeja, (b) => ({ ...b, ...extra, listos: [...b.listos.filter((x) => x !== id), id].slice(-200), respondiendo: null }))
  $.ui.invalidate('ui.render')
}

async function responderDesdeLaBanda($: EngineInterface, id: string, texto: string): Promise<void> {
  const b = await read($, bandeja)
  const m = b.mensajes.find((x) => x.id === id)
  if (!m || !texto.trim()) return
  let r: { ok?: boolean; error?: string } = {}
  try {
    const out = await $.process.run(['node', `${$.plugin.root}/hooks/buzon.js`, 'mod-responder'], { stdin: JSON.stringify({ id, texto }) })
    r = JSON.parse(out.stdout)
  } catch {
    r = { ok: false, error: 'No se pudo correr buzon.js' }
  }
  if (!r.ok) {
    $.ui.toast(`No se envió: ${r.error || 'error desconocido'}`)
    return
  }
  const nota = { de: remitente(m), id, texto: texto.trim().slice(0, 2000) }
  await despachar($, id, { notas: [...b.notas, nota].slice(-10) })
  $.ui.toast(`Respuesta enviada a ${remitente(m)}`)
}

/** FEAT-116 — Una vez por sesión: lo que otra cuenta anotó de este proyecto desde la última marca. */
async function iniciarRecall($: EngineInterface): Promise<void> {
  if ((await read($, bandeja)).recallMirado) return
  await update($, bandeja, (b) => ({ ...b, recallMirado: true }))
  const raiz = normalizar(await $.session.root())
  const marcas = ((await $.store.get('recall-visto')) ?? {}) as Record<string, Record<string, number>>
  const out = await $.process.run(['node', `${$.plugin.root}/hooks/recall-novedades.js`], {
    stdin: JSON.stringify({ cwd: raiz, desde: marcas[raiz.toLowerCase()] ?? {} }),
    env: { CLAUDECODE: '1' }
  })
  if (out.exitCode !== 0) return
  const novedades = novedadesDe(JSON.parse(out.stdout))
  if (!novedades.length) return
  await update($, bandeja, (b) => ({ ...b, novedades }))
  $.ui.invalidate('ui.render')
}

/** FEAT-116 — «traer» y «ahora no» guardan la misma marca: no se vuelve a avisar hasta que haya algo más nuevo. */
async function marcarRecall($: EngineInterface, cuenta: string, traer: boolean): Promise<void> {
  const b = await read($, bandeja)
  const n = b.novedades.find((x) => x.cuenta === cuenta)
  if (!n) return
  const raiz = normalizar(await $.session.root()).toLowerCase()
  const marcas = ((await $.store.get('recall-visto')) ?? {}) as Record<string, Record<string, number>>
  await $.store.set('recall-visto', { ...marcas, [raiz]: { ...(marcas[raiz] ?? {}), [cuenta]: n.hasta } })
  await update($, bandeja, (x) => ({ ...x, novedades: x.novedades.filter((y) => y.cuenta !== cuenta) }))
  $.ui.invalidate('ui.render')
  const pedido = traer ? pedidoDeRecall(n) : null
  if (pedido) await $.prompt.submit({ text: pedido })
}

// ----------------------------------------------------------------- turno (FEAT-122)

// Por turnId: aunque el motor dice que un subagente no dispara turn.start, uno que llegara no pisa al principal.
// Las tools del loop principal van al más viejo abierto (el principal); se descartan los de más de 6 h.
const turnosAbiertos = new Map<string, TurnoEnCurso>()
const TURNO_VIEJO_MS = 6 * 60 * 60 * 1000
let turnosCerrados: TurnoCerrado[] = []

async function costoSesion($: EngineInterface): Promise<number | null> {
  try {
    const u = await $.session.usage()
    return typeof u.cost?.usd === 'number' ? u.cost.usd : null
  } catch {
    return null
  }
}

// ----------------------------------------------------------------- metas (FEAT-126)

const MEDIR_METAS_MS = 5 * 60 * 1000
let midiendoMetas = false
let metasPendientes = false

type RespuestaMetas = { ok?: boolean; error?: string; metas?: MetaPanel[]; transiciones?: Array<{ nombre: string; tipo: string }>; hashes?: string[]; huerfanos?: string[]; meta?: MetaPanel }

async function metasPermitidos($: EngineInterface): Promise<string[]> {
  const v = await $.store.get('metas-permitidos').catch(() => undefined)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

async function pedirMetas($: EngineInterface, cuerpo: Record<string, unknown>): Promise<RespuestaMetas> {
  try {
    const raiz = raizSesion || (await $.session.root())
    const r = await $.process.run(['node', `${$.plugin.root}/hooks/metas.js`], { stdin: JSON.stringify({ cwd: raiz, ...cuerpo }), timeoutMs: 5 * 60 * 1000 })
    return JSON.parse(r.stdout) as RespuestaMetas
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/** Mide (una a la vez) y avisa cada transición con un toast. Nunca lanza. */
async function medirMetas($: EngineInterface): Promise<MetaPanel[] | null> {
  if (midiendoMetas) return null
  midiendoMetas = true
  try {
    const r = await pedirMetas($, { accion: 'medir', permitidos: await metasPermitidos($) })
    if (!r.ok || !r.metas) return null
    metasPendientes = r.metas.some((m) => !m.estado.cumplida)
    for (const t of r.transiciones ?? []) $.ui.toast(t.tipo === 'cumplida' ? `🎯 Meta «${t.nombre}» cumplida` : `⚠️ Meta «${t.nombre}» en riesgo`)
    if (r.transiciones?.length) void actual?.refrescar().catch(() => {})
    return r.metas
  } catch {
    return null
  } finally {
    midiendoMetas = false
  }
}

async function iniciarMetas($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'meta', description: 'Metas del proyecto con progreso: /meta (lista), /meta fecha|conteo|condicion …, /meta aprobar|borrar <id>, /meta revisar, /meta ayuda' })
  await medirMetas($)
  $.clock.every(MEDIR_METAS_MS, () => { if (metasPendientes) void medirMetas($).catch(() => {}) })
}

const AYUDA_META = [
  'Metas del proyecto (compartidas entre tus cuentas):',
  '  /meta fecha "P3" 2026-10-09T05:37Z',
  '  /meta conteo "Major" 20 -- git rev-list --count main..next/v1',
  '  /meta condicion "Gates verdes" -- node scripts/gates.mjs --quick',
  '  … cualquiera admite al final: --riesgo <comando> (si sale distinto de 0, la meta queda en riesgo)',
  '  /meta (lista) · /meta revisar (mide ya) · /meta aprobar <id> · /meta borrar <id>',
  'Los comandos corren sin shell, en la raíz del proyecto, cada 5 min, y solo si esta cuenta los aprobó.'
].join(String.fromCharCode(10))

async function comandoMeta($: EngineInterface, args: string): Promise<{ text: string }> {
  const ahora = await $.clock.now()
  const texto = args.trim()
  const verbo = texto.split(/\s+/)[0] ?? ''
  const resto = texto.slice(verbo.length).trim()
  const permitidos = await metasPermitidos($)
  if (verbo === 'ayuda') return { text: AYUDA_META }
  if (verbo === 'fecha' || verbo === 'conteo' || verbo === 'condicion') {
    const r = await pedirMetas($, { accion: 'crear', args: texto })
    if (!r.ok || !r.meta) return { text: `No se creó: ${r.error ?? 'error desconocido'}` }
    await $.store.set('metas-permitidos', [...new Set([...permitidos, ...(r.hashes ?? [])])])
    metasPendientes = true
    void medirMetas($).then(() => actual?.refrescar()).catch(() => {})
    return { text: `Meta ${r.meta.id} «${r.meta.nombre}» creada${r.hashes?.length ? '; su comando quedó aprobado en esta cuenta' : ''}.` }
  }
  if (verbo === 'borrar') {
    const r = await pedirMetas($, { accion: 'borrar', id: resto })
    if (!r.ok) return { text: `No se borró: ${r.error ?? 'error desconocido'}` }
    const fuera = new Set(r.huerfanos ?? [])
    await $.store.set('metas-permitidos', permitidos.filter((h) => !fuera.has(h)))
    void actual?.refrescar().catch(() => {})
    return { text: `Meta ${resto} borrada.` }
  }
  if (verbo === 'aprobar') {
    const r = await pedirMetas($, { accion: 'listar' })
    const m = r.metas?.find((x) => x.id === resto)
    if (!m) return { text: `No hay una meta ${resto} en este proyecto.` }
    const nuevos = m.hashes.filter((h) => !permitidos.includes(h))
    if (!nuevos.length) return { text: `La meta ${m.id} ya está aprobada en esta cuenta.` }
    const cmds = [m.medir, m.riesgo].filter((a): a is string[] => Array.isArray(a)).map((a) => a.join(' ')).join(' · ')
    let respuesta = ''
    try {
      respuesta = await $.ui.ask(`La meta «${m.nombre}» corre «${cmds}» cada 5 min en ${raizSesion}. ¿Aprobar en esta cuenta?`, { options: ['Aprobar', 'No'], header: 'Meta' })
    } catch {
      return { text: 'Sin respuesta: la meta sigue sin aprobar.' }
    }
    if (respuesta !== 'Aprobar') return { text: 'La meta sigue sin aprobar.' }
    await $.store.set('metas-permitidos', [...new Set([...permitidos, ...nuevos])])
    metasPendientes = true
    void medirMetas($).then(() => actual?.refrescar()).catch(() => {})
    return { text: `Meta ${m.id} aprobada en esta cuenta.` }
  }
  if (verbo === 'revisar') {
    const metas = await medirMetas($)
    return { text: metas ? textoDeMetas(metas, ahora, await metasPermitidos($)) : 'Hay una medición en curso; probá en un rato.' }
  }
  if (verbo === '') {
    const r = await pedirMetas($, { accion: 'listar' })
    return { text: r.ok ? textoDeMetas(r.metas ?? [], ahora, permitidos) : `No se pudieron leer: ${r.error}` }
  }
  return { text: AYUDA_META }
}

// BE-110 — El MCP da de alta la sesión (y escribe el puntero) 500 ms después de arrancar, y session.start
// puede llegar antes: sin puntero, se reintenta (cada 5 s los primeros 2 min, después cada 60 s).
const REINTENTO_RAPIDO_MS = 5000
const REINTENTO_LENTO_MS = 60 * 1000
const VENTANA_RAPIDA_MS = 2 * 60 * 1000

async function ubicarBuzon($: EngineInterface): Promise<Ubicacion | null> {
  const u = await pedirBuzon($, 'mod-ubicar')
  return u && typeof u.sesion === 'string' && typeof u.jsonl === 'string' && typeof u.mod === 'string' ? (u as Ubicacion) : null
}

/** Arranca la vigilancia del buzón (FEAT-100); si la sesión todavía no tiene puntero, la busca de nuevo (BE-110). */
async function iniciarBuzon($: EngineInterface): Promise<void> {
  const ubicada = await ubicarBuzon($)
  if (ubicada) return vigilarBuzon($, ubicada)
  const desde = await $.clock.now()
  let buscando = false
  let encontrada = false
  let ultimo = desde
  $.clock.every(REINTENTO_RAPIDO_MS, () => {
    if (buscando || encontrada) return
    buscando = true
    void (async () => {
      const ahora = await $.clock.now()
      if (ahora - desde > VENTANA_RAPIDA_MS && ahora - ultimo < REINTENTO_LENTO_MS) return
      ultimo = ahora
      const u = await ubicarBuzon($)
      if (u) {
        encontrada = true
        await vigilarBuzon($, u)
      }
    })().catch(() => {}).finally(() => { buscando = false })
  })
}

async function vigilarBuzon($: EngineInterface, ubicacion: Ubicacion): Promise<void> {
    await latir($, ubicacion)
    let anterior = await huella($, ubicacion.jsonl)
    let ticks = 0
    let ocupado = false
    // Lo que ya esperaba antes de que el mod cargara.
    void traerMensajes($).catch(() => {})
    $.clock.every(TICK_BUZON_MS, () => {
      if (ocupado) return
      ocupado = true
      void (async () => {
        ticks += 1
        if (ticks % LATIR_CADA_TICKS === 0) await latir($, ubicacion)
        const vista = await huella($, ubicacion.jsonl)
        if (vista !== anterior) {
          anterior = vista
          await traerMensajes($)
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
// FEAT-115/116 — De la sesión: sobrevive a una recarga del mod (los ids despachados y la nota pendiente incluidos).
const BANDEJA_VACIA: BandejaBanda = { mensajes: [], listos: [], respondiendo: null, notas: [], novedades: [], recallMirado: false }
const bandeja = atom({ plugin: 'lagrange', key: 'bandeja' } as const, BANDEJA_VACIA)
// BE-111 — Lo tecleado en el Input de la banda: cada redibujo lo vuelve a poner como `value` (si no, un redibujo
// pisaba lo escrito), y al enviar gana lo más completo. `bandaId` es el requestId de la banda, para darle el foco.
let borrador = ''
let bandaId: string | null = null

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
      void avisarFanout($, fan).catch(() => {})
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
        agentes: r.agentes ?? null, almas: r.almas ?? null, programaciones: r.programaciones ?? null, worktrees: r.worktrees ?? null,
        // BE-109 — FEAT-126 agregó la sección y no la clave: sin esto, las metas nunca llegaban al panel.
        metas: r.metas ?? null,
        // FEAT-121 — La red (mismo cuidado que BE-109: sin la clave, el bloque queda en «sin datos»).
        red: r.red ?? null
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

// ----------------------------------------------------------------- voz

// FEAT-119/120 — Un `say`/`narrate` con `local_playback` en curso y lo que el MCP avisó que suena
// (`buzones/voz-<claudePid>.json`, ubicado con `buzon.js mod-voz`: no depende del daemon).
const TICK_VOZ_MS = 1000
let rutaVoz: string | null = null
let vocesEnCurso = 0
let vozActual: VozEnCurso | null = null
let frasesVoz: string[] = []
let fraseVoz = -1

async function iniciarVoz($: EngineInterface): Promise<void> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/hooks/buzon.js`, 'mod-voz'])
    const v = r.exitCode === 0 ? (JSON.parse(r.stdout) as { voz?: unknown }).voz : null
    rutaVoz = typeof v === 'string' && v ? v : null
  } catch {
    rutaVoz = null
  }
}

// ----------------------------------------------------------------- FEAT-121

/**
 * Avisos de la red con toasts: un nodo que se cae, el daemon que deja de
 * responder, un nodo con otra versión. Cada aviso sale una vez cuando aparece
 * y, si se arregla solo (un nodo que vuelve), otra al irse. Los datos son los
 * de la sección «Red» del panel (`panel.js red`); un error al leer no decide.
 */
const PRIMERA_RED_MS = 20_000
const TICK_RED_MS = 5 * 60_000
let avisosRed: Map<string, AvisoRed> | null = null
let tickRed: { cancel(): void } | null = null

async function mirarRed($: EngineInterface): Promise<void> {
  const root = raizSesion || (await $.session.root())
  const r = await $.process.run(['node', `${$.plugin.root}/hooks/panel.js`, 'red', root ?? '.'])
  if (r.exitCode !== 0) return
  const red = (JSON.parse(r.stdout) as { red?: RedPanel | null }).red
  if (red == null) return
  const nuevos = new Map(avisosDeRed(red).map((a) => [a.clave, a] as const))
  const previos = avisosRed
  avisosRed = nuevos
  for (const [clave, a] of nuevos) if (!previos?.has(clave)) $.ui.toast(a.texto, { timeoutMs: 10_000 })
  if (previos) for (const [clave, a] of previos) if (!nuevos.has(clave) && a.recuperado) $.ui.toast(a.recuperado, { timeoutMs: 6_000 })
}

function iniciarRed($: EngineInterface): void {
  avisosRed = null
  $.clock.after(PRIMERA_RED_MS, () => { void mirarRed($).catch(() => {}) })
  if (!tickRed) tickRed = $.clock.every(TICK_RED_MS, () => { void mirarRed($).catch(() => {}) })
}

// ----------------------------------------------------------------- FEAT-135

/**
 * Avisos de fondo con toasts (lógica en `avisos-fondo.ts`): un fan-out o un
 * lote que termina, una cuota que se libera (o la propia que cruza el 90 %) y
 * un mensaje nuevo en la banda. El fan-out y los mensajes usan sus ticks; los
 * lotes y la cuota, `panel.js avisos` cada minuto, aunque el panel esté
 * cerrado. Lo que esta sesión está esperando no se avisa: llega por la tool.
 * Hasta el primer `panel.js avisos` no se sabe qué tipos quiere el usuario
 * (`background_toasts`), así que no sale ninguno.
 */
const PRIMEROS_AVISOS_MS = 20_000
const TICK_AVISOS_MS = 60_000
const PROPIA_MS = 2 * 60_000
const TOOLS_CON_FIN = ['agy_fanout', 'agy_lote'] as const
const finesPropios = new Map<string, number>()
let tiposAviso: Set<TipoAviso> | null = null
let estadoFanoutAv: EstadoFanout | undefined
let estadoLotesAv: EstadoLotes | undefined
let estadoCuotaAv: EstadoCuota | undefined
let estadoMensajesAv: EstadoMensajes | undefined
let tickAvisos: { cancel(): void } | null = null
let mirandoAvisos = false

function avisar($: EngineInterface, avisos: Aviso[]): void {
  if (!tiposAviso) return
  for (const a of avisos) if (tiposAviso.has(a.tipo)) $.ui.toast(a.texto, { timeoutMs: a.timeoutMs })
}

function esPropia(tool: (typeof TOOLS_CON_FIN)[number], ahora: number): boolean {
  for (const l of llamadas.values()) if (l.tool.endsWith(tool)) return true
  const fin = finesPropios.get(tool)
  return fin !== undefined && ahora - fin < PROPIA_MS
}

async function avisarFanout($: EngineInterface, fan: FanoutPanel | null): Promise<void> {
  const r = avisosFanout(estadoFanoutAv, fan, esPropia('agy_fanout', await $.clock.now()))
  estadoFanoutAv = r.estado
  avisar($, r.avisos)
}

async function mirarAvisos($: EngineInterface): Promise<void> {
  if (mirandoAvisos) return
  mirandoAvisos = true
  try {
    const root = raizSesion || (await $.session.root())
    const r = await $.process.run(['node', `${$.plugin.root}/hooks/panel.js`, 'avisos', root ?? '.'])
    if (r.exitCode !== 0) return
    const d = JSON.parse(r.stdout) as { lotes?: LoteAviso[] | null; cuota?: CuotaPanel | null; propia?: string | null; tipos?: unknown }
    tiposAviso = tiposDe(d.tipos)
    const ahora = await $.clock.now()
    if (Array.isArray(d.lotes)) {
      const x = avisosLotes(estadoLotesAv, d.lotes, esPropia('agy_lote', ahora))
      estadoLotesAv = x.estado
      avisar($, x.avisos)
    }
    // Sin dato no decide: una línea de base vacía haría avisar de golpe lo que ya estaba alto.
    if (d.cuota && typeof d.cuota === 'object') {
      const x = avisosCuota(estadoCuotaAv, d.cuota, ahora, d.propia ?? null)
      estadoCuotaAv = x.estado
      avisar($, x.avisos)
    }
  } finally {
    mirandoAvisos = false
  }
}

function iniciarAvisos($: EngineInterface): void {
  tiposAviso = null
  estadoFanoutAv = estadoLotesAv = estadoCuotaAv = estadoMensajesAv = undefined
  $.clock.after(PRIMEROS_AVISOS_MS, () => { void mirarAvisos($).catch(() => {}) })
  if (!tickAvisos) tickAvisos = $.clock.every(TICK_AVISOS_MS, () => { void mirarAvisos($).catch(() => {}) })
}

// ----------------------------------------------------------------- FEAT-117

/**
 * Fase 1: medir qué pasos podrían ir a Haiku 5.5 (`haiku-medicion.ts`), sin
 * desviar ninguno. Se acumula en `$.store` (entre sesiones) y se guarda al
 * cerrar cada turno del loop principal. `/lagrange-haiku` lo muestra.
 */
const CLAVE_MEDICION = 'medicion-haiku'
let medicion: Medicion = MEDICION_VACIA
let medicionSucia = false
// Las tools que pidió el último paso de cada loop (`principal` o el id del subagente).
const pedidasPorLoop = new Map<string, string[]>()
// El tipo de cada subagente, por su id (lo da `agent.spawn`).
const tipoDeAgente = new Map<string, string>()

async function medirPaso($: EngineInterface, e: { agentId?: string; index: number }, r: { toolUses?: ReadonlyArray<{ name: string }>; usage?: unknown } | undefined): Promise<void> {
  const loop = e.agentId ?? 'principal'
  const previas = e.index === 0 ? null : (pedidasPorLoop.get(loop) ?? null)
  const pedidas = (r?.toolUses ?? []).map((u) => u.name)
  pedidasPorLoop.set(loop, pedidas)
  const clase = clasificar({ tipoAgente: e.agentId ? tipoDeAgente.get(e.agentId) ?? null : null, enSubagente: Boolean(e.agentId), previas, pedidas })
  medicion = sumarPaso(medicion, clase, (r?.usage ?? null) as never, await $.clock.now())
  medicionSucia = true
}

async function guardarMedicion($: EngineInterface): Promise<void> {
  if (!medicionSucia) return
  medicionSucia = false
  await $.store.set(CLAVE_MEDICION, medicion)
}

// El tick vive solo mientras suena una voz: arranca con la primera y se cancela con la última.
let tickVoz: { cancel(): void } | null = null

function empezarVoz($: EngineInterface): void {
  vocesEnCurso += 1
  vozActual = null
  if (!tickVoz) tickVoz = $.clock.every(TICK_VOZ_MS, () => { void mirarVoz($).catch(() => {}) })
  $.ui.invalidate('ui.render')
}

/**
 * Con una voz en curso: lee el aviso hasta encontrarlo (una vez por llamada) y después cuenta la frase
 * con el reloj. Redibuja solo si cambió la voz o la frase.
 */
async function mirarVoz($: EngineInterface): Promise<void> {
  if (vocesEnCurso === 0) return
  const ahora = await $.clock.now()
  if (!vozActual && rutaVoz) {
    let crudo: string | null = null
    try { crudo = await $.fs.read(rutaVoz) } catch {}
    if (vocesEnCurso === 0) return
    const v = leerVoz(crudo, ahora)
    if (v) {
      vozActual = v
      frasesVoz = frases(v.texto)
      fraseVoz = -1
    }
  }
  if (vozActual && vozActual.hasta < ahora) {
    vozActual = null
    frasesVoz = []
  }
  const i = vozActual ? fraseEn(frasesVoz, ahora - vozActual.desde, vozActual.duracionMs) : -1
  if (i !== fraseVoz) {
    fraseVoz = i
    $.ui.invalidate('ui.render')
  }
}

function terminarVoz($: EngineInterface): void {
  vocesEnCurso = Math.max(0, vocesEnCurso - 1)
  if (vocesEnCurso > 0) return
  try { tickVoz?.cancel() } catch {}
  tickVoz = null
  vozActual = null
  frasesVoz = []
  fraseVoz = -1
  $.ui.invalidate('ui.render')
}

/** FEAT-120 — La fila de subtítulos, o `null`. */
function subtituloActual(): string | null {
  return vozActual && fraseVoz >= 0 && frasesVoz[fraseVoz] ? filaDeSubtitulo(vozActual, frasesVoz[fraseVoz]) : null
}
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
    // FEAT-135 — Lo que termine de esta tool en los próximos minutos ya llegó como resultado.
    for (const t of TOOLS_CON_FIN) if (l.tool.endsWith(t)) finesPropios.set(t, ahora)
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

/** FEAT-111 — Un JSON del disco, o `null` si falta o no se puede leer. */
async function leerJson($: EngineInterface, ruta: string): Promise<unknown> {
  try { return JSON.parse(await $.fs.read(ruta)) } catch { return null }
}

/** FEAT-111 — `{ deny }` si el usuario cancela por cuota baja; `null` para seguir. Nunca lanza. */
async function frenoDeCuota($: EngineInterface, tool: unknown, input: unknown): Promise<{ deny: string } | null> {
  try {
    const homes = [await $.env.get('USERPROFILE').catch(() => undefined), await $.env.get('HOME').catch(() => undefined)].filter((h): h is string => Boolean(h))
    if (!homes.length) return null
    const raiz = raizSesion || (await $.session.root())
    let global: unknown = null
    let uso: unknown = null
    for (const h of homes) {
      global ??= await leerJson($, `${h}/.claude/antigravity.json`)
      uso ??= await leerJson($, `${h}/.claude/antigravity-usage.json`)
    }
    const porDefecto = modeloPorDefecto(raiz ? await leerJson($, `${raiz}/.claude/antigravity.json`) : null, global, await $.env.get('AGY_MODEL').catch(() => undefined))
    const pedido = modelosDelPedido(tool, input, porDefecto)
    if (!pedido) return null
    const ahora = await $.clock.now()
    const x = bajo(pedido.modelos, restantes(uso, ahora))
    if (!x) return null
    // FEAT-131 — Las sondas del lote con Claude, donde las guarda el bridge (bridgeDataDirPath).
    let cuentas: string[] = []
    if (pedido.tool === 'agy_lote') {
      const explicito = await $.env.get('TELEGRAM_BRIDGE_DATA_DIR').catch(() => undefined)
      const local = await $.env.get('LOCALAPPDATA').catch(() => undefined)
      const dir = explicito && explicito.trim() ? explicito.trim() : (local ? `${local}/antigravity-telegram-bridge` : null)
      cuentas = cuentasClaudeOfrecibles(pedido.tool, dir ? await leerJson($, `${dir}/lotes-sondas-claude.json`) : null, uso, ahora)
    }
    let respuesta: string
    try {
      respuesta = await $.ui.ask(pregunta(x, pedido.tool, pedido.modelos.length), { options: [SEGUIR, ...cuentas.map(opcionClaude), CANCELAR], header: 'Cuota agy' })
    } catch {
      return null // Sin nadie a quién preguntar (claude -p) o descartado: no se retiene nada.
    }
    const d = decision(respuesta, x, cuentas)
    return 'deny' in d ? d : null
  } catch {
    return null
  }
}

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

  // FEAT-109 + FEAT-122 — Un solo `tool.call` sin matcher (el motor no admite dos): mide cada tool del
  // loop principal para la línea de tiempo y, si es de agy, la banda. Lo que devuelve o lanza sigue tal cual.
  on('tool.call', async ($, e, next) => {
    // FEAT-119/120 — Solo la que suena en la PC: sin `local_playback` el audio va a Telegram.
    const deVoz = esToolDeVoz(e.tool) && (e as { local_playback?: unknown }).local_playback === true
    if (deVoz) empezarVoz($)
    try {
      return await medirTool()
    } finally {
      if (deVoz) terminarVoz($)
    }

    async function medirTool() {
    const deAgy = esToolDeAgy(e.tool)
    const turno = (e as { agentId?: string }).agentId ? null : turnosAbiertos.values().next().value ?? null
    if (!deAgy && !turno) return next(e)
    if (deAgy) {
      // FEAT-111 — Antes de anotarla: una llamada cancelada no aparece en la banda ni en el turno.
      const freno = await frenoDeCuota($, e.tool, e) // los argumentos van planos, junto a `tool`
      if (freno) return freno
    }
    const clave = typeof e.tool_use_id === 'string' && e.tool_use_id ? e.tool_use_id : `l${++contadorLlamadas}`
    try {
      const ahora = await $.clock.now()
      if (turno) abrirTool(turno, clave, String(e.tool), ahora)
      if (deAgy) {
        llamadas.set(clave, { tool: e.tool, desde: ahora })
        $.ui.invalidate('ui.render')
      }
    } catch {}
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } catch (err) {
      try { if (turno) cerrarTool(turno, clave, await $.clock.now(), true) } catch {}
      if (deAgy) await cerrarLlamada($, clave, { fallo: true })
      throw err
    }
    const fallo = Boolean(r?.deny) || Boolean(r?.isError)
    try { if (turno) cerrarTool(turno, clave, await $.clock.now(), fallo) } catch {}
    if (deAgy) await cerrarLlamada($, clave, { texto: r?.text, fallo })
    return r
    }
  })

  // FEAT-115 — Lo que el usuario respondió desde la banda se le cuenta a Claude en su próximo prompt (texto del propio usuario).
  on('prompt.submit', async ($, e, next) => {
    try {
      const kind = (e as { origin?: { kind?: string } }).origin?.kind
      if (kind === 'composer' || kind === 'bridge') {
        const b = await read($, bandeja)
        const bloque = bloqueDeRespuestas(b.notas)
        if (bloque) {
          await update($, bandeja, (x) => ({ ...x, notas: [] }))
          return next({ ...e, text: `${bloque}${e.text}` })
        }
      }
    } catch {}
    return next(e)
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
    // FEAT-135 — Primero: pone en cero las líneas de base que el buzón y el panel llenan al arrancar.
    try { iniciarAvisos($) } catch {}
    await iniciarBuzon($).catch(() => {})
    await iniciarPanel($).catch(() => {})
    void iniciarRecall($).catch(() => {})
    await iniciarGates($).catch(() => {})
    await iniciarGuardas($).catch(() => {})
    await iniciarIdentidad($).catch(() => {})
    void iniciarVoz($).catch(() => {})
    void iniciarMetas($).catch(() => {})
    try { iniciarRed($) } catch {}
    // FEAT-117 — La medición acumulada de otras sesiones.
    try { medicion = leerMedicion(await $.store.get(CLAVE_MEDICION)) } catch {}
    await $.command.register({ name: 'lagrange-haiku', description: 'FEAT-117: qué parte de los pasos y tokens de Claude Code podría ir a Haiku 5.5 (solo mide; «reiniciar» empieza de cero)' }).catch(() => {})
    await $.command.register({ name: 'turno', description: 'Línea de tiempo del último turno: cuánto duró cada tool, requests, tokens y costo; abre el panel de Lagrange' }).catch(() => {})
    await $.command.register({
      name: 'lagrange-resumen',
      description: 'Resumen de esta sesión con todo el contexto ($.model.fork), guardado en ~/.claude/session-summaries. Relee la conversación entera: pide confirmación antes de gastar.'
    }).catch(() => {})
    return resultado
  })

  // FEAT-122 — El detalle en texto; la sección «Último turno» queda en el panel.
  on('command.run', { command: 'turno' }, async ($) => {
    // BE-108 — Sin turnos, solo el texto: abrir el panel no muestra nada nuevo.
    if (!turnosCerrados.length) return { text: textoDeTurno(turnosCerrados) }
    if (actual) { actual.abierto = true; void actual.refrescar().catch(() => {}) }
    await $.ui.open({ id: PANE, title: 'Lagrange' }).catch(() => {})
    return { text: textoDeTurno(turnosCerrados) }
  })

  // FEAT-122 — El inicio: el reloj y el costo acumulado de la sesión. Un subagente no dispara turn.start.
  on('turn.start', async ($, e, next) => {
    try {
      const ahora = await $.clock.now()
      for (const [id, t] of turnosAbiertos) if (ahora - t.desde > TURNO_VIEJO_MS) turnosAbiertos.delete(id)
      turnosAbiertos.set(e.turnId, nuevoTurno(e.turnId, ahora, await costoSesion($)))
    } catch {}
    return next(e)
  })

  // FEAT-122 — Solo cuenta requests: los tokens llegan sumados en turn.complete.
  // `turn.step` hace streaming: el generador reenvía cada pedazo tal cual y cuenta al terminar.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const t = turnosAbiertos.get(e.turnId)
    if (t) contarPaso(t)
    // FEAT-117 — Solo mide: el modelo y el esfuerzo quedan como los pidió el motor.
    try { await medirPaso($, e, r) } catch {}
    return r
  })

  // FEAT-117 — El tipo y el modelo de cada subagente, para la medición.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      if (r?.agentId) tipoDeAgente.set(r.agentId, e.subagentType)
      medicion = sumarSpawn(medicion, e.subagentType, String(r?.model ?? '?'), await $.clock.now())
      medicionSucia = true
    } catch {}
    return r
  })

  on('command.run', { command: 'lagrange-haiku' }, async ($, e) => {
    if (String(e.args ?? '').trim() === 'reiniciar') {
      medicion = MEDICION_VACIA
      medicionSucia = true
      await guardarMedicion($).catch(() => {})
      return { text: 'Medición de FEAT-117 reiniciada.' }
    }
    return { text: textoDeMedicion(medicion, await $.clock.now()) }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      // Un subagente que hubiera abierto uno lo cierra sin registrarlo; el cierre del principal vacía el resto.
      if (e.agentId) turnosAbiertos.delete(e.turnId)
      // FEAT-117 — Un subagente terminado ya no pide pasos; el principal guarda la medición.
      if (e.agentId) { pedidasPorLoop.delete(e.agentId); tipoDeAgente.delete(e.agentId) } else void guardarMedicion($).catch(() => {})
      const t = e.agentId ? undefined : turnosAbiertos.get(e.turnId)
      if (t) {
        turnosAbiertos.clear()
        const cerrado = cerrarTurno(t, { durationMs: e.durationMs, interrumpido: e.isAborted, costoFinal: await costoSesion($), ahora: await $.clock.now(), uso: e.usage })
        turnosCerrados = [...turnosCerrados, cerrado].slice(-TURNOS_GUARDADOS)
        if (actual?.abierto) $.ui.invalidate('ui.render')
      }
    } catch {}
    return r
  })

  // FEAT-126 — Responde al usuario; no entra a la conversación.
  on('command.run', { command: 'meta' }, async ($, e) => comandoMeta($, String(e.args ?? '')))

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
    const texto = textoDeFoto(await read($, foto), ahora, { guardas: guardasVigentes(guardas, { raiz: raizSesion, ahora }), metasPermitidos: await metasPermitidos($), turno: turnosCerrados.at(-1) ?? null })
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
    // FEAT-119 — Mientras suena una voz, el texto dice cuál; el sufijo con la cuenta sigue igual.
    const mensajeVoz = mensajeDeVoz(vocesEnCurso > 0, vozActual)
    if (!identidad && !mensajeVoz) return next(e)
    return next({
      ...e,
      props: {
        ...e.props,
        ...(identidad ? { suffix: sufijoConIdentidad(e.props.suffix, identidad) } : {}),
        ...(mensajeVoz ? { message: mensajeVoz } : {})
      }
    })
  })

  // FEAT-118 — `/clear` no dispara `session.start`: sin esto quedaría un aviso sobre una conversación vacía.
  on('session.end', ($, e, next) => {
    reiniciarHandoff()
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // FEAT-109 — La banda: solo en terminal y Desktop, y solo con algo que mostrar.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    bandaId = typeof e.requestId === 'string' ? e.requestId : bandaId
    const ahora = await $.clock.now()
    cierres = cierres.filter((c) => ahora < c.hasta)
    const estado = { llamadas: [...llamadas.values()], cierres, fanout: fanoutBanda, ahora }
    handoff = vigente(handoff, ahora)
    const conHandoff = hayAviso(handoff, ahora)
    // FEAT-115/116 — El primer mensaje sin despachar y la primera novedad de memoria.
    const caja = await read($, bandeja)
    const pendientesBanda = visibles(caja.mensajes, caja.listos)
    const mensaje = pendientesBanda[0] ?? null
    const novedad = caja.novedades[0] ?? null
    const subtitulo = subtituloActual()
    if (e.surface === 'vscode' || e.surface === 'mobile' || e.props.hasSurvey || (!hayAlgo(estado) && !conHandoff && !mensaje && !novedad && !subtitulo)) {
      bandaDibujada = false
      return next(e)
    }
    // FEAT-118 — Con aviso, una fila menos para agy: el aviso va al final y entra siempre.
    const max = Math.max(1, Math.min(10, e.props.maxRows - 2))
    const fila = conHandoff ? filaDeHandoff(handoff, ahora) : null
    const filasMensaje = mensaje ? filasDeMensaje(mensaje, pendientesBanda.length - 1) : []
    const propias = (fila ? 1 : 0) + (mensaje ? filasMensaje.length + 1 : 0) + (novedad ? 1 : 0) + (subtitulo ? 1 : 0)
    const filas = filasDeBanda({ ...estado, maxFilas: Math.max(0, max - propias) })
    const entreTurnos = !e.props.isWorking
    const respondiendo = mensaje && caja.respondiendo === mensaje.id
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    bandaDibujada = true
    return (
      <Box flexDirection="column">
        {subtitulo && <Text wrap="truncate-end" color="green">{subtitulo}</Text>}
        {filas.map((f) => <Text wrap="truncate-end" color={COLOR_DE_TONO[f.tono]} dimColor={f.tono === 'tenue'}>{f.texto}</Text>)}
        {mensaje && filasMensaje.map((t, i) => <Text wrap="truncate-end" color={i === 0 ? 'cyan' : undefined}>{t}</Text>)}
        {mensaje && respondiendo && (
          <Box flexDirection="row" gap={1}>
            <Input key="buzon-respuesta" autoFocus label="respuesta:" value={borrador} placeholder={`tu respuesta a ${remitente(mensaje)}`} submitLabel="enviar"
              onInput={(v: string) => { borrador = v }}
              onSubmit={(v: string) => { const t = textoFinal(v, borrador); borrador = ''; void responderDesdeLaBanda($, mensaje.id, t).catch(() => {}) }} />
            <Button key="buzon-cancelar" dimColor label="cancelar" onPress={() => { borrador = ''; void update($, bandeja, (b) => ({ ...b, respondiendo: null })).then(() => $.ui.invalidate('ui.render')) }} />
          </Box>
        )}
        {mensaje && !respondiendo && (
          <Box flexDirection="row" gap={1}>
            {entreTurnos && <Button key="buzon-responder" hotkey="r" variant="primary" label="responder" onPress={() => {
              borrador = ''
              void update($, bandeja, (b) => ({ ...b, respondiendo: mensaje.id }))
                .then(() => $.ui.invalidate('ui.render'))
                // BE-111 — El foco va al campo: sin esto, lo tecleado podía terminar en el prompt.
                .then(() => (bandaId ? $.ui.focus({ requestId: bandaId, key: 'buzon-respuesta' }) : undefined))
                .catch(() => {})
            }} />}
            {entreTurnos && <Button key="buzon-claude" hotkey="c" label="pasar a Claude" onPress={() => { void despachar($, mensaje.id).then(() => $.prompt.submit({ text: avisoParaClaude(mensaje) })).catch(() => {}) }} />}
            {entreTurnos && <Button key="buzon-luego" hotkey="l" dimColor label="más tarde" onPress={() => { void despachar($, mensaje.id).catch(() => {}) }} />}
            <Text dimColor>{entreTurnos ? '· clic, o ctrl+x y Tab' : '· al terminar el turno'}</Text>
          </Box>
        )}
        {novedad && (
          <Box flexDirection="row" gap={1}>
            <Text wrap="truncate-end" color="magenta">{filaDeNovedad(novedad)}</Text>
            {entreTurnos && <Button key="recall-traer" hotkey="t" variant="primary" label="traer" onPress={() => { void marcarRecall($, novedad.cuenta, true).catch(() => {}) }} />}
            {entreTurnos && <Button key="recall-no" hotkey="n" dimColor label="ahora no" onPress={() => { void marcarRecall($, novedad.cuenta, false).catch(() => {}) }} />}
          </Box>
        )}
        {fila && (
          <Box flexDirection="row" gap={1}>
            <Text wrap="truncate-end" color={COLOR_DE_HANDOFF[fila.tono]}>{fila.texto}</Text>
            {fila.botones && !e.props.isWorking && <Button key="handoff-guardar" hotkey="h" variant="primary" label="guardar handoff" onPress={() => { void guardarHandoff($).catch(() => {}) }} />}
            {fila.botones && !e.props.isWorking && <Button key="handoff-no" hotkey="x" dimColor label="ahora no" onPress={() => { handoff = descartar(handoff); $.ui.invalidate('ui.render') }} />}
            {fila.botones && <Text dimColor>{e.props.isWorking ? '· handoff al terminar el turno' : '· clic, o ctrl+x y Tab'}</Text>}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const ahora = await $.clock.now()
    const bloques = filasDeFoto(await read($, foto), ahora, { guardas: guardasVigentes(guardas, { raiz: raizSesion, ahora }), metasPermitidos: await metasPermitidos($), turno: turnosCerrados.at(-1) ?? null })
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
