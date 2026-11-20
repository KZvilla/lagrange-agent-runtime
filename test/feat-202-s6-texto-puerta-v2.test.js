/**
 * FEAT-202 S6 — Hilos con dueño (D3), el rol `texto`, la puerta de agy con su lista cerrada (D8) y la API v2 de motores
 * por la proyección con lista blanca (D9).
 *
 *   - D3: la clave `motor@cuenta:id`; una entrada vieja, sin prefijo, se lee como de agy con su modelo, su esfuerzo y su
 *     agente; un hilo de otro motor se rechaza antes de elegir.
 *   - Rol `texto`: con `motores.roles.texto` en otro motor, el texto corre ahí, sin lanzar agy, también en modo manual,
 *     y sin respaldo si falla.
 *   - D8: `despacharAgy` nunca lanza en modo manual, exige herramienta y perfil, y el código no tiene lanzamientos de
 *     agy fuera de la puerta y de `EXCEPCIONES_AGY`.
 *   - D9 / V9: las tres rutas v2 de motores no devuelven un `configDir`, el nombre de una key, un motivo del proveedor
 *     ni los `avisos`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-202-s6-'));
// El modo de agy no sale de la config real de quien corre el test.
const CONFIG_MODO = path.join(TMP, 'antigravity.json');
fs.writeFileSync(CONFIG_MODO, '{}');
process.env.LAGRANGE_AGY_MODO_CONFIG = CONFIG_MODO;
delete process.env.LAGRANGE_AGY_MODO;
const modoManual = (on) => { if (on) process.env.LAGRANGE_AGY_MODO = 'manual'; else delete process.env.LAGRANGE_AGY_MODO; };

const uso = require(path.join(MCP, 'lib', 'uso.js'));
const motores = require(path.join(MCP, 'motores', 'index.js'));
const respaldo = require(path.join(MCP, 'motores', 'respaldo.js'));
const proyeccion = require(path.join(MCP, 'motores', 'proyeccion.js'));
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);

async function main() {
  await group('D3 · la clave del hilo y su dueño', () => {
    check('agy sin cuenta: el id solo', uso.claveHilo('antigravity', 'h1') === 'h1');
    check('claude con cuenta: motor@cuenta:id', uso.claveHilo('claude', 'u1', 'trabajo') === 'claude@trabajo:u1');
    check('deepseek sin cuenta: motor:id', uso.claveHilo('deepseek', 'u2') === 'deepseek:u2');
    const ruta = path.join(TMP, 'uso.json');
    // Una entrada vieja (antes de S6), sin prefijo y sin motor: es de agy.
    fs.writeFileSync(ruta, JSON.stringify({ uso_por_hilo: {
      viejo: { modelo: 'gemini-3.8-flash', esfuerzo: 'high', agente: 'lagrange-reviewer', herramienta: 'plan', total: 10 },
      'claude@trabajo:ajeno': { modelo: 'sonnet', herramienta: 'cast', total: 0 }
    } }));
    const a = uso.crearAlmacenUso({ ruta, stderr: { write: () => {} } });
    const v = a.leerHilo('viejo');
    check('la entrada vieja conserva modelo, esfuerzo y agente', v && v.modelo === 'gemini-3.8-flash' && v.esfuerzo === 'high' && v.agente === 'lagrange-reviewer', JSON.stringify(v));
    check('y se lee como de antigravity', v.motor === 'antigravity' && v.cuenta === null);
    check('con motor antigravity, la misma entrada', a.leerHilo('viejo', { motor: 'antigravity' }).modelo === 'gemini-3.8-flash');
    check('el hilo de claude@trabajo tiene dueño', JSON.stringify(a.duenoDelHilo('ajeno')) === JSON.stringify({ motor: 'claude', cuenta: 'trabajo' }));
    check('pedido como de agy, el de claude no aparece', a.leerHilo('ajeno', { motor: 'antigravity' }) === null);
    check('un hilo sin registro no tiene dueño (se trata como de agy)', a.duenoDelHilo('nadie') === null);
    a.registrarHilo({ conversationId: 'g1', modelo: 'hy4-flash-free', motor: 'opencode-go' });
    check('registrarHilo con motor guarda con prefijo', Boolean(a.leer().uso_por_hilo['opencode-go:g1']) && !a.leer().uso_por_hilo.g1);
    a.registrarHilo({ conversationId: 'viejo', herramienta: 'review' });
    const d = a.leer().uso_por_hilo.viejo;
    check('registrarHilo de agy sobre la entrada vieja: la misma clave, los campos intactos', d.modelo === 'gemini-3.8-flash' && d.agente === 'lagrange-reviewer' && d.total === 10 && d.herramienta === 'review');
  });

  await group('D3 · el dueño se resuelve antes de elegir', () => {
    const conRol = { motores: { roles: { audit: { motor: 'opencode-go', modelo: 'hy4-flash-free' } } } };
    const ajeno = motores.elegirLlamada(conRol, 'audit', { conversation_id: 'u1' }, { dueno: { motor: 'claude', cuenta: 'trabajo' } });
    check('un hilo de claude@trabajo se rechaza', Boolean(ajeno.error) && /claude@trabajo/.test(ajeno.error) && /no cambia de motor/.test(ajeno.error), ajeno.error);
    const conEngine = motores.elegirLlamada(null, 'review', { conversation_id: 'u1', engine: 'agy' }, { dueno: { motor: 'deepseek', cuenta: null } });
    check('engine: "agy" no retoma un hilo de deepseek', Boolean(conEngine.error) && /deepseek/.test(conEngine.error));
    const deAgy = motores.elegirLlamada(conRol, 'audit', { conversation_id: 'h1' }, { dueno: { motor: 'antigravity', cuenta: null } });
    check('un hilo de agy con el rol en Go: el motor sale del hilo', !deAgy.error && deAgy.motor.id === 'antigravity');
    const sinRegistro = motores.elegirLlamada(conRol, 'audit', { conversation_id: 'h2' }, { dueno: null });
    check('un hilo sin registro, como hoy: agy', !sinRegistro.error && sinRegistro.motor.id === 'antigravity');
    const api = motores.elegirLlamada(null, 'audit', { conversation_id: 'h1', engine: 'opencode-go' }, { dueno: null });
    check('un motor de API sigue rechazando conversation_id', Boolean(api.error) && /no retoma hilos/.test(api.error));
  });

  await group('Rol texto: corre en su motor, fijo', async () => {
    const config = { motores: { roles: { texto: { motor: 'opencode-go', modelo: 'hy4-flash-free', esfuerzo: null } } } };
    let agyLanzado = 0;
    const pedidos = [];
    const usos = [];
    const generar = async (o) => { pedidos.push(o); return { ok: true, texto: 'hola desde Go', duracion: 0.4, uso: { input_tokens: 5, output_tokens: 3 } }; };
    const base = { config, intentarAgy: async () => { agyLanzado += 1; return { success: true, data: { response: 'agy' } }; }, prompt: 'reescribí', estado: respaldo.crearEstado({ leerFallback: () => null, guardarFallback: () => {} }), registrarUso: (u) => usos.push(u), tool: 'say', log: () => {}, generar };
    const r = await respaldo.conFallback(base);
    check('responde el motor del rol', r.res.success && r.res.data.response === 'hola desde Go' && r.via === 'opencode-go' && r.motivo === 'rol');
    check('agy no se lanza', agyLanzado === 0);
    check('con el modelo del rol', pedidos[0].modelo === 'hy4-flash-free');
    check('el uso va al motor, con el rol texto', usos.length === 1 && usos[0].motor === 'opencode-go' && usos[0].rol === 'texto' && usos[0].modelo === 'hy4-flash-free');
    check('la nota dice que lo fijó el rol', /motores\.roles\.texto/.test(respaldo.notaDeVia(r)) && /OpenCode Go/.test(respaldo.notaDeVia(r)));
    modoManual(true);
    const m = await respaldo.conFallback(base);
    modoManual(false);
    check('en modo manual corre igual, sin agy', m.res.success && agyLanzado === 0);
    const falla = await respaldo.conFallback({ ...base, config: { ...config, fallback_agy: 'deepseek' }, generar: async () => ({ ok: false, texto: '', duracion: 0.1, error: 'Go no respondió' }) });
    check('si falla, no cae a agy ni al respaldo', !falla.res.success && agyLanzado === 0 && falla.via === 'opencode-go' && /motores\.roles\.texto → opencode-go: Go no respondió/.test(falla.res.error), falla.res.error);
    const enAgy = await respaldo.conFallback({ ...base, config: { motores: { roles: { texto: { motor: 'antigravity' } } } } });
    check('el rol en agy: el camino de siempre', enAgy.via === 'agy' && agyLanzado === 1);
    const sinRol = await respaldo.conFallback({ ...base, config: {} });
    check('sin rol: agy, como hoy', sinRol.via === 'agy' && agyLanzado === 2);
    check('textoPorRol: claude con cuenta', respaldo.textoPorRol({ motores: { roles: { texto: { motor: 'claude', modelo: 'haiku', cuenta: 'trabajo' } } } }).cuenta === 'trabajo');
  });

  await group('D8 · la puerta de agy', async () => {
    let lanzados = 0;
    const lanzar = async () => { lanzados += 1; return { success: true }; };
    const ok = await motores.despacharAgy({ pedido: { herramienta: 'agy_run', perfil: 'edicion' }, lanzar, manual: false });
    check('con herramienta y perfil, lanza', ok.success && lanzados === 1);
    const manual = await motores.despacharAgy({ pedido: { herramienta: 'agy_research', perfil: 'lectura' }, lanzar, manual: true });
    check('en modo manual no lanza, con la forma de executeAgy', manual.success === false && manual.manual === true && lanzados === 1);
    modoManual(true);
    const porEnv = await motores.despacharAgy({ pedido: { herramienta: 'agy_say', perfil: 'sin-tools' }, lanzar });
    modoManual(false);
    check('el modo manual se lee al momento', porEnv.manual === true && lanzados === 1);
    const sinPerfil = await motores.despacharAgy({ pedido: { herramienta: 'agy_run' }, lanzar, manual: false });
    check('sin perfil, rechaza sin lanzar', !sinPerfil.success && /perfil/.test(sinPerfil.error) && lanzados === 1);
    const raro = await motores.despacharAgy({ pedido: { herramienta: 'agy_run', perfil: 'imagen' }, lanzar, manual: false });
    check('un perfil que antigravity no tiene, rechaza', !raro.success && lanzados === 1);
    const excepcion = await motores.despacharAgy({ pedido: { herramienta: 'agy_image', perfil: 'sin-tools' }, lanzar, manual: false });
    check('una excepción no entra por la puerta', !excepcion.success && /image-generator/.test(excepcion.error) && lanzados === 1);
    check('la lista cerrada: image, voice_stream, fanout y lote', Object.keys(motores.EXCEPCIONES_AGY).sort().join(',') === 'agy_fanout,agy_image,agy_lote,agy_voice_stream');
  });

  await group('D8 · ningún lanzamiento de agy fuera de la puerta y de la lista', () => {
    const LANZADORES = /\bexecuteAgy(?:Stdin|Streaming)?\b/;
    const archivos = [];
    const recorrer = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) recorrer(p);
        else if (/\.(c?js|mjs)$/.test(e.name)) archivos.push(p);
      }
    };
    recorrer(MCP);
    const fuera = [];
    let puertas = 0;
    let excepciones = 0;
    for (const f of archivos) {
      // agy-stream.js define los dos ejecutores de stream.
      if (path.basename(f) === 'agy-stream.js') continue;
      const lineas = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      lineas.forEach((l, i) => {
        const codigo = l.replace(/\/\/.*$/, '');
        if (!LANZADORES.test(codigo) || /^\s*\*/.test(l)) return;
        if (/^\s*(const|let|var)\s*\{[^}]*\}\s*=\s*require\(/.test(codigo)) return; // el require
        if (/^function executeAgy\(/.test(codigo)) return; // la definición
        const marca = /\/\/ D8: (puerta|excepción (\S+))/.exec(l);
        if (marca && marca[1] === 'puerta') { puertas += 1; return; }
        if (marca && marca[2] && Object.prototype.hasOwnProperty.call(motores.EXCEPCIONES_AGY, marca[2])) { excepciones += 1; return; }
        fuera.push(`${path.relative(RAIZ, f)}:${i + 1}`);
      });
    }
    check('todo lanzamiento pasa por la puerta o está en la lista', fuera.length === 0, fuera.join(', '));
    check('la puerta tiene sus dos ejecutores', puertas === 2, String(puertas));
    check('las excepciones marcadas son de la lista (image, fanout, lote)', excepciones >= 3, String(excepciones));
    const narracion = fs.readFileSync(path.join(MCP, 'tools', 'narration.js'), 'utf8');
    check('narrate y say usan la puerta con el perfil sin-tools', /lanzarAgy\(\{ herramienta: 'agy_narrate', perfil: 'sin-tools' \}/.test(narracion) && /lanzarAgy\(\{ herramienta: 'agy_say', perfil: 'sin-tools' \}/.test(narracion));
  });

  await group('D9 · estadoDeMotores y la tabla de roles', async () => {
    const config = { motores: { roles: { audit: { motor: 'opencode-go', modelo: 'hy4-flash-free' }, 'alma:alya': { motor: 'deepseek' } } } };
    const estados = await motores.estadoDeMotores({ config, leerCuota: () => null, dependencias: { resolverBinClaude: () => ({ ok: false }), leerKey: async () => ({ key: null }) } });
    const por = Object.fromEntries(estados.map((e) => [e.id, e]));
    check('cada motor con su código de motivo', por.claude.motivoCodigo === 'sin-cli' && por.deepseek.motivoCodigo === 'sin-key' && por.antigravity.motivoCodigo === null);
    check('con sus capacidades y sus modelos', por['opencode-go'].capacidades.modelos === 'tabla' && por['opencode-go'].modelos.some((m) => m.modelo === 'hy4-flash-free' && m.perfiles.edicion === 'sondeado'));
    const rs = Object.fromEntries(motores.rolesResueltos(config).map((r) => [r.rol, r]));
    check('un rol de la config: su motor y origen config', rs.audit.motor === 'opencode-go' && rs.audit.modelo === 'hy4-flash-free' && rs.audit.origen === 'config');
    check('un rol sin entrada: agy, origen defecto', rs.texto.motor === 'antigravity' && rs.texto.origen === 'defecto');
    check('los roles de la config que no son de intención también', rs['alma:alya'].motor === 'deepseek');
  });

  await group('D9 / V9 · las rutas v2 no sueltan secretos', async () => {
    const VENENO = ['C:\\Users\\alguien\\.claude-work', 'OPENCODE_GO_API_KEY', 'DEEPSEEK_API_KEY', '401 Unauthorized: invalid sk-', 'un aviso de la config', '/home/x/secreto'];
    const vista = {
      ok: true,
      avisos: ['un aviso de la config'],
      sujetos: [{ rol: 'alma:alya', general: 'alma', tipo: 'alma', id: 'alya', propio: { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo', configDir: 'C:\\Users\\alguien\\.claude-work' }, origen: 'alma:alya', efectivo: { motor: 'claude', modelo: 'sonnet', esfuerzo: 'low', cuenta: 'trabajo', configDir: '/home/x/secreto' }, fallback: null, resolucion: null }],
      catalogo: [{ motor: 'claude', cupo: true, modelos: [{ modelo: 'sonnet', admite: true, niveles: ['low'], implicito: 'low' }] }],
      sondas: { 'claude@trabajo': { estado: 'no-vigentes', motivo: 'no se pudo leer: ENOENT C:\\Users\\alguien\\.claude-work\\sondas.json' } },
      cuentasLote: ['principal', 'trabajo'],
      apodos: { principal: 'Spica' },
      deepseek: { key: true, origen: 'keepassxc', lectura: 'DEEPSEEK_API_KEY' },
      opencodeGo: { key: false, origen: null, lectura: 'OPENCODE_GO_API_KEY' },
      motores: [{ id: 'opencode-go', disponible: false, motivo: 'falta OPENCODE_GO_API_KEY en /home/x/secreto/.env', capacidades: { perfiles: { lectura: 'sondeado' }, configDir: '/home/x/secreto' }, cupo: { ok: false, motivo: '401 Unauthorized: invalid sk-abc' }, roles: ['audit'], modelos: [{ modelo: 'hy4-flash-free', perfiles: { edicion: 'sondeado' }, sonda: { edicion: 'vigente', clave: 'OPENCODE_GO_API_KEY' } }] }],
      roles: [{ rol: 'audit', motor: 'opencode-go', modelo: 'hy4-flash-free', esfuerzo: null, origen: 'config', configDir: '/home/x/secreto' }]
    };
    const cupoCrudo = { ok: false, tipo: 'ventanas', motivo: 'falta OPENCODE_GO_API_KEY (401 Unauthorized: invalid sk-abc)' };
    const nucleo = {
      motores: async () => vista,
      motoresV2: async () => vista,
      cupoMotor: async () => cupoCrudo,
      guardarMotor: async () => vista
    };
    const lect = await importar('telegram-bridge/web/v2/lecturas.js');
    const mut = await importar('telegram-bridge/web/v2/mutaciones.js');
    const tareasMod = await importar('telegram-bridge/tareas.js');
    const lecturas = lect.rutasLecturaV2({ nucleo, estadoDeCarriles: () => [], recorte: tareasMod.RECORTE, arranque: 'arr' });
    const mutaciones = mut.rutasMutacionV2({ nucleo, cola: {}, ctx: { chat: { id: 'web:terminal' } }, chatTerminal: 'web:terminal', registro: { obtener: () => null }, idem: null, almacen: { publicar: () => {} }, recorte: tareasMod.RECORTE });
    const llamar = async (rutas, metodo, ruta, cuerpo = {}) => {
      const r = rutas.find((x) => x.metodo === metodo && x.patron.test(ruta.split('?')[0]));
      return r.fn({ p: [], cuerpo, url: new URL(`http://x${ruta}`) });
    };
    const respuestas = {
      'GET /api/v2/motores': await llamar(lecturas, 'GET', '/api/v2/motores'),
      'GET /api/v2/motores/cupo': await llamar(lecturas, 'GET', '/api/v2/motores/cupo?motor=opencode-go'),
      'POST /api/v2/motores/rol': await llamar(mutaciones, 'POST', '/api/v2/motores/rol', { rol: 'audit', motor: 'opencode-go' })
    };
    for (const [ruta, r] of Object.entries(respuestas)) {
      const json = JSON.stringify(r);
      const suelta = VENENO.filter((v) => json.includes(v.replace(/\\/g, '\\\\')) || json.includes(v));
      check(`${ruta}: sin configDir, nombres de key, motivos del proveedor ni avisos`, suelta.length === 0 && !/configDir|avisos|keepassxc/.test(json), suelta.join(' | ') || json.slice(0, 300));
    }
    const v = respuestas['GET /api/v2/motores'];
    check('la terminal sigue leyendo sujetos, catálogo y keys', v.sujetos[0].efectivo.motor === 'claude' && v.sujetos[0].efectivo.cuenta === 'trabajo' && v.catalogo[0].cupo === true && v.deepseek.key === true && v.opencodeGo.key === false);
    check('el motor sale con su código, no con su motivo', v.motores[0].motivoCodigo === 'sin-key' && v.motores[0].cupo.motivoCodigo === 'error' && !('motivo' in v.motores[0]));
    check('la sonda de claude sale con código y texto propio', v.sondas['claude@trabajo'].estado === 'no-vigentes' && v.sondas['claude@trabajo'].motivoCodigo === 'no-vigentes');
    check('los roles salen con su origen', v.roles[0].rol === 'audit' && v.roles[0].origen === 'config');
    const c = respuestas['GET /api/v2/motores/cupo'];
    check('el cupo: la forma de D5 con motivoCodigo', c.ok === false && c.motivoCodigo === 'sin-key' && typeof c.texto === 'string' && !('motivo' in c));
    const ventanas = proyeccion.cupoV2({ ok: true, tipo: 'ventanas', visto: '2026-11-19T10:00:00.000Z', ventanas: [{ nombre: 'weekly', usado: 0.4, reinicia: '2026-11-21T00:00:00.000Z', duracionMs: 604800000, percent: 40, status: 'ok', cuenta: 'x@y.com' }] });
    check('una ventana conserva sus campos y nada más', ventanas.ventanas[0].percent === 40 && ventanas.ventanas[0].duracionMs === 604800000 && !('cuenta' in ventanas.ventanas[0]));
    const saldo = proyeccion.cupoV2({ ok: true, tipo: 'saldo', saldo: '4.20', moneda: 'USD', disponible: true });
    check('el saldo de deepseek', saldo.tipo === 'saldo' && saldo.saldo === '4.20' && saldo.moneda === 'USD');
    const error = await mut.rutasMutacionV2({ nucleo: { guardarMotor: async () => ({ codigo: 400, ok: false, error: 'rol inválido' }) }, cola: {}, ctx: {}, chatTerminal: 'web:terminal', registro: {}, idem: null, almacen: { publicar: () => {} }, recorte: tareasMod.RECORTE })
      .find((x) => x.metodo === 'POST' && x.patron.test('/api/v2/motores/rol')).fn({ p: [], cuerpo: {} });
    check('un rechazo de guardarRol pasa tal cual', error.codigo === 400 && error.error === 'rol inválido');
  });

  await group('status usa la proyección del cupo', () => {
    const lineas = motores.lineasDeMotores([{ id: 'opencode-go', disponible: true, motivo: null, roles: [], cupo: { ok: false, motivo: 'OPENCODE_GO_API_KEY rechazada' } }]).join('\n');
    check('sin el motivo crudo del cupo', !/OPENCODE_GO_API_KEY/.test(lineas) && /quota: unknown/.test(lineas), lineas);
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
