/**
 * FEAT-103 — `/lagrange-resumen`, sin `$`: argumentos, el prompt para
 * `$.model.fork`, la validación y el archivo.
 *
 * El prompt es propio, no el de `mcp-server/summary-doc.js`: aquel trabaja
 * sobre un transcript preprocesado ("Final State", "Derived Facts"), y con el
 * fork el transcript es esta misma conversación. Los metadatos los pone el mod,
 * así el modelo no los inventa.
 */

export const FOCOS = ['full', 'decisions', 'changes', 'debugging', 'handoff'] as const
export type Foco = (typeof FOCOS)[number]

export type MetaResumen = {
  sessionId: string
  proyecto: string
  rama: string | null
  modelo: string
  inicio: number | null
  fin: number
}

/** `decisions si` → foco y confirmación; acepta `si` o `sí`. */
export function leerArgs(args: string): { foco: string; valido: boolean; confirmado: boolean } {
  const partes = String(args || '').trim().split(/\s+/).filter(Boolean)
  const confirmado = partes.some((p) => /^s[ií]$/i.test(p))
  const resto = partes.filter((p) => !/^s[ií]$/i.test(p))
  const foco = (resto[0] || 'full').toLowerCase()
  return { foco, valido: (FOCOS as readonly string[]).includes(foco), confirmado }
}

/** La rama de un `.git/HEAD` (`ref: refs/heads/<rama>`), o `null` si está desacoplado o no se entiende. */
export function ramaDeHead(texto: string): string | null {
  const m = /^ref:\s*refs\/heads\/(.+)\s*$/m.exec(String(texto || ''))
  return m ? m[1].trim() : null
}

/** En un worktree, `.git` es un archivo `gitdir: <ruta>`: la ruta, o `null`. */
export function gitdirDe(texto: string): string | null {
  const m = /^gitdir:\s*(.+)\s*$/m.exec(String(texto || ''))
  return m ? m[1].trim() : null
}

const iso = (ms: number | null) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '[no disponible]')

const SECCIONES: Record<Foco, string> = {
  full: 'Cubrí todas las secciones por igual.',
  decisions: 'Profundizá en "Decisiones": razones, alternativas descartadas y compromisos.',
  changes: 'Profundizá en "Cambios": cada archivo con lo que cambió y por qué.',
  debugging: 'Profundizá en "Problemas y resoluciones": cada error con su causa raíz.',
  handoff: 'Es un traspaso: lo que necesita una sesión NUEVA, sin acceso a esta conversación, para seguir el trabajo.'
}

export function promptDeResumen(foco: Foco, meta: MetaResumen): string {
  const datos = [
    '## Datos de la sesión (verificados por el plugin; copialos tal cual, no los cambies)',
    `- Session id: ${meta.sessionId || '[no disponible]'}`,
    `- Proyecto: ${meta.proyecto || '[no disponible]'}`,
    `- Rama: ${meta.rama || '[no disponible]'}`,
    `- Modelo: ${meta.modelo || '[no disponible]'}`,
    `- Inicio: ${iso(meta.inicio)}`,
    `- Fin: ${iso(meta.fin)}`
  ].join('\n')
  const secciones = foco === 'handoff'
    ? [
        '### 1. Objetivo y estado', '### 2. Qué se hizo (con archivos y commits que aparezcan en la conversación)',
        '### 3. Decisiones y por qué', '### 4. Qué falta, en orden', '### 5. Trampas conocidas',
        '### 6. Cómo verificar dónde quedó', '### 7. Prompt para iniciar la sesión nueva'
      ]
    : [
        '### 1. Resumen ejecutivo', '### 2. Decisiones', '### 3. Cambios', '### 4. Problemas y resoluciones',
        '### 5. Estado actual y próximos pasos', '### 6. Contexto para continuar'
      ]
  return [
    'Sin usar herramientas: escribí un documento de resumen de ESTA conversación. El transcript es la conversación misma;',
    'el estado final es el de los últimos turnos, no uno intermedio.',
    '',
    datos,
    '',
    '## Secciones (en este orden, como encabezados markdown)',
    ...secciones,
    '',
    `## Foco: ${SECCIONES[foco]}`,
    '',
    '## Reglas',
    '- Respondé el documento ENTERO como texto, empezando por un título `#`. Nada de archivos, enlaces ni rutas a otro lado.',
    '- No inventes SHAs, versiones ni cantidades: solo los que aparecen en la conversación. Si algo no está claro, "[no claro]".',
    '- Distinguí lo medido (salida de un comando) de lo estimado.',
    '- Citá archivos concretos, con líneas si la conversación las tiene.',
    '- Escribí en el idioma en que habló el usuario. Máximo 400 líneas.'
  ].join('\n')
}

const MIN_LONGITUD = 400

/** Como `validarDocumento` de `summary-doc.js`: un documento real es largo y tiene varios encabezados. */
export function validarResumen(texto: string): { ok: true } | { ok: false; motivo: string } {
  const t = String(texto || '').trim()
  if (!t) return { ok: false, motivo: 'la respuesta vino vacía' }
  if (t.length < MIN_LONGITUD) return { ok: false, motivo: `tiene ${t.length} caracteres, menos de ${MIN_LONGITUD}` }
  const encabezados = (t.match(/^#{1,4}\s+\S/gm) || []).length
  if (encabezados < 2) return { ok: false, motivo: `tiene ${encabezados} encabezado(s); un resumen tiene varios` }
  return { ok: true }
}

/** `<home>/.claude/session-summaries/<fecha>-<id8>-fork.md`, con el id saneado como en `saveSummary`. */
export function archivoDeResumen(home: string, meta: MetaResumen): string {
  const fecha = new Date(meta.fin).toISOString().slice(0, 10)
  const id = (meta.sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'unknown'
  return `${home.replace(/[\\/]+$/, '')}/.claude/session-summaries/${fecha}-${id}-fork.md`
}

/** El frontmatter de `saveSummary` (index.js), con quién lo hizo y el modelo. */
export function frontmatter(meta: MetaResumen): string {
  const limpio = (v: string | null) => String(v ?? 'unknown').replace(/\\/g, '/').replace(/"/g, "'")
  return [
    '---',
    `session_id: "${limpio(meta.sessionId)}"`,
    'host: "claude"',
    `project: "${limpio(meta.proyecto)}"`,
    `branch: "${limpio(meta.rama)}"`,
    `date: "${new Date(meta.fin).toISOString().slice(0, 10)}"`,
    `start_time: "${meta.inicio ? new Date(meta.inicio).toISOString() : 'unknown'}"`,
    `end_time: "${new Date(meta.fin).toISOString()}"`,
    'summarized_by: "lagrange-resumen (model.fork)"',
    `model: "${limpio(meta.modelo)}"`,
    '---',
    ''
  ].join('\n')
}

type Uso = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null | undefined

/** El pie de costo: siempre, también cuando el fork no respondió. */
export function pieDeCosto(uso: Uso): string {
  const n = (v: number | undefined) => (typeof v === 'number' ? v : 0)
  const nuevos = n(uso?.input_tokens) + n(uso?.cache_creation_input_tokens)
  return `— $.model.fork: ${n(uso?.cache_read_input_tokens)} tokens leídos de caché, ${nuevos} nuevos, ${n(uso?.output_tokens)} de salida.`
}

export function textoDeEstimacion(foco: string, tokens: number | undefined, modelo: string): string {
  const cuanto = typeof tokens === 'number' && Number.isFinite(tokens) ? `~${tokens}` : '[no disponible]'
  return [
    `/lagrange-resumen relee toda esta conversación con ${modelo || 'el modelo de la sesión'}: ${cuanto} tokens de contexto`,
    '(en la sonda S10, una sesión larga leyó 616.675 de caché). En sesiones largas, agy_session_summary es más barato.',
    `Para seguir: /lagrange-resumen ${foco} si`
  ].join('\n')
}
