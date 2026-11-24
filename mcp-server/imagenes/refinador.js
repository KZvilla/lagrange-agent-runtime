'use strict';

/**
 * FEAT-210 §2 — El refinador: el modelo que escribe el prompt técnico de una imagen.
 *
 * Una llamada aislada (`vision.llamar` en modo `refinar`): no sabe nada del
 * alma. Recibe el pedido del alma, el mensaje del usuario y, si el turno trae
 * una foto, sus bytes; si la visión no está verificada o falla con la foto, la
 * descripción que vio el alma. Devuelve `{ prompt, negativo, proporcion }`,
 * saneado campo por campo. Si no hay refinador o su salida no parsea, el prompt
 * es el texto del alma tal cual, en `1:1`.
 */

const { limpiarSalida } = require('../almas/mediador.js');
const visionReal = require('./vision.js');

const PROPORCIONES = Object.freeze(['1:1', '3:4', '4:3', '16:9', '9:16']);
const MAX_NEGATIVO = 300;
const NEGATIVO_GENERICO = 'blurry, low quality, distorted, deformed, watermark, text artifacts';

/** Saca los cercos de código (```json … ```) y parsea. `null` si no es un objeto. */
function parsearSalida(texto) {
  let t = String(texto || '').trim();
  const cerco = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (cerco) t = cerco[1].trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    const o = JSON.parse(t.slice(i, j + 1));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/** Cada campo, saneado: `prompt` hasta el `tope`, `negativo` hasta 300, `proporcion` contra la lista. */
function sanear(o, tope) {
  const prompt = limpiarSalida(typeof o.prompt === 'string' ? o.prompt : '').texto.slice(0, tope);
  const negativo = limpiarSalida(typeof o.negativo === 'string' ? o.negativo : '').texto.slice(0, MAX_NEGATIVO);
  const proporcion = PROPORCIONES.includes(o.proporcion) ? o.proporcion : '1:1';
  return prompt ? { prompt, negativo: negativo || NEGATIVO_GENERICO, proporcion } : null;
}

/** Sin refinador: el texto del alma tal cual. `motivo`, por qué (al log de la cola). */
function sinRefinar(pedido, tope, motivo = null) {
  return { prompt: limpiarSalida(pedido).texto.slice(0, tope), negativo: NEGATIVO_GENERICO, proporcion: '1:1', refinado: false, ...(motivo ? { motivo } : {}) };
}

/**
 * `refinar({ pedido, mensaje, foto, tope, signal, … })` → `{ prompt, negativo, proporcion, refinado, conFoto, uso }`.
 * `foto = { ruta, descripcion: { ok, texto } }`. Nunca lanza; un cancelado devuelve `{ cancelado: true }`.
 */
async function refinar({ pedido, mensaje = '', foto = null, tope = 300, signal, vision = visionReal, homeDir, leer, ejecutar, fetchImpl, registrarUso = () => {}, clave = null, origen = 'usuario' }) {
  const base = [`Pedido del asistente: ${String(pedido || '').slice(0, 300)}`, `Mensaje del usuario: ${String(mensaje || '').slice(0, 1000)}`, `El prompt tiene que entrar en ${tope} caracteres.`];
  const intentos = [];
  let motivo = null;
  if (foto && foto.ruta) intentos.push({ partes: { texto: [...base, 'Usá la foto adjunta como referencia.'].join('\n'), imagen: { ruta: foto.ruta } }, conFoto: true });
  const descripcion = foto && foto.descripcion && foto.descripcion.ok ? foto.descripcion.texto : null;
  intentos.push({ partes: { texto: [...base, ...(descripcion ? [`Descripción de la foto de referencia (hecha por otro modelo): ${descripcion}`] : [])].join('\n') }, conFoto: false });
  for (const intento of intentos) {
    const inicio = Date.now();
    let r;
    try {
      r = await vision.llamar({ partes: intento.partes, modo: 'refinar', signal, homeDir, leer, ejecutar, fetchImpl });
    } catch (err) {
      r = { ok: false, motivo: err.message };
    }
    if (r.cancelado || (signal && signal.aborted)) return { cancelado: true };
    if (!r.ok) { motivo = r.motivo || 'el refinador no respondió'; continue; } // sin visión o falló con la foto: se prueba con la descripción
    try {
      registrarUso({ tool: 'refinador_imagen', motor: 'opencode-go', rol: clave ? `alma:${clave}` : 'imagen', modelo: r.modelo || null, modeloReal: r.modelo || null, esfuerzo: null, conversationId: null, duracion: (Date.now() - inicio) / 1000, usage: r.uso || null, error: null, costoUsd: null, origen, cuota: null });
    } catch {}
    const o = parsearSalida(r.texto);
    const limpio = o && sanear(o, tope);
    if (limpio) return { ...limpio, refinado: true, conFoto: intento.conFoto };
    motivo = 'el refinador respondió algo que no es el JSON pedido';
    break; // respondió pero no parsea: el texto del alma
  }
  return sinRefinar(pedido, tope, motivo);
}

module.exports = { PROPORCIONES, NEGATIVO_GENERICO, parsearSalida, sanear, sinRefinar, refinar };
