/**
 * FEAT-119 + FEAT-120 — Avisarle al mod qué está sonando en la PC.
 *
 * Justo antes de reproducir, el MCP escribe `buzones/<sesion>.voz` con la voz,
 * el texto y cuánto dura el audio; al terminar lo borra (solo si sigue siendo
 * suyo). El mod lo lee mientras dura un `say`/`narrate` con `local_playback`
 * para el spinner y los subtítulos (`hooks/voz-texto.ts`). Sin sesión de
 * Claude Code (Codex, manual) no se escribe nada: no hay mod que lo lea.
 */
const fs = require('node:fs');
const buzones = require('./buzones.js');

// Si la cabecera no se puede leer: un ritmo de habla corriente.
const CARACTERES_POR_SEGUNDO = 15;
// Lo que el `.voz` sigue valiendo después del fin estimado, por si el reproductor tarda en arrancar.
const HOLGURA_MS = 2000;

/** Duración de un WAV PCM por su cabecera (`byteRate` del chunk fmt y tamaño del chunk data); `null` si no se puede. */
function duracionWav(ruta) {
  let fd;
  try {
    fd = fs.openSync(ruta, 'r');
    const cab = Buffer.alloc(4096);
    const leidos = fs.readSync(fd, cab, 0, cab.length, 0);
    if (leidos < 12 || cab.toString('ascii', 0, 4) !== 'RIFF' || cab.toString('ascii', 8, 12) !== 'WAVE') return null;
    let byteRate = 0;
    for (let o = 12; o + 8 <= leidos;) {
      const id = cab.toString('ascii', o, o + 4);
      const tam = cab.readUInt32LE(o + 4);
      if (id === 'fmt ' && o + 16 <= leidos) byteRate = cab.readUInt32LE(o + 16);
      if (id === 'data') {
        if (!byteRate) return null;
        // Un tamaño de data inválido (0 o 0xFFFFFFFF en streams) se toma del archivo.
        const resto = fs.fstatSync(fd).size - (o + 8);
        const datos = tam > 0 && tam !== 0xffffffff ? Math.min(tam, resto) : resto;
        return datos > 0 ? Math.round((datos / byteRate) * 1000) : null;
      }
      o += 8 + tam + (tam % 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Escribe el `.voz` de la sesión. Devuelve la marca para borrarlo después, o
 * `null` si no se escribió (sesión inválida, error de disco: el audio suena igual).
 */
function escribirVoz({ dataDir = buzones.dataDirPath(), sesion, voz, texto, wav = null, ahora = Date.now(), pid = process.pid }) {
  if (!buzones.sesionValida(sesion) || !texto) return null;
  const duracionMs = (wav && duracionWav(wav)) || Math.max(1000, Math.round((String(texto).length / CARACTERES_POR_SEGUNDO) * 1000));
  const datos = { voz: String(voz || ''), texto: String(texto), desde: ahora, duracionMs, hasta: ahora + duracionMs + HOLGURA_MS, pid };
  try {
    buzones.escribirAtomico(buzones.rutas(dataDir, sesion).voz, JSON.stringify(datos));
    return { sesion, desde: ahora, pid };
  } catch {
    return null;
  }
}

/** Borra el `.voz` solo si sigue siendo el que escribió esta marca (otra narración pudo pisarlo). */
function borrarVoz({ dataDir = buzones.dataDirPath(), marca }) {
  if (!marca) return;
  try {
    const ruta = buzones.rutas(dataDir, marca.sesion).voz;
    const actual = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (actual && actual.desde === marca.desde && actual.pid === marca.pid) fs.unlinkSync(ruta);
  } catch {}
}

module.exports = { duracionWav, escribirVoz, borrarVoz, CARACTERES_POR_SEGUNDO, HOLGURA_MS };
