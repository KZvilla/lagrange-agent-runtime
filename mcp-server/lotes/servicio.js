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
const comandosRepo = require('./comandos-repo.js');

const ABSOLUTA_EN_PROMPT = /(^|[\s"'`(])([A-Za-z]:[\\/]|\/mnt\/)/;
// FEAT-131 — `claude@<cuenta>`; sin motor, agy como siempre.
const RE_MOTOR_CLAUDE = /^claude@([a-z0-9][a-z0-9-]{0,31})$/;
const MODELO_CLAUDE_POR_DEFECTO = 'sonnet';

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
  if (!Object.hasOwn(cuentas, m[1])) throw new Error(`la cuenta ${m[1]} no está declarada en motores.cuentas`);
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
      return { ...resto, prompt, archivos: t.archivos.map(String), modelo, ...(effort ? { effort } : {}), modelo_auditor: modeloAuditor,
        // FEAT-149 — La skill de la receta es el defecto; la de la tarea gana.
        ...(!t.skill && receta.nodos.escribir.skill ? { skill: receta.nodos.escribir.skill } : {}) };
    });
    const reparto = validarReparto(tareas);
    if (!reparto.valido) throw new Error(explicarReparto(reparto));
    // FEAT-107 — Con la cuota guardada de un grupo agotado, ni escritores ni
    // auditores pueden correr: no se arma nada. Lo usan el MCP y la consola web.
    // FEAT-131 — Con Claude no se frena por la cuota de agy: el caso de uso es
    // justo Gemini agotado. Si al auditor le falta cuota, su auditoría queda en
    // error y el lote no se integra hasta auditarlo (plan §12.3).
    if (typeof revisarCuota === 'function' && !esClaude) {
      const modelos = tareas.flatMap((t) => [t.modelo, elegirModeloAuditor(t.modelo, t.modelo_auditor)]);
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
    return { id, slug: id, repoPath, modeloBase, tareas, timeoutMinutes, concurrencia, motor, cuenta, receta };
  }

  async function comprobarPreflight(solicitud = {}) {
    try { await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30000 }); }
    catch (err) { throw new Error(`Docker en WSL no responde: ${err.message}. Probá wsl -e docker version.`); }
    for (const imagen of [dockerLib.IMAGEN_AGY, dockerLib.IMAGEN_PROXY, dockerLib.IMAGEN_VERIFICADOR]) {
      const r = await docker(['image', 'inspect', imagen], { permitirFallo: true });
      if (r.code !== 0) throw new Error(`Falta la imagen ${imagen}. Construila con npm run lotes -- imagenes.`);
    }
    const volumen = await docker(['volume', 'inspect', dockerLib.VOLUMEN_CREDENCIALES], { permitirFallo: true });
    if (volumen.code !== 0) throw new Error(`Falta el volumen ${dockerLib.VOLUMEN_CREDENCIALES}. Hacé login con npm run lotes -- login.`);
    for (const ca of [dockerLib.VOLUMEN_CA_PRIVADA, dockerLib.VOLUMEN_CA_PUBLICA]) {
      const r = await docker(['volume', 'inspect', ca], { permitirFallo: true });
      if (r.code !== 0) throw new Error(`Falta el volumen TLS ${ca}. Prepará la CA con npm run lotes -- imagenes.`);
    }
    const ca = await docker(dockerLib.argvVerificarCA(), { permitirFallo: true });
    if (ca.code !== 0) throw new Error('La CA TLS del proxy está incompleta, vencida o no coincide.');
    if (solicitud.motor === 'claude') {
      const img = await docker(['image', 'inspect', dockerLib.IMAGEN_CLAUDE], { permitirFallo: true });
      if (img.code !== 0) throw new Error(`Falta la imagen ${dockerLib.IMAGEN_CLAUDE}. Construila con npm run lotes -- imagenes-claude.`);
      const login = await docker(['volume', 'inspect', dockerLib.volumenLoginClaude(solicitud.cuenta)], { permitirFallo: true });
      if (login.code !== 0) throw new Error(`Falta el login de Claude de ${solicitud.cuenta}. Hacé login con npm run lotes -- login-claude ${solicitud.cuenta}.`);
      const sondas = await verificarSondasClaude(solicitud.cuenta);
      if (!sondas.ok) throw new Error(`Claude en el lote no está habilitado para ${solicitud.cuenta}: ${sondas.motivo}.`);
    }
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
    const expiraEpoch = Math.floor((reloj() + (timeoutMinutes * tareas.length + minutosPrueba + 50 * tareas.length + 60) * 60000) / 1000);
    let credenciales = null;
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
      const control = config.fanoutControl !== false ? crearLectorDeControl(repoPath, id) : null;
      const ejecutarTarea = async (peticion) => {
        let fd = null;
        if (config.fanoutProgressLog !== false) { try { fd = fs.openSync(rutaProgreso(repoPath, id, peticion.taskId), 'a'); } catch {} }
        const onLine = fd === null ? undefined : (linea) => { try { fs.writeSync(fd, `${linea}\n`); } catch {} };
        const runner = crearEjecutorContenedor({ docker, ejecutarStream, credenciales, idLote: id, raizCopias, expiraEpoch, aWsl, onLine,
          stopCheck: control ? () => control.consumirDetencion(peticion.taskId) : undefined,
          terminarCliente, timeoutMinutesPorDefecto: timeoutMinutes, motor });
        try {
          const r = await runner(peticion);
          const d = r.data || {};
          if (motor === 'claude' && typeof registrarLlamada === 'function') {
            // FEAT-131 — Con la cuenta y su cuota de 5 h: la ven el panel y el diálogo de FEAT-111.
            registrarLlamada({
              tool: 'lote', motor: `claude@${cuenta}`, modelo: peticion.model, modeloReal: d.modelo_real || null,
              esfuerzo: peticion.effort || null, conversationId: d.conversation_id || null, duracion: d.duration_seconds || 0,
              usage: d.usage || null, error: r.success ? null : (r.error || 'falló'), costoUsd: d.costo_usd ?? null, cuota: d.cuota || null
            });
          } else if (motor !== 'claude') {
            registrarUso('run', peticion.model || config.defaultModel, peticion.effort, d.conversation_id || '', d.duration_seconds || 0, d.usage, !r.success, r.error || '');
          }
          return r;
        } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
      };

      const salida = await fanout({ repoPath, slug: id, tareas, concurrencia, modelo: modeloBase, timeoutMinutes, contenedor: true }, {
        ejecutar: ejecutarTarea,
        registrarEstado,
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
      const auditar = crearAuditorFn({ docker, aWsl, raizCopias, idLote: id, expiraEpoch, credenciales, ejecutarStdin, terminarCliente, log });
      await revisarLote({ slug: id, tareas, resultados: salida.resultados, registro, verificar, auditar, receta, repo: repoPath,
        registrarUso: (a) => registrarUso('audit', a.modelo, null, a.conversation_id || '', a.duracionMs / 1000, a.usage, false, '') });
      return registro.leer(id);
    } catch (err) {
      marcarFallido(id);
      throw new Error(dockerLib.sanitizarSalida(err.message).slice(0, 500));
    } finally {
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

  return { validarSolicitud, preparar, ejecutar, lanzarYEsperar, cancelar, ejecutarEnSegundoPlano };
}

module.exports = { crearServicioLotes, motorDelPedido };
