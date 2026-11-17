/**
 * FEAT-197 — Interfaz de las tools en inglés y sin el proveedor en el nombre:
 * - `tools/list` no publica ningún `agy_*` ni parámetros o valores en español (salvo los ajustes de `set_config`);
 * - la tabla de nombres-tools.js va y vuelve sin perder nada;
 * - un nombre o parámetro viejo se rechaza con el nombre nuevo y no corre nada (también dentro de agy, r1 F9);
 * - la tabla de política del MCP y la del servidor web siguen iguales (r1 F4);
 * - un cursor con `tool: "auditoria"` sigue avisando por la ruta de la cola nueva (r1 F6);
 * - las regex de los hooks solo toman los servidores de Lagrange (r1 F10);
 * - un pedido viejo de la cola llega con el aviso (r1 F11);
 * - el migrador de permisos reescribe, respalda y es idempotente.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');

const RAIZ = path.join(__dirname, '..');
const nombres = require(path.join(RAIZ, 'mcp-server', 'lib', 'nombres-tools.js'));
const migrar = require(path.join(RAIZ, 'mcp-server', 'lib', 'migrar-permisos.js'));
const pedidosSesion = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-sesion.js'));

const texto = (r) => ((r && r.result && r.result.content) || []).map((c) => c.text || '').join('\n');
const esError = (r) => Boolean(r && r.result && r.result.isError);

// Palabras en español que no pueden quedar como parámetro o valor de la interfaz (FEAT-197).
const ESPANOL = new Set([
  'accion', 'pedir', 'pedido', 'listar', 'tomar', 'soltar', 'entregar', 'recoger', 'mios', 'para_auditar', 'forzar',
  'informe', 'nombre', 'esperar', 'esperar_segundos', 'texto', 'nota', 'titulo', 'pasos', 'metodo', 'ruta', 'cuerpo',
  'tipo', 'estados', 'segundos', 'estado', 'rutas', 'abrir', 'terminar', 'llamar', 'responder', 'preguntar', 'tarea',
  'lote', 'aprobacion', 'agentes', 'enviar', 'leer', 'silenciar', 'para', 'todos', 'si', 'buscar', 'anotar',
  'verificar', 'limite', 'descripcion', 'revisar', 'dias', 'proyecto', 'Hallazgo', 'Trampa', 'Pendiente', 'desde',
  'archivos', 'tareas', 'concurrencia', 'modelo', 'soloLectura', 'lanzar', 'prueba', 'motor', 'modelo_auditor', 'receta',
  'confirmacion', 'alma', 'modo', 'inmediato', 'diferido', 'reaccionable', 'extracto', 'exportar', 'importar', 'archivo',
  'confirmar', 'ver', 'olvidar', 'semilla', 'agente', 'voz', 'completa', 'identidad', 'usuario', 'incluir_diario',
  'incluir_hilo', 'sondas'
]);

function recorrer(schema, fn, ruta = '') {
  if (!schema || typeof schema !== 'object') return;
  for (const [k, v] of Object.entries(schema.properties || {})) {
    fn(k, v, `${ruta}${k}`);
    recorrer(v, fn, `${ruta}${k}.`);
    if (v && v.items) recorrer(v.items, fn, `${ruta}${k}[].`);
  }
}

async function conServidor(env, fn) {
  const s = startServer({ env });
  try { await s.initialize(); return await fn(s); } finally { await s.stop(); }
}

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat197-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'inicio');
  return dir;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat197-data-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat197-cfg-'));
  const cfg = path.join(cfgDir, 'antigravity.json');
  const base = { LAGRANGE_AGY_MODO_CONFIG: cfg, TELEGRAM_BRIDGE_DATA_DIR: dataDir, HOME: cfgDir, USERPROFILE: cfgDir };

  await group('tools/list publica la interfaz en inglés', async () => {
    const tools = await conServidor(base, async (s) => (await s.listTools()).result.tools);
    const nombresPublicos = tools.map((t) => t.name);
    check('ningún nombre empieza con agy_', nombresPublicos.every((n) => !n.startsWith('agy_')), nombresPublicos.filter((n) => n.startsWith('agy_')).join(', '));
    for (const n of ['run', 'plan', 'review', 'audit', 'research', 'batch', 'fanout', 'image', 'usage', 'status',
      'session_summary', 'voice_stream', 'audit_queue', 'soul', 'console', 'message', 'knowledge']) {
      check(`publica ${n}`, nombresPublicos.includes(n));
    }
    check('sin nombres repetidos', new Set(nombresPublicos).size === nombresPublicos.length);
    const malos = [];
    for (const t of tools) {
      if (t.name === 'set_config') continue; // ajustes persistidos: fuera de alcance (r1 F5)
      recorrer(t.inputSchema, (k, v, ruta) => {
        if (ESPANOL.has(k)) malos.push(`${t.name}.${ruta}`);
        for (const e of (v && v.enum) || []) if (ESPANOL.has(e)) malos.push(`${t.name}.${ruta}=${e}`);
        if (Array.isArray(v && v.required)) for (const r of v.required) if (ESPANOL.has(r)) malos.push(`${t.name}.${ruta} required ${r}`);
      });
      for (const r of t.inputSchema.required || []) if (ESPANOL.has(r)) malos.push(`${t.name} required ${r}`);
    }
    check('ningún parámetro ni valor en español (salvo set_config)', malos.length === 0, malos.join(', '));
  });

  await group('la tabla va y vuelve', () => {
    const casos = [
      ['agy_lote', { accion: 'lanzar', slug: 's', tareas: [{ id: 'a', prompt: 'p', archivos: ['x/'], modelo: 'm', prueba: { argv: ['node'] } }], modelo_auditor: 'q', motor: 'claude@w', receta: 'r', concurrencia: 2 }],
      ['consola', { accion: 'pasos', pasos: ['uno', { id: 'p1', texto: 't', estado: 'en_curso', enlaces: [{ tipo: 'tarjeta', id: 't_1' }] }] }],
      ['auditoria', { accion: 'entregar', id: 'abcdef', informe: '## Verdict: PASS', nombre: 'x', forzar: true }],
      ['alma', { action: 'importar', voz: 'Alya', archivo: 'f', confirmar: true, confirmacion: 'tok', tipo: 'completa' }],
      ['conocimiento', { accion: 'anotar', tipo: 'Hallazgo', titulo: 't', cuerpo: 'c', revisar: true }],
      ['telegram_send_voice', { reaccionable: { alma: 'a', extracto: 'e' } }],
      ['agy_plan', { task: 't', pedido: 'abcdef', esperar_segundos: 0 }]
    ];
    for (const [nombre, args] of casos) {
      const pub = nombres.llamadaPublica(nombre, args);
      const vuelta = nombres.llamadaInterna(pub.nombre, pub.args);
      check(`${nombre} → ${pub.nombre} → ${vuelta.nombre}`, vuelta.nombre === nombre && JSON.stringify(vuelta.args) === JSON.stringify(args), JSON.stringify(vuelta));
    }
    check('NOMBRES tiene los 17 cambios', Object.keys(nombres.NOMBRES).length === 17, Object.keys(nombres.NOMBRES).join(','));
    check('un nombre viejo no es un alias', Boolean(nombres.llamadaInterna('agy_audit', {}).error) && nombres.llamadaInterna('agy_audit', {}).nuevo === 'audit');
    check('un parámetro viejo se rechaza con el nuevo', /`accion` ahora se llama `action`/.test(nombres.llamadaInterna('batch', { accion: 'estado' }).error || ''));
    check('un valor viejo se rechaza con el nuevo', /"estado".*"status"/.test(nombres.llamadaInterna('batch', { action: 'estado' }).error || ''));
    check('un alias quitado se rechaza', /ya no existe/.test(nombres.llamadaInterna('voice_stream', { alma: 'x' }).error || ''));
    check('una tool fuera de la tabla pasa igual', nombres.llamadaInterna('telegram_notify', { message: 'm' }).nombre === 'telegram_notify');
  });

  await group('tools/call rechaza nombres viejos sin correr nada', async () => {
    await conServidor(base, async (s) => {
      const r = await s.requestCrudo('tools/call', { name: 'agy_status', arguments: {} });
      check('agy_status → status', esError(r) && /ahora se llama `status`/.test(texto(r)), texto(r));
      const r2 = await s.requestCrudo('tools/call', { name: 'agy_lote', arguments: { accion: 'estado' } });
      check('agy_lote → batch', esError(r2) && /ahora se llama `batch`/.test(texto(r2)), texto(r2));
      const r3 = await s.requestCrudo('tools/call', { name: 'batch', arguments: { accion: 'estado' } });
      check('batch con accion → action', esError(r3) && /`action`/.test(texto(r3)), texto(r3));
      const r4 = await s.requestCrudo('tools/call', { name: 'status', arguments: {} });
      check('status corre', !esError(r4), texto(r4).slice(0, 200));
    });
    await conServidor({ ...base, LAGRANGE_HOST: 'agy' }, async (s) => {
      const r = await s.requestCrudo('tools/call', { name: 'agy_status', arguments: {} });
      check('dentro de agy, agy_status → "ahora se llama status" (r1 F9)', esError(r) && /ahora se llama `status`/.test(texto(r)), texto(r));
      const r2 = await s.requestCrudo('tools/call', { name: 'agy_run', arguments: { prompt: 'x' } });
      check('dentro de agy, agy_run → el texto de FEAT-196 (run tampoco está)', esError(r2) && /no está disponible/.test(texto(r2)), texto(r2));
      const tools = (await s.listTools()).result.tools.map((t) => t.name).sort();
      check('dentro de agy, solo audit_queue, status y usage', JSON.stringify(tools) === JSON.stringify(['audit_queue', 'status', 'usage']), tools.join(','));
    });
  });

  await group('política: el MCP y el servidor web usan la misma tabla (r1 F4)', () => {
    const mcp = fs.readFileSync(path.join(RAIZ, 'mcp-server', 'lib', 'politica-herramientas.js'), 'utf8');
    const web = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'web', 'servidor.js'), 'utf8');
    const tabla = (src) => (/agy_lote: \['lanzar'\], agy_fanout: \['lanzar'\], cast_agent: \[[^\]]*\]/.exec(src) || [])[0];
    check('las dos tablas existen y son iguales', Boolean(tabla(mcp)) && tabla(mcp) === tabla(web));
    check('la tabla nombra tools internas de la tabla de nombres', ['agy_lote', 'agy_fanout', 'cast_agent'].every((t) => nombres.TOOLS[t]));
  });

  await group('cursores y pedidos de antes del cambio (r1 F6, F11)', async () => {
    const viejo = { id: 'abcdef', tipo: 'audit', tool: 'auditoria' };
    check('tool "auditoria" → ruta de la cola nueva', pedidosSesion.rutaInforme(viejo) === '.lagrange/auditorias/informes/abcdef.md');
    check('tool "auditoria" → recoger con audit_queue', /`audit_queue` \(`action: "collect"`/.test(pedidosSesion.textoRecoger(viejo)));
    check('tool "audit_queue" vale lo mismo', pedidosSesion.rutaInforme({ ...viejo, tool: 'audit_queue' }) === '.lagrange/auditorias/informes/abcdef.md');
    check('tool "agy_review" → recoger con review y request_id', /`review` \(`request_id: "abcdef"`/.test(pedidosSesion.textoRecoger({ id: 'abcdef', tipo: 'review', tool: 'agy_review' })));

    const dir = repo();
    try {
      fs.mkdirSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos'), { recursive: true });
      // Un pedido escrito con la plantilla de antes de FEAT-197 (cita la tool `auditoria`).
      fs.writeFileSync(path.join(dir, '.lagrange', 'auditorias', 'pedidos', 'abcdef.md'), [
        '---', 'id: abcdef', 'tipo: audit', 'modo: implementation', 'solicitante: claude:otra', `cwd: ${dir.replace(/\\/g, '/')}`,
        'informe: .lagrange/auditorias/informes/abcdef.md', '---', '', '# Pedido de auditoría abcdef',
        '', '**Tomalo antes de empezar.** Con la herramienta de Lagrange de tu harness (la tool `auditoria`, o `/lagrange-audit abcdef`', 'en agy): `tomar` lo reserva para vos y `entregar` escribe el informe.', ''
      ].join('\n'));
      // 0601e7 F1 — Host explícito: sin él, el resultado dependía de heredar el entorno de una sesión de Claude Code.
      await conServidor({ ...base, LAGRANGE_AGY_MODO: 'manual', LAGRANGE_HOST: 'opencode' }, async (s) => {
        const r = await s.requestCrudo('tools/call', { name: 'audit_queue', arguments: { action: 'take', id: 'abcdef', cwd: dir, session_id: 'yo-1' } });
        const t = texto(r);
        if (esError(r)) {
          check('take de un pedido viejo (sin error)', false, t);
        } else {
          check('take de un pedido viejo trae el aviso de FEAT-197', /anterior a FEAT-197/.test(t) && /`audit_queue` con `action: "submit"`/.test(t), t.slice(0, 400));
          check('y el cuerpo viejo, tal cual', /la tool `auditoria`/.test(t));
        }
      });
    } finally {
      removeFixture(dir);
    }
  });

  await group('hooks: solo los servidores de Lagrange (r1 F10)', async () => {
    const banda = await import(pathToFileURL(path.join(RAIZ, 'hooks', 'banda-texto.ts')).href).catch(() => null);
    const cuota = await import(pathToFileURL(path.join(RAIZ, 'hooks', 'cuota-previa.ts')).href).catch(() => null);
    const voz = await import(pathToFileURL(path.join(RAIZ, 'hooks', 'voz-texto.ts')).href).catch(() => null);
    if (!banda || !cuota || !voz) {
      // Node sin soporte de .ts: lo cubren los tests de mods (`npm run test:mod`); acá, la fuente.
      const src = fs.readFileSync(path.join(RAIZ, 'hooks', 'banda-texto.ts'), 'utf8');
      check('banda-texto nombra los servidores de Lagrange', /mcp__\(\?:plugin_lagrange_lagrange\|lagrange\|lagrange-dev\)__\(run\|audit\|plan\|review\|research\|fanout\|batch\)/.test(src));
      return;
    }
    check('banda: mcp__plugin_lagrange_lagrange__run sí', banda.esToolDeAgy('mcp__plugin_lagrange_lagrange__run'));
    check('banda: mcp__lagrange-dev__batch sí', banda.esToolDeAgy('mcp__lagrange-dev__batch'));
    check('banda: mcp__otro__run no', !banda.esToolDeAgy('mcp__otro__run'));
    check('banda: el nombre viejo no', !banda.esToolDeAgy('mcp__lagrange__agy_run'));
    check('cuota: mcp__otro__batch no se mira', cuota.modelosDelPedido('mcp__otro__batch', { action: 'launch', tasks: [{}] }, 'gemini-x') === null);
    const p = cuota.modelosDelPedido('mcp__lagrange__batch', { action: 'launch', tasks: [{ model: 'gemini-a' }, {}], auditor_model: 'claude-b', model: 'gemini-c' }, null);
    check('cuota: batch lee tasks/model/auditor_model', p && p.tool === 'batch' && JSON.stringify(p.modelos) === JSON.stringify(['gemini-a', 'gemini-c', 'claude-b']), JSON.stringify(p));
    check('cuota: batch status no se mira', cuota.modelosDelPedido('mcp__lagrange__batch', { action: 'status' }, null) === null);
    check('voz: mcp__otro__say no', !voz.esToolDeVoz('mcp__otro__say') && voz.esToolDeVoz('mcp__plugin_lagrange_lagrange__say'));
  });

  await group('migrador de permisos', async () => {
    const t = '{\n  // comentario\n  "permissions": { "allow": ["mcp__plugin_lagrange_lagrange__agy_audit", "mcp__lagrange__mensaje", "Bash(git status)"] },\n  "tools": { "lagrange_auditoria": true }\n}\n';
    const r = migrar.migrarTexto(t);
    check('reescribe los tres', r.texto.includes('"mcp__plugin_lagrange_lagrange__audit"') && r.texto.includes('"mcp__lagrange__message"') && r.texto.includes('"lagrange_audit_queue"'), r.texto);
    check('conserva comentarios y lo ajeno', r.texto.includes('// comentario') && r.texto.includes('"Bash(git status)"'));
    check('segunda pasada sin cambios', migrar.migrarTexto(r.texto).cambios.length === 0);
    check('nombresViejos avisa', migrar.nombresViejos(t).length === 3 && migrar.nombresViejos(r.texto).length === 0);
    check('no toca prefijos parciales', migrar.migrarTexto('["mcp__lagrange__agy_audit_extra"]').cambios.length === 0);
    check('un comodín viejo no se reescribe pero se avisa (5d6f80 F3)', migrar.migrarTexto('{"lagrange_agy_*": "ask"}').cambios.length === 0
      && JSON.stringify(migrar.nombresViejos('{"lagrange_agy_*": "ask", "x": ["mcp__lagrange__agy_*"]}')) === JSON.stringify(['lagrange_agy_*', 'mcp__lagrange__agy_*']));

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat197-home-'));
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), t);
      const script = await import(pathToFileURL(path.join(RAIZ, 'scripts', 'tools-migrar.mjs')).href);
      const archivos = script.archivosAMirar({ env: {}, home, cuentas: {} });
      const seco = script.migrar({ archivos });
      check('sin --aplicar no escribe', fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8') === t && seco.some((x) => x.cambios.length));
      const hecho = script.migrar({ archivos, aplicar: true });
      const fila = hecho.find((x) => x.cambios.length);
      check('con --aplicar escribe y respalda', fila && fs.existsSync(fila.respaldo) && fs.readFileSync(fila.respaldo, 'utf8') === t
        && fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8') === r.texto);
      check('segunda corrida: nada', script.migrar({ archivos, aplicar: true }).every((x) => !x.cambios.length));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cfgDir, { recursive: true, force: true });
  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
