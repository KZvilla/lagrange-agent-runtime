/**
 * FEAT-108 — Integrar un lote.
 *
 * Lo que se prueba es sobre todo lo que NO tiene que pasar: integrar con una
 * prueba roja o una auditoría con reservas, mergear un commit que nadie auditó,
 * dejar la rama base a medio mergear ante un conflicto o pisar cambios del
 * usuario. Repos git de verdad, como los arma worktrees.js.
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { crearRegistro } = require('../mcp-server/lotes/registro.js');
const { evaluarIntegrable, integrarLote } = require('../mcp-server/lotes/integrar.js');
const { descartarLote } = require('../mcp-server/lotes/descartar.js');
const { adquirirBloqueo, liberarBloqueo } = require('../mcp-server/lotes/bloqueo.js');

const raizTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-integrar-'));

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitOk(repo, args) {
  try { git(repo, args); return true; } catch { return false; }
}
function escribir(dir, archivo, texto) {
  fs.mkdirSync(path.dirname(path.join(dir, archivo)), { recursive: true });
  fs.writeFileSync(path.join(dir, archivo), texto);
}

/**
 * Repo en la rama `trabajo` con un worktree por tarea; cada tarea escribe sus
 * archivos y commitea, como el ejecutor del lote.
 */
function repoConLote(nombre, slug, cambios) {
  const repo = path.join(raizTmp, nombre);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'trabajo']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  escribir(repo, 'base.txt', 'uno\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'inicial']);
  const tareas = cambios.map((archivos, i) => {
    const n = i + 1;
    const ruta = path.join(repo, '.claude', 'worktrees', `agy-${slug}-${n}`);
    const rama = `wt/agy-${slug}-${n}`;
    git(repo, ['worktree', 'add', '-q', '-b', rama, ruta, 'trabajo']);
    if (!archivos) return { id: `t${n}`, rama, worktree: ruta, commit: null, sinCambios: true };
    for (const [archivo, texto] of Object.entries(archivos)) escribir(ruta, archivo, texto);
    git(ruta, ['add', '-A']);
    git(ruta, ['commit', '-q', '-m', `tarea ${n}`]);
    return { id: `t${n}`, rama, worktree: ruta, commit: git(ruta, ['rev-parse', 'HEAD']), sinCambios: false };
  });
  git(repo, ['branch', 'feat/ajena']);
  return { repo, tareas };
}

const PASA = { prueba: { estado: 'paso', exitCode: 0 }, auditoria: { estado: 'completa', veredicto: 'PASS' } };

function registroCon(dirNombre, { id, repo, tareas, estado = 'para revisar', porTarea = {} }) {
  const registro = crearRegistro({ dir: path.join(raizTmp, dirNombre) });
  registro.crear({ id, repo, ramaBase: 'trabajo', tareas });
  for (const t of tareas) {
    registro.actualizarTarea(id, t.id, {
      rama: t.rama, worktree: t.worktree, commit: t.commit, sinCambios: t.sinCambios,
      estado: t.commit ? 'para revisar' : 'escrita',
      ...(t.commit ? PASA : { prueba: { estado: 'omitida' }, auditoria: { estado: 'omitida' } }),
      ...(porTarea[t.id] || {})
    });
  }
  if (estado === 'para revisar') {
    for (const e of ['verificando', 'auditando', 'para revisar']) registro.cambiarEstado(id, e);
  } else if (estado) registro.cambiarEstado(id, estado);
  return registro;
}

function loteSimple(over = {}) {
  return {
    estado: 'para revisar',
    tareas: [{ id: 'a', commit: 'abc1234', estado: 'para revisar', ...PASA }, { id: 'b', commit: 'def5678', estado: 'para revisar', ...PASA }],
    ...over
  };
}

async function main() {
  await group('V1 — la puerta', async () => {
    check('PASS + prueba verde → integrable', evaluarIntegrable(loteSimple()).ok);
    const conTarea = (cambio) => loteSimple({ tareas: [{ id: 'a', commit: 'abc1234', estado: 'para revisar', ...PASA, ...cambio }] });
    const pwr = evaluarIntegrable(conTarea({ auditoria: { estado: 'completa', veredicto: 'PASS WITH RESERVATIONS' } }));
    check('PASS WITH RESERVATIONS → no', !pwr.ok && /a: auditoría PASS WITH RESERVATIONS/.test(pwr.motivos.join()));
    check('FAIL → no', !evaluarIntegrable(conTarea({ auditoria: { estado: 'completa', veredicto: 'FAIL' } })).ok);
    check('auditoría con error → no', !evaluarIntegrable(conTarea({ auditoria: { estado: 'error', veredicto: null } })).ok);
    const roja = evaluarIntegrable(conTarea({ prueba: { estado: 'fallo', exitCode: 1 } }));
    check('prueba roja → no, con el exit', !roja.ok && /a: prueba fallo \(exit 1\)/.test(roja.motivos.join()));
    check('prueba no configurada → no', !evaluarIntegrable(conTarea({ prueba: { estado: 'no configurada' } })).ok);
    check('tarea fallida sin commit → no', !evaluarIntegrable(loteSimple({ tareas: [...loteSimple().tareas, { id: 'c', commit: null, estado: 'fallida', error: 'x' }] })).ok);
    check('estado ≠ para revisar → no', !evaluarIntegrable(loteSimple({ estado: 'fallido' })).ok);
    check('cero commits → no', !evaluarIntegrable(loteSimple({ tareas: [{ id: 'a', commit: null, sinCambios: true, estado: 'escrita' }] })).ok);
    const sin = evaluarIntegrable(loteSimple({ tareas: [...loteSimple().tareas, { id: 'c', commit: null, sinCambios: true, estado: 'escrita' }] }));
    check('una tarea sin cambios se saltea', sin.ok && sin.tareas.length === 2);
  });

  await group('V2 — integra lo auditado y limpia solo lo del lote', async () => {
    const { repo, tareas } = repoConLote('repo2', 'i2', [{ 'a.txt': 'A\n' }, { 'b.txt': 'B\n' }, null]);
    const registro = registroCon('estado2', { id: 'i2', repo, tareas });
    const antes = git(repo, ['rev-parse', 'trabajo']);
    let podó = false;
    const r = await integrarLote({ registro, id: 'i2', confirmar: async () => 'i2', recolectarRestos: async () => { podó = true; } });
    check('devuelve integrado', r.integrado === true && r.antes === antes);
    const log = git(repo, ['log', '--format=%H %P', '--first-parent', `${antes}..trabajo`]).split('\n').reverse();
    check('dos merges, uno por tarea con commit', log.length === 2);
    check('el segundo padre de cada merge es el SHA auditado', log[0].split(' ')[2] === tareas[0].commit && log[1].split(' ')[2] === tareas[1].commit);
    check('el working tree del checkout avanzó', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'A\n' && fs.existsSync(path.join(repo, 'b.txt')));
    const lote = registro.leer('i2');
    check('estado integrado con su registro', lote.estado === 'integrado' && lote.integracion.despues === git(repo, ['rev-parse', 'trabajo']) && lote.integracion.merges.length === 2);
    check('ramas del lote borradas', tareas.every((t) => !gitOk(repo, ['rev-parse', '--verify', `refs/heads/${t.rama}`])));
    check('worktrees del lote borrados', tareas.every((t) => !fs.existsSync(t.worktree)));
    check('la rama ajena sigue', gitOk(repo, ['rev-parse', '--verify', 'refs/heads/feat/ajena']));
    check('recolectó restos', podó);
    let error = '';
    try { await descartarLote({ registro, id: 'i2', git: (rp, a) => git(rp, a), confirmar: async () => 'i2' }); } catch (err) { error = err.message; }
    check('un lote integrado no se descarta', /integrado/.test(error));
    check('el lock quedó libre', (() => { const l = adquirirBloqueo(repo, 'otro'); liberarBloqueo(l); return true; })());
  });

  await group('V3 — un conflicto no escribe nada', async () => {
    const { repo, tareas } = repoConLote('repo3', 'i3', [{ 'base.txt': 'de A\n' }, { 'base.txt': 'de B\n' }]);
    const registro = registroCon('estado3', { id: 'i3', repo, tareas });
    const antes = git(repo, ['rev-parse', 'trabajo']);
    let error = null;
    try { await integrarLote({ registro, id: 'i3', confirmar: async () => 'i3' }); } catch (err) { error = err; }
    check('falla con el archivo en conflicto (sin el OID del árbol)', error && /base\.txt/.test(error.message) && error.conflicto.length === 1 && error.conflicto[0] === 'base.txt');
    check('la rama base no se movió', git(repo, ['rev-parse', 'trabajo']) === antes);
    check('el working tree no cambió', fs.readFileSync(path.join(repo, 'base.txt'), 'utf8') === 'uno\n' && git(repo, ['status', '--porcelain', '--untracked-files=no']) === '');
    check('el lote sigue para revisar', registro.leer('i3').estado === 'para revisar');
    check('las ramas siguen', tareas.every((t) => gitOk(repo, ['rev-parse', '--verify', `refs/heads/${t.rama}`])));
  });

  await group('V4 — rama movida, checkout sucio, main, base sin checkout', async () => {
    {
      const { repo, tareas } = repoConLote('repo4a', 'i4a', [{ 'a.txt': 'A\n' }]);
      const registro = registroCon('estado4a', { id: 'i4a', repo, tareas });
      escribir(tareas[0].worktree, 'extra.txt', 'sin auditar\n');
      git(tareas[0].worktree, ['add', '-A']);
      git(tareas[0].worktree, ['commit', '-q', '-m', 'después']);
      let error = '';
      try { await integrarLote({ registro, id: 'i4a', confirmar: async () => 'i4a' }); } catch (err) { error = err.message; }
      check('rama con commits después de auditar → rechazo', /cambió después de auditarse/.test(error));
    }
    {
      const { repo, tareas } = repoConLote('repo4b', 'i4b', [{ 'a.txt': 'A\n' }]);
      const registro = registroCon('estado4b', { id: 'i4b', repo, tareas });
      const antes = git(repo, ['rev-parse', 'trabajo']);
      escribir(repo, 'base.txt', 'tocado a mano\n');
      let error = '';
      try { await integrarLote({ registro, id: 'i4b', confirmar: async () => 'i4b' }); } catch (err) { error = err.message; }
      check('checkout con cambios sin commitear → rechazo', /cambios sin commitear/.test(error));
      check('y no tocó ni la rama ni el archivo', git(repo, ['rev-parse', 'trabajo']) === antes && fs.readFileSync(path.join(repo, 'base.txt'), 'utf8') === 'tocado a mano\n');
    }
    {
      const { repo, tareas } = repoConLote('repo4c', 'i4c', [{ 'a.txt': 'A\n' }]);
      const registro = registroCon('estado4c', { id: 'i4c', repo, tareas });
      registro.guardar({ ...registro.leer('i4c'), ramaBase: 'main' });
      let error = '';
      try { await integrarLote({ registro, id: 'i4c', confirmar: async () => 'i4c' }); } catch (err) { error = err.message; }
      check('rama base main → rechazo', /no admite integraciones/.test(error));
    }
    {
      const { repo, tareas } = repoConLote('repo4d', 'i4d', [{ 'a.txt': 'A\n' }]);
      git(repo, ['checkout', '-q', '-b', 'otra']);
      const registro = registroCon('estado4d', { id: 'i4d', repo, tareas });
      const r = await integrarLote({ registro, id: 'i4d', confirmar: async () => 'i4d' });
      check('base sin checkout → avanza por update-ref', r.integrado && git(repo, ['rev-parse', 'trabajo']) === r.despues);
      check('sin tocar el checkout de otra rama', !fs.existsSync(path.join(repo, 'a.txt')) && git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'otra');
    }
    {
      const { repo, tareas } = repoConLote('repo4e', 'i4e', [{ 'a.txt': 'A\n' }]);
      git(repo, ['checkout', '-q', '-b', 'otra']);
      const registro = registroCon('estado4e', { id: 'i4e', repo, tareas });
      const antes = git(repo, ['rev-parse', 'trabajo']);
      let movida = '';
      // La base se mueve justo antes de la única escritura: el compare-and-swap la frena.
      const gitQueMueve = (r, args) => {
        if (args[0] === 'update-ref') {
          movida = git(repo, ['commit-tree', `${antes}^{tree}`, '-p', antes, '-m', 'otro']);
          git(repo, ['update-ref', 'refs/heads/trabajo', movida]);
        }
        const x = require('node:child_process').spawnSync('git', ['-C', r, ...args], { encoding: 'utf8', windowsHide: true });
        return { code: x.status, stdout: x.stdout || '', stderr: x.stderr || '' };
      };
      let error = '';
      try { await integrarLote({ registro, id: 'i4e', confirmar: async () => 'i4e', git: gitQueMueve }); } catch (err) { error = err.message; }
      check('base movida durante la integración → rechazo', /cambió mientras se integraba/.test(error) && git(repo, ['rev-parse', 'trabajo']) === movida);
      check('y el lote sigue para revisar', registro.leer('i4e').estado === 'para revisar');
    }
  });

  await group('V5 — lock y confirmación', async () => {
    const { repo, tareas } = repoConLote('repo5', 'i5', [{ 'a.txt': 'A\n' }]);
    const registro = registroCon('estado5', { id: 'i5', repo, tareas });
    const antes = git(repo, ['rev-parse', 'trabajo']);
    const r = await integrarLote({ registro, id: 'i5', confirmar: async () => 'otro' });
    check('confirmación que no coincide → nada', r.integrado === false && git(repo, ['rev-parse', 'trabajo']) === antes);
    const ajeno = adquirirBloqueo(repo, 'otro-lote');
    let error = '';
    try { await integrarLote({ registro, id: 'i5', confirmar: async () => 'i5' }); } catch (err) { error = err.message; }
    check('lock tomado por otro lote → rechazo', /reservado por el lote otro-lote/.test(error) && git(repo, ['rev-parse', 'trabajo']) === antes);
    let errorDescarte = '';
    try { await descartarLote({ registro, id: 'i5', git: (rp, a) => git(rp, a), confirmar: async () => 'i5' }); } catch (err) { errorDescarte = err.message; }
    check('descartar también espera el lock', /reservado por el lote otro-lote/.test(errorDescarte) && registro.leer('i5').estado === 'para revisar');
    liberarBloqueo(ajeno);
  });

  await group('registro — un id integrado se puede reusar y se aparta con su estado', async () => {
    const registro = crearRegistro({ dir: path.join(raizTmp, 'estado6') });
    registro.crear({ id: 'r1', repo: raizTmp, ramaBase: 'x', tareas: [] });
    for (const e of ['verificando', 'auditando', 'para revisar', 'integrado']) registro.cambiarEstado('r1', e);
    registro.crear({ id: 'r1', repo: raizTmp, ramaBase: 'x', tareas: [] });
    const apartados = fs.readdirSync(registro.carpeta).filter((f) => f.startsWith('r1-integrado-'));
    check('apartado como r1-integrado-<fecha>', apartados.length === 1);
    let error = '';
    try { registro.cambiarEstado('r1', 'integrado'); } catch (err) { error = err.message; }
    check('solo se integra desde para revisar', /transición inválida/.test(error));
  });
}

main()
  .catch((err) => { check(`sin excepción: ${err.stack}`, false); })
  .finally(() => {
    try { fs.rmSync(raizTmp, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    report();
  });
