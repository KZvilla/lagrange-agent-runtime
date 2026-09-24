/**
 * FEAT-075 — Motor, modelo y esfuerzo por alma y por agente: el rol
 * `alma:<clave>`, su precedencia en `elegir`, el catálogo que ofrece la web,
 * la escritura compartida (`fusionarMotores`, `guardarRol`) y el testigo de
 * sondas que la consola lee para mostrar "corriendo".
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const roles = require('../mcp-server/motores/roles.js');
const motores = require('../mcp-server/motores/index.js');
const niveles = require('../mcp-server/motores/niveles.js');
const { fusionarMotores, guardarRol, rutaConfigGlobal } = require('../mcp-server/motores/config-motores.js');
const sondas = require('../mcp-server/motores/sondas.js');

const lanza = (f) => { try { f(); return null; } catch (err) { return err.message; } };

async function main() {
  await group('rol alma:<clave>', () => {
    for (const r of ['alma:tm', 'alma:alya', 'alma:a-1', `alma:${'a'.repeat(64)}`]) check(`válido: ${r.slice(0, 20)}`, roles.rolValido(r));
    for (const r of ['alma:', 'alma:TM', 'alma:-x', 'alma:a_b', 'alma:a.b', `alma:${'a'.repeat(65)}`, 'almas:tm', 'alma:tm:x']) check(`inválido: ${r.slice(0, 20)}`, !roles.rolValido(r));
    const rutas = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'almas', 'rutas.js'), 'utf8');
    const m = /const CLAVE_VALIDA = \/(.+)\/;/.exec(rutas);
    check('CLAVE_VALIDA sigue declarada en rutas.js', Boolean(m));
    if (m) {
      const clave = new RegExp(m[1]);
      const bateria = ['tm', 'alya', 'a', '0x', 'a-b', '-a', 'A', 'a_b', 'a.b', '', 'a'.repeat(64), 'a'.repeat(65), 'ñandu', 'a b'];
      check('RE_ALMA ≡ alma: + CLAVE_VALIDA', bateria.every(c => clave.test(c) === roles.RE_ALMA.test(`alma:${c}`)));
    }
    const r = roles.validarRoles({ 'alma:tm': { motor: 'claude', modelo: 'sonnet', esfuerzo: 'medium' } }, { estricto: true });
    check('validarRoles lo acepta', r.ok && r.roles['alma:tm'].modelo === 'sonnet');
    const mal = roles.validarRoles({ 'alma:TM': { motor: 'claude', modelo: 'sonnet' } });
    check('el motivo nombra alma:<clave>', !mal.ok && /alma:<clave>/.test(mal.motivo));
  });

  await group('FEAT-079: rol consolidar:<clave>', () => {
    for (const r of ['consolidar:tm', 'consolidar:alya', `consolidar:${'a'.repeat(64)}`]) check(`válido: ${r.slice(0, 24)}`, roles.rolValido(r));
    for (const r of ['consolidar:', 'consolidar:TM', 'consolidar:../x', 'consolidar:a_b', `consolidar:${'a'.repeat(65)}`, 'consolidar:tm:x']) check(`inválido: ${r.slice(0, 24)}`, !roles.rolValido(r));
    const rutas = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'almas', 'rutas.js'), 'utf8');
    const m = /const CLAVE_VALIDA = \/(.+)\/;/.exec(rutas);
    if (m) {
      const clave = new RegExp(m[1]);
      const bateria = ['tm', 'alya', 'a', '0x', 'a-b', '-a', 'A', 'a_b', 'a.b', '', 'a'.repeat(64), 'a'.repeat(65), 'ñandu', 'a b'];
      check('RE_CONSOLIDAR ≡ consolidar: + CLAVE_VALIDA', bateria.every(c => clave.test(c) === roles.RE_CONSOLIDAR.test(`consolidar:${c}`)));
    }
    const mal = roles.validarRoles({ 'consolidar:TM': { motor: 'antigravity' } });
    check('el motivo nombra consolidar:<clave>', !mal.ok && /consolidar:<clave>/.test(mal.motivo));
    const config = { motores: { roles: {
      consolidar: { motor: 'claude', modelo: 'sonnet', esfuerzo: 'medium' },
      'consolidar:tm': { motor: 'claude', modelo: 'opus', esfuerzo: null }
    } } };
    const tm = motores.elegir(config, 'consolidar:tm');
    check('consolidar:tm gana y no hereda el esfuerzo', tm.motor.id === 'claude' && tm.modelo === 'opus' && tm.esfuerzo === null);
    const otra = motores.elegir(config, 'consolidar:alya');
    check('sin rol propio: el general', otra.motor.id === 'claude' && otra.modelo === 'sonnet' && otra.esfuerzo === 'medium');
    check('sin nada: antigravity', motores.elegir({}, 'consolidar:tm').motor.id === 'antigravity');
    check('alma:tm no se usa para consolidar', motores.elegir({ motores: { roles: { 'alma:tm': { motor: 'claude', modelo: 'opus' } } } }, 'consolidar:tm').motor.id === 'antigravity');
  });

  await group('elegir: precedencia por entrada completa', () => {
    const config = { motores: { roles: {
      alma: { motor: 'claude', modelo: 'sonnet', esfuerzo: 'medium' },
      'alma:tm': { motor: 'claude', modelo: 'opus', esfuerzo: null },
      'alma:gemi': { motor: 'antigravity', modelo: null, esfuerzo: null }
    } } };
    const tm = motores.elegir(config, 'alma:tm');
    check('alma:tm gana', tm.motor.id === 'claude' && tm.modelo === 'opus');
    check('no hereda el esfuerzo de alma', tm.esfuerzo === null);
    check('alma:gemi → antigravity aunque alma sea claude', motores.elegir(config, 'alma:gemi').motor.id === 'antigravity');
    const otra = motores.elegir(config, 'alma:otra');
    check('sin rol propio cae en alma', otra.motor.id === 'claude' && otra.modelo === 'sonnet' && otra.esfuerzo === 'medium');
    check('sin alma ni propio → antigravity', motores.elegir({ motores: { roles: {} } }, 'alma:x').motor.id === 'antigravity');
    check('cast:<nombre> no cae en alma', motores.elegir(config, 'cast:x').motor.id === 'antigravity');
  });

  await group('catálogo', () => {
    const c = niveles.catalogo();
    const agy = c.find(x => x.motor === 'antigravity');
    const cl = c.find(x => x.motor === 'claude');
    check('los dos motores', Boolean(agy && cl) && c.length === 2);
    check('cada modelo trae los niveles de nivelesPara', c.every(x => x.modelos.every(m => JSON.stringify(m.niveles) === JSON.stringify(niveles.nivelesPara(x.motor, m.modelo).niveles) && m.admite === niveles.nivelesPara(x.motor, m.modelo).admite)));
    check('agy ofrece "el de agy" (null) primero', agy.modelos[0].modelo === null && !agy.modelos[0].admite);
    check('claude no recomienda Haiku primero', cl.modelos[0].modelo !== 'haiku' && cl.modelos.some(m => m.modelo === 'haiku'));
    const conExtra = niveles.catalogo([{ motor: 'claude', modelo: 'claude-opus-4-6' }, { motor: 'claude', modelo: 'sonnet' }, { motor: 'antigravity', modelo: null }]);
    const clExtra = conExtra.find(x => x.motor === 'claude').modelos;
    check('un modelo guardado fuera del catálogo se suma con sus niveles', clExtra.at(-1).modelo === 'claude-opus-4-6' && !clExtra.at(-1).niveles.includes('xhigh'));
    check('sin duplicar los que ya están', clExtra.filter(m => m.modelo === 'sonnet').length === 1 && conExtra.find(x => x.motor === 'antigravity').modelos.length === agy.modelos.length);
  });

  await group('fusionarMotores', () => {
    const actual = { roles: { alma: { motor: 'claude', modelo: 'sonnet', esfuerzo: null } }, claude: { bin: 'C:\\c.exe', freno_cuota_5h: 0.9 } };
    const r = fusionarMotores(actual, { roles: { 'alma:tm': { motor: 'claude', modelo: 'opus' } } });
    check('roles reemplaza la tabla entera', Object.keys(r.roles).join() === 'alma:tm');
    check('y conserva los motores', r.claude.bin === 'C:\\c.exe' && r.claude.freno_cuota_5h === 0.9);
    check('fusiona campo a campo', fusionarMotores(actual, { claude: { freno_cuota_5h: 0.5 } }).claude.bin === 'C:\\c.exe');
    check('bin solo en claude', /solo aplica/.test(lanza(() => fusionarMotores({}, { antigravity: { bin: 'x' } }))));
    check('freno fuera de rango', /va de 0 a 1/.test(lanza(() => fusionarMotores({}, { claude: { freno_cuota_5h: 2 } }))));
    check('clave desconocida', /clave desconocida/.test(lanza(() => fusionarMotores({}, { codex: {} }))));
    check('estricto: Pro con medium se rechaza', /no admite el esfuerzo/.test(lanza(() => fusionarMotores({}, { roles: { alma: { motor: 'antigravity', modelo: 'gemini-3.1-pro', esfuerzo: 'medium' } } }))));
    check('no es un objeto', /tiene que ser un objeto/.test(lanza(() => fusionarMotores({}, []))));
    check('no toca el original', Object.keys(actual.roles).join() === 'alma');
  });

  await group('guardarRol', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat075-'));
    const ruta = rutaConfigGlobal(home);
    const leer = () => JSON.parse(fs.readFileSync(ruta, 'utf8'));
    try {
      const nuevo = guardarRol('alma:tm', { motor: 'claude', modelo: 'sonnet', esfuerzo: 'medium' }, { homeDir: home });
      check('sin archivo: lo crea', nuevo.ok && leer().motores.roles['alma:tm'].modelo === 'sonnet');

      fs.writeFileSync(ruta, JSON.stringify({ model: 'gemini-3.8-flash', voicebox_url: 'http://x', motores: { roles: { alma: { motor: 'antigravity' } }, claude: { bin: 'C:\\c.exe' } } }, null, 2));
      const r = guardarRol('cast:revisor', { motor: 'claude', modelo: 'haiku' }, { homeDir: home });
      const d = leer();
      check('agrega un rol', r.ok && d.motores.roles['cast:revisor'].modelo === 'haiku');
      check('conserva los demás roles', d.motores.roles.alma.motor === 'antigravity');
      check('conserva el resto del archivo', d.model === 'gemini-3.8-flash' && d.voicebox_url === 'http://x' && d.motores.claude.bin === 'C:\\c.exe');

      check('reemplaza', guardarRol('cast:revisor', { motor: 'antigravity', modelo: 'gemini-3.1-pro', esfuerzo: 'high' }, { homeDir: home }).ok && leer().motores.roles['cast:revisor'].esfuerzo === 'high');
      check('quita con null', guardarRol('cast:revisor', null, { homeDir: home }).ok && !('cast:revisor' in leer().motores.roles));

      const antes = fs.readFileSync(ruta, 'utf8');
      const haiku = guardarRol('alma:tm', { motor: 'claude', modelo: 'haiku', esfuerzo: 'high' }, { homeDir: home });
      check('Haiku con esfuerzo: rechazo con motivo', !haiku.ok && /no admite esfuerzo/.test(haiku.motivo));
      const pro = guardarRol('alma:tm', { motor: 'antigravity', modelo: 'gemini-3.1-pro', esfuerzo: 'medium' }, { homeDir: home });
      check('Pro con medium: rechazo', !pro.ok && /admite: low, high/.test(pro.motivo));
      check('claude sin modelo: rechazo', !guardarRol('alma:tm', { motor: 'claude' }, { homeDir: home }).ok);
      check('rol inválido: rechazo', !guardarRol('alma:TM', { motor: 'antigravity' }, { homeDir: home }).ok);
      check('el archivo quedó intacto', fs.readFileSync(ruta, 'utf8') === antes);

      // Un esfuerzo guardado a mano que hoy no valida no bloquea editar otro sujeto.
      fs.writeFileSync(ruta, JSON.stringify({ motores: { roles: { alma: { motor: 'claude', modelo: 'haiku', esfuerzo: 'high' } } } }));
      const otro = guardarRol('alma:tm', { motor: 'antigravity' }, { homeDir: home });
      check('lo guardado se normaliza como en la carga', otro.ok && leer().motores.roles.alma.esfuerzo === null && leer().motores.roles['alma:tm'].motor === 'antigravity');

      fs.writeFileSync(ruta, '{ roto');
      const roto = guardarRol('alma:tm', { motor: 'antigravity' }, { homeDir: home });
      check('JSON roto: no escribe', !roto.ok && /no se puede leer/.test(roto.motivo) && fs.readFileSync(ruta, 'utf8') === '{ roto');
      check('y no lo aparta', fs.readdirSync(path.dirname(ruta)).every(f => !/corrupto/.test(f)));
      fs.writeFileSync(ruta, '[1,2]');
      check('JSON que no es objeto: no escribe', !guardarRol('alma:tm', { motor: 'antigravity' }, { homeDir: home }).ok && fs.readFileSync(ruta, 'utf8') === '[1,2]');
      check('sin temporales sobrantes', fs.readdirSync(path.dirname(ruta)).every(f => !/\.tmp-/.test(f)));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await group('sondas.corriendo', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat075-sondas-'));
    try {
      check('sin testigo: no', !sondas.corriendo('claude', { homeDir: home }));
      check('con testigo fresco: sí', sondas.tomarTestigo('claude', { homeDir: home }) && sondas.corriendo('claude', { homeDir: home }));
      check('solo del motor pedido', !sondas.corriendo('antigravity', { homeDir: home }));
      check('abandonado (más viejo que el vencimiento): no', !sondas.corriendo('claude', { homeDir: home, ahora: Date.now() + sondas.TESTIGO_VENCE_MS + 1000 }));
      sondas.soltarTestigo('claude', home);
      check('soltado: no', !sondas.corriendo('claude', { homeDir: home }));
      const ctx = require('../mcp-server/motores/sondas-claude.js').crearContextoSondas({ homeDir: home, obtenerBin: () => ({ ok: false, motivo: 'test' }) });
      check('el contexto de claude lo expone', typeof ctx.corriendo === 'function' && ctx.corriendo() === false);
      let resoluciones = 0;
      const contado = require('../mcp-server/motores/sondas-claude.js').crearContextoSondas({ homeDir: home, obtenerBin: () => { resoluciones++; return { ok: false, motivo: 'test' }; } });
      const conHuella = await contado.leerSondas('lectura', { huella: { versionCli: '1', versionLagrange: '1' } });
      check('leerSondas con huella dada no resuelve el binario', resoluciones === 0 && /todavía no se verificó/.test(conHuella.motivo));
      await contado.leerSondas('lectura');
      check('sin huella la calcula, como antes', resoluciones === 1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  report();
}

main().catch(err => { console.error(err); process.exit(1); });
