/**
 * BE-071 — Resultados de sondas por versión de Lagrange.
 *
 * Con dos instalaciones en versiones distintas (0.67.3 en una cuenta, 0.67.4 en otra), el
 * archivo de resultados guardaba una sola entrada por motor y perfil y cada versión invalidaba
 * la de la otra. Ahora las versiones nuevas también escriben un archivo por motor, versión y
 * perfil (auxiliar), y `vigencia` lo consulta con la misma comparación completa de la huella
 * (SEC-018). Todo lo que se escribe va a un home temporal.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { check, group, report } = require('./lib/assert');
const sondas = require('../mcp-server/motores/sondas.js');
const { leerJson, guardarJson } = require('../mcp-server/agents/almacen.js');

const SONDAS_JS = path.join(__dirname, '..', 'mcp-server', 'motores', 'sondas.js');
const borrar = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };
const nuevoHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'be071-home-'));
const huella = (versionLagrange, versionCli = '2.1.284') => ({ versionCli, versionLagrange });
const entrada = (h, resultado = 'pasa', fecha = '2026-09-20T10:00:00.000Z') => ({ huella: h, resultado, motivo: resultado === 'pasa' ? null : 'C1: falló', sondas: {}, fecha });
const A = '0.67.3';
const B = '0.67.4';
const M = 'claude@trabajo';
const P = 'sin-tools';

/** El cuerpo de `guardarResultado` de las versiones anteriores a BE-071: lee, cambia una clave, reescribe todo. */
function escritorViejo(motor, perfil, e, homeDir) {
  const ruta = sondas.rutaResultados(homeDir);
  const { datos, ilegible } = leerJson(ruta);
  const todo = datos && typeof datos === 'object' ? datos : {};
  todo[motor] = { ...(todo[motor] || {}), [perfil]: e };
  guardarJson(ruta, todo, { ilegible });
}

/** Escribe una entrada del auxiliar tal cual, como la dejaría un corte a mitad de guardado. */
function ponerAux(home, motor, version, perfil, contenido) {
  const ruta = sondas.rutaEntradaPorVersion(motor, version, perfil, home);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, typeof contenido === 'string' ? contenido : JSON.stringify(contenido));
  return ruta;
}
const versionesDe = (home, motor) => {
  try { return fs.readdirSync(path.join(sondas.rutaResultadosPorVersion(home), encodeURIComponent(motor))).sort(); } catch { return []; }
};
const legible = (ruta) => { try { JSON.parse(fs.readFileSync(ruta, 'utf8')); return true; } catch { return false; } };

const lockDe = (home) => `${sondas.rutaResultados(home)}.lock`;
const ponerLock = (home, edadMs = 0) => {
  fs.mkdirSync(path.dirname(lockDe(home)), { recursive: true });
  fs.writeFileSync(lockDe(home), '');
  if (edadMs) { const t = new Date(Date.now() - edadMs); fs.utimesSync(lockDe(home), t, t); }
};
const hijoNode = (codigo) => new Promise((res) => {
  const h = cp.spawn(process.execPath, ['-e', codigo]);
  let out = ''; let err = '';
  h.stdout.on('data', (d) => { out += d; });
  h.stderr.on('data', (d) => { err += d; });
  h.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }));
});

async function main() {
  await group('dos versiones no se invalidan entre sí', () => {
    const home = nuevoHome();
    try {
      check('guardar devuelve true', sondas.guardarResultado(M, P, entrada(huella(A)), home) === true);
      sondas.guardarResultado(M, P, entrada(huella(B)), home);
      check('A sigue vigente después de que B escribió', sondas.vigencia(M, P, huella(A), home).ok);
      check('B vigente', sondas.vigencia(M, P, huella(B), home).ok);
      check('el archivo de siempre queda con la última escritura (lo que leen las versiones viejas)',
        sondas.leerResultados(home)[M][P].huella.versionLagrange === B);
      check('otra versión de Lagrange sin resultado → no vigente', !sondas.vigencia(M, P, huella('0.67.5'), home).ok);
      check('misma versión de Lagrange, otro CLI → no vigente (SEC-018: la huella completa pesa)',
        !sondas.vigencia(M, P, huella(A, '2.1.300'), home).ok);
      check('otro perfil de la misma versión → no vigente', !sondas.vigencia(M, 'con-tools', huella(A), home).ok);
      check('otro motor → no vigente', !sondas.vigencia('claude@principal', P, huella(A), home).ok);
    } finally { borrar(home); }
  });

  await group('una falla es de su versión: no contagia ni se borra por otra', () => {
    const home = nuevoHome();
    try {
      sondas.guardarResultado(M, P, entrada(huella(A), 'falla'), home);
      sondas.guardarResultado(M, P, entrada(huella(B), 'pasa'), home);
      check('B ok', sondas.vigencia(M, P, huella(B), home).ok);
      const va = sondas.vigencia(M, P, huella(A), home);
      check('A sigue sin ser vigente y dice por qué falló', !va.ok && /falló/.test(va.motivo), va.motivo);
    } finally { borrar(home); }
  });

  await group('un escritor viejo reescribe el archivo de siempre y no toca el auxiliar', () => {
    const home = nuevoHome();
    try {
      sondas.guardarResultado(M, P, entrada(huella(B)), home);
      const ruta = sondas.rutaEntradaPorVersion(M, B, P, home);
      const antes = fs.readFileSync(ruta, 'utf8');
      escritorViejo(M, P, entrada(huella(A)), home);
      escritorViejo('otro', P, entrada(huella(A)), home);
      check('el auxiliar quedó intacto', fs.readFileSync(ruta, 'utf8') === antes);
      check('B sigue vigente aunque el archivo de siempre ahora tenga la huella de A', sondas.vigencia(M, P, huella(B), home).ok);
      check('A, la última que escribió el viejo, sigue vigente por el archivo de siempre', sondas.vigencia(M, P, huella(A), home).ok);
    } finally { borrar(home); }
  });

  await group('tope de 3 versiones por motor, por fecha', () => {
    const home = nuevoHome();
    try {
      const fechas = { '0.67.1': '2026-09-01T00:00:00Z', '0.67.2': '2026-09-02T00:00:00Z', '0.67.3': '2026-09-03T00:00:00Z', '0.67.4': '2026-09-04T00:00:00Z', '0.67.5': '2026-09-05T00:00:00Z' };
      for (const [v, f] of Object.entries(fechas)) sondas.guardarResultado(M, P, entrada(huella(v), 'pasa', f), home);
      check('quedan las 3 más recientes por fecha', JSON.stringify(versionesDe(home, M)) === '["0.67.3","0.67.4","0.67.5"]', JSON.stringify(versionesDe(home, M)));
      // Una versión con semver MAYOR pero fecha vieja no le gana a las recientes: se ordena por fecha.
      sondas.guardarResultado(M, P, entrada(huella('0.90.0'), 'pasa', '2026-01-01T00:00:00Z'), home);
      const v2 = versionesDe(home, M);
      check('la recién escrita nunca se descarta, aunque su fecha sea la más vieja', v2.includes('0.90.0') && v2.length === 3, JSON.stringify(v2));
      sondas.guardarResultado('claude@principal', P, entrada(huella(A)), home);
      check('el tope es por motor', versionesDe(home, M).length === 3 && versionesDe(home, 'claude@principal').length === 1);
      // Un perfil más de una versión ya guardada no crea otra versión.
      sondas.guardarResultado(M, 'con-tools', entrada(huella('0.90.0'), 'pasa', '2026-01-02T00:00:00Z'), home);
      check('otro perfil de la misma versión no cuenta como versión nueva', versionesDe(home, M).length === 3);
    } finally { borrar(home); }
  });

  await group('sin versión de Lagrange se comporta como antes', () => {
    const home = nuevoHome();
    try {
      sondas.guardarResultado(M, P, entrada({ versionCli: '1', versionLagrange: null }), home);
      check('no crea el auxiliar', !fs.existsSync(sondas.rutaResultadosPorVersion(home)));
      check('y sigue siendo vigente por el archivo de siempre', sondas.vigencia(M, P, { versionCli: '1', versionLagrange: null }, home).ok);
      check('huella null no es vigente', !sondas.vigencia(M, P, null, home).ok);
      ponerLock(home);
      check('sin versión y con el lock tomado, un pasa se descarta (false)', sondas.guardarResultado(M, 'con-tools', entrada({ versionCli: '1', versionLagrange: null }), home) === false);
    } finally { borrar(home); }
  });

  await group('una entrada del auxiliar solo vale con la forma que escribe correrJuego', () => {
    const home = nuevoHome();
    try {
      const ruta = ponerAux(home, M, A, P, '{ esto no es json');
      check('un archivo ilegible cuenta como ausente y no lanza', !sondas.vigencia(M, P, huella(A), home).ok);
      check('guardar sigue andando', sondas.guardarResultado(M, P, entrada(huella(A)), home) === true);
      check('y el resultado ya es vigente', sondas.vigencia(M, P, huella(A), home).ok);
      const dir = fs.readdirSync(path.dirname(ruta));
      check('el ilegible se apartó, no se borró', dir.some((f) => f.includes('.json.corrupto-')), dir.join(','));

      const otro = nuevoHome();
      try {
        const casos = {
          'un pase sin fecha': { huella: huella(B), resultado: 'pasa' },
          'un pase con fecha que no es una fecha': { huella: huella(B), resultado: 'pasa', fecha: 'x' },
          'una huella que es un arreglo': { huella: [1], resultado: 'pasa', fecha: '2026-09-20T10:00:00Z' },
          'sin huella': { resultado: 'pasa', fecha: '2026-09-20T10:00:00Z' },
          'un arreglo en vez de una entrada': [1, 2, 3],
          'un número': 7
        };
        for (const [nombre, contenido] of Object.entries(casos)) {
          ponerAux(otro, M, B, P, contenido);
          check(`${nombre} no da vigencia`, !sondas.vigencia(M, P, huella(B), otro).ok);
        }
        ponerAux(otro, M, B, P, entrada(huella(B)));
        check('la misma entrada bien formada sí', sondas.vigencia(M, P, huella(B), otro).ok);
      } finally { borrar(otro); }
    } finally { borrar(home); }
  });

  await group('nombres raros no salen de la carpeta ni heredan del prototipo', () => {
    const home = nuevoHome();
    try {
      const base = sondas.rutaResultadosPorVersion(home);
      for (const v of ['..', '.', '', 'a/b', 'a\\b', '__proto__', 'constructor']) {
        const ruta = sondas.rutaEntradaPorVersion(M, v, P, home);
        check(`la ruta de la versión ${JSON.stringify(v)} queda dentro de la carpeta`, path.resolve(ruta).startsWith(path.resolve(base) + path.sep), ruta);
      }
      check('una versión ".." se guarda y se lee como cualquier otra', sondas.guardarResultado(M, P, entrada(huella('..')), home) === true && sondas.vigencia(M, P, huella('..'), home).ok);
      check('no escribió fuera de la carpeta', !fs.existsSync(path.join(home, '.claude', 'sin-tools.json')) && !fs.existsSync(path.join(base, 'sin-tools.json')));
      check('constructor como versión sin resultado no es vigente', !sondas.vigencia(M, P, huella('constructor'), home).ok);
    } finally { borrar(home); }
  });

  await group('cortes entre las dos escrituras: nunca queda vigente algo que ya no lo es', () => {
    const home = nuevoHome();
    try {
      // Corte después del auxiliar y antes del archivo de siempre: el nuevo resultado (B) está solo en el auxiliar.
      sondas.guardarResultado(M, P, entrada(huella(A)), home);
      ponerAux(home, M, B, P, entrada(huella(B)));
      check('B se encuentra en el auxiliar', sondas.vigencia(M, P, huella(B), home).ok);

      // Corte con una FALLA nueva de A solo en el auxiliar; el archivo de siempre conserva el pase viejo de A.
      ponerAux(home, M, A, P, entrada(huella(A), 'falla', '2026-09-20T11:00:00.000Z'));
      check('el archivo de siempre todavía tiene el pase viejo de A',
        sondas.leerResultados(home)[M][P].resultado === 'pasa' && sondas.leerResultados(home)[M][P].huella.versionLagrange === A);
      const v = sondas.vigencia(M, P, huella(A), home);
      check('la falla del auxiliar gana: A NO es vigente', !v.ok && /falló/.test(v.motivo), v.motivo);

      // Al revés: el auxiliar no se pudo escribir y conserva un pase viejo de la misma huella; el archivo de siempre
      // tiene la falla nueva. Tampoco puede quedar vigente.
      const home2 = nuevoHome();
      try {
        ponerAux(home2, M, A, P, entrada(huella(A)));
        fs.writeFileSync(sondas.rutaResultados(home2), JSON.stringify({ [M]: { [P]: entrada(huella(A), 'falla', '2026-09-20T11:00:00.000Z') } }));
        check('un pase viejo en el auxiliar no tapa la falla nueva del archivo de siempre', !sondas.vigencia(M, P, huella(A), home2).ok);
      } finally { borrar(home2); }
    } finally { borrar(home); }
  });

  await group('BLOCKER de la auditoría: una escritura vieja del archivo de siempre no borra una falla', () => {
    const home = nuevoHome();
    try {
      // Hay un pase de B, y otro proceso (motor A) leyó el archivo de siempre en ese momento.
      sondas.guardarResultado(M, P, entrada(huella(B)), home);
      const copiaVieja = fs.readFileSync(sondas.rutaResultados(home), 'utf8');
      // Se guarda una falla nueva de B...
      sondas.guardarResultado(M, P, entrada(huella(B), 'falla'), home);
      check('la falla quedó', !sondas.vigencia(M, P, huella(B), home).ok);
      // ...y el otro proceso, con su copia vieja, reescribe el archivo de siempre entero (recuperación de lock no exclusiva).
      const viejo = JSON.parse(copiaVieja);
      viejo.otroMotor = { [P]: entrada(huella(B)) };
      fs.writeFileSync(sondas.rutaResultados(home), JSON.stringify(viejo));
      check('el archivo de siempre volvió a tener el pase de B', sondas.leerResultados(home)[M][P].resultado === 'pasa');
      const v = sondas.vigencia(M, P, huella(B), home);
      check('pero B sigue sin ser vigente: la falla vive en su propio archivo', !v.ok && /falló/.test(v.motivo), v.motivo);
      // Y una escritura concurrente de otro motor en el auxiliar no toca esa entrada.
      sondas.guardarResultado('otro', P, entrada(huella(B)), home);
      check('ni tras guardar un pase de otro motor', !sondas.vigencia(M, P, huella(B), home).ok);
    } finally { borrar(home); }
  });

  await group('BLOCKER de la ronda 2: una corrida que termina tarde no pisa a una posterior (el testigo vence a los 10 min)', () => {
    const home = nuevoHome();
    try {
      // Corrida 1 terminó su juego a las 10:00 con un pase; corrida 2 (arrancó cuando el testigo venció) terminó a las 10:11 con una falla y guardó primero.
      sondas.guardarResultado(M, P, entrada(huella(B), 'falla', '2026-09-20T10:11:00.000Z'), home);
      const r = sondas.guardarResultado(M, P, entrada(huella(B), 'pasa', '2026-09-20T10:00:00.000Z'), home);
      check('el pase de la corrida anterior no reemplaza a la falla más nueva (se descarta: false, y el llamador lo registra)', r === false);
      const v = sondas.vigencia(M, P, huella(B), home);
      check('B sigue sin ser vigente', !v.ok && /falló/.test(v.motivo), v.motivo);
      check('ni el archivo de siempre se tocó con el resultado viejo', sondas.leerResultados(home)[M][P].resultado === 'falla');
      // Y al revés, uno más nuevo sí reemplaza.
      sondas.guardarResultado(M, P, entrada(huella(B), 'pasa', '2026-09-20T10:20:00.000Z'), home);
      check('un pase posterior sí reemplaza a la falla', sondas.vigencia(M, P, huella(B), home).ok);
      // Con la misma fecha (o una que no se entiende) se escribe, como antes.
      sondas.guardarResultado(M, P, entrada(huella(B), 'falla', '2026-09-20T10:20:00.000Z'), home);
      check('a igual fecha manda la última en escribirse', !sondas.vigencia(M, P, huella(B), home).ok);
    } finally { borrar(home); }
  });

  await group('BLOCKER de la ronda 2: la poda nunca borra una falla', () => {
    const home = nuevoHome();
    try {
      const hace = (dias) => new Date(Date.now() - dias * 86_400_000).toISOString();
      // 0.67.1 falló hace 50 días, 0.67.2 pasó y 0.67.0 falló hace 200; después llegan tres versiones más recientes y sobran las tres primeras.
      sondas.guardarResultado(M, P, entrada(huella('0.67.0'), 'falla', hace(200)), home);
      sondas.guardarResultado(M, P, entrada(huella('0.67.1'), 'falla', hace(50)), home);
      sondas.guardarResultado(M, P, entrada(huella('0.67.2'), 'pasa', hace(40)), home);
      for (const [v, d] of [['0.67.3', 3], ['0.67.4', 2], ['0.67.5', 1]]) sondas.guardarResultado(M, P, entrada(huella(v), 'pasa', hace(d)), home);
      check('el pase de la versión que sobraba se borró', !fs.existsSync(sondas.rutaEntradaPorVersion(M, '0.67.2', P, home)));
      check('la carpeta vacía también', !versionesDe(home, M).includes('0.67.2'), JSON.stringify(versionesDe(home, M)));
      check('una falla reciente de una versión que sobraba se conservó', fs.existsSync(sondas.rutaEntradaPorVersion(M, '0.67.1', P, home)));
      check('una falla de hace más de 90 días se borró (acota la carpeta)', !fs.existsSync(sondas.rutaEntradaPorVersion(M, '0.67.0', P, home)) && !versionesDe(home, M).includes('0.67.0'), JSON.stringify(versionesDe(home, M)));
      // Vuelve esa versión con un corte entre las dos escrituras: el archivo de siempre conserva un pase de la misma huella.
      fs.writeFileSync(sondas.rutaResultados(home), JSON.stringify({ [M]: { [P]: entrada(huella('0.67.1'), 'pasa', hace(60)) } }));
      check('así que 0.67.1 sigue sin ser vigente', !sondas.vigencia(M, P, huella('0.67.1'), home).ok);
      check('las tres más recientes siguen', ['0.67.3', '0.67.4', '0.67.5'].every((v) => sondas.vigencia(M, P, huella(v), home).ok));
    } finally { borrar(home); }
  });

  await group('BLOCKER de la ronda 3: la fecha es el final de la corrida; se ordena por cuándo empezó', () => {
    const home = nuevoHome();
    try {
      const conInicio = (h, resultado, inicio, fecha) => ({ ...entrada(h, resultado, fecha), inicio });
      // B empezó a las 10:11 y falló a las 10:12. A empezó a las 10:00, se demoró y pasó a las 10:13 (fecha posterior a la falla).
      sondas.guardarResultado(M, P, conInicio(huella(B), 'falla', '2026-09-20T10:11:00.000Z', '2026-09-20T10:12:00.000Z'), home);
      const r = sondas.guardarResultado(M, P, conInicio(huella(B), 'pasa', '2026-09-20T10:00:00.000Z', '2026-09-20T10:13:00.000Z'), home);
      check('el pase de la corrida que empezó antes se descarta aunque haya terminado después', r === false);
      const v = sondas.vigencia(M, P, huella(B), home);
      check('B sigue sin ser vigente', !v.ok && /falló/.test(v.motivo), v.motivo);
      // Una corrida que empezó después sí reemplaza.
      sondas.guardarResultado(M, P, conInicio(huella(B), 'pasa', '2026-09-20T10:30:00.000Z', '2026-09-20T10:31:00.000Z'), home);
      check('un pase de una corrida posterior sí', sondas.vigencia(M, P, huella(B), home).ok);
      // Una falla siempre se escribe, aunque su corrida sea más vieja: perderla dejaría vigente un pase.
      const r2 = sondas.guardarResultado(M, P, conInicio(huella(B), 'falla', '2026-09-20T09:00:00.000Z', '2026-09-20T09:05:00.000Z'), home);
      check('una falla más vieja igual se escribe (true)', r2 === true);
      check('y B deja de ser vigente', !sondas.vigencia(M, P, huella(B), home).ok);
      // correrJuego deja `inicio` en la entrada.
      const t0 = new Date('2026-09-20T12:00:00.000Z');
      let n = 0;
      return sondas.correrJuego({ sondas: [{ id: 'X', correr: async () => ({ resultado: 'pasa' }) }], huella: huella(B), ahora: () => new Date(t0.getTime() + 60_000 * n++) })
        .then((e) => check('correrJuego guarda inicio antes que fecha', e.inicio === '2026-09-20T12:00:00.000Z' && e.fecha === '2026-09-20T12:01:00.000Z', JSON.stringify(e)));
    } finally { borrar(home); }
  });

  await group('BLOCKER de la ronda 3: una fecha futura no tapa una falla ni vale como verificación', () => {
    const home = nuevoHome();
    try {
      const futuro = '2099-01-01T00:00:00.000Z';
      ponerAux(home, M, B, P, entrada(huella(B), 'pasa', futuro));
      check('un pase con fecha de 2099 no es vigente', !sondas.vigencia(M, P, huella(B), home).ok);
      const r = sondas.guardarResultado(M, P, entrada(huella(B), 'falla', '2026-09-20T10:00:00.000Z'), home);
      check('una falla de hoy se escribe pese al pase futuro', r === true && JSON.parse(fs.readFileSync(sondas.rutaEntradaPorVersion(M, B, P, home), 'utf8')).resultado === 'falla');
      check('y B no es vigente', !sondas.vigencia(M, P, huella(B), home).ok);
      // Un pase de hoy tampoco queda bloqueado por una entrada futura.
      ponerAux(home, M, B, P, entrada(huella(B), 'falla', futuro));
      check('un pase de hoy reemplaza a una entrada con fecha futura', sondas.guardarResultado(M, P, entrada(huella(B), 'pasa', '2026-09-20T10:00:00.000Z'), home) === true && sondas.vigencia(M, P, huella(B), home).ok);
      // Dentro del margen de 5 minutos por relojes desfasados, sí vale.
      ponerAux(home, M, B, 'con-tools', entrada(huella(B), 'pasa', new Date(Date.now() + 60_000).toISOString()));
      check('un minuto adelantado (relojes desfasados) todavía vale', sondas.vigencia(M, 'con-tools', huella(B), home).ok);
      ponerAux(home, M, B, 'con-tools', entrada(huella(B), 'pasa', new Date(Date.now() + 10 * 60_000).toISOString()));
      check('diez minutos adelantado ya no', !sondas.vigencia(M, 'con-tools', huella(B), home).ok);
    } finally { borrar(home); }
  });

  await group('BLOCKER de la ronda 4: una falla con fecha futura sigue siendo falla; un pase con fecha futura no vale en ningún archivo', () => {
    const home = nuevoHome();
    try {
      const futuro = new Date(Date.now() + 60 * 60_000).toISOString();
      // La falla quedó (con el reloj adelantado) solo en el auxiliar por un corte; el archivo de siempre conserva un pase de la misma huella.
      fs.mkdirSync(path.dirname(sondas.rutaResultados(home)), { recursive: true });
      fs.writeFileSync(sondas.rutaResultados(home), JSON.stringify({ [M]: { [P]: entrada(huella(B), 'pasa', '2026-09-20T10:00:00.000Z') } }));
      ponerAux(home, M, B, P, entrada(huella(B), 'falla', futuro));
      const v = sondas.vigencia(M, P, huella(B), home);
      check('la falla futura del auxiliar gana al pase del archivo de siempre', !v.ok && /falló/.test(v.motivo), v.motivo);

      // Un pase con fecha futura solo en el archivo de siempre (sin auxiliar) tampoco habilita.
      const home2 = nuevoHome();
      try {
        fs.mkdirSync(path.dirname(sondas.rutaResultados(home2)), { recursive: true });
        fs.writeFileSync(sondas.rutaResultados(home2), JSON.stringify({ [M]: { [P]: entrada(huella(B), 'pasa', futuro) } }));
        const v2 = sondas.vigencia(M, P, huella(B), home2);
        check('un pase futuro del archivo de siempre no es vigente', !v2.ok && /futuro/.test(v2.motivo), v2.motivo);
        // Pasado el margen de relojes desfasados: un minuto adelantado todavía vale.
        fs.writeFileSync(sondas.rutaResultados(home2), JSON.stringify({ [M]: { [P]: entrada(huella(B), 'pasa', new Date(Date.now() + 60_000).toISOString()) } }));
        check('un minuto adelantado (relojes desfasados) todavía vale', sondas.vigencia(M, P, huella(B), home2).ok);
      } finally { borrar(home2); }

      // La poda no borra una falla futura de una versión que sobra.
      const home3 = nuevoHome();
      try {
        const hace = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
        ponerAux(home3, M, '0.60.0', P, entrada(huella('0.60.0'), 'falla', futuro));
        sondas.guardarResultado(M, P, entrada(huella('0.61.0'), 'pasa', hace(3)), home3);
        sondas.guardarResultado(M, P, entrada(huella('0.62.0'), 'pasa', hace(2)), home3);
        sondas.guardarResultado(M, P, entrada(huella('0.63.0'), 'pasa', hace(1)), home3);
        sondas.guardarResultado(M, P, entrada(huella('0.64.0'), 'pasa', hace(0)), home3);
        check('la versión con la falla futura sobra por antigüedad pero su falla se conserva',
          fs.existsSync(sondas.rutaEntradaPorVersion(M, '0.60.0', P, home3)), JSON.stringify(versionesDe(home3, M)));
      } finally { borrar(home3); }
    } finally { borrar(home); }
  });

  await group('nombres largos no colisionan', () => {
    const home = nuevoHome();
    try {
      const base = 'x'.repeat(150);
      const m1 = `${base}1`;
      const m2 = `${base}2`;
      check('dos motores con el mismo prefijo largo tienen rutas distintas', sondas.rutaEntradaPorVersion(m1, A, P, home) !== sondas.rutaEntradaPorVersion(m2, A, P, home));
      check('dos perfiles con el mismo prefijo largo también', sondas.rutaEntradaPorVersion(M, A, `${base}1`, home) !== sondas.rutaEntradaPorVersion(M, A, `${base}2`, home));
      sondas.guardarResultado(m1, P, entrada(huella(A)), home);
      check('el resultado de uno no da vigencia al otro', sondas.vigencia(m1, P, huella(A), home).ok && !sondas.vigencia(m2, P, huella(A), home).ok);
      check('un segmento largo queda acotado', path.basename(path.dirname(path.dirname(sondas.rutaEntradaPorVersion(m1, A, P, home)))).length <= 100);
    } finally { borrar(home); }
  });

  await group('lock ocupado: el auxiliar se escribe igual; en el archivo de siempre solo las fallas', () => {
    const home = nuevoHome();
    try {
      // Caso de la ronda 3: pase previo de la misma huella, otro proceso tiene el lock, la corrida nueva falla.
      sondas.guardarResultado(M, P, entrada(huella(A)), home);
      check('antes de la falla, A vigente', sondas.vigencia(M, P, huella(A), home).ok);
      ponerLock(home);
      const t0 = performance.now();
      const r = sondas.guardarResultado(M, P, entrada(huella(A), 'falla'), home);
      const ms = performance.now() - t0;
      check('la falla se escribió aunque el lock estaba tomado (true)', r === true);
      check('esperó el lock antes de rendirse (~2 s), no escribió de inmediato', ms >= 1500, `${ms} ms`);
      check('y A ya NO es vigente: un pase viejo no sobrevive a una falla nueva', !sondas.vigencia(M, P, huella(A), home).ok);
      check('las versiones viejas también la ven, en el archivo de siempre', sondas.leerResultados(home)[M][P].resultado === 'falla');
      check('el lock ajeno no se tocó', fs.existsSync(lockDe(home)));

      // Un pase con el lock tomado: queda en el auxiliar (esta versión ya lo puede usar) y el archivo de siempre no cambia.
      const r2 = sondas.guardarResultado(M, P, entrada(huella(B)), home);
      check('un pase con versión y el lock tomado queda guardado en el auxiliar (true)', r2 === true);
      check('no toca el archivo de siempre', sondas.leerResultados(home)[M][P].huella.versionLagrange === A && sondas.leerResultados(home)[M][P].resultado === 'falla');
      check('y B es vigente por el auxiliar', sondas.vigencia(M, P, huella(B), home).ok);
    } finally { borrar(home); }
  });

  await group('lock huérfano (más de 5 s) se recupera', () => {
    const home = nuevoHome();
    try {
      ponerLock(home, 10_000);
      const t0 = performance.now();
      check('un pasa guarda pese al lock viejo', sondas.guardarResultado(M, P, entrada(huella(A)), home) === true);
      check('rápido, sin esperar los 2 s', performance.now() - t0 < 1500, `${performance.now() - t0} ms`);
      check('y quedó vigente', sondas.vigencia(M, P, huella(A), home).ok);
      check('el lock se liberó', !fs.existsSync(lockDe(home)));
    } finally { borrar(home); }
  });

  await group('procesos en paralelo', async () => {
    const home = nuevoHome();
    try {
      // 4 procesos, cada uno con su motor y 6 perfiles: ninguna entrada se pierde.
      const perfiles = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
      const codigo = (motor) => `const s=require(${JSON.stringify(SONDAS_JS)});`
        + `for (const p of ${JSON.stringify(perfiles)}) { const ok = s.guardarResultado(${JSON.stringify(motor)}, p, {huella:{versionCli:'1',versionLagrange:'0.67.4'},resultado:'pasa',fecha:new Date().toISOString()}, ${JSON.stringify(home)}); if (ok !== true) process.stdout.write('NO'); }`;
      const motores = ['m0', 'm1', 'm2', 'm3'];
      const rs = await Promise.all(motores.map((m) => hijoNode(codigo(m))));
      check('ninguno falló ni descartó', rs.every((r) => r.code === 0 && r.out === ''), JSON.stringify(rs));
      const todo = sondas.leerResultados(home);
      const faltan = [];
      for (const m of motores) for (const p of perfiles) {
        if (!todo[m] || !todo[m][p]) faltan.push(`main:${m}/${p}`);
        if (!legible(sondas.rutaEntradaPorVersion(m, '0.67.4', p, home))) faltan.push(`aux:${m}/${p}`);
      }
      check('no se perdió ninguna entrada, ni en el archivo de siempre ni en el auxiliar', faltan.length === 0, faltan.join(', '));
    } finally { borrar(home); }
  });

  await group('dos procesos recuperando a la vez un lock huérfano', async () => {
    const home = nuevoHome();
    try {
      ponerLock(home, 10_000);
      const codigo = (motor) => `const s=require(${JSON.stringify(SONDAS_JS)});`
        + `setTimeout(()=>{try{process.stdout.write(String(s.guardarResultado(${JSON.stringify(motor)},'sin-tools',{huella:{versionCli:'1',versionLagrange:'0.67.4'},resultado:'falla',fecha:new Date().toISOString()},${JSON.stringify(home)})))}catch(e){process.stdout.write('LANZO '+e.message)}},300);`;
      const rs = await Promise.all(['r0', 'r1'].map((m) => hijoNode(codigo(m))));
      check('ninguno lanza', rs.every((r) => r.code === 0 && r.out === 'true'), JSON.stringify(rs));
      check('el archivo de siempre existe y es JSON válido', fs.existsSync(sondas.rutaResultados(home)) && legible(sondas.rutaResultados(home)));
      // La recuperación de un lock huérfano no es exclusiva: el archivo de siempre puede perder la entrada de uno.
      // Las del auxiliar son archivos distintos y las dos fallas quedan.
      check('las dos fallas quedaron en el auxiliar, legibles', ['r0', 'r1'].every((m) => legible(sondas.rutaEntradaPorVersion(m, '0.67.4', P, home))));
      check('y ninguna de las dos es vigente', ['r0', 'r1'].every((m) => !sondas.vigencia(m, P, huella('0.67.4', '1'), home).ok));
    } finally { borrar(home); }
  });

  await group('testigo: solo lo suelta su dueño', () => {
    const home = nuevoHome();
    try {
      check('se toma', sondas.tomarTestigo('claude', { homeDir: home }) === true);
      const ruta = sondas.rutaTestigo('claude', home);
      // Otro proceso lo reemplazó (el nuestro venció): no se lo quitamos.
      fs.writeFileSync(ruta, JSON.stringify({ pid: process.pid + 1_000_003, desde: new Date().toISOString() }));
      sondas.soltarTestigo('claude', home);
      check('el testigo de otro pid no se borra', fs.existsSync(ruta));
      fs.writeFileSync(ruta, JSON.stringify({ pid: process.pid, desde: new Date().toISOString() }));
      sondas.soltarTestigo('claude', home);
      check('el propio se borra', !fs.existsSync(ruta));
      fs.writeFileSync(ruta, 'basura');
      sondas.soltarTestigo('claude', home);
      check('uno ilegible se borra, como antes', !fs.existsSync(ruta));
      let lanzo = false;
      try { sondas.soltarTestigo('claude', home); } catch { lanzo = true; }
      check('soltar sin testigo no lanza', !lanzo);
    } finally { borrar(home); }
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
