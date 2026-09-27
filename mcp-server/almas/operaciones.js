/**
 * FEAT-090 §3.2 — Las operaciones de almas, como datos y no como texto.
 *
 * Una sola implementación para dos caminos: el MCP la usa directa en `solo` y
 * `servidor`, y el servidor la ejecuta cuando un nodo la pide (`POST
 * /nodo/almas`). Cada superficie arma su propio texto con lo que devuelve.
 *
 * Todo lo que viaja por la red tiene que ser JSON: nada de rutas del disco del
 * servidor como argumento, y los sobres de exportar e importar van como objeto
 * (el archivo lo escribe o lo lee el MCP del nodo en SU disco).
 */

const fs = require('node:fs');
const path = require('node:path');
const rutas = require('./rutas.js');
const archivos = require('./archivos.js');
const recuerdos = require('./recuerdos.js');
const diario = require('./diario.js');
const semilla = require('./semilla.js');
const contexto = require('./contexto.js');
const escaneo = require('./escaneo.js');
const portable = require('./portable.js');
const consolidar = require('./consolidar.js');

/** §3.3 — Qué nivel pide cada operación. Un nodo tiene `lectura` por defecto. */
const NIVEL = Object.freeze({
  existe: 'lectura', listar: 'lectura', claveExistente: 'lectura', resumenListado: 'lectura',
  identidad: 'lectura', contexto: 'lectura', ver: 'lectura', inventario: 'lectura', inventarioAlma: 'lectura', inventarioUsuario: 'lectura', exportar: 'lectura',
  anotarDiario: 'escritura', consolidar: 'escritura', olvidar: 'escritura', sembrar: 'escritura',
  previsualizarImportacion: 'escritura', importar: 'escritura', migrarAlma: 'escritura'
});

function nombreEnAlma(ruta) {
  const m = /^#\s+(.+)$/m.exec(archivos.leerTexto(ruta));
  return m ? m[1].trim() : null;
}

/** La voz pedida contra las almas que ya existen: "Diego" encuentra `diego-alvarez`. */
function claveExistente(voz) {
  const directa = rutas.claveDeVoz(voz);
  if (!directa) return null;
  const hallada = semilla.perfilPorNombre(rutas.listarClaves().map((name) => ({ name })), voz);
  return hallada ? hallada.name : directa;
}

function existe(clave) {
  try { return fs.existsSync(rutas.rutasDe(clave).alma); } catch { return false; }
}

function listar() {
  return rutas.listarClaves();
}

function modeloResumen(modelo, tope) {
  return { entradas: recuerdos.entradas(modelo), usado: recuerdos.usado(modelo), tope };
}

/** Lo que muestra `alma action:"listar"`. */
function resumenListado() {
  const claves = rutas.listarClaves();
  const almas = claves.map((c) => {
    const r = rutas.rutasDe(c);
    const m = recuerdos.leer(r.memoria, 'm');
    const ultima = diario.ultimas(c, 1)[0];
    return {
      clave: c,
      nombre: nombreEnAlma(r.alma),
      entradas: recuerdos.entradas(m).length,
      usado: recuerdos.usado(m),
      ultima: ultima ? ultima.ts : null,
      tieneAlma: fs.existsSync(r.alma)
    };
  });
  const usuario = recuerdos.leer(rutas.rutaUsuario(), 'u');
  return {
    almas,
    usuario: { entradas: recuerdos.entradas(usuario).length, usado: recuerdos.usado(usuario) },
    topes: { memoria: recuerdos.TOPE_MEMORIA, usuario: recuerdos.TOPE_USUARIO },
    dir: rutas.dirAlmas()
  };
}

/** `{ texto, recortado }` de `alma.md`, o `null` si no existe o está vacía. */
function identidad(clave) {
  if (!existe(clave)) return null;
  return contexto.identidad(clave) || null;
}

/** El contexto de una charla (identidad + memoria), o `null`. */
function contextoDe(clave) {
  if (!existe(clave)) return null;
  return contexto.componerContexto(clave, { conMemoria: true }) || null;
}

/** Lo que muestra `alma action:"ver"`, o `null` si no hay alma ni memoria. */
function ver(clave) {
  const r = rutas.rutasDe(clave);
  if (!fs.existsSync(r.alma) && !fs.existsSync(r.memoria)) return null;
  const alma = archivos.leerTexto(r.alma);
  return {
    clave,
    alma,
    maxAlma: semilla.MAX_ALMA,
    // SEC-015 — solo se informa: el usuario vino a auditar su propio archivo.
    hallazgosAlma: escaneo.hallazgosDeDocumento(alma),
    memoria: modeloResumen(recuerdos.leer(r.memoria, 'm'), recuerdos.TOPE_MEMORIA),
    usuario: modeloResumen(recuerdos.leer(rutas.rutaUsuario(), 'u'), recuerdos.TOPE_USUARIO),
    ultimas: diario.ultimas(clave, 10),
    archivos: { alma: r.alma, memoria: r.memoria, usuario: rutas.rutaUsuario(), diario: r.diario }
  };
}

/** §3.3 — Lo de un nodo lleva su nombre en el diario. */
function anotarDiario(clave, entrada, { nodo = null } = {}) {
  if (!existe(clave)) throw Object.assign(new Error(`No hay alma para ${clave}.`), { codigo: 404 });
  const limpia = entrada && typeof entrada === 'object' ? { ...entrada } : {};
  if (nodo) limpia.nodo = nodo;
  diario.anotar(clave, limpia);
  return { ok: true };
}

async function olvidar(clave, id, { superficie = 'alma', nodo = null } = {}) {
  const profunda = require('./profunda.js');
  const r = await profunda.olvidarPorPedido(clave, id, { superficie });
  if (nodo && r && r.ok) { try { diario.anotar(clave, { superficie, tipo: 'nota', resumen: `olvido pedido desde ${nodo}`, nodo }); } catch {} }
  return { ...r, compartido: profunda.esCompartido(id), aviso: r && r.ok ? profunda.avisoDeOlvido(r) : '' };
}

/** El perfil lo resuelve quien pide (su Voicebox); acá solo se escribe. */
function sembrar(perfil, { forzar = false, nodo = null } = {}) {
  if (!perfil || typeof perfil.name !== 'string') throw Object.assign(new Error('Falta el perfil de voz.'), { codigo: 400 });
  const clave = rutas.claveDeVoz(perfil.name);
  if (!clave) throw Object.assign(new Error('Ese nombre no da una clave de alma.'), { codigo: 400 });
  const r = semilla.sembrar(clave, perfil, { forzar: Boolean(forzar) });
  if (r.creado) diario.anotar(clave, { superficie: 'alma', tipo: 'semilla', resumen: r.existia ? 're-sembrada' : 'sembrada', ...(nodo ? { nodo } : {}) });
  return { clave, ...r };
}

/** Un sobre (FEAT-051): el archivo lo escribe quien lo pidió. */
function exportar(tipo, clave, opciones = {}) {
  if (tipo === 'usuario') return portable.exportarUsuario();
  if (!clave) throw Object.assign(new Error('Falta la clave del alma.'), { codigo: 400 });
  if (tipo === 'identidad') return portable.exportarIdentidad(clave);
  return portable.exportarAlma(clave, { incluirDiario: Boolean(opciones.incluirDiario), incluirHilo: Boolean(opciones.incluirHilo) });
}

/** La previsualización de un import: la misma que arma `alma importar` sin `confirmar`. */
function previsualizarImportacion(sobre, clave) {
  if (sobre.tipo === 'usuario-memoria') {
    const ruta = rutas.rutaUsuario();
    const entradas = sobre.contenido.usuario && sobre.contenido.usuario.entradas;
    if (!Array.isArray(entradas)) throw Object.assign(new Error('El sobre dice ser de `usuario.md` pero no trae `contenido.usuario.entradas`.'), { codigo: 400 });
    return { tipo: 'usuario', sim: portable.simularEntradas(entradas, ruta, 'u', recuerdos.TOPE_USUARIO), token: portable.tokenEntradas(sobre, ruta, 'u') };
  }
  const previewAlma = portable.previsualizarAlma(sobre, clave);
  const entradasMemoria = sobre.contenido.memoria ? sobre.contenido.memoria.entradas : null;
  const simMemoria = entradasMemoria ? portable.simularEntradas(entradasMemoria, rutas.rutasDe(clave).memoria, 'm', recuerdos.TOPE_MEMORIA) : null;
  return { tipo: 'alma', previewAlma, simMemoria };
}

/**
 * Aplica un import ya previsualizado. `diarioDe` es el alma a la que se le
 * anota (para `usuario.md`, una existente que elige quien pide).
 */
function importar(sobre, clave, { confirmacion = null, diarioDe = null, nodo = null } = {}) {
  const extra = nodo ? { nodo } : {};
  if (sobre.tipo === 'usuario-memoria') {
    const ruta = rutas.rutaUsuario();
    const entradas = sobre.contenido.usuario && sobre.contenido.usuario.entradas;
    if (!Array.isArray(entradas)) throw Object.assign(new Error('El sobre dice ser de `usuario.md` pero no trae `contenido.usuario.entradas`.'), { codigo: 400 });
    if (confirmacion !== portable.tokenEntradas(sobre, ruta, 'u')) return { resultado: 'conflicto', motivo: 'Confirmación inválida' };
    const resultado = portable.importarEntradas(entradas, ruta, 'u', recuerdos.TOPE_USUARIO);
    if (diarioDe) diario.anotar(diarioDe, { superficie: 'alma', tipo: 'importar', resumen: `usuario.md: ${resultado.aplicadas.length} agregadas, ${resultado.rechazadas.length} rechazadas`, ...extra });
    return { resultado: 'aplicado', usuario: resultado };
  }
  const resultado = portable.importarAlma(sobre, clave, { confirmacion });
  if (resultado.resultado === 'conflicto') return resultado;
  const entradasMemoria = sobre.contenido.memoria ? sobre.contenido.memoria.entradas : null;
  const resMemoria = entradasMemoria ? portable.importarEntradas(entradasMemoria, rutas.rutasDe(clave).memoria, 'm', recuerdos.TOPE_MEMORIA) : null;
  diario.anotar(clave, {
    superficie: 'alma',
    tipo: 'importar',
    resumen: `identidad: ${resultado.resultado}${resMemoria ? `; memoria: ${resMemoria.aplicadas.length} agregadas, ${resMemoria.rechazadas.length} rechazadas` : ''}`,
    ...extra
  });
  return { ...resultado, memoria: resMemoria };
}

/**
 * FEAT-090 §4 — Migra un alma de un nodo. Nueva → se crea completa; existente
 * → la identidad del servidor no se toca (si difiere, la del nodo queda en
 * `alma.md.nodo-<nombre>`) y las entradas de memoria se suman sin repetir.
 * Con `simular`, no escribe nada.
 */
function migrarAlma(sobre, clave, { nodo = 'nodo', simular = false } = {}) {
  if (!sobre || (sobre.tipo !== 'alma-completa' && sobre.tipo !== 'usuario-memoria')) throw Object.assign(new Error('Sobre de migración inválido.'), { codigo: 400 });
  if (sobre.tipo === 'usuario-memoria') {
    const ruta = rutas.rutaUsuario();
    const entradas = sobre.contenido.usuario?.entradas || [];
    if (simular) {
      const sim = portable.simularEntradas(entradas, ruta, 'u', recuerdos.TOPE_USUARIO);
      return { tipo: 'usuario', sumadas: sim.aceptadas.length, rechazadas: sim.rechazadas.length, simulado: true };
    }
    const r = portable.importarEntradas(entradas, ruta, 'u', recuerdos.TOPE_USUARIO);
    return { tipo: 'usuario', sumadas: r.aplicadas.length, rechazadas: r.rechazadas.length };
  }
  const r = rutas.rutasDe(clave);
  const entradas = sobre.contenido.memoria?.entradas || [];
  // `siembra` (no existe), `sin-cambios` o `conflicto`: la identidad del
  // servidor nunca se pisa.
  const preview = portable.previsualizarAlma(sobre, clave);
  const nuevo = preview.tipoConflicto === 'siembra';
  const difiere = preview.tipoConflicto === 'conflicto';
  if (simular) {
    const sim = portable.simularEntradas(entradas, r.memoria, 'm', recuerdos.TOPE_MEMORIA);
    return { tipo: 'alma', clave, accion: nuevo ? 'creada' : 'sumada', identidadEnConflicto: difiere, sumadas: sim.aceptadas.length, rechazadas: sim.rechazadas.length, simulado: true };
  }
  if (nuevo) {
    const res = portable.importarAlma(sobre, clave, { confirmacion: preview.confirmacion });
    if (res.resultado === 'conflicto') throw Object.assign(new Error(res.motivo), { codigo: 409 });
  } else if (difiere) {
    const aparte = `${r.alma}.nodo-${String(nodo).replace(/[^a-z0-9-]/gi, '')}`;
    fs.writeFileSync(aparte, preview.textoNuevo, 'utf8');
  }
  const res = portable.importarEntradas(entradas, r.memoria, 'm', recuerdos.TOPE_MEMORIA);
  diario.anotar(clave, { superficie: 'alma', tipo: 'importar', resumen: `migrada desde ${nodo}: ${nuevo ? 'creada' : 'sumada'}, ${res.aplicadas.length} entradas`, nodo });
  return { tipo: 'alma', clave, accion: nuevo ? 'creada' : 'sumada', identidadEnConflicto: difiere, sumadas: res.aplicadas.length, rechazadas: res.rechazadas.length };
}

/** FEAT-090 §3.4 — Un pendiente de consolidación que manda un nodo: se escribe acá y se lanza el consolidador. */
function recibirPendiente(pendiente, { lanzar = null } = {}) {
  const p = pendiente && typeof pendiente === 'object' ? pendiente : null;
  if (!p || typeof p.clave !== 'string' || !Array.isArray(p.turnos)) throw Object.assign(new Error('Pendiente inválido.'), { codigo: 400 });
  try { rutas.validarClave(p.clave); } catch { throw Object.assign(new Error('Clave de alma inválida.'), { codigo: 400 }); }
  if (!existe(p.clave)) throw Object.assign(new Error(`No hay alma para ${p.clave}.`), { codigo: 400 });
  const archivo = consolidar.volcar({ clave: p.clave, streamId: String(p.streamId || `nodo-${Date.now()}`).slice(0, 80), turnos: p.turnos });
  if (lanzar) lanzar(archivo);
  return { ok: true };
}

/** El script del consolidador, para lanzarlo como proceso aparte. */
const SCRIPT_CONSOLIDAR = path.join(__dirname, 'consolidar.js');

module.exports = {
  NIVEL,
  SCRIPT_CONSOLIDAR,
  claveExistente,
  existe,
  listar,
  resumenListado,
  identidad,
  contexto: contextoDe,
  ver,
  anotarDiario,
  olvidar,
  sembrar,
  exportar,
  previsualizarImportacion,
  importar,
  migrarAlma,
  recibirPendiente
};
