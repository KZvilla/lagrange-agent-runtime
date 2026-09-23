/**
 * FEAT-071 — El motor `antigravity` y las superficies que migraron a él.
 *
 * Es un refactor sin cambio de comportamiento, y lo que lo prueba es la
 * equivalencia de argv (§4.1 del plan): lo que recibe el doble de `ejecutar`
 * tiene que ser, par flag-valor por par flag-valor, lo que armaba el código de
 * antes. Los armadores de antes están copiados abajo tal cual (`legado*`) para
 * que la comparación no dependa del código nuevo. El orden entre flags no se
 * exige (ya difería entre superficies); `-p` al final con el prompt idéntico, sí.
 *
 * agy nunca se ejecuta: `execFile` se parchea antes de requerir los módulos,
 * como en `almas-charla.test.js`, para que `agy agents` resuelva.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

let agentesQueResuelven = ['lagrange-alma', 'lector', 'escritor'];
cp.execFile = function (_bin, _args, _opts, cb) {
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, `${agentesQueResuelven.join('\n')}\n`, ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');
const motor = require('../mcp-server/motores/antigravity.js');
const charla = require('../mcp-server/almas/charla.js');
const consolidar = require('../mcp-server/almas/consolidar.js');
const cast = require('../mcp-server/agents/cast.js');
const registro = require('../mcp-server/agents/registry.js');
const semilla = require('../mcp-server/almas/semilla.js');
const { esfuerzoParaCli } = require('../mcp-server/lib/cli-compat.js');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

// --- Armadores de antes de FEAT-071, copiados tal cual -------------------------

/** `almas/agente.js:argsBase` + `charla.js:130-135` / `consolidar.js:284`. */
function legadoAlma({ modelo, esfuerzo, formato, hilo, prompt }) {
  const args = ['--agent', 'lagrange-alma', '--output-format', formato === 'stream-json' ? 'stream-json' : 'json'];
  if (modelo) args.push('--model', modelo);
  const efectivo = esfuerzoParaCli({ modelo, pedido: esfuerzo, porDefecto: 'low' });
  if (efectivo) args.push('--effort', efectivo);
  return [...args, ...(hilo ? ['--conversation', hilo] : []), '-p', prompt];
}

/** `agents/cast.js:98-128`. `effort` ya resuelto, como lo resolvía castear. */
function legadoCast({ formato, agent, readOnly, effort, model, hilo, prompt }) {
  const cliArgs = ['--output-format', formato, '--agent', agent, '--dangerously-skip-permissions'];
  if (readOnly) cliArgs.push('--mode', 'plan');
  if (effort) cliArgs.push('--effort', effort);
  if (model) cliArgs.push('--model', model);
  if (hilo) cliArgs.push('--conversation', hilo);
  cliArgs.push('-p', prompt);
  return cliArgs;
}

// --- Comparación por pares flag-valor -------------------------------------------

const SIN_VALOR = new Set(['--dangerously-skip-permissions']);

function pares(argv) {
  const cuerpo = argv.slice(0, -2);
  const salida = [];
  for (let i = 0; i < cuerpo.length; i++) {
    if (SIN_VALOR.has(cuerpo[i])) salida.push(cuerpo[i]);
    else { salida.push(`${cuerpo[i]}=${cuerpo[i + 1]}`); i++; }
  }
  return salida.sort();
}

function equivalentes(nuevo, viejo) {
  const colaOk = nuevo.at(-2) === '-p' && viejo.at(-2) === '-p' && nuevo.at(-1) === viejo.at(-1);
  const a = pares(nuevo);
  const b = pares(viejo);
  return colaOk && a.length === b.length && a.every((x, i) => x === b[i]);
}

const detalle = (nuevo, viejo) => `nuevo=${JSON.stringify(pares(nuevo))} viejo=${JSON.stringify(pares(viejo))}`;

/** Un `ejecutar` de mentira que guarda argv y opciones. */
function espia({ conversationId = 'conv-1', respuesta = 'Hola.' } = {}) {
  const llamadas = [];
  const fn = async (cliArgs, opciones) => {
    llamadas.push({ cliArgs, opciones });
    return { success: true, data: { response: respuesta, conversation_id: conversationId, usage: { total_tokens: 3 } } };
  };
  fn.llamadas = llamadas;
  fn.ultimo = () => llamadas[llamadas.length - 1];
  return fn;
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'motores-almas-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'motores-home-'));
  const env = { LAGRANGE_ALMAS_DIR: base };
  semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });
  const dirSkill = path.join(home, '.gemini', 'config', 'skills', 'revisor');
  fs.mkdirSync(dirSkill, { recursive: true });
  fs.writeFileSync(path.join(dirSkill, 'SKILL.md'), '---\nname: revisor\ndescription: skill de prueba\nrisk: low\n---\n\nRevisá.\n', 'utf8');
  registro.instalarAgente('lector', { skill: 'revisor' }, home);
  registro.instalarAgente('escritor', { skill: 'revisor', readOnly: false }, home);

  try {
    await group('armar: matriz contra los armadores de antes (§4.1)', () => {
      const casosAlma = [
        { nombre: 'alma json sin hilo', p: {}, v: {} },
        { nombre: 'alma con hilo', p: { hilo: 'h-1' }, v: { hilo: 'h-1' } },
        { nombre: 'alma en stream', p: { formato: 'stream' }, v: { formato: 'stream-json' } },
        { nombre: 'alma con Claude en agy (sin --effort)', p: { modelo: 'claude-opus-4-6' }, v: { modelo: 'claude-opus-4-6' } },
        { nombre: 'alma con Gemini (low por defecto)', p: { modelo: 'gemini-3.8-flash' }, v: { modelo: 'gemini-3.8-flash' } },
        { nombre: 'alma con esfuerzo explícito', p: { esfuerzo: 'high' }, v: { esfuerzo: 'high' } },
        { nombre: 'consolidación (low explícito)', p: { esfuerzo: 'low' }, v: { esfuerzo: 'low' } }
      ];
      for (const { nombre, p, v } of casosAlma) {
        const nuevo = motor.armar({ perfil: 'sin-tools', prompt: 'hola', formato: 'json', ...p });
        const viejo = legadoAlma({ prompt: 'hola', formato: 'json', ...v });
        check(nombre, equivalentes(nuevo, viejo), detalle(nuevo, viejo));
        check(`${nombre}: nunca skip`, !nuevo.includes('--dangerously-skip-permissions'));
      }

      const casosCast = [
        { nombre: 'cast read_only con hilo', perfil: 'lectura', readOnly: true, hilo: 'h-2' },
        { nombre: 'cast con escritura', perfil: 'edicion', readOnly: false },
        { nombre: 'cast en stream con modelo y esfuerzo', perfil: 'lectura', readOnly: true, stream: true, model: 'gemini-3.1-pro', effort: 'high' }
      ];
      for (const c of casosCast) {
        const nuevo = motor.armar({
          perfil: c.perfil, cast: 'lector', prompt: 'revisá', modelo: c.model, esfuerzo: c.effort,
          hilo: c.hilo, formato: c.stream ? 'stream' : 'json'
        });
        const viejo = legadoCast({
          formato: c.stream ? 'stream-json' : 'json', agent: 'lector', readOnly: c.readOnly,
          effort: c.effort, model: c.model, hilo: c.hilo, prompt: 'revisá'
        });
        check(c.nombre, equivalentes(nuevo, viejo), detalle(nuevo, viejo));
      }

      let tiro = false;
      try { motor.armar({ perfil: 'sin-tools', cast: 'escritor', prompt: 'x' }); } catch { tiro = true; }
      check('sin-tools con cast es un error de programación', tiro);
      tiro = false;
      try { motor.armar({ perfil: 'lectura', prompt: 'x' }); } catch { tiro = true; }
      check('lectura sin cast es un error de programación', tiro);
    });

    await group('interpretar: la forma de P1/P4 a un resultado neutral', () => {
      const r = motor.interpretar({ success: true, data: { response: 'hola', conversation_id: 'c', usage: { t: 1 } } });
      check('éxito', r.ok && !r.cancelado && r.texto === 'hola' && r.hilo === 'c' && r.uso.t === 1);
      const crudo = motor.interpretar({ success: true, data: null, rawOutput: 'crudo' });
      check('sin data cae en rawOutput y sin hilo', crudo.texto === 'crudo' && crudo.hilo === null && crudo.uso === null);
      const cancelado = motor.interpretar({ success: false, cancelled: true, error: 'corte' });
      check('cancelado', !cancelado.ok && cancelado.cancelado && cancelado.error === 'corte');
      check('un resultado nulo es un fallo, no una excepción', motor.interpretar(undefined).ok === false);
    });

    await group('superficies: lo que llega al doble de ejecutar (§4.1, §4.3)', async () => {
      const ejecutar = espia({ conversationId: 'conv-alya' });
      const alSpawn = () => {};
      const alTexto = () => {};
      let r = await charla.charlar({
        clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar, homeDir: home, env,
        opciones: { stream: true, onSpawn: alSpawn, onTexto: alTexto, model: 'claude-opus-4-6' }
      });
      let { cliArgs, opciones } = ejecutar.ultimo();
      let viejo = legadoAlma({ modelo: 'claude-opus-4-6', formato: 'stream-json', prompt: cliArgs.at(-1) });
      check('charla sin hilo en stream: argv equivalente', r.ok && equivalentes(cliArgs, viejo), detalle(cliArgs, viejo));
      check('charla: onSpawn y onTexto llegan a ejecutar', opciones.onSpawn === alSpawn && opciones.onTexto === alTexto);
      check('charla: el timeout por defecto sigue en 5', opciones.timeoutMinutes === 5);
      check('charla: sigue devolviendo usage y hilo', r.usage.total_tokens === 3 && r.hilo === 'conv-alya');

      r = await charla.charlar({ clave: 'alya', texto: 'seguimos', agyBin: 'agy', ejecutar, homeDir: home, env });
      ({ cliArgs } = ejecutar.ultimo());
      viejo = legadoAlma({ hilo: 'conv-alya', formato: 'json', prompt: cliArgs.at(-1) });
      check('charla retomando el hilo: argv equivalente', r.ok && r.continuado && equivalentes(cliArgs, viejo), detalle(cliArgs, viejo));

      const ejecutarCast = espia({ conversationId: 'hilo-lector' });
      const alMirar = () => {};
      const baseCast = { cwd: home, agyBin: 'agy', ejecutar: ejecutarCast, homeDir: home };
      let rc = await cast.castear({ ...baseCast, agent: 'lector', prompt: 'mirá', opciones: { memory: false, stream: true, onActividad: alMirar, onTexto: alTexto, onSpawn: alSpawn } });
      ({ cliArgs, opciones } = ejecutarCast.ultimo());
      viejo = legadoCast({ formato: 'stream-json', agent: 'lector', readOnly: true, prompt: 'mirá' });
      check('cast read_only en stream: argv equivalente', rc.ok && equivalentes(cliArgs, viejo), detalle(cliArgs, viejo));
      check('cast: onSpawn, onTexto y onActividad llegan a ejecutar',
        opciones.onSpawn === alSpawn && opciones.onTexto === alTexto && opciones.onActividad === alMirar);

      rc = await cast.castear({ ...baseCast, agent: 'lector', prompt: 'seguí', opciones: { memory: false } });
      ({ cliArgs } = ejecutarCast.ultimo());
      viejo = legadoCast({ formato: 'json', agent: 'lector', readOnly: true, hilo: 'hilo-lector', prompt: 'seguí' });
      check('cast read_only con hilo: argv equivalente', rc.ok && rc.continuado && equivalentes(cliArgs, viejo), detalle(cliArgs, viejo));

      rc = await cast.castear({ ...baseCast, agent: 'escritor', prompt: 'editá', opciones: { memory: false, model: 'gemini-3.8-flash', effortPorDefecto: 'medium' } });
      ({ cliArgs } = ejecutarCast.ultimo());
      viejo = legadoCast({ formato: 'json', agent: 'escritor', readOnly: false, model: 'gemini-3.8-flash', effort: 'medium', prompt: 'editá' });
      check('cast con escritura: argv equivalente, sin --mode', rc.ok && equivalentes(cliArgs, viejo) && !cliArgs.includes('--mode'), detalle(cliArgs, viejo));
      check('cast: sigue devolviendo effort resuelto', rc.effort === 'medium');

      const ejecutarCons = espia();
      const turnos = [
        { rol: 'usuario', texto: 'Hola.' }, { rol: 'alma', texto: 'Hola.' },
        { rol: 'usuario', texto: 'Uno.' }, { rol: 'alma', texto: 'Dos.' },
        { rol: 'usuario', texto: 'Chau.' }
      ];
      const archivo = consolidar.volcar({ clave: 'alya', streamId: 'motor', turnos }, env);
      const rs = await consolidar.consolidarTodos({ archivo, ejecutar: ejecutarCons, agyBin: 'agy', homeDir: home, env });
      ({ cliArgs } = ejecutarCons.ultimo());
      viejo = legadoAlma({ esfuerzo: 'low', prompt: cliArgs.at(-1) });
      check('consolidación: argv equivalente', rs.length === 1 && rs[0].ok && equivalentes(cliArgs, viejo), detalle(cliArgs, viejo));
    });

    await group('fail-closed (§4.4)', async () => {
      const ejecutar = espia();
      motor.perfiles['sin-tools'] = 'declarado';
      try {
        const r = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar, homeDir: home, env });
        check('sin-tools no verificado: charla devuelve ok:false con motivo', !r.ok && /sin-tools/.test(r.motivo || ''), JSON.stringify(r));
        check('y no se llama a ejecutar', ejecutar.llamadas.length === 0);
        const pre = await motor.preflight({ perfil: 'sin-tools' }, { agyBin: 'agy', homeDir: home });
        check('preflight lo rechaza sin degradar a otro perfil', !pre.ok);
      } finally {
        motor.perfiles['sin-tools'] = 'verificado';
      }

      agentesQueResuelven = ['otro'];
      try {
        const r = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar, homeDir: home, env });
        check('agente no resuelto: charla devuelve ok:false', !r.ok && /no resuelve/.test(r.motivo || ''), JSON.stringify(r));
        const rc = await cast.castear({ cwd: home, agyBin: 'agy', ejecutar, homeDir: home, agent: 'lector', prompt: 'x', opciones: { memory: false } });
        check('agente no resuelto: cast devuelve error sin conversationId', !rc.ok && /No se casteo/.test(rc.error) && !('conversationId' in rc));
        check('ninguno llama a ejecutar', ejecutar.llamadas.length === 0);
      } finally {
        agentesQueResuelven = ['lagrange-alma', 'lector', 'escritor'];
      }

      const desconocido = await motor.preflight({ perfil: 'root' }, { agyBin: 'agy', homeDir: home });
      check('un perfil desconocido se rechaza', !desconocido.ok);
    });
  } finally {
    borrar(base);
    borrar(home);
  }

  report();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
