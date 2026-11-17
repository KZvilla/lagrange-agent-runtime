/**
 * FEAT-201 F0 S1 — Validador del contrato v2 (`web/contrato-v2.json`).
 *
 * El bridge no tiene dependencias de validación (grammy, auto-retry y marked),
 * así que esto implementa solo el subconjunto de JSON Schema que usa el
 * contrato. `cargarContrato` rechaza un esquema con una palabra clave que este
 * validador no conoce: así no se ignora en silencio.
 *
 * Palabras clave: `type` (cadena o lista), `nullable`, `required`,
 * `properties`, `additionalProperties` (booleano), `enum`, `items`,
 * `minLength`, `maxLength`, `minimum`, `maximum` y `$ref`
 * (`#/agregados/<nombre>`). `description` se acepta y se ignora.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUTA_CONTRATO = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'contrato-v2.json');

export const PALABRAS = Object.freeze(new Set([
  'type', 'nullable', 'required', 'properties', 'additionalProperties', 'enum', 'items',
  'minLength', 'maxLength', 'minimum', 'maximum', '$ref', 'description'
]));
const TIPOS = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const RE_REF = /^#\/agregados\/([A-Za-z][A-Za-z0-9]*)$/;

function tipoDe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function encaja(tipo, v) {
  const real = tipoDe(v);
  if (tipo === real) return true;
  // Un entero también es un número.
  return tipo === 'number' && real === 'integer';
}

/**
 * Revisa la forma de un esquema: palabras conocidas, tipos válidos y `$ref` que
 * apuntan a un agregado existente. Devuelve la lista de problemas.
 */
function revisarEsquema(esquema, ruta, agregados, problemas) {
  if (!esquema || typeof esquema !== 'object' || Array.isArray(esquema)) {
    problemas.push(`${ruta}: no es un objeto`);
    return;
  }
  for (const clave of Object.keys(esquema)) {
    if (!PALABRAS.has(clave)) problemas.push(`${ruta}: palabra clave no implementada «${clave}»`);
  }
  if (esquema.$ref !== undefined) {
    const m = RE_REF.exec(String(esquema.$ref));
    if (!m || !Object.prototype.hasOwnProperty.call(agregados, m[1])) problemas.push(`${ruta}: $ref roto «${esquema.$ref}»`);
    if (Object.keys(esquema).some((k) => k !== '$ref' && k !== 'description')) problemas.push(`${ruta}: $ref no se combina con otras palabras`);
    return;
  }
  const tipos = Array.isArray(esquema.type) ? esquema.type : esquema.type === undefined ? [] : [esquema.type];
  for (const t of tipos) if (!TIPOS.has(t)) problemas.push(`${ruta}: tipo desconocido «${t}»`);
  if (esquema.properties !== undefined) {
    if (typeof esquema.properties !== 'object' || Array.isArray(esquema.properties)) problemas.push(`${ruta}.properties: no es un objeto`);
    else for (const [k, sub] of Object.entries(esquema.properties)) revisarEsquema(sub, `${ruta}.${k}`, agregados, problemas);
  }
  if (esquema.required !== undefined) {
    if (!Array.isArray(esquema.required)) problemas.push(`${ruta}.required: no es una lista`);
    else for (const k of esquema.required) {
      if (!esquema.properties || !Object.prototype.hasOwnProperty.call(esquema.properties, k)) problemas.push(`${ruta}: «${k}» es obligatorio pero no está en properties`);
    }
  }
  if (esquema.additionalProperties !== undefined && typeof esquema.additionalProperties !== 'boolean') {
    problemas.push(`${ruta}.additionalProperties: solo se implementa como booleano`);
  }
  if (esquema.enum !== undefined && !Array.isArray(esquema.enum)) problemas.push(`${ruta}.enum: no es una lista`);
  if (esquema.items !== undefined) revisarEsquema(esquema.items, `${ruta}[]`, agregados, problemas);
}

/** Lee y revisa el contrato. Lanza con la lista de problemas si no es válido. */
export function cargarContrato(ruta = RUTA_CONTRATO) {
  const contrato = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  return revisarContrato(contrato);
}

export function revisarContrato(contrato) {
  const problemas = [];
  if (typeof contrato?.version !== 'string' || !/^2\.\d+$/.test(contrato.version)) problemas.push('version: tiene que ser 2.x');
  const agregados = contrato?.agregados && typeof contrato.agregados === 'object' ? contrato.agregados : {};
  const eventos = contrato?.eventos && typeof contrato.eventos === 'object' ? contrato.eventos : {};
  for (const [nombre, esquema] of Object.entries(agregados)) revisarEsquema(esquema, `agregados.${nombre}`, agregados, problemas);
  for (const [tipo, esquema] of Object.entries(eventos)) revisarEsquema(esquema, `eventos.${tipo}`, agregados, problemas);
  // Cada tipo del enum de `evento` tiene su esquema de datos, y al revés.
  const tiposEvento = agregados.evento?.properties?.tipo?.enum || [];
  for (const t of tiposEvento) if (!Object.prototype.hasOwnProperty.call(eventos, t)) problemas.push(`eventos: falta el esquema de «${t}»`);
  for (const t of Object.keys(eventos)) if (!tiposEvento.includes(t)) problemas.push(`eventos.${t}: no está en el enum de agregados.evento.tipo`);
  if (problemas.length) {
    const err = new Error(`Contrato v2 inválido:\n- ${problemas.join('\n- ')}`);
    err.problemas = problemas;
    throw err;
  }
  return contrato;
}

function validarContra(esquema, valor, ruta, agregados, errores) {
  if (esquema.$ref !== undefined) {
    const nombre = RE_REF.exec(esquema.$ref)[1];
    validarContra(agregados[nombre], valor, ruta, agregados, errores);
    return;
  }
  if (valor === null && esquema.nullable === true) return;
  if (esquema.type !== undefined) {
    const tipos = Array.isArray(esquema.type) ? esquema.type : [esquema.type];
    if (!tipos.some((t) => encaja(t, valor))) {
      errores.push(`${ruta}: se esperaba ${tipos.join(' o ')} y llegó ${tipoDe(valor)}`);
      return;
    }
  }
  if (esquema.enum !== undefined && !esquema.enum.includes(valor)) errores.push(`${ruta}: valor fuera de la lista`);
  if (typeof valor === 'string') {
    if (esquema.minLength !== undefined && valor.length < esquema.minLength) errores.push(`${ruta}: más corto que ${esquema.minLength}`);
    if (esquema.maxLength !== undefined && valor.length > esquema.maxLength) errores.push(`${ruta}: más largo que ${esquema.maxLength}`);
  }
  if (typeof valor === 'number') {
    if (esquema.minimum !== undefined && valor < esquema.minimum) errores.push(`${ruta}: menor que ${esquema.minimum}`);
    if (esquema.maximum !== undefined && valor > esquema.maximum) errores.push(`${ruta}: mayor que ${esquema.maximum}`);
  }
  if (tipoDe(valor) === 'object') {
    const props = esquema.properties || {};
    for (const k of esquema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(valor, k)) errores.push(`${ruta}.${k}: falta`);
    }
    for (const [k, v] of Object.entries(valor)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) validarContra(props[k], v, `${ruta}.${k}`, agregados, errores);
      else if (esquema.additionalProperties === false) errores.push(`${ruta}.${k}: campo no permitido`);
    }
  }
  if (Array.isArray(valor) && esquema.items !== undefined) {
    valor.forEach((v, i) => validarContra(esquema.items, v, `${ruta}[${i}]`, agregados, errores));
  }
}

/**
 * Valida `valor` contra un agregado (`'turno'`) o un tipo de evento
 * (`'evento:turno.fin'`). Devuelve la lista de errores, vacía si encaja.
 */
export function validar(contrato, nombre, valor) {
  const esEvento = nombre.startsWith('evento:');
  const fuente = esEvento ? contrato.eventos : contrato.agregados;
  const clave = esEvento ? nombre.slice('evento:'.length) : nombre;
  if (!fuente || !Object.prototype.hasOwnProperty.call(fuente, clave)) return [`${nombre}: no existe en el contrato`];
  const errores = [];
  validarContra(fuente[clave], valor, clave, contrato.agregados, errores);
  return errores;
}
