/**
 * FEAT-202 S0 — Capacidades declaradas y roles por intención.
 *
 *   - cada motor exporta `capacidades`, y `perfiles` es la misma referencia;
 *   - los roles nuevos (`audit`, `run`, `texto`…) se validan por capacidad, en config global y de proyecto;
 *   - lo de siempre no cambia: deepseek y opencode-go corren almas y consolidación, no casts;
 *   - `elegir` dice de dónde salió la elección;
 *   - las constantes que forzaban a cargar módulos grandes viven en hojas, y no hay ciclos de `require`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { check, group, report } = require('./lib/assert');
const MCP = path.join(__dirname, '..', 'mcp-server');
const motores = require(path.join(MCP, 'motores', 'index.js'));
const roles = require(path.join(MCP, 'motores', 'roles.js'));
const cap = require(path.join(MCP, 'motores', 'capacidades.js'));
const { aplicarRol } = require(path.join(MCP, 'motores', 'config-motores.js'));
const { loadConfig } = require(path.join(MCP, 'lib', 'config.js'));

const GO = { motor: 'opencode-go', modelo: 'deepseek-v4.1-flash', esfuerzo: 'low' };
const DS = { motor: 'deepseek', modelo: 'deepseek-flash' };

/** Ciclos de `require()` relativos dentro de `dir` (los dinámicos con string literal cuentan igual). */
function ciclosDeRequire(dir) {
  const g = new Map();
  const recorrer = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (!['node_modules', 'vendor'].includes(f.name)) recorrer(p); } else if (f.name.endsWith('.js')) g.set(p, []);
    }
  };
  recorrer(dir);
  for (const p of g.keys()) {
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    const s = fs.readFileSync(p, 'utf8');
    let m;
    while ((m = re.exec(s))) {
      let t = path.resolve(path.dirname(p), m[1]);
      if (!t.endsWith('.js')) t = fs.existsSync(`${t}.js`) ? `${t}.js` : path.join(t, 'index.js');
      if (g.has(t)) g.get(p).push(t);
    }
  }
  const estado = new Map();
  const pila = [];
  const ciclos = [];
  const dfs = (n) => {
    estado.set(n, 1); pila.push(n);
    for (const v of g.get(n)) {
      if (estado.get(v) === 1) ciclos.push(pila.slice(pila.indexOf(v)).concat(v).map((x) => path.relative(dir, x)).join(' -> '));
      else if (!estado.get(v)) dfs(v);
    }
    pila.pop(); estado.set(n, 2);
  };
  for (const n of g.keys()) if (!estado.get(n)) dfs(n);
  return ciclos;
}

async function main() {
  await group('cada motor declara sus capacidades', async () => {
    for (const [id, m] of Object.entries(motores.MOTORES)) {
      check(`${id}: capacidades del módulo hoja`, m.capacidades === cap.CAPACIDADES[id]);
      check(`${id}: perfiles es la misma referencia`, m.perfiles === m.capacidades.perfiles);
    }
    check('los cuatro motores, y nada más', Object.keys(cap.CAPACIDADES).sort().join() === Object.keys(motores.MOTORES).sort().join());
    check('solo agy tiene imagen, stream, red y contenedor', ['imagen', 'stream', 'red', 'contenedor'].every((k) => Object.entries(cap.CAPACIDADES).filter(([, c]) => c[k]).map(([id]) => id).join() === 'antigravity'));
    check('cupo: deepseek por saldo, los demás por ventanas', cap.CAPACIDADES.deepseek.cupo === 'saldo' && ['antigravity', 'claude', 'opencode-go'].every((id) => cap.CAPACIDADES[id].cupo === 'ventanas'));
  });

  await group('roles por intención: forma', async () => {
    for (const rol of Object.keys(cap.ROLES_INTENCION)) check(`${rol} es un rol válido`, roles.rolValido(rol) && roles.ROLES_BASE.includes(rol));
    check('los de siempre siguen', ['alma', 'consolidar', 'cast', 'alma:alya', 'consolidar:alya', 'cast:lagrange-plan'].every(roles.rolValido));
    check('uno inventado, no', !roles.rolValido('auditar') && !roles.rolValido('audit:x'));
  });

  await group('roles por intención: qué motor puede', async () => {
    const v = (tabla) => roles.validarRoles(tabla, { estricto: true });
    check('texto en opencode-go y en deepseek', v({ texto: GO }).ok && v({ texto: DS }).ok);
    check('texto en claude (sin-tools sondeado)', v({ texto: { motor: 'claude', modelo: 'haiku' } }).ok);
    check('texto en antigravity (sin-tools verificado)', v({ texto: { motor: 'antigravity' } }).ok);
    const audit = v({ audit: GO });
    // S2 — La lectura de opencode-go va por modelo: deepseek-v4.1-flash la tiene verificada (FEAT-176).
    check('audit en opencode-go con deepseek-v4.1-flash: lectura verificada, vale (S2)', audit.ok, audit.motivo);
    // FEAT-206 — claude corre la lectura solo dentro de un cast: un rol de lectura en claude se rechaza.
    check('audit en claude: se rechaza (la lectura de claude necesita un cast)', !v({ audit: { motor: 'claude', modelo: 'sonnet' } }, { estricto: true }).ok);
    const agy = v({ audit: { motor: 'antigravity' } });
    check('audit en antigravity: lectura solo declarada, se rechaza y dice que sin entrada ya corre ahí', !agy.ok && /solo declarado/.test(agy.motivo) && /sin entrada en motores.roles/.test(agy.motivo), agy.motivo);
    const run = v({ run: { motor: 'claude', modelo: 'sonnet' } });
    check('run en claude: no tiene edicion', !run.ok && /claude no tiene el perfil edicion/.test(run.motivo), run.motivo);
    const imagen = v({ imagen: GO });
    check('imagen en opencode-go: sin la capacidad', !imagen.ok && /no tiene imagen/.test(imagen.motivo), imagen.motivo);
    check('voz en antigravity: sin-tools verificado y stream', v({ voz: { motor: 'antigravity' } }).ok);
    const voz = v({ voz: { motor: 'claude', modelo: 'haiku' } });
    check('voz en claude: sin stream', !voz.ok && /no tiene stream/.test(voz.motivo), voz.motivo);
    const research = v({ research: { motor: 'claude', modelo: 'sonnet' } });
    check('research en claude: sin red', !research.ok && /no tiene red/.test(research.motivo), research.motivo);
  });

  await group('lo de siempre no cambia', async () => {
    const v = (tabla) => roles.validarRoles(tabla, { estricto: true });
    check('almas y consolidación en Go y en DeepSeek', v({ alma: GO, 'alma:alya': GO, consolidar: GO, 'consolidar:alya': DS }).ok);
    check('cast en Go o DeepSeek: no', !v({ cast: GO }).ok && !v({ 'cast:x': DS }).ok);
    check('cast en antigravity y en claude: sí (los caminos de hoy aceptan declarado)', v({ cast: { motor: 'antigravity' }, 'cast:x': { motor: 'claude', modelo: 'sonnet' } }).ok);
    check('alma en antigravity', v({ alma: { motor: 'antigravity' } }).ok);
  });

  await group('ida y vuelta: config global y de proyecto', async () => {
    const r = aplicarRol({}, 'texto', GO);
    check('aplicarRol guarda texto', r.ok && r.roles.texto && r.roles.texto.motor === 'opencode-go', JSON.stringify(r));
    const r2 = aplicarRol(r.datos, 'texto', null);
    check('y lo quita', r2.ok && !r2.roles.texto);
    check('aplicarRol rechaza un cast en Go (S2: sin casts)', !aplicarRol({}, 'cast', GO).ok);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-home-'));
    const proyecto = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-proy-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(proyecto, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: { roles: { texto: GO, review: { motor: 'claude', modelo: 'sonnet' } } } }));
    const viejoHome = process.env.HOME; const viejoUp = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const c = loadConfig(proyecto);
      const t = c.motores.roles || {};
      // FEAT-206 — review en claude se saca con un aviso; el resto de la tabla queda.
      check('texto en Go desde la global; review en claude se saca con aviso', t.texto && t.texto.motor === 'opencode-go' && !t.review && c.avisos.some((x) => /review/.test(x)), JSON.stringify(t));
      // La tabla del proyecto reemplaza a la global entera; un motor de terceros, ahí, se descarta.
      fs.writeFileSync(path.join(proyecto, '.claude', 'antigravity.json'), JSON.stringify({ motores: { roles: { plan: { motor: 'claude', modelo: 'opus' }, texto: DS } } }));
      const cp = loadConfig(proyecto);
      const tp = cp.motores.roles || {};
      check('plan en claude, desde el proyecto: se saca con aviso (FEAT-206)', !tp.plan && cp.avisos.some((x) => /plan/.test(x)), JSON.stringify(tp));
      check('un motor de terceros desde el proyecto se descarta, con aviso', !(tp.texto && tp.texto.motor === 'deepseek') && cp.avisos.some((a) => /deepseek/.test(a)), JSON.stringify(cp.avisos));
      const e = motores.elegir(c, 'texto');
      check('elegir: el rol configurado', e.motor.id === 'opencode-go' && e.fijo && e.seleccion === 'rol');
      const d = motores.elegir(c, 'audit');
      check('elegir: sin entrada, antigravity por defecto', d.motor.id === 'antigravity' && !d.fijo && d.seleccion === 'defecto');
    } finally {
      process.env.HOME = viejoHome; process.env.USERPROFILE = viejoUp;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(proyecto, { recursive: true, force: true });
    }
  });

  await group('constantes en módulos hoja, sin ciclos', async () => {
    const fb = require(path.join(MCP, 'lib', 'fallback-agy.js'));
    const forma = require(path.join(MCP, 'lib', 'forma-fallback.js'));
    const pat = require(path.join(MCP, 'lib', 'patrones-agy.js'));
    const uso = require(path.join(MCP, 'lib', 'uso-agy.js'));
    const rl = require(path.join(MCP, 'lib', 'cuota-rate-limit.js'));
    check('fallback-agy reexporta la forma y los patrones', fb.formaDeFallback === forma.formaDeFallback && fb.RE_CUOTA === pat.RE_CUOTA && fb.RE_SIN_CREDITOS === pat.RE_SIN_CREDITOS && fb.RE_FALLBACK === forma.RE_FALLBACK);
    check('uso-agy reexporta cuotaDesdeRateLimit', uso.cuotaDesdeRateLimit === rl.cuotaDesdeRateLimit);
    const leer = (rel) => fs.readFileSync(path.join(MCP, rel), 'utf8');
    check('config.js y ajustes.js no cargan fallback-agy por la forma', !/require\('\.\/fallback-agy\.js'\)/.test(leer('lib/config.js')) && !/require\('\.\/fallback-agy\.js'\)/.test(leer('lib/ajustes.js')));
    check('las sondas de agy no cargan fallback-agy', !/fallback-agy\.js/.test(leer('motores/sondas-antigravity.js')));
    check('motores/claude.js no carga uso-agy', !/require\([^)]*uso-agy\.js/.test(leer('motores/claude.js')));
    check('capacidades.js es una hoja (solo carga niveles.js, otra hoja)', (leer('motores/capacidades.js').match(/require\([^)]*\)/g) || []).join() === "require('./niveles.js')" && !/require\(/.test(leer('motores/niveles.js')));
    // Los dos que ya estaban antes de FEAT-202, los dos con un require perezoso (dentro de una función). Uno nuevo
    // falla acá.
    const CONOCIDOS = [
      ['motores/claude.js', 'motores/claude-ejecutar.js'],
      ['lotes/grafo-receta.js', 'lotes/recetas.js']
    ];
    const nuevos = ciclosDeRequire(MCP).map((c) => c.split(path.sep).join('/'))
      .filter((c) => !CONOCIDOS.some((par) => c.split(' -> ').length === 3 && par.every((x) => c.includes(x))));
    check('sin ciclos de require nuevos en mcp-server/', nuevos.length === 0, nuevos.slice(0, 5).join('\n'));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
