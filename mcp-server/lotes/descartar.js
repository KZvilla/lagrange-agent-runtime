/**
 * Descartar un lote: borrar sus worktrees y sus ramas (FEAT-061 fase 2, §4.7).
 *
 * ES LA ÚNICA OPERACIÓN DE LA FEATURE QUE DESTRUYE TRABAJO
 * -------------------------------------------------------
 * Por eso vive del lado del humano (RFC §2 R4) y por eso está acá, en un módulo
 * con las dependencias inyectadas, en vez de suelta dentro del script: lo que
 * borra ramas se prueba.
 *
 * Dos guardas, y ninguna es decorativa:
 *  - la rama tiene que empezar con `wt/agy-<id>-`, o sea ser de ESTE lote;
 *  - el worktree tiene que estar bajo `.claude/worktrees/` del repo del lote.
 * Lo que no las pase se salta y se informa. Nunca se barre por prefijo ni se
 * usa `limpiarWorktrees`, que trabaja sobre todos los worktrees del fan-out.
 *
 * FEAT-108: integrar un lote usa el mismo borrado acotado
 * (`borrarRestosDelLote`), y los dos toman el lock del repo de `bloqueo.js`:
 * sin él, un descarte podría borrar las ramas que una integración está
 * mergeando.
 */
const fs = require('node:fs');
const path = require('node:path');
const { adquirirBloqueo, liberarBloqueo } = require('./bloqueo.js');

// F4b — Un lote que espera a un humano también se descarta: no tiene proceso dueño.
const ESTADOS_DESCARTABLES = ['para revisar', 'fallido', 'interrumpido', 'esperando humano'];
const DIR_WORKTREES = path.join('.claude', 'worktrees');

/**
 * Borra los worktrees y las ramas que el registro asocia a `lote`, con las dos
 * guardas. `puedeBorrarRama(t)` decide además si la rama de una tarea se borra
 * (al integrar: solo si ya está en la rama base).
 *
 * @returns {{ borrados: Array, saltados: Array }}
 */
async function borrarRestosDelLote(lote, { git, informar = () => {}, puedeBorrarRama = () => ({ ok: true }) }) {
  const prefijoRama = `wt/agy-${lote.id}-`;
  const borrados = [];
  const saltados = [];

  // F4c — Las ramas de una tarea (`t.ramas[k]`) tienen su worktree y su rama, con el mismo prefijo del lote.
  const piezas = (lote.tareas || []).flatMap((t) => [t, ...Object.entries(t.ramas && typeof t.ramas === 'object' ? t.ramas : {})
    .filter(([, r]) => r && (r.worktree || r.rama))
    .map(([k, r]) => ({ id: `${t.id}-r${k}`, worktree: r.worktree || null, rama: r.rama || null, commit: r.commit || null, esRama: true }))]);
  for (const t of piezas) {
    if (t.worktree) {
      const relativo = path.relative(lote.repo, t.worktree);
      const dentro = !relativo.startsWith('..') && !path.isAbsolute(relativo) && relativo.startsWith(DIR_WORKTREES);
      if (!dentro) {
        saltados.push({ que: t.worktree, motivo: `no está bajo ${DIR_WORKTREES}` });
        informar(`  saltado (worktree fuera de ${DIR_WORKTREES}): ${t.worktree}`);
      } else {
        await git(lote.repo, ['worktree', 'unlock', t.worktree], { permitirFallo: true });
        await git(lote.repo, ['worktree', 'remove', t.worktree, '--force'], { permitirFallo: true });
        // `git worktree remove` puede dejar la carpeta si Windows la retiene.
        try {
          if (fs.existsSync(t.worktree)) fs.rmSync(t.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        } catch {}
        // Lo que se informa es lo que quedó en disco, no lo que se intentó: si
        // el worktree ya no estaba (repo recreado, borrado a mano), decir
        // "borrado" sería mentir sobre una operación destructiva.
        if (fs.existsSync(t.worktree)) {
          saltados.push({ que: t.worktree, motivo: 'no se pudo borrar' });
          informar(`  NO se pudo borrar el worktree: ${t.worktree}`);
        } else {
          borrados.push({ que: t.worktree, tipo: 'worktree' });
          informar(`  worktree borrado: ${t.worktree}`);
        }
      }
    }

    if (t.rama) {
      // La rama de una rama es material de trabajo del lote: lo que importa se juntó en la tarea.
      const permiso = !t.rama.startsWith(prefijoRama) ? { ok: false, motivo: 'la rama no es de este lote' } : (t.esRama ? { ok: true } : await puedeBorrarRama(t));
      if (!permiso.ok) {
        saltados.push({ que: t.rama, motivo: permiso.motivo });
        informar(`  saltado (${permiso.motivo}): ${t.rama}`);
      } else {
        const salida = await git(lote.repo, ['branch', '-D', t.rama], { permitirFallo: true });
        if (salida === null) {
          saltados.push({ que: t.rama, motivo: 'la rama ya no existía' });
          informar(`  la rama ya no existía: ${t.rama}`);
        } else {
          borrados.push({ que: t.rama, tipo: 'rama' });
          informar(`  rama borrada: ${t.rama}`);
        }
      }
    }
  }

  await git(lote.repo, ['worktree', 'prune'], { permitirFallo: true });
  return { borrados, saltados };
}

/**
 * El lock del repo del lote, o un error legible si otro lote lo tiene.
 */
function tomarRepo(repo, id, bloquear) {
  try {
    return bloquear(repo, id);
  } catch (err) {
    throw new Error(`${err.message}; probá cuando termine`);
  }
}

/**
 * @param {object} deps
 * @param {object} deps.registro    El de registro.js.
 * @param {string} deps.id
 * @param {Function} deps.git       (repo, args, opciones) => string|null
 * @param {Function} deps.confirmar async () => string — lo que el humano escribió.
 * @param {Function} [deps.recolectarRestos] async () => void
 * @param {Function} [deps.informar] (linea) => void
 * @param {Function} [deps.bloquear]  (repo, id) => lock — por defecto, el de bloqueo.js.
 * @param {Function} [deps.liberar]   (lock) => void
 */
async function descartarLote({ registro, id, git, confirmar, recolectarRestos, informar = () => {},
  bloquear = adquirirBloqueo, liberar = liberarBloqueo }) {
  const lote = registro.leer(id);
  if (!lote) throw new Error(`no hay ningún lote con id ${id}`);
  if (!ESTADOS_DESCARTABLES.includes(lote.estado)) {
    throw new Error(`el lote ${id} está en estado "${lote.estado}": solo se descartan lotes terminados`);
  }

  informar(`Lote ${id} (${lote.estado}), repo ${lote.repo}`);
  informar('Se van a borrar estos worktrees y ramas:');
  for (const t of lote.tareas) {
    informar(`  - ${t.rama || '(sin rama)'}  ${t.worktree || ''}`);
    for (const r of Object.values(t.ramas && typeof t.ramas === 'object' ? t.ramas : {})) if (r && (r.rama || r.worktree)) informar(`  - ${r.rama || '(sin rama)'}  ${r.worktree || ''}`);
  }
  informar('Esto borra el trabajo del lote. No se puede deshacer.');

  const respuesta = String(await confirmar()).trim();
  if (respuesta !== id) {
    informar('No coincide. No se borró nada.');
    return { descartado: false, borrados: [], saltados: [] };
  }

  // El lock se toma después de la confirmación (un humano tipeando no frena a
  // nadie) y, ya dentro, el lote se relee: mientras se esperaba la respuesta
  // pudo integrarse.
  const lock = tomarRepo(lote.repo, id, bloquear);
  try {
    const actual = registro.leer(id);
    if (!actual || !ESTADOS_DESCARTABLES.includes(actual.estado)) {
      throw new Error(`el lote ${id} cambió a "${actual ? actual.estado : 'inexistente'}" mientras se confirmaba: no se borró nada`);
    }
    const { borrados, saltados } = await borrarRestosDelLote(actual, { git, informar });
    if (recolectarRestos) {
      try { await recolectarRestos(); } catch { /* que falle la poda no impide descartar */ }
    }

    registro.cambiarEstado(id, 'descartado');
    informar(`Lote ${id} descartado.`);
    return { descartado: true, borrados, saltados };
  } finally {
    liberar(lock);
  }
}

module.exports = { ESTADOS_DESCARTABLES, DIR_WORKTREES, descartarLote, borrarRestosDelLote, tomarRepo };
