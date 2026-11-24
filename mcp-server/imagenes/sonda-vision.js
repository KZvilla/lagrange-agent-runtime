'use strict';

/**
 * FEAT-210 — La sonda de visión de OpenCode Go (`deepseek-v4.1-flash`).
 *
 * La visión del modelo no está verificada en el código: antes de mandarle los
 * bytes de una imagen, una sonda corta le muestra un cuadrado de 64 × 64 de un
 * color sólido y la respuesta tiene que nombrar el color. Va aparte de la tabla
 * de Go: no toca `PERFILES`, `estadoPerfil`, `correrAhora` ni `MODELOS_GO`.
 *
 * Guarda en el almacén común (`sondas.js`) con el motor `opencode-go` y el
 * perfil `vision`, y su testigo es propio (`opencode-go-vision`): no frena las
 * sondas de lectura y edición ni lo frenan ellas. Corre en segundo plano la
 * primera vez que hace falta; mientras no hay resultado, cada consumidor usa su
 * respaldo de texto.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const zlib = require('node:zlib');
const sondas = require('../motores/sondas.js');
const { MODELO_OPENCODE_GO } = require('../motores/niveles.js');

const MOTOR = 'opencode-go';
const PERFIL = 'vision';
const TESTIGO = 'opencode-go-vision';
const VERSION_MODULO = 1;
// Un rojo puro: lo nombra cualquier modelo que vea, y no lo adivina uno que no (la consigna no da pistas).
const COLOR = Object.freeze({ nombre: 'rojo', rgb: [220, 20, 20], acepta: /\b(rojo|roja|red|carmes[ií]|escarlata|crimson|scarlet)\b/i });
const PROMPT = 'What is the single solid color that fills this image? Answer with just the color name.';

function versionLagrange() {
  try { return require('../../package.json').version || null; } catch { return null; }
}

const HASH = crypto.createHash('sha256').update(JSON.stringify({ PROMPT, COLOR: COLOR.rgb, VERSION_MODULO })).digest('hex').slice(0, 16);

function huella(modelo = MODELO_OPENCODE_GO, { version = versionLagrange } = {}) {
  const v = version();
  return v ? { versionLagrange: v, modelo, sonda: HASH } : null;
}

/** Un PNG de `lado` × `lado` de un color sólido, sin dependencias. */
function pngSolido(lado, [r, g, b]) {
  const crc = (buf) => {
    let c = ~0;
    for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (~c) >>> 0;
  };
  const trozo = (tipo, datos) => {
    const largo = Buffer.alloc(4); largo.writeUInt32BE(datos.length);
    const td = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([largo, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0); ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const fila = Buffer.alloc(1 + lado * 3);
  for (let i = 0; i < lado; i++) { fila[1 + i * 3] = r; fila[2 + i * 3] = g; fila[3 + i * 3] = b; }
  const crudo = Buffer.concat(Array.from({ length: lado }, () => fila));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr), trozo('IDAT', zlib.deflateSync(crudo)), trozo('IEND', Buffer.alloc(0))
  ]);
}

/** `{ ok, motivo }`: ¿hay una sonda de visión vigente que pasó? */
function vigente({ homeDir = os.homedir(), modelo = MODELO_OPENCODE_GO, version = versionLagrange } = {}) {
  const v = sondas.vigencia(MOTOR, PERFIL, huella(modelo, { version }), homeDir);
  return { ok: v.ok, motivo: v.motivo, hay: Boolean(v.entrada) };
}

/**
 * Corre la sonda una vez (si no la corre otro proceso) y guarda el resultado.
 * `llamar(partes)` es `vision.llamarCrudo`: se inyecta para no cargar `vision.js` acá.
 */
async function correrVision({ llamar, homeDir = os.homedir(), modelo = MODELO_OPENCODE_GO, version = versionLagrange, log = () => {} } = {}) {
  if (!sondas.tomarTestigo(TESTIGO, { homeDir })) return { ocupado: true };
  try {
    const juego = [{
      id: 'V1',
      correr: async () => {
        const r = await llamar({ texto: PROMPT, imagen: { bytes: pngSolido(64, COLOR.rgb), mime: 'image/png' } });
        // Sin key, sin red o sin cupo no se midió la visión: inconclusa, sin reintento (como una sonda sin cuota).
        if (!r || !r.ok) return { resultado: 'inconclusa', causa: 'cuota', motivo: (r && r.motivo) || 'no respondió' };
        return COLOR.acepta.test(r.texto || '')
          ? { resultado: 'pasa', motivo: null }
          : { resultado: 'falla', motivo: `no nombró el color (dijo «${String(r.texto || '').slice(0, 40)}»)` };
      }
    }];
    const entrada = await sondas.correrJuego({ sondas: juego, huella: huella(modelo, { version }) });
    sondas.guardarResultado(MOTOR, PERFIL, entrada, homeDir);
    log(`[sondas] ${MOTOR}/${PERFIL}: ${entrada.resultado}${entrada.motivo ? ` (${entrada.motivo})` : ''}`);
    return { ocupado: false, entrada };
  } finally {
    sondas.soltarTestigo(TESTIGO, homeDir);
  }
}

module.exports = { MOTOR, PERFIL, TESTIGO, COLOR, PROMPT, HASH, huella, pngSolido, vigente, correrVision };
