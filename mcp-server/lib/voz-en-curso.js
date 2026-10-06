/**
 * FEAT-119 + FEAT-120 — Avisarle al mod qué está sonando en la PC.
 *
 * Justo antes de reproducir, el MCP escribe `buzones/voz-<claudePid>.json` con
 * la voz, el texto y cuánto dura el audio; al terminar lo borra (solo si sigue
 * siendo suyo). El mod de esa sesión lo encuentra con `buzon.js mod-voz` (el
 * mismo padre) y lo usa para el spinner y los subtítulos. No depende del
 * daemon ni del alta del buzón.
 */
const fs = require('node:fs');
const buzones = require('./buzones.js');

// Si la cabecera no se puede leer: un ritmo de habla corriente.
const CARACTERES_POR_SEGUNDO = 15;
// Lo que el aviso sigue valiendo después del fin estimado, por si el reproductor tarda en arrancar.
const HOLGURA_MS = 2000;

/**
 * Escribe el aviso para el Claude Code `claudePid`. Devuelve la marca para
 * borrarlo después, o `null` si no se escribió (el audio suena igual).
 */
function escribirVoz({ dataDir = buzones.dataDirPath(), claudePid, voz, texto, wav = null, ahora = Date.now(), pid = process.pid, duracionWav = require('../omnivoice.js').duracionWav }) {
  if (!Number.isInteger(claudePid) || claudePid <= 1 || !texto) return null;
  const segundos = wav ? duracionWav(wav) : null;
  const duracionMs = Number.isFinite(segundos) && segundos > 0
    ? Math.round(segundos * 1000)
    : Math.max(1000, Math.round((String(texto).length / CARACTERES_POR_SEGUNDO) * 1000));
  const ruta = buzones.rutaVoz(dataDir, claudePid);
  const datos = { voz: String(voz || ''), texto: String(texto), desde: ahora, duracionMs, hasta: ahora + duracionMs + HOLGURA_MS, pid };
  try {
    fs.mkdirSync(buzones.dirBuzones(dataDir), { recursive: true, mode: 0o700 });
    buzones.escribirAtomico(ruta, JSON.stringify(datos));
    return { ruta, desde: ahora, pid };
  } catch {
    return null;
  }
}

/** Borra el aviso solo si sigue siendo el que escribió esta marca (otra narración pudo pisarlo). */
function borrarVoz(marca) {
  if (!marca) return;
  try {
    const actual = JSON.parse(fs.readFileSync(marca.ruta, 'utf8'));
    if (actual && actual.desde === marca.desde && actual.pid === marca.pid) fs.unlinkSync(marca.ruta);
  } catch {}
}

module.exports = { escribirVoz, borrarVoz, CARACTERES_POR_SEGUNDO, HOLGURA_MS };
