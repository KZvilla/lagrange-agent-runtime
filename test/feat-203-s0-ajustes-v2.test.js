/**
 * FEAT-203 S0 — Ajustes en la API v2 y lo que la terminal necesita para editar roles:
 *
 *   - `admiten` (qué motor, modelo y esfuerzo acepta cada rol) sale del mismo validador que escribe;
 *   - `GET /api/v2/motores` trae la tabla de Roles (intenciones + `consolidar`, sin reglas de sujeto), `admiten` en
 *     cada rol y cada sujeto, y `respaldo.destino`;
 *   - `consolidar` se guarda desde la v2;
 *   - `GET/POST /api/v2/ajustes` con lista blanca: nunca una ruta, un `configDir`, el entorno ni los avisos;
 *   - el freno se escribe como `freno_cuota` y el alias de antes solo vale donde el motor lo acepta.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);

const { admitenDe } = require(path.join(MCP, 'motores', 'admiten.js'));
const { validarRoles } = require(path.join(MCP, 'motores', 'roles.js'));
const { ROLES_INTENCION } = require(path.join(MCP, 'motores', 'capacidades.js'));
const motoresMod = require(path.join(MCP, 'motores', 'index.js'));
const niveles = require(path.join(MCP, 'motores', 'niveles.js'));
const ajustes = require(path.join(MCP, 'lib', 'ajustes.js'));

function homeNuevo(contenido) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat203-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (contenido !== undefined) fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2));
  return home;
}
const archivo = (home) => path.join(home, '.claude', 'antigravity.json');
const leer = (home) => JSON.parse(fs.readFileSync(archivo(home), 'utf8'));

// Lo que nunca sale por la v2.
// FEAT-204 — `identidades`, `voz` y `avisos` (de esas dos) ya salen, por su lista blanca; el CSS de los colores, no.
const VENENO = ['configDir', '.claude-work', 'antigravity.json', 'entorno', 'pisadoPorProyecto', 'rolesEditables', 'OPENCODE_GO_API_KEY', '#58a6ff', '"css"'];

function motoresFalsos(config, guardados = []) {
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
    sondasClaude: () => ({ corriendo: () => false, huellaActual: () => 'h', leerSondas: async () => ({ ok: true }), dispararSiHaceFalta: () => {} }),
    guardarRol: (rol, entrada) => { guardados.push({ rol, entrada }); return { ok: true, roles: { [rol]: entrada } }; }
  };
}

async function nucleoCon({ config, home, guardados }) {
  const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
  const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js').catch(() => ({ crearCanalWeb: () => ({}) }));
  return crearNucleoWeb({
    canal: crearCanalWeb(),
    bot: { almasDisponibles: () => [{ clave: 'ana', voz: 'Ana' }], agentesCasteables: () => [{ nombre: 'lector' }] },
    almas: {}, workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({}),
    motores: motoresFalsos(config, guardados),
    ajustes: {
      leer: () => ajustes.leerAjustes({ homeDir: home }),
      guardar: (cuerpo, opciones) => ajustes.guardarAjustes(cuerpo, { ...opciones, homeDir: home }),
      pisadoPorProyecto: () => [{ ruta: '/proyecto/antigravity.json', claves: ['model'] }],
      entorno: () => ({ AGY_MODEL: 'x' })
    }
  });
}

async function rutas(nucleo) {
  const lect = await importar('telegram-bridge/web/v2/lecturas.js');
  const mut = await importar('telegram-bridge/web/v2/mutaciones.js');
  const tareasMod = await importar('telegram-bridge/tareas.js');
  const lecturas = lect.rutasLecturaV2({ nucleo, estadoDeCarriles: () => [], recorte: tareasMod.RECORTE, arranque: 'arr' });
  const mutaciones = mut.rutasMutacionV2({ nucleo, cola: {}, ctx: { chat: { id: 'web:terminal' } }, chatTerminal: 'web:terminal', registro: { obtener: () => null }, idem: null, almacen: { publicar: () => {} }, recorte: tareasMod.RECORTE });
  return async (metodo, ruta, cuerpo = {}) => {
    const r = [...lecturas, ...mutaciones].find((x) => x.metodo === metodo && x.patron.test(ruta));
    return r.fn({ p: [], cuerpo, url: new URL(`http://x${ruta}`) });
  };
}

async function main() {
  await group('admiten: el mismo validador que escribe', () => {
    const vacios = ['research', 'imagen', 'voz'].filter((r) => admitenDe(r).length === 0);
    check('research, imagen y voz: vacío', vacios.length === 3, vacios.join(','));
    const go = (rol) => (admitenDe(rol).find((m) => m.motor === 'opencode-go') || { modelos: [] }).modelos.map((x) => x.id).sort();
    for (const rol of ['audit', 'review', 'plan']) {
      check(`${rol}: los tres modelos de Go`, JSON.stringify(go(rol)) === JSON.stringify(Object.keys(niveles.MODELOS_GO).sort()), JSON.stringify(go(rol)));
    }
    const run = admitenDe('run');
    check('run: solo opencode-go + hy4-flash-free', run.length === 1 && run[0].motor === 'opencode-go' && run[0].modelos.length === 1 && run[0].modelos[0].id === 'hy4-flash-free', JSON.stringify(run));
    const todos = Object.keys(ROLES_INTENCION).concat(['consolidar', 'alma:ana', 'consolidar:ana', 'cast:lector']);
    const conAgy = todos.filter((r) => admitenDe(r).some((m) => m.motor === 'antigravity'));
    check('agy no entra en ningún rol', conAgy.length === 0, conAgy.join(','));
    const ds = admitenDe('audit').find((m) => m.motor === 'deepseek');
    check('deepseek solo con deepseek-flash', ds && ds.modelos.length === 1 && ds.modelos[0].id === niveles.MODELO_DEEPSEEK);
    const fable = todos.flatMap((r) => admitenDe(r)).filter((m) => m.motor === 'claude').flatMap((m) => m.modelos).filter((x) => /fable/i.test(x.id));
    check('claude sin ningún modelo fable', fable.length === 0);
    let malos = [];
    for (const rol of todos) {
      for (const m of admitenDe(rol)) {
        for (const x of m.modelos) {
          if (!x.id) malos.push(`${rol}:${m.motor}:null`);
          if (!validarRoles({ [rol]: { motor: m.motor, modelo: x.id, esfuerzo: null } }, { estricto: true }).ok) malos.push(`${rol}:${m.motor}:${x.id}`);
          for (const e of x.esfuerzos) {
            if (!validarRoles({ [rol]: { motor: m.motor, modelo: x.id, esfuerzo: e } }, { estricto: true }).ok) malos.push(`${rol}:${m.motor}:${x.id}:${e}`);
          }
        }
      }
    }
    check('cada par y cada esfuerzo pasa validarRoles estricto', malos.length === 0, malos.slice(0, 5).join(' | '));
    // FEAT-205 (F7 de la auditoría de FEAT-203) — La misma propiedad con `cuentas`, como la llama el núcleo.
    const cuentas = ['trabajo'];
    const malosConCuentas = [];
    for (const rol of todos) {
      for (const m of admitenDe(rol, { cuentas })) {
        for (const x of m.modelos) {
          if (!validarRoles({ [rol]: { motor: m.motor, modelo: x.id, esfuerzo: null } }, { estricto: true, cuentas }).ok) malosConCuentas.push(`${rol}:${m.motor}:${x.id}`);
          for (const e of x.esfuerzos) {
            if (!validarRoles({ [rol]: { motor: m.motor, modelo: x.id, esfuerzo: e } }, { estricto: true, cuentas }).ok) malosConCuentas.push(`${rol}:${m.motor}:${x.id}:${e}`);
          }
        }
      }
    }
    check('con cuentas: cada par y cada esfuerzo pasa validarRoles estricto', malosConCuentas.length === 0, malosConCuentas.slice(0, 5).join(' | '));
    const glm = admitenDe('audit').find((m) => m.motor === 'opencode-go').modelos.find((x) => x.id === 'glm-5.3');
    check('un esfuerzo fuera de `esfuerzos` no valida', glm.esfuerzos.length === 0 && !validarRoles({ audit: { motor: 'opencode-go', modelo: 'glm-5.3', esfuerzo: 'high' } }, { estricto: true }).ok);
    const cast = admitenDe('cast:lector');
    check('un cast: solo claude (los motores sin casts no entran)', cast.length === 1 && cast[0].motor === 'claude', JSON.stringify(cast.map((m) => m.motor)));
  });

  await group('GET /api/v2/motores: roles, admiten y respaldo', async () => {
    const config = {
      fallbackAgy: 'claude@trabajo',
      motores: {
        cuentas: { trabajo: { configDir: '/home/x/.claude-work' } },
        roles: {
          audit: { motor: 'opencode-go', modelo: 'hy4-flash-free', esfuerzo: null },
          'alma:ana': { motor: 'deepseek', modelo: 'deepseek-flash', esfuerzo: null },
          'cast:lector': { motor: 'claude', modelo: 'sonnet', esfuerzo: null }
        }
      }
    };
    const nucleo = await nucleoCon({ config, home: homeNuevo({}), guardados: [] });
    const llamar = await rutas(nucleo);
    const v = await llamar('GET', '/api/v2/motores');
    const nombres = v.roles.map((r) => r.rol);
    check('roles: las intenciones y consolidar', Object.keys(ROLES_INTENCION).every((r) => nombres.includes(r)) && nombres.includes('consolidar'), nombres.join(','));
    check('sin reglas de sujeto ni duplicados', !nombres.some((r) => r.includes(':')) && new Set(nombres).size === nombres.length);
    const cons = v.roles.find((r) => r.rol === 'consolidar');
    check('consolidar aparece con el archivo sin regla, de defecto', cons && cons.origen === 'defecto');
    check('audit sale de config con su admiten', v.roles.find((r) => r.rol === 'audit').origen === 'config' && Array.isArray(v.roles.find((r) => r.rol === 'audit').admiten));
    check('research: admiten vacío', JSON.stringify(v.roles.find((r) => r.rol === 'research').admiten) === '[]');
    const sujetos = Object.fromEntries(v.sujetos.map((s) => [s.rol, s]));
    check('cada sujeto trae admiten', ['alma:ana', 'consolidar:ana', 'cast:lector'].every((r) => sujetos[r] && Array.isArray(sujetos[r].admiten)), Object.keys(sujetos).join(','));
    check('el cast solo admite claude', sujetos['cast:lector'].admiten.every((m) => m.motor === 'claude'));
    check('respaldo.destino: claude@trabajo', v.respaldo && v.respaldo.destino === 'claude@trabajo', JSON.stringify(v.respaldo));
    const json = JSON.stringify(v);
    check('sin configDir ni avisos', !/configDir|\.claude-work|avisos/.test(json));

    const fantasma = await (await rutas(await nucleoCon({ config: { ...config, fallbackAgy: 'claude@fantasma' }, home: homeNuevo({}), guardados: [] })))('GET', '/api/v2/motores');
    check('claude@fantasma: destino null', fantasma.respaldo.destino === null);
    const principal = await (await rutas(await nucleoCon({ config: { ...config, fallbackAgy: 'claude@principal' }, home: homeNuevo({}), guardados: [] })))('GET', '/api/v2/motores');
    check('claude@principal: destino null', principal.respaldo.destino === null);
    const go = await (await rutas(await nucleoCon({ config: { ...config, fallbackAgy: 'opencode-go' }, home: homeNuevo({}), guardados: [] })))('GET', '/api/v2/motores');
    check('opencode-go: destino opencode-go', go.respaldo.destino === 'opencode-go');
  });

  await group('POST /api/v2/motores/rol: consolidar', async () => {
    const guardados = [];
    const llamar = await rutas(await nucleoCon({ config: { motores: {} }, home: homeNuevo({}), guardados }));
    const r = await llamar('POST', '/api/v2/motores/rol', { rol: 'consolidar', motor: 'deepseek', modelo: 'deepseek-flash' });
    check('guardar consolidar: sin 404', r && r.ok !== false && guardados.length === 1 && guardados[0].rol === 'consolidar', JSON.stringify(r).slice(0, 200));
    const q = await llamar('POST', '/api/v2/motores/rol', { rol: 'consolidar', quitar: true });
    check('quitar consolidar: sin 404', q && q.ok !== false && guardados[1].entrada === null);
    const alma = await llamar('POST', '/api/v2/motores/rol', { rol: 'alma', motor: 'deepseek', modelo: 'deepseek-flash' });
    // FEAT-205 — La regla general de las almas tiene su fila en Roles: desde la API v2 ya se guarda.
    check('alma genérica: se guarda desde la v2 (FEAT-205)', alma && alma.ok !== false && guardados[2].rol === 'alma', JSON.stringify(alma).slice(0, 200));
  });

  await group('GET /api/v2/ajustes: lista blanca', async () => {
    const home = homeNuevo({
      fallback_agy: 'claude@trabajo',
      model: 'gemini-3.8-flash', readonly_isolation: 'host',
      identidad_sesion: { principal: { nombre: 'Spica' } },
      motores: {
        cuentas: { trabajo: { configDir: '~/.claude-work' } },
        roles: { audit: { motor: 'opencode-go', modelo: 'hy4-flash-free', esfuerzo: null } },
        claude: { freno_cuota_5h: 0.7 },
        antigravity: { freno_cuota: 2 },
        'opencode-go': { freno_cuota_5h: 0.8 }
      }
    });
    const llamar = await rutas(await nucleoCon({ config: { motores: {} }, home, guardados: [] }));
    const v = await llamar('GET', '/api/v2/ajustes');
    check('ok, con las cuatro versiones (FEAT-204)', v.ok === true && ['motores', 'general', 'identidades', 'voz'].every((k) => typeof v.versiones[k] === 'string') && Object.keys(v.versiones).length === 4);
    check('solo las claves de la forma', JSON.stringify(Object.keys(v).sort()) === JSON.stringify(['avisos', 'colores', 'frenables', 'general', 'identidades', 'limites', 'motores', 'ok', 'proyectoFija', 'versiones', 'voz']), Object.keys(v).join(','));
    const json = JSON.stringify(v);
    const suelta = VENENO.filter((x) => json.includes(x));
    check('sin ruta, configDir, entorno ni roles', suelta.length === 0 && !/roles|hy4/.test(json), suelta.join(','));
    check('cuentasFallback sin principal', JSON.stringify(v.motores.cuentasFallback) === '["trabajo"]');
    check('fallback_agy válido', v.motores.fallback_agy === 'claude@trabajo');
    check('frenables: los tres con ventanas', JSON.stringify(v.frenables.map((f) => f.motor).sort()) === JSON.stringify(['antigravity', 'claude', 'opencode-go']));
    check('claude: el alias vale', v.general.frenos.claude === 0.7);
    check('antigravity con freno 2: null', v.general.frenos.antigravity === null);
    check('opencode-go con el alias: null (no lo acepta)', v.general.frenos['opencode-go'] === null);
    check('general sin campos de más', v.general.model === 'gemini-3.8-flash' && v.general.readonly_isolation === 'host' && !('avisos' in v.general));
    check('limites: los cinco', JSON.stringify(Object.keys(v.limites).sort()) === JSON.stringify(['aislamientos', 'avisosFondo', 'esfuerzos', 'modosOrquestacion', 'timeoutMax']));

    const fantasma = await (await rutas(await nucleoCon({ config: { motores: {} }, home: homeNuevo({ fallback_agy: 'claude@fantasma' }), guardados: [] })))('GET', '/api/v2/ajustes');
    check('claude@fantasma: fallback_agy null', fantasma.motores.fallback_agy === null);

    const roto = await (await rutas(await nucleoCon({ config: { motores: {} }, home: homeNuevo('{ esto no es json'), guardados: [] })))('GET', '/api/v2/ajustes');
    check('archivo ilegible: 422 sin la ruta', roto.codigo === 422 && roto.ok === false && !/antigravity\.json.*no se puede|[\\/]\.claude[\\/]/.test(roto.error) && !('ruta' in roto), JSON.stringify(roto));
  });

  await group('POST /api/v2/ajustes', async () => {
    const home = homeNuevo({ motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } }, 'opencode-go': { freno_cuota_5h: 0.8 } } });
    const llamar = await rutas(await nucleoCon({ config: { motores: {} }, home, guardados: [] }));
    const v = await llamar('GET', '/api/v2/ajustes');
    const rechazos = [
      [{ identidades: {} }, 'identidades.cuentas'],
      [{ voz: { versionSeccion: v.versiones.voz, otra: 1 } }, 'voz.otra'],
      [{ motores: { versionSeccion: v.versiones.motores, roles: {} } }, 'motores.roles'],
      [{ general: { versionSeccion: v.versiones.general, frenos: { deepseek: 0.5 } } }, 'general.frenos.deepseek'],
      [{ general: { versionSeccion: v.versiones.general, sesiones_claude: {} } }, 'general.sesiones_claude'],
      [{ general: { versionSeccion: v.versiones.general, frenos: { 'opencode-go': 2 } } }, 'general.frenos.opencode-go'],
      [{ motores: { versionSeccion: v.versiones.motores, fallback_agy: 'claude@principal' } }, 'motores.fallback_agy']
    ];
    for (const [cuerpo, campo] of rechazos) {
      const r = await llamar('POST', '/api/v2/ajustes', cuerpo);
      check(`400 con campo ${campo}`, r.codigo === 400 && r.ok === false && r.campo === campo, JSON.stringify(r));
    }
    const antes = fs.readFileSync(archivo(home), 'utf8');
    check('un rechazo no toca el archivo', fs.readFileSync(archivo(home), 'utf8') === antes);

    const borra = await llamar('POST', '/api/v2/ajustes', { general: { versionSeccion: v.versiones.general, frenos: { 'opencode-go': null } } });
    check('borrar el freno de Go (que no rige) no escribe un freno_cuota fantasma', borra.ok === true && !('freno_cuota' in (leer(home).motores['opencode-go'] || {})), JSON.stringify(leer(home).motores));

    const v2 = await llamar('GET', '/api/v2/ajustes');
    const r = await llamar('POST', '/api/v2/ajustes', { general: { versionSeccion: v2.versiones.general, frenos: { 'opencode-go': 0.6, claude: 0.9 } }, motores: { versionSeccion: v2.versiones.motores, fallback_agy: 'deepseek' } });
    const d = leer(home);
    check('guardado: forma v2 con guardado true', r.ok === true && r.guardado === true && r.general.frenos['opencode-go'] === 0.6 && r.motores.fallback_agy === 'deepseek', JSON.stringify(r).slice(0, 300));
    check('en el archivo, freno_cuota en Go y en claude, sin alias', d.motores['opencode-go'].freno_cuota === 0.6 && !('freno_cuota_5h' in d.motores['opencode-go']) && d.motores.claude.freno_cuota === 0.9 && d.fallback_agy === 'deepseek', JSON.stringify(d));
    const json = JSON.stringify(r);
    check('la respuesta tampoco trae ruta ni configDir', !VENENO.some((x) => json.includes(x)));

    const conflicto = await llamar('POST', '/api/v2/ajustes', { general: { versionSeccion: 'vieja', model: 'x' } });
    check('409: conflictos y estado proyectado', conflicto.codigo === 409 && JSON.stringify(conflicto.conflictos) === '["general"]' && conflicto.estado && conflicto.estado.ok === true && !VENENO.some((x) => JSON.stringify(conflicto).includes(x)), JSON.stringify(conflicto).slice(0, 300));

    const { ajustesRespuestaV2 } = await importar('telegram-bridge/web/v2/ajustes.js');
    const sinEstado = ajustesRespuestaV2({ ok: false, codigo: 409, error: 'cambió', conflictos: ['motores'], estado: null });
    check('409 con estado null', sinEstado.codigo === 409 && sinEstado.estado === null);
    const ocupado = ajustesRespuestaV2({ ok: false, codigo: 503, error: 'lock en /home/x/.claude/antigravity.json' });
    check('503: mensaje propio, sin la ruta', ocupado.codigo === 503 && !/home|antigravity/.test(ocupado.error));
    const otro = await llamar('POST', '/api/v2/ajustes', { otra: 1 });
    check('una sección desconocida: 400 con campo', otro.codigo === 400 && otro.campo === 'otra');
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
