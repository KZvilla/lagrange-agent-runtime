/**
 * FEAT-166 — El hilo de un alma que corre en un motor sin estado (deepseek).
 *
 * agy y Claude guardan el hilo del lado del proveedor y `estado.json` solo
 * guarda su id. La API de DeepSeek no guarda nada: el historial es nuestro.
 *
 *   <dir del alma>/hilos/<uuid>.jsonl
 *   línea 1: { v: 1, creado, prompt_tokens }   (cabecera)
 *   después: { role: 'user'|'assistant', content } por línea
 *
 * **El archivo es la fuente de verdad.** Si no existe, no parsea o pasó el tope,
 * el hilo no está vigente y el próximo turno nace con la foto de memoria: el
 * orden entre `registrarTurno` y la escritura deja de importar y no hay amnesia
 * posible (un id registrado sin archivo nace de nuevo).
 *
 * Lo que se guarda del `assistant` es la respuesta ya sin `<alma>` ni
 * `<tablero>` y saneada como el resto de lo que escribe el modelo: las
 * operaciones de memoria no se reinyectan. Nada borra los hilos: tampoco
 * "hilo nuevo" (`olvidarHilo`), que es un comando de todos los días.
 */

const fs = require('node:fs');
const path = require('node:path');
const rutas = require('./rutas.js');
const { conLock, escribirAtomico } = require('./archivos.js');
const { sanearParaInyeccion } = require('./escaneo.js');

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Pasado este prompt, el próximo turno nace con la foto (en vez de compactar). */
const TOPE_HILO_TOKENS = 64000;

/** La ruta del hilo, o `null` si el id no es un UUID (nunca toca el disco con un id raro). */
function rutaHilo(clave, id, env = process.env) {
  if (typeof id !== 'string' || !RE_UUID.test(id)) return null;
  return path.join(rutas.rutasDe(clave, env).dir, 'hilos', `${id}.jsonl`);
}

/** `{ cabecera, mensajes }`, o `null` si falta, está truncado o algo no parsea. Nunca lanza. */
function leerHilo(clave, id, env = process.env) {
  let ruta;
  try { ruta = rutaHilo(clave, id, env); } catch { return null; }
  if (!ruta) return null;
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); } catch { return null; }
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return null;
  try {
    const cabecera = JSON.parse(lineas[0]);
    if (!cabecera || cabecera.v !== 1) return null;
    const mensajes = lineas.slice(1).map((l) => JSON.parse(l));
    const forma = mensajes.every((m, i) => m && m.role === (i % 2 === 0 ? 'user' : 'assistant') && typeof m.content === 'string');
    return forma ? { cabecera, mensajes } : null;
  } catch {
    return null;
  }
}

/** ¿Se puede retomar este hilo? `false` sin id, con id inválido, sin archivo, truncado o pasado el tope. */
function hiloVigente(clave, id, env = process.env) {
  const h = leerHilo(clave, id, env);
  return Boolean(h && !(Number(h.cabecera.prompt_tokens) > TOPE_HILO_TOKENS));
}

/**
 * Agrega un turno (`user` y `assistant` juntos, así alternan siempre) y anota
 * el `prompt_tokens` real de la respuesta. Crea el archivo si no existe o no
 * era válido. Bajo el lock del archivo: dos turnos del mismo alma no se pisan.
 * Lanza si el id es inválido o el lock no se consigue; quien llama decide.
 */
function agregarTurno({ clave, hilo, user, assistant, promptTokens = null }, env = process.env) {
  const ruta = rutaHilo(clave, hilo, env);
  if (!ruta) throw new Error(`hilo local inválido: "${hilo}"`);
  conLock(ruta, () => {
    const previo = leerHilo(clave, hilo, env);
    const cabecera = {
      v: 1,
      creado: (previo && previo.cabecera.creado) || new Date().toISOString(),
      prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : ((previo && previo.cabecera.prompt_tokens) || 0)
    };
    const mensajes = [
      ...(previo ? previo.mensajes : []),
      { role: 'user', content: String(user || '') },
      { role: 'assistant', content: sanearParaInyeccion(String(assistant || '')) }
    ];
    escribirAtomico(ruta, `${[cabecera, ...mensajes].map((x) => JSON.stringify(x)).join('\n')}\n`);
  });
}

module.exports = { RE_UUID, TOPE_HILO_TOKENS, rutaHilo, leerHilo, hiloVigente, agregarTurno };
