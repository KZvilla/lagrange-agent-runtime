/**
 * FEAT-119/120 — El aviso de lo que suena (`mcp-server/lib/voz-en-curso.js`) y
 * su ruta para el mod (`buzon.js mod-voz`): por PID de Claude, sin daemon.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, report } = require('./lib/assert');
const { temporalQueSeBorra } = require('./lib/temporales');
const buzones = require('../mcp-server/lib/buzones.js');
const { escribirVoz, borrarVoz, HOLGURA_MS } = require('../mcp-server/lib/voz-en-curso.js');

async function main() {
  await group('escribirVoz: duración del wav o estimada; borrarVoz solo lo propio', () => {
    const d = temporalQueSeBorra('voz-');
    const marca = escribirVoz({ dataDir: d, claudePid: 4242, voz: 'Alya', texto: 'hola', wav: 'x.wav', ahora: 1000, pid: 7, duracionWav: () => 2.5 });
    const ruta = buzones.rutaVoz(d, 4242);
    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    check('por PID de Claude', marca && marca.ruta === ruta && path.basename(ruta) === 'voz-4242.json');
    check('duración de la cabecera y hasta con holgura', datos.duracionMs === 2500 && datos.hasta === 1000 + 2500 + HOLGURA_MS && datos.voz === 'Alya' && datos.texto === 'hola');
    const estimada = escribirVoz({ dataDir: d, claudePid: 5, voz: 'A', texto: 'x'.repeat(30), wav: 'x.wav', ahora: 0, duracionWav: () => null });
    check('sin cabecera: 15 caracteres por segundo', JSON.parse(fs.readFileSync(estimada.ruta, 'utf8')).duracionMs === 2000);
    check('sin claudePid válido no escribe', escribirVoz({ dataDir: d, claudePid: 1, voz: 'A', texto: 'x' }) === null && escribirVoz({ dataDir: d, claudePid: null, voz: 'A', texto: 'x' }) === null);

    // Otra narración pisó el aviso: la marca vieja no lo borra.
    const nueva = escribirVoz({ dataDir: d, claudePid: 4242, voz: 'Diego', texto: 'otra', ahora: 2000, pid: 8, duracionWav: () => 1 });
    borrarVoz(marca);
    check('una marca vieja no borra el aviso de otra', fs.existsSync(ruta) && JSON.parse(fs.readFileSync(ruta, 'utf8')).voz === 'Diego');
    borrarVoz(nueva);
    check('la propia sí', !fs.existsSync(ruta));
    borrarVoz(null);
    borrarVoz(nueva);
    check('borrar dos veces o sin marca no tira', true);
  });

  await group('buzon.js mod-voz: la ruta por el padre, sin daemon ni sesión', () => {
    const d = temporalQueSeBorra('voz-hook-');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'buzon.js'), 'mod-voz'], { encoding: 'utf8', env: { ...process.env, CLAUDECODE: '', TELEGRAM_BRIDGE_DATA_DIR: d } });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch {}
    check('exit 0 y la ruta de voz-<ppid>.json', r.status === 0 && j && j.voz === buzones.rutaVoz(d, process.pid), r.stdout + r.stderr);
  });

  await group('limpiarViejos se lleva los avisos viejos', () => {
    const d = temporalQueSeBorra('voz-limpiar-');
    escribirVoz({ dataDir: d, claudePid: 99, voz: 'A', texto: 'x', duracionWav: () => 1 });
    const ruta = buzones.rutaVoz(d, 99);
    const viejo = new Date(Date.now() - buzones.RETENCION_MS - 60_000);
    fs.utimesSync(ruta, viejo, viejo);
    check('borrado', buzones.limpiarViejos(d, new Set()) === 1 && !fs.existsSync(ruta));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
