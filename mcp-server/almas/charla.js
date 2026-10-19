/**
 * FEAT-043 — Un turno de charla con un alma.
 *
 * Es la primera superficie donde el alma escribe su memoria, y por eso es la
 * más estricta con el aislamiento: corre SIEMPRE como `lagrange-alma`, el
 * agente sin tools, y si ese agente no resuelve no se lanza nada. No hay
 * camino de respaldo, a diferencia de las narraciones (fase 1): allá el prompt
 * lleva un `alma.md` que escribe el usuario; acá lleva memoria escrita por un
 * modelo, que es el vector de inyección persistente del RFC §6. Degradar al
 * agente por defecto pondría `write_to_file` del otro lado de ese texto.
 *
 * `ejecutar` se inyecta, como en `agents/cast.js`: el bot pasa `runAgyArgs` y
 * los tests un doble, así que este módulo se prueba sin lanzar agy. El argv lo
 * arma el motor (FEAT-071) a partir del perfil `sin-tools`.
 */

const fs = require('node:fs');
const os = require('node:os');
const rutas = require('./rutas.js');
const contexto = require('./contexto.js');
const recuerdos = require('./recuerdos.js');
const diario = require('./diario.js');
const bloque = require('./bloque.js');
const bloqueTablero = require('./bloque-tablero.js');
const hilos = require('./hilos.js');
const motores = require('../motores/index.js');
const profunda = require('./profunda.js');
const archivo = require('./archivo.js');
const fallbackAgy = require('../lib/fallback-agy.js');

/**
 * Snapshot congelado (RFC §4.2): el contexto entero va solo cuando el hilo
 * nace. En un hilo continuado, agy ya tiene los turnos previos; reinyectar la
 * memoria en cada vuelta duplica tokens y deja conviviendo la versión vieja y
 * la nueva de un recuerdo que se reemplazó a mitad de la charla.
 */
function armarPrompt({ clave, mensaje, hilo, env, tablero = null, ahora = new Date(), profundos = [] }) {
  // FEAT-058 — El tablero es estado vivo: va en cada turno, también en un
  // hilo continuado, y con él la consigna de `<tablero>` (antes de `<alma>`).
  const conTablero = typeof tablero === 'string';
  const cierre = `${conTablero ? `${bloqueTablero.instruccionDeCierre()}\n` : ''}${bloque.instruccionDeCierre({ conTema: true })}`;
  const cuerpo = conTablero ? `${bloqueTablero.contextoDelTablero(tablero, ahora)}\n\n---\n\n${mensaje}` : mensaje;
  if (hilo) return `${cuerpo}\n${cierre}`;
  const ctx = contexto.componerContexto(clave, { conMemoria: true, profundos }, env);
  return `${ctx}\n\n---\n\n${cuerpo}\n${cierre}`;
}

/**
 * Las operaciones van por archivo: `recuerdos.aplicar` trabaja sobre uno por
 * llamada. Lo comparte la consolidación de la charla de voz (`consolidar.js`):
 * es el mismo reparto entre `memoria.md` y `usuario.md`, con los mismos topes.
 */
function aplicarOperaciones(clave, operaciones, env) {
  const aplicadas = [];
  const rechazadas = [];
  const porArchivo = [
    { prefijo: 'm', ruta: rutas.rutasDe(clave, env).memoria, tope: recuerdos.TOPE_MEMORIA },
    { prefijo: 'u', ruta: rutas.rutaUsuario(env), tope: recuerdos.TOPE_USUARIO }
  ];

  for (const { prefijo, ruta, tope } of porArchivo) {
    const ops = operaciones.filter(o => o.prefijo === prefijo);
    if (!ops.length) continue;
    const compartido = prefijo === 'u';
    // FEAT-171 — Un `olvidar` de un id del archivo (`tm…`/`tu…`) no tiene
    // nada que hacer en la memoria caliente.
    const calientes = ops.filter(o => !(o.tipo === 'olvidar' && String(o.id).startsWith('t')));
    let r = { aplicadas: [], rechazadas: [] };
    try {
      // FEAT-171 — `archivar` escribe primero en el archivo, con el lock de la
      // memoria tomado: si el archivo no lo acepta, la entrada se queda.
      if (calientes.length) {
        r = recuerdos.aplicar(ruta, prefijo, calientes, tope, {
          // Solo vale si ESTA entrada quedó escrita: un `ok` sin ella la perdería.
          alArchivar: (e, op) => {
            const r = archivo.escribir(clave, [{ ...e, tema: op.tema }], { compartido, env });
            if (r.ok && r.escritas.includes(String(e.id).toLowerCase())) return { ok: true };
            return { ok: false, motivo: r.motivo || (r.rechazadas[0] && r.rechazadas[0].motivo) || 'no entró al archivo' };
          }
        });
      }
    } catch (err) {
      // Un lock ocupado o un archivo ilegible no puede costar la respuesta.
      rechazadas.push({ op: { prefijo }, motivo: err.message });
      continue;
    }
    aplicadas.push(...r.aplicadas.map(a => ({ ...a, prefijo })));
    const pendientes = r.rechazadas.map(x => ({ ...x, prefijo }));

    // FEAT-171 — `olvidar` es de verdad: también se lleva lo archivado. Un id
    // que no estaba en la memoria caliente pero sí en el archivo es un olvido
    // aplicado, no un rechazo.
    for (const op of ops.filter(o => o.tipo === 'olvidar')) {
      let borrado = null;
      try { borrado = archivo.olvidar(clave, op.id, { env }); } catch {}
      if (!borrado || !borrado.borrado) continue;
      const i = pendientes.findIndex(x => x.op && x.op.tipo === 'olvidar' && x.op.id === op.id);
      if (i >= 0) pendientes.splice(i, 1);
      if (!aplicadas.some(a => a.tipo === 'olvidar' && a.id === op.id)) aplicadas.push({ tipo: 'olvidar', id: op.id, texto: borrado.texto, prefijo, enArchivo: true });
    }
    for (const op of ops.filter(o => o.tipo === 'olvidar' && String(o.id).startsWith('t'))) {
      if (!aplicadas.some(a => a.tipo === 'olvidar' && a.id === op.id)) pendientes.push({ op: { tipo: 'olvidar', id: op.id }, motivo: 'id inexistente', prefijo });
    }
    rechazadas.push(...registrarRechazosPorTope(clave, pendientes, { compartido, env }));
  }
  // Las copias viejas de la memoria profunda (legado de FEAT-046) se van con
  // cada `olvidar`. No espera: la charla no se demora por el servicio.
  profunda.copiarOperaciones(clave, { aplicadas, rechazadas }, { env });
  return { aplicadas, rechazadas };
}

/**
 * FEAT-171 — Un recuerdo legítimo al que le faltó lugar en la memoria caliente
 * no se pierde: va al archivo con un id sintético. Lo comparte el alta manual
 * del bot y la web. Devuelve las rechazadas con `archivado: id` o, si tampoco
 * entró al archivo, con `motivoArchivo`. Nunca lanza.
 */
function registrarRechazosPorTope(clave, rechazadas, { compartido = false, env = process.env, ahora = Date.now } = {}) {
  let n = 0;
  return rechazadas.map((x) => {
    if (!x || x.motivo !== 'tope' || !x.texto) return x;
    // `+ n`: dos rechazos del mismo turno no pueden compartir id.
    const id = archivo.idSintetico(compartido ? 'u' : 'm', ahora() + n++);
    try {
      const r = archivo.escribir(clave, [{ id, texto: x.texto }], { compartido, env });
      return r.ok && r.escritas.length ? { ...x, archivado: id } : { ...x, motivoArchivo: r.motivo || (r.rechazadas[0] && r.rechazadas[0].motivo) || 'no entró' };
    } catch (err) {
      return { ...x, motivoArchivo: err.message };
    }
  });
}

function anotarEnDiario(clave, { respuesta, aplicadas, rechazadas, metadatos, motor = null, modeloReal = null, cuenta = null, hilo = null, fallback = false, recuerdos: dados = null }, env) {
  try {
    // FEAT-053 — La superficie la dice quien llama (web o telegram). Sin
    // dato se asume telegram, que era el único origen antes de la consola web.
    const superficie = metadatos && metadatos.superficie === 'web' ? 'web' : 'telegram';
    const origen = metadatos && metadatos.tipo === 'reaccion'
      ? {
          tipo: 'reaccion',
          reaccion: String(metadatos.reaccion || ''),
          mensajeId: String(metadatos.messageId || '')
        }
      : {};
    // BE-039 — Con el motor y el modelo: si la voz "cambia de carácter", se
    // separa el efecto del modelo del de la memoria.
    // SEC-021 — Y la cuenta, el hilo y la red: la procedencia completa de lo
    // que el alma guarda. Un alma corre sin tools: `red: 'no'`.
    // FEAT-097 — `fallback: true` si agy no pudo y respondió `claude@<cuenta>`.
    const quien = motor ? { motor, cuenta, modelo_real: modeloReal, hilo, red: 'no', ...(fallback ? { fallback: true } : {}) } : {};
    // FEAT-171 — Qué recuerdos archivados se dieron al nacer el hilo (y cuáles no
    // pasaron el escaneo): con esto se decide si hacen falta recuerdos por turno.
    const conRecuerdos = dados && (dados.ids.length || dados.omitidas.length)
      ? { recuerdos: dados.ids, ...(dados.omitidas.length ? { recuerdos_omitidos: dados.omitidas } : {}) }
      : {};
    diario.anotar(clave, { superficie, ...origen, ...quien, ...conRecuerdos, resumen: respuesta }, env);
    // Igual que la consolidación de voz: registrar cada cambio deja trazabilidad.
    // En `olvidar`, a.texto es el valor quitado y preserva la única copia que
    // deja de existir en el archivo; en `reemplazar` es el nuevo valor aplicado.
    for (const a of aplicadas) {
      diario.anotar(clave, { superficie, tipo: `memoria:${a.tipo}`, id: a.id, resumen: a.texto, ...quien }, env);
    }
    for (const r of rechazadas) {
      diario.anotar(clave, { superficie, tipo: 'rechazo', motivo: r.motivo }, env);
    }
  } catch (err) {
    process.stderr.write(`[almas] No se pudo anotar el diario de ${clave}: ${err.message}\n`);
  }
}

/** BE-039 — Un registro de uso que falla no puede costar la respuesta. */
function registrarSinRomper(registrarUso, llamada) {
  try {
    registrarUso(llamada);
  } catch (err) {
    process.stderr.write(`[almas] No se pudo registrar el uso: ${err.message}
`);
  }
}

/**
 * Un turno. Nunca lanza por un fallo de la charla: devuelve `{ok: false, …}`.
 * Solo lanza por un error de programación del llamante (falta `agyBin` o
 * `ejecutar`), porque sin `agyBin` no se puede verificar el agente y seguir sin
 * verificar es el fail-open que este módulo existe para evitar.
 *
 * BE-039 — `registrarUso(llamada)` lo inyecta quien llama y se llama una vez
 * por turno lanzado, también en fallo o cancelación. Sin inyectar no escribe
 * nada: así los tests nunca tocan el uso real del usuario. `contextoMotor`
 * (`config`, `leerCuota`, `leerSondas`…) también se inyecta; el hilo que se
 * retoma es el del motor que corre. `opciones.origen` dice quién inició el turno.
 *
 * FEAT-072 — El motor sale del rol `alma` de `contextoMotor.config` (o de
 * `motor`, si se pasa explícito); FEAT-075: `alma:<clave>` gana sobre `alma`.
 * Con el modelo y el esfuerzo del rol, que
 * ganan sobre los de `opciones`. `ejecutarClaude` es el ejecutor del motor
 * `claude`: sin él, un alma en claude se rechaza y nada se lanza.
 */
async function charlar({
  clave, texto, agyBin, ejecutar, ejecutarClaude = null, ejecutarDeepseek = null, homeDir = os.homedir(), env = process.env, opciones = {},
  motor: motorExplicito = null, registrarUso = () => {}, contextoMotor = {}
}) {
  if (!agyBin) throw new Error('charlar: falta `agyBin`, sin él no se puede verificar el agente.');
  if (typeof ejecutar !== 'function') throw new Error('charlar: falta `ejecutar`.');
  rutas.validarClave(clave);

  const mensaje = String(texto || '').trim();
  if (!mensaje) return { ok: false, motivo: 'el mensaje está vacío' };
  if (!fs.existsSync(rutas.rutasDe(clave, env).alma)) return { ok: false, sinAlma: true };

  const eleccionDelRol = motorExplicito
    ? { motor: motorExplicito, modelo: null, esfuerzo: null, cuenta: null, fijo: true }
    : motores.elegir(contextoMotor.config, `alma:${clave}`);
  const ejecutores = { ejecutar, ejecutarClaude, ejecutarDeepseek };
  const origen = opciones.origen || 'usuario';

  /**
   * FEAT-097 — Un intento con una elección (motor, cuenta, modelo, esfuerzo).
   * Lo que depende del motor se calcula acá, para que el reintento con
   * `claude@<cuenta>` use su hilo, su uso y su procedencia.
   */
  const intentarCon = async (eleccion) => {
    const motor = eleccion.motor;
    // FEAT-085 — La cuenta del rol viaja en los dos pedidos (preflight y turno) y
    // su clave (`claude@trabajo`) indexa el hilo y el uso: un hilo de una cuenta
    // no se retoma con otra.
    const cuenta = eleccion.cuenta || null;
    const claveHilo = motores.claveDeCuenta(motor.id, cuenta);
    const falta = motores.faltaEjecutor(motor, ejecutores);
    if (falta) return { resultado: { ok: false, error: falta, preflight: true } };
    // El perfil del fallback gana sobre `opciones`: el modelo pedido es de agy.
    const modelo = eleccion.modelo || (eleccion.fallback ? null : opciones.model) || null;
    const esfuerzo = eleccion.fallback ? eleccion.esfuerzo : (eleccion.esfuerzo || opciones.effort || null);

    // FEAT-071 — El perfil `sin-tools` asegura y verifica el agente sin tools
    // antes de todo lo demás, como antes.
    const pre = await motor.preflight({ perfil: 'sin-tools', modelo, origen, ...(cuenta ? { cuenta } : {}) }, { ...contextoMotor, agyBin, homeDir });
    if (!pre.ok) return { resultado: { ok: false, error: pre.motivo, preflight: true } };

    let hilo = opciones.fresco ? null : hilos.hiloDe(clave, { env, motor: claveHilo });
    // FEAT-166 — Un motor que guarda el hilo de nuestro lado dice si se puede
    // retomar (por capacidad, sin preguntar qué motor es). Si no (sin archivo,
    // truncado, pasado el tope), nace de nuevo y con la foto: nunca amnesia.
    if (hilo && typeof motor.hiloVigente === 'function' && !motor.hiloVigente(clave, hilo, env)) hilo = null;
    // FEAT-171 — Lo archivado que viene al caso, solo cuando nace el hilo, igual
    // que el snapshot de memoria. Sale del archivo local, no del servicio.
    const busqueda = hilo ? { resultados: [], omitidas: [] } : archivo.buscar(clave, mensaje, { env });
    const profundos = busqueda.resultados;
    const pedido = {
      perfil: 'sin-tools',
      prompt: armarPrompt({ clave, mensaje, hilo, env, tablero: opciones.tablero ?? null, profundos }),
      hilo,
      modelo,
      esfuerzo,
      // FEAT-055 — `stream` es opt-in: el bot lo pide para la respuesta en vivo.
      formato: opciones.stream ? 'stream' : 'json',
      origen,
      aislado: Boolean(opciones.aislado),
      // FEAT-166 — El motor deepseek ubica el hilo local por la clave del alma.
      clave,
      ...(cuenta ? { cuenta } : {})
    };

    const inicio = Date.now();
    // FEAT-072 — Un turno de Claude cortado por el watchdog igual deja su hilo
    // (el previsto), y uno cancelado antes del spawn no deja ninguno.
    const resultado = await motores.despachar({
      motor,
      pedido,
      pre,
      ejecutores,
      env,
      homeDir,
      opciones: {
        cwd: opciones.cwd,
        timeoutMinutes: opciones.timeoutMinutes || 5,
        onSpawn: opciones.onSpawn,
        onTexto: opciones.onTexto
      }
    });
    const duracion = (Date.now() - inicio) / 1000;

    const hiloNuevo = resultado.hilo || hilo || null;
    // FEAT-060 — Un turno AISLADO no deja rastro en el hilo activo del alma.
    // `fresco` no alcanza para decidirlo: `/charla nuevo` también es fresco y ahí
    // el hilo nuevo SÍ tiene que pasar a ser el del usuario. Lo aislado es otra
    // cosa: un trabajo que corre solo, de madrugada, que no puede quedarse con la
    // conversación. Sin esto, el siguiente `/charla` del usuario retomaba el hilo
    // del trabajo programado.
    if (hiloNuevo && !opciones.aislado) hilos.registrarTurno(clave, { conversationId: hiloNuevo, motor: claveHilo }, env);

    registrarSinRomper(registrarUso, {
      tool: 'charla',
      motor: claveHilo,
      // FEAT-086 — Para registrar a qué modelo resolvió el alias del rol.
      rol: `alma:${clave}`,
      modelo: pedido.modelo || null,
      modeloReal: resultado.modeloReal,
      esfuerzo: pedido.esfuerzo || null,
      conversationId: hiloNuevo,
      duracion,
      usage: resultado.uso,
      error: resultado.ok ? null : (resultado.error || (resultado.cancelado ? 'Charla cancelada.' : 'La charla falló sin detalle.')),
      costoUsd: resultado.costoUsd,
      origen,
      cuota: resultado.cuota
    });
    return { resultado, pedido, hilo, hiloNuevo, duracion, cuenta, busqueda };
  };

  // FEAT-097 — Si agy no puede y `fallback_agy` está activo, una vez más con
  // `claude@<cuenta>` (Sonnet, esfuerzo low). Un rol con motor fijo, no.
  const intento = await fallbackAgy.conFallbackDeRol({
    config: contextoMotor.config, eleccion: eleccionDelRol, tipo: 'alma', intentar: intentarCon, estado: contextoMotor.fallback || null,
    // FEAT-107 — El modelo que agy usaría (el bot lo manda en `opciones.model`) y la cuota guardada de su grupo.
    modelo: eleccionDelRol.modelo || opciones.model || null, revisarCuota: contextoMotor.revisarCuota || null
  });
  const { resultado, eleccion, fallback } = intento;
  if (resultado.preflight) return { ok: false, motivo: resultado.error };
  const { pedido, hilo, hiloNuevo, duracion, cuenta, busqueda } = intento;
  const motor = eleccion.motor;

  // FEAT-076 — `modelo` y `esfuerzo` pedidos viajan con el resultado: el
  // registro de tareas los guarda para la Actividad reciente de la consola.
  const base = {
    clave, hilo: hiloNuevo, continuado: Boolean(hilo), duracion, usage: resultado.uso,
    motor: motor.id, cuenta, modelo: pedido.modelo || null, modeloReal: resultado.modeloReal, esfuerzo: pedido.esfuerzo || null,
    costoUsd: resultado.costoUsd,
    fallback
  };
  if (resultado.cancelado) return { ...base, ok: false, cancelled: true, motivo: resultado.error || 'Charla cancelada.' };
  if (!resultado.ok) return { ...base, ok: false, motivo: resultado.error || 'La charla falló sin detalle.' };

  const crudo = resultado.texto;
  // FEAT-058 — Primero el tablero: un `<tablero>` sin cerrar no se lleva el
  // bloque de memoria. Se extrae siempre, aunque no se haya pedido, para que
  // nunca se muestre; aplicarlo (o no) lo decide el bot.
  const deTablero = bloqueTablero.extraerBloque(crudo);
  const { respuesta, operaciones } = bloque.extraerBloque(deTablero.respuesta, { conTema: true });
  // FEAT-166 — Un motor sin estado guarda el turno en su hilo local, ya sin
  // `<alma>` ni `<tablero>`. Un error de lock o de disco no cuesta la respuesta:
  // el archivo es la fuente de verdad y el próximo turno nace con la foto.
  if (typeof motor.agregarTurno === 'function' && !opciones.aislado && hiloNuevo && resultado.userEnviado) {
    try {
      motor.agregarTurno({ clave, hilo: hiloNuevo, user: resultado.userEnviado, assistant: respuesta, promptTokens: resultado.promptTokens }, env);
    } catch (err) {
      process.stderr.write(`[almas] No se pudo guardar el turno de ${clave} en su hilo local: ${err.message}\n`);
    }
  }
  const { aplicadas, rechazadas } = aplicarOperaciones(clave, operaciones, env);
  const dados = busqueda ? { ids: busqueda.resultados.map(r => r.id), omitidas: busqueda.omitidas } : null;
  anotarEnDiario(clave, { respuesta, aplicadas, rechazadas, metadatos: opciones.diario, motor: motor.id, modeloReal: resultado.modeloReal, cuenta, hilo: hiloNuevo, fallback: Boolean(fallback), recuerdos: dados }, env);

  return {
    ...base,
    ok: true,
    respuesta: respuesta || '(se quedó sin palabras)',
    aplicadas,
    rechazadas,
    tablero: { operaciones: deTablero.operaciones, sobrantes: deTablero.sobrantes }
  };
}

module.exports = { charlar, armarPrompt, aplicarOperaciones, registrarRechazosPorTope, registrarSinRomper };
