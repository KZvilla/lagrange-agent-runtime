const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dockerLib = require('./docker.js');
const { recolectar: recolectarPorDefecto } = require('./recolector.js');
const { crearCredenciales } = require('./credenciales.js');
const { crearEjecutorContenedor } = require('./ejecutor.js');
const { crearVerificador, validarPrueba } = require('./verificador.js');
const { crearAuditor, elegirModeloAuditor } = require('./auditor.js');
const { revisarLote, ACCIONES_HUMANO, ACCIONES_CONFLICTO } = require('./pipeline-revision.js');
const { gitDeRepo } = require('./juntar.js');
const { adquirirBloqueo, liberarBloqueo } = require('./bloqueo.js');
const { ESTADOS_FINALES, ESPERANDO_HUMANO } = require('./registro.js');
const { createHash } = require('node:crypto');
const { lanzarFanout, prepararTareas } = require('../fanout.js');
const registroAgentes = require('../agents/registry.js');
const { crearEscritorDeEstado, crearLectorDeControl, rutaProgreso, limpiarProgreso } = require('../fanout-estado.js');
const { esfuerzoParaCli, validarModeloEsfuerzo } = require('../lib/cli-compat.js');
const { validarReparto, explicarReparto } = require('../reparto.js');
const niveles = require('../motores/niveles.js');
const sondasClaude = require('./sondas-claude.js');
const imagenesLib = require('./imagenes.js');
const recetas = require('./recetas.js');
const grafoReceta = require('./grafo-receta.js');
const comandosRepo = require('./comandos-repo.js');
const { crearReescritor } = require('./vueltas.js');

const ABSOLUTA_EN_PROMPT = /(^|[\s"'`(])([A-Za-z]:[\\/]|\/mnt\/)/;
// FEAT-131 — `claude@<cuenta>`; sin motor, agy como siempre.
const RE_MOTOR_CLAUDE = /^claude@([a-z0-9][a-z0-9-]{0,31})$/;
const MODELO_CLAUDE_POR_DEFECTO = 'sonnet';
const CUENTA_PRINCIPAL = 'principal';
// F4b — Lo que el usuario puede escribir al responder a una tarea que espera.
const MAX_TEXTO_HUMANO = 4 * 1024;

/** F4b — La huella de una skill: si cambia mientras una tarea espera, la tarea no se reanuda con otra skill. */
const huellaSkill = (cuerpo) => createHash('sha256').update(String(cuerpo ?? '')).digest('hex');

/**
 * FEAT-131 — El motor del lote: `{ motor: 'antigravity' }` o `{ motor: 'claude',
 * cuenta }`. La cuenta tiene que estar declarada en `motores.cuentas` (FEAT-085);
 * `principal` no, porque el lote con Claude existe para la cuenta secundaria y
 * su login vive en un volumen propio. Nunca se elige solo: lo pide el pedido.
 */
function motorDelPedido(valor, config) {
  if (valor == null || valor === '' || valor === 'antigravity') return { motor: 'antigravity', cuenta: null };
  const m = RE_MOTOR_CLAUDE.exec(String(valor));
  if (!m) throw new Error(`motor inválido: ${JSON.stringify(valor)}. Usá "antigravity" o "claude@<cuenta>".`);
  const cuentas = (config.motores && config.motores.cuentas) || {};
  // FEAT-153 — `principal` (la cuenta por defecto) es una cuenta de lote incorporada: el lote no usa su carpeta, sino
  // el login del volumen `lagrange-claude-principal-home`, y pasa por los mismos chequeos (imagen, login, sondas).
  if (m[1] !== CUENTA_PRINCIPAL && !Object.hasOwn(cuentas, m[1])) throw new Error(`la cuenta ${m[1]} no está declarada en motores.cuentas`);
  return { motor: 'claude', cuenta: m[1] };
}

/** FEAT-131 — Modelo y esfuerzo de una tarea con Claude, validados con el catálogo de niveles.js. */
function validarModeloClaude(t, modelo, effortPedido) {
  if (/^(gemini|gpt-oss)/i.test(modelo)) throw new Error(`Tarea ${t.id}: el modelo ${modelo} no es de Claude`);
  dockerLib.validarOpcionCli(modelo, `modelo de la tarea ${t.id}`);
  if (niveles.modeloBloqueado('claude', modelo)) throw new Error(`Tarea ${t.id}: el modelo ${modelo} no se ofrece`);
  if (!effortPedido) return null;
  if (!niveles.admiteNivel('claude', modelo, effortPedido)) {
    const n = niveles.nivelesPara('claude', modelo);
    throw new Error(`Tarea ${t.id}: ${modelo} no admite el esfuerzo ${effortPedido}${n.admite ? ` (admite ${n.niveles.join(', ')})` : ' (no admite esfuerzo)'}`);
  }
  return String(effortPedido).toLowerCase();
}

/**
 * FEAT-153 — Los pedidos de reescritura agrupados por motor, en el orden en que aparecen:
 * `[{ motor, cuenta, pedidos }]`. Un pedido sin Escribir con motor propio va con el motor del lote.
 */
function gruposPorMotor(lista, escritores, lote) {
  const grupos = new Map();
  for (const x of lista) {
    const e = x.nodo ? escritores[x.nodo.id] : null;
    const motor = e ? e.motor : lote.motor;
    const cuenta = motor === 'claude' ? (e ? e.cuenta : lote.cuenta) : null;
    const clave = motor === 'claude' ? `claude@${cuenta}` : 'antigravity';
    if (!grupos.has(clave)) grupos.set(clave, { motor, cuenta, pedidos: [] });
    grupos.get(clave).pedidos.push(x);
  }
  return [...grupos.values()];
}

/**
 * FEAT-153 — `reescribir(lista)` por motor y en serie: antes de cada grupo se destruyen las credenciales
 * vigentes y se crean las de su motor (los volúmenes del lote son uno solo: nunca hay dos vivas); al
 * final, pase lo que pase, vuelven las de agy para verificar y auditar. `credenciales` es `{ leer, poner }`
 * sobre la variable del lote (el auditor las lee al usarlas) y `crear(motor, cuenta)` arma unas nuevas.
 */
function reescribirPorMotor({ reescritor, escritores, lote, credenciales, crear }) {
  return async function reescribir(lista) {
    const grupos = gruposPorMotor(lista, escritores, lote);
    if (grupos.length === 1 && grupos[0].motor !== 'claude' && credenciales.leer().motor !== 'claude') return reescritor(lista);
    const hechos = [];
    try {
      for (const g of grupos) {
        if (!(g.motor === 'antigravity' && credenciales.leer().motor !== 'claude')) {
          await credenciales.leer().destruir();
          credenciales.poner(crear(g.motor, g.cuenta));
        }
        hechos.push(...await reescritor(g.pedidos));
      }
      return hechos;
    } finally {
      if (credenciales.leer().motor === 'claude') {
        await credenciales.leer().destruir();
        credenciales.poner(crear('antigravity', null));
      }
    }
  };
}

function enteroAcotado(valor, defecto, min, max, nombre) {
  if (valor == null || valor === '') return defecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nombre} debe estar entre ${min} y ${max}`);
  return n;
}

function crearServicioLotes({
  registro,
  config = {},
  docker = dockerLib.crearDocker({}),
  aWsl = dockerLib.crearTraductorDeRutas({}),
  ejecutarStream,
  ejecutarStdin,
  terminarCliente,
  registrarUso = () => {},
  recolectar = recolectarPorDefecto,
  adquirirLock = adquirirBloqueo,
  liberarLock = liberarBloqueo,
  fanout = lanzarFanout,
  crearVerificadorFn = crearVerificador,
  crearAuditorFn = crearAuditor,
  raizCopias = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'lagrange', 'lotes'),
  log = (linea) => process.stderr.write(`[lotes] ${linea}\n`),
  reloj = Date.now,
  leerCuerpoSkill = (nombre) => registroAgentes.leerCuerpoSkill(nombre, os.homedir()),
  // FEAT-107 — `(modelo) => { agotada, hasta, … } | null`; sin ella, no se mira la cuota.
  revisarCuota = null,
  // FEAT-131 — Uso de las tareas con Claude (`registrarLlamada` de uso-agy.js),
  // con su cuota de 5 h; y dónde están las sondas `edicion` por cuenta.
  registrarLlamada = null,
  dirDatos = null,
  verificarSondasClaude = async (cuenta) => {
    if (!dirDatos) return { ok: false, motivo: 'sin directorio de datos para leer las sondas' };
    return sondasClaude.sondasVigentes(sondasClaude.rutaSondas(dirDatos), cuenta, await sondasClaude.huellaActual(docker));
  }
} = {}) {
  if (!registro) throw new Error('crearServicioLotes necesita un registro');

  // FEAT-011: con qué se lee la skill de una tarea y qué se le exige a su
  // cuerpo. Una ruta absoluta del host no existe dentro del contenedor, igual
  // que en el prompt. Va por deps porque fanout.js no puede requerir este
  // módulo sin armar un ciclo.
  // FEAT-149 — Las recetas viven en el directorio de datos del bridge; sin él, solo la clásica.
  const almacenRecetas = dirDatos ? recetas.crearAlmacenRecetas(dirDatos) : null;

  /** La receta efectiva del pedido: `{ id, version?, cambios? }` o `"id"` / `"id@vN"`. */
  function recetaDelPedido(valor) {
    if (valor == null || valor === '') return recetas.aplicarCambios(recetas.CLASICA, {});
    let ref = valor;
    if (typeof valor === 'string') {
      const m = /^([a-z0-9][a-z0-9-]{0,63})(?:@v(\d{1,4}))?$/.exec(valor.trim());
      if (!m) throw new Error(`receta inválida: ${JSON.stringify(valor).slice(0, 60)} (usá "id" o "id@vN")`);
      ref = { id: m[1], version: m[2] ? Number(m[2]) : null };
    }
    if (!ref || typeof ref !== 'object') throw new Error('receta debe ser "id", "id@vN" o { id, version, cambios }');
    const base = ref.id === recetas.CLASICA.id || !almacenRecetas
      ? (ref.id === recetas.CLASICA.id ? recetas.CLASICA : (() => { throw new Error('no hay directorio de datos para leer recetas'); })())
      : almacenRecetas.leer(ref.id, ref.version ?? null);
    return recetas.aplicarCambios(base, ref.cambios || {});
  }

  const depsDeSkill = {
    leerCuerpoSkill,
    validarCuerpo: (cuerpo) => (ABSOLUTA_EN_PROMPT.test(cuerpo) ? 'la SKILL menciona una ruta absoluta del host' : null)
  };

  function validarSolicitud(datos = {}) {
    const id = dockerLib.validarId(String(datos.slug || datos.id || '').trim(), 'slug del lote');
    const repoPath = path.resolve(String(datos.cwd || datos.repoPath || process.cwd()));
    const { motor, cuenta } = motorDelPedido(datos.motor, config);
    const esClaude = motor === 'claude';
    const modeloBase = datos.modelo || (esClaude ? MODELO_CLAUDE_POR_DEFECTO : (config.defaultModel || 'gemini-3.8-flash'));
    const crudas = Array.isArray(datos.tareas) ? datos.tareas : [];
    const receta = recetaDelPedido(datos.receta);
    if (crudas.length < 1 || crudas.length > 6) throw new Error('un lote necesita entre 1 y 6 tareas');
    const timeoutMinutes = enteroAcotado(datos.timeout_minutes, 45, 1, 45, 'timeout_minutes');
    const concurrencia = enteroAcotado(datos.concurrencia, 3, 1, 3, 'concurrencia');
    const tareas = crudas.map((cruda) => {
      const t = { ...cruda };
      dockerLib.validarId(t.id, 'id de la tarea');
      const original = String(t.prompt || '');
      if (!original.trim()) throw new Error(`Tarea ${t.id}: falta prompt`);
      // FEAT-149 — La plantilla del escritor va dentro de [TAREA]; las reglas siguen antes (fanout).
      const prompt = recetas.renderPlantilla(receta.nodos.escribir.plantilla, { prompt: original, archivos: t.archivos || [] });
      if (Buffer.byteLength(prompt) > 100 * 1024) throw new Error(`Tarea ${t.id}: el prompt supera 100 KB`);
      if (ABSOLUTA_EN_PROMPT.test(prompt)) throw new Error(`Tarea ${t.id}: el prompt menciona una ruta absoluta del host`);
      if (!Array.isArray(t.archivos) || t.archivos.length < 1 || t.archivos.length > 32) {
        throw new Error(`Tarea ${t.id}: archivos debe tener entre 1 y 32 entradas`);
      }
      for (const archivo of t.archivos) {
        const normal = String(archivo || '').replace(/\\/g, '/');
        if (normal.startsWith('/') || /^[A-Za-z]:\//.test(normal)) throw new Error(`Tarea ${t.id}: ruta absoluta rechazada: ${archivo}`);
      }
      const modelo = t.modelo || modeloBase;
      let effort;
      if (esClaude) {
        // Sin esfuerzo por defecto: el implícito de cada modelo (niveles.js).
        effort = validarModeloClaude(t, modelo, t.effort || datos.effort);
      } else {
        effort = esfuerzoParaCli({ modelo, pedido: t.effort || datos.effort, porDefecto: config.defaultEffort || 'low' });
        const incompatibilidad = validarModeloEsfuerzo(['--model', modelo, ...(effort ? ['--effort', effort] : [])]);
        if (incompatibilidad) throw new Error(`Tarea ${t.id}: ${incompatibilidad}`);
      }
      validarPrueba(t.prueba);
      const modeloAuditor = t.modelo_auditor || datos.modelo_auditor || receta.nodos.auditar.modelo || null;
      elegirModeloAuditor(modelo, modeloAuditor);
      // BE-096 — Un modelo sin esfuerzo (Claude, GPT-OSS) da `effort` null: la tarea va
      // SIN la clave (validarReparto rechaza null) y el argv sale sin `--effort`.
      const { effort: _pedido, ...resto } = t;
      return { ...resto, prompt, ...(receta.nodos.escribir.vueltas ? { promptOriginal: original } : {}), archivos: t.archivos.map(String), modelo, ...(effort ? { effort } : {}), modelo_auditor: modeloAuditor,
        // FEAT-149 — La skill de la receta es el defecto; la de la tarea gana.
        ...(!t.skill && receta.nodos.escribir.skill ? { skill: receta.nodos.escribir.skill } : {}) };
    });
    const escritores = escritoresDelGrafo(receta, tareas, { datos, motorLote: motor, cuentaLote: cuenta });
    const reparto = validarReparto(tareas);
    if (!reparto.valido) throw new Error(explicarReparto(reparto));
    // FEAT-107 — Con la cuota guardada de un grupo agotado, ni escritores ni
    // auditores pueden correr: no se arma nada. Lo usan el MCP y la consola web.
    // FEAT-131 — Con Claude no se frena por la cuota de agy: el caso de uso es
    // justo Gemini agotado. Si al auditor le falta cuota, su auditoría queda en
    // error y el lote no se integra hasta auditarlo (plan §12.3).
    if (typeof revisarCuota === 'function' && !esClaude) {
      const modelos = [...tareas.flatMap((t) => [t.modelo, elegirModeloAuditor(t.modelo, t.modelo_auditor)]), ...Object.values(escritores).filter((e) => e.motor !== 'claude').map((e) => e.modelo)];
      const cuotaAgy = require('../lib/cuota-agy.js');
      const sin = cuotaAgy.primerModeloSinCuota(modelos, revisarCuota);
      if (sin) throw new Error(cuotaAgy.textoSinCuota(sin));
    }
    // FEAT-011: la skill se resuelve acá, antes del lock y del registro, y se
    // descarta el resultado: el cuerpo no viaja en la reserva. lanzarFanout la
    // vuelve a leer con las mismas deps, así que si cambió en el medio se mide
    // de nuevo.
    const preparadas = prepararTareas(tareas, { ...depsDeSkill, contenedor: true });
    if (!preparadas.ok) throw new Error(preparadas.detalle);
    // FEAT-153 — Las cuentas de Claude de los nodos (además de la del lote): el preflight las chequea todas.
    // FEAT-155 — También las de los Jueces y Advisors de Claude.
    const cuentasNodos = [...new Set([...Object.values(escritores).filter((e) => e.motor === 'claude').map((e) => e.cuenta), ...cuentasDeRevisores(receta)]
      .filter((c) => !(esClaude && c === cuenta)))];
    // F4b — Las skills que puede usar el lote (tareas y Escribir de la receta), medidas al lanzar.
    const skills = [...new Set([...tareas.map((t) => t.skill), ...(receta.forma === grafoReceta.FORMA_GRAFO
      ? Object.values(receta.grafo.nodos).filter((n) => n.tipo === 'escribir').map((n) => n.skill) : [])].filter(Boolean))];
    const huellas = Object.fromEntries(skills.map((s) => [s, huellaSkill(leerCuerpoSkill(s))]));
    return { id, slug: id, repoPath, modeloBase, tareas, timeoutMinutes, concurrencia, motor, cuenta, receta, escritores, cuentasNodos, huellas };
  }

  /**
   * F4a / FEAT-153 — Los Escribir de un grafo que no son el primero (un plan B) con motor o modelo
   * propio: se validan como los de una tarea (cuenta, modelo, esfuerzo) y se devuelven
   * `{ [nodo]: { motor, cuenta, modelo, effort? } }` para el reescritor. Ningún Juez puede ser de la
   * familia de un escritor: ni el modelo auditor de la tarea contra un plan B, ni un Juez con modelo
   * propio contra nadie.
   */
  function escritoresDelGrafo(receta, tareas, { datos, motorLote, cuentaLote }) {
    if (receta.forma !== grafoReceta.FORMA_GRAFO) return {};
    const g = receta.grafo;
    const e1 = grafoReceta.primerEscribir(g);
    const juez1 = Object.keys(g.nodos).find((id) => g.nodos[id].tipo === 'juez');
    const escritores = {};
    for (const [id, n] of Object.entries(g.nodos)) {
      if (n.tipo !== 'escribir' || id === e1 || (!n.modelo && !n.motor)) continue;
      const { motor, cuenta } = n.motor ? motorDelPedido(n.motor, config) : { motor: motorLote, cuenta: cuentaLote };
      const claude = motor === 'claude';
      const modelo = n.modelo || (claude ? MODELO_CLAUDE_POR_DEFECTO : (config.defaultModel || 'gemini-3.8-flash'));
      // El esfuerzo del lote se eligió para el modelo de las tareas: si el del nodo no lo admite, va el suyo por defecto.
      const pedido = datos.effort && niveles.admiteNivel(claude ? 'claude' : 'antigravity', modelo, datos.effort) ? datos.effort : null;
      let effort;
      if (claude) effort = validarModeloClaude({ id }, modelo, pedido);
      else {
        effort = esfuerzoParaCli({ modelo, pedido, porDefecto: config.defaultEffort || 'low' });
        const incompatibilidad = validarModeloEsfuerzo(['--model', modelo, ...(effort ? ['--effort', effort] : [])]);
        if (incompatibilidad) throw new Error(`Nodo ${id}: ${incompatibilidad}`);
      }
      escritores[id] = { motor, cuenta, modelo, ...(effort ? { effort } : {}) };
    }
    const deEscritores = [...new Set([...tareas.map((t) => t.modelo), ...Object.values(escritores).map((e) => e.modelo)])];
    for (const t of tareas) {
      if (t.modelo_auditor) for (const e of Object.values(escritores)) elegirModeloAuditor(e.modelo, t.modelo_auditor);
    }
    for (const [id, n] of Object.entries(g.nodos)) {
      if (!['juez', 'advisor'].includes(n.tipo)) continue;
      // FEAT-155 — Un Juez o Advisor de Claude: la cuenta declarada, un modelo del catálogo y de otra familia que
      // todo escritor (también el que elige por defecto).
      if (String(n.motor || '').startsWith('claude@')) {
        motorDelPedido(n.motor, config);
        if (n.modelo) validarModeloClaude({ id }, n.modelo, null);
        for (const m of deEscritores) elegirModeloAuditor(m, n.modelo || null, { motor: 'claude' });
        continue;
      }
      // F4b — Un Advisor con modelo propio también es de agy y distinto de todo escritor.
      if (!((n.tipo === 'juez' && id !== juez1) || n.tipo === 'advisor') || !n.modelo) continue;
      for (const m of deEscritores) elegirModeloAuditor(m, n.modelo);
    }
    return escritores;
  }

  /** FEAT-155 — Las cuentas de Claude de los Jueces y Advisors de un grafo (para el preflight). */
  function cuentasDeRevisores(receta) {
    if (receta.forma !== grafoReceta.FORMA_GRAFO) return [];
    return Object.values(receta.grafo.nodos)
      .filter((n) => ['juez', 'advisor'].includes(n.tipo) && String(n.motor || '').startsWith('claude@'))
      .map((n) => motorDelPedido(n.motor, config).cuenta);
  }

  /**
   * F3 — Los chequeos del entorno, uno por línea y sin cortar: `{ id, texto, ok, motivo }`. Si
   * Docker no responde, los que dependen de él quedan sin correr («no se pudo comprobar»).
   * `comprobarPreflight` corta en el primero que falla, con el mismo texto de siempre.
   */
  async function chequeosPreflight(solicitud = {}) {
    const lista = [];
    const chequeo = async (id, texto, fn) => {
      try { const motivo = await fn(); lista.push({ id, texto, ok: !motivo, motivo: motivo || null }); }
      catch (err) { lista.push({ id, texto, ok: false, motivo: String(err?.message || err) }); }
    };
    const inspeccionar = async (que, nombre, siFalta) => {
      const r = await docker([que, 'inspect', nombre], { permitirFallo: true });
      return r.code !== 0 ? siFalta : null;
    };
    await chequeo('docker', 'Docker en WSL', async () => {
      try { await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30000 }); return null; }
      catch (err) { return `Docker en WSL no responde: ${err.message}. Probá wsl -e docker version.`; }
    });
    const pasos = [];
    for (const imagen of [dockerLib.IMAGEN_AGY, dockerLib.IMAGEN_PROXY, dockerLib.IMAGEN_VERIFICADOR]) {
      pasos.push([`imagen:${imagen}`, `Imagen ${imagen}`, () => inspeccionar('image', imagen, `Falta la imagen ${imagen}. Construila con npm run lotes -- imagenes.`)]);
    }
    pasos.push(['volumen-credenciales', 'Login de agy (volumen de credenciales)', () => inspeccionar('volume', dockerLib.VOLUMEN_CREDENCIALES, `Falta el volumen ${dockerLib.VOLUMEN_CREDENCIALES}. Hacé login con npm run lotes -- login.`)]);
    for (const ca of [dockerLib.VOLUMEN_CA_PRIVADA, dockerLib.VOLUMEN_CA_PUBLICA]) {
      pasos.push([`volumen:${ca}`, `Volumen TLS ${ca}`, () => inspeccionar('volume', ca, `Falta el volumen TLS ${ca}. Prepará la CA con npm run lotes -- imagenes.`)]);
    }
    pasos.push(['ca', 'CA TLS del proxy', async () => {
      const ca = await docker(dockerLib.argvVerificarCA(), { permitirFallo: true });
      return ca.code !== 0 ? 'La CA TLS del proxy está incompleta, vencida o no coincide.' : null;
    }]);
    // FEAT-153 — La cuenta del lote y las de los nodos de Claude: cada una con su login y sus sondas.
    const cuentasClaude = [...new Set([...(solicitud.motor === 'claude' ? [solicitud.cuenta] : []), ...(solicitud.cuentasNodos || [])])];
    if (cuentasClaude.length) {
      pasos.push(['imagen-claude', `Imagen ${dockerLib.IMAGEN_CLAUDE}`, () => inspeccionar('image', dockerLib.IMAGEN_CLAUDE, `Falta la imagen ${dockerLib.IMAGEN_CLAUDE}. Construila con npm run lotes -- imagenes-claude.`)]);
    }
    for (const c of cuentasClaude) {
      const sufijo = c === solicitud.cuenta && solicitud.motor === 'claude' ? '' : `:${c}`;
      pasos.push([`login-claude${sufijo}`, `Login de Claude de ${c}`, () => inspeccionar('volume', dockerLib.volumenLoginClaude(c), `Falta el login de Claude de ${c}. Hacé login con npm run lotes -- login-claude ${c}.`)]);
      pasos.push([`sondas-claude${sufijo}`, `Sondas de Claude de ${c}`, async () => {
        const sondas = await verificarSondasClaude(c);
        return sondas.ok ? null : `Claude en el lote no está habilitado para ${c}: ${sondas.motivo}.`;
      }]);
    }
    // FEAT-154 — Con una imagen de lotes a medio reconstruir (desde la consola) no arranca ni se reanuda nada.
    pasos.push(['imagen-en-construccion', 'Ninguna imagen de lotes en construcción', () => motivoConstruyendo()]);
    const dockerVivo = lista[0].ok;
    for (const [id, texto, fn] of pasos) {
      if (dockerVivo) await chequeo(id, texto, fn);
      else lista.push({ id, texto, ok: false, sinComprobar: true, motivo: 'no se pudo comprobar: Docker no responde' });
    }
    return lista;
  }

  /** FEAT-154 — El motivo para no arrancar si hay una imagen en construcción (marcador en el directorio de datos). */
  function motivoConstruyendo() {
    const m = imagenesLib.marcadorVivo(dirDatos);
    return m ? `se está reconstruyendo la imagen de ${m.harness} desde la consola: esperá a que termine` : null;
  }

  async function comprobarPreflight(solicitud = {}) {
    const falla = (await chequeosPreflight(solicitud)).find((c) => !c.ok);
    if (falla) throw new Error(falla.motivo);
  }

  /**
   * F4b — Lo que necesita `reanudar` para rearmar el lote sin la reserva, quizás en otro proceso: las
   * tareas ya validadas (prompt, archivos, modelos, nombre de skill y prueba), el motor, los escritores
   * de la receta y las huellas de las skills. Nunca el cuerpo de una skill ni credenciales.
   */
  function pedidoGuardable(s) {
    return JSON.parse(JSON.stringify({
      tareas: s.tareas, motor: s.motor, cuenta: s.cuenta, modeloBase: s.modeloBase, timeoutMinutes: s.timeoutMinutes,
      concurrencia: s.concurrencia, escritores: s.escritores || {}, cuentasNodos: s.cuentasNodos || [], huellas: s.huellas || {}
    }));
  }

  async function preparar(datos) {
    const solicitud = validarSolicitud(datos);
    // FEAT-149 — Aviso temprano: los comandos que nombra la receta tienen que estar declarados en el
    // commit actual. Lo autoritativo se lee al verificar, desde la base de cada tarea (comandos-repo.js).
    if (solicitud.receta.nodos.verificar.comandos.length) {
      comandosRepo.resolverComandos(await comandosRepo.leerComandosRepo(solicitud.repoPath, 'HEAD'), solicitud.receta.nodos.verificar.comandos);
    }
    const previo = registro.leer(solicitud.id);
    if (previo && !ESTADOS_FINALES.includes(previo.estado)) throw new Error(`ya existe un lote ${solicitud.id} (${previo.estado})`);
    const lock = adquirirLock(solicitud.repoPath, solicitud.id);
    try {
      await comprobarPreflight(solicitud);
      registro.marcarInterrumpidos();
      try {
        await recolectar({
          docker,
          lotesCorriendo: registro.listar().filter((l) => ['corriendo', 'verificando', 'auditando'].includes(l.estado)).map((l) => l.id),
          raizCopias
        });
      } catch {}
      // FEAT-154 — Otra vez, pegado al alta: la consola toma el marcador y después mira el registro.
      const construyendo = motivoConstruyendo();
      if (construyendo) throw new Error(construyendo);
      registro.crear({ id: solicitud.id, repo: solicitud.repoPath, ramaBase: '(pendiente)', modelo: solicitud.modeloBase,
        ...(solicitud.motor === 'claude' ? { motor: `claude@${solicitud.cuenta}` } : {}),
        receta: solicitud.receta,
        pedido: pedidoGuardable(solicitud),
        tareas: solicitud.tareas.map((t) => ({ id: t.id, modelo: t.modelo, skill: t.skill })) });
      return { ...solicitud, lock, preparado: true, ejecutado: false };
    } catch (err) {
      liberarLock(lock);
      throw err;
    }
  }

  function marcarFallido(id) {
    try {
      const lote = registro.leer(id);
      if (lote && ['corriendo', 'verificando', 'auditando'].includes(lote.estado)) registro.cambiarEstado(id, 'fallido');
    } catch {}
  }

  /** El vencimiento de las credenciales del lote: cada vuelta repite escritura, prueba, comandos y auditoría. */
  function vencimiento({ tareas, timeoutMinutes, receta }) {
    // FEAT-149 — Cada comando del repo suma su tope máximo (15 min) por tarea: se resuelven recién al verificar.
    const minutosComandos = receta.nodos.verificar.comandos.length * comandosRepo.MAX_MINUTOS;
    const minutosPrueba = tareas.reduce((n, t) => n + (t.prueba ? (Number(t.prueba.timeout_minutes) || 10) : 0) + minutosComandos, 0);
    // FEAT-149 F2 — Cada vuelta del bucle repite escritura, prueba, comandos y auditoría de la tarea.
    const rondas = 1 + (receta.nodos.escribir.vueltas || 0);
    return Math.floor((reloj() + ((timeoutMinutes * tareas.length + minutosPrueba + 50 * tareas.length) * rondas + 60) * 60000) / 1000);
  }

  /**
   * FEAT-153 — Un pedido de reescritura de un Escribir con motor propio trae `motor`/`cuenta`; el resto usa los del
   * lote. `cred.leer()` da las credenciales vigentes (cambian por fase).
   */
  function crearEjecutarTarea({ id, repoPath, motor, cuenta, timeoutMinutes, expiraEpoch, cred, control }) {
    return async (pedido) => {
      const { motor: motorPedido, cuenta: cuentaPedido, ...peticion } = pedido;
      const motorP = motorPedido || motor;
      const cuentaP = motorPedido ? cuentaPedido : cuenta;
      let fd = null;
      if (config.fanoutProgressLog !== false) { try { fd = fs.openSync(rutaProgreso(repoPath, id, peticion.taskId), 'a'); } catch {} }
      const onLine = fd === null ? undefined : (linea) => { try { fs.writeSync(fd, `${linea}\n`); } catch {} };
      const runner = crearEjecutorContenedor({ docker, ejecutarStream, credenciales: cred.leer(), idLote: id, raizCopias, expiraEpoch, aWsl, onLine,
        stopCheck: control ? () => control.consumirDetencion(peticion.taskId) : undefined,
        terminarCliente, timeoutMinutesPorDefecto: timeoutMinutes, motor: motorP });
      try {
        const r = await runner(peticion);
        const d = r.data || {};
        if (motorP === 'claude' && typeof registrarLlamada === 'function') {
          // FEAT-131 — Con la cuenta y su cuota de 5 h: la ven el panel y el diálogo de FEAT-111.
          registrarLlamada({
            tool: 'lote', motor: `claude@${cuentaP}`, modelo: peticion.model, modeloReal: d.modelo_real || null,
            esfuerzo: peticion.effort || null, conversationId: d.conversation_id || null, duracion: d.duration_seconds || 0,
            usage: d.usage || null, error: r.success ? null : (r.error || 'falló'), costoUsd: d.costo_usd ?? null, cuota: d.cuota || null
          });
        } else if (motorP !== 'claude') {
          registrarUso('run', peticion.model || config.defaultModel, peticion.effort, d.conversation_id || '', d.duration_seconds || 0, d.usage, !r.success, r.error || '');
        }
        return r;
      } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
    };
  }

  /**
   * Las etapas después de la primera escritura: verificar, auditar, aconsejar y reescribir (el caminante). La usan
   * `ejecutar` (con los resultados del fan-out) y `reanudar` (F4b, con las fichas guardadas). Las credenciales
   * vigentes al llamarla son las de agy.
   */
  async function correrRevision({ id, repoPath, tareas, receta, motor, cuenta, escritores, concurrencia, timeoutMinutes, expiraEpoch, cred,
    ejecutarTarea, registrarEstado, resultados = null, reanudar = false }) {
    const verificar = crearVerificadorFn({ docker, aWsl, raizCopias, idLote: id, expiraEpoch });
    // F2 — Las credenciales cambian por fase (Claude escribe, agy audita): el auditor las lee al usarlas.
    const credencialesVivas = {
      asegurarVida: (minutos) => cred.leer().asegurarVida(minutos),
      get volumenSecretoProxy() { return cred.leer().volumenSecretoProxy; },
      get motor() { return cred.leer().motor; },
      get cuenta() { return cred.leer().cuenta; }
    };
    // FEAT-155 — Un Juez de Claude corre como una tarea de Claude y registra su uso con la cuenta.
    const auditar = crearAuditorFn({ docker, aWsl, raizCopias, idLote: id, expiraEpoch, credenciales: credencialesVivas, ejecutarStdin, ejecutarStream, registrarLlamada, terminarCliente, log });
    // FEAT-155 — Antes de cada subgrupo de Jueces o Advisors: las credenciales de su motor (nunca dos vivas a la vez).
    const prepararMotor = async (motorJuez, cuentaJuez) => {
      const vigentes = cred.leer();
      const igual = motorJuez === 'claude' ? (vigentes.motor === 'claude' && vigentes.cuenta === cuentaJuez) : vigentes.motor !== 'claude';
      if (igual) return;
      await vigentes.destruir();
      cred.poner(crearCredenciales({ docker, idLote: id, expiraEpoch, ...(motorJuez === 'claude' ? { motor: 'claude', cuenta: cuentaJuez } : {}) }));
    };
    const reescritor = receta.nodos.escribir.vueltas
      ? crearReescritor({ ejecutarTarea, depsDeSkill, registrarEstado, plantilla: receta.nodos.escribir.plantilla, escritores: escritores || {}, concurrencia, timeoutMinutes })
      : null;
    // FEAT-153 — Por motor y en serie: cada grupo con sus credenciales (los volúmenes del lote son uno solo, así que
    // nunca hay dos vivas) y, al final, las de agy de vuelta para verificar y auditar.
    const reescribir = reescritor && reescribirPorMotor({
      reescritor, escritores: escritores || {}, lote: { motor, cuenta }, credenciales: cred,
      crear: (m, c) => crearCredenciales({ docker, idLote: id, expiraEpoch, ...(m === 'claude' ? { motor: m, cuenta: c } : {}) })
    });
    await revisarLote({ slug: id, tareas, resultados, registro, verificar, auditar, receta, repo: repoPath,
      concurrencia, reescribir, baseDeTarea: comandosRepo.baseDeTarea, reanudar, reloj, prepararMotor,
      registrarUso: (a) => registrarUso('audit', a.modelo, null, a.conversation_id || '', a.duracionMs / 1000, a.usage, false, '') });
  }

  /** F4c — El «ejecutar» del fan-out de un grafo que empieza en el Semáforo: no corre nada, devuelve la punta del worktree. */
  async function puntaDelWorktree({ cwd }) {
    const r = await gitDeRepo(cwd)(['rev-parse', 'HEAD']);
    return r.code === 0 ? { success: true, commit: r.stdout.trim(), intentos: 1 } : { success: false, error: `no se pudo leer la punta de ${cwd}`, intentos: 1 };
  }

  async function ejecutar(reserva) {
    if (!reserva?.preparado || reserva.ejecutado) throw new Error('reserva de lote inválida o ya consumida');
    reserva.ejecutado = true;
    const { id, repoPath, tareas, modeloBase, timeoutMinutes, concurrencia } = reserva;
    const motor = reserva.motor || 'antigravity';
    const cuenta = reserva.cuenta || null;
    const receta = reserva.receta || recetas.aplicarCambios(recetas.CLASICA, {});
    const expiraEpoch = vencimiento({ tareas, timeoutMinutes, receta });
    let credenciales = null;
    const cred = { leer: () => credenciales, poner: (c) => { credenciales = c; } };
    let cerrarEstado = () => {};
    try {
      credenciales = crearCredenciales({ docker, idLote: id, expiraEpoch, motor, cuenta });
      const escritor = config.fanoutStatusline !== false ? crearEscritorDeEstado(repoPath, id, tareas) : null;
      const registrarEstado = {
        iniciar(datos) {
          const actual = registro.leer(id);
          registro.guardar({ ...actual, ramaBase: datos.ramaBase, tareas: actual.tareas.map((t) => ({
            ...t,
            rama: datos.meta?.[t.id]?.rama || t.rama,
            worktree: datos.meta?.[t.id]?.rama ? path.join(repoPath, '.claude', 'worktrees', datos.meta[t.id].rama.replace(/^wt\//, '')) : t.worktree
          })) });
          escritor?.iniciar(datos);
        },
        marcar(tareaId, datos) { escritor?.marcar(tareaId, datos); },
        terminar() { escritor?.terminar(); }
      };
      // FEAT-149 F2 — El fan-out cierra el estado al terminar la ronda 1; con vueltas, el lote sigue:
      // se cierra una sola vez, al final (auditoría del plan, r1).
      const estadoDelFanout = { ...registrarEstado, terminar() {} };
      cerrarEstado = () => registrarEstado.terminar();
      const control = config.fanoutControl !== false ? crearLectorDeControl(repoPath, id) : null;
      const ejecutarTarea = crearEjecutarTarea({ id, repoPath, motor, cuenta, timeoutMinutes, expiraEpoch, cred, control });

      // F4c — Un grafo que empieza en el Semáforo no escribe en el fan-out: solo arma rama base y worktrees, y cada
      // tarea sale con la punta de su rama (las que escriben son las ramas).
      const g = grafoReceta.grafoDeReceta(receta);
      const sinEscribir = g.nodos[grafoReceta.nodoInicial(g)]?.tipo === 'semaforo';
      const salida = await fanout({ repoPath, slug: id, tareas, concurrencia, modelo: modeloBase, timeoutMinutes, contenedor: true }, {
        ejecutar: sinEscribir ? puntaDelWorktree : ejecutarTarea,
        registrarEstado: estadoDelFanout,
        ...depsDeSkill,
        limpiarControlPrevio: control ? (taskId) => control.limpiar(taskId) : undefined,
        limpiarProgresoPrevio: config.fanoutProgressLog !== false ? (taskId) => limpiarProgreso(repoPath, id, taskId) : undefined
      });
      if (!salida.lanzado) throw new Error(salida.detalle || 'el lote no se lanzó');
      if (motor === 'claude') {
        // FEAT-131 — El auditor sigue siendo agy, y usa los mismos volúmenes del
        // lote (`lote-<id>-token`, `-proxy-secreto`). Con las tareas ya
        // terminadas, las credenciales de Claude se destruyen y se arman las de
        // agy: el auditor nunca ve el señuelo de Claude (hallado en la prueba
        // de punta a punta: «authentication required» en las dos auditorías).
        await credenciales.destruir();
        credenciales = crearCredenciales({ docker, idLote: id, expiraEpoch });
      }
      await correrRevision({ id, repoPath, tareas, receta, motor, cuenta, escritores: reserva.escritores, concurrencia, timeoutMinutes, expiraEpoch,
        cred, ejecutarTarea, registrarEstado, resultados: salida.resultados });
      return registro.leer(id);
    } catch (err) {
      marcarFallido(id);
      throw new Error(dockerLib.sanitizarSalida(err.message).slice(0, 500));
    } finally {
      try { cerrarEstado(); } catch {}
      try { await credenciales?.destruir(); } catch {}
      liberarLock(reserva.lock);
      releerRespuestas(id);
    }
  }

  /** F4b — El motivo por el que un lote que espera no se pudo reanudar (lo muestra la consola). */
  function anotarEspera(id, motivo) {
    try {
      const lote = registro.leer(id);
      if (lote && lote.estado === ESPERANDO_HUMANO) { lote.esperaMotivo = motivo ? dockerLib.sanitizarSalida(motivo).slice(0, 300) : null; registro.guardar(lote); }
    } catch {}
  }

  /** F4b — Las tareas que esperan y ya tienen respuesta guardada. */
  function respondidas(lote) {
    if (!lote || lote.estado !== ESPERANDO_HUMANO) return [];
    const respuestas = registro.leerRespuestas(lote.id);
    return (lote.tareas || []).filter((t) => t.humano?.estado === 'esperando' && t.ficha && respuestas[t.id]);
  }

  /**
   * F4b — Después de soltar el lock: si llegó una respuesta mientras el caminante corría (y el que respondió no
   * pudo tomar el lock), se reanuda acá. Quien responde guarda antes de intentar el lock y quien tiene el lock
   * relee después de soltarlo: alguno de los dos la ve.
   */
  function releerRespuestas(id) {
    let lote = null;
    try { lote = registro.leer(id); } catch {}
    if (respondidas(lote).length) reanudarEnSegundoPlano(id);
  }

  /**
   * F4b — Guarda la respuesta del usuario a una tarea que espera. `accion`: corregir (con `texto`), aprobar o
   * cancelar. No reanuda: eso lo hace `reanudar` (la consola lo llama justo después).
   */
  function responderHumano({ id, tarea, accion, texto = null } = {}) {
    const lote = registro.leer(id);
    if (!lote) throw new Error(`no hay lote ${id}`);
    if (ESTADOS_FINALES.includes(lote.estado)) throw new Error(`el lote ${id} está "${lote.estado}"`);
    const t = (lote.tareas || []).find((x) => x.id === tarea);
    if (!t) throw new Error(`el lote ${id} no tiene la tarea ${tarea}`);
    if (t.humano?.estado !== 'esperando' || !t.ficha) throw new Error(`la tarea ${tarea} no está esperando una respuesta`);
    // F4c — Con un conflicto de Juntar pendiente, también «seguir sin las ramas que chocaron» y «ya lo resolví».
    const conConflicto = !!(t.conflicto && t.conflicto.commit);
    if (!ACCIONES_HUMANO.includes(accion) && !(conConflicto && ACCIONES_CONFLICTO.includes(accion))) {
      throw new Error(`acción inválida: ${JSON.stringify(accion)} (corregir, aprobar o cancelar${conConflicto ? ', sin-conflictos o resuelto-a-mano' : ''})`);
    }
    const limpio = texto == null ? '' : String(texto).trim();
    if (accion === 'corregir' && !limpio) throw new Error('para corregir hacen falta indicaciones');
    if (Buffer.byteLength(limpio) > MAX_TEXTO_HUMANO) throw new Error(`las indicaciones superan ${MAX_TEXTO_HUMANO} bytes`);
    registro.guardarRespuesta(id, tarea, { accion, texto: limpio || null, cuando: new Date().toISOString() });
    return { ok: true, id, tarea, accion };
  }

  /**
   * F4b — Reanuda un lote que espera, si tiene respuestas: toma el lock del repo, comprueba que las skills no
   * cambiaron y el entorno (preflight), y corre el caminante desde las fichas guardadas. Si algo falla antes de
   * correr, la respuesta queda guardada y el lote sigue esperando, con el motivo. Con el lock tomado (otro lote
   * del repo, u otra reanudación) no hace nada: lo reintenta quien lo suelte, o el barrido del daemon.
   */
  async function reanudar(id) {
    const lote = registro.leer(id);
    if (!respondidas(lote).length) return { reanudado: false, motivo: 'no hay respuestas para aplicar' };
    const p = lote.pedido;
    if (!p || !Array.isArray(p.tareas)) { anotarEspera(id, 'el lote no guardó su pedido: no se puede reanudar (descartalo)'); return { reanudado: false, motivo: 'sin pedido' }; }
    let lock;
    try { lock = adquirirLock(lote.repo, id); } catch (err) { return { reanudado: false, motivo: err.message }; }
    let credenciales = null;
    let retomado = false;
    try {
      const cambiada = Object.entries(p.huellas || {}).find(([s, h]) => huellaSkill(leerCuerpoSkill(s)) !== h);
      if (cambiada) { anotarEspera(id, `la skill ${cambiada[0]} cambió durante la espera`); return { reanudado: false, motivo: `la skill ${cambiada[0]} cambió` }; }
      try { await comprobarPreflight({ motor: p.motor, cuenta: p.cuenta, cuentasNodos: p.cuentasNodos }); } catch (err) {
        anotarEspera(id, err.message);
        return { reanudado: false, motivo: err.message };
      }
      const actual = registro.leer(id);
      if (!respondidas(actual).length) return { reanudado: false, motivo: 'no hay respuestas para aplicar' };
      anotarEspera(id, null);
      registro.retomar(id);
      retomado = true;
      const receta = actual.receta || recetas.aplicarCambios(recetas.CLASICA, {});
      const timeoutMinutes = p.timeoutMinutes || 45;
      const expiraEpoch = vencimiento({ tareas: p.tareas, timeoutMinutes, receta });
      credenciales = crearCredenciales({ docker, idLote: id, expiraEpoch });
      const cred = { leer: () => credenciales, poner: (c) => { credenciales = c; } };
      const control = config.fanoutControl !== false ? crearLectorDeControl(actual.repo, id) : null;
      const motor = p.motor || 'antigravity';
      const cuenta = p.cuenta || null;
      const ejecutarTarea = crearEjecutarTarea({ id, repoPath: actual.repo, motor, cuenta, timeoutMinutes, expiraEpoch, cred, control });
      const sinEstado = { iniciar() {}, marcar() {}, terminar() {} };
      await correrRevision({ id, repoPath: actual.repo, tareas: p.tareas, receta, motor, cuenta, escritores: p.escritores, concurrencia: p.concurrencia || 1,
        timeoutMinutes, expiraEpoch, cred, ejecutarTarea, registrarEstado: sinEstado, reanudar: true });
      return { reanudado: true, lote: registro.leer(id) };
    } catch (err) {
      if (retomado) marcarFallido(id);
      else anotarEspera(id, err.message);
      return { reanudado: false, motivo: dockerLib.sanitizarSalida(err.message).slice(0, 300) };
    } finally {
      try { await credenciales?.destruir(); } catch {}
      liberarLock(lock);
      if (retomado) releerRespuestas(id);
    }
  }

  const enCurso = new Map();
  /** F4b — `reanudar` sin esperar; una sola a la vez por lote en este proceso (el lock cubre entre procesos). */
  function reanudarEnSegundoPlano(id) {
    if (enCurso.has(id)) return enCurso.get(id);
    const promesa = Promise.resolve().then(() => reanudar(id))
      .catch((err) => ({ reanudado: false, motivo: err.message }))
      .then((r) => { if (!r.reanudado && r.motivo && !/no hay respuestas/.test(r.motivo)) log(`Lote ${id}: no se reanudó: ${r.motivo}`); return r; })
      .finally(() => enCurso.delete(id));
    enCurso.set(id, promesa);
    return promesa;
  }

  /** F4b — El barrido del daemon: reanuda los lotes que esperan y ya tienen respuesta. */
  async function reanudarPendientes() {
    const hechos = [];
    for (const lote of registro.listar()) {
      if (respondidas(lote).length) hechos.push({ id: lote.id, ...(await reanudarEnSegundoPlano(lote.id)) });
    }
    return hechos;
  }

  async function cancelar(reserva, motivo = 'cancelado antes de ejecutar') {
    if (!reserva?.preparado || reserva.ejecutado) return false;
    reserva.ejecutado = true;
    marcarFallido(reserva.id);
    try {
      const lote = registro.leer(reserva.id);
      if (lote) { lote.error = dockerLib.sanitizarSalida(motivo).slice(0, 300); registro.guardar(lote); }
    } catch {}
    liberarLock(reserva.lock);
    return true;
  }

  async function lanzarYEsperar(datos) { return ejecutar(await preparar(datos)); }

  function ejecutarEnSegundoPlano(reserva, { onError = (err) => log(err.message) } = {}) {
    const promesa = Promise.resolve().then(() => ejecutar(reserva)).catch((err) => { try { onError(err); } catch {} return null; });
    return { id: reserva.id, estado: 'corriendo', promesa };
  }

  return { validarSolicitud, preparar, ejecutar, lanzarYEsperar, cancelar, ejecutarEnSegundoPlano, chequearEntorno: chequeosPreflight,
    responderHumano, reanudar, reanudarEnSegundoPlano, reanudarPendientes };
}

module.exports = { crearServicioLotes, motorDelPedido, gruposPorMotor, reescribirPorMotor, CUENTA_PRINCIPAL };
