/**
 * FEAT-051 — Exportar e importar identidad: almas, memoria y agentes.
 *
 * Exportar es una vista adicional de lo que ya existe: nada de red salvo el
 * perfil de Voicebox, y ese lo resuelve quien llama (este módulo no importa
 * `index.js`, que arrancaría el servidor MCP). Importar nunca escribe un
 * archivo directo: siempre entra por la operación de dominio que también
 * usaría una edición manual — `recuerdos.aplicar()`, `semilla.escribirIdentidad()`
 * (FEAT-050 §9.2) o `registry.instalarAgente()` — así hereda lock, escritura
 * atómica, escaneo y backup sin duplicar ninguno.
 *
 * El sobre es el formato de FEAT-051 §4: JSON con `schema_version`,
 * `integridad.sha256` (detecta un archivo truncado o editado a mano, no
 * resuelve concurrencia) y un tope de tamaño. La detección de conflicto al
 * importar es de existencia y diferencia contra el destino, nunca del hash de
 * origen: los estados base de dos máquinas no están correlacionados (§6.1).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const rutas = require('./rutas.js');
const archivos = require('./archivos.js');
const escaneo = require('./escaneo.js');
const recuerdos = require('./recuerdos.js');
const diario = require('./diario.js');
const semilla = require('./semilla.js');
const hilos = require('./hilos.js');
const registry = require('../agents/registry.js');

const SCHEMA_VERSION = 1;
const TOPE_CONTENIDO_BYTES = 256 * 1024;

class ErrorPortable extends Error {
  constructor(motivo, codigo) {
    super(motivo);
    this.name = 'ErrorPortable';
    this.codigo = codigo || 'invalido';
  }
}

function versionPlugin() {
  try {
    return require('../../package.json').version || null;
  } catch {
    return null;
  }
}

/** Igual clave, igual orden: es lo que hace que el hash no dependa de cómo `JSON.stringify` recorrió el objeto. */
function jsonCanonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    const claves = Object.keys(valor).sort();
    return `{${claves.map(k => `${JSON.stringify(k)}:${jsonCanonico(valor[k])}`).join(',')}}`;
  }
  return JSON.stringify(valor === undefined ? null : valor);
}

function hashContenido(contenido) {
  return crypto.createHash('sha256').update(jsonCanonico(contenido), 'utf8').digest('hex');
}

function tamanoBytes(contenido) {
  return Buffer.byteLength(JSON.stringify(contenido), 'utf8');
}

function construirSobre(tipo, clave, contenido, advertencias = []) {
  if (tamanoBytes(contenido) > TOPE_CONTENIDO_BYTES) {
    throw new ErrorPortable(`El contenido supera el tope de ${TOPE_CONTENIDO_BYTES} bytes.`, 'tope');
  }
  return {
    schema_version: SCHEMA_VERSION,
    tipo,
    exportado_en: new Date().toISOString(),
    plugin_version: versionPlugin(),
    clave: clave || null,
    contenido,
    integridad: { sha256: hashContenido(contenido) },
    advertencias
  };
}

/** `''`/`false` no cuentan como duplicado de un motivo; solo el propio texto agrupa. */
function entradasDeSobre(modelo) {
  return recuerdos.entradas(modelo).map(e => ({ fecha: e.fecha, texto: e.texto }));
}

// --- Exportación -------------------------------------------------------

/**
 * FEAT-051 §5.1 / §5.2 — `alma.md` (redactado) + memoria activa. `diario` e
 * `hilo` son opt-in: son los recursos más sensibles y los que menos hacen
 * falta para que una voz "sea la misma" en otra máquina (§9 recomendación 1).
 */
function exportarAlma(clave, { incluirDiario = false, incluirHilo = false, env = process.env } = {}) {
  rutas.validarClave(clave);
  const r = rutas.rutasDe(clave, env);
  if (!fs.existsSync(r.alma) && !fs.existsSync(r.memoria)) {
    throw new ErrorPortable(`No hay alma para "${clave}".`, 'no_encontrado');
  }

  const crudo = archivos.leerTexto(r.alma);
  const { texto: almaMd, hallazgos } = escaneo.redactarSecretos(crudo);
  const memoria = recuerdos.leer(r.memoria, 'm');

  const contenido = { alma_md: almaMd, memoria: { entradas: entradasDeSobre(memoria) } };
  if (incluirDiario) contenido.diario = diario.ultimas(clave, diario.CONSERVAR, env);
  if (incluirHilo) {
    // §2 — del hilo viaja metadata de solo lectura, no el hilo. `conversation_id`
    // es un handle de agy que solo resuelve en la máquina de origen: es
    // justamente un identificador de máquina, de los que §4 prohíbe meter en el
    // sobre, y en destino apuntaría a una conversación que no existe.
    const h = hilos.leerEstado(env).almas[clave];
    contenido.hilo = h ? { ultimo_turno: h.ultimo_turno || null, turnos: h.turnos || 0 } : null;
  }

  const advertencias = hallazgos.map(h => `alma.md: ${h.cantidad} fragmento(s) redactado(s) (${h.motivo})`);
  return construirSobre('alma-completa', clave, contenido, advertencias);
}

/** Solo la identidad: clonar personalidad/descripción sin arrastrar la relación acumulada. */
function exportarIdentidad(clave, { env = process.env } = {}) {
  rutas.validarClave(clave);
  const r = rutas.rutasDe(clave, env);
  if (!fs.existsSync(r.alma)) throw new ErrorPortable(`No hay alma.md para "${clave}".`, 'no_encontrado');

  const { texto: almaMd, hallazgos } = escaneo.redactarSecretos(archivos.leerTexto(r.alma));
  const advertencias = hallazgos.map(h => `alma.md: ${h.cantidad} fragmento(s) redactado(s) (${h.motivo})`);
  return construirSobre('alma-identidad', clave, { alma_md: almaMd }, advertencias);
}

/** `usuario.md`: memoria compartida, nunca dentro de un bundle de alma. */
function exportarUsuario({ env = process.env } = {}) {
  const usuario = recuerdos.leer(rutas.rutaUsuario(env), 'u');
  return construirSobre('usuario-memoria', null, { usuario: { entradas: entradasDeSobre(usuario) } });
}

/**
 * FEAT-051 §5.3 / BE-026 — El insumo de `instalarAgente()`, nunca el
 * `agent.md` materializado. Para entradas registradas antes de BE-026 (sin
 * `description` persistida), cae como respaldo de migración a la descripción
 * vigente en el artefacto, y lo rotula en `advertencias`.
 */
function exportarAgente(nombre, { homeDir, descripcionDeArtefacto } = {}) {
  if (!registry.nombreValido(nombre)) throw new ErrorPortable(`Nombre de agente inválido: "${nombre}".`, 'invalido');
  const registro = registry.leerRegistro(homeDir);
  const entrada = registro.agents[nombre];
  if (!entrada) throw new ErrorPortable(`No hay agente registrado "${nombre}".`, 'no_encontrado');

  const advertencias = [];
  let description = entrada.description || '';
  if (!description && typeof descripcionDeArtefacto === 'function') {
    description = descripcionDeArtefacto(entrada) || '';
    if (description) {
      advertencias.push('description: recuperada del agent.md vigente como respaldo de migración (el registro no la tenía persistida)');
    }
  }

  const contenido = {
    skill: entrada.skill,
    read_only: entrada.read_only,
    tools: entrada.tools,
    description: description || null,
    addendum: entrada.addendum || null,
    project_id: entrada.project_id || null
  };
  return construirSobre('agente', nombre, contenido, advertencias);
}

// --- Validación del sobre -----------------------------------------------

function validarSobre(sobre) {
  if (!sobre || typeof sobre !== 'object') throw new ErrorPortable('El sobre no es un objeto JSON válido.', 'invalido');
  if (!Number.isInteger(sobre.schema_version)) throw new ErrorPortable('El sobre no declara `schema_version`.', 'invalido');
  if (sobre.schema_version > SCHEMA_VERSION) {
    throw new ErrorPortable(`Sobre de un schema más nuevo (${sobre.schema_version}) que el soportado (${SCHEMA_VERSION}).`, 'schema_no_soportado');
  }
  if (!sobre.contenido || typeof sobre.contenido !== 'object') throw new ErrorPortable('El sobre no trae `contenido`.', 'invalido');
  if (tamanoBytes(sobre.contenido) > TOPE_CONTENIDO_BYTES) {
    throw new ErrorPortable(`El contenido supera el tope de ${TOPE_CONTENIDO_BYTES} bytes.`, 'tope');
  }
  const esperado = sobre.integridad && sobre.integridad.sha256;
  if (!esperado || hashContenido(sobre.contenido) !== esperado) {
    throw new ErrorPortable('La integridad del sobre no coincide: parece truncado o editado a mano.', 'integridad');
  }
  return sobre;
}

function leerSobre(archivo) {
  let crudo;
  try {
    crudo = fs.readFileSync(archivo, 'utf8');
  } catch (err) {
    throw new ErrorPortable(`No se pudo leer "${archivo}": ${err.message}`, 'no_encontrado');
  }
  let sobre;
  try {
    sobre = JSON.parse(crudo);
  } catch {
    throw new ErrorPortable(`"${archivo}" no es JSON válido.`, 'invalido');
  }
  return validarSobre(sobre);
}

/**
 * Un export es la única operación de FEAT-051 que escribe fuera del dominio de
 * las almas, y `escribirAtomico()` pisa sin preguntar: exportar a una ruta
 * equivocada destruiría ese archivo en silencio. Por eso no sobrescribe nada
 * que no sea un sobre nuestro, salvo `forzar` explícito. No se valida contra un
 * directorio base a propósito: el caso de uso es justamente sacar el sobre de
 * la máquina (un pendrive, una carpeta compartida), así que acotar la ruta
 * rompería la función; lo que hay que proteger es el archivo que ya está ahí.
 */
function escribirSobre(sobre, archivo, { forzar = false } = {}) {
  if (!forzar && fs.existsSync(archivo)) {
    let previo = null;
    try { previo = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch {}
    if (!previo || !Number.isInteger(previo.schema_version) || !previo.integridad) {
      throw new ErrorPortable(
        `"${archivo}" ya existe y no es un sobre de Lagrange: no se sobrescribe. Elegí otra ruta o pasá \`forzar\`.`,
        'destino_ocupado'
      );
    }
  }
  archivos.escribirAtomico(archivo, JSON.stringify(sobre, null, 2) + '\n');
  return archivo;
}

/**
 * Directorio por defecto para sobres exportados: hermano de `lagrange-almas/`,
 * nunca un subdirectorio suyo. `rutas.listarClaves()` lista cualquier carpeta
 * de `dirAlmas()` que matchee `CLAVE_VALIDA` (que un nombre como "exportes"
 * cumple), así que anidarlo ahí lo confunde con un alma real en `listar`.
 */
function dirExportesPorDefecto(env = process.env) {
  return path.join(path.dirname(rutas.dirAlmas(env)), 'lagrange-almas-exportes');
}

// --- Importación: identidad del alma ------------------------------------

/** Liga integridad del sobre + estado del destino al momento de previsualizar: si cualquiera cambió, el token deja de coincidir. */
function tokenConfirmacion(sobre, estado) {
  return hashContenido({ sha256Sobre: sobre.integridad.sha256, estadoHash: estado.hash });
}

/**
 * FEAT-051 §6.1 — No escribe nada. Redacta secretos igual que al exportar (el
 * sobre pudo editarse después), busca hallazgos de orden sin tocar el texto,
 * y clasifica contra el destino por existencia y diferencia, no por hash de
 * origen.
 */
function previsualizarAlma(sobre, clave, { env = process.env } = {}) {
  validarSobre(sobre);
  if (sobre.tipo !== 'alma-completa' && sobre.tipo !== 'alma-identidad') {
    throw new ErrorPortable(`Sobre de tipo "${sobre.tipo}" no trae identidad de alma.`, 'tipo_incorrecto');
  }
  rutas.validarClave(clave);

  const original = sobre.contenido.alma_md || '';
  const { texto: textoNuevo, hallazgos: hallazgosSecreto } = escaneo.redactarSecretos(original);
  const hallazgosOrden = escaneo.hallazgosDeOrden(original);
  const estado = semilla.estadoIdentidad(clave, env);

  let tipoConflicto;
  if (!estado.existe) tipoConflicto = 'siembra';
  else if (estado.texto === textoNuevo) tipoConflicto = 'sin-cambios';
  else tipoConflicto = 'conflicto';

  // Un hallazgo de orden exige confirmación aunque no haya conflicto de
  // contenido: que no exista un `alma.md` previo no vuelve confiable al que llega.
  const requiereConfirmacion = tipoConflicto === 'conflicto' || hallazgosOrden.length > 0;

  return {
    tipoConflicto,
    requiereConfirmacion,
    confirmacion: tokenConfirmacion(sobre, estado),
    // `estadoHash` viaja junto al preview para que `importarAlma` no tenga que
    // releer el disco: reusarlo es lo que hace que "el hash contra el que se
    // validó el token" y "el hash que ve la precondición del write" sean,
    // literalmente, el mismo valor — no dos lecturas separadas que coinciden
    // solo si nada escribió en el medio.
    estadoHash: estado.hash,
    hallazgosSecreto,
    hallazgosOrden,
    textoActual: estado.texto,
    textoNuevo
  };
}

/**
 * FEAT-051 §6.1/§6.4 — Reproduce el preview con el estado *actual* del
 * destino y solo escribe si el `confirmacion` que trae el llamador coincide
 * con el que ese preview recalculado produce. Si el destino cambió desde la
 * previsualización original, los hashes no coinciden y esto es un conflicto,
 * no una segunda oportunidad de adivinar.
 */
function importarAlma(sobre, clave, { confirmacion, env = process.env } = {}) {
  const preview = previsualizarAlma(sobre, clave, { env });

  if (preview.requiereConfirmacion && confirmacion !== preview.confirmacion) {
    return { resultado: 'conflicto', motivo: 'falta confirmación o el destino cambió desde la previsualización', preview };
  }
  if (preview.tipoConflicto === 'sin-cambios') {
    return { resultado: 'sin-cambios', preview };
  }

  // El mismo hash que validó el token, no una relectura nueva: cero ventana
  // entre "contra qué se validó la confirmación" y "qué ve la precondición
  // del write" (más allá de la que ya cierra el lock de `escribirIdentidad`).
  const escritura = semilla.escribirIdentidad(clave, preview.textoNuevo, { env, estadoEsperadoHash: preview.estadoHash });
  return { ...escritura, hallazgosSecreto: preview.hallazgosSecreto, hallazgosOrden: preview.hallazgosOrden };
}

// --- Importación: memoria y usuario.md -----------------------------------

/**
 * FEAT-051 §6.2 — Sin escribir nada: reproduce la misma clasificación que
 * `recuerdos.aplicar()` haría (escaneo, duplicado por texto, tope, truncado a
 * `MAX_TEXTO`) para poder mostrarla en un preview. Es una simulación aparte
 * y no un modo oculto de `aplicar()` a propósito: esa función no tiene forma
 * de "probar" sin persistir, y agregarle una no es lo que pide este ítem.
 */
function simularEntradas(entradasSobre, ruta, prefijo, tope) {
  const modelo = recuerdos.parsear(archivos.leerTexto(ruta), prefijo);
  const existentes = new Set(recuerdos.entradas(modelo).map(e => e.texto.toLowerCase()));
  let usadoProyectado = recuerdos.usado(modelo);

  const aceptadas = [];
  const rechazadas = [];
  for (const entrada of entradasSobre || []) {
    const resultado = escaneo.escanear(entrada && entrada.texto);
    if (!resultado.ok) { rechazadas.push({ motivo: resultado.motivo }); continue; }
    const truncado = resultado.texto.length > recuerdos.MAX_TEXTO;
    const texto = resultado.texto.slice(0, recuerdos.MAX_TEXTO);
    if (existentes.has(texto.toLowerCase())) { rechazadas.push({ motivo: 'duplicado' }); continue; }
    if (usadoProyectado + texto.length > tope) { rechazadas.push({ motivo: 'tope' }); continue; }
    usadoProyectado += texto.length;
    existentes.add(texto.toLowerCase());
    aceptadas.push({ texto, truncado });
  }
  return { aceptadas, rechazadas, usadoProyectado, tope };
}

/**
 * FEAT-051 §6.4 — El token de confirmación para un import de entradas. Liga el
 * sobre al estado del destino *tal como lo vio el preview*, igual que el de
 * identidad: un token que fuera solo el hash del sobre sería una constante del
 * archivo importado y validaría para siempre, contra cualquier destino y en
 * cualquier momento posterior, que es exactamente lo que §6.4 pide evitar.
 */
function tokenEntradas(sobre, ruta, prefijo) {
  const modelo = recuerdos.parsear(archivos.leerTexto(ruta), prefijo);
  return tokenConfirmacion(sobre, { hash: hashContenido(entradasDeSobre(modelo)) });
}

/** Traduce entradas del sobre en operaciones `agregar` con su fecha de origen (BE-027). Nunca reemplaza el archivo. */
function importarEntradas(entradasSobre, ruta, prefijo, tope) {
  const operaciones = (entradasSobre || [])
    .filter(e => e && typeof e.texto === 'string' && e.texto)
    .map(e => ({ tipo: 'agregar', texto: e.texto, fecha: e.fecha }));
  return recuerdos.aplicar(ruta, prefijo, operaciones, tope);
}

// --- Importación: agente -------------------------------------------------

function previsualizarAgente(sobre, nombre, { homeDir } = {}) {
  validarSobre(sobre);
  if (sobre.tipo !== 'agente') throw new ErrorPortable(`Sobre de tipo "${sobre.tipo}" no trae un agente.`, 'tipo_incorrecto');
  if (!registry.nombreValido(nombre)) throw new ErrorPortable(`Nombre de agente inválido: "${nombre}".`, 'invalido');

  const c = sobre.contenido;
  const registro = registry.leerRegistro(homeDir);
  const actual = registro.agents[nombre] || null;
  const skillDisponible = Boolean(registry.leerCuerpoSkill(c.skill, homeDir));

  const cambios = [];
  if (!actual) {
    cambios.push({ campo: '(agente)', anterior: null, nuevo: 'nuevo' });
  } else {
    for (const campo of ['skill', 'read_only', 'description', 'addendum', 'project_id']) {
      const anterior = actual[campo] ?? null;
      const nuevo = c[campo] ?? null;
      if (JSON.stringify(anterior) !== JSON.stringify(nuevo)) cambios.push({ campo, anterior, nuevo });
    }
    const toolsAnteriores = JSON.stringify([...(actual.tools || [])].sort());
    const toolsNuevas = JSON.stringify([...(c.tools || [])].sort());
    if (toolsAnteriores !== toolsNuevas) cambios.push({ campo: 'tools', anterior: actual.tools, nuevo: c.tools });
  }

  return { existeAgente: Boolean(actual), skillDisponible, cambios };
}

/** Siempre por `instalarAgente()`: nunca escribe `agent.md` directo. La memoria de `mcp-memory` no viaja (queda en `advertencias`). */
function importarAgente(sobre, nombre, { homeDir } = {}) {
  validarSobre(sobre);
  if (sobre.tipo !== 'agente') throw new ErrorPortable(`Sobre de tipo "${sobre.tipo}" no trae un agente.`, 'tipo_incorrecto');
  const c = sobre.contenido;

  const entrada = registry.instalarAgente(nombre, {
    skill: c.skill,
    readOnly: c.read_only,
    tools: c.tools,
    description: c.description,
    addendum: c.addendum,
    projectId: c.project_id
  }, homeDir);

  return {
    resultado: 'escrito',
    agente: entrada,
    advertencias: ['la memoria de mcp-memory no viaja con este import: el agente resuelve y castea, pero llega sin sus criterios acumulados']
  };
}

// --- Referencia de voz -----------------------------------------------------

/** Nunca escribible: Voicebox no expone un endpoint de escritura. Sirve solo como insumo de `semilla.sembrar()` a mano. */
function exportarPerfilVoz(perfil, origen) {
  if (!perfil || typeof perfil.name !== 'string' || !perfil.name.trim()) {
    throw new ErrorPortable('El perfil no tiene nombre.', 'invalido');
  }
  const contenido = {
    name: perfil.name,
    personality: perfil.personality || null,
    description: perfil.description || null,
    language: perfil.language || null,
    origen: origen || 'desconocido'
  };
  return construirSobre('perfil-voz-referencia', rutas.claveDeVoz(perfil.name), contenido);
}

module.exports = {
  SCHEMA_VERSION,
  TOPE_CONTENIDO_BYTES,
  ErrorPortable,
  construirSobre,
  validarSobre,
  leerSobre,
  escribirSobre,
  dirExportesPorDefecto,
  exportarAlma,
  exportarIdentidad,
  exportarUsuario,
  exportarAgente,
  exportarPerfilVoz,
  previsualizarAlma,
  importarAlma,
  simularEntradas,
  tokenEntradas,
  importarEntradas,
  previsualizarAgente,
  importarAgente
};
