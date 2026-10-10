const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dockerLib = require('./docker.js');
const { recolectar: recolectarPorDefecto } = require('./recolector.js');
const { crearCredenciales } = require('./credenciales.js');
const { crearEjecutorContenedor } = require('./ejecutor.js');
const { crearVerificador, validarPrueba } = require('./verificador.js');
const { crearAuditor, elegirModeloAuditor } = require('./auditor.js');
const { revisarLote } = require('./pipeline-revision.js');
const { adquirirBloqueo, liberarBloqueo } = require('./bloqueo.js');
const { ESTADOS_FINALES } = require('./registro.js');
const { lanzarFanout, prepararTareas } = require('../fanout.js');
const registroAgentes = require('../agents/registry.js');
const { crearEscritorDeEstado, crearLectorDeControl, rutaProgreso, limpiarProgreso } = require('../fanout-estado.js');
const { esfuerzoParaCli, validarModeloEsfuerzo } = require('../lib/cli-compat.js');
const { validarReparto, explicarReparto } = require('../reparto.js');
const niveles = require('../motores/niveles.js');
const sondasClaude = require('./sondas-claude.js');
const recetas = require('./recetas.js');
const grafoReceta = require('./grafo-receta.js');
const comandosRepo = require('./comandos-repo.js');
const { crearReescritor } = require('./vueltas.js');

const ABSOLUTA_EN_PROMPT = /(^|[\s"'`(])([A-Za-z]:[\\/]|\/mnt\/)/;
// FEAT-131 — `claude@<cuenta>`; sin motor, agy como siempre.
const RE_MOTOR_CLAUDE = /^claude@([a-z0-9][a-z0-9-]{0,31})$/;
const MODELO_CLAUDE_POR_DEFECTO = 'sonnet';
const CUENTA_PRINCIPAL = 'principal';

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
    const cuentasNodos = [...new Set(Object.values(escritores).filter((e) => e.motor === 'claude' && !(esClaude && e.cuenta === cuenta)).map((e) => e.cuenta))];
    return { id, slug: id, repoPath, modeloBase, tareas, timeoutMinutes, concurrencia, motor, cuenta, receta, escritores, cuentasNodos };
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
      if (n.tipo !== 'juez' || id === juez1 || !n.modelo) continue;
      for (const m of deEscritores) elegirModeloAuditor(m, n.modelo);
    }
    return escritores;
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
    const dockerVivo = lista[0].ok;
    for (const [id, texto, fn] of pasos) {
      if (dockerVivo) await chequeo(id, texto, fn);
      else lista.push({ id, texto, ok: false, sinComprobar: true, motivo: 'no se pudo comprobar: Docker no responde' });
    }
    return lista;
  }

  async function comprobarPreflight(solicitud = {}) {
    const falla = (await chequeosPreflight(solicitud)).find((c) => !c.ok);
    if (falla) throw new Error(falla.motivo);
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
      registro.crear({ id: solicitud.id, repo: solicitud.repoPath, ramaBase: '(pendiente)', modelo: solicitud.modeloBase,
        ...(solicitud.motor === 'claude' ? { motor: `claude@${solicitud.cuenta}` } : {}),
        receta: solicitud.receta,
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

  async function ejecutar(reserva) {
    if (!reserva?.preparado || reserva.ejecutado) throw new Error('reserva de lote inválida o ya consumida');
    reserva.ejecutado = true;
    const { id, repoPath, tareas, modeloBase, timeoutMinutes, concurrencia } = reserva;
    const motor = reserva.motor || 'antigravity';
    const cuenta = reserva.cuenta || null;
    const receta = reserva.receta || recetas.aplicarCambios(recetas.CLASICA, {});
    // FEAT-149 — Cada comando del repo suma su tope máximo (15 min) por tarea: se resuelven recién al verificar.
    const minutosComandos = receta.nodos.verificar.comandos.length * comandosRepo.MAX_MINUTOS;
    const minutosPrueba = tareas.reduce((n, t) => n + (t.prueba ? (Number(t.prueba.timeout_minutes) || 10) : 0) + minutosComandos, 0);
    // FEAT-149 F2 — Cada vuelta del bucle repite escritura, prueba, comandos y auditoría de la tarea.
    const rondas = 1 + (receta.nodos.escribir.vueltas || 0);
    const expiraEpoch = Math.floor((reloj() + ((timeoutMinutes * tareas.length + minutosPrueba + 50 * tareas.length) * rondas + 60) * 60000) / 1000);
    let credenciales = null;
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
      // FEAT-153 — Un pedido de reescritura de un Escribir con motor propio trae `motor`/`cuenta`; el resto usa los del lote.
      const ejecutarTarea = async (pedido) => {
        const { motor: motorPedido, cuenta: cuentaPedido, ...peticion } = pedido;
        const motorP = motorPedido || motor;
        const cuentaP = motorPedido ? cuentaPedido : cuenta;
        let fd = null;
        if (config.fanoutProgressLog !== false) { try { fd = fs.openSync(rutaProgreso(repoPath, id, peticion.taskId), 'a'); } catch {} }
        const onLine = fd === null ? undefined : (linea) => { try { fs.writeSync(fd, `${linea}\n`); } catch {} };
        const runner = crearEjecutorContenedor({ docker, ejecutarStream, credenciales, idLote: id, raizCopias, expiraEpoch, aWsl, onLine,
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

      const salida = await fanout({ repoPath, slug: id, tareas, concurrencia, modelo: modeloBase, timeoutMinutes, contenedor: true }, {
        ejecutar: ejecutarTarea,
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
      const verificar = crearVerificadorFn({ docker, aWsl, raizCopias, idLote: id, expiraEpoch });
      // F2 — Las credenciales cambian por fase (Claude escribe, agy audita): el auditor las lee al usarlas.
      const credencialesVivas = {
        asegurarVida: (minutos) => credenciales.asegurarVida(minutos),
        get volumenSecretoProxy() { return credenciales.volumenSecretoProxy; },
        get motor() { return credenciales.motor; },
        get cuenta() { return credenciales.cuenta; }
      };
      const auditar = crearAuditorFn({ docker, aWsl, raizCopias, idLote: id, expiraEpoch, credenciales: credencialesVivas, ejecutarStdin, terminarCliente, log });
      const reescritor = receta.nodos.escribir.vueltas
        ? crearReescritor({ ejecutarTarea, depsDeSkill, registrarEstado, plantilla: receta.nodos.escribir.plantilla, escritores: reserva.escritores || {}, concurrencia, timeoutMinutes })
        : null;
      // FEAT-153 — Por motor y en serie: cada grupo con sus credenciales (los volúmenes del lote son uno solo, así que
      // nunca hay dos vivas) y, al final, las de agy de vuelta para verificar y auditar.
      const reescribir = reescritor && reescribirPorMotor({
        reescritor, escritores: reserva.escritores || {}, lote: { motor, cuenta },
        credenciales: { leer: () => credenciales, poner: (c) => { credenciales = c; } },
        crear: (m, c) => crearCredenciales({ docker, idLote: id, expiraEpoch, ...(m === 'claude' ? { motor: m, cuenta: c } : {}) })
      });
      await revisarLote({ slug: id, tareas, resultados: salida.resultados, registro, verificar, auditar, receta, repo: repoPath,
        concurrencia, reescribir, baseDeTarea: comandosRepo.baseDeTarea,
        registrarUso: (a) => registrarUso('audit', a.modelo, null, a.conversation_id || '', a.duracionMs / 1000, a.usage, false, '') });
      return registro.leer(id);
    } catch (err) {
      marcarFallido(id);
      throw new Error(dockerLib.sanitizarSalida(err.message).slice(0, 500));
    } finally {
      try { cerrarEstado(); } catch {}
      try { await credenciales?.destruir(); } catch {}
      liberarLock(reserva.lock);
    }
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

  return { validarSolicitud, preparar, ejecutar, lanzarYEsperar, cancelar, ejecutarEnSegundoPlano, chequearEntorno: chequeosPreflight };
}

module.exports = { crearServicioLotes, motorDelPedido, gruposPorMotor, reescribirPorMotor, CUENTA_PRINCIPAL };
