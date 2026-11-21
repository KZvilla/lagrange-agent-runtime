/**
 * FEAT-206 S0 — El respaldo de cada rol, sea cual sea su motor.
 *
 *   - la causa estructurada: los ejecutores la ponen por status (y Go distingue el 429 upstream); un timeout no cae;
 *   - `motivoMotor`: qué causas caen en cada motor;
 *   - `eleccionDeRespaldo`: engine, hilo, null propio o heredado, mismo motor, claude a claude, sin destino capaz, el
 *     valor por defecto de un alma en Go y agy en modo manual;
 *   - los caminos: un texto fijo en un motor de API cae a otro motor o a agy, con una fila de uso por intento lanzado;
 *     un alma en claude sin CLI cae; la lectura no cae a claude;
 *   - claude no corre un rol de lectura, y la carga saca solo esa entrada;
 *   - la validación usa el motor efectivo del rol.
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');

const MCP = path.join(__dirname, '..', 'mcp-server');
const respaldo = require(path.join(MCP, 'motores', 'respaldo.js'));
const motores = require(path.join(MCP, 'motores', 'index.js'));
const causas = require(path.join(MCP, 'motores', 'causas.js'));
const goEj = require(path.join(MCP, 'motores', 'opencode-go-ejecutar.js'));
const dsEj = require(path.join(MCP, 'motores', 'deepseek-ejecutar.js'));
const roles = require(path.join(MCP, 'motores', 'roles.js'));
const capacidades = require(path.join(MCP, 'motores', 'capacidades.js'));
const forma = require(path.join(MCP, 'lib', 'forma-fallback.js'));
const { destinoManual } = require(path.join(MCP, 'motores', 'manual.js'));

const agy = motores.motorPorId('antigravity');
const claude = motores.motorPorId('claude');
const deepseek = motores.motorPorId('deepseek');
const go = motores.motorPorId('opencode-go');
const silencio = () => {};
const KEY = async () => ({ key: 'sk-falsa-feat206-1234567890abcd', motivo: null });
const sinEspera = async () => {};

/** Un fetch de mentira: responde `status` con `cuerpo`, siempre. */
const fetchCon = (status, cuerpo = '{}') => async () => ({ ok: status >= 200 && status < 300, status, text: async () => cuerpo });
const respuestaOk = (texto) => JSON.stringify({ model: 'm', choices: [{ message: { content: texto }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

async function main() {
  await group('la causa en los ejecutores', async () => {
    const spec = { cuerpo: { model: 'deepseek-v4.1-flash', messages: [] }, url: 'https://x/chat' };
    const g = (status, cuerpo) => goEj.ejecutarOpencodeGo(spec, { leer: KEY, fetchImpl: fetchCon(status, cuerpo), esperar: sinEspera });
    check('Go 429 de cupo: cupo', (await g(429, '{"error":"rate limited"}')).causa === 'cupo');
    check('Go 429 «Endpoint is unavailable» tras los reintentos: caido', (await g(429, 'Upstream request failed: Endpoint is unavailable')).causa === 'caido');
    check('Go 401: sin-key', (await g(401)).causa === 'sin-key');
    check('Go 503 tras los reintentos: caido', (await g(503)).causa === 'caido');
    check('Go 400: sin causa (no cae)', (await g(400)).causa === null);
    const sinKey = await goEj.ejecutarOpencodeGo(spec, { leer: async () => ({ key: null, motivo: null }), fetchImpl: fetchCon(200) });
    check('Go sin key: sin-key', sinKey.causa === 'sin-key');
    const d = (status) => dsEj.ejecutarDeepseek(spec, { leer: KEY, fetchImpl: fetchCon(status) });
    check('DeepSeek 402 (sin saldo): cupo', (await d(402)).causa === 'cupo');
    check('DeepSeek 403: sin-key', (await d(403)).causa === 'sin-key');
    const reset = async () => { const e = new Error('reset'); e.code = 'ECONNRESET'; throw e; };
    check('una conexión que falla: caido', (await dsEj.ejecutarDeepseek(spec, { leer: KEY, fetchImpl: reset })).causa === 'caido');
    const colgado = (url, op) => new Promise((ok, mal) => op.signal.addEventListener('abort', () => mal(new Error('aborted'))));
    const plazo = await dsEj.ejecutarDeepseek(spec, { leer: KEY, fetchImpl: colgado, timeoutMinutes: 0.001 });
    check('el plazo vencido: sin causa (un timeout nunca cae)', !plazo.success && plazo.causa === null && /pasó los/.test(plazo.error), JSON.stringify(plazo));
    check('interpretar conserva la causa', deepseek.interpretar({ success: false, error: 'x', causa: 'cupo' }).causa === 'cupo' && go.interpretar({ success: false, error: 'x', causa: 'caido' }).causa === 'caido');
    check('causaPorEstado: 5xx caido, 422 nada', causas.causaPorEstado(502) === 'caido' && causas.causaPorEstado(422) === null);
  });

  await group('motivoMotor: qué causas caen en cada motor', () => {
    const f = (causa) => ({ ok: false, error: 'x', causa });
    check('deepseek: cupo, sin-key y caido caen', ['cupo', 'sin-key', 'caido'].every((c) => respaldo.motivoMotor('deepseek', f(c)) === c));
    check('deepseek: sondas no (no tiene sondas)', respaldo.motivoMotor('deepseek', f('sondas')) === null);
    check('opencode-go: sondas cae', respaldo.motivoMotor('opencode-go', f('sondas')) === 'sondas');
    check('claude: sin-cli, sondas y cuota caen', ['sin-cli', 'sondas', 'cuota'].every((c) => respaldo.motivoMotor('claude', f(c)) === c));
    check('sin causa: no cae', respaldo.motivoMotor('deepseek', f(null)) === null && respaldo.motivoMotor('claude', f(undefined)) === null);
    check('cancelado u ok: no cae', respaldo.motivoMotor('deepseek', { ok: false, cancelado: true, causa: 'cupo' }) === null && respaldo.motivoMotor('deepseek', { ok: true, causa: 'cupo' }) === null);
    check('agy: el modo manual por causa o por marca', respaldo.motivoMotor('antigravity', { success: false, error: 'x', causa: 'manual' }) === 'manual' && respaldo.motivoMotor('antigravity', { success: false, error: 'x', manual: true }) === 'manual');
    check('agy: el resto con sus regex de siempre', respaldo.motivoMotor('antigravity', { success: false, error: 'Individual quota reached' }) === 'cuota' && respaldo.motivoMotor('antigravity', { success: false, error: 'watchdog timed out' }) === null);
  });

  await group('eleccionDeRespaldo', () => {
    const C = (fallbackAgy, mapa = {}, rolesTabla = {}) => ({ fallbackAgy, fallbackAgyRoles: mapa, motores: { cuentas: { trabajo: {} }, roles: rolesTabla } });
    const enGo = { motor: go, modelo: 'deepseek-v4.1-flash', fijo: true, seleccion: 'rol' };
    const r = respaldo.eleccionDeRespaldo(C('deepseek'), enGo, 'lectura', { rol: 'audit', manual: false });
    check('audit en Go con el global deepseek: cae a deepseek', r.eleccion && r.eleccion.motor === deepseek);
    check('la elección de lectura sale completa (la acepta despacharApi)', r.eleccion.seleccion && r.eleccion.modelo && r.eleccion.esfuerzo === 'max');
    check('y se marca como respaldo', respaldo.esEleccionDeRespaldo(r.eleccion));
    const engineApi = { ...enGo, seleccion: 'engine' };
    check('engine de API: no cae (engine)', respaldo.eleccionDeRespaldo(C('deepseek'), engineApi, 'lectura', { rol: 'audit', manual: false }).no === 'engine');
    const engineAgy = { ...motores.elegir(null, 'audit'), seleccion: 'engine' };
    check('engine agy: cae como siempre', Boolean(respaldo.eleccionDeRespaldo(C('deepseek'), engineAgy, 'lectura', { rol: 'audit', manual: false }).eleccion));
    check('engine agy con respaldo antigravity: mismo motor, no relanza agy', respaldo.eleccionDeRespaldo(C('antigravity'), engineAgy, 'lectura', { rol: 'audit', manual: false }).no === 'mismo-motor');
    check('hilo retomado: no cae', respaldo.eleccionDeRespaldo(C('deepseek'), engineAgy, 'lectura', { rol: 'audit', hilo: true }).no === 'hilo-retomado');
    check('mismo motor: Go con respaldo Go', respaldo.eleccionDeRespaldo(C('opencode-go'), enGo, 'lectura', { rol: 'audit', manual: false }).no === 'mismo-motor');
    const enClaude = { motor: claude, modelo: 'sonnet', fijo: true, seleccion: 'rol' };
    check('claude a claude: no rige', respaldo.eleccionDeRespaldo(C('claude@trabajo'), enClaude, 'alma', { rol: 'alma:ana', manual: false }).no === 'claude-a-claude');
    check('la lectura no cae a claude: sin-destino-capaz', respaldo.eleccionDeRespaldo(C('claude@trabajo'), enGo, 'lectura', { rol: 'audit', manual: false }).no === 'sin-destino-capaz');
    const agyDest = respaldo.eleccionDeRespaldo(C('antigravity'), enGo, 'lectura', { rol: 'audit', manual: false }).eleccion;
    check('antigravity como destino: agy sin fallback: true (conserva el modelo del llamador)', agyDest && agyDest.motor === agy && agyDest.fallback === undefined && agyDest.seleccion === 'respaldo' && agyDest.modelo === null);
    check('antigravity como destino en modo manual: agy-manual', respaldo.eleccionDeRespaldo(C('antigravity'), enGo, 'lectura', { rol: 'audit', manual: true }).no === 'agy-manual');
    const almaGo = { motor: go, modelo: 'deepseek-v4.1-flash', fijo: true, seleccion: 'rol' };
    const def = respaldo.eleccionDeRespaldo(C(null), almaGo, 'alma', { rol: 'alma:ana', manual: false });
    check('alma en Go sin respaldo: el valor por defecto, agy (amplio)', def.eleccion && def.eleccion.motor === agy && def.origen === 'defecto' && def.amplio === true);
    check('alma en Go con el global en Go: también el valor por defecto', respaldo.eleccionDeRespaldo(C('opencode-go'), almaGo, 'alma', { rol: 'alma:ana', manual: false }).origen === 'defecto');
    check('alma en Go con alma: null heredado: corta todo', respaldo.eleccionDeRespaldo(C('deepseek', { alma: null }), almaGo, 'alma', { rol: 'alma:ana', manual: false }).corta === true);
    check('texto en Go sin respaldo: no hay valor por defecto', !respaldo.eleccionDeRespaldo(C(null), almaGo, 'textos', { rol: 'texto', manual: false }).eleccion);
    check('un cast que escribe no cae', respaldo.eleccionDeRespaldo(C('claude@trabajo'), motores.elegir(null, 'cast:x'), 'cast', { rol: 'cast:x', permitido: false }).no === 'cast-solo-lectura');
    check('destinosPosibles: audit en Go ofrece deepseek y antigravity', JSON.stringify(respaldo.destinosPosibles('audit', enGo)) === '["deepseek","antigravity"]');
    check('destinosPosibles: audit en agy ofrece deepseek y opencode-go', JSON.stringify(respaldo.destinosPosibles('audit', null)) === '["deepseek","opencode-go"]');
  });

  await group('textos: un rol fijo en un motor de API cae', async () => {
    const config = { fallbackAgy: 'opencode-go', motores: { cuentas: {}, roles: { texto: { motor: 'deepseek', modelo: 'deepseek-flash' } } } };
    const usos = [];
    const contexto = { leerKeyDeepseek: KEY, leerKeyOpencodeGo: KEY, saldoSinEsperar: () => null, cupoSinEsperar: () => null, modelosServidos: async () => null };
    const ds429 = async () => ({ success: false, status: 429, error: 'DeepSeek 429', causa: 'cupo' });
    const goOk = async () => ({ success: true, respuesta: JSON.parse(respuestaOk('Hola desde Go.')) });
    const agyProhibido = async () => { throw new Error('agy no se tiene que llamar'); };
    const r = await respaldo.conFallback({ config, intentarAgy: agyProhibido, prompt: 'p', estado: null, contexto, ejecutarDeepseek: ds429, ejecutarOpencodeGo: goOk, registrarUso: (u) => usos.push(u), log: silencio });
    check('DeepSeek sin cupo → respondió Go', r.res.success && r.via === 'opencode-go' && r.desde === 'deepseek' && r.motivo === 'cupo', JSON.stringify(r).slice(0, 300));
    check('la nota nombra al que no pudo', respaldo.notaDeVia(r) === 'OpenCode Go (DeepSeek sin cupo)', respaldo.notaDeVia(r));
    check('el uso: una fila por intento lanzado, la del respaldo como fallback:textos', usos.length === 2 && usos[0].rol === 'texto' && usos[1].rol === 'fallback:textos' && usos[1].motor === 'opencode-go', JSON.stringify(usos.map((u) => [u.motor, u.rol])));

    const ds400 = async () => ({ success: false, status: 400, error: 'DeepSeek 400', causa: null });
    const r400 = await respaldo.conFallback({ config, intentarAgy: agyProhibido, prompt: 'p', estado: null, contexto, ejecutarDeepseek: ds400, ejecutarOpencodeGo: goOk, log: silencio });
    check('un 400 no cae', !r400.res.success && r400.via === 'deepseek');

    const sinKeyCtx = { ...contexto, leerKeyDeepseek: async () => ({ key: null, motivo: null }) };
    const usos2 = [];
    const rk = await respaldo.conFallback({ config, intentarAgy: agyProhibido, prompt: 'p', estado: null, contexto: sinKeyCtx, ejecutarDeepseek: ds429, ejecutarOpencodeGo: goOk, registrarUso: (u) => usos2.push(u), log: silencio });
    check('sin key (preflight) cae, y el rechazo no deja fila', rk.res.success && rk.motivo === 'sin-key' && usos2.length === 1 && usos2[0].rol === 'fallback:textos', JSON.stringify(usos2.map((u) => u.rol)));

    const aAgy = { ...config, fallbackAgy: 'antigravity' };
    const usos3 = [];
    let llamadasAgy = 0;
    const agyOk = async () => { llamadasAgy++; return { success: true, data: { response: 'Hola desde agy.', duration_seconds: 2, usage: { input_tokens: 5 } } }; };
    const ra = await respaldo.conFallback({ config: aAgy, intentarAgy: agyOk, prompt: 'p', estado: null, contexto, ejecutarDeepseek: ds429, registrarUso: (u) => usos3.push(u), log: silencio });
    check('a agy como destino: respondió agy', ra.res.success && ra.via === 'antigravity' && llamadasAgy === 1);
    check('el uso de agy lo registra el respaldo (fallback:textos) y sale sin data.usage', usos3.some((u) => u.motor === 'antigravity' && u.rol === 'fallback:textos') && !ra.res.data.usage);
    check('la nota: «Antigravity (DeepSeek sin cupo)»', respaldo.notaDeVia(ra) === 'Antigravity (DeepSeek sin cupo)');
  });

  await group('almas: un rol en claude sin CLI cae', async () => {
    const config = { fallbackAgy: 'deepseek', motores: { cuentas: {}, roles: { alma: { motor: 'claude', modelo: 'sonnet' } } } };
    const vistos = [];
    const intentar = async (e) => {
      vistos.push(e.motor.id);
      if (e.motor.id === 'claude') return { resultado: { ok: false, error: 'el motor claude no está disponible', preflight: true, causa: 'sin-cli' } };
      return { resultado: { ok: true, texto: 'hola' } };
    };
    const r = await respaldo.conFallbackDeRol({ config, eleccion: motores.elegir(config, 'alma:ana'), tipo: 'alma', rol: 'alma:ana', intentar, log: silencio });
    check('claude sin CLI → deepseek', vistos.join() === 'claude,deepseek' && r.fallback && r.fallback.motor === 'deepseek' && r.fallback.desde === 'claude' && r.fallback.motivo === 'sin-cli', JSON.stringify(r.fallback));
    const vistos2 = [];
    const intentar2 = async (e) => { vistos2.push(e.motor.id); return { resultado: { ok: false, error: 'claude falló (API 500)', causa: null } }; };
    await respaldo.conFallbackDeRol({ config, eleccion: motores.elegir(config, 'alma:ana'), tipo: 'alma', rol: 'alma:ana', intentar: intentar2, log: silencio });
    check('un fallo sin causa no cae', vistos2.join() === 'claude');
  });

  await group('modo manual: una lectura con respaldo capaz no va a la cola', () => {
    check('audit en agy con respaldo: normal', destinoManual({ herramienta: 'agy_audit', args: {}, manual: true, respaldo: true }) === 'normal');
    check('audit en agy sin respaldo: cola', destinoManual({ herramienta: 'agy_audit', args: {}, manual: true }) === 'cola');
    const src = fs.readFileSync(path.join(MCP, 'index.js'), 'utf8');
    const f = src.slice(src.indexOf('function usaFlujoManual'), src.indexOf('function usaFlujoManual') + 1400);
    check('usaFlujoManual resuelve el respaldo con el hilo', /eleccionDeRespaldo\(config, el, 'lectura', \{ rol, hilo \}\)/.test(f) && /continue_session/.test(f));
  });

  await group('la lectura por rol cae (index.js)', () => {
    const src = fs.readFileSync(path.join(MCP, 'index.js'), 'utf8');
    const f = src.slice(src.indexOf('async function ejecutarSoloLectura'), src.indexOf('async function ejecutarSoloLectura') + 9000);
    check('el rol de API decide con motivoMotor y eleccionDeRespaldo', /fallbackAgy\.motivoMotor\(pretendido, ds\)/.test(f) && /fallbackAgy\.eleccionDeRespaldo\(config, eleccion, 'lectura', \{ rol \}\)/.test(f));
    check('el pie dice Role al responder el rol y Fallback al caer', /origen: origenDelRol/.test(f) && /origen: `Fallback: \$\{nota\}`/.test(f));
    check('agy como destino tiene su camino', /correrAgyComoRespaldoDeLectura\(/.test(f));
    check('conRespaldo de lectura recibe la elección que corre', /eleccion: eleccion\.error \? null : eleccion,/.test(f));
  });

  await group('claude no corre un rol de lectura', () => {
    check('faltaParaRol lo rechaza', /lectura de claude necesita un cast/.test(capacidades.faltaParaRol('claude', 'audit', 'sonnet') || ''));
    check('un cast en claude sigue valiendo', capacidades.faltaParaRol('claude', 'cast', 'sonnet') === null);
    const carga = roles.validarRoles({ review: { motor: 'claude', modelo: 'sonnet' }, alma: { motor: 'opencode-go', modelo: 'deepseek-v4.1-flash' } });
    check('la carga saca solo esa entrada, con aviso', carga.ok && !carga.roles.review && carga.roles.alma && carga.avisos.some((a) => /review/.test(a)));
    const escritura = roles.validarRoles({ review: { motor: 'claude', modelo: 'sonnet' } }, { estricto: true });
    check('la escritura la rechaza', !escritura.ok && /lectura de claude/.test(escritura.motivo));
  });

  await group('la validación usa el motor efectivo del rol', () => {
    const rolesTabla = { cast: { motor: 'claude', modelo: 'sonnet' }, review: { motor: 'deepseek', modelo: 'deepseek-flash' } };
    check('antigravity es un destino válido', forma.formaDeFallback('antigravity').motor === 'antigravity' && forma.validarRespaldoRol('texto', 'antigravity', []).ok);
    const e1 = forma.validarRespaldoRol('cast:lector', 'claude@trabajo', ['trabajo'], { roles: rolesTabla });
    check('cast:lector hereda claude de cast: claude@trabajo no (claude-a-claude)', !e1.ok && e1.regla === 'claude-a-claude');
    check('el 400 dice cómo limpiar sin borrar el mapa', /fallback_agy_roles entero/.test(e1.motivo));
    check('review en deepseek con respaldo deepseek: mismo motor', forma.validarRespaldoRol('review', 'deepseek', [], { roles: rolesTabla }).regla === 'mismo-motor');
    check('sin roles (la forma sola): pasa', forma.validarRespaldoRol('cast:lector', 'claude@trabajo', ['trabajo']).ok);
    const t = forma.validarMapaRespaldos({ 'cast:lector': 'claude@trabajo', review: 'deepseek' }, ['trabajo'], { roles: rolesTabla });
    check('la carga conserva las dos (no rigen) y avisa claude a claude', t.ok && t.mapa['cast:lector'] && t.mapa.review && t.avisos.length === 1);
    check('el texto de los destinos nombra antigravity', /"antigravity"/.test(forma.DESTINOS_VALIDOS_TEXTO));
  });

  await group('los nombres', () => {
    check('nombreDeVia: Antigravity y Claude sin cuenta', respaldo.nombreDeVia(null, 'antigravity') === 'Antigravity' && respaldo.nombreDeVia(null, 'claude') === 'Claude');
    check('notaDeVia sin desde: agy, como antes', respaldo.notaDeVia({ via: 'deepseek', motivo: 'manual' }) === 'DeepSeek (agy en modo manual)');
    const sl = fs.readFileSync(path.join(MCP, 'lib', 'statusline-lagrange.js'), 'utf8');
    check('la statusline no muestra «agy → Antigravity»', /destino\.motor === 'antigravity'\) return null/.test(sl));
  });

  await group('auditoría de la implementación, ronda 1', async () => {
    const claudeMod = require(path.join(MCP, 'motores', 'claude.js'));
    const { ejecutarClaude } = require(path.join(MCP, 'motores', 'claude-ejecutar.js'));
    const fin = (extra) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's', ...extra });
    check('claude: un 5xx de la API es caido', claudeMod.interpretar({ success: false, codigo: 1, eventos: [fin({ api_error_status: 529 })] }).causa === 'caido');
    check('claude: un 4xx no cae', claudeMod.interpretar({ success: false, codigo: 1, eventos: [fin({ api_error_status: 400 })] }).causa === null);
    check('claude: murió sin resultado → caido', claudeMod.interpretar({ success: false, codigo: 3, eventos: [] }).causa === 'caido');
    check('claude: el plazo vencido no cae', claudeMod.interpretar({ success: false, codigo: null, plazo: true, eventos: [], error: 'claude pasó los 15 minutos' }).causa === null);
    check('claude: cancelado no cae', claudeMod.interpretar({ success: false, cancelled: true, codigo: null, eventos: [] }).causa === null);
    const noLanza = await ejecutarClaude({ bin: 'claude', argv: [] }, { lanzar: () => { throw new Error('ENOENT'); } });
    check('claude: no se pudo lanzar → caido', noLanza.causa === 'caido' && claudeMod.interpretar(noLanza).causa === 'caido');
    check('motivoMotor(claude) cae con caido', respaldo.motivoMotor('claude', { ok: false, causa: 'caido' }) === 'caido');

    // Decisión 1 — Si el respaldo tampoco puede, el error lleva los dos motivos.
    const config = { fallbackAgy: 'opencode-go', motores: { cuentas: {}, roles: { texto: { motor: 'deepseek', modelo: 'deepseek-flash' } } } };
    const contexto = { leerKeyDeepseek: KEY, leerKeyOpencodeGo: async () => ({ key: null, motivo: null }), saldoSinEsperar: () => null, cupoSinEsperar: () => null, modelosServidos: async () => null };
    const ds429 = async () => ({ success: false, status: 429, error: 'DeepSeek 429', causa: 'cupo' });
    const doble = await respaldo.conFallback({ config, intentarAgy: async () => { throw new Error('no'); }, prompt: 'p', estado: null, contexto, ejecutarDeepseek: ds429, registrarUso: () => {}, log: silencio });
    check('fallo doble: el error nombra a los dos', !doble.res.success && /DeepSeek sin cupo/.test(doble.res.error) && /opencode-go tampoco/.test(doble.res.error), doble.res.error);
    const rol = await respaldo.conFallback({ config: { motores: { cuentas: {}, roles: { texto: { motor: 'deepseek', modelo: 'deepseek-flash' } } } }, intentarAgy: async () => ({}), prompt: 'p', estado: null, contexto, ejecutarDeepseek: async () => ({ success: true, respuesta: JSON.parse(respuestaOk('ok')) }), registrarUso: () => {}, log: silencio });
    check('textoEnRol: cuotaHasta null fuera de agy y desde null (no cayó)', rol.res.success && rol.cuotaHasta === null && rol.desde === null && rol.via === 'deepseek', JSON.stringify(rol).slice(0, 200));
    check('notaDeVia: un rol texto en claude sin cuenta dice «Claude»', respaldo.notaDeVia({ via: 'claude', motivo: 'rol', cuenta: null }) === 'Claude (motores.roles.texto)');

    // Las notas viejas ya no salen de respaldoParaVista.
    const viejas = ['fijo', 'fijo-en-agy', 'go-reintenta-agy'];
    const cfgs = [
      { fallbackAgy: 'deepseek', motores: { cuentas: {}, roles: { audit: { motor: 'opencode-go', modelo: 'deepseek-v4.1-flash' } } } },
      { fallbackAgy: 'opencode-go', motores: { cuentas: {}, roles: { alma: { motor: 'opencode-go', modelo: 'deepseek-v4.1-flash' } } } },
      { motores: { cuentas: {}, roles: { plan: { motor: 'antigravity' } } } }
    ];
    const notas = cfgs.flatMap((c) => ['audit', 'alma:ana', 'plan', 'texto', 'cast'].map((r) => respaldo.respaldoParaVista(c, r).nota));
    check('respaldoParaVista no emite notas viejas', !notas.some((n) => viejas.includes(n)), JSON.stringify(notas));

    // La escritura sobre una config con audit en claude (que la carga ya saca) conserva el resto.
    const configMotores = require(path.join(MCP, 'motores', 'config-motores.js'));
    const datos = { motores: { cuentas: {}, roles: { audit: { motor: 'claude', modelo: 'sonnet' }, alma: { motor: 'opencode-go', modelo: 'deepseek-v4.1-flash' } } } };
    const g = configMotores.aplicarRol(datos, 'texto', { motor: 'deepseek', modelo: 'deepseek-flash' });
    check('aplicarRol con audit en claude preexistente: no pierde el alma', g.ok ? (g.datos.motores.roles.alma && g.datos.motores.roles.texto) : /audit/.test(g.motivo), JSON.stringify(g).slice(0, 300));
  });

  await group('auditoría de la implementación, ronda 2', () => {
    // La matriz: motor efectivo × destino × camino. Cae exactamente cuando el camino acepta el destino y no es el
    // mismo motor; un alma o consolidación en Go con destino Go cae a agy por defecto (decisión 7).
    const ROL_DE = { textos: 'texto', lectura: 'audit', alma: 'alma:ana', consolidar: 'consolidar:ana', cast: 'cast:x' };
    const fallas = [];
    for (const camino of Object.keys(roles.DESTINOS_POR_CAMINO)) {
      for (const motorRol of ['antigravity', 'claude', 'deepseek', 'opencode-go']) {
        for (const destino of ['antigravity', 'deepseek', 'opencode-go', 'claude@trabajo']) {
          const config = { fallbackAgy: destino, motores: { cuentas: { trabajo: { configDir: '/x' } }, roles: {} } };
          const eleccion = { motor: motores.motorPorId(motorRol), modelo: null, esfuerzo: null, cuenta: motorRol === 'claude' ? 'principal' : null, fijo: true, seleccion: 'rol' };
          const rol = ROL_DE[camino];
          const destMotor = destino.startsWith('claude@') ? 'claude' : destino;
          const r = respaldo.eleccionDeRespaldo(config, eleccion, camino, { rol, manual: false });
          const defecto = (camino === 'alma' || camino === 'consolidar') && motorRol === 'opencode-go' && destMotor === 'opencode-go';
          const esperado = defecto ? 'antigravity' : (roles.DESTINOS_POR_CAMINO[camino].includes(destMotor) && destMotor !== motorRol ? destMotor : null);
          const real = r.eleccion ? r.eleccion.motor.id : null;
          const posibles = respaldo.destinosPosibles(rol, eleccion);
          const coherente = defecto || (posibles.includes(destMotor) === (esperado !== null));
          if (real !== esperado || !coherente) fallas.push(`${camino}/${motorRol}→${destino}: ${real} (esperado ${esperado}; posibles ${posibles})`);
        }
      }
    }
    check('la matriz motor × destino × camino', fallas.length === 0, fallas.slice(0, 5).join(' | '));
    const src = fs.readFileSync(path.join(MCP, 'index.js'), 'utf8');
    check('el pie del cast nombra el motor que respondió', /notaDeVia\(\{ \.\.\.cast\.fallback, via: cast\.fallback\.motor \|\| 'claude' \}\)/.test(src));
    check('el resumen fallido no culpa a agy si el rol corre en otro motor', /fbResumen\.via !== 'agy' && fbResumen\.via !== 'antigravity'/.test(src));
    check('notaDeVia de un cast que cayó a agy', respaldo.notaDeVia({ motivo: 'sin-cli', motor: 'antigravity', desde: 'claude', via: 'antigravity' }) === 'Antigravity (claude sin CLI)', respaldo.notaDeVia({ motivo: 'sin-cli', desde: 'claude', via: 'antigravity' }));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
