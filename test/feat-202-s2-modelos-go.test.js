/**
 * FEAT-202 S2 (D4) — Los modelos de OpenCode Go.
 *
 *   - una tabla local versionada (`MODELOS_GO`) es la única fuente: la leen el validador de roles, el catálogo, `armar`
 *     y el bucle de lectura; un modelo fuera de la tabla falla al cargar la config y en `armar`;
 *   - los perfiles van por modelo; ningún modelo de Go corre casts;
 *   - el catálogo de Go solo informa disponibilidad (6 h de caché) y no frena si no se pudo leer;
 *   - `lectura: 'sondeado'` pide una sonda vigente, con huella; sin ella, el modelo vale como `declarado`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { check, group, report } = require('./lib/assert');
const MCP = path.join(__dirname, '..', 'mcp-server');
const M = (f) => require(path.join(MCP, 'motores', f));
const niveles = M('niveles.js');
const cap = M('capacidades.js');
const roles = M('roles.js');
const go = M('opencode-go.js');
const goEj = M('opencode-go-ejecutar.js');
const lectura = M('deepseek-lectura.js');
const sondasGo = M('sondas-opencode-go.js');
const sondas = M('sondas.js');
const motores = M('index.js');
const { loadConfig } = require(path.join(MCP, 'lib', 'config.js'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const respuesta = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });

async function main() {
  await group('la tabla', async () => {
    const ids = Object.keys(niveles.MODELOS_GO);
    check('deepseek-v4.1-flash primero, glm-5.3 y hy4-flash-free', ids.join() === 'deepseek-v4.1-flash,glm-5.3,hy4-flash-free', ids.join());
    check('el catálogo de la consola sale de la tabla', niveles.MODELOS['opencode-go'].join() === ids.join());
    check('cada fila trae perfiles, niveles, thinking, razón y evidencia',
      Object.values(niveles.MODELOS_GO).every((f) => f.perfiles['sin-tools'] && Array.isArray(f.niveles) && typeof f.thinking === 'boolean' && f.razon && f.evidencia));
    // FEAT-202 S5 — `edicion`: sondeada en hy4-flash-free, declarada en los otros dos hasta que vuelva el cupo de Go.
    check('edicion: hy4 sondeada, los otros declarada', niveles.MODELOS_GO['hy4-flash-free'].perfiles.edicion === 'sondeado'
      && niveles.MODELOS_GO['glm-5.3'].perfiles.edicion === 'declarado' && niveles.MODELOS_GO['deepseek-v4.1-flash'].perfiles.edicion === 'declarado');
    check('fuera de la tabla, bloqueado', /tabla/.test(niveles.modeloBloqueado('opencode-go', 'kimi-k3') || '') && niveles.modeloBloqueado('opencode-go', 'glm-5.3') === null);
    check('niveles por modelo: glm sin esfuerzo, hy4 low/high/max',
      !niveles.nivelesPara('opencode-go', 'glm-5.3').admite && niveles.nivelesPara('opencode-go', 'hy4-flash-free').niveles.join() === 'low,high,max');
  });

  await group('capacidades por modelo', async () => {
    const c = cap.capacidadesDe('opencode-go');
    check('opencode-go va por tabla y no corre casts', c.modelos === 'tabla' && c.casts === false);
    check('los perfiles del motor: el mejor estado de la tabla', c.perfiles['sin-tools'] === 'verificado' && c.perfiles.lectura === 'verificado', JSON.stringify(c.perfiles));
    check('el motor exporta la misma referencia', go.perfiles === c.perfiles);
    check('perfilesDe con modelo', cap.perfilesDe('opencode-go', 'hy4-flash-free').lectura === 'sondeado' && Object.keys(cap.perfilesDe('opencode-go', 'kimi-k3')).length === 0);
    check('audit en glm-5.3: vale', cap.faltaParaRol('opencode-go', 'audit', 'glm-5.3') === null);
    check('cast en Go: le falta casts', /casts/.test(cap.faltaParaRol('opencode-go', 'cast', 'deepseek-v4.1-flash') || ''));
    check('deepseek tampoco corre casts', cap.faltaParaRol('deepseek', 'cast:x') !== null);
    check('claude y antigravity, sí', cap.faltaParaRol('claude', 'cast') === null && cap.faltaParaRol('antigravity', 'cast:x') === null);
  });

  await group('validarRoles', async () => {
    const v = (t, estricto = true) => roles.validarRoles(t, { estricto });
    check('audit, review y plan en Go con los tres modelos', ['deepseek-v4.1-flash', 'glm-5.3', 'hy4-flash-free'].every((m) => v({ audit: { motor: 'opencode-go', modelo: m }, review: { motor: 'opencode-go', modelo: m }, plan: { motor: 'opencode-go', modelo: m } }).ok));
    const fuera = v({ texto: { motor: 'opencode-go', modelo: 'kimi-k3' } }, false);
    check('un modelo fuera de la tabla falla también al cargar', !fuera.ok && /tabla/.test(fuera.motivo), fuera.motivo);
    check('glm-5.3 con esfuerzo: estricto rechaza', !v({ texto: { motor: 'opencode-go', modelo: 'glm-5.3', esfuerzo: 'high' } }).ok);
    const suave = v({ texto: { motor: 'opencode-go', modelo: 'glm-5.3', esfuerzo: 'high' } }, false);
    check('glm-5.3 con esfuerzo: al cargar, sin esfuerzo y con aviso', suave.ok && suave.roles.texto.esfuerzo === null && suave.avisos.length === 1);
    check('cast en Go: rechazado', !v({ 'cast:x': { motor: 'opencode-go', modelo: 'glm-5.3' } }).ok);
    check('run en Go: sin edicion', /edicion/.test(v({ run: { motor: 'opencode-go', modelo: 'glm-5.3' } }).motivo || ''));
  });

  await group('loadConfig con un modelo fuera de la tabla', async () => {
    const home = tmp('feat202s2-home-');
    const proyecto = tmp('feat202s2-proy-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: { roles: { texto: { motor: 'opencode-go', modelo: 'qwen4-max' } } } }));
    const viejoHome = process.env.HOME; const viejoUp = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const c = loadConfig(proyecto);
      check('la tabla de roles se descarta, con aviso', !(c.motores.roles && c.motores.roles.texto) && c.avisos.some((a) => /tabla/.test(a)), JSON.stringify(c.avisos));
      fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: { roles: { audit: { motor: 'opencode-go', modelo: 'glm-5.3' } } } }));
      const c2 = loadConfig(proyecto);
      check('audit en glm-5.3 desde la global, y elegir lo devuelve', motores.elegir(c2, 'audit').motor.id === 'opencode-go' && c2.motores.roles.audit.modelo === 'glm-5.3');
    } finally {
      process.env.HOME = viejoHome; process.env.USERPROFILE = viejoUp;
    }
  });

  await group('armar', async () => {
    const pedido = (modelo, esfuerzo = 'high') => ({ perfil: 'sin-tools', prompt: 'hola', modelo, esfuerzo, aislado: true });
    const ds = go.armar(pedido('deepseek-v4.1-flash'));
    check('deepseek: su modelo, thinking y esfuerzo', ds.cuerpo.model === 'deepseek-v4.1-flash' && ds.cuerpo.thinking && ds.cuerpo.reasoning_effort === 'high');
    const glm = go.armar(pedido('glm-5.3'));
    check('glm: su modelo, sin reasoning_effort', glm.cuerpo.model === 'glm-5.3' && !('reasoning_effort' in glm.cuerpo) && glm.cuerpo.thinking);
    const hy = go.armar(pedido('hy4-flash-free', 'xhigh'));
    check('hy4: un esfuerzo que no admite baja al implícito', hy.cuerpo.model === 'hy4-flash-free' && hy.cuerpo.reasoning_effort === 'low');
    check('el cuerpo sigue en la lista blanca, sin tools', [ds, glm, hy].every((a) => Object.keys(a.cuerpo).every((k) => go.CLAVES_DEL_CUERPO.includes(k)) && !('tools' in a.cuerpo)));
    let lanzo = null;
    try { go.armar(pedido('kimi-k3')); } catch (err) { lanzo = err.message; }
    check('fuera de la tabla, armar lanza', /tabla/.test(lanzo || ''), lanzo);
  });

  await group('disponibilidad (catálogo de Go)', async () => {
    const con = (ids) => ({ modelosServidos: async () => ({ ok: true, ids }) });
    check('servido: ok', (await go.disponible('glm-5.3', con(['glm-5.3']))).ok);
    const no = await go.disponible('glm-5.3', con(['deepseek-v4.1-flash']));
    check('en la tabla pero Go ya no lo sirve: no', !no.ok && /ya no sirve glm-5\.3/.test(no.motivo));
    check('sin catálogo: no frena', (await go.disponible('glm-5.3', { modelosServidos: async () => ({ ok: false, motivo: 'caído' }) })).ok);
    check('fuera de la tabla: no, aunque Go lo sirva', !(await go.disponible('kimi-k3', con(['kimi-k3']))).ok);
    const pre = await go.preflight({ perfil: 'sin-tools', modelo: 'glm-5.3' }, { leerKeyOpencodeGo: async () => ({ key: 'k' }), ...con([]) });
    check('preflight frena un modelo que Go no sirve', !pre.ok && /ya no sirve/.test(pre.motivo), JSON.stringify(pre));

    goEj.olvidarModelos();
    let llamadas = 0;
    const fetchImpl = async (url) => { llamadas += 1; check('pide /openai/v1/models', url === goEj.URL_MODELOS); return respuesta({ data: [{ id: 'glm-5.3' }, { id: 'hy4' }] }); };
    const leer = async () => ({ key: 'k' });
    const a = await goEj.modelosServidos({ fetchImpl, leer, ahora: 1000 });
    const b = await goEj.modelosServidos({ fetchImpl, leer, ahora: 1000 + goEj.MODELOS_TTL_MS - 1 });
    const c = await goEj.modelosServidos({ fetchImpl, leer, ahora: 1000 + goEj.MODELOS_TTL_MS + 1 });
    check('los ids, y 6 h de caché', a.ok && a.ids.join() === 'glm-5.3,hy4' && b === a && c !== a && llamadas === 2, String(llamadas));
    goEj.olvidarModelos();
    const f = await goEj.modelosServidos({ fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }), leer, ahora: 0 });
    check('un 401: ok false, con nuestro texto', !f.ok && /rechazó la key/.test(f.motivo));
    goEj.olvidarModelos();
  });

  await group('bucle de lectura por modelo', async () => {
    const home = tmp('feat202s2-sondas-');
    const raiz = tmp('feat202s2-raiz-');
    fs.writeFileSync(path.join(raiz, 'a.txt'), 'x\n');
    const cuerpos = [];
    const ejecutar = async (spec) => { cuerpos.push(spec.cuerpo); return { success: true, respuesta: { model: spec.cuerpo.model, choices: [{ message: { content: 'informe' }, finish_reason: 'stop' }] } }; };
    const base = { raiz, prompt: 'p', motor: 'opencode-go', ejecutar, homeDir: home };
    const sin = await lectura.revisarConLectura({ ...base, modelo: 'hy4-flash-free' });
    check('hy4 sin sonda vigente: no empieza', !sin.ok && /no está probada/.test(sin.error) && cuerpos.length === 0, sin.error);
    const glm = await lectura.revisarConLectura({ ...base, modelo: 'glm-5.3', esfuerzo: 'max' });
    check('glm-5.3 (verificado): corre, sin reasoning_effort', glm.ok && cuerpos[0].model === 'glm-5.3' && !('reasoning_effort' in cuerpos[0]) && cuerpos[0].tools);
    const def = await lectura.revisarConLectura({ ...base, esfuerzo: 'max' });
    check('sin modelo: deepseek-v4.1-flash con max, como siempre', def.ok && cuerpos[1].model === 'deepseek-v4.1-flash' && cuerpos[1].reasoning_effort === 'max');
    const fuera = await lectura.revisarRepo({ repo: raiz, motor: 'opencode-go', modelo: 'kimi-k3', ejecutar });
    check('revisarRepo con un modelo fuera de la tabla no copia nada', !fuera.ok && /tabla/.test(fuera.error));
    const ds = await lectura.revisarConLectura({ raiz, prompt: 'p', ejecutar, esfuerzo: 'high' });
    check('el motor deepseek no cambia', ds.ok && cuerpos[2].model === 'deepseek-flash' && cuerpos[2].reasoning_effort === 'high' && cuerpos[2].thinking);
  });

  await group('sonda de lectura', async () => {
    const ok = { ok: true, texto: 'En src/faro.txt:2 dice "EL FARO DICE 7319"; ../fuera.txt fue rechazado.', herramientas: 3, pasos: 3, modeloReal: 'hy4-flash-free' };
    check('evaluar: la cita exacta pasa', sondasGo.evaluar(ok, 'hy4-flash-free').resultado === 'pasa');
    check('evaluar: sin la línea, falla', sondasGo.evaluar({ ...ok, texto: 'el número es 7319' }, 'hy4-flash-free').resultado === 'falla');
    check('evaluar: sin tools, falla', sondasGo.evaluar({ ...ok, herramientas: 0 }, 'hy4-flash-free').resultado === 'falla');
    check('evaluar: otro modelo, falla', sondasGo.evaluar({ ...ok, modeloReal: 'otro' }, 'hy4-flash-free').resultado === 'falla');
    check('evaluar: sin cupo, inconclusa', sondasGo.evaluar({ ok: false, error: 'OpenCode Go: cupo agotado o límite (429).' }, 'hy4-flash-free').causa === 'cuota');

    const home = tmp('feat202s2-ctx-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const vistos = [];
    const revisar = async (o) => { vistos.push(o); fs.readFileSync(path.join(o.raiz, 'src', 'faro.txt')); return ok; };
    const ctx = sondasGo.crearContextoSondas({ modelo: 'hy4-flash-free', homeDir: home, revisar, version: () => '9.9.9' });
    check('antes de la sonda: declarado', sondasGo.estadoLectura('hy4-flash-free', { homeDir: home, version: () => '9.9.9' }).estado === 'declarado');
    check('leerSondas rechaza', !(await ctx.leerSondas()).ok);
    const r = await ctx.correrAhora();
    check('la sonda corre sobre el repo de prueba, con sinSonda y el modelo', r.entradas.lectura.resultado === 'pasa' && vistos[0].sinSonda === true && vistos[0].modelo === 'hy4-flash-free' && vistos[0].motor === 'opencode-go');
    check('el repo de prueba se borra', !fs.existsSync(vistos[0].raiz));
    check('después: sondeado', sondasGo.estadoLectura('hy4-flash-free', { homeDir: home, version: () => '9.9.9' }).estado === 'sondeado' && (await ctx.leerSondas()).ok);
    check('otra versión de Lagrange: vuelve a declarado', sondasGo.estadoLectura('hy4-flash-free', { homeDir: home, version: () => '9.9.10' }).estado === 'declarado');
    check('se guarda con la clave opencode-go:<modelo>', Boolean((sondas.leerResultados(home)['opencode-go:hy4-flash-free'] || {}).lectura));
    check('un modelo verificado no pide sonda', sondasGo.puedeLeer('glm-5.3', { homeDir: home }).ok && sondasGo.puedeLeer('deepseek-v4.1-flash', { homeDir: home }).ok);

    const general = motores.crearContextoSondas({ homeDir: home });
    check('motores: opencode-go:<modelo> de la tabla tiene contexto', typeof general.deMotor('opencode-go:hy4-flash-free').correrAhora === 'function');
    check('motores: uno fuera de la tabla rechaza', !(await general.deMotor('opencode-go:kimi-k3').leerSondas()).ok);
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
