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

// F4b — Un mutex de recuperación más viejo que esto es de un proceso que murió recuperando.
const MUTEX_VIEJO_MS = 30000;
// Un lock recién creado puede estar vacío un instante (entre el open y el write): no es huérfano.
const LOCK_ESCRIBIENDOSE_MS = 5000;

function reservado(actual) {
  return new Error(`el repositorio ya está reservado por el lote ${actual.id || '(desconocido)'}`);
}

/**
 * F4b — Recupera un lock huérfano sin carrera. Antes, dos procesos que lo encontraban a la vez
 * podían borrarlo los dos, y el segundo borraba el lock nuevo del primero (con la espera humana,
 * el daemon y el MCP reanudan lotes del mismo repo). Solo quien crea el mutex `<lock>.recuperando`
 * (mkdir es atómico) relee el lock y lo borra, y únicamente si sigue siendo el mismo que vio
 * (mismo token) con el dueño muerto. Devuelve true si vale reintentar el open.
 */
function recuperarHuerfano(archivo, visto, { fsImpl, estaVivo, ahora }) {
  const mutex = `${archivo}.recuperando`;
  try { fsImpl.mkdirSync(mutex); } catch (err) {
    if (err.code !== 'EEXIST') throw new Error(`no se pudo recuperar el bloqueo huérfano: ${err.message}`);
    try { if (ahora() - fsImpl.statSync(mutex).mtimeMs > MUTEX_VIEJO_MS) fsImpl.rmdirSync(mutex); } catch {}
    return false;
  }
  try {
    let actual = null;
    try { actual = JSON.parse(fsImpl.readFileSync(archivo, 'utf8')); } catch (err) {
      if (err.code === 'ENOENT') return true;
      try { if (ahora() - fsImpl.statSync(archivo).mtimeMs < LOCK_ESCRIBIENDOSE_MS) return false; } catch { return true; }
    }
    if (actual && estaVivo(Number(actual.pid))) throw reservado(actual);
    if (actual && visto && actual.token !== visto.token) return false;
    try { fsImpl.unlinkSync(archivo); } catch (borrar) {
      if (borrar.code !== 'ENOENT') throw new Error(`no se pudo recuperar el bloqueo huérfano: ${borrar.message}`);
    }
    return true;
  } finally {
    try { fsImpl.rmdirSync(mutex); } catch {}
  }
}

function adquirirBloqueo(repo, idLote, { fsImpl = fs, pid = process.pid, estaVivo = pidVivo, ahora = Date.now } = {}) {
  const archivo = rutaBloqueo(repo);
  fsImpl.mkdirSync(path.dirname(archivo), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const contenido = JSON.stringify({ id: idLote, pid, token, creado: new Date().toISOString() });

  for (let intento = 0; intento < 3; intento++) {
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
      if (actual && estaVivo(Number(actual.pid))) throw reservado(actual);
      recuperarHuerfano(archivo, actual, { fsImpl, estaVivo, ahora });
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
