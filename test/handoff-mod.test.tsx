import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { nuevoHandoff, pctDe, medir, descartar, empezar, terminar, vigente, hayAviso, filaDeHandoff, conTilde, VISIBLE_MS, medirTokens, medirContexto, cortesDe, instruccionesDeCompactacion, empezarCompactacion, terminarCompactacion, VISIBLE_EXITO_MS, ofrecer, cerrar, alEmpezarTurno, promptDeRetomar, estaVisto, marcarVisto, fechaDeRuta, MAX_VISTOS } from '../hooks/handoff-texto.ts'

/**
 * FEAT-118 — El freno de contexto: la parte pura (`hooks/handoff-texto.ts`) y
 * el mod (en `hooks/mods.tsx`): `session.measure`, la ventana de compactación
 * del breakdown, la fila con botones en la banda y `/lagrange-resumen handoff si`
 * con el fork simulado.
 */

const HOME = 'C:/Users/u'

// ------------------------------------------------------------------ puro

test('pctDe: entero, y null sin datos', () => {
  expect(pctDe(72_000, 100_000)).toBe(72)
  expect(pctDe(undefined, 100_000)).toBe(null)
  expect(pctDe(1, 0)).toBe(null)
  expect(pctDe(-1, 10)).toBe(null)
})

test('medir: 69 no avisa; 70 avisa; 75 no repite; 85 avisa; 90 no repite; bajo 40 rearma', () => {
  let h = medir(nuevoHandoff(), 69)
  expect(h.aviso).toBe(null)
  h = medir(h, 70)
  expect(h.aviso).toBe(70)
  h = descartar(medir(h, 75))
  expect(h.aviso).toBe(null)
  h = medir(h, 80)
  expect(h.aviso).toBe(null)
  h = medir(h, 85)
  expect(h.aviso).toBe(85)
  h = descartar(medir(h, 90))
  expect(h.aviso).toBe(null)
  h = medir(h, 39)
  expect(h.disparados).toEqual([])
  h = medir(h, 72)
  expect(h.aviso).toBe(70)
  expect(medir(h, null)).toBe(h)
})

test('medir: saltar de 30 a 90 avisa el 85 y marca los dos', () => {
  const h = medir(medir(nuevoHandoff(), 30), 90)
  expect(h.aviso).toBe(85)
  expect(h.disparados).toEqual([70, 85])
})

test('terminar: solo la primera línea; éxito con ~ por 5 min; error con su texto por 20 s', () => {
  const ok = terminar(empezar(nuevoHandoff(), 0), 'Resumen (handoff) guardado en C:\\Users\\u\\.claude\\session-summaries\\x.md\n— $.model.fork: 1 tokens', 1000, HOME)
  expect(ok.fase).toBe('listo')
  expect(ok.texto).toBe('Handoff guardado en ~/.claude/session-summaries/x.md')
  const mal = terminar(empezar(nuevoHandoff(), 0), 'No se generó el resumen: el fork no respondió (x).\n— pie', 1000, HOME)
  expect(mal.fase).toBe('error')
  expect(mal.texto).toBe('No se generó el resumen: el fork no respondió (x).')
  expect(terminar(nuevoHandoff(), '', 0, HOME).texto).toBe('No se generó el handoff.')
  expect(hayAviso(ok, 1000 + VISIBLE_EXITO_MS - 1)).toBe(true)
  expect(vigente(ok, 1000 + VISIBLE_EXITO_MS).fase).toBe('quieto')
  expect(vigente(mal, 1000 + VISIBLE_MS).fase).toBe('quieto')
  expect(conTilde('D:/otro/x.md', HOME)).toBe('D:/otro/x.md')
})

const NINGUNA = { guardar: false, compactar: false, descartar: false, retomar: false, copiar: false, cerrar: false }
const TODAS = { ...NINGUNA, guardar: true, compactar: true, descartar: true }

test('filaDeHandoff: botones solo en el aviso; 85 es urgente', () => {
  expect(filaDeHandoff(medir(nuevoHandoff(), 72), 0)).toEqual({ texto: 'Contexto: 72 % hasta compactar', tono: 'aviso', acciones: TODAS })
  expect(filaDeHandoff(medir(nuevoHandoff(), 88), 0)?.tono).toBe('urgente')
  expect(filaDeHandoff(empezar(nuevoHandoff(), 0), 65_000)).toEqual({ texto: 'Generando handoff… 1m05s', tono: 'normal', acciones: NINGUNA })
  expect(filaDeHandoff(nuevoHandoff(), 0)).toBe(null)
})

// ------------------------------------------------------------------ FEAT-146 puro

test('FEAT-146 cortesDe: 1M → 3; 600k → 2; 300k → 1', () => {
  expect(cortesDe(1_000_000)).toEqual([268_000, 536_000, 804_000])
  expect(cortesDe(600_000)).toEqual([268_000, 536_000])
  expect(cortesDe(300_000)).toEqual([268_000])
})

test('FEAT-146 medirTokens: 267k no; 268k sí; 300k no repite; 250k no rearma; 50k rearma; vuelve a avisar', () => {
  let h = medirTokens(nuevoHandoff(), 267_000, 1_000_000)
  expect(h.aviso).toBe(null)
  h = medirTokens(h, 268_000, 1_000_000)
  expect(h.aviso).toBe(268_000)
  expect(h.cortes).toBe(3)
  h = descartar(medirTokens(h, 300_000, 1_000_000))
  expect(h.aviso).toBe(null)
  h = medirTokens(h, 250_000, 1_000_000)
  expect(h.disparados).toEqual([268_000])
  h = medirTokens(h, 270_000, 1_000_000)
  expect(h.aviso).toBe(null)
  h = { ...h, ruta: 'C:/x.md', aviso: 268_000 }
  h = medirTokens(h, 50_000, 1_000_000)
  expect(h.disparados).toEqual([])
  expect(h.aviso).toBe(null)
  expect(h.ruta).toBe(null)
  h = medirTokens(h, 300_000, 1_000_000)
  expect(h.aviso).toBe(268_000)
  expect(medirTokens(h, undefined, 1_000_000)).toBe(h)
  expect(medirTokens(h, 300_000, undefined)).toBe(h)
})

test('FEAT-146 medirTokens: saltar de 100k a 900k avisa 804k y marca los tres', () => {
  const h = medirTokens(medirTokens(nuevoHandoff(), 100_000, 1_000_000), 900_000, 1_000_000)
  expect(h.aviso).toBe(804_000)
  expect(h.disparados).toEqual([268_000, 536_000, 804_000])
})

test('FEAT-146 medirContexto: ventana > 536k mide en tokens, si no en %; cambiar de modo vacía lo avisado', () => {
  const t = medirContexto(nuevoHandoff(), 300_000, 1_000_000)
  expect(t.modo).toBe('tokens')
  expect(t.aviso).toBe(268_000)
  const p = medirContexto(nuevoHandoff(), 150_000, 200_000)
  expect(p.modo).toBe('pct')
  expect(p.aviso).toBe(70)
  const cambio = medirContexto(p, 100_000, 1_000_000)
  expect(cambio.modo).toBe('tokens')
  expect(cambio.disparados).toEqual([])
  expect(cambio.aviso).toBe(null)
  expect(medirContexto(p, undefined, 200_000)).toBe(p)
})

test('FEAT-146 filaDeHandoff en tokens: corte n de m; 804k urgente', () => {
  expect(filaDeHandoff(medirContexto(nuevoHandoff(), 272_000, 1_000_000), 0)).toEqual({ texto: 'Contexto: 272k tokens (corte 1 de 3)', tono: 'aviso', acciones: TODAS })
  expect(filaDeHandoff(medirContexto(nuevoHandoff(), 540_000, 600_000), 0)?.texto).toBe('Contexto: 540k tokens (corte 2 de 2)')
  expect(filaDeHandoff(medirContexto(nuevoHandoff(), 810_000, 1_000_000), 0)?.tono).toBe('urgente')
})

test('FEAT-146 terminar guarda la ruta; listo ofrece copiar, compactar y cerrar', () => {
  const ok = terminar(empezar(nuevoHandoff(), 0), 'Resumen (handoff) guardado en C:\\Users\\u\\.claude\\session-summaries\\x.md', 1000, HOME)
  expect(ok.ruta).toBe('C:\\Users\\u\\.claude\\session-summaries\\x.md')
  expect(filaDeHandoff(ok, 1000)?.acciones).toEqual({ ...NINGUNA, compactar: true, copiar: true, cerrar: true })
  const mal = terminar(empezar({ ...nuevoHandoff(), ruta: 'previa' }, 0), 'No se generó', 1000, HOME)
  expect(mal.ruta).toBe('previa')
  expect(filaDeHandoff(mal, 1000)?.acciones).toEqual({ ...NINGUNA, compactar: true })
  const malCompactar = terminarCompactacion(empezarCompactacion(nuevoHandoff(), 0), { resultado: { skip: 'x' } }, 1000)
  expect(filaDeHandoff(malCompactar, 1000)?.acciones).toEqual(NINGUNA)
})

test('FEAT-146 instruccionesDeCompactacion: fija, y con ruta la cita', () => {
  expect(instruccionesDeCompactacion(null)).toMatch(/^Conservá el estado de la tarea en curso/)
  expect(instruccionesDeCompactacion(null)).not.toMatch(/handoff/)
  expect(instruccionesDeCompactacion('C:/h.md')).toMatch(/El handoff completo está en C:\/h\.md; citá esa ruta/)
})

test('FEAT-146 compactación: compactando con reloj; compactado con cifras o sin; skip y error; vence a los 20 s', () => {
  const c = empezarCompactacion(medirContexto(nuevoHandoff(), 300_000, 1_000_000), 0)
  expect(c.aviso).toBe(null)
  expect(hayAviso(c, 999_999)).toBe(true)
  expect(filaDeHandoff(c, 12_000)).toEqual({ texto: 'Compactando… 12s', tono: 'normal', acciones: NINGUNA })
  const ok = terminarCompactacion(c, { resultado: { messages: [], tokensBefore: 812_000, tokensAfter: 46_000 } }, 1000)
  expect(filaDeHandoff(ok, 1000)).toEqual({ texto: 'Compactado: 812k → 46k tokens', tono: 'ok', acciones: NINGUNA })
  expect(terminarCompactacion(c, { resultado: { messages: [] } }, 0).texto).toBe('Compactado.')
  expect(terminarCompactacion(c, { resultado: { skip: 'un hook' } }, 0)).toMatchObject({ fase: 'error', texto: 'Compactación cancelada: un hook' })
  expect(terminarCompactacion(c, { error: new TypeError('x') }, 0)).toMatchObject({ fase: 'error', texto: 'No se pudo compactar: TypeError' })
  expect(hayAviso(ok, 1000 + VISIBLE_MS - 1)).toBe(true)
  expect(vigente(ok, 1000 + VISIBLE_MS).fase).toBe('quieto')
  expect(hayAviso(ok, 1000 + VISIBLE_MS)).toBe(false)
})

// ------------------------------------------------------------------ FEAT-182 puro

const RUTA = 'C:\\Users\\u\\.claude\\session-summaries\\2026-10-25-4eee260b-fork.md'
const EXITO = `Resumen (handoff) guardado en ${RUTA}\n— pie`
const oferta = (mas = {}) => ofrecer(nuevoHandoff(), { ruta: RUTA, ...mas })
const ACCIONES_OFERTA = { ...NINGUNA, retomar: true, copiar: true, cerrar: true }

test('FEAT-182 ofrecer: fecha del nombre, título si se conoce, no vence y le gana al aviso', () => {
  expect(fechaDeRuta(RUTA)).toBe('2026-10-25')
  expect(fechaDeRuta('C:/x/sin-fecha.md')).toBe(null)
  expect(filaDeHandoff(oferta(), 0)).toEqual({ texto: 'Handoff del 25/10', tono: 'normal', acciones: ACCIONES_OFERTA })
  expect(filaDeHandoff(oferta({ fecha: '2026-10-26T03:00:00Z', titulo: 'Traspaso: mods' }), 0)?.texto).toBe('Handoff del 26/10 · Traspaso: mods')
  expect(filaDeHandoff(ofrecer(nuevoHandoff(), { ruta: 'C:/x/a.md' }), 0)?.texto).toBe('Handoff anterior')
  const conAviso = { ...oferta(), aviso: 70, pct: 72 }
  expect(hayAviso(conAviso, 1e12)).toBe(true)
  expect(vigente(conAviso, 1e12).fase).toBe('ofreciendo')
  expect(filaDeHandoff(conAviso, 1e12)?.acciones).toEqual(ACCIONES_OFERTA)
})

test('FEAT-182 un umbral nuevo baja «listo» y muestra el aviso; en vuelo y en la oferta queda guardado', () => {
  const listo = terminar(empezar(medirContexto(nuevoHandoff(), 300_000, 1_000_000), 0), EXITO, 1000, HOME)
  expect(listo.fase).toBe('listo')
  const pasado = medirContexto(listo, 540_000, 1_000_000)
  expect(pasado.fase).toBe('quieto')
  expect(pasado.ruta).toBe(RUTA)
  expect(filaDeHandoff(pasado, 1000)?.texto).toBe('Contexto: 540k tokens (corte 2 de 3)')
  const pct = terminar(empezar(medir(nuevoHandoff(), 72), 0), EXITO, 1000, HOME)
  expect(medir(pct, 86).fase).toBe('quieto')
  expect(medir(pct, 75).fase).toBe('listo')
  const generando = medirContexto(empezar(nuevoHandoff(), 0), 300_000, 1_000_000)
  expect(generando.fase).toBe('generando')
  expect(generando.aviso).toBe(268_000)
  const compactando = medir(empezarCompactacion(nuevoHandoff(), 0), 72)
  expect(compactando.fase).toBe('compactando')
  const ofreciendo = medir(oferta(), 72)
  expect(ofreciendo.fase).toBe('ofreciendo')
  expect(cerrar(ofreciendo).aviso).toBe(70)
})

test('FEAT-182 cerrar: «listo» conserva la ruta para el /clear; la oferta no; descartar sigue tocando solo el aviso', () => {
  const listo = terminar(empezar({ ...nuevoHandoff(), aviso: 70 }, 0), EXITO, 1000, HOME)
  const cerrado = cerrar(listo)
  expect(cerrado).toMatchObject({ fase: 'quieto', texto: '', hasta: 0, ruta: RUTA, fecha: '2026-10-25' })
  expect(filaDeHandoff(cerrado, 1000)).toBe(null)
  expect(cerrar(oferta({ mtimeMs: 5 }))).toMatchObject({ fase: 'quieto', ruta: null, fecha: null, mtimeMs: null })
  expect(descartar(listo).fase).toBe('listo')
  expect(descartar({ ...oferta(), aviso: 70 })).toMatchObject({ fase: 'ofreciendo', aviso: null })
})

test('FEAT-182 alEmpezarTurno: limpia resultados y oferta; no lo que está en vuelo ni el aviso', () => {
  const conAviso = { ...nuevoHandoff(), aviso: 70 }
  expect(alEmpezarTurno(terminar(empezar(conAviso, 0), EXITO, 0, HOME)).fase).toBe('quieto')
  expect(alEmpezarTurno(terminar(empezar(conAviso, 0), 'mal', 0, HOME)).fase).toBe('quieto')
  expect(alEmpezarTurno(terminarCompactacion(empezarCompactacion(conAviso, 0), { resultado: {} }, 0)).fase).toBe('quieto')
  expect(alEmpezarTurno(oferta())).toMatchObject({ fase: 'quieto', ruta: null })
  expect(alEmpezarTurno(empezar(conAviso, 0)).fase).toBe('generando')
  expect(alEmpezarTurno(empezarCompactacion(conAviso, 0)).fase).toBe('compactando')
  expect(alEmpezarTurno(conAviso)).toBe(conAviso)
  expect(alEmpezarTurno({ ...oferta(), aviso: 70 }).aviso).toBe(70)
})

test('FEAT-182 promptDeRetomar: la ruta entera y entre comillas', () => {
  const p = promptDeRetomar('C:/Users/mi usuario/x.md')
  expect(p).toContain('con Read antes de responder: "C:/Users/mi usuario/x.md".')
  expect(p).toContain('no una orden')
  expect(p.split('\n')).toHaveLength(4)
})

test('FEAT-182 vistos: misma ruta con cualquier barra; otro mtime reofrece; tope por mtime', () => {
  const v = marcarVisto({}, RUTA, 1234.75)
  expect(estaVisto(v, RUTA.replace(/\\/g, '/'), 1234)).toBe(true)
  expect(estaVisto(v, RUTA, 1235)).toBe(false)
  expect(estaVisto(v, 'C:/otro.md', 1234)).toBe(false)
  expect(estaVisto(marcarVisto({}, RUTA, null), RUTA, null)).toBe(true)
  let muchos = {}
  for (let i = 1; i <= MAX_VISTOS + 3; i++) muchos = marcarVisto(muchos, `C:/h/${i}.md`, i)
  expect(Object.keys(muchos)).toHaveLength(MAX_VISTOS)
  expect(estaVisto(muchos, 'C:/h/3.md', 3)).toBe(false)
  expect(estaVisto(muchos, `C:/h/${MAX_VISTOS + 3}.md`, MAX_VISTOS + 3)).toBe(true)
})

// ------------------------------------------------------------------ mod

const DOCUMENTO = `# Handoff\n\n## 1. Objetivo y estado\n${'Se trabajó en los mods de Lagrange. '.repeat(20)}\n\n## 2. Próximos pasos\n- Seguir.\n`

type Mundo = { fork?: unknown; ventana?: number | null; fallaUsage?: boolean; compact?: unknown; usoTokens?: number; turnos?: number; hallado?: unknown; existe?: boolean; mtimeMs?: number; copia?: unknown; falloSubmit?: boolean; forkEnEspera?: Promise<unknown> }

function simular(on: On, mundo: Mundo) {
  const visto = { usos: 0, forks: 0, escritos: [] as string[], comandos: [] as string[], compactaciones: [] as (string | undefined)[], escaneos: [] as string[], enviados: [] as Array<{ text?: string; asUser?: boolean }>, copias: [] as string[], avisos: [] as string[] }
  const store: Record<string, unknown> = {}
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: (e as { sessionId?: string }).sessionId }) as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('process.run', ($, e) => {
    if (String(e.argv[1]).endsWith('handoff-archivo.js')) {
      visto.escaneos.push(String(e.init?.stdin))
      return { value: { exitCode: 0, stdout: JSON.stringify(mundo.hallado ?? {}), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const cuerpo = String(e.argv[1]).endsWith('buzon.js') ? { sesion: null } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(cuerpo), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('session.id', () => ({ value: '4eee260b-0000' }))
  on('session.turns', () => ({ value: mundo.turnos ?? 3 }))
  on('turn.start', ($, e) => ({ text: e.text, turnId: e.turnId }) as never)
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => { store[e.key] = e.value; return { value: undefined } })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', ($, e) => {
    visto.usos += 1
    if (mundo.fallaUsage) return { deny: 'sin breakdown' }
    const breakdown = (e as { breakdown?: boolean }).breakdown && mundo.ventana ? { rawMaxTokens: mundo.ventana } : undefined
    return { value: { startedAt: 0, context: { tokens: mundo.usoTokens ?? 1, window: 1_000_000, breakdown }, rateLimits: [] } as never }
  })
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.stat', () => (mundo.mtimeMs === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: 1, mtimeMs: mundo.mtimeMs, isLink: false } as never }))
  on('fs.exists', () => ({ value: mundo.existe ?? true }))
  on('prompt.submit', ($, e) => {
    if (mundo.falloSubmit) throw new Error('sin turno')
    visto.enviados.push(e as never)
    return { text: e.text }
  })
  on('ui.copy', ($, e) => { visto.copias.push((e as { text: string }).text); return { value: mundo.copia ?? { isCopied: true } } as never })
  on('ui.toast', ($, e) => { visto.avisos.push(String((e as { text?: string; message?: string }).text ?? (e as { message?: string }).message ?? JSON.stringify(e))); return { value: undefined } as never })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', ($, e) => { visto.escritos.push(String(e.path).replace(/\\/g, '/')); return { value: undefined } })
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? HOME : undefined }))
  on('model.fork', async () => {
    visto.forks += 1
    if (mundo.forkEnEspera) await mundo.forkEnEspera
    return { value: mundo.fork ?? { isAnswered: false, reason: 'nothing-to-fork', usage: {} } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.compact', ($, e) => {
    visto.compactaciones.push((e as { instructions?: string }).instructions)
    if (mundo.compact instanceof Error) throw mundo.compact
    return (mundo.compact ?? { messages: [{ role: 'user', text: 'resumen', toolUses: [] }], tokensBefore: 812_000, tokensAfter: 46_000 }) as never
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  return visto
}

const inicio = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const BANDA = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const montar = ($: Parameters<Parameters<typeof test>[1]>[0], props = BANDA) =>
  $.ui.mount({ plugin: 'lagrange', surface: 'terminal', component: 'AbovePrompt', props } as never)
const medicion = (tokens: number, window = 1_000_000) => ({ context: { tokens, window }, rateLimits: [], changed: ['context'] }) as never

test('mod: cruzar el 70 % de la ventana de compactación dibuja la fila con [h] y [x]; otra medición no la duplica', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  // 150k de 1M es 15 % del modelo, pero 75 % de la ventana de compactación.
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  const ui = await montar($)
  expect((await ui.find({ type: 'Text', text: /Contexto: 75 % hasta compactar/ }))).toBeDefined()
  expect(await ui.find({ key: 'handoff-guardar' })).toBeDefined()
  expect(await ui.find({ key: 'handoff-no' })).toBeDefined()
  await $.session.measure(medicion(152_000))
  await reloj.settle()
  expect(visto.usos).toBe(1)
  const ui2 = await montar($)
  expect((await ui2.find({ type: 'Text', text: /Contexto: 76 % hasta compactar/ }))).toBeDefined()
})

test('mod: sin breakdown decide con la ventana del modelo (avisa tarde, nunca de más)', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { fallaUsage: true })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeUndefined()
  await $.session.measure(medicion(720_000))
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeDefined()
})

test('mod: [x] oculta la fila', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  const ui = await montar($)
  await ui.press({ key: 'handoff-no' })
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeUndefined()
})

test('mod: [h] corre lagrange-resumen con «handoff si» una vez y deja la ruta con ~', async ($, on) => {
  const reloj = mock.clock(on, { now: Date.parse('2026-10-04T05:00:00Z') })
  const visto = simular(on, { ventana: 200_000, fork: { isAnswered: true, text: DOCUMENTO, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } } })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  const ui = await montar($)
  await ui.press({ key: 'handoff-guardar' })
  await reloj.settle()
  expect(visto.forks).toBe(1)
  expect(visto.escritos.length).toBe(1)
  expect(visto.escritos[0]).toContain('/.claude/session-summaries/')
  const despues = await montar($)
  expect(await despues.find({ type: 'Text', text: /^Handoff guardado en ~\/\.claude\/session-summaries\/.*\.md$/ })).toBeDefined()
  expect(await despues.find({ key: 'handoff-guardar' })).toBeUndefined()
  await reloj.advance(VISIBLE_EXITO_MS + 5000)
  expect(await (await montar($)).find({ type: 'Text', text: /Handoff guardado/ })).toBeUndefined()
})

test('mod: un fork que no responde deja el error en la fila, sin el pie de costo', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  await (await montar($)).press({ key: 'handoff-guardar' })
  await reloj.settle()
  const ui = await montar($)
  expect(await ui.find({ type: 'Text', text: /^No se generó el resumen: esta sesión todavía no respondió en este proceso \(nueva, tras \/clear o retomada\): mandá un mensaje y reintentá, o pedí agy_session_summary\.$/ })).toBeDefined()
})

test('mod: /clear (session.end) quita el aviso', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeDefined()
  await $.session.end({ reason: 'clear', sessionId: '4eee260b-0000' } as never)
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-guardar' })).toBeUndefined()
})

test('mod: con la banda llena, agy cede una fila y el aviso entra al final', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  on('tool.call', { tool: 'mcp__plugin_lagrange_lagrange__agy_run' } as never, () => new Promise(() => {}) as never)
  await $.session.start(inicio)
  await reloj.settle()
  for (let i = 0; i < 3; i++) void $.tool.call({ tool: 'mcp__plugin_lagrange_lagrange__agy_run', prompt: String(i) } as never)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  // maxRows 4 → 2 filas: una de agy y el aviso.
  const ui = await montar($, { ...BANDA, maxRows: 4 })
  const agy = await ui.findAll({ type: 'Text', text: /^agy_run · / })
  expect(agy.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Contexto: 75 % hasta compactar/ })).toBeDefined()
})

test('mod: durante un turno la fila se ve sin botones (el fork espera a que termine)', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  const ui = await montar($, { ...BANDA, isWorking: true })
  expect(await ui.find({ type: 'Text', text: /Contexto: 75 % hasta compactar/ })).toBeDefined()
  expect(await ui.find({ key: 'handoff-guardar' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '· al terminar el turno' })).toBeDefined()
  expect(await ui.find({ key: 'handoff-compactar' })).toBeUndefined()
})

test('mod: la pista entre turnos dice cómo llegar a los botones (clic o el acorde ctrl+x y Tab)', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 200_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  expect(await (await montar($)).find({ type: 'Text', text: '· clic, o ctrl+x y Tab' })).toBeDefined()
})

// ------------------------------------------------------------------ FEAT-146 mod

test('FEAT-146 mod: 270k de 1M dibuja [h], [k] y [x]; [k] compacta una vez con instrucciones y deja las cifras 20 s', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { ventana: 1_000_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(270_000))
  await reloj.settle()
  const ui = await montar($)
  expect(await ui.find({ type: 'Text', text: 'Contexto: 270k tokens (corte 1 de 3)' })).toBeDefined()
  expect(await ui.find({ key: 'handoff-guardar' })).toBeDefined()
  expect(await ui.find({ key: 'handoff-no' })).toBeDefined()
  await ui.press({ key: 'handoff-compactar' })
  await reloj.settle()
  expect(visto.compactaciones.length).toBe(1)
  expect(visto.compactaciones[0]).toMatch(/^Conservá el estado de la tarea en curso/)
  expect(visto.forks).toBe(0)
  const despues = await montar($)
  expect(await despues.find({ type: 'Text', text: 'Compactado: 812k → 46k tokens' })).toBeDefined()
  expect(await despues.find({ key: 'handoff-compactar' })).toBeUndefined()
  await reloj.advance(VISIBLE_MS + 5000)
  expect(await (await montar($)).find({ type: 'Text', text: /Compactado/ })).toBeUndefined()
})

test('FEAT-146 mod: un skip deja «Compactación cancelada»', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 1_000_000, compact: { skip: 'lo frenó un hook' } })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(270_000))
  await reloj.settle()
  await (await montar($)).press({ key: 'handoff-compactar' })
  await reloj.settle()
  expect(await (await montar($)).find({ type: 'Text', text: 'Compactación cancelada: lo frenó un hook' })).toBeDefined()
})

test('FEAT-146 mod: [h] y después [k] pasa la ruta del handoff en las instrucciones', async ($, on) => {
  const reloj = mock.clock(on, { now: Date.parse('2026-10-08T05:00:00Z') })
  const visto = simular(on, { ventana: 1_000_000, fork: { isAnswered: true, text: DOCUMENTO, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } } })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(270_000))
  await reloj.settle()
  await (await montar($)).press({ key: 'handoff-guardar' })
  await reloj.settle()
  const listo = await montar($)
  expect(await listo.find({ type: 'Text', text: /^Handoff guardado en / })).toBeDefined()
  expect(await listo.find({ key: 'handoff-guardar' })).toBeUndefined()
  await listo.press({ key: 'handoff-compactar' })
  await reloj.settle()
  expect(visto.compactaciones.length).toBe(1)
  expect(visto.compactaciones[0]).toContain('El handoff completo está en ')
  expect(visto.compactaciones[0]).toContain('session-summaries')
})

test('FEAT-146 mod: tras compactar, una medición baja rearma y el próximo corte vuelve a avisar', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 1_000_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(270_000))
  await reloj.settle()
  await (await montar($)).press({ key: 'handoff-compactar' })
  await reloj.settle()
  await reloj.advance(VISIBLE_MS + 5000)
  await $.session.measure(medicion(46_000))
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-compactar' })).toBeUndefined()
  await $.session.measure(medicion(280_000))
  await reloj.settle()
  expect(await (await montar($)).find({ type: 'Text', text: 'Contexto: 280k tokens (corte 1 de 3)' })).toBeDefined()
})

test('FEAT-146 mod: sin medición (sesión retomada), la banda siembra el contexto con session.usage y avisa sin turno', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { ventana: 1_000_000, usoTokens: 796_000 })
  await $.session.start(inicio)
  await reloj.settle()
  await montar($)
  await reloj.settle()
  const ui = await montar($)
  expect(await ui.find({ type: 'Text', text: 'Contexto: 796k tokens (corte 2 de 3)' })).toBeDefined()
  expect(await ui.find({ key: 'handoff-compactar' })).toBeDefined()
})

// ------------------------------------------------------------------ FEAT-182 mod

const HALLADO = { ruta: RUTA, fecha: '2026-10-25T10:00:00.000Z', titulo: 'Traspaso: mods', fin: '2026-10-25T10:00:00.000Z', mtimeMs: 1000.5 }
const FIN_CLEAR = { reason: 'clear', sessionId: '4eee260b-0000' } as never
const FORK_OK = { isAnswered: true, text: DOCUMENTO, usage: {} }
type Motor = Parameters<Parameters<typeof test>[1]>[0]

/** Dos renders: el primero lanza la búsqueda en segundo plano, el segundo ve la oferta. */
async function asentar($: Motor, reloj: { settle: () => Promise<unknown> }) {
  await montar($)
  await reloj.settle()
  return montar($)
}

test('FEAT-182 mod: sesión nueva con handoff → oferta sin esperar al render; [s] manda el prompt sin asUser y marca visto', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { turnos: 0, hallado: HALLADO })
  await $.session.start(inicio)
  await reloj.settle()
  const ui = await asentar($, reloj)
  expect(await ui.find({ type: 'Text', text: 'Handoff del 25/10 · Traspaso: mods' })).toBeDefined()
  expect(visto.escaneos).toHaveLength(1)
  expect(JSON.parse(visto.escaneos[0]).homes).toEqual([HOME])
  await ui.press({ key: 'handoff-retomar' })
  await reloj.settle()
  expect(visto.enviados).toHaveLength(1)
  expect(visto.enviados[0].text).toBe(promptDeRetomar(RUTA))
  expect(visto.enviados[0].asUser).toBeUndefined()
  expect(await (await montar($)).find({ key: 'handoff-retomar' })).toBeUndefined()
  await $.session.start(inicio)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeUndefined()
})

test('FEAT-182 mod: [x] marca visto y no reofrece; un mtime nuevo sí; [p] copia sin marcar', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const mundo = { turnos: 0, hallado: { ...HALLADO } }
  const visto = simular(on, mundo)
  await $.session.start(inicio)
  await reloj.settle()
  const ui = await asentar($, reloj)
  await ui.press({ key: 'handoff-copiar' })
  await reloj.settle()
  expect(visto.copias).toEqual([promptDeRetomar(RUTA)])
  await $.session.start(inicio)
  await reloj.settle()
  const otra = await asentar($, reloj)
  expect(await otra.find({ key: 'handoff-cerrar' })).toBeDefined()
  await otra.press({ key: 'handoff-cerrar' })
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-cerrar' })).toBeUndefined()
  await $.session.start(inicio)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeUndefined()
  mundo.hallado.mtimeMs = 2000
  await $.session.start(inicio)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeDefined()
})

test('FEAT-182 mod: sin portapapeles, la ruta en un toast; [s] con el archivo borrado o el envío caído no marca', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const mundo = { turnos: 0, hallado: HALLADO, copia: { isCopied: false, reason: 'no-clipboard' }, existe: false, falloSubmit: false }
  const visto = simular(on, mundo)
  await $.session.start(inicio)
  await reloj.settle()
  const ui = await asentar($, reloj)
  await ui.press({ key: 'handoff-copiar' })
  await reloj.settle()
  expect(visto.avisos.join(' ')).toContain(`"${RUTA}"`)
  await ui.press({ key: 'handoff-retomar' })
  await reloj.settle()
  expect(visto.enviados).toHaveLength(0)
  const sigue = await montar($)
  expect(await sigue.find({ key: 'handoff-retomar' })).toBeDefined()
  mundo.existe = true
  mundo.falloSubmit = true
  await sigue.press({ key: 'handoff-retomar' })
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-retomar' })).toBeDefined()
  await $.session.start(inicio)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeDefined()
})

test('FEAT-182 mod: sesión con turnos (--resume, reload): no escanea ni ofrece', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { turnos: 2, hallado: HALLADO })
  await $.session.start(inicio)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeUndefined()
  expect(visto.escaneos).toHaveLength(0)
})

test('FEAT-182 mod: en vscode y mobile no se busca', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { turnos: 0, hallado: HALLADO })
  await $.session.start(inicio)
  await reloj.settle()
  await $.ui.mount({ plugin: 'lagrange', surface: 'vscode', component: 'AbovePrompt', props: BANDA } as never)
  await $.ui.mount({ plugin: 'lagrange', surface: 'mobile', component: 'AbovePrompt', props: BANDA } as never)
  await reloj.settle()
  expect(visto.escaneos).toHaveLength(0)
})

test('FEAT-182 mod: con un turno andando no se busca, y tras ese turno ya no se ofrece', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { turnos: 0, hallado: HALLADO })
  await $.session.start(inicio)
  await reloj.settle()
  await montar($, { ...BANDA, isWorking: true })
  await reloj.settle()
  expect(visto.escaneos).toHaveLength(0)
  await $.turn.start({ turnId: 't1' } as never)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeUndefined()
  expect(visto.escaneos).toHaveLength(0)
})

test('FEAT-182 mod: el primer turno se lleva la oferta sin marcarla', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  simular(on, { turnos: 0, hallado: HALLADO })
  await $.session.start(inicio)
  await reloj.settle()
  await asentar($, reloj)
  await $.turn.start({ turnId: 't1' } as never)
  await reloj.settle()
  expect(await (await montar($)).find({ key: 'handoff-retomar' })).toBeUndefined()
  await $.session.start(inicio)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeDefined()
})

test('FEAT-182 mod: [h] deja la fila de éxito 5 min con copiar y cerrar, sin oferta', async ($, on) => {
  const reloj = mock.clock(on, { now: Date.parse('2026-10-25T05:00:00Z') })
  const visto = simular(on, { ventana: 200_000, fork: FORK_OK, mtimeMs: 77 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  await (await montar($)).press({ key: 'handoff-guardar' })
  await reloj.settle()
  const ui = await montar($)
  expect(await ui.find({ key: 'handoff-retomar' })).toBeUndefined()
  expect(await ui.find({ key: 'handoff-copiar' })).toBeDefined()
  expect(await ui.find({ key: 'handoff-cerrar' })).toBeDefined()
  expect(visto.escritos[0]).not.toContain('ultimo')
  await reloj.advance(VISIBLE_EXITO_MS - 1000)
  expect(await (await montar($)).find({ key: 'handoff-cerrar' })).toBeDefined()
  await reloj.advance(2000)
  expect(await (await montar($)).find({ key: 'handoff-cerrar' })).toBeUndefined()
})

test('FEAT-182 mod: /clear ofrece el handoff de memoria sin escanear ni preguntar turnos; marcado, no', async ($, on) => {
  const reloj = mock.clock(on, { now: Date.parse('2026-10-25T05:00:00Z') })
  const visto = simular(on, { ventana: 200_000, fork: FORK_OK, mtimeMs: 77, turnos: 5 })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  await (await montar($)).press({ key: 'handoff-guardar' })
  await reloj.settle()
  await $.session.end(FIN_CLEAR)
  await reloj.settle()
  const ui = await asentar($, reloj)
  expect(await ui.find({ type: 'Text', text: 'Handoff del 25/10' })).toBeDefined()
  expect(visto.escaneos).toHaveLength(0)
  await ui.press({ key: 'handoff-cerrar' })
  await reloj.settle()
  await $.session.end(FIN_CLEAR)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeUndefined()
})

test('FEAT-182 mod: /clear sin handoff en memoria escanea; salir no ofrece', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  const visto = simular(on, { turnos: 5, hallado: HALLADO })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'x' } as never)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeUndefined()
  await $.session.end(FIN_CLEAR)
  await reloj.settle()
  expect(await (await asentar($, reloj)).find({ key: 'handoff-retomar' })).toBeDefined()
  expect(visto.escaneos).toHaveLength(1)
})

test('FEAT-182 mod: un /clear durante [h] no pisa la sesión nueva', async ($, on) => {
  const reloj = mock.clock(on, { now: 0 })
  let soltar = () => {}
  const forkEnEspera = new Promise<void>((r) => { soltar = r })
  const visto = simular(on, { ventana: 200_000, fork: FORK_OK, forkEnEspera })
  await $.session.start(inicio)
  await reloj.settle()
  await $.session.measure(medicion(150_000))
  await reloj.settle()
  await (await montar($)).press({ key: 'handoff-guardar' })
  await reloj.settle()
  await $.session.end(FIN_CLEAR)
  await reloj.settle()
  soltar()
  // El resumen sigue escribiendo: si el archivo de tests termina antes, falla entero (pasó en la CI, más lenta).
  while (!visto.escritos.length) await reloj.settle()
  await reloj.settle()
  const ui = await montar($)
  expect(visto.escritos).toHaveLength(1)
  expect(await ui.find({ key: 'handoff-copiar' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Handoff guardado/ })).toBeUndefined()
})
