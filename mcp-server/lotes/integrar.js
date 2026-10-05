/**
 * Integrar un lote: mergear en su rama base lo que se auditó (FEAT-108,
 * FEAT-061 fase 5).
 *
 * ES LA ÚNICA OPERACIÓN DE LA FEATURE QUE ESCRIBE EN UNA RAMA DEL USUARIO
 * ----------------------------------------------------------------------
 * Por eso la decide un humano (botón de dos pasos o `npm run lotes -- integrar`)
 * y por eso el veredicto del auditor no dispara nada: solo habilita (SEC-017).
 *
 * Tres reglas:
 *  - se mergea el SHA auditado, no la rama: si la rama de una tarea ya no
 *    apunta a ese SHA, alguien le agregó algo que nadie auditó;
 *  - todos los merges se calculan en memoria (`merge-tree --write-tree` +
 *    `commit-tree`) y la rama base se mueve UNA vez al final. Un conflicto en
 *    la tercera tarea no deja la base con dos merges hechos;
 *  - el working tree del usuario no se toca hasta esa única escritura, y solo
 *    si no tiene cambios sin commitear (`merge --ff-only`); si la base no está
 *    checkouteada, `update-ref` con el valor viejo (compare-and-swap).
 */
const { execFile } = require('node:child_process');
const path = require('node:path');
const { RAMAS_PROTEGIDAS, listarWorktrees: listarWorktreesPorDefecto } = require('../worktrees.js');
const { adquirirBloqueo, liberarBloqueo } = require('./bloqueo.js');
const { borrarRestosDelLote, tomarRepo } = require('./descartar.js');
const { validarSha } = require('./diff.js');

const ESTADO_INTEGRABLE = 'para revisar';

/**
 * ¿Se puede integrar este lote? Pura: la usan la consola (para habilitar el
 * botón) y el CLI.
 *
 * @returns {{ ok: boolean, motivos: string[], tareas: Array }} `tareas`: las que
 *   tienen commit, en el orden del registro.
 */
function evaluarIntegrable(lote) {
  const motivos = [];
  const tareas = [];
  if (!lote) return { ok: false, motivos: ['no existe el lote'], tareas };
  if (lote.estado !== ESTADO_INTEGRABLE) motivos.push(`el lote está "${lote.estado}"; solo se integra uno "${ESTADO_INTEGRABLE}"`);
  for (const t of lote.tareas || []) {
    // Una tarea que terminó bien sin cambiar nada no tiene qué mergear.
    if (!t.commit && t.sinCambios && !t.error) continue;
    if (!t.commit) { motivos.push(`${t.id}: sin commit (${t.estado})`); continue; }
    const prueba = t.prueba || {};
    const auditoria = t.auditoria || {};
    if (prueba.estado !== 'paso') motivos.push(`${t.id}: prueba ${prueba.estado || 'pendiente'}${prueba.exitCode == null ? '' : ` (exit ${prueba.exitCode})`}`);
    if (auditoria.estado !== 'completa') motivos.push(`${t.id}: auditoría ${auditoria.estado || 'pendiente'}`);
    else if (auditoria.veredicto !== 'PASS') motivos.push(`${t.id}: auditoría ${auditoria.veredicto || 'sin veredicto'}`);
    tareas.push(t);
  }
  if (!tareas.length && !motivos.length) motivos.push('ninguna tarea tiene commit');
  return { ok: motivos.length === 0, motivos, tareas };
}

/** BE-104 — Asíncrono: integrar corre en el daemon y no puede frenarle el event loop. */
function gitPorDefecto(repo, args) {
  return new Promise((resolve) => {
    const hijo = execFile('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = !err ? 0 : (typeof err.code === 'number' ? err.code : -1);
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && typeof err.code !== 'number' ? err.message : '')) });
    });
    hijo.stdin?.end();
  });
}

function falla(mensaje, extra = {}) {
  return Object.assign(new Error(mensaje), extra);
}

function mismaRuta(a, b) {
  const n = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  return n(a) === n(b);
}

/**
 * @param {object} deps
 * @param {object} deps.registro
 * @param {string} deps.id
 * @param {Function} deps.confirmar async () => string — lo que el humano escribió.
 * @param {Function} [deps.git]   (repo, args) => { code, stdout, stderr }
 * @param {Function} [deps.recolectarRestos] async () => void
 * @param {Function} [deps.informar] (linea) => void
 * @param {Function} [deps.bloquear] / [deps.liberar] el lock del repo.
 * @param {Function} [deps.listarWorktrees] (repo) => [{ ruta, rama }]
 */
async function integrarLote({ registro, id, confirmar, git = gitPorDefecto, recolectarRestos, informar = () => {},
  bloquear = adquirirBloqueo, liberar = liberarBloqueo, listarWorktrees = listarWorktreesPorDefecto }) {
  const lote = registro.leer(id);
  if (!lote) throw falla(`no hay ningún lote con id ${id}`, { codigo: 404 });
  const previa = evaluarIntegrable(lote);
  if (!previa.ok) throw falla(`el lote ${id} no se puede integrar: ${previa.motivos.join('; ')}`, { motivos: previa.motivos });

  informar(`Lote ${id}, repo ${lote.repo}`);
  informar(`Se van a mergear en ${lote.ramaBase}, un merge por tarea:`);
  for (const t of previa.tareas) informar(`  - ${t.id}  ${t.rama || '(sin rama)'}  ${String(t.commit).slice(0, 8)}`);

  const respuesta = String(await confirmar()).trim();
  if (respuesta !== id) {
    informar('No coincide. No se integró nada.');
    return { integrado: false };
  }

  const lock = tomarRepo(lote.repo, id, bloquear);
  try {
    // Dentro del lock, todo de nuevo: mientras se confirmaba pudo cambiar.
    const actual = registro.leer(id);
    const puerta = evaluarIntegrable(actual);
    if (!puerta.ok) throw falla(`el lote ${id} cambió mientras se confirmaba: ${puerta.motivos.join('; ')}`, { motivos: puerta.motivos });
    const repo = actual.repo;
    const ramaBase = String(actual.ramaBase || '');
    const g = (args) => git(repo, args);

    if (!ramaBase || RAMAS_PROTEGIDAS.has(ramaBase)) throw falla(`la rama base "${ramaBase}" no admite integraciones de un lote`);
    const refBase = `refs/heads/${ramaBase}`;
    const base = await g(['rev-parse', '--verify', '--quiet', `${refBase}^{commit}`]);
    if (base.code !== 0) throw falla(`la rama base ${ramaBase} ya no existe`);
    const antes = base.stdout.trim();

    // Lo que se mergea es lo auditado.
    const shas = [];
    for (const t of puerta.tareas) {
      validarSha(t.commit);
      const c = await g(['rev-parse', '--verify', '--quiet', `${t.commit}^{commit}`]);
      if (c.code !== 0) throw falla(`el commit ${String(t.commit).slice(0, 8)} de ${t.id} ya no existe`);
      const sha = c.stdout.trim();
      if (t.rama) {
        const r = await g(['rev-parse', '--verify', '--quiet', `refs/heads/${t.rama}^{commit}`]);
        if (r.code !== 0) throw falla(`la rama ${t.rama} de ${t.id} ya no existe`);
        if (r.stdout.trim() !== sha) throw falla(`la rama ${t.rama} de ${t.id} cambió después de auditarse`);
      }
      shas.push({ tarea: t, sha });
    }

    // La cadena de merges, en memoria.
    let cur = antes;
    const merges = [];
    for (const { tarea, sha } of shas) {
      const m = await g(['merge-tree', '--write-tree', '--no-messages', '--name-only', cur, sha]);
      if (m.code === 1) {
        const archivos = m.stdout.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
        throw falla(`la tarea ${tarea.id} choca con lo anterior en: ${archivos.join(', ') || '(sin detalle)'}. No se integró nada.`, { conflicto: archivos });
      }
      if (m.code !== 0) throw falla(`no se pudo calcular el merge de ${tarea.id}: ${m.stderr.trim().slice(0, 300)}`);
      const arbol = m.stdout.split(/\r?\n/)[0].trim();
      const mensaje = `Merge lote ${id}: tarea ${tarea.id}${tarea.rama ? ` (${tarea.rama})` : ''}`;
      const c = await g(['commit-tree', arbol, '-p', cur, '-p', sha, '-m', mensaje]);
      if (c.code !== 0) throw falla(`no se pudo crear el merge de ${tarea.id}: ${c.stderr.trim().slice(0, 300)}`);
      cur = c.stdout.trim();
      merges.push({ tarea: tarea.id, commit: sha, merge: cur });
    }

    // La única escritura sobre la rama del usuario.
    const checkout = (await listarWorktrees(repo)).find((w) => w.rama === ramaBase);
    if (checkout) {
      const st = await git(checkout.ruta, ['status', '--porcelain', '--untracked-files=no']);
      if (st.code !== 0) throw falla(`no se pudo leer el estado del checkout de ${ramaBase}`);
      if (st.stdout.trim()) throw falla(`hay cambios sin commitear en el checkout de ${ramaBase}. No se integró nada.`);
      const ff = await git(checkout.ruta, ['merge', '--ff-only', '--quiet', cur]);
      if (ff.code !== 0) throw falla(`git no pudo avanzar ${ramaBase}: ${ff.stderr.trim().slice(0, 300)}. No se integró nada.`);
    } else {
      const u = await g(['update-ref', '-m', `lagrange: integrar lote ${id}`, refBase, cur, antes]);
      if (u.code !== 0) throw falla(`${ramaBase} cambió mientras se integraba: ${u.stderr.trim().slice(0, 300)}. No se integró nada.`);
    }
    const despues = (await g(['rev-parse', '--verify', '--quiet', refBase])).stdout.trim();
    if (despues !== cur) throw falla(`${ramaBase} quedó en ${despues.slice(0, 8)} y se esperaba ${cur.slice(0, 8)}`);

    // Registrado ANTES de limpiar: si algo se cae a mitad de la limpieza, el
    // lote ya dice que está integrado.
    const integracion = { rama: ramaBase, antes, despues, cuando: new Date().toISOString(), merges };
    registro.guardar({ ...registro.leer(id), integracion });
    registro.cambiarEstado(id, 'integrado');
    informar(`${ramaBase}: ${antes.slice(0, 8)} → ${despues.slice(0, 8)} (${merges.length} merge${merges.length === 1 ? '' : 's'})`);

    const esAncestro = async (a) => (await g(['merge-base', '--is-ancestor', a, refBase])).code === 0;
    const gitTexto = async (r, args, { permitirFallo = false } = {}) => {
      const x = await git(r, args);
      if (x.code === 0) return x.stdout;
      if (permitirFallo) return null;
      throw new Error(x.stderr.trim());
    };
    const { borrados, saltados } = await borrarRestosDelLote(registro.leer(id), {
      git: gitTexto,
      informar,
      puedeBorrarRama: async (t) => ((await esAncestro(t.commit || `refs/heads/${t.rama}`))
        ? { ok: true }
        : { ok: false, motivo: `no está en ${ramaBase}` })
    });
    if (recolectarRestos) {
      try { await recolectarRestos(); } catch { /* la poda no deshace una integración */ }
    }
    informar(`Lote ${id} integrado.`);
    return { integrado: true, ...integracion, borrados, saltados };
  } finally {
    liberar(lock);
  }
}

module.exports = { ESTADO_INTEGRABLE, evaluarIntegrable, integrarLote };
