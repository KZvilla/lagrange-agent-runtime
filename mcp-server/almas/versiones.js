'use strict';

/**
 * FEAT-215 (parte B) — Cuál imagen es cuál: cómo se nombra cada una ante el alma, y qué dice el usuario cuando elige entre
 * varias versiones. Sin estado: los datos vienen del índice (`indice.candidatas`, `vistasPendientes`).
 */

const { normalizar } = require('./pide-imagen.js');
const { sanearParaInyeccion } = require('./escaneo.js');

const ENTERO = (v) => (Number.isInteger(v) && v > 0 ? v : null);
/** «#7», «#7 y #8», «#7, #8 y #9». */
const lista = (nums) => {
  const t = nums.map((n) => `#${n}`);
  return t.length < 2 ? t.join('') : `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}`;
};

/** «Imagen #8 · otra versión de la #7 (…) · partió de la #5», o «Tu imagen» si es de antes de que tuvieran número. */
function rotulo(v) {
  const num = ENTERO(v.num);
  // FEAT-214 — Una del taller no es suya: la hizo el usuario a mano.
  if (v.origen === 'taller') return num ? `Imagen #${num} · la hizo el usuario en el taller` : 'Una imagen que el usuario hizo en el taller';
  const partes = [num ? `Imagen #${num}, tuya` : 'Tu imagen'];
  const de = ENTERO(v.deNum);
  if (v.origen === 'version') partes.push(`otra versión${de ? ` de la #${de}` : ''} (mismo pedido, otra semilla): la pidió el usuario por su cuenta`);
  else if (v.origen === 'variante') partes.push(`una variación${de ? ` de la #${de}` : ''}: la pidió el usuario por su cuenta`);
  const base = ENTERO(v.baseNum);
  if (base && base !== de) partes.push(`partió de la #${base}`);
  return partes.join(' · ');
}

const promptDe = (v) => sanearParaInyeccion(String(v.prompt || '')).replace(/\s+/g, ' ').trim().slice(0, 300);

/** Lo que antecede a las vistas de un turno si algunas son del mismo pedido, o `''`. */
function avisoDeGrupos(vistas) {
  const grupos = new Map();
  const raizDe = (v) => {
    let raiz = ENTERO(v.num);
    let actual = v;
    for (let i = 0; i < 4 && actual && actual.origen === 'version' && ENTERO(actual.deNum); i++) {
      raiz = actual.deNum;
      actual = vistas.find((x) => x.num === raiz);
    }
    return raiz;
  };
  for (const v of vistas) {
    const raiz = raizDe(v);
    if (!raiz || !ENTERO(v.num)) continue;
    if (!grupos.has(raiz)) grupos.set(raiz, []);
    grupos.get(raiz).push(v.num);
  }
  return [...grupos.values()].filter((g) => g.length > 1).map((g) => `[Las ${lista(g)} son versiones del mismo pedido: una sola corrida, no ${g.length}.]`).join('\n');
}

const ORDINALES = [['primera', 'primer', 'first'], ['segunda', 'second'], ['tercera', 'third'], ['cuarta', 'fourth']];

/** ¿El usuario nombra una (o todas) de esas versiones? Solo para el recordatorio: no vale como pedido. */
function nombraVersion(mensaje, nums) {
  const t = normalizar(mensaje);
  for (const m of t.matchAll(/(?:#|\bla |\bel |\bversion |\bimagen |\bnumero )\s*#?(\d{1,6})\b|^\s*(\d{1,6})\s*[.!]?\s*$/g)) if (nums.includes(Number(m[1] || m[2]))) return true;
  if (/\b(?:las|los) (?:dos|tres|cuatro|\d)\b|\bambas\b|\bambos\b|\btodas\b|\btodos\b|\bcada una\b|\bboth\b|\ball of them\b/.test(t)) return true;
  if (/\bla (?:ultima|anterior|mas nueva|nueva)\b/.test(t)) return true;
  return ORDINALES.slice(0, nums.length).some((o) => o.some((p) => new RegExp(`\\b${p}\\b`).test(t)));
}

module.exports = { lista, rotulo, promptDe, avisoDeGrupos, nombraVersion };
