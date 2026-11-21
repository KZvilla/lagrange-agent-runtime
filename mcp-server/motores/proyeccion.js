'use strict';

/**
 * FEAT-202 S6 (D9, D5) — La proyección de los motores para la terminal (API v2) y para `status`, con lista blanca.
 *
 * Todo lo que sale de acá está enumerado campo por campo: nunca una ruta, un `configDir`, el nombre de una variable de
 * key, un `motivo` del proveedor ni los `avisos` de la carga de config. Un motivo sale como `motivoCodigo` y un texto
 * propio por código.
 *
 * Es una hoja (sin dependencias): la carga el bridge (`web/v2/motores.js`) y el servidor MCP (`status`).
 */

/** El texto de cada código. Los códigos son el contrato; el texto, solo para mostrar. */
const TEXTO_DE_CODIGO = Object.freeze({
  manual: 'manual mode: Lagrange does not launch agy',
  'sin-cli': 'the engine executable was not found or did not answer',
  'sin-key': 'no API key configured',
  'sin-respuesta': 'the provider did not answer in time',
  'sin-dato': 'no reading yet',
  'no-informa': 'this engine does not report its quota',
  'sin-cupo': 'out of quota',
  'no-vigentes': 'isolation probes not current: until they pass, turns on this engine are refused',
  corriendo: 'isolation probes running',
  error: 'could not read it'
});

/** Un motivo libre (del motor o del proveedor) a su código. Nunca se devuelve el motivo. */
function codigoDeMotivo(motivo) {
  const m = String(motivo || '');
  if (!m) return 'sin-dato';
  if (/modo manual|manual mode/i.test(m)) return 'manual';
  if (/api[_ ]?key|clave|\bkey\b/i.test(m)) return 'sin-key';
  if (/sin respuesta|no respond|did not answer|timeout|timed out|tiempo l[ií]mite|abort/i.test(m)) return 'sin-respuesta';
  if (/sin cupo|out of quota|agotad|exhaust/i.test(m)) return 'sin-cupo';
  if (/not read|sin dato|no reading|sin lectura|no hay/i.test(m)) return 'sin-dato';
  if (/executable|ejecutable|ENOENT|not found|no encontr/i.test(m)) return 'sin-cli';
  return 'error';
}

function conCodigo(codigo) {
  const c = Object.prototype.hasOwnProperty.call(TEXTO_DE_CODIGO, codigo) ? codigo : 'error';
  return { motivoCodigo: c, texto: TEXTO_DE_CODIGO[c] };
}

const texto = (v, tope = 64) => (typeof v === 'string' && v.length <= tope ? v : null);
const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fecha = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : (numero(v) !== null ? v : null));
const RE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RE_ROL = /^[a-z][a-z0-9_-]{0,31}(?::[a-z0-9][a-z0-9._-]{0,63})?$/i;
const RE_CUENTA = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ESTADOS_PERFIL = new Set(['verificado', 'sondeado', 'declarado']);
const ESFUERZOS = /^[a-z]{1,16}$/;

/** Una ventana de cupo: los campos de D5 y los de la consola (`percent`, `resetsAt`, `status`). */
function ventanaV2(v) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    nombre: texto(o.nombre, 32), usado: numero(o.usado), reinicia: fecha(o.reinicia), duracionMs: numero(o.duracionMs),
    grupo: texto(o.grupo, 32), percent: numero(o.percent), resetsAt: fecha(o.resetsAt), status: texto(o.status, 32)
  };
}

/** El cupo de un motor: `{ ok, tipo, ventanas | saldo, visto, motivoCodigo }`, con `texto` para el código. */
function cupoV2(c) {
  if (!c || typeof c !== 'object') return { ok: false, tipo: null, visto: null, ...conCodigo('no-informa') };
  const tipo = c.tipo === 'saldo' || c.tipo === 'ventanas' ? c.tipo : null;
  if (!c.ok) return { ok: false, tipo, visto: null, ...conCodigo(codigoDeMotivo(c.motivo || c.error)) };
  if (tipo === 'saldo') {
    const saldo = typeof c.saldo === 'string' || numero(c.saldo) !== null ? String(c.saldo).slice(0, 32) : null;
    return { ok: true, tipo, saldo, moneda: texto(c.moneda, 8), disponible: c.disponible !== false, visto: fecha(c.visto), motivoCodigo: null, texto: null };
  }
  const ventanas = Array.isArray(c.ventanas) ? c.ventanas.slice(0, 16).map(ventanaV2) : [];
  return { ok: true, tipo: 'ventanas', ventanas, visto: fecha(c.visto), motivoCodigo: null, texto: null };
}

/** Las capacidades de D2, solo los valores simples y los perfiles. */
function capacidadesV2(c) {
  const o = c && typeof c === 'object' ? c : {};
  const perfiles = {};
  for (const [p, e] of Object.entries(o.perfiles || {})) if (ESTADOS_PERFIL.has(e) && texto(p, 16)) perfiles[p] = e;
  const uno = (v) => (v === null || typeof v === 'boolean' ? v : texto(v, 16));
  return {
    perfiles, hilos: uno(o.hilos), red: Boolean(o.red), imagen: Boolean(o.imagen), stream: Boolean(o.stream),
    contenedor: Boolean(o.contenedor), cupo: uno(o.cupo), casts: Boolean(o.casts), modelos: uno(o.modelos)
  };
}

/** Un modelo de la tabla (D4) con sus niveles, sus perfiles y el estado de su sonda (`vigente` | `no-vigente` | null). */
function modeloV2(m) {
  const o = m && typeof m === 'object' ? m : {};
  const perfiles = {};
  for (const [p, e] of Object.entries(o.perfiles || {})) if (ESTADOS_PERFIL.has(e) && texto(p, 16)) perfiles[p] = e;
  const sonda = {};
  for (const [p, e] of Object.entries(o.sonda || {})) if ((e === 'vigente' || e === 'no-vigente') && texto(p, 16)) sonda[p] = e;
  return {
    modelo: o.modelo === null ? null : texto(o.modelo, 80),
    admite: Boolean(o.admite),
    niveles: Array.isArray(o.niveles) ? o.niveles.filter((n) => typeof n === 'string' && ESFUERZOS.test(n)) : [],
    implicito: typeof o.implicito === 'string' && ESFUERZOS.test(o.implicito) ? o.implicito : null,
    perfiles, sonda,
    // Lo que rinde en Go (`go-estimados.js`): pedidos estimados cada 5 h; `gratis`, sin tope.
    pedidos5h: numero(o.pedidos5h), gratis: Boolean(o.gratis)
  };
}

/** Un modelo de Go que Lagrange no ofrece: solo el id, el nombre y lo que rinde. */
function otroModeloV2(m) {
  const o = m && typeof m === 'object' ? m : {};
  return { id: texto(o.id, 80), nombre: texto(o.nombre, 80), pedidos5h: numero(o.pedidos5h), gratis: Boolean(o.gratis) };
}

/** De dónde salen las estimaciones: la fecha y la página. */
function estimadosV2(e) {
  if (!e || typeof e !== 'object') return null;
  const fuente = typeof e.fuente === 'string' && /^https:\/\/opencode\.ai\/[\w./#-]{0,80}$/.test(e.fuente) ? e.fuente : null;
  return { fecha: typeof e.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.fecha) ? e.fecha : null, fuente };
}

/**
 * El estado de un motor (`estadoDeMotores` más lo que sume quien llama): `{ id, disponible, motivoCodigo, texto,
 * version, capacidades, cupo, roles, modelos, otrosModelos, estimados }`.
 */
function motorV2(e) {
  const o = e && typeof e === 'object' ? e : {};
  const id = typeof o.id === 'string' && RE_ID.test(o.id) ? o.id : null;
  const motivo = o.disponible ? { motivoCodigo: null, texto: null } : conCodigo(o.motivoCodigo || codigoDeMotivo(o.motivo));
  return {
    id,
    disponible: Boolean(o.disponible),
    ...motivo,
    version: typeof o.version === 'string' && /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(o.version) ? o.version : null,
    capacidades: capacidadesV2(o.capacidades),
    cupo: o.cupo === undefined ? null : cupoV2(o.cupo),
    roles: Array.isArray(o.roles) ? o.roles.filter((r) => typeof r === 'string' && RE_ROL.test(r)) : [],
    modelos: Array.isArray(o.modelos) ? o.modelos.map(modeloV2) : [],
    otrosModelos: Array.isArray(o.otrosModelos) ? o.otrosModelos.slice(0, 64).map(otroModeloV2).filter((m) => m.id) : [],
    estimados: estimadosV2(o.estimados)
  };
}

/** Una elección resuelta (`{ motor, modelo, esfuerzo, cuenta }`). */
function eleccionV2(e) {
  const o = e && typeof e === 'object' ? e : {};
  return {
    motor: typeof o.motor === 'string' && RE_ID.test(o.motor) ? o.motor : null,
    modelo: texto(o.modelo, 80),
    esfuerzo: typeof o.esfuerzo === 'string' && ESFUERZOS.test(o.esfuerzo) ? o.esfuerzo : null,
    cuenta: typeof o.cuenta === 'string' && RE_CUENTA.test(o.cuenta) ? o.cuenta : null
  };
}

/**
 * FEAT-203 S0 — Lo que acepta un rol al guardar: `[{ motor, modelos: [{ id, esfuerzos }] }]`. `null` si el núcleo no lo
 * calculó (la terminal muestra entonces los selectores sin filtrar).
 */
function admitenV2(a) {
  if (!Array.isArray(a)) return null;
  return a
    .filter((m) => m && typeof m.motor === 'string' && RE_ID.test(m.motor) && Array.isArray(m.modelos))
    .map((m) => ({
      motor: m.motor,
      modelos: m.modelos
        .filter((x) => x && texto(x.id, 80))
        .map((x) => ({ id: x.id, esfuerzos: Array.isArray(x.esfuerzos) ? x.esfuerzos.filter((e) => typeof e === 'string' && ESFUERZOS.test(e)) : [] }))
    }))
    .filter((m) => m.modelos.length);
}

/** El destino si agy no puede, con la forma de `fallback_agy`, o `null`. */
function destinoV2(d) {
  return d === 'deepseek' || d === 'opencode-go' || (typeof d === 'string' && /^claude@[a-z0-9][a-z0-9-]{0,31}$/.test(d)) ? d : null;
}

// FEAT-205 — Las listas cerradas del respaldo por rol.
const ORIGENES_RESPALDO = Object.freeze(['rol', 'hereda', 'global', 'ninguno']);
const NOTAS_RESPALDO = Object.freeze(['fijo', 'fijo-en-agy', 'go-reintenta-agy', 'hilo-retomado', 'cast-solo-lectura']);

/** FEAT-205 — El respaldo de un rol o sujeto, campo por campo, o `null` si no vino (un plugin sin FEAT-205). */
function respaldoV2(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    destino: destinoV2(r.destino),
    origen: ORIGENES_RESPALDO.includes(r.origen) ? r.origen : 'ninguno',
    desde: typeof r.desde === 'string' && RE_ROL.test(r.desde) ? r.desde : null,
    aplica: r.aplica === true,
    nota: NOTAS_RESPALDO.includes(r.nota) ? r.nota : null,
    // `claude@principal` no es un respaldo: es la cuenta que ya está corriendo.
    admite: Array.isArray(r.admite) ? [...new Set(r.admite.map(destinoV2).filter((d) => d && d !== 'claude@principal'))] : []
  };
}

/** Un rol de la tabla resuelta: su elección, de dónde salió (`config` o `defecto`) y lo que acepta. */
function rolV2(r) {
  const o = r && typeof r === 'object' ? r : {};
  return {
    rol: typeof o.rol === 'string' && RE_ROL.test(o.rol) ? o.rol : null,
    ...eleccionV2(o),
    origen: o.origen === 'config' ? 'config' : 'defecto',
    admiten: admitenV2(o.admiten),
    respaldo: respaldoV2(o.respaldo)
  };
}

/** Un sujeto de la consola (alma, consolidación o agente) con los campos que lee la terminal. */
function sujetoMotorV2(s) {
  const o = s && typeof s === 'object' ? s : {};
  const fb = o.fallback && typeof o.fallback === 'object' ? o.fallback : null;
  const res = o.resolucion && typeof o.resolucion === 'object' ? o.resolucion : null;
  return {
    rol: typeof o.rol === 'string' && RE_ROL.test(o.rol) ? o.rol : null,
    general: texto(o.general, 32),
    tipo: ['alma', 'consolidacion', 'agente'].includes(o.tipo) ? o.tipo : null,
    id: texto(o.id, 64),
    propio: o.propio && typeof o.propio === 'object' ? eleccionV2(o.propio) : null,
    origen: typeof o.origen === 'string' && RE_ROL.test(o.origen) ? o.origen : null,
    efectivo: eleccionV2(o.efectivo),
    fallback: fb ? {
      motor: typeof fb.motor === 'string' && RE_ID.test(fb.motor) ? fb.motor : null,
      cuenta: typeof fb.cuenta === 'string' && RE_CUENTA.test(fb.cuenta) ? fb.cuenta : null,
      hasta: numero(fb.hasta) ?? fecha(fb.hasta)
    } : null,
    resolucion: res ? {
      modelo: texto(res.modelo, 80), vistoEn: fecha(res.vistoEn), anterior: texto(res.anterior, 80),
      cambioEn: fecha(res.cambioEn), cambioReciente: Boolean(res.cambioReciente)
    } : null,
    admiten: admitenV2(o.admiten),
    respaldo: respaldoV2(o.respaldo)
  };
}

/** El estado de las sondas de una cuenta de claude: `{ estado, motivoCodigo, texto }`, sin el motivo crudo. */
function sondaClaudeV2(s) {
  const estado = s && ['vigentes', 'corriendo', 'no-vigentes'].includes(s.estado) ? s.estado : 'no-vigentes';
  if (estado === 'vigentes') return { estado, motivoCodigo: null, texto: null };
  return { estado, ...conCodigo(estado === 'corriendo' ? 'corriendo' : 'no-vigentes') };
}

/**
 * FEAT-202 S6 (D9) — `GET /api/v2/motores`: lo que la terminal ya leía (sujetos, catálogo, sondas, cuentas del lote,
 * apodos y si hay key de deepseek y opencode-go), más `motores` y `roles`. Sin `avisos`. FEAT-203 S0: `admiten` en
 * cada rol y cada sujeto, y `respaldo.destino`.
 */
function motoresV2(vista) {
  const v = vista && typeof vista === 'object' ? vista : {};
  const sondas = v.sondas && typeof v.sondas === 'object'
    ? Object.fromEntries(Object.entries(v.sondas).filter(([k]) => /^claude(@[a-z0-9][a-z0-9-]{0,31})?$/.test(k)).map(([k, s]) => [k, sondaClaudeV2(s)]))
    : null;
  const hayKey = (k) => ({ key: Boolean(k && k.key) });
  return {
    ok: v.ok !== false,
    motores: Array.isArray(v.motores) ? v.motores.map(motorV2) : [],
    roles: Array.isArray(v.roles) ? v.roles.map(rolV2) : [],
    sujetos: Array.isArray(v.sujetos) ? v.sujetos.map(sujetoMotorV2) : [],
    catalogo: Array.isArray(v.catalogo) ? v.catalogo.map((c) => ({
      motor: c && typeof c.motor === 'string' && RE_ID.test(c.motor) ? c.motor : null,
      cupo: Boolean(c && c.cupo),
      modelos: Array.isArray(c && c.modelos) ? c.modelos.map(modeloV2) : []
    })) : [],
    sondas,
    cuentasLote: Array.isArray(v.cuentasLote) ? v.cuentasLote.filter((c) => typeof c === 'string' && /^[a-z0-9_-]{1,40}$/i.test(c)) : [],
    apodos: Object.fromEntries(Object.entries(v.apodos || {}).filter(([k, n]) => /^[a-z0-9_-]{1,40}$/i.test(k) && texto(n, 40)).map(([k, n]) => [k, n])),
    deepseek: hayKey(v.deepseek),
    opencodeGo: hayKey(v.opencodeGo),
    // FEAT-203 S0 — El destino global si agy no puede.
    respaldo: { destino: destinoV2(v.respaldo && v.respaldo.destino) }
  };
}

module.exports = { TEXTO_DE_CODIGO, codigoDeMotivo, cupoV2, capacidadesV2, modeloV2, motorV2, admitenV2, respaldoV2, ORIGENES_RESPALDO, NOTAS_RESPALDO, rolV2, sujetoMotorV2, sondaClaudeV2, motoresV2 };
