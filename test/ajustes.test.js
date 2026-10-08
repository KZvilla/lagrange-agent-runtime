/**
 * FEAT-134 — Ajustes: el escritor validado de la configuración global
 * (`mcp-server/lib/ajustes.js`), `saveConfig`/`guardarRol` bajo el mismo lock
 * y sin pisar un JSON roto, y las rutas locales de la consola (sesión, origen,
 * tope de cuerpo, nunca por nodo, sin nivel de RPC).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');

const ajustes = require('../mcp-server/lib/ajustes.js');
const configMotores = require('../mcp-server/motores/config-motores.js');
const { conLock } = require('../mcp-server/almas/archivos.js');

const BRIDGE = path.join(__dirname, '..', 'telegram-bridge');
const imp = (f) => import(pathToFileURL(path.join(BRIDGE, f)).href);

function homeNuevo(contenido) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ajustes-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (contenido !== undefined) fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2));
  return home;
}
const archivo = (home) => path.join(home, '.claude', 'antigravity.json');
const leer = (home) => JSON.parse(fs.readFileSync(archivo(home), 'utf8'));

const BASE = {
  model: 'gemini-3.8-flash',
  guardas: { algo: true },
  identidad_sesion: {
    principal: { nombre: 'Spica', emblema: '✦', color: 'cian', extra: 'se conserva', voz: { es: 'Spica', en: 'EN Spica', idioma: 'es' } }
  },
  motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } } },
  voice_setup: {
    version: 3, status: 'configured', languages: ['es', 'en'], default_language: 'es',
    defaults: { es: { audio: { profile: 'Priscilla', provider: 'omnivoice' }, identity: { mode: 'neutral' } }, en: { audio: { profile: 'Emily', provider: 'omnivoice' }, identity: { mode: 'neutral' } } },
    fallbacks: { es: [], en: [] }
  },
  voz_por_perfil: { Nyotengu: 'voicebox' }
};

async function main() {
  await group('leerAjustes', () => {
    const home = homeNuevo(BASE);
    const e = ajustes.leerAjustes({ homeDir: home });
    check('lee', e.ok, e.error);
    check('principal y trabajo son las cuentas', e.cuentas.map((c) => c.cuenta).join(',') === 'principal,trabajo');
    check('trabajo sin identidad → null', e.identidades.trabajo === null);
    check('identidad normalizada', e.identidades.principal.nombre === 'Spica' && e.identidades.principal.voz.en === 'EN Spica');
    check('una versión por sección', ['identidades', 'voz', 'motores'].every((k) => /^[0-9a-f]{16}$/.test(e.versiones[k])));
    check('colores del statusline', e.colores.nombres.includes('cian') && e.colores.nombres.includes('magenta') && e.colores.css.cian);
    check('la ruta del archivo viaja', e.ruta === archivo(home));
    // BE-117 — El panel valida con lo que manda el servidor, no con constantes propias.
    check('límites del escritor', e.limites.nombre === 24 && e.limites.emblema === 2 && e.limites.perfil === 128 && e.limites.idiomas.join() === 'es,en' && e.limites.proveedores.join() === 'omnivoice,voicebox', JSON.stringify(e.limites));
    const modelo = (motor, m) => (e.catalogo.find((c) => c.motor === motor) || { modelos: [] }).modelos.find((x) => x.modelo === m);
    check('catálogo de motores: agy y claude', e.catalogo.map((c) => c.motor).join() === 'antigravity,claude');
    check('Haiku 4.5 no ofrece esfuerzo; Haiku 5.5 y Sonnet sí (BE-120)', modelo('claude', 'claude-haiku-4-5') && !modelo('claude', 'claude-haiku-4-5').admite && modelo('claude', 'haiku').niveles.includes('low') && modelo('claude', 'claude-haiku-5-5').admite && modelo('claude', 'sonnet').niveles.includes('high'));
    const aMano = homeNuevo({ ...BASE, motores: { ...BASE.motores, roles: { alma: { motor: 'claude', modelo: 'claude-sonnet-4-9' } } } });
    check('un modelo guardado a mano se sigue viendo', Boolean(ajustes.leerAjustes({ homeDir: aMano }).catalogo.find((c) => c.motor === 'claude').modelos.find((x) => x.modelo === 'claude-sonnet-4-9')));
    removeFixture(aMano);
    const roto = homeNuevo({ ...BASE, voice_setup: { version: 9 }, motores: { roles: { alma: { motor: 'xx' } }, cuentas: {} } });
    const r = ajustes.leerAjustes({ homeDir: roto });
    check('una sección rota no tumba la lectura', r.ok && r.avisos.voz.length > 0 && r.avisos.motores.length > 0, JSON.stringify(r.avisos));
    const ilegible = homeNuevo('{ esto no es json');
    check('archivo ilegible → 422', ajustes.leerAjustes({ homeDir: ilegible }).codigo === 422);
    for (const h of [home, roto, ilegible]) removeFixture(h);
  });

  await group('guardarAjustes: identidades', () => {
    const home = homeNuevo(BASE);
    const v = () => ajustes.leerAjustes({ homeDir: home }).versiones;
    let r = ajustes.guardarAjustes({ identidades: { versionSeccion: v().identidades, cuentas: { trabajo: { nombre: 'Epikouros', emblema: '☘', color: 'verde', voz: { es: 'Epikouros', en: null, idioma: 'es' } } } } }, { homeDir: home });
    check('crea la identidad de trabajo', r.ok && leer(home).identidad_sesion.trabajo.nombre === 'Epikouros', JSON.stringify(r));
    const d = leer(home);
    check('claves ajenas intactas (model, guardas, extra)', d.model === BASE.model && d.guardas.algo === true && d.identidad_sesion.principal.extra === 'se conserva');
    check('voz sin el idioma vaciado', !('en' in d.identidad_sesion.trabajo.voz));
    check('backup del archivo anterior', fs.existsSync(`${archivo(home)}.bak-ajustes`));

    const casos = [
      [{ principal: { nombre: '' } }, 'identidades.principal.nombre', 'nombre vacío'],
      [{ principal: { nombre: 'x'.repeat(25) } }, 'identidades.principal.nombre', 'nombre largo'],
      [{ principal: { nombre: 'Epikouros' } }, 'identidades.principal.nombre', 'nombre repetido (al campo de la cuenta editada)'],
      [{ principal: { emblema: 'abc' } }, 'identidades.principal.emblema', 'emblema de 3'],
      [{ principal: { color: 'violeta' } }, 'identidades.principal.color', 'color que no es del statusline'],
      [{ principal: { voz: { es: 'a\u0007b' } } }, 'identidades.principal.voz.es', 'perfil con control'],
      [{ principal: { voz: { idioma: 'fr' } } }, 'identidades.principal.voz.idioma', 'idioma fr'],
      [{ principal: { otra: 1 } }, 'identidades.principal.otra', 'clave desconocida'],
      [{ nadie: { nombre: 'X' } }, 'identidades.nadie', 'cuenta que no existe']
    ];
    for (const [cuentas, campo, nombre] of casos) {
      const antes = fs.readFileSync(archivo(home), 'utf8');
      r = ajustes.guardarAjustes({ identidades: { versionSeccion: v().identidades, cuentas } }, { homeDir: home });
      check(`${nombre} → 400 en ${campo}, sin escribir`, !r.ok && r.codigo === 400 && r.campo === campo && fs.readFileSync(archivo(home), 'utf8') === antes, JSON.stringify(r));
    }
    for (const color of ['MAGENTA', '#12ab34', 200]) {
      r = ajustes.guardarAjustes({ identidades: { versionSeccion: v().identidades, cuentas: { principal: { color } } } }, { homeDir: home });
      check(`color ${JSON.stringify(color)} válido`, r.ok, JSON.stringify(r));
    }
    r = ajustes.guardarAjustes({ identidades: { versionSeccion: v().identidades, cuentas: { principal: { color: null, emblema: null } } } }, { homeDir: home });
    check('null quita color y emblema', r.ok && !('color' in leer(home).identidad_sesion.principal) && !('emblema' in leer(home).identidad_sesion.principal));
    removeFixture(home);
  });

  await group('guardarAjustes: versiones, todo o nada', () => {
    const home = homeNuevo(BASE);
    const e = ajustes.leerAjustes({ homeDir: home });
    // Otro proceso cambia `model` (fuera de las secciones): no da 409.
    const d = leer(home); d.model = 'otro'; fs.writeFileSync(archivo(home), JSON.stringify(d));
    let r = ajustes.guardarAjustes({ identidades: { versionSeccion: e.versiones.identidades, cuentas: { principal: { nombre: 'Spica2' } } } }, { homeDir: home });
    check('un cambio ajeno a la sección no da 409', r.ok, JSON.stringify(r));
    // Otro proceso cambia la voz: guardar la voz con la versión vieja da 409.
    const d2 = leer(home); d2.voz_por_perfil = { Emily: 'omnivoice' }; fs.writeFileSync(archivo(home), JSON.stringify(d2));
    r = ajustes.guardarAjustes({ voz: { versionSeccion: e.versiones.voz, voz_por_perfil: null } }, { homeDir: home });
    check('versión vieja de la sección → 409 con conflictos y estado', !r.ok && r.codigo === 409 && r.conflictos.includes('voz') && r.estado && r.estado.ok, JSON.stringify({ c: r.codigo, k: r.conflictos }));
    check('… y no escribió', leer(home).voz_por_perfil.Emily === 'omnivoice');
    // Todo o nada: identidades válidas + voz inválida → nada escrito.
    const v = ajustes.leerAjustes({ homeDir: home }).versiones;
    const antes = fs.readFileSync(archivo(home), 'utf8');
    r = ajustes.guardarAjustes({
      identidades: { versionSeccion: v.identidades, cuentas: { principal: { nombre: 'Cambiado' } } },
      voz: { versionSeccion: v.voz, voz_por_perfil: { Emily: 'kokoro' } }
    }, { homeDir: home });
    check('una sección inválida → nada escrito', !r.ok && r.codigo === 400 && r.campo === 'voz.voz_por_perfil' && fs.readFileSync(archivo(home), 'utf8') === antes, JSON.stringify(r));
    r = ajustes.guardarAjustes({ voz: { versionSeccion: v.voz, voz_por_perfil: { emily: 'voicebox', Emily: 'omnivoice' } } }, { homeDir: home });
    check('voz_por_perfil con claves repetidas → 400', !r.ok && r.codigo === 400);
    r = ajustes.guardarAjustes({ voz: { versionSeccion: v.voz, voice_setup: { version: 3, status: 'configured' } } }, { homeDir: home });
    check('voice_setup inválido → 400', !r.ok && r.codigo === 400 && r.campo === 'voz.voice_setup');
    r = ajustes.guardarAjustes({ otra: {} }, { homeDir: home });
    check('sección desconocida → 400', !r.ok && r.codigo === 400);
    const sin = ajustes.guardarAjustes({ voz: { versionSeccion: v.voz } }, { homeDir: home });
    check('sin cambios reales → ok sin escribir', sin.ok && sin.sinCambios === true);
    const ilegible = homeNuevo('{ roto');
    r = ajustes.guardarAjustes({ voz: { versionSeccion: 'x' } }, { homeDir: ilegible });
    check('archivo ilegible → 422 y no se toca', !r.ok && r.codigo === 422 && fs.readFileSync(archivo(ilegible), 'utf8') === '{ roto');
    removeFixture(home); removeFixture(ilegible);
  });

  await group('guardarAjustes: motores', () => {
    const home = homeNuevo(BASE);
    const v = () => ajustes.leerAjustes({ homeDir: home }).versiones;
    const permitidos = new Set(['alma:alya', 'cast:revisor']);
    let r = ajustes.guardarAjustes({ motores: { versionSeccion: v().motores, roles: { alma: { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' }, 'alma:alya': { motor: 'antigravity' } }, fallback_agy: 'claude@trabajo' } }, { homeDir: home, rolesPermitidos: permitidos });
    check('guarda roles y fallback', r.ok && leer(home).motores.roles.alma.motor === 'claude' && leer(home).fallback_agy === 'claude@trabajo', JSON.stringify(r));
    check('devuelve los roles que quedaron en claude (para las sondas)', r.cambiadosClaude.length === 1 && r.cambiadosClaude[0].rol === 'alma' && r.cambiadosClaude[0].cuenta === 'trabajo');
    check('las cuentas no se tocan', leer(home).motores.cuentas.trabajo.configDir === '~/.claude-work');
    r = ajustes.guardarAjustes({ motores: { versionSeccion: v().motores, roles: { 'alma:alya': { motor: 'antigravity' } } } }, { homeDir: home, rolesPermitidos: permitidos });
    check('un rol que falta en la tabla se quita', r.ok && !('alma' in leer(home).motores.roles));
    r = ajustes.guardarAjustes({ motores: { versionSeccion: v().motores, roles: { 'alma:inexistente': { motor: 'antigravity' } } } }, { homeDir: home, rolesPermitidos: permitidos });
    check('rol no editable → 400', !r.ok && r.codigo === 400 && r.campo === 'motores.roles.alma:inexistente');
    r = ajustes.guardarAjustes({ motores: { versionSeccion: v().motores, roles: { alma: { motor: 'claude' } } } }, { homeDir: home, rolesPermitidos: permitidos });
    check('claude sin modelo → 400 (la validación de roles.js)', !r.ok && r.codigo === 400);
    r = ajustes.guardarAjustes({ motores: { versionSeccion: v().motores, fallback_agy: 'claude@otra' } }, { homeDir: home });
    check('fallback a una cuenta que no existe → 400', !r.ok && r.campo === 'motores.fallback_agy');
    removeFixture(home);
  });

  await group('auditoría de la implementación: casos que faltaban', () => {
    const home = homeNuevo({ ...BASE, motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } }, roles: { 'alma:vieja': { motor: 'antigravity' }, alma: { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' } } } });
    const v = () => ajustes.leerAjustes({ homeDir: home }).versiones;
    const permitidos = new Set(['alma:alya']);
    let r = ajustes.guardarAjustes({ motores: { versionSeccion: v().motores, roles: { 'alma:vieja': { motor: 'antigravity' }, alma: { motor: 'claude', modelo: 'sonnet', esfuerzo: null, cuenta: null } } } }, { homeDir: home, rolesPermitidos: permitidos });
    check('M2: volver un rol claude a la cuenta principal (cuenta: null) se guarda', r.ok && !leer(home).motores.roles.alma.cuenta, JSON.stringify(r));
    check('MINOR-1: un rol guardado que ya no es editable (alma:vieja) no bloquea el resto', r.ok && leer(home).motores.roles['alma:vieja'].motor === 'antigravity');
    r = ajustes.guardarAjustes({ motores: { versionSeccion: v().motores, roles: { 'alma:vieja': { motor: 'antigravity' }, alma: { motor: 'claude', modelo: 'sonnet' } } } }, { homeDir: home, rolesPermitidos: permitidos });
    check('M2: un rol sin la clave cuenta también queda sin cuenta', r.ok && !leer(home).motores.roles.alma.cuenta);
    removeFixture(home);

    const legado = homeNuevo({ ...BASE, identidad_sesion: { principal: { nombre: 'Spica', color: 'violeta' } }, voice_setup: { version: 9 }, voz_por_perfil: null });
    const vl = ajustes.leerAjustes({ homeDir: legado }).versiones;
    r = ajustes.guardarAjustes({ identidades: { versionSeccion: vl.identidades, cuentas: { principal: { nombre: 'Spica', color: 'violeta', voz: { es: 'Spica', en: null, idioma: null } } } } }, { homeDir: legado });
    check('MINOR-3: un color viejo que no se tocó no bloquea editar la voz', r.ok && leer(legado).identidad_sesion.principal.color === 'violeta' && leer(legado).identidad_sesion.principal.voz.es === 'Spica', JSON.stringify(r));
    r = ajustes.guardarAjustes({ voz: { versionSeccion: ajustes.leerAjustes({ homeDir: legado }).versiones.voz, voice_setup: { version: 9 }, voz_por_perfil: { Emily: 'voicebox' } } }, { homeDir: legado });
    check('MINOR-3: un voice_setup roto que no se tocó no bloquea voz_por_perfil', r.ok && leer(legado).voz_por_perfil.Emily === 'voicebox' && leer(legado).voice_setup.version === 9, JSON.stringify(r));
    removeFixture(legado);

    const nulo = homeNuevo('null');
    r = ajustes.guardarAjustes({ voz: { versionSeccion: 'x' } }, { homeDir: nulo });
    check('MINOR-4: un archivo con el literal null no se pisa', !r.ok && r.codigo === 422 && fs.readFileSync(archivo(nulo), 'utf8') === 'null', JSON.stringify(r));
    check('MINOR-4: guardarRol tampoco lo pisa', !configMotores.guardarRol('alma', { motor: 'antigravity' }, { homeDir: nulo }).ok && fs.readFileSync(archivo(nulo), 'utf8') === 'null');
    removeFixture(nulo);
    const vacio = homeNuevo('   ');
    check('un archivo vacío sí se puede escribir', configMotores.guardarRol('alma', { motor: 'antigravity' }, { homeDir: vacio }).ok);
    removeFixture(vacio);
  });

  await group('cliente: la vista de Ajustes (FEAT-136: componente en ui/vista-ajustes.js)', () => {
    const vista = fs.readFileSync(path.join(BRIDGE, 'web', 'public', 'ui', 'vista-ajustes.js'), 'utf8');
    const js = fs.readFileSync(path.join(BRIDGE, 'web', 'public', 'app.js'), 'utf8');
    check('la vista de Ajustes existe', /export function VistaAjustes\(/.test(vista) && vista.length > 1000);
    check('sin atributos style en texto (style-src self): solo objetos por CSSOM', !/style=\$\{[`'"]/.test(vista) && !/style="/.test(vista));
    check('sin innerHTML', !/innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/.test(vista));
    check('Probar en una ruta manda el motor de la fila', vista.includes('probar({ perfil: ruta.profile, idioma, proveedor: ruta.provider })'));
    // Prueba en vivo (2026-10-07): un `const proveedor` en el cuerpo tapaba el
    // parámetro y daba "Cannot access 'proveedor' before initialization".
    const probar = js.slice(js.indexOf('async function probarVozAjustes('), js.indexOf('\n  }\n', js.indexOf('async function probarVozAjustes(')));
    const params = ((/async function probarVozAjustes\(\{([^}]*)\}\)/.exec(probar) || [, ''])[1]).split(',').map((p) => p.split('=')[0].trim()).filter(Boolean);
    check('probarVozAjustes no redeclara sus parámetros', params.length === 4 && params.every((p) => !new RegExp(`\b(const|let)\s+${p}\b`).test(probar)), params.join(','));
    // Y un parámetro `voz` tapaba el estado del reproductor: "Cannot create property 'tareaId' on string".
    check('ningún parámetro tapa el estado compartido (voz, ajustes)', params.every((p) => !['voz', 'ajustes'].includes(p)), params.join(','));
  });

  await group('cliente: el foco sobrevive (BE-116, ahora sin parches: inputs controlados)', () => {
    const vista = fs.readFileSync(path.join(BRIDGE, 'web', 'public', 'ui', 'vista-ajustes.js'), 'utf8');
    const js = fs.readFileSync(path.join(BRIDGE, 'web', 'public', 'app.js'), 'utf8');
    check('sin recordarFoco/devolverFoco: Preact conserva los nodos', !/(recordarFoco|devolverFoco)\(/.test(vista + js));
    check('el campo con error se enfoca una sola vez', /enfocarError = false; n\.focus/.test(vista));
    check('un error de guardado pide el foco', /enfocarError = Boolean\(info\.campo\)/.test(vista));
    const texto = vista.split('\n').filter((l) => /campo\(c\('(nombre|emblema|color)'\)/.test(l) && /<input /.test(l));
    check('nombre, emblema y hex se editan en el borrador al escribir', texto.length === 3 && texto.every((l) => /onInput=\$\{/.test(l) && /editar\(/.test(l)), String(texto.length));
  });

  await group('cliente: BE-117 sin constantes de validación propias', () => {
    const vista = fs.readFileSync(path.join(BRIDGE, 'web', 'public', 'ui', 'vista-ajustes.js'), 'utf8');
    check('sin lista propia de modelos', !/MODELOS_MOTOR/.test(vista) && /modelosDeMotor\(r\.motor\)/.test(vista));
    check('sin esfuerzos fijos', !/'low', 'medium', 'high'/.test(vista));
    check('topes de nombre y emblema del servidor', !/maxlength="(24|4)"/.test(vista) && /maxlength=\$\{String\(lim\.nombre\)\}/.test(vista) && !/hasta 2 caracteres/.test(vista));
    check('idiomas y motores de voz del servidor', !/\['omnivoice', 'OmniVoice'\]/.test(vista) && !/=== 'es' \? 'Español' : 'Inglés'/.test(vista) && /limites\(\)\.proveedores/.test(vista));
  });

  await group('lock: sin anidar y con espera', () => {
    const home = homeNuevo(BASE);
    // El lock tomado por otro: guardar espera y, al vencer, 503 sin escribir.
    const antes = fs.readFileSync(archivo(home), 'utf8');
    const r = conLock(archivo(home), () => ajustes.guardarAjustes({ voz: { versionSeccion: 'x', voz_por_perfil: null } }, { homeDir: home }));
    check('con el lock tomado → 503 (no cuelga ni pisa)', !r.ok && r.codigo === 503 && fs.readFileSync(archivo(home), 'utf8') === antes, JSON.stringify(r));
    const g = conLock(archivo(home), () => configMotores.guardarRol('alma', { motor: 'antigravity' }, { homeDir: home }));
    check('guardarRol con el lock tomado → error con motivo', !g.ok && /Otro proceso/.test(g.motivo));
    check('guardarRol sin contención anda', configMotores.guardarRol('alma', { motor: 'claude', modelo: 'sonnet' }, { homeDir: home }).ok);
    const ilegible = homeNuevo('[1, 2]');
    const gr = configMotores.guardarRol('alma', { motor: 'antigravity' }, { homeDir: ilegible });
    check('guardarRol con un JSON que no es objeto → no se pisa', !gr.ok && fs.readFileSync(archivo(ilegible), 'utf8') === '[1, 2]');
    removeFixture(home); removeFixture(ilegible);
  });

  await group('saveConfig (set_config) no pisa un JSON roto', async () => {
    for (const roto of ['{ no es json', '[1, 2]', '"texto"']) {
      const home = homeNuevo(roto);
      const server = startServer({ cwd: home, env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: null } });
      try {
        await server.initialize();
        const r = await server.callTool('set_config', { model: 'gemini-3.8-flash' });
        const texto = r.result?.content?.[0]?.text || '';
        check(`${JSON.stringify(roto.slice(0, 8))} → error y archivo intacto`, r.result?.isError && /no se modifica|no se puede leer|no es un objeto/.test(texto) && fs.readFileSync(archivo(home), 'utf8') === roto, texto);
      } finally {
        await server.stop();
        removeFixture(home);
      }
    }
    const home = homeNuevo(BASE);
    const server = startServer({ cwd: home, env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: null } });
    try {
      await server.initialize();
      const r = await server.callTool('set_config', { effort: 'low' });
      check('set_config normal sigue andando y conserva el resto', !r.result?.isError && leer(home).effort === 'low' && leer(home).identidad_sesion.principal.extra === 'se conserva');
    } finally {
      await server.stop();
      removeFixture(home);
    }
  });

  // ── Rutas web ─────────────────────────────────────────────────────────
  const srv = await imp('web/servidor.js');
  const { crearCanalWeb, CHAT_WEB_LOCAL } = await imp('web/canal.js');
  await group('rutas: fuera del RPC de nodos', () => {
    const metodos = ['ajustes', 'guardarAjustes', 'perfilesAjustes', 'probarVoz'];
    check('ningún método de Ajustes tiene nivel (un nodo nunca lo ejecuta)', metodos.every((m) => srv.nivelDe(m) === null));
    check('ninguno está en metodosPermitidos', metodos.every((m) => !srv.metodosPermitidos().has(m)));
    check('ni en NIVEL_DE_MUTACION', metodos.every((m) => !Object.hasOwn(srv.NIVEL_DE_MUTACION, m)));
  });

  await group('rutas: sesión, origen, tope y nodo', async () => {
    const TOKEN = 'a'.repeat(48);
    const llamadas = [];
    const nucleo = {
      canal: crearCanalWeb(), chatId: CHAT_WEB_LOCAL,
      ajustes: async () => ({ ok: true, versiones: {} }),
      perfilesAjustes: async () => ({ ok: true, perfiles: [] }),
      guardarAjustes: async (c) => { llamadas.push(c); return { ok: true }; },
      probarVoz: async () => ({ binario: Buffer.from('RIFFxxxx'), tipo: 'audio/wav', cabeceras: { 'x-lagrange-perfil': 'Spica', 'x-lagrange-proveedor': 'omnivoice', 'x-otra': 'no' } })
    };
    const web = srv.crearServidorWeb({ nucleo, token: TOKEN });
    const base = await new Promise((r) => web.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${web.address().port}`)));
    const pedir = (ruta, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve) => {
      const req = http.request(new URL(ruta, base), { method, headers }, (res) => {
        const partes = [];
        res.on('data', (d) => partes.push(d));
        res.on('end', () => { const buf = Buffer.concat(partes); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {} resolve({ status: res.statusCode, json, buf, h: res.headers }); });
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.end(body || undefined);
    });
    const conSesion = { 'x-lagrange-token': TOKEN };
    const json = { ...conSesion, 'content-type': 'application/json' };
    try {
      check('GET sin sesión → 401', (await pedir('/api/ajustes')).status === 401);
      check('GET con sesión → 200', (await pedir('/api/ajustes', { headers: conSesion })).status === 200);
      check('POST sin sesión → 401', (await pedir('/api/ajustes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401);
      check('POST con Origin ajeno → 403', (await pedir('/api/ajustes', { method: 'POST', headers: { ...json, origin: 'https://malo.example' }, body: '{}' })).status === 403);
      check('POST cross-site → 403', (await pedir('/api/ajustes', { method: 'POST', headers: { ...json, 'sec-fetch-site': 'cross-site' }, body: '{}' })).status === 403);
      check('POST con cuerpo enorme → 413', (await pedir('/api/ajustes', { method: 'POST', headers: json, body: JSON.stringify({ x: 'y'.repeat(70 * 1024) }) })).status === 413);
      check('POST válido llega al núcleo', (await pedir('/api/ajustes', { method: 'POST', headers: json, body: '{"voz":{}}' })).status === 200 && llamadas.length === 1);
      check('/api/n/<nodo>/ajustes → 404', (await pedir('/api/n/otro/ajustes', { headers: conSesion })).status === 404);
      check('/api/n/local/ajustes → 404', (await pedir('/api/n/local/ajustes', { headers: conSesion })).status === 404);
      check('/api/n/x/ajustes/probar-voz → 404', (await pedir('/api/n/x/ajustes/probar-voz', { method: 'POST', headers: json, body: '{}' })).status === 404);
      const p = await pedir('/api/ajustes/probar-voz', { method: 'POST', headers: json, body: '{"voz":"Spica"}' });
      check('probar-voz devuelve audio/wav con sus cabeceras x-lagrange-*', p.status === 200 && /audio\/wav/.test(p.h['content-type']) && p.h['x-lagrange-perfil'] === 'Spica' && p.h['x-lagrange-proveedor'] === 'omnivoice', JSON.stringify(p.h));
      check('… y solo cabeceras x-lagrange-*', p.h['x-otra'] === undefined);
      check('/ajustes es una ruta de la consola', (await pedir('/ajustes', { headers: conSesion })).status === 200);
    } finally {
      await new Promise((r) => web.close(r));
    }
  });

  await group('núcleo: probar-voz y perfiles', async () => {
    const { crearNucleoWeb } = await imp('web/nucleo.js');
    let pruebas = 0;
    const nucleo = crearNucleoWeb({
      canal: crearCanalWeb(),
      bot: { probarVoz: async () => { pruebas++; return { ok: true, audio: Buffer.from('x'), perfil: 'Spica', proveedor: 'omnivoice', preferencia: { proveedor: 'voicebox', cumplida: false, motivo: 'model_not_downloaded' } }; }, almasDisponibles: () => [] },
      almas: {}, workspaces: () => [], ultimoWorkspace: () => null, logs: () => ({}), sesiones: () => ({}),
      ajustes: { leer: () => ({ ok: true }), guardar: () => ({ ok: true }), perfiles: async () => ({ ok: true, perfiles: [{ nombre: 'Spica' }] }), validarVozPorPerfil: ajustes.validarVozPorPerfil, pisadoPorProyecto: () => [] }
    });
    let r = await nucleo.probarVoz({ voz: '' });
    check('sin voz → 400', r.codigo === 400);
    r = await nucleo.probarVoz({ voz: 'Spica', vozPorPerfil: { Spica: 'kokoro' } });
    check('borrador de voz_por_perfil inválido → 400', r.codigo === 400);
    r = await nucleo.probarVoz({ voz: 'Spica', idioma: 'en' });
    check('suena: binario y preferencia en cabecera', Buffer.isBuffer(r.binario) && decodeURIComponent(r.cabeceras['x-lagrange-preferencia']) === 'voicebox:no:model_not_downloaded', JSON.stringify(r.cabeceras));
    r = await nucleo.probarVoz({ voz: 'Spica' });
    check('dos seguidas → 429', r.codigo === 429 && pruebas === 1);
    const p1 = await nucleo.perfilesAjustes();
    const p2 = await nucleo.perfilesAjustes();
    check('perfiles cacheados', p1 === p2 && p1.perfiles.length === 1);
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
