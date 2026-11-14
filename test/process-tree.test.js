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

  await group('respaldo con child.kill solo si falla /T /F en Windows', async () => {
    let killSoloGracia = 0;
    const hijoGracia = { pid: 101, exitCode: null, signalCode: null, kill: () => { killSoloGracia += 1; } };
    terminateTree(hijoGracia, 20, {
      plataforma: 'win32',
      ejecutar: (_b, args, cb) => {
        if (!args.includes('/F')) cb?.(new Error('falla amable'));
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('si falla solo /T, respeta la gracia y no llama child.kill antes', killSoloGracia === 0);

    let killForzado = 0;
    const hijoFuerza = { pid: 102, exitCode: null, signalCode: null, kill: () => { killForzado += 1; } };
    terminateTree(hijoFuerza, 5, {
      plataforma: 'win32',
      ejecutar: (_b, args, cb) => { cb?.(new Error(args.includes('/F') ? 'sin permiso' : 'falla amable')); }
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    check('si falla /T /F y el hijo sigue vivo, recurre a child.kill', killForzado === 1);

    let sinCrash = true;
    const stubSinKill = { pid: 103, exitCode: null, signalCode: null };
    try {
      terminateTree(stubSinKill, 5, {
        plataforma: 'win32',
        ejecutar: (_b, _args, cb) => { cb?.(new Error('sin permiso')); }
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
    } catch { sinCrash = false; }
    check('si el stub no define kill, no lanza', sinCrash);

    let onForceLlamado = 0;
    const hijoForce = { pid: 104, exitCode: null, signalCode: null, kill: () => {} };
    terminateTree(hijoForce, 5, {
      plataforma: 'win32',
      ejecutar: (_b, _args, cb) => { cb?.(); },
      onForce: () => { onForceLlamado += 1; }
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    check('onForce se invoca al llegar a la fase forzada', onForceLlamado === 1);
  });

  report();
})().catch((err) => { console.error(err); process.exitCode = 1; });
