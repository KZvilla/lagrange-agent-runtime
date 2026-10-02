/**
 * FEAT-102 — Las guardas de Lagrange, sin `$`: validar las reglas de
 * `~/.claude/antigravity.json` (clave `guardas`) y decidir si una frena un
 * comando de las tools Bash o PowerShell de Claude.
 *
 * Sin regex (una regex del usuario puede colgar la sesión): una regla es una
 * secuencia de palabras enteras que tiene que aparecer contigua en el comando
 * normalizado. La palabra `*` acepta cero o más palabras en el medio. Es un
 * freno de buena fe, no una barrera: un comando ofuscado puede no coincidir.
 */

export type Guarda = { secuencia: string[]; motivo: string; vence: number | null; raiz: string | null }

const MAX_PALABRAS = 8
const MAX_LARGO_PALABRA = 80
const MAX_MOTIVO = 200

/** Minúsculas, sin comillas, backticks ni barras invertidas, partido en palabras por espacios y separadores de shell. */
export function palabrasDe(texto: string): string[] {
  return String(texto)
    .toLowerCase()
    .replace(/["'`\\]/g, '')
    .split(/[\s;|&()<>]+/)
    .filter(Boolean)
}

/** La carpeta para comparar: sin mayúsculas, `\` como `/` y sin barra final. */
export function normalizarRaiz(ruta: string): string {
  return String(ruta).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Las reglas válidas de `guardas`. Una inválida se descarta; si no es un array, ninguna. */
export function validarGuardas(lista: unknown): { guardas: Guarda[]; descartadas: number } {
  if (!Array.isArray(lista)) return { guardas: [], descartadas: 0 }
  const guardas: Guarda[] = []
  let descartadas = 0
  for (const r of lista) {
    const g = validarUna(r)
    if (g) guardas.push(g)
    else descartadas += 1
  }
  return { guardas, descartadas }
}

function validarUna(r: unknown): Guarda | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  if (!Array.isArray(o.secuencia) || !o.secuencia.every((p) => typeof p === 'string')) return null
  // "git push" en una sola palabra se parte: no se descarta en silencio.
  const secuencia = (o.secuencia as string[]).flatMap((p) => p.trim().toLowerCase().split(/\s+/)).filter(Boolean)
  if (!secuencia.length || secuencia.length > MAX_PALABRAS) return null
  if (secuencia.some((p) => p.length > MAX_LARGO_PALABRA)) return null
  if (secuencia.every((p) => p === '*')) return null
  if (typeof o.motivo !== 'string' || !o.motivo.trim() || o.motivo.length > MAX_MOTIVO) return null
  let vence: number | null = null
  if (o.vence !== undefined) {
    if (typeof o.vence !== 'string') return null
    vence = Date.parse(o.vence)
    if (!Number.isFinite(vence)) return null
  }
  let raiz: string | null = null
  if (o.raiz !== undefined) {
    if (typeof o.raiz !== 'string' || !o.raiz.trim()) return null
    raiz = normalizarRaiz(o.raiz)
  }
  return { secuencia, motivo: o.motivo.trim(), vence, raiz }
}

/** ¿La secuencia aparece contigua en las palabras, con `*` como cero o más palabras? */
export function coincide(secuencia: string[], palabras: string[]): boolean {
  // Tramos sin `*`: cada uno contiguo, en orden, con huecos libres entre tramos.
  const tramos: string[][] = []
  let actual: string[] = []
  for (const p of secuencia) {
    if (p === '*') { if (actual.length) tramos.push(actual); actual = [] }
    else actual.push(p)
  }
  if (actual.length) tramos.push(actual)
  let desde = 0
  for (const tramo of tramos) {
    let hallado = -1
    for (let i = desde; i + tramo.length <= palabras.length; i++) {
      let ok = true
      for (let j = 0; j < tramo.length; j++) {
        if (palabras[i + j] !== tramo[j]) { ok = false; break }
      }
      if (ok) { hallado = i; break }
    }
    if (hallado < 0) return false
    desde = hallado + tramo.length
  }
  return true
}

/** La primera guarda vigente que frena el comando en esta raíz, o `null`. */
export function guardaQueFrena(guardas: Guarda[], { comando, raiz, ahora }: { comando: string; raiz: string; ahora: number }): Guarda | null {
  const palabras = palabrasDe(comando)
  const aqui = normalizarRaiz(raiz)
  for (const g of guardas) {
    if (g.vence !== null && ahora >= g.vence) continue
    if (g.raiz !== null && g.raiz !== aqui) continue
    if (coincide(g.secuencia, palabras)) return g
  }
  return null
}

/** El texto que ve el modelo: el motivo, sin la secuencia ni rutas. */
export function textoDeFreno(g: Guarda): string {
  return `Lagrange · guarda: ${g.motivo}. Si hace falta igual, pedíselo al usuario.`
}
