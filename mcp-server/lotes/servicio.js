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
const { lanzarFanout } = require('../fanout.js');
const { crearEscritorDeEstado, crearLectorDeControl, rutaProgreso, limpiarProgreso } = require('../fanout-estado.js');
const { esfuerzoParaCli, validarModeloEsfuerzo } = require('../lib/cli-compat.js');
const { validarReparto, explicarReparto } = require('../reparto.js');

const ABSOLUTA_EN_PROMPT = /(^|[\s"'`(])([A-Za-z]:[\\/]|\/mnt\/)/;

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
  reloj = Date.now
} = {}) {
  if (!registro) throw new Error('crearServicioLotes necesita un registro');

  function validarSolicitud(datos = {}) {
    const id = dockerLib.validarId(String(datos.slug || datos.id || '').trim(), 'slug del lote');
    const repoPath = path.resolve(String(datos.cwd || datos.repoPath || process.cwd()));
    const modeloBase = datos.modelo || config.defaultModel || 'gemini-3.8-flash';
    const crudas = Array.isArray(datos.tareas) ? datos.tareas : [];
    if (crudas.length < 1 || crudas.length > 6) throw new Error('un lote necesita entre 1 y 6 tareas');
    const timeoutMinutes = enteroAcotado(datos.timeout_minutes, 45, 1, 45, 'timeout_minutes');
    const concurrencia = enteroAcotado(datos.concurrencia, 3, 1, 3, 'concurrencia');
    const tareas = crudas.map((cruda) => {
      const t = { ...cruda };
      dockerLib.validarId(t.id, 'id de la tarea');
      const prompt = String(t.prompt || '');
      if (!prompt.trim()) throw new Error(`Tarea ${t.id}: falta prompt`);
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
      const effort = esfuerzoParaCli({ modelo, pedido: t.effort || datos.effort, porDefecto: config.defaultEffort || 'low' });
      validarPrueba(t.prueba);
      elegirModeloAuditor(modelo, t.modelo_auditor || datos.modelo_auditor);
      const incompatibilidad = validarModeloEsfuerzo(['--model', modelo, ...(effort ? ['--effort', effort] : [])]);
      if (incompatibilidad) throw new Error(`Tarea ${t.id}: ${incompatibilidad}`);
      return { ...t, prompt, archivos: t.archivos.map(String), modelo, effort, modelo_auditor: t.modelo_auditor || datos.modelo_auditor || null };
    });
    const reparto = validarReparto(tareas);
    if (!reparto.valido) throw new Error(explicarReparto(reparto));
    return { id, slug: id, repoPath, modeloBase, tareas, timeoutMinutes, concurrencia };
  }

  async function comprobarPreflight() {
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
  }

  async function preparar(datos) {
    const solicitud = validarSolicitud(datos);
    const previo = registro.leer(solicitud.id);
    if (previo && previo.estado !== 'descartado') throw new Error(`ya existe un lote ${solicitud.id} (${previo.estado})`);
    const lock = adquirirLock(solicitud.repoPath, solicitud.id);
    try {
      await comprobarPreflight();
      registro.marcarInterrumpidos();
      try {
        await recolectar({
          docker,
          lotesCorriendo: registro.listar().filter((l) => ['corriendo', 'verificando', 'auditando'].includes(l.estado)).map((l) => l.id),
          raizCopias
        });
      } catch {}
      registro.crear({ id: solicitud.id, repo: solicitud.repoPath, ramaBase: '(pendiente)', modelo: solicitud.modeloBase,
        tareas: solicitud.tareas.map((t) => ({ id: t.id, modelo: t.modelo })) });
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
    const minutosPrueba = tareas.reduce((n, t) => n + (t.prueba ? (Number(t.prueba.timeout_minutes) || 10) : 0), 0);
    const expiraEpoch = Math.floor((reloj() + (timeoutMinutes * tareas.length + minutosPrueba + 50 * tareas.length + 60) * 60000) / 1000);
    let credenciales = null;
    try {
      credenciales = crearCredenciales({ docker, idLote: id, expiraEpoch });
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
          terminarCliente, timeoutMinutesPorDefecto: timeoutMinutes });
        try {
          const r = await runner(peticion);
          const d = r.data || {};
          registrarUso('run', peticion.model || config.defaultModel, peticion.effort, d.conversation_id || '', d.duration_seconds || 0, d.usage, !r.success, r.error || '');
          return r;
        } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
      };

      const salida = await fanout({ repoPath, slug: id, tareas, concurrencia, modelo: modeloBase, timeoutMinutes, contenedor: true }, {
        ejecutar: ejecutarTarea,
        registrarEstado,
        limpiarControlPrevio: control ? (taskId) => control.limpiar(taskId) : undefined,
        limpiarProgresoPrevio: config.fanoutProgressLog !== false ? (taskId) => limpiarProgreso(repoPath, id, taskId) : undefined
      });
      if (!salida.lanzado) throw new Error(salida.detalle || 'el lote no se lanzó');
      const verificar = crearVerificadorFn({ docker, aWsl, raizCopias, idLote: id, expiraEpoch });
      const auditar = crearAuditorFn({ docker, aWsl, raizCopias, idLote: id, expiraEpoch, credenciales, ejecutarStdin, terminarCliente, log });
      await revisarLote({ slug: id, tareas, resultados: salida.resultados, registro, verificar, auditar,
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

module.exports = { crearServicioLotes };
