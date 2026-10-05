/**
 * FEAT-129 §5 — Búsqueda léxica, pura. `node:sqlite` de Node 22.15 no trae
 * FTS5 (medido), y el contenido está en castellano: se pliegan tildes y
 * mayúsculas, y una palabra de 6 letras o más también cuenta por su prefijo de
 * 5 (`configuración` ↔ `configuró`), que es lo que cubren las conjugaciones.
 *
 * Puntaje = tokens de la consulta encontrados; el título cuenta doble.
 * Desempate por `revised.at ?? generated.at`. Sin índice: con cientos de
 * archivos se recorre en milisegundos.
 */
'use strict';

const LIMITE_MAX = 10;
const MIN_PREFIJO = 6;
const PREFIJO = 5;
const EXTRACTO = 200;

function plegar(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function tokens(texto) {
  return [...new Set(plegar(texto).split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
}

/** Si el token de la consulta es una de las palabras (o comparte el prefijo, si es largo). */
function aparece(token, palabras) {
  if (palabras.includes(token)) return true;
  if (token.length < MIN_PREFIJO) return false;
  const pre = token.slice(0, PREFIJO);
  return palabras.some((p) => p.startsWith(pre));
}

function fechaDe(datos) {
  const r = datos && datos.revised && datos.revised.at;
  const g = datos && datos.generated && datos.generated.at;
  return String(r || g || '');
}

function extracto(cuerpo, consulta) {
  const plano = String(cuerpo || '').replace(/\s+/g, ' ').trim();
  const plegado = plegar(plano);
  let i = -1;
  for (const t of consulta) {
    i = plegado.indexOf(t);
    if (i < 0 && t.length >= MIN_PREFIJO) i = plegado.indexOf(t.slice(0, PREFIJO));
    if (i >= 0) break;
  }
  const desde = Math.max(0, i - 60);
  const trozo = plano.slice(desde, desde + EXTRACTO);
  return `${desde > 0 ? '…' : ''}${trozo}${desde + EXTRACTO < plano.length ? '…' : ''}`;
}

/**
 * `conceptos`: `[{ ruta, datos, cuerpo }]`. Devuelve
 * `[{ ruta, tipo, titulo, descripcion, extracto, puntaje, coincide }]`. BE-106 — El tipo
 * de la nota también se busca (peso 1), y `coincide` dice qué tokens encontraron algo.
 */
function buscar(conceptos, { q, tipo, tags, limite = LIMITE_MAX } = {}) {
  const consulta = tokens(q);
  if (!consulta.length) throw new Error('`q` no puede estar vacía.');
  const tope = Math.max(1, Math.min(LIMITE_MAX, Number.isFinite(limite) ? Math.floor(limite) : LIMITE_MAX));
  const tagsPedidos = Array.isArray(tags) ? tags.map(plegar) : [];

  const resultados = [];
  for (const c of conceptos || []) {
    const d = c.datos || {};
    if (tipo && d.type !== tipo) continue;
    const susTags = Array.isArray(d.tags) ? d.tags.map(plegar) : [];
    if (tagsPedidos.length && !tagsPedidos.every((t) => susTags.includes(t))) continue;

    const palabrasTitulo = tokens(d.title);
    const palabrasResto = tokens([d.type, d.description, susTags.join(' '), c.cuerpo].join(' '));
    let puntaje = 0;
    const coincide = [];
    for (const t of consulta) {
      if (aparece(t, palabrasTitulo)) { puntaje += 2; coincide.push(t); }
      else if (aparece(t, palabrasResto)) { puntaje += 1; coincide.push(t); }
    }
    if (!puntaje) continue;
    resultados.push({
      ruta: c.ruta, tipo: d.type, titulo: d.title || null, descripcion: d.description || null,
      extracto: extracto(c.cuerpo, consulta), puntaje, coincide, fecha: fechaDe(d)
    });
  }
  resultados.sort((a, b) => b.puntaje - a.puntaje || b.fecha.localeCompare(a.fecha));
  return resultados.slice(0, tope).map(({ fecha, ...r }) => r);
}

module.exports = { buscar, plegar, tokens, LIMITE_MAX };
