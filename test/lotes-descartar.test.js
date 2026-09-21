/**
 * FEAT-061 fase 2 — Descartar un lote.
 *
 * Es lo único de la feature que destruye trabajo, así que lo que se prueba acá
 * es sobre todo lo que NO tiene que borrar: una rama que no es del lote, un
 * worktree fuera de `.claude/worktrees/`, y todo lo demás cuando la
 * confirmación no coincide.
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { crearRegistro } = require('../mcp-server/lotes/registro.js');
const { descartarLote } = require('../mcp-server/lotes/descartar.js');

const raizTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-descartar-'));

function git(repo, args, { permitirFallo = false } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  } catch (err) {
    if (permitirFallo) return null;
    throw err;
  }
}

/**
 * Repo con dos worktrees de lote de verdad, hechos como los hace worktrees.js:
 * ramas `wt/agy-<slug>-<n>` en `.claude/worktrees/agy-<slug>-<n>`.
 */
function repoConLote(slug, nombre) {
  const repo = path.join(raizTmp, nombre);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'trabajo']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uno\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'inicial']);

  const tareas = [1, 2].map(n => {
    const ruta = path.join(repo, '.claude', 'worktrees', `agy-${slug}-${n}`);
    const rama = `wt/agy-${slug}-${n}`;
    git(repo, ['worktree', 'add', '-q', '-b', rama, ruta, 'trabajo']);
    return { id: `t${n}`, rama, worktree: ruta };
  });

  // Una rama ajena, que el lote NO tiene que tocar aunque alguien la meta en
  // su registro.
  git(repo, ['branch', 'feat/importante']);
  return { repo, tareas };
}

function registroCon(dirNombre, { id, repo, tareas, estado }) {
  const dir = path.join(raizTmp, dirNombre);
  const registro = crearRegistro({ dir });
  registro.crear({ id, repo, ramaBase: 'trabajo', tareas });
  for (const t of tareas) registro.actualizarTarea(id, t.id, { rama: t.rama, worktree: t.worktree, estado: 'para revisar' });
  if (estado === 'para revisar') {
    registro.cambiarEstado(id, 'verificando');
    registro.cambiarEstado(id, 'auditando');
    registro.cambiarEstado(id, 'para revisar');
  } else if (estado) registro.cambiarEstado(id, estado);
  return registro;
}

async function main() {
  await group('descarta lo del lote, y nada más', async () => {
    const { repo, tareas } = repoConLote('p1', 'repo1');
    const registro = registroCon('estado1', { id: 'p1', repo, tareas, estado: 'para revisar' });

    let podó = false;
    const r = await descartarLote({
      registro, id: 'p1', git,
      confirmar: async () => 'p1',
      recolectarRestos: async () => { podó = true; }
    });

    check('devuelve descartado', r.descartado === true);
    check('borra los dos worktrees', !fs.existsSync(tareas[0].worktree) && !fs.existsSync(tareas[1].worktree));
    const ramas = git(repo, ['branch', '--format=%(refname:short)']);
    check('borra las dos ramas del lote', !ramas.includes('wt/agy-p1-1') && !ramas.includes('wt/agy-p1-2'));
    check('NO toca la rama ajena', ramas.includes('feat/importante'));
    check('NO toca la rama base', ramas.includes('trabajo'));
    check('el lote queda descartado en el registro', registro.leer('p1').estado === 'descartado');
    check('poda los restos de Docker', podó);
  });

  await group('sin confirmación no borra nada', async () => {
    const { repo, tareas } = repoConLote('p2', 'repo2');
    const registro = registroCon('estado2', { id: 'p2', repo, tareas, estado: 'para revisar' });

    const r = await descartarLote({ registro, id: 'p2', git, confirmar: async () => 'si' });

    check('no descarta', r.descartado === false);
    check('los worktrees siguen', fs.existsSync(tareas[0].worktree) && fs.existsSync(tareas[1].worktree));
    check('las ramas siguen', git(repo, ['branch', '--format=%(refname:short)']).includes('wt/agy-p2-1'));
    check('el lote sigue para revisar', registro.leer('p2').estado === 'para revisar');
  });

  await group('se niega a lo que no es del lote', async () => {
    const { repo, tareas } = repoConLote('p3', 'repo3');
    // Un registro manipulado: una rama ajena y un worktree fuera de sitio.
    const ajeno = path.join(raizTmp, 'worktree-ajeno');
    fs.mkdirSync(ajeno, { recursive: true });
    fs.writeFileSync(path.join(ajeno, 'no-borrar.txt'), 'importante\n');

    const registro = registroCon('estado3', {
      id: 'p3',
      repo,
      tareas: [
        { id: 't1', rama: 'feat/importante', worktree: ajeno },
        tareas[1]
      ],
      estado: 'para revisar'
    });

    const r = await descartarLote({ registro, id: 'p3', git, confirmar: async () => 'p3' });

    check('no borra la rama ajena', git(repo, ['branch', '--format=%(refname:short)']).includes('feat/importante'));
    check('no borra el worktree fuera de .claude/worktrees', fs.existsSync(path.join(ajeno, 'no-borrar.txt')));
    check('informa los dos saltos', r.saltados.length === 2, JSON.stringify(r.saltados));
    check('sí borra lo que sí es del lote', !fs.existsSync(tareas[1].worktree));
  });

  await group('estados en los que no se descarta', async () => {
    const { repo, tareas } = repoConLote('p4', 'repo4');
    const registro = registroCon('estado4', { id: 'p4', repo, tareas });  // queda corriendo

    let error = null;
    try {
      await descartarLote({ registro, id: 'p4', git, confirmar: async () => 'p4' });
    } catch (err) { error = err; }

    check('un lote corriendo no se descarta', !!error && /corriendo/.test(error.message));
    check('y sus worktrees siguen', fs.existsSync(tareas[0].worktree));

    let sinLote = null;
    try {
      await descartarLote({ registro, id: 'noexiste', git, confirmar: async () => 'noexiste' });
    } catch (err) { sinLote = err; }
    check('un id inexistente da error claro', !!sinLote && /no hay ningún lote/.test(sinLote.message));
  });

  // Los worktrees quedan registrados en el repo, así que se limpian antes de
  // borrar el directorio temporal.
  for (const nombre of ['repo1', 'repo2', 'repo3', 'repo4']) {
    const repo = path.join(raizTmp, nombre);
    git(repo, ['worktree', 'prune'], { permitirFallo: true });
  }
  try { fs.rmSync(raizTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}

  report();
}

main();
