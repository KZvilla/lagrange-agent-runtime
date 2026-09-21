const { execFile } = require('node:child_process');

/** Termina el proceso y sus hijos sin abrir una shell. */
function terminateTree(child, graceMs = 5000, { plataforma = process.platform, ejecutar = execFile } = {}) {
  if (!child) return null;
  if (plataforma === 'win32' && child.pid) {
    ejecutar('taskkill', ['/pid', String(child.pid), '/T'], () => {});
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        ejecutar('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      }
    }, graceMs);
    timer.unref?.();
    return timer;
  }

  try { child.kill('SIGTERM'); } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, graceMs);
  timer.unref?.();
  return timer;
}

module.exports = { terminateTree };
