'use strict';

/**
 * FEAT-213 — Las flags con las que se levanta ComfyUI. Hoja: la usan los ajustes (la forma) y el proceso (la lista de su versión).
 *
 * Salen de **su** `main.py --help`: el nombre, si lleva valor, sus opciones, su ayuda y los grupos que se excluyen. Un valor
 * nunca puede ser otra flag: va como `--flag=valor`.
 */

const MAX_FLAGS = 40;
const MAX_VALOR = 300;
const MAX_TOTAL = 8000;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
const RE_FLAG = /^--[a-zA-Z][a-zA-Z0-9_-]{0,61}$/;
/** Las que pone el plugin (la red y el navegador) y las que hacen salir al proceso. */
const PROHIBIDAS = Object.freeze([
  '--listen', '--port', '--tls-keyfile', '--tls-certfile', '--enable-cors-header', '--auto-launch', '--disable-auto-launch', '--windows-standalone-build',
  '--help', '--version', '--quick-test-for-ci', '--list-feature-flags'
]);

const prohibida = (flag) => PROHIBIDAS.includes(flag) || flag.startsWith('--front-end-');
const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** La forma de la lista, sin preguntarle a ComfyUI. `{ ok, flags }` o `{ ok: false, campo, motivo }`. */
function validarForma(v) {
  const mal = (campo, motivo) => ({ ok: false, campo, motivo });
  if (!Array.isArray(v)) return mal('', 'tiene que ser una lista');
  if (v.length > MAX_FLAGS) return mal('', `hasta ${MAX_FLAGS} flags`);
  const flags = [];
  const vistas = new Set();
  let total = 0;
  for (const [i, e] of v.entries()) {
    if (!esObjeto(e)) return mal(`.${i}`, 'cada una es { flag, valor }');
    for (const k of Object.keys(e)) if (k !== 'flag' && k !== 'valor') return mal(`.${i}.${k}`, 'no está permitido');
    const flag = typeof e.flag === 'string' ? e.flag.trim() : '';
    if (!RE_FLAG.test(flag)) return mal(`.${i}.flag`, 'no es el nombre de una flag');
    if (prohibida(flag)) return mal(`.${i}.flag`, `${flag} no se puede poner`);
    if (vistas.has(flag)) return mal(`.${i}.flag`, `${flag} está repetida`);
    vistas.add(flag);
    let valor = e.valor === undefined || e.valor === null ? null : typeof e.valor === 'number' && Number.isFinite(e.valor) ? String(e.valor) : e.valor;
    if (valor !== null) {
      if (typeof valor !== 'string') return mal(`.${i}.valor`, 'tiene que ser un texto');
      valor = valor.trim();
      if (!valor) valor = null;
      else if (valor.length > MAX_VALOR) return mal(`.${i}.valor`, `hasta ${MAX_VALOR} caracteres`);
      else if (CONTROLES.test(valor)) return mal(`.${i}.valor`, 'no puede llevar saltos de línea');
      else if (valor.startsWith('-')) return mal(`.${i}.valor`, 'no puede empezar con un guion');
    }
    total += flag.length + (valor ? valor.length + 1 : 0);
    if (total > MAX_TOTAL) return mal('', 'son demasiado largas');
    flags.push({ flag, valor });
  }
  return { ok: true, flags };
}

/** Parte el «usage» en sus corchetes de primer nivel: `[--a | --b]`, `[--c X]`. */
function corchetes(uso) {
  const salida = [];
  let nivel = 0;
  let desde = -1;
  for (let i = 0; i < uso.length; i++) {
    if (uso[i] === '[') { if (nivel === 0) desde = i + 1; nivel++; }
    else if (uso[i] === ']' && nivel > 0) { nivel--; if (nivel === 0) salida.push(uso.slice(desde, i)); }
  }
  return salida;
}

/** Parte por las `|` de primer nivel (las de adentro de `[…]` o `{…}` son de un valor). */
function alternativas(t) {
  const salida = [''];
  let nivel = 0;
  for (const ch of t) {
    if (ch === '[' || ch === '{') nivel++;
    else if (ch === ']' || ch === '}') nivel--;
    if (ch === '|' && nivel === 0) salida.push(''); else salida[salida.length - 1] += ch;
  }
  return salida.map((x) => x.trim()).filter(Boolean);
}

/**
 * `main.py --help` → `[{ flag, valor: 'no' | 'si' | 'opcional', opciones, ayuda, grupo }]`. `grupo` es el número de las que se
 * excluyen entre sí, o `null`.
 */
function parsearAyuda(texto) {
  const t = String(texto || '').replace(/\r\n/g, '\n');
  const i = t.search(/^(options|optional arguments):/m);
  if (i < 0) return [];
  const uso = t.slice(0, i).replace(/\s+/g, ' ');
  const porFlag = new Map();
  let grupo = 0;
  for (const c of corchetes(uso)) {
    const partes = alternativas(c);
    const enGrupo = partes.length > 1 ? ++grupo : null;
    for (const p of partes) {
      const m = /^(--[A-Za-z][\w-]*)(?:\s+(.*))?$/.exec(p);
      if (!m) continue;
      const resto = (m[2] || '').trim();
      // `[IP]` y `[LEVEL FILE ...]` son opcionales; `[none,auto,…]` es el metavar de las opciones de un combo.
      const lista = /^\[([a-z0-9_]+(?:,[a-z0-9_]+)+)\]$/.exec(resto) || /^\{([^}]+)\}$/.exec(resto);
      porFlag.set(m[1], { flag: m[1], valor: !resto ? 'no' : lista ? 'si' : resto.startsWith('[') ? 'opcional' : 'si', opciones: lista ? lista[1].split(',').map((x) => x.trim()) : [], ayuda: '', grupo: enGrupo });
    }
  }
  let actual = null;
  for (const linea of t.slice(i).split('\n').slice(1)) {
    const m = /^ {1,4}(?:-\w, )?(--[A-Za-z][\w-]*)(.*)$/.exec(linea);
    if (m) {
      actual = porFlag.get(m[1]) || null;
      if (!actual && m[1] !== '--help') { actual = { flag: m[1], valor: 'no', opciones: [], ayuda: '', grupo: null }; porFlag.set(m[1], actual); }
      const ayuda = /^.*? {2,}(\S.*)$/.exec(m[2]);
      if (actual && ayuda) actual.ayuda = ayuda[1].trim();
    } else if (actual && /^ {10,}\S/.test(linea)) actual.ayuda = `${actual.ayuda} ${linea.trim()}`.trim();
    else if (/^\S/.test(linea)) actual = null;
  }
  return [...porFlag.values()].map((f) => ({ ...f, ayuda: f.ayuda.slice(0, 600) }));
}

/** Contra la lista de su versión. `{ ok }` o `{ ok: false, campo, motivo }`. */
function validarContra(flags, catalogo) {
  const por = new Map(catalogo.map((f) => [f.flag, f]));
  const grupos = new Map();
  for (const [i, { flag, valor }] of flags.entries()) {
    const d = por.get(flag);
    if (!d) return { ok: false, campo: `.${i}.flag`, motivo: `${flag} no está en esa versión de ComfyUI` };
    if (d.valor === 'no' && valor !== null) return { ok: false, campo: `.${i}.valor`, motivo: `${flag} no lleva valor` };
    if (d.valor === 'si' && valor === null) return { ok: false, campo: `.${i}.valor`, motivo: `${flag} necesita un valor` };
    if (valor !== null && d.opciones.length && !d.opciones.includes(valor)) return { ok: false, campo: `.${i}.valor`, motivo: `${flag} acepta ${d.opciones.join(', ')}` };
    if (d.grupo !== null) {
      if (grupos.has(d.grupo)) return { ok: false, campo: `.${i}.flag`, motivo: `${flag} y ${grupos.get(d.grupo)} se excluyen` };
      grupos.set(d.grupo, flag);
    }
  }
  return { ok: true };
}

/** Las que se pueden usar al levantar y los avisos de las que se saltean (una versión nueva puede haberlas sacado). */
function filtrar(flags, catalogo) {
  const usadas = [];
  const avisos = [];
  for (const f of flags) {
    const v = validarContra([...usadas, f], catalogo);
    if (v.ok) usadas.push(f); else avisos.push(`Se saltea ${f.flag}: ${v.motivo}.`);
  }
  return { usadas, avisos };
}

const comoArgumento = ({ flag, valor }) => (valor === null ? flag : `${flag}=${valor}`);

/** Lo que muestra la pantalla: sin las que no se pueden poner. */
const ofrecidas = (catalogo) => catalogo.filter((f) => !prohibida(f.flag));

module.exports = { MAX_FLAGS, MAX_VALOR, PROHIBIDAS, prohibida, validarForma, parsearAyuda, validarContra, filtrar, comoArgumento, ofrecidas };
