const { check, group, report } = require('./lib/assert.js');
const { terminateTree } = require('../mcp-server/lib/process-tree.js');

(async () => {
  await group('terminación del árbol en Windows', async () => {
    const llamadas = [];
    const child = { pid: 4321, exitCode: null, signalCode: null };
    terminateTree(child, 5, {
      plataforma: 'win32',
      ejecutar: (bin, args, cb) => { llamadas.push({ bin, args }); cb?.(); }
    });
    check('primero pide taskkill /T sin shell ni fuerza',
      llamadas.length === 1 && llamadas[0].bin === 'taskkill'
      && llamadas[0].args.join(' ') === '/pid 4321 /T');
    await new Promise((resolve) => setTimeout(resolve, 15));
    check('si el proceso sigue vivo agrega /F después de la gracia',
      llamadas.length === 2 && llamadas[1].args.join(' ') === '/pid 4321 /T /F');
  });

  await group('terminación del árbol en POSIX', async () => {
    const senales = [];
    const child = { exitCode: null, signalCode: null, kill: (senal) => senales.push(senal) };
    terminateTree(child, 5, { plataforma: 'linux' });
    check('envía SIGTERM primero', senales.join(',') === 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 15));
    check('si sigue vivo escala a SIGKILL', senales.join(',') === 'SIGTERM,SIGKILL');
  });

  await group('un hijo ya terminado no se fuerza', async () => {
    const llamadas = [];
    const child = { pid: 99, exitCode: 0, signalCode: null };
    terminateTree(child, 5, { plataforma: 'win32', ejecutar: (_b, args, cb) => { llamadas.push(args); cb?.(); } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    check('conserva solo el intento amable', llamadas.length === 1 && !llamadas[0].includes('/F'));
  });

  report();
})().catch((err) => { console.error(err); process.exitCode = 1; });
