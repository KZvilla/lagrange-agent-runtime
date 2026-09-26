'use strict';

/**
 * SEC-020 fase 2 — `agy_plan`, `agy_review` y `agy_audit` en contenedor.
 *
 * El problema (SEC-020): en el host, estas tools corren agy con
 * `--mode plan --dangerously-skip-permissions`, que corre comandos y escribe por
 * ruta absoluta; `deny_*` es texto en el prompt. La fase 1 lo dijo y lo hizo
 * visible. Esta lo contiene con la misma frontera medida de FEAT-061: Docker de
 * WSL, red `--internal`, proxy con allowlist exacta y token señuelo.
 *
 * Lo que el agente ve: una INSTANTÁNEA del árbol de trabajo montada `:ro`
 * (`instantanea.js`), sin `.git`, sin lo ignorado y sin lo de `deny_paths`; su
 * propio volumen de hilo en `/home/agy/.gemini` (uno por hilo: dos auditorías
 * nunca comparten estado de agy) para poder retomar con `--conversation`.
 *
 * Modo (plan §2.1): `auto` usa el contenedor si la infraestructura está sana.
 * La primera vez que lo está, deja una marca y desde ahí `auto` es fail-closed:
 * borrar una imagen o un volumen ya no degrada al host (ronda 2 de la
 * auditoría del plan). Sin la marca (la infra nunca anduvo acá), host con aviso.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dockerLib = require('./docker.js');
const { crearCredenciales } = require('./credenciales.js');
const { recolectar } = require('./recolector.js');
const { instantaneaDeTrabajo } = require('./instantanea.js');

const MODOS = ['auto', 'container', 'host'];
const HILO_HORAS = 24;
const MARGEN_MINUTOS = 30;
const CACHE_PREFLIGHT_MS = 10 * 60 * 1000;
const VIEJA_MS = 6 * 60 * 60 * 1000;
const INSTALAR = 'npm run lotes -- imagenes y npm run lotes -- login (ver README, lotes en contenedor)';

function raizPorDefecto() {
  // LAGRANGE_SOLO_LECTURA_DIR: solo para tests (no leer ni escribir la marca real).
  if (process.env.LAGRANGE_SOLO_LECTURA_DIR) return process.env.LAGRANGE_SOLO_LECTURA_DIR;
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'lagrange', 'solo-lectura');
}

function escribirAtomico(ruta, texto) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, texto);
  fs.renameSync(tmp, ruta);
}

// ---------------------------------------------------------------- marca y registro de hilos

function rutaMarca(raiz) { return path.join(raiz, 'contenedor-verificado.json'); }
function hayMarca(raiz) { try { return fs.statSync(rutaMarca(raiz)).isFile(); } catch { return false; } }
function escribirMarca(raiz, ahora) {
  if (!hayMarca(raiz)) escribirAtomico(rutaMarca(raiz), JSON.stringify({ verificado: new Date(ahora).toISOString() }, null, 2));
}

function crearRegistroHilos(raiz, reloj = Date.now) {
  const ruta = path.join(raiz, 'hilos.json');
  const leer = () => {
    try {
      const j = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      return j && typeof j.hilos === 'object' && j.hilos ? j : { hilos: {} };
    } catch { return { hilos: {} }; }
  };
  const guardar = (j) => {
    const ahora = Math.floor(reloj() / 1000);
    for (const [id, h] of Object.entries(j.hilos)) if (!h || h.expira < ahora) delete j.hilos[id];
    escribirAtomico(ruta, JSON.stringify(j, null, 2));
  };
  return {
    obtener(id) { return leer().hilos[String(id || '').toLowerCase()] || null; },
    anotar(id, datos) { const j = leer(); j.hilos[String(id).toLowerCase()] = datos; guardar(j); },
    quitar(id) { const j = leer(); delete j.hilos[String(id || '').toLowerCase()]; guardar(j); }
  };
}

// ---------------------------------------------------------------- preflight y decisión de modo

/**
 * `{ sana, instalada, motivo }`. "Instalada" = imágenes y volúmenes presentes;
 * "sana" = además Docker responde y la CA del proxy verifica. Solo lee.
 */
async function preflight(docker) {
  try { await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30000 }); } catch (err) {
    return { sana: false, instalada: false, motivo: `Docker en WSL no responde (${dockerLib.sanitizarSalida(err.message).slice(0, 160)})` };
  }
  for (const imagen of [dockerLib.IMAGEN_AGY, dockerLib.IMAGEN_PROXY]) {
    const r = await docker(['image', 'inspect', imagen], { permitirFallo: true });
    if (r.code !== 0) return { sana: false, instalada: false, motivo: `falta la imagen ${imagen}` };
  }
  for (const vol of [dockerLib.VOLUMEN_CREDENCIALES, dockerLib.VOLUMEN_CA_PRIVADA, dockerLib.VOLUMEN_CA_PUBLICA]) {
    const r = await docker(['volume', 'inspect', vol], { permitirFallo: true });
    if (r.code !== 0) return { sana: false, instalada: false, motivo: `falta el volumen ${vol}` };
  }
  const ca = await docker(dockerLib.argvVerificarCA(), { permitirFallo: true });
  if (ca.code !== 0) return { sana: false, instalada: true, motivo: 'la CA TLS del proxy está incompleta, vencida o no coincide' };
  return { sana: true, instalada: true, motivo: null };
}

function modoConfigurado(config = {}, env = process.env) {
  const crudo = env.LAGRANGE_SOLO_LECTURA || config.readonlyIsolation || 'auto';
  return MODOS.includes(crudo) ? crudo : 'auto';
}

/**
 * → `{ modo: 'contenedor' }` | `{ modo: 'host', aviso }` | `{ error }`.
 * Nunca degrada al host si hay marca o si se pidió `container`.
 */
async function decidir({ config, env, pedido, raiz, comprobar, ahora = Date.now() }) {
  const configurado = modoConfigurado(config, env);
  if (pedido && !['container', 'host'].includes(pedido)) return { error: `isolation inválido: "${pedido}" (container | host)` };
  if (pedido === 'host') {
    if (configurado === 'container') return { error: 'isolation "host" rechazado: la configuración exige readonly_isolation "container".' };
    return { modo: 'host', aviso: 'Corrió en el host porque se pidió isolation "host".' };
  }
  if (configurado === 'host' && pedido !== 'container') {
    return { modo: 'host', aviso: 'Corrió en el host (readonly_isolation "host").' };
  }
  const pf = await comprobar();
  if (pf.sana) {
    try { escribirMarca(raiz, ahora); } catch {}
    return { modo: 'contenedor' };
  }
  if (configurado === 'auto' && pedido !== 'container' && !hayMarca(raiz)) {
    return {
      modo: 'host',
      aviso: `⚠️ Corrió en el host, sin contención: ${pf.motivo}. Para aislar estas tools, instalá la infraestructura de los lotes en contenedor (${INSTALAR}).`
    };
  }
  return { error: `No se lanzó nada: el aislamiento en contenedor no está disponible (${pf.motivo}). Esta máquina ya lo usó antes, así que no se degrada al host sin pedirlo: arreglá la infraestructura (${INSTALAR}) o configurá readonly_isolation "host" a conciencia.` };
}

// ---------------------------------------------------------------- ejecutor

function crearEjecutorSoloLectura({
  docker = dockerLib.crearDocker({}),
  aWsl = dockerLib.crearTraductorDeRutas({}),
  ejecutarStdin,
  terminarCliente = null,
  raiz = raizPorDefecto(),
  reloj = Date.now,
  aleatorio = () => crypto.randomBytes(3).toString('hex'),
  log = () => {}
} = {}) {
  if (typeof ejecutarStdin !== 'function') throw new Error('crearEjecutorSoloLectura necesita ejecutarStdin');
  const hilos = crearRegistroHilos(raiz, reloj);
  let cachePreflight = null;

  async function comprobar() {
    if (cachePreflight && cachePreflight.hasta > reloj()) return cachePreflight.valor;
    const valor = await preflight(docker);
    if (valor.sana) cachePreflight = { valor, hasta: reloj() + CACHE_PREFLIGHT_MS };
    return valor;
  }

  function barrerCarpetasViejas() {
    let entradas = [];
    try { entradas = fs.readdirSync(raiz, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (!e.isDirectory() || !e.name.startsWith('ro-')) continue;
      const ruta = path.join(raiz, e.name);
      try { if (reloj() - fs.statSync(ruta).mtimeMs > VIEJA_MS) fs.rmSync(ruta, { recursive: true, force: true }); } catch {}
    }
  }

  async function correr({ herramienta, repo, prompt, modelo, effort, conversationId = null, timeoutMinutes = 25, denyPaths = [], signal, traceId }) {
    const corta = String(herramienta || 'tool').replace(/^agy_/, '').replace(/[^a-z]/g, '').slice(0, 10) || 'tool';
    const id = dockerLib.validarId(`ro-${corta}-${aleatorio()}`, 'id de la corrida');
    const n = dockerLib.nombres(id, 'ro');
    const ahoraS = Math.floor(reloj() / 1000);
    const expiraCorrida = ahoraS + (Math.trunc(timeoutMinutes) + MARGEN_MINUTOS) * 60;
    const inicio = reloj();
    const destino = path.join(raiz, id);
    let credenciales = null;
    let volumenHilo = null;
    let hiloNuevo = false;
    let resultado = null;

    try {
      try { await recolectar({ docker, soloLectura: true, ahora: reloj }); } catch {}
      barrerCarpetasViejas();

      // Hilo: retomar solo uno que nació en el aislamiento y sigue vigente.
      if (conversationId) {
        const h = hilos.obtener(conversationId);
        if (!h || h.expira * 1000 < reloj() + timeoutMinutes * 60000) {
          return { success: false, error: `Ese hilo (${conversationId}) no existe en el aislamiento: se creó en el host o ya venció (duran ${HILO_HORAS} h). Empezá uno nuevo sin conversation_id.` };
        }
        const existe = await docker(['volume', 'inspect', dockerLib.validarId(h.volumen, 'volumen del hilo')], { permitirFallo: true });
        if (existe.code !== 0) {
          hilos.quitar(conversationId);
          return { success: false, error: `El volumen del hilo ${conversationId} ya no existe. Empezá uno nuevo sin conversation_id.` };
        }
        volumenHilo = h.volumen;
      }

      const inst = instantaneaDeTrabajo({ repo, destino, raizPermitida: raiz, denyPaths });
      const montaje = await aWsl(inst.destino);

      credenciales = crearCredenciales({ docker, idLote: id, expiraEpoch: expiraCorrida });
      await credenciales.asegurarVida(Math.trunc(timeoutMinutes));

      if (!volumenHilo) {
        volumenHilo = `${dockerLib.PREFIJO_VOLUMEN_HILO}${aleatorio()}`;
        hiloNuevo = true;
        await docker(['volume', 'create', ...dockerLib.etiquetas(volumenHilo, ahoraS + HILO_HORAS * 3600), volumenHilo]);
        await docker(dockerLib.argvPrepararVolumenHilo(volumenHilo));
      }

      await docker(dockerLib.argvCrearRed(n.redAuditor, id, expiraCorrida));
      const proxy = dockerLib.argvProxy({ nombreProxy: n.proxyAuditor, nombreRed: n.redAuditor, perfil: 'tarea', volumenSecreto: credenciales.volumenSecretoProxy, idLote: id, expiraEpoch: expiraCorrida });
      const problemasProxy = dockerLib.verificarInvariantesProxy(proxy, 'tarea');
      if (problemasProxy.length) throw new Error(`invariantes del proxy: ${problemasProxy.join('; ')}`);
      await dockerLib.levantarProxy(docker, proxy, n.proxyAuditor);
      await docker(dockerLib.argvConectarBridge(n.proxyAuditor));

      const argv = dockerLib.argvSoloLectura({
        nombres: n, rutaCopia: montaje, volumenHilo, conversacion: conversationId ? String(conversationId) : null,
        modelo, effort, timeoutMinutes, idLote: id, expiraEpoch: expiraCorrida
      });
      const problemas = dockerLib.verificarInvariantesSoloLectura(argv);
      if (problemas.length) throw new Error(`invariantes del contenedor: ${problemas.join('; ')}`);
      const segundosPreparacion = Math.round((reloj() - inicio) / 1000);

      const r = await ejecutarStdin('wsl', prompt, ['-e', 'docker', ...argv], {
        cwd: inst.destino,
        timeoutMinutes,
        agregarFormatos: false,
        signal,
        traceId,
        log: (linea) => log(String(linea).trimEnd()),
        terminate: (child) => {
          docker(dockerLib.argvStop(n.auditor, 10), { permitirFallo: true }).catch(() => {});
          if (terminarCliente) terminarCliente(child);
        }
      });
      const conv = r && r.data && r.data.conversation_id;
      // BE-049 — Un corte por --print-timeout se puede retomar: su hilo vive.
      if (r && (r.success || r.parcial) && conv && hiloNuevo) {
        hilos.anotar(conv, { volumen: volumenHilo, expira: ahoraS + HILO_HORAS * 3600, herramienta, creado: new Date(reloj()).toISOString() });
      }
      resultado = {
        ...r,
        aislamiento: {
          modo: 'contenedor', id, archivos: inst.archivos, excluidos: inst.excluidos,
          omitidos: inst.omitidos.length, noCopiados: inst.noCopiados.length, segundosPreparacion
        }
      };
      return resultado;
    } catch (err) {
      resultado = { success: false, error: `Aislamiento en contenedor: ${dockerLib.sanitizarSalida(err.message).slice(0, 400)}` };
      return resultado;
    } finally {
      await docker(dockerLib.argvRmForzado(n.auditor), { permitirFallo: true });
      await docker(dockerLib.argvRmForzado(n.proxyAuditor), { permitirFallo: true });
      if (volumenHilo) {
        const vive = hiloNuevo && resultado && (resultado.success || resultado.parcial) && resultado.data && resultado.data.conversation_id;
        if (hiloNuevo && !vive) {
          await docker(dockerLib.argvBorrarVolumen(volumenHilo), { permitirFallo: true });
        } else {
          await docker(dockerLib.argvLimpiarSenuelo(volumenHilo), { permitirFallo: true });
        }
      }
      await docker(dockerLib.argvBorrarRed(n.redAuditor), { permitirFallo: true });
      try { await credenciales?.destruir(); } catch {}
      try { fs.rmSync(destino, { recursive: true, force: true }); } catch {}
    }
  }

  return { correr, comprobar, hilos, raiz };
}

module.exports = {
  MODOS, HILO_HORAS, INSTALAR,
  raizPorDefecto, preflight, modoConfigurado, decidir, hayMarca, escribirMarca, rutaMarca,
  crearRegistroHilos, crearEjecutorSoloLectura
};
