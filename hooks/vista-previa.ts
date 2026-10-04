/**
 * FEAT-112 — La vista previa del daño, sin `$`: reconocer los comandos
 * destructivos que se miden antes de correr, leer sus rutas y armar el motivo
 * que muestra el prompt de permisos del motor (`classic.PreToolUse` → `{ ask }`).
 *
 * Como las guardas (`guardas.ts`), es un freno de buena fe: no sigue `cd`, ni
 * variables, ni subshells. Solo separa por comillas y por `;` `&&` `||` `|`, y
 * entiende `git -C <dir>` para saber dónde medir.
 */

import { palabrasDe } from './guardas.ts'

export type CasoWorktree = { tipo: 'worktree'; dir: string | null; ruta: string; force: boolean }
export type CasoBorrado = { tipo: 'borrado'; dir: string | null; rutas: string[] }
export type CasoPush = { tipo: 'push'; dir: string | null; remoto: string | null; origen: string | null; destino: string | null }
export type CasoNode = { tipo: 'node' }
export type Caso = CasoWorktree | CasoBorrado | CasoPush | CasoNode

/** Lo que encontró la medición; un caso sin daño no deja hallazgo y el comando pasa. */
export type Hallazgo =
  | { tipo: 'worktree'; ruta: string; links: Array<{ ruta: string; destino: string | null }>; cambios: number; force: boolean }
  | { tipo: 'borrado'; links: Array<{ ruta: string; destino: string | null }>; versionados: Array<{ ruta: string; n: number }> }
  | { tipo: 'push'; ref: string; commits: number }
  | { tipo: 'node' }
  | { tipo: 'sin-medir'; comando: string }

const MAX_LINEAS = 12

/**
 * Parte un comando en segmentos (por `;` `&&` `||` `|` fuera de comillas) y cada
 * segmento en palabras, respetando comillas simples y dobles. La barra invertida
 * no escapa: en PowerShell y en rutas de Windows es un carácter más.
 */
export function separar(comando: string): string[][] {
  const segmentos: string[][] = []
  let palabras: string[] = []
  let actual = ''
  let hay = false
  let comilla: string | null = null
  const cerrarPalabra = () => { if (hay) palabras.push(actual); actual = ''; hay = false }
  const cerrarSegmento = () => { cerrarPalabra(); if (palabras.length) segmentos.push(palabras); palabras = [] }
  const s = String(comando)
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (comilla) {
      if (ch === comilla) comilla = null
      else actual += ch
      continue
    }
    if (ch === '"' || ch === "'") { comilla = ch; hay = true; continue }
    if (ch === ';' || ch === '\n') { cerrarSegmento(); continue }
    if ((ch === '&' || ch === '|') && s[i + 1] === ch) { cerrarSegmento(); i++; continue }
    if (ch === '|') { cerrarSegmento(); continue }
    if (/\s/.test(ch)) { cerrarPalabra(); continue }
    actual += ch
    hay = true
  }
  cerrarSegmento()
  return segmentos
}

const esOpcion = (p: string) => p.startsWith('-') && p.length > 1

/** Los argumentos que siguen a `git` sin sus opciones globales; `-C <dir>` se guarda aparte. */
function partirGit(seg: string[]): { dir: string | null; resto: string[] } | null {
  const i = seg.findIndex((p) => p.toLowerCase() === 'git')
  if (i < 0) return null
  let dir: string | null = null
  let j = i + 1
  while (j < seg.length && esOpcion(seg[j])) {
    if (seg[j] === '-C' && j + 1 < seg.length) { dir = seg[j + 1]; j += 2; continue }
    // `-c clave=valor` y otras opciones globales con valor pegado o separado.
    if (seg[j] === '-c' && j + 1 < seg.length) { j += 2; continue }
    j += 1
  }
  return { dir, resto: seg.slice(j) }
}

function casoGit(seg: string[]): Caso | null {
  const g = partirGit(seg)
  if (!g) return null
  const [sub, ...args] = g.resto
  if (!sub) return null
  if (sub.toLowerCase() === 'worktree' && args[0]?.toLowerCase() === 'remove') {
    const resto = args.slice(1)
    const ruta = resto.find((p) => !esOpcion(p))
    if (!ruta) return null
    const force = resto.some((p) => p === '--force' || p === '-f' || /^-f+$/.test(p))
    return { tipo: 'worktree', dir: g.dir, ruta, force }
  }
  return null
}

/** `git push` forzado: `--force`/`-f` fuerza todos los refspecs; si no, solo los que empiezan con `+`. */
function casosPush(seg: string[]): CasoPush[] {
  const g = partirGit(seg)
  if (!g || g.resto[0]?.toLowerCase() !== 'push') return []
  const args = g.resto.slice(1)
  const lease = args.some((p) => p.startsWith('--force-with-lease'))
  const forzado = args.some((p) => p === '--force' || p === '-f')
  if (lease && !forzado) return []
  const posicionales = args.filter((p) => !esOpcion(p))
  // Sin remoto (`git push +main`), el primer posicional ya es un refspec.
  const remoto = posicionales[0] && !posicionales[0].startsWith('+') ? posicionales[0] : null
  const refspecs = remoto ? posicionales.slice(1) : posicionales
  const caso = (r: string | null): CasoPush => {
    const limpio = (r ?? '').replace(/^\+/, '')
    const [origen, destino] = limpio ? (limpio.includes(':') ? limpio.split(':') : [limpio, limpio]) : [null, null]
    return { tipo: 'push', dir: g.dir, remoto, origen: origen || null, destino: destino || null }
  }
  if (forzado) return refspecs.length ? refspecs.map(caso) : [caso(null)]
  return refspecs.filter((r) => r.startsWith('+')).map(caso)
}

function casoBorrado(seg: string[]): Caso | null {
  const cmd = (seg[0] ?? '').toLowerCase()
  const args = seg.slice(1)
  if (cmd === 'rm') {
    const recursivo = args.some((p) => p === '--recursive' || (/^-[a-zA-Z]+$/.test(p) && /[rR]/.test(p)))
    const rutas = args.filter((p) => !esOpcion(p))
    return recursivo && rutas.length ? { tipo: 'borrado', dir: null, rutas } : null
  }
  if (cmd === 'remove-item' || cmd === 'ri' || cmd === 'del' || cmd === 'erase' || cmd === 'rd' || cmd === 'rmdir') {
    const bajos = args.map((p) => p.toLowerCase())
    const recursivo = bajos.some((p) => p === '-recurse' || p === '-r' || p === '/s')
    if (!recursivo) return null
    const rutas: string[] = []
    for (let i = 0; i < args.length; i++) {
      const p = args[i]
      const b = bajos[i]
      if (b === '-path' || b === '-literalpath') { if (args[i + 1]) rutas.push(args[i + 1]); i++; continue }
      // Modificadores de cmd (`/s`, `/q`): una barra y una letra. `/var/log` es una ruta.
      if (esOpcion(p) || /^\/[a-zA-Z]$/.test(p)) continue
      rutas.push(p)
    }
    // PowerShell: `Remove-Item a, b` llega como `a,` `b`.
    const limpias = rutas.flatMap((r) => r.split(',')).map((r) => r.trim()).filter(Boolean)
    return limpias.length ? { tipo: 'borrado', dir: null, rutas: limpias } : null
  }
  return null
}

/** ¿El comando entero mata `node` en general? Se mira sin segmentar: `Get-Process node | Stop-Process` cruza un pipe. */
export function mataNode(comando: string): boolean {
  const w = palabrasDe(comando)
  const tiene = (x: string) => w.includes(x)
  const nodeNombre = w.some((p) => p === 'node' || p === 'node.exe')
  if (!nodeNombre) return false
  // `Stop-Process node`, `-Name`, `-ProcessName`; `kill` y `spps` son alias en PowerShell. `-Id` mata un PID: no es «todos».
  if ((tiene('stop-process') || tiene('spps') || tiene('kill')) && !tiene('-id')) return true
  if (tiene('taskkill') && (tiene('/im') || tiene('-im'))) return true
  if (tiene('pkill') || tiene('killall')) return true
  if (tiene('get-process') && (tiene('stop-process') || tiene('kill'))) return true
  return false
}

/** Los casos del comando, en orden. Vacío: el comando pasa sin medir. */
export function reconocer(comando: string): Caso[] {
  const casos: Caso[] = []
  for (const seg of separar(comando)) {
    const c = casoGit(seg) ?? casoBorrado(seg)
    if (c) casos.push(c)
    casos.push(...casosPush(seg))
  }
  if (mataNode(comando)) casos.push({ tipo: 'node' })
  return casos
}

/** ¿La ruta tiene comodines del shell? No se puede medir: se pregunta con «no se pudo medir». */
export function tieneComodin(ruta: string): boolean {
  return /[*?[]/.test(ruta)
}

/** Barras normales, sin barra final; para comparar, en minúsculas. */
export function normalizar(ruta: string): string {
  return String(ruta).replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/\.(?=\/|$)/g, '')
}

export function mismaRuta(a: string, b: string): boolean {
  return normalizar(a).toLowerCase() === normalizar(b).toLowerCase()
}

export function esAbsoluta(ruta: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(ruta) || ruta.startsWith('/') || ruta.startsWith('\\\\')
}

/** La ruta absoluta de `ruta` vista desde `base`. */
export function unir(base: string, ruta: string): string {
  return normalizar(esAbsoluta(ruta) ? ruta : `${normalizar(base)}/${ruta}`)
}

/** `ruta` relativa a `raiz` si está adentro; si no, tal cual. */
export function relativa(raiz: string, ruta: string): string {
  const r = normalizar(raiz), p = normalizar(ruta)
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p
}

/** Las rutas de `git worktree list --porcelain`. */
export function rutasDeWorktrees(salida: string): string[] {
  return salida.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => normalizar(l.slice('worktree '.length)))
}

/** Las entradas de `git status --porcelain --ignored`: las ignoradas y sin seguimiento (candidatas a link) y los cambios. */
export function leerStatus(salida: string): { sueltas: string[]; cambios: number } {
  const sueltas: string[] = []
  let cambios = 0
  for (const l of salida.split(/\r?\n/)) {
    if (l.length < 4) continue
    const xy = l.slice(0, 2)
    let ruta = l.slice(3)
    if (ruta.startsWith('"') && ruta.endsWith('"')) ruta = ruta.slice(1, -1)
    if (xy === '!!' || xy === '??') sueltas.push(ruta.replace(/\/$/, ''))
    if (xy !== '!!') cambios += 1
  }
  return { sueltas, cambios }
}

/** ¿Es un link? `isLink`, o adónde llega cuando no es donde dice estar (una junction que el motor no marcara). */
export function esLink(ruta: string, st: { isLink?: boolean; realPath?: string }): boolean {
  if (st.isLink) return true
  return typeof st.realPath === 'string' && !mismaRuta(st.realPath, ruta)
}

function linea(l: { ruta: string; destino: string | null }): string {
  return l.destino ? `${l.ruta} → ${l.destino}` : l.ruta
}

/** El motivo del prompt: una cabecera y una o más líneas por hallazgo, con tope. */
export function motivoDe(hallazgos: Hallazgo[], raiz: string): string {
  const lineas: string[] = ['Lagrange · vista previa del daño']
  for (const h of hallazgos) {
    switch (h.tipo) {
      case 'worktree': {
        lineas.push(`git worktree remove${h.force ? ' --force' : ''} ${relativa(raiz, h.ruta)}`)
        for (const l of h.links) lineas.push(`⚠ contiene un link: ${linea({ ruta: relativa(h.ruta, l.ruta), destino: l.destino ? relativa(raiz, l.destino) : null })}${h.force ? ' — --force borra a través de él' : ''}`)
        if (h.force && h.cambios > 0) lineas.push(`${h.cambios} ${h.cambios === 1 ? 'archivo sin commitear se perdería' : 'archivos sin commitear se perderían'}`)
        break
      }
      case 'borrado': {
        lineas.push('borrado recursivo:')
        for (const l of h.links) lineas.push(`⚠ link: ${linea({ ruta: relativa(raiz, l.ruta), destino: l.destino ? relativa(raiz, l.destino) : null })}`)
        for (const v of h.versionados) lineas.push(`${relativa(raiz, v.ruta)}: ${v.n} ${v.n === 1 ? 'archivo versionado' : 'archivos versionados'}`)
        break
      }
      case 'push':
        lineas.push(`git push forzado: ${h.commits} ${h.commits === 1 ? 'commit' : 'commits'} de ${h.ref} se perderían (según la copia local, sin fetch)`)
        break
      case 'node':
        lineas.push('mata todos los node: esta sesión de Claude Code, los MCP de Lagrange, el daemon del bridge y el registrador de P3')
        break
      case 'sin-medir':
        lineas.push(`${h.comando}: no se pudo medir el alcance`)
        break
    }
  }
  return (lineas.length > MAX_LINEAS ? [...lineas.slice(0, MAX_LINEAS - 1), `… y ${lineas.length - MAX_LINEAS + 1} líneas más`] : lineas).join('\n')
}
