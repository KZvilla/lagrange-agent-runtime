/**
 * FEAT-061 fase 2 - El recolector de restos.
 *
 * La invariante que justifica el modulo entero: poda infraestructura de Docker
 * y copias en disco, y NUNCA toca worktrees, ramas ni llama a git. El trabajo
 * del agente vive en una rama; un recolector que pueda borrar ramas es un
 * recolector que puede borrar lo que el humano todavia no reviso.
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recolectar, parsearFilas } = require('../mcp-server/lotes/recolector.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-recolector-'));

group('recolector', () => {
  check('parsea las filas de docker', parsearFilas('c1\tlote1\t100\nc2\tlote2\t0\n').length === 2);

  const llamadas = [];
  const docker = async (args, opciones) => {
    llamadas.push(args.join(' '));
    if (args[0] === 'ps') return { code: 0, stdout: 'lote-viejo-1\tviejo\t100\nlote-vivo-1\tvivo\t0\n', stderr: '' };
    if (args[0] === 'network') return { code: 0, stdout: 'lote-viejo-1-red\tviejo\t100\n', stderr: '' };
    if (args[0] === 'volume') return { code: 0, stdout: 'lote-viejo-token\tviejo\t100\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  const raizCopias = path.join(dir, 'copias');
  fs.mkdirSync(path.join(raizCopias, 'viejo'), { recursive: true });
  fs.mkdirSync(path.join(raizCopias, 'vivo'), { recursive: true });

  return recolectar({ docker, lotesCorriendo: ['vivo'], raizCopias, ahora: () => 1000 }).then(podados => {
    check('poda el contenedor del lote que no corre', podados.contenedores.includes('lote-viejo-1'));
    check('NO toca el contenedor del lote vivo', !podados.contenedores.includes('lote-vivo-1'));
    check('poda su red', podados.redes.includes('lote-viejo-1-red'));
    check('poda su volumen de token', podados.volumenes.includes('lote-viejo-token'));
    check('borra la copia en disco del lote viejo', !fs.existsSync(path.join(raizCopias, 'viejo')));
    check('deja la copia del lote vivo', fs.existsSync(path.join(raizCopias, 'vivo')));
    check('nunca llama a git', !llamadas.some(l => /git|worktree|branch/.test(l)), llamadas.join(' | '));
    check('borra contenedores antes que redes', llamadas.findIndex(l => l.startsWith('rm -f')) < llamadas.findIndex(l => l.startsWith('network rm')));
  });
}).then(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  report();
});
