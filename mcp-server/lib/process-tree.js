const { execFile } = require('node:child_process');

/** Termina el proceso y sus hijos sin abrir una shell. */
function terminateTree(child, graceMs = 5000, { plataforma = process.platform, ejecutar = execFile, onForce } = {}) {
  if (!child) return null;
  if (plataforma === 'win32' && child.pid) {
    ejecutar('taskkill', ['/pid', String(child.pid), '/T'], () => {});
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        onForce?.();
        ejecutar('taskkill', ['/pid', String(child.pid), '/T', '/F'], (err) => {
          // Si taskkill falla (p. ej. sin permisos en sandbox AppContainer), al menos matamos el hijo directo.
          if (err && child.exitCode === null && child.signalCode === null && typeof child.kill === 'function') {
            try { child.kill(); } catch {}
          }
        });
      }
    }, graceMs);
    timer.unref?.();
    return timer;
  }

  try { child.kill('SIGTERM'); } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      onForce?.();
      try { child.kill('SIGKILL'); } catch {}
    }
  }, graceMs);
  timer.unref?.();
  return timer;
}

module.exports = { terminateTree };
