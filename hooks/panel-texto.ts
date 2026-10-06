import type { FotoPanel, VentanaCuota, MetaPanel } from '../types'
import type { Guarda } from './guardas.ts'
import { cabecera, tiras, porTipo, TOPE_FILAS_PANEL } from './turno-texto.ts'
import type { TurnoCerrado } from './turno-texto.ts'

/**
 * FEAT-101 — La foto del panel en filas, sin `$`: la dibuja el Pane y la
 * devuelve el comando `lagrange-panel`. Las cuotas guardan la fracción usada
 * (agy la invierte desde "% restante" en `cuota-agy.js`).
 *
 * FEAT-106 — Cada fila es una lista de segmentos con estilo. El Pane los dibuja
 * con color; `textoDeFoto` concatena el texto (vuelve a la conversación: nada
 * de ANSI). Un segmento `soloTexto` (el emoji de la cuota) va solo al texto.
 */

export type Segmento = { texto: string; color?: string; tenue?: boolean; negrita?: boolean; soloTexto?: boolean }
export type Bloque = { titulo: string; filas: Segmento[][] }

const s = (texto: string, estilo: Omit<Segmento, 'texto'> = {}): Segmento => ({ texto, ...estilo })
const tenue = (texto: string): Segmento => s(texto, { tenue: true })
const fila = (texto: string): Segmento[] => [s(texto)]
const filaTenue = (texto: string): Segmento[] => [tenue(texto)]

const fecha = (v: string | null | undefined) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null)

// BE-092 — Una ventana que ya pasó su reinicio no tiene porcentaje que valga, y
// cada fila dice de cuándo es el dato.
function hace(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`
}

// FEAT-106 — Los umbrales de la statusline (`statusline-base.js`): verde < 50,
// amarillo < 75, ámbar < 90, rojo ≥ 90. Nombres de Ink o hex.
const CELDAS = 10
const VIEJO_MS = 6 * 60 * 60 * 1000

function colorDe(p: number): string {
  if (p >= 90) return 'red'
  if (p >= 75) return '#ff8700'
  if (p >= 50) return 'yellow'
  return 'green'
}

function emojiDe(p: number | null): string {
  if (p === null) return '⚪'
  if (p >= 90) return '🔴'
  if (p >= 75) return '🟠'
  if (p >= 50) return '🟡'
  return '🟢'
}

function barra(p: number): string {
  const llenas = Math.max(0, Math.min(CELDAS, Math.round(p / 10)))
  return '█'.repeat(llenas) + '░'.repeat(CELDAS - llenas)
}

/** La celda de una ventana (lo que va después de `5h `): `████░░░░░░ 40%`, `░░░░░░░░░░ reiniciada` o `—`. Con el % que vale, o `null`. */
function ventana(frac: number | null | undefined, resetea: string | null | undefined, ahora: number): Celda {
  const r = fecha(resetea)
  if (r !== null && ahora >= r) return { celda: [tenue(`${barra(0)} reiniciada`)], pct: null, resetea: null }
  if (typeof frac !== 'number') return { celda: [tenue('—')], pct: null, resetea: null }
  const p = Math.round(frac * 100)
  const color = colorDe(p)
  return { celda: [s(barra(p), { color }), s(' '), s(`${p}%`, { color })], pct: p, resetea: r }
}

/**
 * FEAT-124 — El pronóstico: con la ventana de más uso en ≥ 75 % y su reinicio por venir,
 * «· despeja HH:MM» (o «el DD/MM» a más de 24 h), del color de su punto. En un empate,
 * el reinicio más tardío: recién ahí se despeja. Sin pct (reiniciada o sin dato), nada.
 */
export function pronostico(ventanas: readonly Celda[], ahora: number): Segmento | null {
  // El mismo máximo que decide el punto de la fila: si esa ventana no tiene reinicio conocido, no se pronostica con otra.
  const conPct = ventanas.filter((v): v is Celda & { pct: number } => v.pct !== null)
  if (!conPct.length) return null
  const peor = Math.max(...conPct.map((v) => v.pct))
  if (peor < 75) return null
  const reinicios = conPct.filter((v) => v.pct === peor && v.resetea !== null && v.resetea > ahora).map((v) => v.resetea as number)
  if (!reinicios.length) return null
  const r = Math.max(...reinicios)
  const d = new Date(r)
  const dos = (n: number) => String(n).padStart(2, '0')
  const cuando = r - ahora > 24 * 60 * 60 * 1000 ? `el ${dos(d.getDate())}/${dos(d.getMonth() + 1)}` : `${dos(d.getHours())}:${dos(d.getMinutes())}`
  // Dos espacios, como «(visto hace …)»: sin ese texto, no queda pegado al porcentaje de 7d.
  return s(`  · despeja ${cuando}`, { color: colorDe(peor) })
}

const anchoDe = (celda: Segmento[]) => celda.reduce((n, x) => n + x.texto.length, 0)

/** La celda más el relleno (sin estilo) hasta el ancho de su columna (§8). */
function rellenar(celda: Segmento[], ancho: number): Segmento[] {
  const falta = ancho - anchoDe(celda)
  return falta > 0 ? [...celda, s(' '.repeat(falta))] : celda
}

type Celda = { celda: Segmento[]; pct: number | null; resetea: number | null }
type Celdas = { cinco: Celda; siete: Celda }
type Anchos = { nombre: number; cinco: number; siete: number }

/** Una fila de cuota: emoji (solo texto), nombre rellenado, las dos ventanas en columna y de cuándo es el dato. */
function filaCuota(nombre: string, { cinco, siete }: Celdas, anchos: Anchos, ahora: number, vistoEn: string | null | undefined): Segmento[] {
  const usos = [cinco.pct, siete.pct].filter((x): x is number => x !== null)
  const peor = usos.length ? Math.max(...usos) : null
  const visto = fecha(vistoEn)
  const segs: Segmento[] = [
    s(`${emojiDe(peor)} `, { soloTexto: true }), s(`${nombre.padEnd(anchos.nombre)}  `),
    s('5h '), ...rellenar(cinco.celda, anchos.cinco), s(' · '),
    // Sin relleno al final de la fila: la celda de 7d solo se rellena si sigue "(visto hace …)".
    s('7d '), ...(visto !== null ? rellenar(siete.celda, anchos.siete) : siete.celda)
  ]
  if (visto !== null) {
    const edad = ahora - visto
    // El amarillo reemplaza al tenue: combinados, en la terminal se lee mal.
    segs.push(s('  '), edad > VIEJO_MS ? s(`(visto hace ${hace(edad)})`, { color: 'yellow' }) : tenue(`(visto hace ${hace(edad)})`))
  }
  const p = pronostico([cinco, siete], ahora)
  if (p) segs.push(p)
  return segs
}

// FEAT-105 — "vence en 25 min" / "vence en 3 h" / "vence en 2 d".
function dentroDe(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`
}

function cuando(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

// BE-102 — Cómo se muestra cada grupo de cuota de agy; la clave (`grupos.claude_gpt` en uso-agy.js) no cambia.
// El mismo mapa vive en mcp-server/lib/statusline-lagrange.js (CommonJS): si se agrega un grupo, en los dos.
// Un grupo nuevo sale con su clave tal cual hasta que se lo nombre acá.
const NOMBRE_GRUPO_AGY: Record<string, string> = { claude_gpt: 'claude/gpt' }

type Extra = { guardas?: Guarda[]; metasPermitidos?: readonly string[]; turno?: TurnoCerrado | null }

// ----------------------------------------------------------------- FEAT-126 metas

/** Cuánto va, de 0 a 1: el tiempo transcurrido, el conteo o la condición. */
export function progresoDeMeta(m: MetaPanel, ahora: number): number {
  if (m.estado.cumplida) return 1
  if (m.tipo === 'fecha') {
    const ini = Date.parse(m.creada), fin = Date.parse(m.fin ?? '')
    return Number.isFinite(ini) && Number.isFinite(fin) && fin > ini ? Math.max(0, Math.min(1, (ahora - ini) / (fin - ini))) : 0
  }
  if (m.tipo === 'conteo') return m.objetivo && m.estado.valor !== null ? Math.max(0, Math.min(1, m.estado.valor / m.objetivo)) : 0
  return 0
}

/** «faltan 3 d 4 h», «7/20», «pendiente»; «cumplida» al llegar. */
export function detalleDeMeta(m: MetaPanel, ahora: number): string {
  if (m.estado.cumplida) return 'cumplida'
  if (m.tipo === 'conteo') return `${m.estado.valor ?? '?'}/${m.objetivo}`
  if (m.tipo === 'condicion') return 'pendiente'
  const falta = Date.parse(m.fin ?? '') - ahora
  if (!Number.isFinite(falta)) return '?'
  const h = Math.max(0, Math.floor(falta / 3_600_000))
  return h >= 24 ? `faltan ${Math.floor(h / 24)} d ${h % 24} h` : `faltan ${h} h ${Math.max(0, Math.floor((falta % 3_600_000) / 60_000))} min`
}

/** Sin aprobar: tiene comandos y alguno no está entre los que aprobó esta cuenta. */
export function metaSinAprobar(m: MetaPanel, permitidos: readonly string[]): boolean {
  return m.hashes.some((h) => !permitidos.includes(h))
}

export function filaDeMeta(m: MetaPanel, ahora: number, permitidos: readonly string[]): Segmento[] {
  const p = progresoDeMeta(m, ahora)
  const color = m.estado.cumplida ? 'green' : m.estado.enRiesgo ? 'yellow' : undefined
  const segs: Segmento[] = [s(`${m.nombre} `, { negrita: true }), s(barra(p * 100), { color: color ?? 'cyan' }), s(` ${detalleDeMeta(m, ahora)}`, { color })]
  if (m.estado.enRiesgo && !m.estado.cumplida) segs.push(s(' ⚠ en riesgo', { color: 'yellow' }))
  if (!m.estado.cumplida && metaSinAprobar(m, permitidos)) segs.push(tenue(` · sin aprobar (/meta aprobar ${m.id})`))
  else if (m.estado.error && !m.estado.cumplida) segs.push(tenue(` · ${m.estado.error}`))
  return segs
}

/** Lo que responde `/meta`: cada meta con su id y sus comandos. */
export function textoDeMetas(metas: readonly MetaPanel[], ahora: number, permitidos: readonly string[]): string {
  if (!metas.length) return 'No hay metas en este proyecto. Creá una con /meta fecha|conteo|condicion … (ver /meta ayuda).'
  return metas.map((m) => {
    const linea = filaDeMeta(m, ahora, permitidos).map((x) => x.texto).join('')
    const cmds = [m.medir ? `  mide: ${m.medir.join(' ')}` : null, m.riesgo ? `  riesgo: ${m.riesgo.join(' ')}` : null].filter(Boolean)
    return [`${m.id} · ${linea}`, ...cmds].join('\n')
  }).join('\n')
}

/** Las secciones de FEAT-105. Las guardas llegan ya filtradas: solo motivo y vencimiento, nunca la secuencia ni la raíz. */
function seccionesNuevas(f: FotoPanel | null, ahora: number, { guardas, metasPermitidos, turno }: Extra): Bloque[] {
  const a = f?.agentes
  const agentes: Segmento[][] = a == null
    ? [filaTenue('sin datos')]
    : a.estado === 'sin-enlace'
      ? [filaTenue('daemon sin enlace')]
      : a.sesiones.length
        ? [
            ...a.sesiones.map((x) => [
              s(x.nodo, { color: 'magenta' }), s(`/${x.nombre} · ${x.proyecto ?? '?'} · desde ${cuando(x.desde)}`),
              ...(x.silenciada ? [tenue(' (no recibe)')] : [])
            ]),
            ...(a.aviso ? [[s(`⚠ ${a.aviso}`, { color: 'yellow' })]] : [])
          ]
        : [filaTenue('ninguna sesión registrada')]
  const al = f?.almas
  const numero = (n: number) => (n > 0 ? s(String(n), { color: 'yellow' }) : s(String(n)))
  const almas: Segmento[][] = al
    ? [
        [numero(al.pendientes), s(' pendientes de consolidar · '), numero(al.cuarentena), s(' en cuarentena')],
        // FEAT-127 — Las activas en las últimas 24 h: solo nombre, superficie y cuándo.
        ...(al.recientes ?? []).map((x) => [s(x.nombre, { negrita: true }), tenue(`${x.superficie ? ` · ${x.superficie}` : ''} · hace ${hace(ahora - x.ts)}`)])
      ]
    : [filaTenue('sin datos')]
  const p = f?.programaciones
  const programaciones: Segmento[][] = p
    ? [...p.proximas.map((x) => [s(cuando(x.proxima)), s(` · ${x.titulo}`)]), [tenue(`${p.activas} activas · ${p.pausadas} pausadas`)]]
    : [filaTenue('sin datos')]
  // BE-101 — Las idénticas (mismo motivo y mismo vencimiento) en una fila con su cuenta. Campo a campo,
  // sin clave de texto: un motivo puede tener `:`. En el orden de la primera de cada grupo.
  const grupos: Array<{ g: Guarda; n: number }> = []
  for (const g of guardas ?? []) {
    const igual = grupos.find((x) => x.g.motivo === g.motivo && x.g.vence === g.vence)
    if (igual) igual.n += 1
    else grupos.push({ g, n: 1 })
  }
  const filasGuardas: Segmento[][] = grupos.length
    ? grupos.map(({ g, n }) => [s(g.motivo, { color: 'yellow' }), tenue(` · ${g.vence === null ? 'sin vencimiento' : `vence en ${dentroDe(g.vence - ahora)}`}${n > 1 ? ` · ${n} reglas` : ''}`)])
    : [filaTenue('ninguna')]
  const bloques: Bloque[] = [
    { titulo: 'Agentes', filas: agentes },
    { titulo: 'Almas', filas: almas },
    { titulo: 'Programaciones', filas: programaciones },
    { titulo: 'Guardas', filas: filasGuardas }
  ]
  if (f?.metas?.length) bloques.push({ titulo: 'Metas', filas: f.metas.map((m) => filaDeMeta(m, ahora, metasPermitidos ?? [])) })
  // FEAT-122 — El último turno del loop principal: el detalle completo, con /turno.
  if (turno) bloques.push({ titulo: 'Último turno', filas: [fila(cabecera(turno)), ...tiras(turno, TOPE_FILAS_PANEL).map((x) => [s(x.texto, x.error ? { color: 'red' } : {})]), [tenue(porTipo(turno).join(' · ') || 'sin tools')]] })
  const w = f?.worktrees
  if (w && w.length) bloques.push({ titulo: 'Worktrees huérfanos', filas: w.map((x) => [s(x.nombre, { color: 'yellow' }), ...(x.vacia ? [tenue(' (vacía)')] : [])]) })
  return bloques
}

export function filasDeFoto(f: FotoPanel | null, ahora: number, extra: Extra = {}): Bloque[] {
  const fan = f?.fanout
  const fanout: Segmento[][] = fan
    ? [fila(fan.linea ?? `fan-out ${fan.slug ?? ''}`), ...fan.tareas.map((t) => fila(`  ${t.estado} · ${t.id}`))]
    : [filaTenue('sin fan-out en curso')]

  const c = f?.cuota
  const entradas: Array<{ nombre: string; v: VentanaCuota; vistoEn: string | null | undefined }> = []
  if (c?.antigravity) for (const [g, v] of Object.entries(c.antigravity.grupos)) entradas.push({ nombre: `agy ${NOMBRE_GRUPO_AGY[g] ?? g}`, v, vistoEn: c.antigravity.vistoEn })
  if (c?.claude) entradas.push({ nombre: 'claude', v: c.claude, vistoEn: c.claude.vistoEn })
  if (c?.claudePorCuenta) for (const [cuenta, v] of Object.entries(c.claudePorCuenta)) entradas.push({ nombre: `claude@${cuenta}`, v, vistoEn: v.vistoEn })
  // §8 — Dos pasadas: primero todas las celdas, para medir el ancho de cada columna; después las filas.
  const celdas: Celdas[] = entradas.map((e) => ({ cinco: ventana(e.v.ventana5h, e.v.resetea5h, ahora), siete: ventana(e.v.ventana7d, e.v.resetea7d, ahora) }))
  const anchos: Anchos = {
    nombre: entradas.reduce((m, e) => Math.max(m, e.nombre.length), 0),
    cinco: celdas.reduce((m, c) => Math.max(m, anchoDe(c.cinco.celda)), 0),
    siete: celdas.reduce((m, c) => Math.max(m, anchoDe(c.siete.celda)), 0)
  }
  const cuota = entradas.map((e, i) => filaCuota(e.nombre, celdas[i], anchos, ahora, e.vistoEn))

  const v = f?.versiones
  const versiones: Segmento[][] = v
    ? [
        fila(`esta copia: ${v.propia ?? '?'}`),
        ...v.cuentas.map((x) => [
          s(`${x.cuenta}${x.propia ? ' (esta sesión)' : ''}: ${x.version ?? x.estado}`),
          ...(x.desactualizada ? [s(' ⚠ desactualizada', { color: 'red' })] : [])
        ])
      ]
    : []
  return [
    { titulo: 'Fan-out', filas: fanout },
    { titulo: 'Cuota', filas: cuota.length ? cuota : [filaTenue('sin datos')] },
    { titulo: 'Versiones', filas: versiones.length ? versiones : [filaTenue('sin datos')] },
    ...seccionesNuevas(f, ahora, extra)
  ]
}

/** Para la conversación: el texto de los segmentos (con el emoji), sin estilos. */
export function textoDeFoto(f: FotoPanel | null, ahora: number, extra: Extra = {}): string {
  return filasDeFoto(f, ahora, extra)
    .map((b) => [`**${b.titulo}**`, ...b.filas.map((segs) => segs.map((x) => x.texto).join(''))].join('\n'))
    .join('\n\n')
}
