'use strict';

/**
 * FEAT-195 — Cola neutral de auditorías: cualquier harness pide, cualquier otro audita.
 *
 * ```
 * <raíz del proyecto>/.lagrange/auditorias/
 *   .gitignore            "*"
 *   pedidos/<id>.md       lo escribe quien pide
 *   pedidos/<id>/         contexto de git (estado, log, diffs), sin deny_paths
 *   tomados/<id>.json     reclamo del auditor vigente
 *   informes/<id>.md      lo escribe `entregar` (o el auditor a mano, con el umbral de estabilidad)
 * ```
 *
 * Identidad: `<harness>:<sesión>` (`claude:<CLAUDE_CODE_SESSION_ID>`, `opencode:<sessionID>`,
 * `agy:<ANTIGRAVITY_CONVERSATION_ID>`); sin sesión confiable, `<harness>:anonimo`. Invariantes del plan:
 *   I2 nadie audita lo propio · I4 a lo sumo un auditor vigente (sin vencimiento; `forzar` y `soltar`) ·
 *   I5 un informe cuenta si es válido (id + exactamente un `## Verdict:`) y estable.
 * Este módulo no toca el cursor de las sesiones de Claude (I3): eso lo decide quien llama, y solo para el solicitante.
 *
 * Reusa `pedidos-agy.js` (rutas, ids únicos entre colas, barrido, frontmatter) y `artefactosDeGit`. Los pedidos
 * `tipo: audit` de la cola vieja (`.lagrange/agy/`) se recogen por id (legado, hasta que los barra la limpieza).
 */

const fs = require('node:fs');
const path = require('node:path');
const pedidosAgy = require('./pedidos-agy.js');
const nombresTools = require('./nombres-tools.js');
const { artefactosDeGit } = require('../lotes/instantanea.js');
const { conLock } = require('../almas/archivos.js');
const { escribirAtomico } = require('./fs-atomico.js');

const CARPETA = 'auditorias';
const HARNESSES = new Set(['claude', 'opencode', 'agy']);
const MODOS = new Set(['implementation', 'plan']);
const RE_SESION = /^[A-Za-z0-9._-]{1,128}$/;
const RE_IDENTIDAD = /^(claude|opencode|agy):[A-Za-z0-9._-]{1,128}$/;
const RE_VEREDICTO = /^## Verdict:\s*(PASS WITH RESERVATIONS|PASS|FAIL)\s*$/gmi;
const UMBRAL_ESTABLE_MS = 5000;
const GITIGNORE = '# FEAT-195 — cola de auditorías: pedidos, reclamos e informes locales, no se versionan.\n*\n';

class ErrorCola extends Error {
  constructor(codigo, mensaje) {
    super(mensaje);
    this.name = 'ErrorCola';
    this.code = codigo;
  }
}

/** `<harness>:<sesión>`. Una sesión ausente o con caracteres raros queda `anonimo` (nunca se inventa una). */
function identidad(harness, sesion) {
  if (!HARNESSES.has(harness)) throw new ErrorCola('EHARNESS', `harness desconocido: "${harness}" (claude, opencode o agy)`);
  const s = String(sesion || '').trim();
  return `${harness}:${RE_SESION.test(s) ? s : 'anonimo'}`;
}

function validarIdentidad(yo) {
  if (!RE_IDENTIDAD.test(String(yo || ''))) throw new ErrorCola('EIDENTIDAD', `identidad inválida: "${yo}" (formato <harness>:<sesión>)`);
  return String(yo);
}

/** Un nombre legible para mostrar (una línea, sin `---`); nunca decide nada. */
function nombreLimpio(nombre) {
  const n = String(nombre || '').replace(/[\r\n]+/g, ' ').replace(/-{3,}/g, '-').trim().slice(0, 80);
  return n || null;
}

const rutasCola = (raiz, id) => pedidosAgy.rutas(raiz, id, CARPETA);

function leerTexto(ruta) {
  try { return fs.readFileSync(ruta, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

/** El reclamo vigente, o null. Uno ilegible cuenta como tomado por alguien desconocido: no se pisa sin `forzar`. */
function leerTomado(r) {
  const t = leerTexto(r.tomado);
  if (t === null) return null;
  try {
    const j = JSON.parse(t);
    if (j && typeof j.auditor === 'string') return { auditor: j.auditor, nombre: j.nombre || null, tomadoMs: Number(j.tomadoMs) || 0 };
  } catch {}
  return { auditor: '(reclamo ilegible)', nombre: null, tomadoMs: 0 };
}

/** I5 — Problemas del cuerpo de un informe: exactamente una línea de veredicto, y no vacío. */
function problemasDelCuerpo(cuerpo) {
  const problemas = [];
  const texto = String(cuerpo || '');
  if (!texto.trim()) return ['el informe está vacío'];
  const n = (texto.match(RE_VEREDICTO) || []).length;
  if (n === 0) problemas.push('falta una de las líneas `## Verdict: PASS`, `## Verdict: PASS WITH RESERVATIONS` o `## Verdict: FAIL` (sola en su renglón)');
  if (n > 1) problemas.push(`hay ${n} líneas \`## Verdict:\`: tiene que haber exactamente una`);
  return problemas;
}

function veredictoDe(cuerpo) {
  RE_VEREDICTO.lastIndex = 0;
  const m = RE_VEREDICTO.exec(String(cuerpo || ''));
  RE_VEREDICTO.lastIndex = 0;
  return m ? m[1].toUpperCase() : null;
}

/**
 * Estado del informe de un pedido de la cola. `escribiendo`: válido pero escrito a mano hace menos de `umbralMs`
 * (puede estar a medias). Uno escrito por `entregar` (lleva `entregado:`) es atómico y no espera.
 */
function estadoInforme(r, id, { umbralMs = UMBRAL_ESTABLE_MS, ahora = Date.now() } = {}) {
  const texto = leerTexto(r.informe);
  if (texto === null) return { estado: 'pendiente', problemas: [] };
  const fi = pedidosAgy.frontmatter(texto);
  const problemas = [];
  if (fi.campos.id !== id) problemas.push(`el informe tiene que empezar con el encabezado \`---\\nid: ${id}\\n---\` (dice id "${fi.campos.id || ''}")`);
  problemas.push(...problemasDelCuerpo(fi.cuerpo));
  const base = {
    texto: fi.cuerpo.trim(),
    veredicto: veredictoDe(fi.cuerpo),
    auditor: fi.campos.auditor || null,
    nombre: fi.campos.nombre || null,
    entregado: fi.campos.entregado || null,
    problemas
  };
  if (problemas.length) return { estado: 'invalido', ...base };
  if (!base.entregado) {
    let mtimeMs = ahora;
    try { mtimeMs = fs.statSync(r.informe).mtimeMs; } catch {}
    if (ahora - mtimeMs < umbralMs) return { estado: 'escribiendo', ...base };
  }
  return { estado: 'listo', ...base };
}

function leerPedido(r, id) {
  const texto = leerTexto(r.pedido);
  if (texto === null) return null;
  const fp = pedidosAgy.frontmatter(texto);
  if (fp.campos.id !== id) throw new ErrorCola('EPEDIDO', `el pedido ${r.relPedido} dice id "${fp.campos.id || ''}", no ${id}`);
  return { texto, campos: fp.campos };
}

function exigirPedido(raiz, id) {
  const r = rutasCola(raiz, id);
  const p = leerPedido(r, id);
  if (!p) throw new ErrorCola('ENOPEDIDO', `no hay pedido de auditoría ${id} en ${pedidosAgy.normal(raiz)} (${r.relPedido}): ¿es otro proyecto, o lo barrió la limpieza de ${pedidosAgy.DIAS_BARRIDO} días?`);
  return { r, p };
}

/**
 * Escribe un pedido. `prompt` es el proceso completo + la tarea (I6: el pedido es autosuficiente).
 * @returns {{ id, raiz, pedido, informe, adjuntos, barridos }}
 */
function pedir({ cwd, modo, prompt, solicitante, nombre = null, denyPaths = [], ahora = new Date(), azar } = {}) {
  if (!MODOS.has(modo)) throw new ErrorCola('EMODO', `modo de auditoría inválido: "${modo}" (implementation o plan)`);
  if (!String(prompt || '').trim()) throw new ErrorCola('EPROMPT', 'el pedido no tiene instrucciones');
  validarIdentidad(solicitante);
  const raiz = pedidosAgy.raizDe(cwd);
  const base = path.join(raiz, '.lagrange', CARPETA);
  pedidosAgy.asegurarCarpeta(base, GITIGNORE);
  const barridos = pedidosAgy.barrer(raiz, { ahora: ahora.getTime(), carpeta: CARPETA });
  const id = pedidosAgy.nuevoId(raiz, azar ? { azar } : undefined);
  const r = rutasCola(raiz, id);
  const git = artefactosDeGit({ repo: raiz, destino: r.adjuntos, denyPaths });
  const n = nombreLimpio(nombre);
  const adjuntos = git ? git.archivos.map((a) => `\`${r.relAdjuntos}/${a}\``).join(', ') : null;
  const texto = `---
id: ${id}
tipo: audit
modo: ${modo}
creado: ${ahora.toISOString()}
solicitante: ${solicitante}
${n ? `nombre: ${n}\n` : ''}rama: ${git ? git.rama : '(sin git)'}
head: ${git ? git.head : '(sin git)'}
cwd: ${pedidosAgy.normal(raiz)}
informe: ${r.relInforme}
---

# Pedido de auditoría ${id} (Lagrange, cola de auditorías)

Lo pidió \`${solicitante}\`${n ? ` (${n})` : ''}. Lo corre a mano la sesión que elija el usuario (claude, opencode o agy),
nunca la que lo pidió. Trabajá sobre el proyecto de esta carpeta (\`${pedidosAgy.normal(raiz)}\`).${adjuntos ? ` El contexto de git está en ${adjuntos}; el código, en el árbol de trabajo.` : ''}

**Tomalo antes de empezar.** Con la herramienta de Lagrange de tu harness (la tool \`audit_queue\`, o \`/lagrange-audit ${id}\`
en agy): \`take\` lo reserva para vos y \`submit\` escribe el informe. Así nadie más lo audita a la vez.

**Entrega:** el informe completo en Markdown, con exactamente una de estas líneas (obligatoria: Lagrange la lee):
\`## Verdict: PASS\`, \`## Verdict: PASS WITH RESERVATIONS\` o \`## Verdict: FAIL\`. Con \`submit\` el encabezado lo pone
Lagrange. Sin la herramienta, escribilo en \`${r.relInforme}\` empezando con este encabezado exacto:

\`\`\`
---
id: ${id}
---
\`\`\`

No edites ningún otro archivo del proyecto. Cuando termines, decile al usuario que el informe ${id} está listo.

---

${prompt}
`;
  fs.writeFileSync(r.pedido, texto);
  return { id, raiz, pedido: r.relPedido, informe: r.relInforme, adjuntos: git ? r.relAdjuntos : null, barridos };
}

/**
 * Reclama un pedido para auditarlo. Rechaza el propio (I2), uno ya auditado y uno tomado por otro salvo `forzar` (I4).
 * @returns {{ id, raiz, texto, pedido, informe, adjuntos, anterior, yaEraTuyo }}
 */
function tomar({ cwd, id, yo, nombre = null, forzar = false, ahora = Date.now() } = {}) {
  pedidosAgy.validarId(id);
  validarIdentidad(yo);
  const raiz = pedidosAgy.raizDe(cwd);
  const { r, p } = exigirPedido(raiz, id);
  if (p.campos.solicitante === yo) {
    throw new ErrorCola('EPROPIO', `el pedido ${id} es tuyo (${yo}): lo audita otra sesión, no la que lo pidió`);
  }
  const resultado = conLock(r.tomado, () => {
    if (estadoInforme(r, id, { ahora }).estado === 'listo') throw new ErrorCola('EAUDITADO', `el pedido ${id} ya tiene su informe: no hay nada que tomar`);
    const actual = leerTomado(r);
    if (actual && actual.auditor === yo) return { anterior: null, yaEraTuyo: true };
    if (actual && !forzar) {
      const desde = actual.tomadoMs ? ` desde ${new Date(actual.tomadoMs).toISOString()}` : '';
      throw new ErrorCola('ETOMADO', `el pedido ${id} lo tiene ${actual.auditor}${actual.nombre ? ` (${actual.nombre})` : ''}${desde}. Si esa sesión ya no está, tomalo con forzar.`);
    }
    escribirAtomico(r.tomado, JSON.stringify({ id, auditor: yo, nombre: nombreLimpio(nombre), tomadoMs: ahora }));
    return { anterior: actual, yaEraTuyo: false };
  });
  return {
    id, raiz, texto: p.texto, pedido: r.relPedido, informe: r.relInforme,
    adjuntos: fs.existsSync(r.adjuntos) ? r.relAdjuntos : null,
    ...resultado
  };
}

/** Libera el reclamo. Solo el auditor vigente. */
function soltar({ cwd, id, yo } = {}) {
  pedidosAgy.validarId(id);
  validarIdentidad(yo);
  const raiz = pedidosAgy.raizDe(cwd);
  const { r } = exigirPedido(raiz, id);
  return conLock(r.tomado, () => {
    const actual = leerTomado(r);
    if (!actual) return { soltado: false };
    if (actual.auditor !== yo) throw new ErrorCola('ENOESTUYO', `el pedido ${id} lo tiene ${actual.auditor}, no vos: no podés soltarlo`);
    fs.rmSync(r.tomado, { force: true });
    return { soltado: true };
  });
}

/**
 * Valida y escribe el informe (atómico, con su encabezado). Exige ser el auditor vigente. Un texto inválido no se
 * escribe: devuelve `{ ok: false, problemas }` para que el auditor lo corrija.
 */
function entregar({ cwd, id, yo, nombre = null, informe, ahora = new Date() } = {}) {
  pedidosAgy.validarId(id);
  validarIdentidad(yo);
  const raiz = pedidosAgy.raizDe(cwd);
  const { r } = exigirPedido(raiz, id);
  // Si el auditor mandó su propio encabezado, se descarta: el de la cola lo pone `entregar`.
  const cuerpo = pedidosAgy.frontmatter(String(informe || '')).cuerpo.trim();
  return conLock(r.tomado, () => {
    const actual = leerTomado(r);
    if (!actual) throw new ErrorCola('ENOTOMADO', `el pedido ${id} no está tomado: tomalo antes de entregar`);
    if (actual.auditor !== yo) throw new ErrorCola('ENOESTUYO', `el pedido ${id} lo tiene ${actual.auditor}, no vos: no podés entregarlo`);
    if (estadoInforme(r, id, { ahora: ahora.getTime() }).estado === 'listo') throw new ErrorCola('EAUDITADO', `el pedido ${id} ya tiene su informe`);
    const problemas = problemasDelCuerpo(cuerpo);
    if (problemas.length) return { ok: false, problemas };
    const n = nombreLimpio(nombre) || actual.nombre;
    escribirAtomico(r.informe, `---\nid: ${id}\nauditor: ${yo}\n${n ? `nombre: ${n}\n` : ''}entregado: ${ahora.toISOString()}\n---\n\n${cuerpo}\n`);
    return { ok: true, id, informe: r.relInforme, veredicto: veredictoDe(cuerpo) };
  });
}

/**
 * Lee el estado y, si está, el informe de un pedido. Busca primero en la cola nueva y, si no está, en la de agy
 * (legado, solo `tipo: audit`). No marca nada en ningún cursor (I3): eso es de quien llama.
 * @returns {{ cola, id, tipo, modo, solicitante, estado: 'pendiente'|'en_curso'|'escribiendo'|'listo'|'invalido',
 *   texto?, veredicto?, auditor?, nombre?, problemas, informe, pedido }}
 */
function recoger({ cwd, id, umbralMs = UMBRAL_ESTABLE_MS, ahora = Date.now() } = {}) {
  pedidosAgy.validarId(id);
  const raiz = pedidosAgy.raizDe(cwd);
  const r = rutasCola(raiz, id);
  const p = leerPedido(r, id);
  if (p) {
    if (p.campos.cwd && !pedidosAgy.mismaRuta(p.campos.cwd, pedidosAgy.normal(raiz))) {
      throw new ErrorCola('EOTRARAIZ', `el pedido ${id} es de ${p.campos.cwd}, no de ${pedidosAgy.normal(raiz)}: recogelo con ese cwd`);
    }
    const inf = estadoInforme(r, id, { umbralMs, ahora });
    const tomado = leerTomado(r);
    const estado = inf.estado === 'pendiente' && tomado ? 'en_curso' : inf.estado;
    return {
      cola: CARPETA, id, tipo: 'audit', modo: p.campos.modo || null, solicitante: p.campos.solicitante || null,
      ...inf, estado, auditor: inf.auditor || (tomado ? tomado.auditor : null),
      informe: r.relInforme, pedido: r.relPedido
    };
  }
  if (!fs.existsSync(pedidosAgy.rutas(raiz, id).pedido)) {
    throw new ErrorCola('ENOPEDIDO', `no hay pedido ${id} en ${pedidosAgy.normal(raiz)} (ni en ${r.relPedido} ni en .lagrange/agy/pedidos/${id}.md): ¿es otro proyecto, o lo barrió la limpieza de ${pedidosAgy.DIAS_BARRIDO} días?`);
  }
  const viejo = pedidosAgy.recogerInforme({ cwd: raiz, id });
  if (viejo.tipo !== 'audit') {
    throw new ErrorCola('ENOAUDITORIA', `el pedido ${id} es de ${nombresTools.nombreNuevo(pedidosAgy.TIPOS[viejo.tipo].tool)}, no una auditoría: recogelo con esa tool`);
  }
  return { cola: 'agy', solicitante: null, auditor: null, nombre: null, pedido: pedidosAgy.rutas(raiz, id).relPedido, ...viejo };
}

/**
 * Los pedidos de la cola para `yo`. `para_auditar`: sin informe listo, no propios y libres (o tomados por `yo`).
 * `mios`: los que pidió `yo`, con su estado. Del más nuevo al más viejo.
 */
function listar({ cwd, yo, que = 'para_auditar', ahora = Date.now() } = {}) {
  validarIdentidad(yo);
  if (!['para_auditar', 'mios'].includes(que)) throw new ErrorCola('EQUE', `listar: "${que}" no es para_auditar ni mios`);
  const raiz = pedidosAgy.raizDe(cwd);
  let nombres = [];
  try { nombres = fs.readdirSync(path.join(raiz, '.lagrange', CARPETA, 'pedidos')); } catch { return []; }
  const salida = [];
  for (const n of nombres) {
    const m = /^([0-9a-f]{6})\.md$/.exec(n);
    if (!m) continue;
    const id = m[1];
    try {
      const r = rutasCola(raiz, id);
      const p = leerPedido(r, id);
      if (!p) continue;
      const propio = p.campos.solicitante === yo;
      if ((que === 'mios') !== propio) continue;
      const inf = estadoInforme(r, id, { ahora });
      const tomado = leerTomado(r);
      if (que === 'para_auditar' && (inf.estado === 'listo' || (tomado && tomado.auditor !== yo))) continue;
      salida.push({
        id, modo: p.campos.modo || null, creado: p.campos.creado || '', rama: p.campos.rama || null,
        solicitante: p.campos.solicitante || null, nombre: p.campos.nombre || null,
        estado: inf.estado === 'pendiente' && tomado ? 'en_curso' : inf.estado,
        veredicto: inf.veredicto || null, auditor: inf.auditor || (tomado ? tomado.auditor : null),
        tomadoPorMi: Boolean(tomado && tomado.auditor === yo)
      });
    } catch {}
  }
  return salida.sort((a, b) => String(b.creado).localeCompare(String(a.creado)) || b.id.localeCompare(a.id));
}

/** Para los avisos (FEAT-194): ¿el informe de `id` está listo y estable? Mira la cola nueva y, si no, la de agy. */
function informeEstable(raiz, id, { umbralMs = UMBRAL_ESTABLE_MS, ahora = Date.now() } = {}) {
  try {
    pedidosAgy.validarId(id);
    const r = rutasCola(raiz, id);
    if (fs.existsSync(r.pedido)) return estadoInforme(r, id, { umbralMs, ahora }).estado === 'listo';
    return pedidosAgy.informeEstable(raiz, id, { umbralMs, ahora });
  } catch {
    return false;
  }
}

/**
 * FEAT-195 (F4) — Los informes listos de la cola nueva, del más nuevo al más viejo, sin cuerpo ni rutas: para la banda
 * de Claude (`hooks/panel.js`), que muestra solo los que esa sesión pidió. Nunca lanza.
 */
function listarInformes(cwd, { umbralMs = UMBRAL_ESTABLE_MS, ahora = Date.now() } = {}) {
  let raiz;
  try { raiz = pedidosAgy.raizDe(cwd); } catch { return []; }
  let nombres = [];
  try { nombres = fs.readdirSync(path.join(raiz, '.lagrange', CARPETA, 'informes')); } catch { return []; }
  const salida = [];
  for (const n of nombres) {
    const m = /^([0-9a-f]{6})\.md$/.exec(n);
    if (!m) continue;
    try {
      const r = rutasCola(raiz, m[1]);
      const p = leerPedido(r, m[1]);
      if (!p) continue;
      const inf = estadoInforme(r, m[1], { umbralMs, ahora });
      if (inf.estado !== 'listo') continue;
      salida.push({ id: m[1], tipo: 'audit', modo: p.campos.modo || null, veredicto: inf.veredicto || null, mtimeMs: fs.statSync(r.informe).mtimeMs });
    } catch {}
  }
  return salida.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

module.exports = {
  CARPETA, HARNESSES, UMBRAL_ESTABLE_MS, ErrorCola,
  identidad, validarIdentidad, pedir, tomar, soltar, entregar, recoger, listar, listarInformes, informeEstable, problemasDelCuerpo,
  rutas: rutasCola
};
