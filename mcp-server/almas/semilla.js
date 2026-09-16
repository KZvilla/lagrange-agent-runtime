/**
 * FEAT-041 — La primera versión de `alma.md`, sembrada desde un perfil de
 * Voicebox.
 *
 * Desde que existe, manda el archivo: lo edita el usuario y un cambio posterior
 * en Voicebox no lo pisa. Re-sembrar con `forzar` guarda antes una copia en
 * `alma.md.anterior`, porque un forzar por error no puede borrar sin retorno lo
 * que el usuario escribió a mano.
 *
 * La búsqueda del perfil es directa y sin fallback, a propósito: sembrar el
 * alma de otra voz es peor que no sembrar. Por eso no se usa
 * `resolveVoiceProfile` (index.js), que cae a una voz por idioma o a la
 * primera de la lista.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { claveDeVoz, rutasDe } = require('./rutas.js');
const { conLock, escribirAtomico, leerTexto } = require('./archivos.js');

const IDIOMAS = { es: 'español', en: 'inglés' };

// Lo que entra de `alma.md` en el contexto de una llamada (fase 1 en
// adelante). Vive acá porque este módulo es el dueño del archivo, y `ver` avisa
// si el alma se pasa.
const MAX_ALMA = 2000;

/**
 * El perfil cuyo nombre es la voz pedida. Primero por clave exacta; si no hay,
 * por prefijo de segmento en cualquier sentido ("diego" ↔ "diego-alvarez"),
 * nunca por prefijo suelto ("ana" no es "anabel"). Con cero o más de un
 * candidato, `null`.
 */
function perfilPorNombre(perfiles, voz) {
  if (!Array.isArray(perfiles) || !perfiles.length) return null;
  const buscada = claveDeVoz(voz);
  if (!buscada) return null;

  const conClave = perfiles
    .filter(p => p && typeof p.name === 'string')
    .map(p => ({ p, clave: claveDeVoz(p.name) }))
    .filter(x => x.clave);

  const exactos = conClave.filter(x => x.clave === buscada);
  if (exactos.length === 1) return exactos[0].p;
  if (exactos.length > 1) return null;

  const porSegmento = conClave.filter(x =>
    x.clave.startsWith(`${buscada}-`) || buscada.startsWith(`${x.clave}-`)
  );
  return porSegmento.length === 1 ? porSegmento[0].p : null;
}

function campo(valor, respaldo) {
  const texto = typeof valor === 'string' ? valor.trim() : '';
  return texto || respaldo;
}

/** Los respaldos son los mismos que usa `getPersonaPrompt` (spoken-text.js). */
function textoSemilla(perfil, hoy = new Date().toISOString().slice(0, 10)) {
  const nombre = campo(perfil.name, 'Voz');
  const codigo = campo(perfil.language, 'es').toLowerCase().slice(0, 2);
  const idioma = IDIOMAS[codigo] || campo(perfil.language, 'español');
  return [
    `# ${nombre}`,
    '',
    `<!-- Semilla de Lagrange, generada el ${hoy} desde el perfil de Voicebox. Editala a gusto: desde ahora manda este archivo. -->`,
    '',
    '## Cómo sos',
    '',
    campo(perfil.personality, 'Natural and expressive'),
    '',
    '## Quién sos',
    '',
    campo(perfil.description, 'Voice Assistant'),
    '',
    '## Idioma',
    '',
    `Hablás en ${idioma}.`,
    ''
  ].join('\n');
}

/**
 * Escribe `alma.md` para `clave`. Sin `forzar`, un alma existente no se toca.
 * Devuelve `{creado, existia, ruta, respaldo}`.
 */
function sembrar(clave, perfil, opciones = {}) {
  if (!perfil || !campo(perfil.name, '')) throw new Error('El perfil no tiene nombre.');
  const rutas = rutasDe(clave, opciones.env || process.env);

  return conLock(rutas.alma, () => {
    const existia = fs.existsSync(rutas.alma);
    if (existia && !opciones.forzar) return { creado: false, existia, ruta: rutas.alma, respaldo: null };

    let respaldo = null;
    if (existia) {
      fs.copyFileSync(rutas.alma, rutas.anterior);
      respaldo = rutas.anterior;
    }
    escribirAtomico(rutas.alma, textoSemilla(perfil, opciones.hoy));
    return { creado: true, existia, ruta: rutas.alma, respaldo };
  });
}

/** `sha256` de `null`/ausente y de `''` caen en el mismo hash a propósito: lo que importa acá es "nada que preservar", no si el archivo existe. */
function hashTexto(texto) {
  return crypto.createHash('sha256').update(String(texto ?? ''), 'utf8').digest('hex');
}

/**
 * FEAT-050 §9.2 / FEAT-051 §6.4 — El estado de `alma.md` que una
 * previsualización lee para poder detectar, más tarde, si el destino cambió
 * antes de aplicar. `leerTexto` nunca confunde "no existe" con "no se pudo
 * leer": un error de lectura que no sea `ENOENT` se propaga.
 */
function estadoIdentidad(clave, env = process.env) {
  const rutas = rutasDe(clave, env);
  const existe = fs.existsSync(rutas.alma);
  const texto = existe ? leerTexto(rutas.alma) : null;
  return { existe, texto, hash: hashTexto(texto) };
}

/**
 * FEAT-050 §9.2 — Escribe `alma.md` como documento único versionado: no hay
 * una gramática de operaciones como en `recuerdos.js`, así que el precedente
 * es lock + precondición + backup, calcado de `sembrar(forzar)`.
 *
 * `estadoEsperadoHash` es el hash que una previsualización leyó del destino
 * (`estadoIdentidad().hash`). La comprobación corre DENTRO del lock, no antes:
 * es lo único que cierra la ventana entre "el usuario vio el preview" y
 * "confirmó aplicar". Sin ese argumento, la función no tiene con qué detectar
 * una carrera y escribe directo (uso interno, p. ej. import de alma nueva sin
 * paso de preview intermedio).
 *
 * Devuelve `{ resultado: 'escrito' | 'sin-cambios' | 'conflicto', ruta, respaldo }`.
 * `'conflicto'` nunca escribe ni toca `alma.md.anterior`.
 */
function escribirIdentidad(clave, textoNuevo, opciones = {}) {
  const env = opciones.env || process.env;
  const rutas = rutasDe(clave, env);

  return conLock(rutas.alma, () => {
    const existe = fs.existsSync(rutas.alma);
    const actual = existe ? leerTexto(rutas.alma) : null;

    if (opciones.estadoEsperadoHash !== undefined && hashTexto(actual) !== opciones.estadoEsperadoHash) {
      return { resultado: 'conflicto', motivo: 'el destino cambió desde la previsualización', ruta: rutas.alma };
    }
    if (actual === textoNuevo) {
      return { resultado: 'sin-cambios', ruta: rutas.alma };
    }

    let respaldo = null;
    if (existe) {
      fs.copyFileSync(rutas.alma, rutas.anterior);
      respaldo = rutas.anterior;
    }
    escribirAtomico(rutas.alma, textoNuevo);
    return { resultado: 'escrito', ruta: rutas.alma, respaldo };
  });
}

module.exports = { MAX_ALMA, perfilPorNombre, textoSemilla, sembrar, hashTexto, estadoIdentidad, escribirIdentidad };
