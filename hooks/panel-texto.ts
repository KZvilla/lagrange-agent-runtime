import type { FotoPanel, VentanaCuota } from '../types'
import type { Guarda } from './guardas.ts'

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
function ventana(frac: number | null | undefined, resetea: string | null | undefined, ahora: number): { celda: Segmento[]; pct: number | null } {
  const r = fecha(resetea)
  if (r !== null && ahora >= r) return { celda: [tenue(`${barra(0)} reiniciada`)], pct: null }
  if (typeof frac !== 'number') return { celda: [tenue('—')], pct: null }
  const p = Math.round(frac * 100)
  const color = colorDe(p)
  return { celda: [s(barra(p), { color }), s(' '), s(`${p}%`, { color })], pct: p }
}

const anchoDe = (celda: Segmento[]) => celda.reduce((n, x) => n + x.texto.length, 0)

/** La celda más el relleno (sin estilo) hasta el ancho de su columna (§8). */
function rellenar(celda: Segmento[], ancho: number): Segmento[] {
  const falta = ancho - anchoDe(celda)
  return falta > 0 ? [...celda, s(' '.repeat(falta))] : celda
}

type Celdas = { cinco: { celda: Segmento[]; pct: number | null }; siete: { celda: Segmento[]; pct: number | null } }
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

type Extra = { guardas?: Guarda[] }

/** Las secciones de FEAT-105. Las guardas llegan ya filtradas: solo motivo y vencimiento, nunca la secuencia ni la raíz. */
function seccionesNuevas(f: FotoPanel | null, ahora: number, { guardas }: Extra): Bloque[] {
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
    ? [[numero(al.pendientes), s(' pendientes de consolidar · '), numero(al.cuarentena), s(' en cuarentena')]]
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
