/**
 * FEAT-189 — `agy_image`: generación y edición de imágenes a través del
 * subagente built-in `image-generator` de agy.
 *
 * La sonda del 2026-11-10 confirmó el contrato real:
 *   - el agente principal invoca `invoke_subagent` con TypeName "image-generator";
 *   - el subagente llama `generate_image` con Prompt, ImageName, AspectRatio e
 *     ImagePaths;
 *   - el backend guarda un JPG 1K en el brain del agente principal, no en el cwd;
 *   - no hay comando, flag ni API directa para invocarlo.
 *
 * Este módulo se queda con lo que se puede probar sin lanzar agy: validación de
 * la solicitud, armado del prompt, parseo de la ruta, lectura de metadatos y
 * copia durable. El handler de index.js arma los argumentos de la CLI y llama a
 * `generarImagen` con `executeAgy` inyectado.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_IMAGE_PATHS = 14;

const ASPECTOS = Object.freeze([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
  '1:4', '4:1', '1:8', '8:1'
]);

const EXT_POR_FORMATO = Object.freeze({ jpeg: '.jpg', png: '.png', webp: '.webp' });
const FORMATOS = Object.freeze(['jpeg', 'png', 'webp']);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function esRutaAbsoluta(ruta) {
  return path.isAbsolute(ruta) || /^[A-Za-z]:[\\/]/.test(ruta) || /^\\\\[^\\]+\\/.test(ruta);
}

function aForwardSlashes(ruta) {
  return String(ruta).replace(/\\/g, '/');
}

function formatoDeImagen(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function dimensionesJpeg(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marcador = buf[i + 1];
    if (marcador === 0xd8 || marcador === 0xd9) { i += 2; continue; }
    if (marcador >= 0xd0 && marcador <= 0xd7) { i += 2; continue; }
    const largo = buf.readUInt16BE(i + 2);
    if (largo < 2) return null;
    // SOF0..SOF15, salvo DHT (C4), JPG (C8) y DAC (CC).
    if (marcador >= 0xc0 && marcador <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marcador)) {
      if (i + 8 >= buf.length) return null;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + largo;
  }
  return null;
}

function dimensionesWebp(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.slice(12, 16).toString('ascii');
  if (fourcc === 'VP8X') {
    return {
      width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
      height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
    };
  }
  if (fourcc === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8 ' && buf.length >= 30
    && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function dimensionesDeImagen(buf, formato) {
  if (formato === 'jpeg') return dimensionesJpeg(buf);
  if (formato === 'png' && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (formato === 'webp') return dimensionesWebp(buf);
  return null;
}

function leerImagen(ruta, { requerirDimensiones = false } = {}) {
  let st;
  try { st = fs.statSync(ruta); } catch (err) { return { ok: false, error: `No encontré la imagen ${ruta}: ${err.message}` }; }
  if (!st.isFile()) return { ok: false, error: `No es un archivo: ${ruta}` };
  if (st.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: `La imagen supera ${MAX_IMAGE_BYTES / 1048576} MB: ${ruta}` };
  }
  let buf;
  try { buf = fs.readFileSync(ruta); } catch (err) { return { ok: false, error: `No pude leer ${ruta}: ${err.message}` }; }
  const formato = formatoDeImagen(buf);
  if (!formato) return { ok: false, error: `No es una imagen JPEG, PNG o WebP: ${ruta}` };
  const dim = dimensionesDeImagen(buf, formato);
  // Para el artefacto que devuelve agy exigimos dimensiones verificables: un
  // JPEG truncado o un WebP (cuyas dimensiones no parseamos) no se copia.
  if (requerirDimensiones && (!dim || !(dim.width > 0) || !(dim.height > 0))) {
    return { ok: false, error: `No pude verificar las dimensiones de la imagen ${ruta}.` };
  }
  return { ok: true, formato, width: dim ? dim.width : null, height: dim ? dim.height : null, bytes: st.size };
}

function resolverRutasDeImagen(valores, baseDir) {
  if (valores === undefined || valores === null) return { ok: true, rutas: [] };
  if (!Array.isArray(valores)) return { ok: false, error: 'image_paths debe ser un array de rutas.' };
  if (valores.length > MAX_IMAGE_PATHS) {
    return { ok: false, error: `image_paths admite hasta ${MAX_IMAGE_PATHS} imágenes (recibí ${valores.length}).` };
  }
  const rutas = [];
  for (const valor of valores) {
    if (typeof valor !== 'string' || !valor.trim()) {
      return { ok: false, error: 'image_paths contiene una ruta vacía o que no es texto.' };
    }
    const pedida = valor.trim();
    const absoluta = esRutaAbsoluta(pedida) ? path.resolve(pedida) : path.resolve(baseDir, pedida);
    const info = leerImagen(absoluta);
    if (!info.ok) return { ok: false, error: info.error };
    rutas.push(aForwardSlashes(absoluta));
  }
  return { ok: true, rutas: [...new Set(rutas)] };
}

function slugDePrompt(prompt) {
  const limpio = String(prompt || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return limpio || 'imagen';
}

function timestamp(ahora = new Date()) {
  return ahora.toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
}

function nombrePorDefecto(prompt, ahora = new Date(), formato = 'jpeg') {
  return `${timestamp(ahora)}-${slugDePrompt(prompt)}${EXT_POR_FORMATO[formato] || '.jpg'}`;
}

function existeRuta(ruta) {
  try { fs.lstatSync(ruta); return true; } catch { return false; }
}

function esEnlaceSimbolico(ruta) {
  try { return fs.lstatSync(ruta).isSymbolicLink(); } catch { return false; }
}

function rutaLibre(destino, { overwrite = false } = {}) {
  if (overwrite) return destino;
  if (!existeRuta(destino)) return destino;
  const ext = path.extname(destino);
  const base = destino.slice(0, destino.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidato = `${base}-${n}${ext}`;
    if (!existeRuta(candidato)) return candidato;
  }
  throw new Error(`No encontré un nombre libre para ${destino}`);
}

/** El destino final no puede ser un enlace simbólico ni un archivo existente sin overwrite. */
function destinoSeguro(ruta, { overwrite = false } = {}) {
  let st = null;
  try { st = fs.lstatSync(ruta); } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, error: `No pude inspeccionar el destino ${ruta}: ${err.message}` };
  }
  if (st && st.isSymbolicLink()) {
    return { ok: false, error: `El destino es un enlace simbólico: ${ruta}. Elegí una ruta real.` };
  }
  if (st && !overwrite) {
    return { ok: false, error: `El archivo ya existe: ${ruta}. Pasá overwrite: true para reemplazarlo.` };
  }
  return { ok: true };
}

function resolverSalida(outputPath, { baseDir, homeDir, prompt, ahora = new Date(), overwrite = false } = {}) {
  if (outputPath !== undefined && outputPath !== null && typeof outputPath !== 'string') {
    return { ok: false, error: 'output_path debe ser un string.' };
  }
  const pedido = typeof outputPath === 'string' ? outputPath.trim() : '';
  if (!pedido) {
    const dir = path.join(homeDir || os.homedir(), '.claude', 'lagrange-images');
    if (esEnlaceSimbolico(dir)) {
      return { ok: false, error: `El directorio de salida es un enlace simbólico: ${dir}. Elegí otro output_path.` };
    }
    try {
      if (existeRuta(dir) && !fs.statSync(dir).isDirectory()) {
        return { ok: false, error: `El directorio de salida no es un directorio: ${dir}.` };
      }
    } catch (err) {
      return { ok: false, error: `No pude inspeccionar el directorio de salida ${dir}: ${err.message}` };
    }
    const destino = path.join(dir, nombrePorDefecto(prompt, ahora));
    return { ok: true, ruta: rutaLibre(destino, { overwrite }), auto: true };
  }

  const absoluta = esRutaAbsoluta(pedido) ? path.resolve(pedido) : path.resolve(baseDir || process.cwd(), pedido);
  let st = null;
  try { st = fs.lstatSync(absoluta); } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, error: `No pude inspeccionar output_path ${absoluta}: ${err.message}` };
  }
  if (st && st.isSymbolicLink()) {
    return { ok: false, error: `output_path es un enlace simbólico: ${absoluta}. Elegí una ruta real.` };
  }
  let esDirectorio = /[\\/]$/.test(pedido);
  if (st) esDirectorio = st.isDirectory();
  // Sin extensión = directorio, aunque todavía no exista. Un archivo existente
  // sin extensión no se interpreta como directorio: se rechaza.
  if (!esDirectorio && !path.extname(absoluta)) {
    if (st) {
      return { ok: false, error: `output_path no tiene extensión de imagen: ${absoluta}. Usá .jpg, .jpeg, o pasá un directorio.` };
    }
    esDirectorio = true;
  }

  if (esDirectorio) {
    const destino = path.join(absoluta, nombrePorDefecto(prompt, ahora));
    return { ok: true, ruta: rutaLibre(destino, { overwrite }), auto: true };
  }

  const ext = path.extname(absoluta).toLowerCase();
  // El backend de agy devuelve JPEG. Un .png/.webp explícito se rechaza antes
  // de gastar cuota; si una versión futura devuelve PNG, se puede omitir
  // output_path y la tool elige la extensión real del artefacto.
  if (!['.jpg', '.jpeg'].includes(ext)) {
    return { ok: false, error: `output_path tiene una extensión no soportada: ${ext || '(sin extensión)'}. agy devuelve JPEG: usá .jpg o .jpeg, o pasá un directorio.` };
  }
  if (st && !overwrite) {
    return { ok: false, error: `El archivo ya existe: ${absoluta}. Pasá overwrite: true para reemplazarlo.` };
  }
  return { ok: true, ruta: absoluta, auto: false };
}

function ajustarDestino(salida, formato, { overwrite = false } = {}) {
  const ext = EXT_POR_FORMATO[formato];
  if (!ext) return { ok: false, error: `Formato de imagen no soportado: ${formato}.` };
  const actual = path.extname(salida.ruta).toLowerCase();
  const compatible = actual === ext || (ext === '.jpg' && actual === '.jpeg');
  if (!salida.auto && !compatible) {
    return {
      ok: false,
      error: `agy devolvió ${formato.toUpperCase()} pero output_path termina en ${actual}. Usá ${ext} o omití output_path para que la tool elija la extensión.`
    };
  }
  let destino = salida.ruta;
  if (salida.auto && !compatible) {
    destino = destino.slice(0, destino.length - actual.length) + ext;
  }
  return { ok: true, ruta: rutaLibre(destino, { overwrite }) };
}

function prepararSolicitud(args = {}, { baseDir = process.cwd(), homeDir = os.homedir(), ahora = new Date() } = {}) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'prompt es obligatorio y no puede quedar vacío.' };
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    return { ok: false, error: `prompt supera ${MAX_PROMPT_BYTES / 1024} KB.` };
  }
  const aspectRatio = args.aspect_ratio === undefined || args.aspect_ratio === null ? '1:1' : String(args.aspect_ratio).trim();
  if (!ASPECTOS.includes(aspectRatio)) {
    return { ok: false, error: `aspect_ratio inválido: "${aspectRatio}". Valores: ${ASPECTOS.join(', ')}.` };
  }
  const imagenes = resolverRutasDeImagen(args.image_paths, baseDir);
  if (!imagenes.ok) return imagenes;
  const salida = resolverSalida(args.output_path, {
    baseDir, homeDir, prompt, ahora, overwrite: Boolean(args.overwrite)
  });
  if (!salida.ok) return salida;
  return {
    ok: true,
    prompt,
    imagePaths: imagenes.rutas,
    aspectRatio,
    output: salida,
    overwrite: Boolean(args.overwrite)
  };
}

function promptDeImagen(solicitud) {
  const lineas = [
    '[IMAGE GENERATION TASK]',
    'Delegate this task to the built-in `image-generator` subagent with `invoke_subagent` and TypeName "image-generator".',
    'Do NOT call `generate_image` yourself. Do NOT read files, run commands, search the web, fetch URLs, inspect tools or binaries, or create project files.',
    'Do not copy, convert or post-process the image: the image generator saves the JPG in the main agent artifact directory.',
    `Aspect ratio: ${solicitud.aspectRatio}.`,
    solicitud.imagePaths.length
      ? `Source/reference images (pass this exact array as ImagePaths, with forward slashes): ${JSON.stringify(solicitud.imagePaths)}`
      : 'No source images: text-to-image generation.',
    '',
    'Brief:',
    solicitud.prompt,
    '',
    'When the subagent finishes, return ONLY the absolute path of the final image, one line, no other text.'
  ];
  return lineas.join('\n');
}

/**
 * Extrae la última ruta absoluta de imagen que exista en el texto. La respuesta
 * de agy puede traer "Waiting for subagent notification." antes de la ruta, o
 * la ruta entre backticks; no se toma la respuesta entera como path.
 */
function extraerRutaDeImagen(texto) {
  if (typeof texto !== 'string' || !texto.trim()) return null;
  const candidatos = [];
  const limpiar = (s) => s.trim()
    .replace(/^[`"']+/, '')
    .replace(/[`"']+$/, '')
    .replace(/[.,;:)\]]+$/, '');
  for (const linea of texto.split(/\r?\n/)) {
    const limpia = limpiar(linea);
    if (!limpia) continue;
    if (esRutaAbsoluta(limpia) && /\.(?:jpe?g|png|webp)$/i.test(limpia)) candidatos.push(limpia);
  }
  // Por si la ruta viene embebida en una frase.
  const re = /(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'`<>|]+?\.(?:jpe?g|png|webp)|\/[^\r\n"'`<>|]+?\.(?:jpe?g|png|webp)/gi;
  for (const m of texto.matchAll(re)) candidatos.push(limpiar(m[0]));

  let ultima = null;
  for (const candidato of [...new Set(candidatos)]) {
    try {
      if (fs.statSync(candidato).isFile()) ultima = candidato;
    } catch {}
  }
  return ultima;
}

function textoDeResultado(result) {
  const data = (result && result.data) || {};
  return data.response || (result && result.rawOutput) || '';
}

/**
 * Corre agy y copia el artefacto. `ejecutar` se inyecta para que los tests no
 * lancen el binario real.
 */
async function generarImagen({
  solicitud, promptFinal, baseArgs = [], timeoutMinutes = 10, ejecutar,
  ahora = new Date(), signal = null
} = {}) {
  if (!solicitud || !solicitud.ok) return { ok: false, error: 'solicitud inválida' };
  if (typeof ejecutar !== 'function') return { ok: false, error: 'falta la función ejecutar' };

  let cwd;
  try { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-image-')); } catch (err) {
    return { ok: false, error: `No pude crear el directorio temporal: ${err.message}` };
  }

  try {
    const args = [...baseArgs, '-p', promptFinal];
    const result = await ejecutar(args, { cwd, timeoutMinutes, signal });
    const data = (result && result.data) || {};
    const conversationId = data.conversation_id || null;
    const durationSeconds = data.duration_seconds || 0;
    const usage = data.usage || null;
    const respuesta = textoDeResultado(result);

    if (!result || !result.success) {
      return {
        ok: false,
        error: (result && result.error) || 'agy no pudo generar la imagen',
        result, conversationId, durationSeconds, usage, response: respuesta, cwd
      };
    }

    const sourcePath = extraerRutaDeImagen(respuesta);
    if (!sourcePath) {
      return {
        ok: false,
        error: 'agy terminó pero no devolvió una ruta absoluta de imagen. El agente principal pudo no haber delegado en image-generator o el subagente pudo haber fallado.',
        result, conversationId, durationSeconds, usage, response: respuesta, cwd
      };
    }

    const info = leerImagen(sourcePath, { requerirDimensiones: true });
    if (!info.ok) {
      return {
        ok: false,
        error: info.error,
        result, conversationId, durationSeconds, usage, response: respuesta, cwd, sourcePath
      };
    }

    const destino = ajustarDestino(solicitud.output, info.formato, { overwrite: solicitud.overwrite });
    if (!destino.ok) {
      return {
        ok: false,
        error: destino.error,
        result, conversationId, durationSeconds, usage, response: respuesta, cwd, sourcePath
      };
    }

    const seguro = destinoSeguro(destino.ruta, { overwrite: solicitud.overwrite });
    if (!seguro.ok) {
      return {
        ok: false,
        error: seguro.error,
        result, conversationId, durationSeconds, usage, response: respuesta, cwd, sourcePath
      };
    }

    try {
      fs.mkdirSync(path.dirname(destino.ruta), { recursive: true });
      fs.copyFileSync(sourcePath, destino.ruta, solicitud.overwrite ? 0 : fs.constants.COPYFILE_EXCL);
    } catch (err) {
      const motivo = err && err.code === 'EEXIST'
        ? `El archivo ya existe: ${destino.ruta}. Pasá overwrite: true para reemplazarlo.`
        : `No pude copiar la imagen a ${destino.ruta}: ${err.message}`;
      return {
        ok: false,
        error: motivo,
        result, conversationId, durationSeconds, usage, response: respuesta, cwd, sourcePath
      };
    }

    let bytes = info.bytes;
    try { bytes = fs.statSync(destino.ruta).size; } catch {}

    return {
      ok: true,
      path: destino.ruta,
      sourcePath,
      format: info.formato,
      width: info.width,
      height: info.height,
      bytes,
      conversationId,
      durationSeconds,
      usage,
      response: respuesta,
      result,
      cwd,
      now: ahora instanceof Date ? ahora : new Date()
    };
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  ASPECTOS,
  FORMATOS,
  MAX_IMAGE_BYTES,
  MAX_PROMPT_BYTES,
  MAX_IMAGE_PATHS,
  prepararSolicitud,
  promptDeImagen,
  generarImagen,
  extraerRutaDeImagen,
  formatoDeImagen,
  dimensionesDeImagen,
  leerImagen,
  resolverSalida,
  resolverRutasDeImagen,
  destinoSeguro,
  nombrePorDefecto,
  slugDePrompt
};
