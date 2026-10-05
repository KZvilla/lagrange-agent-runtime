/**
 * FEAT-111 — Antes de lanzar agy (`agy_run`, `agy_fanout`, `agy_lote` lanzar)
 * con la cuota guardada de su grupo por debajo del 20 %, preguntar «Seguir /
 * Cancelar». Sin `$`: qué llamadas mira, sus modelos, el restante y el texto.
 *
 * El mod no puede importar CommonJS: `grupoDe` es espejo de `grupoDeCuota`
 * (`mcp-server/motores/antigravity.js`) y la vigencia de 30 min es la de
 * `CUOTA_DECIDE_MS` (`mcp-server/lib/cuota-agy.js`);
 * `test/cuota-previa-paridad.test.js` compara las dos.
 */

export type Grupo = 'gemini' | 'claude_gpt'
export type Restante = { grupo: Grupo; fraccion: number; ventana: '5 h' | 'semanal'; resetea: number | null }

/** Por debajo de esto pregunta (decisión del usuario, 2026-10-05). */
export const UMBRAL = 0.2
/** Un dato más viejo no decide nada (como `CUOTA_DECIDE_MS`). */
export const VIGENCIA_MS = 30 * 60 * 1000

// Solo las tres que lanzan trabajo con edición; plan/review/audit/research quedan fuera.
const TOOL = /^mcp__[^_].*__agy_(run|fanout|lote)$/

export function grupoDe(modelo: unknown): Grupo | null {
  const m = String(modelo || '').toLowerCase()
  if (!m) return null
  if (m.startsWith('gemini')) return 'gemini'
  if (m.startsWith('claude') || m.startsWith('gpt-oss')) return 'claude_gpt'
  return null
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Los modelos que usaría el pedido (uno por tarea), o `null` si la llamada no se mira. */
export function modelosDelPedido(tool: unknown, input: unknown, porDefecto: string | null): { tool: string; modelos: (string | null)[] } | null {
  const m = typeof tool === 'string' ? TOOL.exec(tool) : null
  if (!m) return null
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (m[1] === 'run') return { tool: 'agy_run', modelos: [texto(i.model) ?? porDefecto] }
  if (m[1] === 'lote' && i.accion !== 'lanzar') return null
  const base = texto(i.modelo) ?? porDefecto
  const tareas = Array.isArray(i.tareas) ? i.tareas : []
  const modelos = tareas.map((t) => texto((t as Record<string, unknown> | null)?.modelo) ?? base)
  if (m[1] === 'lote' && texto(i.modelo_auditor)) modelos.push(texto(i.modelo_auditor))
  return { tool: `agy_${m[1]}`, modelos }
}

/** La clave `model` del proyecto, si no la del global, si no `AGY_MODEL` (la precedencia de `loadConfig`). */
export function modeloPorDefecto(proyecto: unknown, global: unknown, env: string | null | undefined): string | null {
  const de = (c: unknown) => texto(c && typeof c === 'object' ? (c as Record<string, unknown>).model : null)
  return de(proyecto) ?? de(global) ?? texto(env)
}

/** El restante de cada grupo de la cuota guardada; `null` sin dato, ilegible o vencido. */
export function restantes(uso: unknown, ahora: number): Partial<Record<Grupo, Restante>> | null {
  const c = (uso as { cuota?: { antigravity?: Record<string, unknown> } } | null)?.cuota?.antigravity
  const visto = Date.parse(String(c?.visto_en ?? ''))
  const grupos = c?.grupos as Record<string, Record<string, unknown>> | undefined
  if (!grupos || !Number.isFinite(visto) || ahora - visto > VIGENCIA_MS) return null
  const out: Partial<Record<Grupo, Restante>> = {}
  for (const grupo of ['gemini', 'claude_gpt'] as const) {
    const g = grupos[grupo]
    if (!g) continue
    let peor: Restante | null = null
    for (const [usado, reinicio, ventana] of [[g.ventana_5h, g.resetea_5h, '5 h'], [g.ventana_7d, g.resetea_7d, 'semanal']] as const) {
      if (typeof usado !== 'number' || !Number.isFinite(usado)) continue
      const r = Date.parse(String(reinicio ?? ''))
      // Una ventana cuyo reinicio ya pasó se renovó: queda entera.
      // Redondeada: 1 − 0,8 da 0,1999… y cruzaría el umbral por error de coma flotante.
      const fraccion = Number.isFinite(r) && r <= ahora ? 1 : Math.round(Math.min(1, Math.max(0, 1 - usado)) * 10000) / 10000
      if (!peor || fraccion < peor.fraccion) peor = { grupo, fraccion, ventana, resetea: Number.isFinite(r) && r > ahora ? r : null }
    }
    if (peor) out[grupo] = peor
  }
  return out
}

/** El grupo del pedido con menos cuota, si está por debajo del umbral; si no, `null`. */
export function bajo(modelos: (string | null)[], r: Partial<Record<Grupo, Restante>> | null): Restante | null {
  if (!r) return null
  let peor: Restante | null = null
  for (const g of new Set(modelos.map(grupoDe))) {
    const x = g ? r[g] : undefined
    if (x && x.fraccion < UMBRAL && (!peor || x.fraccion < peor.fraccion)) peor = x
  }
  return peor
}

const NOMBRE: Record<Grupo, string> = { gemini: 'Gemini', claude_gpt: 'Claude/GPT' }

function hora(ms: number | null): string {
  if (ms === null) return 'sin hora de reinicio'
  const d = new Date(ms)
  return `se renueva a las ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** El estado de la cuota en una frase, para la pregunta y para el motivo del `deny`. */
export function estadoDe(x: Restante): string {
  const cuanto = x.fraccion <= 0 ? 'sin cuota' : `queda ${Math.max(1, Math.floor(x.fraccion * 100))} %`
  return `${cuanto} en el grupo ${NOMBRE[x.grupo]} de agy (${x.ventana}, ${hora(x.resetea)})`
}

export function pregunta(x: Restante, tool: string, tareas: number): string {
  const que = tool === 'agy_run' ? 'Esto lanza un agy_run' : `Esto lanza ${tareas} ${tareas === 1 ? 'tarea' : 'tareas'} (${tool})`
  return `${estadoDe(x)[0].toUpperCase()}${estadoDe(x).slice(1)}. ${que}. ¿Seguir?`
}

export const SEGUIR = 'Seguir'
export const CANCELAR = 'Cancelar'

/** Qué hacer con la respuesta: pasar, o el texto del `deny` (lo que el modelo lee). */
export function decision(respuesta: string, x: Restante): { pasar: true } | { deny: string } {
  if (respuesta === SEGUIR) return { pasar: true }
  if (respuesta === CANCELAR) return { deny: `Cancelado por el usuario: ${estadoDe(x)}. No lo reintentes sin que lo pida.` }
  return { deny: `El usuario no lanzó la llamada (${estadoDe(x)}) y respondió: ${respuesta}` }
}
