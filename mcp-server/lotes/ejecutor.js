/**
 * El `ejecutar` que corre una tarea del lote dentro de un contenedor
 * (FEAT-061 fase 2, §4.4 del plan).
 *
 * Encaja en `lanzarFanout` como cualquier otro ejecutor: recibe una petición y
 * devuelve `{ success, ... }`. La diferencia es todo lo que pasa entre medio, y
 * el orden importa:
 *
 *   token → copia plana → red → proxy → docker run → ESPERAR AL CONTENEDOR →
 *   sincronizar → commit → bajar todo
 *
 * LA ESPERA NO ES UN DETALLE
 * --------------------------
 * `executeAgyStreaming` resuelve cuando muere el CLIENTE (`wsl.exe`), no cuando
 * muere el contenedor — y S10 midió que matar el cliente deja el contenedor
 * corriendo. Si sincronizáramos ahí, leeríamos una copia que el agente sigue
 * escribiendo, y al bajar la red nos daría un endpoint activo. Por eso, después
 * de que resuelve y ANTES de tocar nada, se espera a que el contenedor no
 * exista: `docker stop` + `docker wait`, y `rm -f` si se pasa de tiempo.
 *
 * SI LA TAREA NO TERMINÓ BIEN, NO SE SINCRONIZA
 * ---------------------------------------------
 * Detenida (FEAT-012), vencida por watchdog o con agy saliendo != 0: la copia se
 * tira sin tocar el worktree. Trabajo a medias, o cortado justamente por
 * sospechoso, no entra al repo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  nombres,
  argvCrearRed,
  argvBorrarRed,
  argvProxy,
  levantarProxy,
  argvConectarBridge,
  argvTarea,
  argvStop,
  argvWait,
  argvRmForzado,
  argvExiste,
  verificarInvariantes
} = require('./docker.js');
const { copiaPlana, sincronizar, commitSeguro, crearHooksVacio } = require('./copia.js');

const ESPERA_CONTENEDOR_MS = 60000;

/**
 * Los ids de tarea los escribe quien arma el reparto y van a nombres de
 * contenedor. Se saneán (no se rechazan) para no hacer fallar un lote entero
 * por un punto en un id; `validarId` de docker.js sigue siendo la última
 * palabra.
 *
 * Cuando hubo que sanear, se agrega un sufijo derivado del id original: si no,
 * `a.b` y `a/b` producirían el mismo `a-b`, o sea el mismo contenedor y la
 * misma carpeta de copia para dos tareas que corren a la vez.
 */
function sanearId(taskId) {
  const original = String(taskId || '');
  const limpio = original.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 40);
  if (!limpio) return 'tarea';
  if (limpio === original) return limpio;
  const huella = createHash('sha256').update(original).digest('hex').slice(0, 6);
  return `${limpio}-${huella}`;
}

function crearEjecutorContenedor({
  docker,
  ejecutarStream,
  credenciales,
  idLote,
  raizCopias,
  rutaPermitidos,
  expiraEpoch,
  aWsl,
  hooksPath,
  onLine,
  stopCheck,
  terminarCliente,
  timeoutMinutesPorDefecto = 45,
  esperaContenedorMs = ESPERA_CONTENEDOR_MS,
  registrarAnomalias
}) {
  // La carpeta de hooks vacíos va FUERA de la raíz de copias: el recolector
  // borra todo directorio de ahí que no sea de un lote corriendo, y se llevaría
  // puesta la carpeta de hooks en medio de una corrida.
  const hooks = hooksPath || crearHooksVacio(path.dirname(path.resolve(raizCopias)));

  /**
   * Espera a que el contenedor deje de existir. Idempotente: si ya no está,
   * vuelve enseguida.
   */
  async function esperarFinDelContenedor(nombreContenedor) {
    const limite = Date.now() + esperaContenedorMs;
    await docker(argvStop(nombreContenedor, 10), { permitirFallo: true, timeoutMs: esperaContenedorMs });
    await docker(argvWait(nombreContenedor), { permitirFallo: true, timeoutMs: esperaContenedorMs });

    while (Date.now() < limite) {
      const r = await docker(argvExiste(nombreContenedor), { permitirFallo: true });
      if (!String(r.stdout || '').trim()) return true;
      await new Promise(res => setTimeout(res, 500));
    }
    await docker(argvRmForzado(nombreContenedor), { permitirFallo: true });
    return false;
  }

  return async function ejecutar(peticion) {
    const n = nombres(idLote, sanearId(peticion.taskId));
    const worktree = peticion.cwd;
    const topeMinutos = peticion.timeout_minutes || timeoutMinutesPorDefecto;
    const dirTarea = path.join(raizCopias, idLote, sanearId(peticion.taskId));
    const dirPedido = `${dirTarea}-pedido`;
    const anomalias = [];

    // 1. Token con vida suficiente para esta tarea (§4.3). Serializado adentro:
    //    dos tareas que lo piden a la vez producen un solo refresco.
    try {
      await credenciales.asegurarVida(topeMinutos);
    } catch (err) {
      return { success: false, error: `token del lote: ${err.message}`, anomalias, commit: null };
    }

    // 2. Copia plana del HEAD, sin `.git`, y el prompt aparte en su propio
    //    montaje de solo lectura.
    try {
      copiaPlana({ worktree, destino: dirTarea, raizPermitida: raizCopias });
      fs.rmSync(dirPedido, { recursive: true, force: true });
      fs.mkdirSync(dirPedido, { recursive: true });
      fs.writeFileSync(path.join(dirPedido, 'PROMPT.md'), peticion.prompt, 'utf8');
    } catch (err) {
      return { success: false, error: `no se pudo preparar la copia: ${err.message}`, anomalias, commit: null };
    }

    const montajeCopia = await aWsl(dirTarea);
    const montajePedido = await aWsl(dirPedido);

    const argv = argvTarea({
      nombres: n,
      rutaCopia: montajeCopia,
      rutaPedido: montajePedido,
      modelo: peticion.model,
      effort: peticion.effort,
      idLote,
      expiraEpoch
    });

    // Barato, y convierte "confiamos en que nadie agregó un montaje" en una
    // comprobación que corre en cada tarea.
    const problemas = verificarInvariantes(argv);
    if (problemas.length) {
      fs.rmSync(dirTarea, { recursive: true, force: true });
      fs.rmSync(dirPedido, { recursive: true, force: true });
      return { success: false, error: `el contenedor no cumple sus invariantes: ${problemas.join('; ')}`, anomalias, commit: null };
    }

    let res;
    let sincronizado = null;
    try {
      // 3. Red aislada y proxy con allowlist. El proxy también en `bridge`: es
      //    la única salida, y el agente no está ahí.
      await docker(argvRmForzado(n.contenedor), { permitirFallo: true });
      await docker(argvRmForzado(n.proxy), { permitirFallo: true });
      await docker(argvBorrarRed(n.red), { permitirFallo: true });
      await docker(argvCrearRed(n.red, idLote, expiraEpoch));
      await levantarProxy(docker, argvProxy({ nombreProxy: n.proxy, nombreRed: n.red, archivoPermitidos: rutaPermitidos, idLote, expiraEpoch }), n.proxy);
      await docker(argvConectarBridge(n.proxy));

      // 4. La corrida. `agregarOutputFormat: false` porque el flag ya va en el
      //    comando de adentro: agregarlo acá se lo pasaría a `wsl`, no a agy.
      res = await ejecutarStream('wsl', ['-e', 'docker', ...argv], {
        cwd: worktree,
        timeoutMinutes: topeMinutos,
        agregarOutputFormat: false,
        onLine,
        stopCheck,
        terminate: (child) => {
          // El orden importa: `docker stop` para el contenedor; matar el
          // cliente solo, no (S10).
          docker(argvStop(n.contenedor, 10), { permitirFallo: true }).catch(() => {});
          if (terminarCliente) terminarCliente(child);
        }
      });

      // 5. Esperar SIEMPRE a que el contenedor no exista, antes de leer la
      //    copia o bajar la red.
      await esperarFinDelContenedor(n.contenedor);

      const detenido = res.stopped === true;
      const vencido = !res.success && /watchdog timed out/i.test(String(res.error || ''));

      if (res.success && !detenido && !vencido) {
        // 6. Sincronización y commit, los dos en el host.
        sincronizado = sincronizar({ copia: dirTarea, worktree, archivos: peticion.archivos || [] });
        anomalias.push(...sincronizado.anomalias);

        const { commit, sinCambios } = commitSeguro({
          worktree,
          tocados: sincronizado.tocados,
          mensaje: `lote ${idLote}: tarea ${peticion.taskId}`,
          hooksPath: hooks
        });

        if (registrarAnomalias && anomalias.length) registrarAnomalias(peticion.taskId, anomalias);

        return {
          ...res,
          success: true,
          commit,
          sinCambios: !!sinCambios,
          anomalias,
          conversation_id: (res.data && res.data.conversation_id) || null
        };
      }

      if (registrarAnomalias && anomalias.length) registrarAnomalias(peticion.taskId, anomalias);
      return { ...res, commit: null, anomalias, conversation_id: (res.data && res.data.conversation_id) || null };
    } catch (err) {
      return { success: false, error: `ejecutor del lote: ${err.message}`, commit: null, anomalias };
    } finally {
      // 7. Bajar el proxy y la red, y tirar la copia. Siempre, y recién acá:
      //    antes de la espera del punto 5 la red no se deja borrar.
      await docker(argvRmForzado(n.proxy), { permitirFallo: true });
      await docker(argvBorrarRed(n.red), { permitirFallo: true });
      try { fs.rmSync(dirTarea, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dirPedido, { recursive: true, force: true }); } catch {}
      // Y la carpeta del lote si ya no queda nadie: `rmdir` a secas, que falla
      // solo si otra tarea del mismo lote sigue usándola.
      try { fs.rmdirSync(path.join(raizCopias, idLote)); } catch {}
    }
  };
}

module.exports = { ESPERA_CONTENEDOR_MS, sanearId, crearEjecutorContenedor };
