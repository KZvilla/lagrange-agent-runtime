/**
 * FEAT-115 + FEAT-116 — El buzón y el recall en la banda, sin `$`: qué
 * mensajes se ven, cómo se dibujan, y los textos que el plugin manda a Claude.
 *
 * El texto de un mensaje de otro agente se le muestra al USUARIO en la banda;
 * a Claude nunca le llega por acá: con «pasar a Claude» recibe el mismo aviso
 * de siempre (quién y cuántos) y lo lee con `mensaje leer`, dentro de su sobre.
 */

import type { MensajeBanda, NotaRespuesta, NovedadBanda } from '../types'
export type { MensajeBanda, NotaRespuesta, NovedadBanda }

/** Lo que se ve en la banda: los pendientes que el usuario no despachó en esta sesión. */
export function visibles(mensajes: readonly MensajeBanda[], listos: readonly string[]): MensajeBanda[] {
  const fuera = new Set(listos)
  return mensajes.filter((m) => m && typeof m.id === 'string' && m.id && !fuera.has(m.id))
}

/** `nodo/nombre`, o solo el nombre en el nodo local. */
export function remitente(m: MensajeBanda): string {
  return m.de.nodo && m.de.nodo !== 'local' ? `${m.de.nodo}/${m.de.nombre}` : m.de.nombre || 'otro agente'
}

const MAX_FILAS_TEXTO = 3

/** Las filas del primer mensaje: la cabecera y hasta tres líneas del texto. */
export function filasDeMensaje(m: MensajeBanda, mas: number): string[] {
  const lineas = m.texto.split('\n').map((l) => l.trim()).filter(Boolean)
  const cuerpo = lineas.slice(0, MAX_FILAS_TEXTO)
  if (lineas.length > MAX_FILAS_TEXTO) cuerpo[MAX_FILAS_TEXTO - 1] = `${cuerpo[MAX_FILAS_TEXTO - 1]} …`
  const resto = mas > 0 ? `  (+${mas} más)` : ''
  return [`✉ ${remitente(m)} · de otro agente${resto}`, ...cuerpo.map((l) => `  ${l}`)]
}

// El mismo saneo que `textoAviso` de `mcp-server/lib/buzones.js`: lo que diga otro nodo no entra crudo.
const limpio = (v: unknown) => String(v ?? '').replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 81)

/** «Pasar a Claude»: el aviso de siempre, sin el texto. */
export function avisoParaClaude(m: MensajeBanda): string {
  return `📨 Tenés 1 mensaje de otros agentes (de ${limpio(m.de.nodo)}/${limpio(m.de.nombre)}). Leelo con la herramienta \`mensaje\`, accion: leer.`
}

/**
 * Lo que se antepone al próximo prompt del usuario después de responder desde
 * la banda: el texto es del propio usuario. Vacío si no hay notas.
 */
export function bloqueDeRespuestas(notas: readonly NotaRespuesta[]): string {
  if (!notas.length) return ''
  // El remitente y el id vienen de otro agente: saneados como en el aviso; el texto es del propio usuario.
  const filas = notas.map((n) => `- A ${limpio(n.de)} (mensaje ${limpio(n.id)}) le respondí desde la banda: «${n.texto}»`)
  return `[Mientras tanto, desde la banda de Lagrange]\n${filas.join('\n')}\nLos mensajes originales están en \`mensaje\` (accion: leer, todos: true).\n\n`
}

const CUENTA = /^[\w-]{1,40}$/

/** FEAT-116 — El pedido de «traer»: solo la cuenta (validada) y cuántas notas. Sin nombres de archivo. */
export function pedidoDeRecall(n: NovedadBanda): string | null {
  if (!CUENTA.test(n.cuenta)) return null
  const cuantas = `${n.cantidad} nota${n.cantidad === 1 ? '' : 's'}`
  return `Traé con la tool \`recall\` (desde: "${n.cuenta}") la memoria de esta cuenta para este proyecto: tiene ${cuantas} nuevas o cambiadas. Seguí la skill \`recall\`: compará con tu memoria, verificá contra el código y guardá solo lo que sirva, adaptado.`
}

/** FEAT-116 — La fila de la banda. */
export function filaDeNovedad(n: NovedadBanda): string {
  return `📚 ${n.nombre} tiene ${n.cantidad} nota${n.cantidad === 1 ? '' : 's'} nueva${n.cantidad === 1 ? '' : 's'} de este proyecto`
}

/** FEAT-116 — Del JSON de `recall-novedades.js` a filas: cantidad y la marca a guardar (el mtime más nuevo). */
export function novedadesDe(salida: unknown): NovedadBanda[] {
  const cuentas = (salida as { cuentas?: unknown } | null)?.cuentas
  if (!Array.isArray(cuentas)) return []
  const out: NovedadBanda[] = []
  for (const c of cuentas) {
    const notas = Array.isArray(c?.notas) ? c.notas.filter((x: { mtimeMs?: unknown }) => typeof x?.mtimeMs === 'number') : []
    if (typeof c?.cuenta !== 'string' || !CUENTA.test(c.cuenta) || !notas.length) continue
    const nombre = typeof c.nombre === 'string' && c.nombre.trim() ? c.nombre.trim().slice(0, 40) : c.cuenta
    const total = Number.isInteger(c.total) && c.total >= notas.length ? c.total : notas.length
    out.push({ cuenta: c.cuenta, nombre, cantidad: total, hasta: Math.max(...notas.map((x: { mtimeMs: number }) => x.mtimeMs)) })
  }
  return out
}
