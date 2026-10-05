/**
 * FEAT-123 — Qué cuenta de Claude es esta sesión y con qué nombre y emblema se
 * muestra (`identidad_sesion` del antigravity.json global).
 *
 * Copia de `mcp-server/lib/identidad-sesion.js` (el mod no puede importar CJS).
 * Las dos corren la tabla `test/fixtures/identidad-casos.mjs`: si cambia una,
 * cambia la otra.
 */

export const PRINCIPAL = 'principal'
const MAX_NOMBRE = 24
const MAX_EMBLEMA = 2
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/

export type Identidad = { nombre: string; emblema: string | null; color: string | number | null }

const esObjeto = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** `~` inicial al home, barras normales, sin barra final, en minúsculas: solo para comparar. */
function normalizar(ruta: string, home: string): string {
  let r = ruta.trim()
  if (r === '~' || /^~[\\/]/.test(r)) r = home + r.slice(1)
  return r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** `principal`, el nombre de una cuenta de `motores.cuentas`, o `null` si el dir no es de ninguna. */
export function resolverCuenta({ configDir, home, cuentas }: { configDir: unknown; home: string; cuentas: unknown }): string | null {
  const dir = typeof configDir === 'string' ? configDir.trim() : ''
  if (!dir) return PRINCIPAL
  const propio = normalizar(dir, home)
  if (propio === normalizar(`${home}/.claude`, home)) return PRINCIPAL
  for (const [nombre, entrada] of Object.entries(esObjeto(cuentas) ? cuentas : {})) {
    if (nombre === PRINCIPAL || !esObjeto(entrada) || typeof entrada.configDir !== 'string' || !entrada.configDir.trim()) continue
    if (normalizar(entrada.configDir, home) === propio) return nombre
  }
  return null
}

function grafemas(texto: string): number {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(texto)].length
  }
  return [...texto].length
}

/** `{ nombre, emblema, color }` o `null`. Sin nombre válido no hay identidad; un emblema inválido se descarta solo. */
export function validarIdentidad(crudo: unknown): Identidad | null {
  if (!esObjeto(crudo) || typeof crudo.nombre !== 'string') return null
  const nombre = crudo.nombre.trim()
  if (!nombre || nombre.length > MAX_NOMBRE || CONTROLES.test(nombre)) return null
  let emblema: string | null = null
  if (typeof crudo.emblema === 'string') {
    const e = crudo.emblema.trim()
    if (e && !CONTROLES.test(e) && grafemas(e) <= MAX_EMBLEMA) emblema = e
  }
  const color = typeof crudo.color === 'string' || typeof crudo.color === 'number' ? crudo.color : null
  return { nombre, emblema, color }
}

/** La identidad de esta sesión según la config global, o `null`. Nunca tira. */
export function identidadDeConfig(config: unknown, { configDir, home }: { configDir: unknown; home: string }): Identidad | null {
  try {
    if (!esObjeto(config) || !esObjeto(config.identidad_sesion)) return null
    const cuentas = esObjeto(config.motores) ? config.motores.cuentas : undefined
    const cuenta = resolverCuenta({ configDir, home, cuentas })
    if (!cuenta || !Object.prototype.hasOwnProperty.call(config.identidad_sesion, cuenta)) return null
    return validarIdentidad(config.identidad_sesion[cuenta])
  } catch {
    return null
  }
}

/** Lo que se muestra: `✦  Spica` (dos espacios: algunos emblemas, como ☘, se dibujan anchos y se pegan al nombre), o solo el nombre. */
export function etiquetaDe(identidad: Identidad): string {
  return identidad.emblema ? `${identidad.emblema}  ${identidad.nombre}` : identidad.nombre
}

/** El `suffix` del spinner con la identidad al final; el separador va siempre, pegado a la palabra. */
export function sufijoConIdentidad(previo: unknown, identidad: Identidad): string {
  const etiqueta = etiquetaDe(identidad)
  return typeof previo === 'string' && previo ? `${previo} · ${etiqueta}` : ` · ${etiqueta}`
}

export function identidadesIguales(a: Identidad | null, b: Identidad | null): boolean {
  return a === b || (!!a && !!b && a.nombre === b.nombre && a.emblema === b.emblema && a.color === b.color)
}
