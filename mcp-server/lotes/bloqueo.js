const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function rutaBloqueo(repo) {
  return path.join(path.resolve(repo), '.claude', 'worktrees', '.lagrange-lote.lock');
}

function adquirirBloqueo(repo, idLote, { fsImpl = fs, pid = process.pid, estaVivo = pidVivo } = {}) {
  const archivo = rutaBloqueo(repo);
  fsImpl.mkdirSync(path.dirname(archivo), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const contenido = JSON.stringify({ id: idLote, pid, token, creado: new Date().toISOString() });

  for (let intento = 0; intento < 2; intento++) {
    let fd;
    try {
      fd = fsImpl.openSync(archivo, 'wx');
      fsImpl.writeFileSync(fd, contenido, 'utf8');
      fsImpl.closeSync(fd);
      return { archivo, token, id: idLote, pid, liberado: false };
    } catch (err) {
      if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch {} }
      if (err.code !== 'EEXIST') throw new Error(`no se pudo bloquear el repositorio: ${err.message}`);
      let actual = null;
      try { actual = JSON.parse(fsImpl.readFileSync(archivo, 'utf8')); } catch {}
      if (actual && estaVivo(Number(actual.pid))) {
        throw new Error(`el repositorio ya está reservado por el lote ${actual.id || '(desconocido)'}`);
      }
      try { fsImpl.unlinkSync(archivo); } catch (borrar) {
        if (borrar.code !== 'ENOENT') throw new Error(`no se pudo recuperar el bloqueo huérfano: ${borrar.message}`);
      }
    }
  }
  throw new Error('no se pudo adquirir el bloqueo del repositorio');
}

function liberarBloqueo(bloqueo, { fsImpl = fs } = {}) {
  if (!bloqueo || bloqueo.liberado) return false;
  try {
    const actual = JSON.parse(fsImpl.readFileSync(bloqueo.archivo, 'utf8'));
    if (actual.token !== bloqueo.token) return false;
    fsImpl.unlinkSync(bloqueo.archivo);
    bloqueo.liberado = true;
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') { bloqueo.liberado = true; return true; }
    return false;
  }
}

module.exports = { pidVivo, rutaBloqueo, adquirirBloqueo, liberarBloqueo };
