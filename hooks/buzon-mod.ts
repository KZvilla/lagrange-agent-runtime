import type { Register, EngineInterface } from 'claude-code'

/**
 * FEAT-100 — El aviso del buzón de `mensaje` como mod de Claude Code.
 *
 * Los hooks de `buzon.js` avisan bloqueando el Stop, y al modelo le llega como
 * "Stop hook blocking error". Este mod vigila el buzón de la sesión y, cuando
 * llega algo nuevo, encola el aviso con `$.prompt.submit`: entra marcado como
 * mensaje del plugin y nunca se mete en un turno en curso (corre al quedar
 * ociosa). Mientras late, `buzon.js stop` calla y `espera` no avisa; si el mod
 * se cae, el latido se vence y los hooks vuelven a cargo.
 *
 * Solo el aviso (cuántos y de quién): el texto de un mensaje sale únicamente
 * por la tool `mensaje`, con su encuadre. Nunca `$.session.append`: esa fila le
 * llega al modelo como un mensaje del usuario (sonda S3).
 *
 * La lógica del buzón (locks, cursores) sigue en Node: el módulo no tiene Node,
 * así que la pide a `buzon.js mod-ubicar` / `mod-nuevos` por `$.process.run`.
 */

const TICK_MS = 3000
const LATIR_CADA_TICKS = 3

type Ubicacion = { sesion: string; jsonl: string; mod: string }

async function pedir($: EngineInterface, modo: 'mod-ubicar' | 'mod-nuevos'): Promise<Record<string, unknown> | null> {
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

async function avisarSiHayNuevos($: EngineInterface): Promise<void> {
  const r = await pedir($, 'mod-nuevos')
  const aviso = r && typeof r.aviso === 'string' ? r.aviso : null
  if (aviso) await $.prompt.submit({ text: aviso })
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const resultado = await next(e)
    const u = await pedir($, 'mod-ubicar')
    if (!u || typeof u.sesion !== 'string' || typeof u.jsonl !== 'string' || typeof u.mod !== 'string') return resultado
    const ubicacion = u as Ubicacion
    await latir($, ubicacion)
    let anterior = await huella($, ubicacion.jsonl)
    let ticks = 0
    let ocupado = false
    // Lo que ya esperaba antes de que el mod cargara.
    void avisarSiHayNuevos($).catch(() => {})
    $.clock.every(TICK_MS, () => {
      if (ocupado) return
      ocupado = true
      void (async () => {
        ticks += 1
        if (ticks % LATIR_CADA_TICKS === 0) await latir($, ubicacion)
        const actual = await huella($, ubicacion.jsonl)
        if (actual !== anterior) {
          anterior = actual
          await avisarSiHayNuevos($)
        }
      })().catch(() => {}).finally(() => { ocupado = false })
    })
    return resultado
  })
}
