/**
 * FEAT-086 — Fijar la versión de modelo por rol y ver a qué resuelve el alias.
 * El catálogo ofrece IDs completos después de los alias, y cada turno de claude
 * con `rol` registra a qué modelo resolvió lo pedido (lo observado, nunca una
 * consulta). Un cambio de resolución se marca una sola vez.
 *
 * Nunca lanza el `claude` real ni agy: `execFile` se parchea antes de requerir
 * los módulos y el ejecutor de claude es doble.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const execFileReal = cp.execFile;
cp.execFile = function (_bin, _args, _opts, cb) {
  if (/taskkill/i.test(String(_bin))) return execFileReal.apply(this, arguments);
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, 'lagrange-alma\nlector\n', ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');
const niveles = require('../mcp-server/motores/niveles.js');
const roles = require('../mcp-server/motores/roles.js');
const usoAgy = require('../mcp-server/lib/uso-agy.js');
const charla = require('../mcp-server/almas/charla.js');
const cast = require('../mcp-server/agents/cast.js');
const consolidar = require('../mcp-server/almas/consolidar.js');
const registro = require('../mcp-server/agents/registry.js');
const semilla = require('../mcp-server/almas/semilla.js');

const valorDe = (argv, flag) => argv[argv.indexOf(flag) + 1];

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat086-'));
  const home = path.join(raiz, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const env = { LAGRANGE_ALMAS_DIR: path.join(raiz, 'almas') };

  try {
    await group('catálogo: alias primero, después IDs para fijar', () => {
      const cl = niveles.catalogo().find(c => c.motor === 'claude').modelos.map(m => m.modelo);
      check('los alias van primero', cl.slice(0, 3).join() === 'sonnet,opus,haiku');
      check('y siguen los IDs completos', ['claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-haiku-4-5'].every(id => cl.indexOf(id) > 2), JSON.stringify(cl));
      check('Fable no se ofrece', !cl.some(m => /fable|best/.test(m)));
      const todos = roles.validarRoles(Object.fromEntries(cl.map((m, i) => [`cast:r${i}`, { motor: 'claude', modelo: m }])), { estricto: true });
      check('cada uno pasa la validación estricta', todos.ok, todos.motivo);
      check('Opus 5.5 fijado conserva su esfuerzo implícito medium', niveles.nivelesPara('claude', 'claude-opus-5-5').implicito === 'medium');
      check('Haiku 4.5 fijado sigue sin esfuerzo', !niveles.nivelesPara('claude', 'claude-haiku-4-5').admite);
      const armado = require('../mcp-server/motores/claude.js').armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'claude-opus-5-5', esfuerzo: 'high' }, { env: {} });
      check('un ID completo llega tal cual a --model', valorDe(armado.argv, '--model') === 'claude-opus-5-5' && valorDe(armado.argv, '--effort') === 'high');
    });

    await group('actualizarResolucion (pura)', () => {
      const t0 = new Date('2026-09-20T10:00:00Z');
      const t1 = new Date('2026-09-21T10:00:00Z');
      const t2 = new Date('2026-09-22T10:00:00Z');
      const base = { rol: 'alma:alya', motor: 'claude', modelo: 'opus' };
      const r1 = usoAgy.actualizarResolucion({}, { ...base, modeloReal: 'claude-opus-5', ahora: t0 });
      check('la primera resolución, sin marca', r1['alma:alya'].modelo === 'claude-opus-5' && r1['alma:alya'].cambio_en === null && r1['alma:alya'].anterior === null);
      const r2 = usoAgy.actualizarResolucion(r1, { ...base, modeloReal: 'claude-opus-5', ahora: t1 });
      check('la misma: solo se actualiza visto_en', r2['alma:alya'].visto_en === t1.toISOString() && r2['alma:alya'].cambio_en === null);
      const r3 = usoAgy.actualizarResolucion(r2, { ...base, modeloReal: 'claude-opus-5-5', ahora: t2 });
      check('cambió: anterior y cambio_en', r3['alma:alya'].modelo === 'claude-opus-5-5' && r3['alma:alya'].anterior.modelo === 'claude-opus-5'
        && r3['alma:alya'].anterior.hasta === t1.toISOString() && r3['alma:alya'].cambio_en === t2.toISOString());
      const r4 = usoAgy.actualizarResolucion(r3, { ...base, modeloReal: 'claude-opus-5-5', ahora: new Date('2026-09-23T10:00:00Z') });
      check('el turno siguiente no re-marca', r4['alma:alya'].cambio_en === t2.toISOString() && r4['alma:alya'].anterior.modelo === 'claude-opus-5');
      const r5 = usoAgy.actualizarResolucion(r4, { ...base, modelo: 'sonnet', modeloReal: 'claude-sonnet-5', ahora: t2 });
      check('otro alias: entrada nueva, sin marca', r5['alma:alya'].alias === 'sonnet' && r5['alma:alya'].cambio_en === null && r5['alma:alya'].anterior === null);
      const r6 = usoAgy.actualizarResolucion(r5, { ...base, modelo: 'sonnet', motor: 'claude@trabajo', modeloReal: 'claude-sonnet-4-6', ahora: t2 });
      check('otra cuenta: entrada nueva, sin marca', r6['alma:alya'].cuenta === 'trabajo' && r6['alma:alya'].cambio_en === null);
      check('modeloReal igual al pedido no registra', usoAgy.actualizarResolucion({}, { ...base, modeloReal: 'opus' }) === null);
      check('agy no registra', usoAgy.actualizarResolucion({}, { ...base, motor: 'antigravity', modeloReal: 'gemini' }) === null);
      check('un rol inválido no registra', usoAgy.actualizarResolucion({}, { ...base, rol: 'cualquiera', modeloReal: 'x' }) === null
        && usoAgy.actualizarResolucion({}, { ...base, rol: null, modeloReal: 'x' }) === null);
      const llena = {};
      for (let i = 0; i < usoAgy.TOPE_RESOLUCIONES; i++) {
        llena[`cast:r${i}`] = { alias: 'opus', cuenta: null, modelo: 'm', visto_en: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() };
      }
      const conTope = usoAgy.actualizarResolucion(llena, { ...base, modeloReal: 'claude-opus-5-5', ahora: t2 });
      check('tope: se descarta la vista hace más tiempo', Object.keys(conTope).length === usoAgy.TOPE_RESOLUCIONES && !conTope['cast:r0'] && conTope['alma:alya']);
    });

    await group('almacén: registra con el lock y sobrevive al reinicio', () => {
      const ruta = path.join(home, '.claude', 'antigravity-usage.json');
      const almacen = usoAgy.crearAlmacenUso({ ruta, stderr: { write() {} } });
      almacen.registrarLlamada({ tool: 'cast', motor: 'claude', rol: 'cast:lector', modelo: 'sonnet', modeloReal: 'claude-sonnet-5' });
      check('queda en resoluciones', almacen.leerResoluciones()['cast:lector'].modelo === 'claude-sonnet-5');
      almacen.registrarLlamada({ tool: 'cast', motor: 'claude', modelo: 'sonnet', modeloReal: 'claude-sonnet-5' });
      check('sin rol, el uso se suma igual y no toca resoluciones', Object.keys(almacen.leerResoluciones()).length === 1 && almacen.leer().session.total_calls === 2);
      almacen.reiniciar();
      check('reiniciar el uso conserva las resoluciones', almacen.leerResoluciones()['cast:lector'] && almacen.leer().session.total_calls === 0);
    });

    await group('superficies: pasan el rol del sujeto', async () => {
      semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });
      const dirSkill = path.join(home, '.gemini', 'config', 'skills', 'revisor');
      fs.mkdirSync(dirSkill, { recursive: true });
      fs.writeFileSync(path.join(dirSkill, 'SKILL.md'), '---\nname: revisor\ndescription: skill de prueba\nrisk: low\n---\n\nRevisá.\n', 'utf8');
      registro.instalarAgente('lector', { skill: 'revisor' }, home);

      const ctx = (tabla) => ({ config: { motores: { roles: tabla } }, bin: 'claude-doble', env: {}, leerSondas: async () => ({ ok: true }) });
      const nuncaAgy = async () => { throw new Error('agy no debería correr'); };
      const cl = async (spec) => {
        const id = spec.argv.includes('--resume') ? valorDe(spec.argv, '--resume') : valorDe(spec.argv, '--session-id');
        return { success: true, lanzado: true, codigo: 0, eventos: [
          { type: 'system', subtype: 'init', session_id: id, tools: [], model: 'claude-sonnet-5' },
          { type: 'result', subtype: 'success', is_error: false, result: 'Hola.', session_id: id,
            modelUsage: { 'claude-sonnet-5': { inputTokens: 5, outputTokens: 5, canonicalModel: 'claude-sonnet-5' } } }
        ] };
      };
      const usos = [];
      await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: nuncaAgy, ejecutarClaude: cl, homeDir: home, env,
        contextoMotor: ctx({ alma: { motor: 'claude', modelo: 'sonnet' } }), registrarUso: u => usos.push(u) });
      check('charla: rol alma:<clave> (aunque la entrada se herede de alma)', usos[0] && usos[0].rol === 'alma:alya' && usos[0].modelo === 'sonnet' && usos[0].modeloReal === 'claude-sonnet-5', JSON.stringify(usos[0]));
      await cast.castear({ agent: 'lector', prompt: 'mirá', cwd: home, agyBin: 'agy', ejecutar: nuncaAgy, ejecutarClaude: cl, homeDir: home,
        contextoMotor: ctx({ cast: { motor: 'claude', modelo: 'sonnet' } }), registrarUso: u => usos.push(u), opciones: { memory: false } });
      check('cast: rol cast:<nombre>', usos[1] && usos[1].rol === 'cast:lector', JSON.stringify(usos[1]));
      const turnos = [];
      for (let i = 0; i < 3; i++) consolidar.agregarTurno(turnos, { rol: 'usuario', texto: `turno ${i}` });
      consolidar.agregarTurno(turnos, { rol: 'alma', texto: 'respuesta' });
      const archivo = consolidar.volcar({ clave: 'alya', streamId: 'prueba-086', turnos }, env);
      await consolidar.consolidarTodos({ archivo, env, agyBin: 'agy', homeDir: home, ejecutar: nuncaAgy, ejecutarClaude: cl,
        registrarUso: u => usos.push(u), contextoMotor: ctx({ consolidar: { motor: 'claude', modelo: 'sonnet' } }) });
      check('consolidación: rol consolidar:<clave>', usos[2] && usos[2].rol === 'consolidar:alya', JSON.stringify(usos[2]));
    });
  } finally {
    try { fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {}
  }
  report();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
