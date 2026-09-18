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
 */
const fs = require('node:fs');
const path = require('node:path');

const ESTADOS_DESCARTABLES = ['para revisar', 'fallido', 'interrumpido'];
const DIR_WORKTREES = path.join('.claude', 'worktrees');

/**
 * @param {object} deps
 * @param {object} deps.registro    El de registro.js.
 * @param {string} deps.id
 * @param {Function} deps.git       (repo, args, opciones) => string|null
 * @param {Function} deps.confirmar async () => string — lo que el humano escribió.
 * @param {Function} [deps.recolectarRestos] async () => void
 * @param {Function} [deps.informar] (linea) => void
 */
async function descartarLote({ registro, id, git, confirmar, recolectarRestos, informar = () => {} }) {
  const lote = registro.leer(id);
  if (!lote) throw new Error(`no hay ningún lote con id ${id}`);
  if (!ESTADOS_DESCARTABLES.includes(lote.estado)) {
    throw new Error(`el lote ${id} está en estado "${lote.estado}": solo se descartan lotes terminados`);
  }

  informar(`Lote ${id} (${lote.estado}), repo ${lote.repo}`);
  informar('Se van a borrar estos worktrees y ramas:');
  for (const t of lote.tareas) informar(`  - ${t.rama || '(sin rama)'}  ${t.worktree || ''}`);
  informar('Esto borra el trabajo del lote. No se puede deshacer.');

  const respuesta = String(await confirmar()).trim();
  if (respuesta !== id) {
    informar('No coincide. No se borró nada.');
    return { descartado: false, borrados: [], saltados: [] };
  }

  const prefijoRama = `wt/agy-${id}-`;
  const borrados = [];
  const saltados = [];

  for (const t of lote.tareas) {
    if (t.worktree) {
      const relativo = path.relative(lote.repo, t.worktree);
      const dentro = !relativo.startsWith('..') && !path.isAbsolute(relativo) && relativo.startsWith(DIR_WORKTREES);
      if (!dentro) {
        saltados.push({ que: t.worktree, motivo: `no está bajo ${DIR_WORKTREES}` });
        informar(`  saltado (worktree fuera de ${DIR_WORKTREES}): ${t.worktree}`);
      } else {
        git(lote.repo, ['worktree', 'unlock', t.worktree], { permitirFallo: true });
        git(lote.repo, ['worktree', 'remove', t.worktree, '--force'], { permitirFallo: true });
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
      if (!t.rama.startsWith(prefijoRama)) {
        saltados.push({ que: t.rama, motivo: 'la rama no es de este lote' });
        informar(`  saltado (la rama no es de este lote): ${t.rama}`);
      } else {
        const salida = git(lote.repo, ['branch', '-D', t.rama], { permitirFallo: true });
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

  git(lote.repo, ['worktree', 'prune'], { permitirFallo: true });
  if (recolectarRestos) {
    try { await recolectarRestos(); } catch { /* que falle la poda no impide descartar */ }
  }

  registro.cambiarEstado(id, 'descartado');
  informar(`Lote ${id} descartado.`);
  return { descartado: true, borrados, saltados };
}

module.exports = { ESTADOS_DESCARTABLES, DIR_WORKTREES, descartarLote };
