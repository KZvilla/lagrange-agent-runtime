/**
 * FEAT-101 — Los datos del panel de Lagrange: `mcp-server/lib/fanout-linea.js`
 * (movido sin cambios desde `fanout-statusline.js`) y `hooks/panel.js`, corrido
 * como proceso, como lo corre el mod. Todo en directorios temporales.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, report } = require('./lib/assert');
const { temporalQueSeBorra } = require('./lib/temporales');
const linea = require('../mcp-server/lib/fanout-linea.js');

const PANEL = path.join(__dirname, '..', 'hooks', 'panel.js');

function estado(cwd, nombre, datos) {
  const dir = path.join(cwd, '.claude', 'worktrees');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `.fanout-status-${nombre}.json`), JSON.stringify(datos));
}

function panel(modo, cwd, home) {
  const r = spawnSync(process.execPath, [PANEL, modo, cwd], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' }
  });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  return { ...r, j };
}

async function main() {
  const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
  const enCurso = { slug: 'demo', iniciado: hace(1), actualizado: hace(0), tareas: { t1: { estado: 'ok' }, t2: { estado: 'corriendo' } } };

  await group('fanout-linea: la misma línea que la statusline', () => {
    check('en curso: progreso y lo que sigue corriendo', /^🔀 fanout demo: 1\/2 · 1 ok · 1 corriendo \(1m\d+s\)$/.test(linea.armarLinea(enCurso)), linea.armarLinea(enCurso));
    const terminada = { ...enCurso, terminado: hace(2), tareas: { t1: { estado: 'ok' }, t2: { estado: 'error' } } };
    check('terminada hace 2 min: no expiró y lo dice', !linea.estaExpirada(terminada) && /\(terminado, /.test(linea.armarLinea(terminada)));
    check(`terminada hace más de ${linea.TTL_TERMINADO_MIN} min: expirada`, linea.estaExpirada({ ...terminada, terminado: hace(linea.TTL_TERMINADO_MIN + 1) }));
    check('sin tareas: null', linea.armarLinea({ slug: 'x', tareas: {} }) === null);
    const cwd = temporalQueSeBorra('panel-linea-');
    estado(cwd, 'vieja', { ...enCurso, slug: 'vieja', actualizado: hace(30) });
    estado(cwd, 'nueva', enCurso);
    check('corridaMasReciente elige la de actualizado más nuevo', linea.corridaMasReciente(cwd).slug === 'demo');
  });

  await group('panel.js fanout', () => {
    const home = temporalQueSeBorra('panel-home-');
    const vacio = temporalQueSeBorra('panel-vacio-');
    const r = panel('fanout', vacio, home);
    check('sin nada: { fanout: null } y exit 0', r.status === 0 && r.j && r.j.fanout === null, r.stdout + r.stderr);
    const cwd = temporalQueSeBorra('panel-fan-');
    estado(cwd, 'demo', enCurso);
    const f = panel('fanout', cwd, home).j?.fanout;
    check('con uno en curso: la línea y las tareas', f && /fanout demo: 1\/2/.test(f.linea) && f.tareas.length === 2 && f.tareas.some((t) => t.id === 't2' && t.estado === 'corriendo') && f.terminado === false, JSON.stringify(f));
    estado(cwd, 'demo', { ...enCurso, terminado: hace(20) });
    check('expirado: null', panel('fanout', cwd, home).j?.fanout === null);
  });

  await group('panel.js foto: cuota y versiones, sin rutas', () => {
    const home = temporalQueSeBorra('panel-foto-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity-usage.json'), JSON.stringify({
      session: { total_calls: 1, total_tokens: 1 },
      cuota: {
        antigravity: { grupos: { gemini: { ventana_5h: 0.1, ventana_7d: 0.25 } }, cuenta: 'cr***@gmail.com', visto_en: hace(5) },
        claude: { ventana_5h: 0.2, ventana_7d: 0.3, visto_en: hace(9) }
      }
    }));
    const cwd = temporalQueSeBorra('panel-foto-cwd-');
    estado(cwd, 'demo', enCurso);
    const r = panel('foto', cwd, home);
    const j = r.j || {};
    check('exit 0 con las tres secciones', r.status === 0 && 'fanout' in j && 'cuota' in j && 'versiones' in j, r.stdout + r.stderr);
    check('la cuota de agy por grupo, como fracción usada', j.cuota?.antigravity?.grupos?.gemini?.ventana5h === 0.1 && j.cuota.antigravity.grupos.gemini.ventana7d === 0.25, JSON.stringify(j.cuota));
    check('sin la cuenta enmascarada de agy', !r.stdout.includes('gmail') && !('cuenta' in (j.cuota?.antigravity || {})));
    check('la cuota de Claude', j.cuota?.claude?.ventana5h === 0.2);
    // BE-092 — El panel dice de cuándo es cada cuota: el dato tiene que llegar.
    check('vistoEn de Claude y de agy en la foto', typeof j.cuota?.claude?.vistoEn === 'string' && typeof j.cuota?.antigravity?.vistoEn === 'string', JSON.stringify(j.cuota));
    check('versiones: esta copia y la cuenta principal', typeof j.versiones?.propia === 'string' && j.versiones.cuentas.some((c) => c.cuenta === 'principal'), JSON.stringify(j.versiones));
    const sinBarras = (p) => p.replace(/\\/g, '/');
    check('ninguna ruta del temporal en la salida', !sinBarras(r.stdout).includes(sinBarras(home)) && !sinBarras(r.stdout).includes(sinBarras(cwd)) && !r.stdout.includes('dir'), r.stdout);
    fs.writeFileSync(path.join(home, '.claude', 'antigravity-usage.json'), '{ roto');
    const roto = panel('foto', cwd, home);
    check('una sección sin datos queda null y las demás salen igual', roto.status === 0 && roto.j?.cuota === null && roto.j?.fanout?.slug === 'demo' && roto.j?.versiones, roto.stdout);
    check('un modo desconocido: exit 0 con error', panel('otro', cwd, home).j?.error === 'modo desconocido');
  });

  // BE-093 — La cuota que mide la sesión interactiva, bajo la clave de su cuenta.
  await group('panel.js cuota-sesion: la cuota de la sesión con la clave de la cuenta', () => {
    const home = temporalQueSeBorra('panel-cuota-');
    const otra = path.join(home, '.claude-otra');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(otra, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: { cuentas: { trabajo: { configDir: otra } } } }));
    const usos = path.join(home, '.claude', 'antigravity-usage.json');
    const leer = () => { try { return JSON.parse(fs.readFileSync(usos, 'utf8')).cuota || {}; } catch { return {}; } };
    const cwd = temporalQueSeBorra('panel-cuota-cwd-');
    const correr = (args, extra = {}) => {
      const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', ...extra };
      delete env.CLAUDECODE;
      const r = spawnSync(process.execPath, [PANEL, 'cuota-sesion', cwd, ...args], { encoding: 'utf8', timeout: 15000, env });
      let j = null;
      try { j = JSON.parse(r.stdout); } catch {}
      return { ...r, j };
    };
    const reset = '2026-10-02T23:00:00.000Z';
    const r = correr(['42', reset, '31', '2026-10-05T10:00:00.000Z']);
    const c = leer().claude || {};
    check('principal sin CLAUDECODE ni CLAUDE_CONFIG_DIR: escribe cuota.claude', r.status === 0 && r.j?.ok && r.j.clave === 'claude' && c.ventana_5h === 0.42 && c.ventana_7d === 0.31, r.stdout + r.stderr + JSON.stringify(c));
    check('con reinicios, fuente y visto_en', c.resetea_5h === reset && c.fuente === 'sesion' && typeof c.visto_en === 'string' && c.estado === null, JSON.stringify(c));
    check('sin rutas en la salida', !r.stdout.replace(/\\/g, '/').includes(home.replace(/\\/g, '/')));
    const t = correr(['150', '-', '-', '-'], { CLAUDE_CONFIG_DIR: otra });
    const ct = leer()['claude@trabajo'] || {};
    check('cuenta declarada: cuota.claude@trabajo, 150 % queda en 1', t.j?.clave === 'claude@trabajo' && ct.ventana_5h === 1 && ct.ventana_7d === null && ct.resetea_5h === null, t.stdout + JSON.stringify(ct));
    const antes = fs.readFileSync(usos, 'utf8');
    const n = correr(['10', '-', '-', '-'], { CLAUDE_CONFIG_DIR: path.join(home, '.claude-nadie') });
    check('carpeta no declarada: no escribe', n.status === 0 && n.j?.ok === false && fs.readFileSync(usos, 'utf8') === antes, n.stdout);
    const v = correr(['-', '-', '-', '-']);
    const x = correr(['mucho', reset, 'poco', '-']);
    check('sin ventanas o porcentaje no numérico: exit 0 sin escribir', v.status === 0 && v.j?.ok === false && x.status === 0 && x.j?.ok === false && fs.readFileSync(usos, 'utf8') === antes, v.stdout + x.stdout);
  });

  report();
}

main();
