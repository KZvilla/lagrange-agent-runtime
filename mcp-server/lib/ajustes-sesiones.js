/**
 * FEAT-169 F4 — La sección `sesiones` de Ajustes: `sesiones_claude` (qué
 * carpetas ofrece /claude además de las de confianza, cuáles oculta, con qué
 * cuenta y modo abre cada una, la cuenta por defecto y el tope de sesiones).
 *
 * La lectura reusa `aplicarSesionesClaude` de config.js (los mismos avisos que
 * ve el daemon); la escritura es estricta y todo o nada, con las mismas reglas.
 * Agregar una carpeta no salta la confianza: el launcher la sigue exigiendo en
 * el `.claude.json` de la cuenta, que Lagrange nunca escribe.
 */
'use strict';

const path = require('node:path');
const { MODOS_SPAWN_CLAUDE, MAX_SESIONES_CLAUDE_TOPE, CUENTA_PRINCIPAL, aplicarSesionesClaude } = require('./config.js');
const roles = require('../motores/roles.js');
const { ErrorAjuste } = require('./ajustes-general.js');

const MAX_ENTRADAS = 50;
const MAX_RUTA = 1024;
const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const cuentasDeDatos = (datos) => (esObjeto(datos.motores) && esObjeto(datos.motores.cuentas) ? datos.motores.cuentas : {});

/** Lo crudo de la sección, para su versión. */
function crudoSesiones(datos) {
  return datos.sesiones_claude ?? null;
}

/**
 * Para la pantalla: lo que está en el archivo, en la forma del pedido, y los
 * avisos de lo que el daemon ignora. Una sección que no es objeto vuelve vacía.
 */
function leerSesiones(datos, { homeDir = '' } = {}) {
  const crudo = crudoSesiones(datos);
  const cfg = { motores: { cuentas: cuentasDeDatos(datos) }, avisos: [] };
  if (crudo !== null) aplicarSesionesClaude(cfg, { sesiones_claude: crudo }, { homeDir });
  const c = esObjeto(crudo) ? crudo : {};
  const directorios = esObjeto(c.directorios)
    ? Object.fromEntries(Object.entries(c.directorios).map(([ruta, m]) => [ruta, {
      modo: esObjeto(m) && typeof m.modo === 'string' ? m.modo : null,
      cuenta: esObjeto(m) && typeof m.cuenta === 'string' ? m.cuenta : null
    }]))
    : {};
  return {
    sesiones: {
      cuenta_por_defecto: typeof c.cuenta_por_defecto === 'string' ? c.cuenta_por_defecto : null,
      max_sesiones: Number.isInteger(c.max_sesiones) ? c.max_sesiones : null,
      directorios,
      ocultos: Array.isArray(c.ocultos) ? c.ocultos.filter((r) => typeof r === 'string') : []
    },
    modos: [...MODOS_SPAWN_CLAUDE],
    tope: MAX_SESIONES_CLAUDE_TOPE,
    avisos: cfg.avisos
  };
}

function rutaEstricta(r, campo) {
  if (typeof r !== 'string' || !r.trim() || r.length > MAX_RUTA || /[\x00-\x1f]/.test(r)) {
    throw new ErrorAjuste('Cada carpeta tiene que ser una ruta escrita', campo);
  }
  const t = r.trim();
  if (!path.isAbsolute(t) && t !== '~' && !/^~[\\/]/.test(t)) {
    throw new ErrorAjuste(`"${t}" no es una ruta absoluta (o que empiece con ~)`, campo);
  }
  return t;
}

/**
 * Aplica `{ cuenta_por_defecto, max_sesiones, directorios, ocultos }` (la
 * sección entera: lo que falta queda vacío). Sin nada, borra la clave. Lanza
 * `ErrorAjuste`.
 */
function aplicarSesiones(datos, pedido, { homeDir = '' } = {}) {
  if (!esObjeto(pedido)) throw new ErrorAjuste('La sección sesiones tiene que ser un objeto', 'sesiones');
  const extra = Object.keys(pedido).filter((k) => !['cuenta_por_defecto', 'max_sesiones', 'directorios', 'ocultos'].includes(k));
  if (extra.length) throw new ErrorAjuste(`Claves desconocidas en sesiones: ${extra.join(', ')}`, 'sesiones');
  const cuentas = cuentasDeDatos(datos);
  const cuentaValida = (c) => c === CUENTA_PRINCIPAL || (typeof c === 'string' && roles.RE_CUENTA.test(c) && Object.prototype.hasOwnProperty.call(cuentas, c));
  const salida = {};

  const cpd = pedido.cuenta_por_defecto ?? null;
  if (cpd !== null) {
    if (!cuentaValida(cpd)) throw new ErrorAjuste(`La cuenta por defecto "${cpd}" no es principal ni una cuenta configurada`, 'sesiones.cuenta_por_defecto');
    salida.cuenta_por_defecto = cpd;
  }
  const max = pedido.max_sesiones ?? null;
  if (max !== null) {
    if (!Number.isInteger(max) || max < 1 || max > MAX_SESIONES_CLAUDE_TOPE) {
      throw new ErrorAjuste(`El máximo de sesiones tiene que ser un entero de 1 a ${MAX_SESIONES_CLAUDE_TOPE}`, 'sesiones.max_sesiones');
    }
    salida.max_sesiones = max;
  }

  const dirs = pedido.directorios ?? {};
  if (!esObjeto(dirs)) throw new ErrorAjuste('Las carpetas agregadas tienen que ser { "<ruta>": { modo, cuenta } }', 'sesiones.directorios');
  const entradas = Object.entries(dirs);
  if (entradas.length > MAX_ENTRADAS) throw new ErrorAjuste(`Hasta ${MAX_ENTRADAS} carpetas agregadas`, 'sesiones.directorios');
  const vistas = new Set();
  const directorios = {};
  for (const [clave, meta] of entradas) {
    const ruta = rutaEstricta(clave, 'sesiones.directorios');
    const id = roles.expandirRuta(ruta, homeDir).toLowerCase();
    if (vistas.has(id)) throw new ErrorAjuste(`"${ruta}" está dos veces`, 'sesiones.directorios');
    vistas.add(id);
    const m = meta ?? {};
    if (!esObjeto(m)) throw new ErrorAjuste(`"${ruta}" tiene que llevar { modo, cuenta }`, 'sesiones.directorios');
    const otras = Object.keys(m).filter((k) => !['modo', 'cuenta'].includes(k));
    if (otras.length) throw new ErrorAjuste(`Claves desconocidas en "${ruta}": ${otras.join(', ')}`, 'sesiones.directorios');
    const entrada = {};
    if (m.modo !== undefined && m.modo !== null) {
      if (!MODOS_SPAWN_CLAUDE.includes(m.modo)) throw new ErrorAjuste(`El modo de "${ruta}" tiene que ser ${MODOS_SPAWN_CLAUDE.join(' o ')}`, 'sesiones.directorios');
      entrada.modo = m.modo;
    }
    if (m.cuenta !== undefined && m.cuenta !== null) {
      if (!cuentaValida(m.cuenta)) throw new ErrorAjuste(`La cuenta de "${ruta}" ("${m.cuenta}") no es principal ni una cuenta configurada`, 'sesiones.directorios');
      entrada.cuenta = m.cuenta;
    }
    directorios[ruta] = entrada;
  }
  if (Object.keys(directorios).length) salida.directorios = directorios;

  const ocultosPedidos = pedido.ocultos ?? [];
  if (!Array.isArray(ocultosPedidos)) throw new ErrorAjuste('Las carpetas ocultas tienen que ser una lista de rutas', 'sesiones.ocultos');
  if (ocultosPedidos.length > MAX_ENTRADAS) throw new ErrorAjuste(`Hasta ${MAX_ENTRADAS} carpetas ocultas`, 'sesiones.ocultos');
  const ocultos = [];
  const vistosOcultos = new Set();
  for (const r of ocultosPedidos) {
    const ruta = rutaEstricta(r, 'sesiones.ocultos');
    const id = roles.expandirRuta(ruta, homeDir).toLowerCase();
    // Una repetida no es un error: se guarda una vez.
    if (!vistosOcultos.has(id)) { vistosOcultos.add(id); ocultos.push(ruta); }
  }
  if (ocultos.length) salida.ocultos = ocultos;

  const nuevos = { ...datos };
  if (Object.keys(salida).length) nuevos.sesiones_claude = salida;
  else delete nuevos.sesiones_claude;
  return nuevos;
}

module.exports = { crudoSesiones, leerSesiones, aplicarSesiones };
