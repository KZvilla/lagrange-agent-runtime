/**
 * FEAT-205 — El respaldo «si agy no puede» por rol (`fallback_agy_roles`), con el global como valor por defecto:
 *
 *   - la herencia (`alma:<x>` → `alma` → global) con `hasOwnProperty`: un `null` propio corta;
 *   - cada camino de `conRespaldo` usa el destino del rol, y la tabla `DESTINOS_POR_CAMINO` coincide con el runtime;
 *   - las reglas de siempre no cambian (un rol fijo no cae, la lectura con hilo no cae, un cast que edita no cae);
 *   - la validación estricta (escritura) y la tolerante (carga);
 *   - la vista (`respaldo` por rol y por sujeto, sin secretos), `POST /api/v2/motores/rol` con `respaldo`, las reglas
 *     generales `alma` y `cast` en la v2, el 409 de Ajustes y `set_config`;
 *   - los mensajes de cuota con una regla por rol.
 *
 * Nunca lanza agy, claude ni una API: los intentos son dobles.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');

const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);

const respaldo = require(path.join(MCP, 'motores', 'respaldo.js'));
const roles = require(path.join(MCP, 'motores', 'roles.js'));
const forma = require(path.join(MCP, 'lib', 'forma-fallback.js'));
const { loadConfig } = require(path.join(MCP, 'lib', 'config.js'));
const configMotores = require(path.join(MCP, 'motores', 'config-motores.js'));
const motoresMod = require(path.join(MCP, 'motores', 'index.js'));
const { motoresV2 } = require(path.join(MCP, 'motores', 'proyeccion.js'));
const { admitenDe } = require(path.join(MCP, 'motores', 'admiten.js'));
const { ROLES_INTENCION } = require(path.join(MCP, 'motores', 'capacidades.js'));
const niveles = require(path.join(MCP, 'motores', 'niveles.js'));
const ajustes = require(path.join(MCP, 'lib', 'ajustes.js'));

const silencio = () => {};
const CUOTA = 'Antigravity error: "Individual quota reached. Resets in 50h19m22s.". AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}';
const MODELO = 'gemini-3.8-flash';
const T0 = Date.parse('2026-11-20T12:00:00Z');

function estadoFalso() {
  let f = {};
  return respaldo.crearEstado({ leerFallback: () => f, guardarFallback: (v) => { f = v; return true; } });
}
/** Un estado con la cuota del grupo de MODELO agotada: los caminos van directo al destino, sin intentar agy. */
function agotado() {
  const e = estadoFalso();
  respaldo.registrarCuotaAgotada({ estado: e, modelo: MODELO, error: CUOTA, ahora: Date.now() });
  return e;
}
const enAgy = () => ({ motor: motoresMod.motorPorId('antigravity'), modelo: null, esfuerzo: null, cuenta: null, fijo: false });
const CUENTAS = { trabajo: { configDir: '/tmp/trabajo' } };

function homeNuevo(contenido) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat205-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (contenido !== undefined) fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify(contenido, null, 2));
  return home;
}
const archivo = (home) => path.join(home, '.claude', 'antigravity.json');
const leer = (home) => JSON.parse(fs.readFileSync(archivo(home), 'utf8'));

/** Corre un camino con la config dada y devuelve el motor al que cayó (`agy` si no cayó). */
async function caeA(camino, config, { rol, permitido = true, conversationId = null, eleccion = enAgy() } = {}) {
  if (camino === 'textos') {
    const r = await respaldo.conRespaldo('textos', {
      config, rol, intentarAgy: async () => ({ success: false, error: CUOTA }), prompt: 'p', estado: agotado(), modelo: MODELO,
      generar: async () => ({ ok: true, texto: 'x', duracion: 0.1 }), log: silencio
    });
    return r.via;
  }
  if (camino === 'lectura') {
    const r = await respaldo.conRespaldo('lectura', {
      config, rol, intentarAgy: async () => ({ success: false, error: CUOTA }), intentarSuplente: async (m) => ({ success: true, m }),
      estado: agotado(), modelo: MODELO, conversationId, log: silencio
    });
    return r.via;
  }
  const r = await respaldo.conRespaldo(camino, {
    config, eleccion, rol, permitido, estado: agotado(), modelo: MODELO, log: silencio,
    intentar: async (el) => ({ resultado: { ok: true, texto: el.motor.id } })
  });
  return r.fallback ? r.eleccion.motor.id : 'agy';
}

function motoresFalsos(config, { home }) {
  return {
    config: () => config,
    elegir: (c, rol) => {
      const e = motoresMod.elegir(c, rol);
      return { motor: e.motor.id, modelo: e.modelo, esfuerzo: e.esfuerzo, cuenta: e.cuenta || null };
    },
    catalogo: (extras) => niveles.catalogo(extras).map((c) => ({ ...c, cupo: false })),
    estados: async () => [],
    rolesResueltos: (c) => motoresMod.rolesResueltos(c),
    rolesIntencion: Object.keys(ROLES_INTENCION),
    admiten: (rol, cuentas) => admitenDe(rol, { cuentas }),
    respaldoDeRol: (c, rol) => respaldo.respaldoParaVista(c, rol, motoresMod.elegir(c, rol)),
    sondasClaude: () => ({ corriendo: () => false, huellaActual: () => 'h', leerSondas: async () => ({ ok: true }), dispararSiHaceFalta: () => {} }),
    guardarRol: (rol, entrada, opciones) => configMotores.guardarRol(rol, entrada, { ...(opciones || {}), homeDir: home })
  };
}

async function rutasCon(config, home) {
  const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
  const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js').catch(() => ({ crearCanalWeb: () => ({}) }));
  const nucleo = crearNucleoWeb({
    canal: crearCanalWeb(),
    bot: { almasDisponibles: () => [{ clave: 'ana', voz: 'Ana' }], agentesCasteables: () => [{ nombre: 'lector' }] },
    almas: {}, workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({}),
    motores: motoresFalsos(config, { home }),
    ajustes: {
      leer: () => ajustes.leerAjustes({ homeDir: home }),
      guardar: (cuerpo, opciones) => ajustes.guardarAjustes(cuerpo, { ...opciones, homeDir: home }),
      pisadoPorProyecto: () => [], entorno: () => ({})
    }
  });
  const lect = await importar('telegram-bridge/web/v2/lecturas.js');
  const mut = await importar('telegram-bridge/web/v2/mutaciones.js');
  const tareasMod = await importar('telegram-bridge/tareas.js');
  const lecturas = lect.rutasLecturaV2({ nucleo, estadoDeCarriles: () => [], recorte: tareasMod.RECORTE, arranque: 'arr' });
  const mutaciones = mut.rutasMutacionV2({ nucleo, cola: {}, ctx: { chat: { id: 'web:terminal' } }, chatTerminal: 'web:terminal', registro: { obtener: () => null }, idem: null, almacen: { publicar: () => {} }, recorte: tareasMod.RECORTE });
  const llamar = async (metodo, ruta, cuerpo = {}) => {
    const r = [...lecturas, ...mutaciones].find((x) => x.metodo === metodo && x.patron.test(ruta));
    return r.fn({ p: [], cuerpo, url: new URL(`http://x${ruta}`) });
  };
  return { llamar, nucleo };
}

async function main() {
  await group('herencia', () => {
    const c = { fallbackAgy: 'deepseek', fallbackAgyRoles: { alma: 'opencode-go', 'alma:ana': 'claude@trabajo', cast: null } };
    const d = (rol) => { const x = respaldo.destinoDeFallback(c, rol); return x ? (x.cuenta ? `claude@${x.cuenta}` : x.motor) : null; };
    check('propio gana', d('alma:ana') === 'claude@trabajo');
    check('sin propio, la regla general', d('alma:bea') === 'opencode-go');
    check('sin regla, el global', d('consolidar:ana') === 'deepseek' && d('texto') === 'deepseek' && d('audit') === 'deepseek');
    check('un null en la general corta el global (cast: null)', d('cast:lector') === null && d('cast') === null);
    check('origen: rol, hereda, global, ninguno', respaldo.resolverRespaldo(c, 'alma:ana').origen === 'rol'
      && respaldo.resolverRespaldo(c, 'alma:bea').origen === 'hereda' && respaldo.resolverRespaldo(c, 'alma:bea').desde === 'alma'
      && respaldo.resolverRespaldo(c, 'texto').origen === 'global' && respaldo.resolverRespaldo(c, 'cast:lector').origen === 'ninguno');
    check('sin rol: el global', d(null) === 'deepseek');
    // Regresión: sin la clave nueva, cada rol da lo mismo que 2.12.0 (el global).
    const sin = { fallbackAgy: 'opencode-go' };
    const todos = [...Object.keys(ROLES_INTENCION), 'alma', 'alma:ana', 'consolidar', 'consolidar:ana', 'cast', 'cast:lector'];
    check('sin fallback_agy_roles: todos resuelven al global', todos.every((r) => respaldo.destinoDeFallback(sin, r).motor === 'opencode-go'));
  });

  await group('un solo mapeo de rol a camino', () => {
    const casos = { texto: 'textos', audit: 'lectura', review: 'lectura', plan: 'lectura', alma: 'alma', 'alma:ana': 'alma',
      consolidar: 'consolidar', 'consolidar:ana': 'consolidar', cast: 'cast', 'cast:lector': 'cast', research: null, run: null, imagen: null, voz: null };
    const malos = Object.entries(casos).filter(([r, c]) => roles.caminoDeRespaldo(r) !== c);
    check('caminoDeRespaldo', malos.length === 0, JSON.stringify(malos));
    check('cada camino está en CAMINOS', Object.keys(roles.DESTINOS_POR_CAMINO).every((c) => respaldo.CAMINOS[c]));
  });

  await group('cada camino cae al destino del rol, no al global', async () => {
    const C = (mapa, global = null) => ({ fallbackAgy: global, fallbackAgyRoles: mapa, motores: { cuentas: CUENTAS } });
    check('textos: texto → opencode-go (global deepseek)', await caeA('textos', C({ texto: 'opencode-go' }, 'deepseek'), { rol: 'texto' }) === 'opencode-go');
    check('lectura: audit → opencode-go (global deepseek)', await caeA('lectura', C({ audit: 'opencode-go' }, 'deepseek'), { rol: 'audit' }) === 'opencode-go');
    check('alma: alma:ana → deepseek (global opencode-go)', await caeA('alma', C({ 'alma:ana': 'deepseek' }, 'opencode-go'), { rol: 'alma:ana' }) === 'deepseek');
    check('consolidar: consolidar:ana → claude (global deepseek)', await caeA('consolidar', C({ 'consolidar:ana': 'claude@trabajo' }, 'deepseek'), { rol: 'consolidar:ana' }) === 'claude');
    check('cast: cast:lector → claude por la general (sin global)', await caeA('cast', C({ cast: 'claude@trabajo' }), { rol: 'cast:lector' }) === 'claude');
    check('alma: null propio no cae aunque haya global', await caeA('alma', C({ 'alma:ana': null }, 'deepseek'), { rol: 'alma:ana' }) === 'agy');
  });

  await group('DESTINOS_POR_CAMINO coincide con el runtime', async () => {
    const destinoDe = { claude: 'claude@trabajo', deepseek: 'deepseek', 'opencode-go': 'opencode-go' };
    const rolDe = { textos: 'texto', lectura: 'audit', alma: 'alma:ana', consolidar: 'consolidar:ana', cast: 'cast:lector' };
    const malos = [];
    for (const [camino, rol] of Object.entries(rolDe)) {
      for (const motor of ['claude', 'deepseek', 'opencode-go']) {
        const config = { fallbackAgy: null, fallbackAgyRoles: { [rol]: destinoDe[motor] }, motores: { cuentas: CUENTAS } };
        const via = await caeA(camino, config, { rol });
        const cae = via === motor;
        if (cae !== roles.DESTINOS_POR_CAMINO[camino].includes(motor)) malos.push(`${camino}:${motor}→${via}`);
      }
    }
    check('cae si y solo si el motor está en la tabla', malos.length === 0, malos.join(' | '));
  });

  await group('las reglas que no cambian', async () => {
    const C = { fallbackAgy: null, fallbackAgyRoles: { 'alma:ana': 'deepseek', audit: 'deepseek', 'cast:lector': 'claude@trabajo' }, motores: { cuentas: CUENTAS } };
    const fija = { ...enAgy(), fijo: true };
    check('un rol fijo con respaldo no cae', await caeA('alma', C, { rol: 'alma:ana', eleccion: fija }) === 'agy');
    check('la lectura con hilo retomado no cae', await caeA('lectura', C, { rol: 'audit', conversationId: 'h1' }) === 'agy');
    check('un cast que no es de lectura no cae', await caeA('cast', C, { rol: 'cast:lector', permitido: false }) === 'agy');
  });

  await group('validación estricta', () => {
    const v = (rol, valor) => forma.validarRespaldoRol(rol, valor, ['trabajo', 'principal']).ok;
    check('audit con claude@: no', !v('audit', 'claude@trabajo'));
    check('audit con deepseek y opencode-go: sí', v('audit', 'deepseek') && v('audit', 'opencode-go'));
    check('cast con deepseek: no; con claude@: sí', !v('cast:lector', 'deepseek') && v('cast', 'claude@trabajo'));
    check('research, run, imagen y voz: no', ['research', 'run', 'imagen', 'voz'].every((r) => !v(r, 'deepseek') && !v(r, null)));
    check('una cuenta que no existe: no', !forma.validarRespaldoRol('texto', 'claude@fantasma', ['trabajo']).ok);
    check('principal: no, aunque esté declarada', !v('texto', 'claude@principal'));
    check('null vale en un rol con camino', v('alma:ana', null) && v('texto', null));
    check('codex (retirado) no', !v('texto', 'codex'));
    check('rol desconocido no', !v('nadie', 'deepseek'));
  });

  await group('carga tolerante', () => {
    const home = homeNuevo({
      fallback_agy: 'deepseek',
      motores: { cuentas: { trabajo: { configDir: '~/.claude-trabajo' } } },
      fallback_agy_roles: { audit: 'claude@trabajo', texto: 'opencode-go', cast: 'deepseek', 'alma:ana': 'claude@trabajo', run: 'deepseek' }
    });
    const proyecto = fs.mkdtempSync(path.join(os.tmpdir(), 'feat205-proy-'));
    fs.mkdirSync(path.join(proyecto, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proyecto, '.claude', 'antigravity.json'), JSON.stringify({ fallback_agy_roles: { texto: 'deepseek' } }));
    const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    const errWrite = process.stderr.write;
    process.stderr.write = () => true;
    let c;
    try { c = loadConfig(proyecto); } finally {
      process.stderr.write = errWrite;
      process.env.HOME = antes.HOME; process.env.USERPROFILE = antes.USERPROFILE;
    }
    check('se queda con las buenas', JSON.stringify(c.fallbackAgyRoles) === JSON.stringify({ texto: 'opencode-go', 'alma:ana': 'claude@trabajo' }), JSON.stringify(c.fallbackAgyRoles));
    check('un aviso por cada ignorada (audit, cast, run)', c.avisos.filter((a) => /fallback_agy_roles/.test(a) && /ignora esa entrada/.test(a)).length === 3, JSON.stringify(c.avisos));
    check('la del proyecto se ignora con un aviso', c.fallbackAgyRoles.texto === 'opencode-go' && c.avisos.some((a) => /fallback_agy_roles solo se lee de la configuración global/.test(a)));
    const vacia = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'feat205-v-')));
    check('sin la clave: {}', vacia.fallbackAgyRoles && Object.keys(vacia.fallbackAgyRoles).length === 0);
  });

  await group('la vista: destino, origen, aplica, nota y admite', () => {
    const config = {
      fallbackAgy: 'claude@trabajo',
      fallbackAgyRoles: { audit: 'opencode-go', alma: 'deepseek' },
      motores: {
        cuentas: { trabajo: { configDir: '/x' }, principal: { configDir: '/y' } },
        roles: { texto: { motor: 'antigravity' }, 'alma:bea': { motor: 'opencode-go', modelo: 'deepseek-v4.1-flash' }, review: { motor: 'deepseek', modelo: 'deepseek-flash' } }
      }
    };
    const v = (rol) => respaldo.respaldoParaVista(config, rol, motoresMod.elegir(config, rol));
    check('audit: propio, aplica, nota hilo-retomado, admite sin claude', v('audit').destino === 'opencode-go' && v('audit').origen === 'rol'
      && v('audit').aplica && v('audit').nota === 'hilo-retomado' && JSON.stringify(v('audit').admite) === '["deepseek","opencode-go"]', JSON.stringify(v('audit')));
    check('plan: el global claude@ no rige en la lectura (destino null)', v('plan').destino === null && v('plan').origen === 'global');
    check('alma:ana: hereda de alma', v('alma:ana').destino === 'deepseek' && v('alma:ana').origen === 'hereda' && v('alma:ana').desde === 'alma');
    check('admite: claude@trabajo, sin principal', v('alma:ana').admite.includes('claude@trabajo') && !v('alma:ana').admite.includes('claude@principal'));
    check('texto fijo en agy: fijo-en-agy, no aplica', v('texto').nota === 'fijo-en-agy' && v('texto').aplica === false);
    check('alma:bea fija en Go: go-reintenta-agy', v('alma:bea').nota === 'go-reintenta-agy' && v('alma:bea').aplica === false);
    check('review fijo en deepseek: fijo', v('review').nota === 'fijo' && v('review').aplica === false);
    check('cast:lector: cast-solo-lectura, global claude@trabajo', v('cast:lector').nota === 'cast-solo-lectura' && v('cast:lector').destino === 'claude@trabajo');
    check('research: sin respaldo', v('research').aplica === false && v('research').admite.length === 0 && v('research').nota === null);
    const principal = { fallbackAgy: 'claude@principal', motores: { cuentas: { principal: { configDir: '/y' } } } };
    check('global claude@principal heredado: destino null', respaldo.respaldoParaVista(principal, 'texto', motoresMod.elegir(principal, 'texto')).destino === null);
    const fantasma = { fallbackAgy: 'claude@fantasma', motores: { cuentas: {} } };
    check('global con una cuenta que no existe: destino null', respaldo.respaldoParaVista(fantasma, 'texto', motoresMod.elegir(fantasma, 'texto')).destino === null);
  });

  await group('mensajes de cuota', async () => {
    const pl = { grupo: 'gemini', hasta: T0 + 3600_000, modelo: MODELO };
    check('sin regla: el consejo de siempre', /configurá fallback_agy/.test(respaldo.textoDeCuotaPrevia(pl)));
    check('con regla: Roles', /respaldo de este rol en Roles/.test(respaldo.textoDeCuotaPrevia({ ...pl, porRol: true })));
    const conNull = { fallbackAgy: 'deepseek', fallbackAgyRoles: { audit: null } };
    const r = await respaldo.conRespaldo('lectura', { config: conNull, rol: 'audit', intentarAgy: async () => ({}), intentarSuplente: async () => ({}), estado: agotado(), modelo: MODELO, log: silencio });
    check('audit con null propio: el rechazo aconseja Roles', r.preflight && /en Roles/.test(r.res.error), r.res && r.res.error);
    const hilo = await respaldo.conRespaldo('lectura', { config: { fallbackAgy: null }, rol: 'audit', intentarAgy: async () => ({}), intentarSuplente: async () => ({}), estado: agotado(), modelo: MODELO, conversationId: 'h', log: silencio });
    check('hilo retomado sin regla: el de siempre', /para hilos nuevos/.test(hilo.res.error));
    check('tieneReglaDeRespaldo: propia, heredada y ninguna', respaldo.tieneReglaDeRespaldo({ fallbackAgyRoles: { cast: null } }, 'cast:x')
      && respaldo.tieneReglaDeRespaldo({ fallbackAgyRoles: { texto: 'deepseek' } }, 'texto') && !respaldo.tieneReglaDeRespaldo({ fallbackAgyRoles: {} }, 'texto'));
  });

  await group('proyección v2 sin secretos', () => {
    const vista = { roles: [{ rol: 'audit', motor: 'antigravity', origen: 'defecto', respaldo: { destino: 'opencode-go', origen: 'rol', desde: null, aplica: true, nota: 'hilo-retomado', admite: ['deepseek', 'opencode-go', 'claude@principal', '/home/x/.claude-work', 'deepseek'] } }],
      sujetos: [{ rol: 'alma:ana', respaldo: { destino: 'C:\\Users\\x', origen: 'raro', desde: '<b>', aplica: 'si', nota: 'otra', admite: 'no' } }] };
    const p = motoresV2(vista);
    const r = p.roles[0].respaldo;
    check('rol: campo por campo, sin duplicados ni rutas', r.destino === 'opencode-go' && r.nota === 'hilo-retomado' && JSON.stringify(r.admite) === '["deepseek","opencode-go"]', JSON.stringify(r));
    const s = p.sujetos[0].respaldo;
    check('sujeto: lo raro cae a valores seguros', s.destino === null && s.origen === 'ninguno' && s.desde === null && s.aplica === false && s.nota === null && s.admite.length === 0, JSON.stringify(s));
    check('sin respaldo (plugin viejo): null', motoresV2({ roles: [{ rol: 'audit' }] }).roles[0].respaldo === null);
  });

  await group('POST /api/v2/motores/rol con respaldo', async () => {
    const home = homeNuevo({ fallback_agy: 'deepseek', motores: { cuentas: { trabajo: { configDir: '~/.claude-trabajo' } } } });
    const config = { fallbackAgy: 'deepseek', motores: { cuentas: CUENTAS } };
    const { llamar } = await rutasCon(config, home);
    const solo = await llamar('POST', '/api/v2/motores/rol', { rol: 'audit', respaldo: 'opencode-go' });
    check('solo respaldo: se guarda sin tocar el rol', solo && solo.ok !== false && leer(home).fallback_agy_roles.audit === 'opencode-go' && !(leer(home).motores.roles || {}).audit, JSON.stringify(solo).slice(0, 200));
    const nulo = await llamar('POST', '/api/v2/motores/rol', { rol: 'cast', respaldo: null });
    check('null: «sin respaldo» en el archivo', nulo.ok !== false && leer(home).fallback_agy_roles.cast === null);
    await llamar('POST', '/api/v2/motores/rol', { rol: 'cast', respaldo: 'heredar' });
    check('heredar: borra la clave', !Object.prototype.hasOwnProperty.call(leer(home).fallback_agy_roles, 'cast'));
    const juntos = await llamar('POST', '/api/v2/motores/rol', { rol: 'alma', motor: 'deepseek', modelo: 'deepseek-flash', respaldo: 'claude@trabajo' });
    check('motor y respaldo juntos (y alma general desde la v2)', juntos.ok !== false && leer(home).motores.roles.alma.motor === 'deepseek' && leer(home).fallback_agy_roles.alma === 'claude@trabajo', JSON.stringify(juntos).slice(0, 200));
    const quitar = await llamar('POST', '/api/v2/motores/rol', { rol: 'alma', quitar: true, respaldo: 'opencode-go' });
    check('quitar con respaldo: el rol vuelve a agy con su respaldo', quitar.ok !== false && !leer(home).motores.roles.alma && leer(home).fallback_agy_roles.alma === 'opencode-go');
    const antes = fs.readFileSync(archivo(home), 'utf8');
    const malo = await llamar('POST', '/api/v2/motores/rol', { rol: 'audit', motor: 'opencode-go', modelo: 'glm-5.3', respaldo: 'claude@trabajo' });
    check('motor válido y respaldo inválido: 400 con campo, sin escribir', malo.codigo === 400 && malo.campo === 'respaldo' && fs.readFileSync(archivo(home), 'utf8') === antes, JSON.stringify(malo));
    const malMotor = await llamar('POST', '/api/v2/motores/rol', { rol: 'audit', motor: 'opencode-go', modelo: 'glm-5.3', esfuerzo: 'high', respaldo: 'deepseek' });
    check('F7 — un esfuerzo fuera por la ruta real: 400 con campo motor, sin escribir', malMotor.codigo === 400 && malMotor.campo === 'motor' && fs.readFileSync(archivo(home), 'utf8') === antes, JSON.stringify(malMotor));
    const vacio = await llamar('POST', '/api/v2/motores/rol', { rol: 'audit' });
    check('un cuerpo sin nada: 400', vacio.codigo === 400);
    const cast = await llamar('POST', '/api/v2/motores/rol', { rol: 'cast', motor: 'claude', modelo: 'sonnet' });
    check('cast general desde la v2', cast.ok !== false && leer(home).motores.roles.cast.motor === 'claude', JSON.stringify(cast).slice(0, 200));
    const { nucleo } = await rutasCon(config, home);
    const v1 = await nucleo.guardarMotor({ rol: 'alma', motor: 'deepseek', modelo: 'deepseek-flash' });
    check('la consola vieja sigue sin editar alma general (404)', v1.codigo === 404);
    const v1r = await nucleo.guardarMotor({ rol: 'alma:ana', respaldo: 'deepseek' });
    check('la consola vieja no guarda respaldo', v1r.codigo === 400 && !Object.prototype.hasOwnProperty.call(leer(home).fallback_agy_roles, 'alma:ana'));
    removeFixture(home);
  });

  await group('GET /api/v2/motores: generales y respaldo', async () => {
    const config = { fallbackAgy: 'opencode-go', fallbackAgyRoles: { cast: null }, motores: { cuentas: CUENTAS, roles: {} } };
    const home = homeNuevo({});
    const { llamar } = await rutasCon(config, home);
    const v = await llamar('GET', '/api/v2/motores');
    const fila = (rol) => v.roles.find((r) => r.rol === rol);
    check('alma y cast en roles, con admiten', fila('alma') && fila('cast') && fila('consolidar') && Array.isArray(fila('alma').admiten) && fila('cast').admiten.length > 0);
    check('cast general: ninguno', fila('cast').respaldo.origen === 'ninguno' && fila('cast').respaldo.destino === null);
    const s = v.sujetos.find((x) => x.rol === 'cast:lector');
    check('el sujeto cast:lector hereda el null', s && s.respaldo && s.respaldo.origen === 'ninguno', JSON.stringify(s && s.respaldo));
    const texto = JSON.stringify(v);
    check('sin configDir ni rutas', !/configDir|\/tmp\/trabajo/.test(texto));
    check('respaldo global igual que antes', v.respaldo.destino === 'opencode-go');
    removeFixture(home);
  });

  await group('Ajustes: el mapa cambia la versión y Ajustes no lo toca', () => {
    const home = homeNuevo({ fallback_agy: 'deepseek', motores: { cuentas: { trabajo: { configDir: '~/.claude-trabajo' } } } });
    const v0 = ajustes.leerAjustes({ homeDir: home });
    const sinMapa = JSON.stringify(v0.versiones.motores);
    const g = configMotores.guardarRol('audit', undefined, { homeDir: home, respaldo: 'opencode-go' });
    check('guardarRol solo con respaldo', g.ok, JSON.stringify(g));
    const v1 = ajustes.leerAjustes({ homeDir: home });
    check('la versión de motores cambió', JSON.stringify(v1.versiones.motores) !== sinMapa);
    const conflicto = ajustes.guardarAjustes({ motores: { versionSeccion: v0.versiones.motores, fallback_agy: 'opencode-go' } }, { homeDir: home });
    check('Ajustes con la versión vieja: 409', conflicto.codigo === 409, JSON.stringify(conflicto).slice(0, 200));
    const ok = ajustes.guardarAjustes({ motores: { versionSeccion: v1.versiones.motores, fallback_agy: 'opencode-go' } }, { homeDir: home });
    check('con la nueva guarda y conserva el mapa', ok.ok !== false && leer(home).fallback_agy === 'opencode-go' && leer(home).fallback_agy_roles.audit === 'opencode-go', JSON.stringify(ok).slice(0, 200));
    const sin = homeNuevo({ fallback_agy: 'deepseek' });
    const a = ajustes.leerAjustes({ homeDir: sin }).versiones.motores;
    const b = ajustes.leerAjustes({ homeDir: homeNuevo({ fallback_agy: 'deepseek' }) }).versiones.motores;
    check('sin la clave, la versión es la de siempre (estable)', JSON.stringify(a) === JSON.stringify(b));
    removeFixture(home); removeFixture(sin);
  });

  await group('set_config: fallback_agy_roles', async () => {
    const home = homeNuevo({ fallback_agy: 'deepseek' });
    const server = startServer({ cwd: home, env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: null } });
    const texto = (r) => r.result?.content?.[0]?.text || '';
    try {
      await server.initialize();
      const alta = await server.callTool('set_config', { motores: { cuentas: { trabajo: { configDir: '~/.claude-trabajo' } } }, fallback_agy_roles: { 'alma:ana': 'claude@trabajo', audit: 'opencode-go' } });
      check('alta de una cuenta y su uso en la misma llamada', !alta.result?.isError && leer(home).fallback_agy_roles['alma:ana'] === 'claude@trabajo', texto(alta));
      const malo = await server.callTool('set_config', { fallback_agy_roles: { audit: 'claude@trabajo' } });
      check('audit con claude@: error, archivo intacto', malo.result?.isError && leer(home).fallback_agy_roles.audit === 'opencode-go', texto(malo));
      const fantasma = await server.callTool('set_config', { fallback_agy_roles: { texto: 'claude@fantasma' } });
      check('cuenta que no existe: error', fantasma.result?.isError, texto(fantasma));
      const borrar = await server.callTool('set_config', { motores: { cuentas: {} } });
      check('borrar una cuenta que el mapa usa: error con el rol', borrar.result?.isError && /alma:ana/.test(texto(borrar)) && leer(home).motores.cuentas.trabajo, texto(borrar));
      const proy = await server.callTool('set_config', { scope: 'project', fallback_agy_roles: { texto: 'deepseek' } });
      check('scope project: error', proy.result?.isError, texto(proy));
      const nulo = await server.callTool('set_config', { fallback_agy_roles: null });
      check('null: borra el mapa', !nulo.result?.isError && leer(home).fallback_agy_roles === undefined, texto(nulo));
    } finally {
      await server.stop();
      removeFixture(home);
    }
  });

  report();
}

main().catch((e) => { console.error(e); process.exit(1); });
