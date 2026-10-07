import { tokensDe } from './turno-texto.ts'

/**
 * FEAT-117 fase 1 — Medir qué requests de Claude Code podrían ir a Haiku 5.5,
 * sin desviar ninguno. Puro: clasifica cada paso (`turn.step`) y cada
 * subagente (`agent.spawn`) y acumula pasos y tokens por clase; `mods.tsx`
 * solo lo cablea y lo guarda en `$.store` (sobrevive entre sesiones).
 *
 * Las clases:
 *   - `lectura`: un paso del loop principal que viene de un paso que solo pidió
 *     tools de lectura y que a su vez solo pide tools de lectura. Es el
 *     «subturno trivial» de FEAT-117: encadenar búsquedas.
 *   - `principal`: cualquier otro paso del loop principal (responder, editar,
 *     decidir). No es candidato.
 *   - `sub:<tipo>`: los pasos de un subagente, por tipo. Candidatos los de
 *     `SUBAGENTES_CANDIDATOS` (solo leen y devuelven una conclusión).
 *
 * Ojo al leer los números: la caché de prompt es por modelo. Un paso que
 * cambia de modelo a mitad de un turno relee todo su contexto sin caché; por
 * eso se guardan aparte los tokens leídos de caché, que serían los que se
 * pierden.
 */

export const LECTURA = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead'])
export const SUBAGENTES_CANDIDATOS = new Set(['Explore', 'claude-code-guide', 'lagrange:agy', 'agy'])

export type Cuenta = { pasos: number; entrada: number; salida: number; cacheLeida: number; modelos: Record<string, number> }
export type Medicion = { desde: number | null; clases: Record<string, Cuenta>; spawns: Record<string, Record<string, number>> }

export const MEDICION_VACIA: Medicion = { desde: null, clases: {}, spawns: {} }

type Uso = Parameters<typeof tokensDe>[0] & { model?: string }

/** Lo que se sabe de un paso al terminar. `previas`: las tools que pidió el paso anterior del mismo loop (null en el primero). */
export type Paso = { tipoAgente: string | null; enSubagente: boolean; previas: string[] | null; pedidas: string[] }

export function clasificar(p: Paso): string {
  if (p.enSubagente) return `sub:${p.tipoAgente ?? 'desconocido'}`
  const soloLectura = (l: string[]) => l.length > 0 && l.every((t) => LECTURA.has(t))
  return p.previas && soloLectura(p.previas) && soloLectura(p.pedidas) ? 'lectura' : 'principal'
}

export function esCandidata(clase: string): boolean {
  return clase === 'lectura' || (clase.startsWith('sub:') && SUBAGENTES_CANDIDATOS.has(clase.slice(4)))
}

export function sumarPaso(m: Medicion, clase: string, uso: Uso | null, ahora: number): Medicion {
  const t = tokensDe(uso)
  const c = m.clases[clase] ?? { pasos: 0, entrada: 0, salida: 0, cacheLeida: 0, modelos: {} }
  const modelo = uso?.model || '?'
  const nueva: Cuenta = {
    pasos: c.pasos + 1,
    entrada: c.entrada + t.entrada + t.cacheEscrita,
    salida: c.salida + t.salida,
    cacheLeida: c.cacheLeida + t.cacheLeida,
    modelos: { ...c.modelos, [modelo]: (c.modelos[modelo] ?? 0) + 1 }
  }
  return { ...m, desde: m.desde ?? ahora, clases: { ...m.clases, [clase]: nueva } }
}

export function sumarSpawn(m: Medicion, tipo: string, modelo: string, ahora: number): Medicion {
  const s = m.spawns[tipo] ?? {}
  return { ...m, desde: m.desde ?? ahora, spawns: { ...m.spawns, [tipo]: { ...s, [modelo]: (s[modelo] ?? 0) + 1 } } }
}

/** Valida lo leído de `$.store`: algo roto empieza de cero. */
export function leerMedicion(v: unknown): Medicion {
  if (!v || typeof v !== 'object') return MEDICION_VACIA
  const m = v as Partial<Medicion>
  if (typeof m.clases !== 'object' || !m.clases || typeof m.spawns !== 'object' || !m.spawns) return MEDICION_VACIA
  return { desde: typeof m.desde === 'number' ? m.desde : null, clases: m.clases, spawns: m.spawns }
}

const miles = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n))
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : '—')

/** El informe de `/lagrange-haiku`. */
export function textoDeMedicion(m: Medicion, ahora: number): string {
  const clases = Object.entries(m.clases)
  if (!clases.length && !Object.keys(m.spawns).length) return 'Todavía no hay pasos medidos. La medición corre sola en cada turno; volvé a mirar después de trabajar un rato.'
  const total = clases.reduce((n, [, c]) => n + c.entrada + c.salida + c.cacheLeida, 0)
  const pasos = clases.reduce((n, [, c]) => n + c.pasos, 0)
  const dias = m.desde ? Math.max(1, Math.round((ahora - m.desde) / 86_400_000)) : 0
  const lineas = [`**Medición FEAT-117** (${dias ? `${dias} d` : 'hoy'} · ${pasos} pasos · ${miles(total)} tokens). Nada se desvía: solo se cuenta.`, '']
  lineas.push('| Clase | Candidata | Pasos | Tokens (% del total) | De caché | Modelos |', '|---|---|---|---|---|---|')
  const orden = clases.sort(([, a], [, b]) => (b.entrada + b.salida + b.cacheLeida) - (a.entrada + a.salida + a.cacheLeida))
  let candidatos = 0
  for (const [clase, c] of orden) {
    const tokens = c.entrada + c.salida + c.cacheLeida
    if (esCandidata(clase)) candidatos += tokens
    const modelos = Object.entries(c.modelos).map(([k, n]) => `${k} ×${n}`).join(', ')
    lineas.push(`| ${clase} | ${esCandidata(clase) ? 'sí' : 'no'} | ${c.pasos} | ${miles(tokens)} (${pct(tokens, total)}) | ${pct(c.cacheLeida, tokens)} | ${modelos} |`)
  }
  lineas.push('', `Candidatos a Haiku 5.5: **${pct(candidatos, total)}** de los tokens.`)
  const spawns = Object.entries(m.spawns)
  if (spawns.length) {
    lineas.push('', 'Subagentes lanzados (tipo → modelo):')
    for (const [tipo, mods] of spawns) lineas.push(`- ${tipo}: ${Object.entries(mods).map(([k, n]) => `${k} ×${n}`).join(', ')}`)
  }
  lineas.push('', 'Ojo: la caché de prompt es por modelo. Cambiar de modelo a mitad de un turno relee el contexto sin caché; la columna «De caché» es lo que se perdería. `/lagrange-haiku reiniciar` empieza de cero.')
  return lineas.join('\n')
}
