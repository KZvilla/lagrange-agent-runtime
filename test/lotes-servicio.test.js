const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crearRegistro } = require('../mcp-server/lotes/registro.js');
const { crearServicioLotes } = require('../mcp-server/lotes/servicio.js');
const { adquirirBloqueo, liberarBloqueo, rutaBloqueo } = require('../mcp-server/lotes/bloqueo.js');
const { diffCommit, MAX_DIFF } = require('../mcp-server/lotes/diff.js');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-servicio-'));
const repo = path.join(raiz, 'repo');
const datos = path.join(raiz, 'datos');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
const docker = async () => ({ code: 0, stdout: 'ok', stderr: '' });
const solicitud = {
  slug: 'web-prueba-1', cwd: repo, modelo: 'gemini-3.8-flash', effort: 'high', concurrencia: 2, timeout_minutes: 20,
  tareas: [
    { id: 't_a', prompt: 'Cambiar A', archivos: ['src/a.js'], prueba: { argv: ['node', 'test/a.test.js'], timeout_minutes: 5 } },
    { id: 't_b', prompt: 'Cambiar B', archivos: ['src/b.js'] }
  ]
};

const pruebas = [];

pruebas.push(group('servicio compartido de lotes', () => {
  const registro = crearRegistro({ dir: datos });
  const servicio = crearServicioLotes({ registro, docker, aWsl: async (x) => x,
    config: { fanoutStatusline: false, fanoutControl: false, fanoutProgressLog: false }, recolectar: async () => {},
    fanout: async () => ({ lanzado: false, detalle: 'fallo simulado' }), ejecutarStream: async () => {}, ejecutarStdin: async () => {} });
  const normal = servicio.validarSolicitud(solicitud);
  check('normaliza la misma solicitud sin efectos', normal.id === solicitud.slug && normal.tareas.length === 2 && normal.timeoutMinutes === 20);
  let rechazo = false;
  try { servicio.validarSolicitud({ ...solicitud, slug: 'otro', tareas: [solicitud.tareas[0], { ...solicitud.tareas[1], archivos: ['src/a.js'] }] }); } catch { rechazo = true; }
  check('rechaza repartos solapados antes del preflight', rechazo);

  return servicio.preparar(solicitud).then(async (reserva) => {
    check('preparar persiste la reserva', registro.leer(solicitud.slug)?.estado === 'corriendo');
    check('preparar conserva el lock del repo', fs.existsSync(rutaBloqueo(repo)));
    await servicio.cancelar(reserva, 'familia cambió');
    check('cancelar marca fallido y libera lock', registro.leer(solicitud.slug)?.estado === 'fallido' && !fs.existsSync(rutaBloqueo(repo)));

    const segunda = { ...solicitud, slug: 'web-prueba-2' };
    const reserva2 = await servicio.preparar(segunda);
    const bg = servicio.ejecutarEnSegundoPlano(reserva2, { onError: () => {} });
    check('background responde sin esperar', bg.id === segunda.slug && bg.estado === 'corriendo');
    await bg.promesa;
    check('el rechazo terminal queda consumido y persistido', registro.leer(segunda.slug)?.estado === 'fallido');

    let usosAuditoria = 0;
    const feliz = crearServicioLotes({ registro, docker, aWsl: async (x) => x,
      config: { fanoutStatusline: false, fanoutControl: false, fanoutProgressLog: false }, recolectar: async () => {},
      fanout: async ({ tareas }) => ({ lanzado: true, resultados: tareas.map((t, i) => ({
        id: t.id, exito: true, rama: `wt/agy-web-prueba-3-${i + 1}`, ruta: repo,
        commit: `abcdef${i + 1}`, anomalias: [], conversation_id: `c${i + 1}`
      })) }),
      crearVerificadorFn: () => async ({ prueba }) => ({ estado: prueba ? 'paso' : 'no configurada', argv: prueba?.argv || null, exitCode: prueba ? 0 : null, duracionMs: 1, salida: '', salidaTruncada: false }),
      crearAuditorFn: () => async () => ({ estado: 'completa', veredicto: 'PASS', modelo: 'gemini-3.1-pro', conversation_id: 'audit', reporte: '## Verdict: PASS', error: null, duracionMs: 1, usage: {} }),
      registrarUso: (tipo) => { if (tipo === 'audit') usosAuditoria++; },
      ejecutarStream: async () => {}, ejecutarStdin: async () => {} });
    const terminado = await feliz.lanzarYEsperar({ ...solicitud, slug: 'web-prueba-3' });
    check('ejecutar recorre fanout, verificación y auditoría hasta para revisar',
      terminado.estado === 'para revisar'
      && terminado.tareas.every((t) => t.estado === 'para revisar' && t.auditoria.veredicto === 'PASS'));
    check('el happy path registra auditorías y libera el lock', usosAuditoria === 2 && !fs.existsSync(rutaBloqueo(repo)));
  });
}));

// FEAT-011 — La skill se resuelve antes del lock y del registro; el cuerpo
// no viaja ni en la reserva ni en el registro.
pruebas.push(group('skill por tarea en lotes (FEAT-011)', async () => {
  const datosSkill = path.join(raiz, 'datos-skill');
  const repoSkill = path.join(raiz, 'repo-skill');
  fs.mkdirSync(path.join(repoSkill, '.git'), { recursive: true });
  const registro = crearRegistro({ dir: datosSkill });
  const cuerpos = { buena: 'CUERPO-BUENO', absoluta: 'usá C:\\Users\\x\\algo', grande: 'g'.repeat(40 * 1024) };
  let deps = null;
  const servicio = crearServicioLotes({ registro, docker, aWsl: async (x) => x,
    config: { fanoutStatusline: false, fanoutControl: false, fanoutProgressLog: false }, recolectar: async () => {},
    leerCuerpoSkill: (n) => cuerpos[n] ?? null,
    fanout: async (_o, d) => { deps = d; return { lanzado: false, detalle: 'fin' }; },
    ejecutarStream: async () => {}, ejecutarStdin: async () => {} });
  const base = { slug: 'skill-1', cwd: repoSkill, modelo: 'gemini-3.8-flash', tareas: [{ id: 't_a', prompt: 'Cambiar A', archivos: ['src/a.js'] }] };
  const conSkill = (skill, extra = {}) => ({ ...base, tareas: [{ ...base.tareas[0], skill, ...extra }] });
  const rechaza = (sol, re) => { try { servicio.validarSolicitud(sol); return false; } catch (e) { return re.test(e.message); } };

  check('skill inexistente se rechaza', rechaza(conSkill('nada'), /skill "nada"/));
  check('cuerpo con ruta absoluta se rechaza', rechaza(conSkill('absoluta'), /ruta absoluta del host/));
  check('prompt final de más de 120 KB se rechaza', rechaza(conSkill('grande', { prompt: 'Cambiar A ' + 'p'.repeat(90 * 1024) }), /tope es 120 KB/));

  let lockAntes = false;
  try { await servicio.preparar(conSkill('nada')); } catch { lockAntes = fs.existsSync(rutaBloqueo(repoSkill)); }
  check('rechazada en preparar: ni lock ni registro', !lockAntes && !fs.existsSync(rutaBloqueo(repoSkill)) && registro.leer('skill-1') === null);

  const valida = servicio.validarSolicitud(conSkill('buena'));
  check('la reserva no trae skillCuerpo', !JSON.stringify(valida).includes('CUERPO-BUENO') && valida.tareas[0].skill === 'buena');
  const reserva = await servicio.preparar(conSkill('buena'));
  const guardado = registro.leer('skill-1');
  check('el registro guarda el nombre de la skill', guardado.tareas[0].skill === 'buena');
  check('el registro no guarda el cuerpo', !JSON.stringify(guardado).includes('CUERPO-BUENO'));
  await servicio.ejecutarEnSegundoPlano(reserva, { onError: () => {} }).promesa;
  check('fanout recibe el lector y la validación del cuerpo',
    deps && typeof deps.leerCuerpoSkill === 'function' && deps.leerCuerpoSkill('buena') === 'CUERPO-BUENO'
    && /ruta absoluta/.test(deps.validarCuerpo('C:\\x') || ''));
}));

pruebas.push(group('lock por repositorio', () => {
  const otroRepo = path.join(raiz, 'lock-repo');
  const uno = adquirirBloqueo(otroRepo, 'uno');
  let ocupado = false;
  try { adquirirBloqueo(otroRepo, 'dos'); } catch { ocupado = true; }
  check('un proceso vivo impide otro lote', ocupado);
  check('solo el dueño libera', liberarBloqueo({ ...uno, token: 'incorrecto' }) === false && fs.existsSync(uno.archivo));
  check('el dueño libera su lock', liberarBloqueo(uno) && !fs.existsSync(uno.archivo));
}));

pruebas.push(group('diff exacto acotado', () => {
  let argv = null;
  return diffCommit({ repo, commit: 'abcdef1', ejecutar: (_bin, args, opciones, cb) => { argv = { args, opciones }; cb(null, 'diff seguro', ''); } })
    .then((r) => {
      check('usa git show sobre el SHA exacto y sin shell', argv.args.includes('abcdef1') && argv.args.includes('show') && argv.opciones.shell === false);
      check('aplica el límite en el subprocess', argv.opciones.maxBuffer === MAX_DIFF + 1 && r.diff === 'diff seguro');
      return diffCommit({ repo, commit: 'abcdef1', ejecutar: (_b, _a, _o, cb) => cb(Object.assign(new Error('grande'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '', '') })
        .then(() => check('rechaza maxBuffer', false), (err) => check('rechaza maxBuffer', /supera/.test(err.message)));
    });
}));

Promise.all(pruebas).then(() => {
  try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
  report();
}).catch((err) => {
  console.error(err);
  try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
