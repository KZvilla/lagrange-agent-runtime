/**
 * SEC-020 fase 2 — Tools de solo lectura en contenedor: argv puros e
 * invariantes, recolector, decisión de modo (fail-closed con marca) y el
 * ejecutor con un `docker` y un `ejecutarStdin` falsos (sin WSL ni agy).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const d = require('../mcp-server/lotes/docker.js');
const { recolectar } = require('../mcp-server/lotes/recolector.js');
const sl = require('../mcp-server/lotes/solo-lectura.js');

const UUID = '751ba43c-cf69-49ac-a61f-4f2908d2faaa';

function argvBase(extra = {}) {
  return d.argvSoloLectura({
    nombres: d.nombres('ro-audit-abc123', 'ro'), rutaCopia: '/mnt/c/x/ro-audit-abc123', volumenHilo: 'ro-hilo-aa11bb',
    modelo: 'gemini-3.1-pro', effort: 'high', timeoutMinutes: 25, idLote: 'ro-audit-abc123', expiraEpoch: 2000000000, ...extra
  });
}

function repoTemporal() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ro-sl-repo-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.js'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'i');
  return dir;
}

/** Docker falso: registra y responde lo mínimo para que credenciales/proxy avancen. */
function dockerFalso({ falla = () => false, volumenesExistentes = new Set() } = {}) {
  const llamadas = [];
  const docker = async (args, opciones = {}) => {
    llamadas.push(args);
    let r = { code: 0, stdout: `${new Date(Date.now() + 3600e3).toISOString()}\n`, stderr: '' };
    if (args[0] === 'inspect') r = { code: 0, stdout: 'true\n', stderr: '' };
    if (args[0] === 'volume' && args[1] === 'inspect') r = { code: volumenesExistentes.has(args[2]) ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'ps' || args[0] === 'network' && args[1] === 'ls' || args[0] === 'volume' && args[1] === 'ls') r = { code: 0, stdout: '', stderr: '' };
    if (falla(args)) r = { code: 1, stdout: '', stderr: 'falla simulada' };
    if (r.code !== 0 && !opciones.permitirFallo) throw new Error(`docker ${args.slice(0, 3).join(' ')} falló`);
    return r;
  };
  return { docker, llamadas };
}

async function main() {
  await group('argvSoloLectura e invariantes', () => {
    const argv = argvBase();
    check('las invariantes pasan', d.verificarInvariantesSoloLectura(argv).length === 0, JSON.stringify(d.verificarInvariantesSoloLectura(argv)));
    const montajes = argv.filter((a, i) => argv[i - 1] === '-v');
    check('/trabajo RO', montajes.includes('/mnt/c/x/ro-audit-abc123:/trabajo:ro'));
    check('el volumen del hilo en /home/agy/.gemini', montajes.includes('ro-hilo-aa11bb:/home/agy/.gemini'));
    check('nunca agy-credenciales', !argv.join(' ').includes('agy-credenciales'));
    check('red interna de la corrida', argv[argv.indexOf('--network') + 1] === 'lote-ro-audit-abc123-ro-auditor-red');
    check('plan + print-timeout del pedido', argv.at(-1).includes('--mode plan') && argv.at(-1).includes('--print-timeout 25m'));
    check('con hilo, --conversation en el comando', argvBase({ conversacion: UUID }).at(-1).includes(`--conversation ${UUID}`));
    let err = null;
    try { argvBase({ conversacion: 'x; rm -rf /' }); } catch (e) { err = e; }
    check('una conversación que no es UUID se rechaza al armar', err && /UUID/.test(err.message));
    err = null;
    try { argvBase({ volumenHilo: 'agy-credenciales' }); } catch (e) { err = e; }
    check('un volumen de hilo sin prefijo ro-hilo- se rechaza', err && /volumen del hilo/.test(err.message));

    const con = (mutar) => { const a = argvBase(); mutar(a); return d.verificarInvariantesSoloLectura(a); };
    check('rechaza /trabajo RW', con((a) => { a[a.indexOf('/mnt/c/x/ro-audit-abc123:/trabajo:ro')] = '/mnt/c/x:/trabajo'; }).length > 0);
    check('rechaza un -v extra', con((a) => a.splice(3, 0, '-v', '/mnt/c:/host')).some((p) => /montaje inesperado/.test(p)));
    check('rechaza el socket de Docker', con((a) => a.splice(3, 0, '-v', '/var/run/docker.sock:/trabajo:ro')).length > 0);
    check('rechaza --privileged', con((a) => a.splice(3, 0, '--privileged')).length > 0);
    check('rechaza --network host', con((a) => { a[a.indexOf('--network') + 1] = 'host'; }).length > 0);
    check('rechaza el volumen de credenciales en el hilo', con((a) => { a[a.indexOf('ro-hilo-aa11bb:/home/agy/.gemini')] = 'agy-credenciales:/home/agy/.gemini'; }).length > 0);
    check('rechaza sin límites de recursos', con((a) => a.splice(a.indexOf('--memory=2g'), 1)).length > 0);

    const prep = d.argvPrepararVolumenHilo('ro-hilo-aa11bb');
    check('preparar el volumen: root, sin red, solo chown', prep.includes('--network') && prep[prep.indexOf('--network') + 1] === 'none' && prep.at(-3) === 'chown');
    const limpiar = d.argvLimpiarSenuelo('ro-hilo-aa11bb');
    check('limpiar el señuelo: sin red, RO, uid de agy, rm del token',
      limpiar[limpiar.indexOf('--network') + 1] === 'none' && limpiar.includes('--read-only')
      && limpiar.at(-1) === '/hilo/antigravity-cli/antigravity-oauth-token' && limpiar.includes('rm'));
  });

  await group('recolector: los recursos ro- se podan solo por vencimiento', async () => {
    const ahora = 1_700_000_000_000;
    const filas = [
      `lote-ro-audit-a-ro-auditor\tro-audit-a\t${ahora / 1000 + 600}`,
      `lote-ro-audit-b-ro-auditor\tro-audit-b\t${ahora / 1000 - 60}`,
      `lote-x-t1\tx\t${ahora / 1000 + 600}`
    ].join('\n');
    const borrados = [];
    const docker = async (args) => {
      if (args[0] === 'ps' || (args[1] === 'ls')) return { code: 0, stdout: filas, stderr: '' };
      borrados.push(args.at(-1));
      return { code: 0, stdout: '', stderr: '' };
    };
    await recolectar({ docker, lotesCorriendo: [], raizCopias: path.join(os.tmpdir(), 'no-existe-ro'), ahora: () => ahora });
    check('ro- vigente sobrevive aunque "no corre"', !borrados.includes('lote-ro-audit-a-ro-auditor'));
    check('ro- vencido se poda', borrados.includes('lote-ro-audit-b-ro-auditor'));
    check('un lote que no corre se poda como siempre', borrados.includes('lote-x-t1'));
    borrados.length = 0;
    await recolectar({ docker, soloLectura: true, ahora: () => ahora });
    check('soloLectura: no toca lotes', !borrados.includes('lote-x-t1') && borrados.includes('lote-ro-audit-b-ro-auditor'));
  });

  await group('decidir el modo', async () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-sl-modo-'));
    const sana = async () => ({ sana: true, instalada: true, motivo: null });
    const rota = async () => ({ sana: false, instalada: false, motivo: 'falta la imagen lagrange-lote-agy' });
    try {
      let r = await sl.decidir({ config: {}, env: {}, raiz, comprobar: rota });
      check('auto sin marca y sin infra → host con aviso', r.modo === 'host' && /sin contención/.test(r.aviso));
      r = await sl.decidir({ config: {}, env: {}, raiz, comprobar: sana });
      check('auto con infra sana → contenedor, y deja la marca', r.modo === 'contenedor' && sl.hayMarca(raiz));
      r = await sl.decidir({ config: {}, env: {}, raiz, comprobar: rota });
      check('auto CON marca y sin infra → error, no degrada', r.error && /no se degrada al host/.test(r.error));
      r = await sl.decidir({ config: {}, env: {}, pedido: 'host', raiz, comprobar: rota });
      check('isolation host explícito → host', r.modo === 'host');
      r = await sl.decidir({ config: { readonlyIsolation: 'container' }, env: {}, pedido: 'host', raiz, comprobar: sana });
      check('host pedido con config container → rechazo', r.error && /rechazado/.test(r.error));
      r = await sl.decidir({ config: { readonlyIsolation: 'host' }, env: {}, raiz, comprobar: sana });
      check('config host → host', r.modo === 'host');
      r = await sl.decidir({ config: {}, env: { LAGRANGE_SOLO_LECTURA: 'host' }, raiz, comprobar: sana });
      check('la variable de entorno gana (los tests fuerzan host)', r.modo === 'host');
      fs.rmSync(sl.rutaMarca(raiz));
      r = await sl.decidir({ config: { readonlyIsolation: 'container' }, env: {}, raiz, comprobar: rota });
      check('container sin marca y sin infra → error igual', Boolean(r.error));
      r = await sl.decidir({ config: {}, env: {}, pedido: 'raro', raiz, comprobar: sana });
      check('isolation inválido → error', Boolean(r.error));
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  await group('el ejecutor', async () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-sl-raiz-'));
    const repo = repoTemporal();
    let hex = 0;
    const aleatorio = () => (++hex).toString(16).padStart(6, '0');
    try {
      // Éxito con hilo nuevo.
      const f1 = dockerFalso();
      const pedidos = [];
      const ej = sl.crearEjecutorSoloLectura({
        docker: f1.docker, aWsl: async (p) => `/mnt/fake/${path.basename(p)}`, raiz, aleatorio,
        ejecutarStdin: async (bin, prompt, args, op) => { pedidos.push({ bin, prompt, args, op }); return { success: true, data: { response: 'ok', conversation_id: UUID } }; }
      });
      const r = await ej.correr({ herramienta: 'agy_audit', repo, prompt: 'auditá', modelo: 'gemini-3.1-pro', effort: 'high', timeoutMinutes: 25, denyPaths: ['.env*'] });
      check('éxito', r.success && r.data.response === 'ok', JSON.stringify(r).slice(0, 300));
      check('informa el aislamiento', r.aislamiento && r.aislamiento.modo === 'contenedor' && r.aislamiento.archivos === 1);
      check('lanza wsl -e docker run con el argv de solo lectura', pedidos[0].bin === 'wsl' && pedidos[0].args[0] === '-e' && pedidos[0].args.includes('--read-only'));
      check('el prompt va por stdin', pedidos[0].prompt === 'auditá' && pedidos[0].op.agregarFormatos === false);
      const nombresCall = f1.llamadas.map((a) => a.join(' '));
      check('crea y prepara el volumen del hilo', nombresCall.some((c) => c.startsWith('volume create') && c.includes('ro-hilo-')) && nombresCall.some((c) => c.includes('chown')));
      check('limpia el señuelo al final', nombresCall.some((c) => c.includes('antigravity-oauth-token')));
      check('borra red y contenedores al final', nombresCall.some((c) => c.startsWith('network rm')) && nombresCall.some((c) => c.startsWith('rm -f')));
      check('no deja la instantánea', !fs.readdirSync(raiz).some((n) => n.startsWith('ro-audit')));
      check('anota el hilo', ej.hilos.obtener(UUID) && ej.hilos.obtener(UUID).volumen.startsWith('ro-hilo-'));

      // Retomar: el volumen existe.
      const vol = ej.hilos.obtener(UUID).volumen;
      const f2 = dockerFalso({ volumenesExistentes: new Set([vol]) });
      const pedidos2 = [];
      const ej2 = sl.crearEjecutorSoloLectura({
        docker: f2.docker, aWsl: async (p) => `/mnt/fake/${path.basename(p)}`, raiz, aleatorio,
        ejecutarStdin: async (bin, prompt, args) => { pedidos2.push(args); return { success: true, data: { response: 'seguí', conversation_id: UUID } }; }
      });
      const r2 = await ej2.correr({ herramienta: 'agy_audit', repo, prompt: 'seguí', conversationId: UUID, timeoutMinutes: 25 });
      check('retoma con --conversation sobre el mismo volumen', r2.success && pedidos2[0].at(-1).includes(`--conversation ${UUID}`) && pedidos2[0].includes(`${vol}:/home/agy/.gemini`));
      check('al retomar no borra el volumen', !f2.llamadas.some((a) => a[0] === 'volume' && a[1] === 'rm' && a.at(-1) === vol));

      // Hilo desconocido: error sin lanzar nada.
      const f3 = dockerFalso();
      let lanzo = false;
      const ej3 = sl.crearEjecutorSoloLectura({ docker: f3.docker, aWsl: async () => '/mnt/x', raiz, aleatorio, ejecutarStdin: async () => { lanzo = true; return { success: true }; } });
      const r3 = await ej3.correr({ herramienta: 'agy_audit', repo, prompt: 'x', conversationId: '00000000-0000-0000-0000-000000000000' });
      check('hilo que no nació en el aislamiento → error, sin lanzar', !r3.success && /no existe en el aislamiento/.test(r3.error) && !lanzo);

      // Fallo de agy con hilo nuevo: se borra su volumen.
      const f4 = dockerFalso();
      const ej4 = sl.crearEjecutorSoloLectura({ docker: f4.docker, aWsl: async () => '/mnt/x', raiz, aleatorio, ejecutarStdin: async () => ({ success: false, error: 'agy falló' }) });
      const r4 = await ej4.correr({ herramienta: 'agy_plan', repo, prompt: 'x' });
      const volNuevo = f4.llamadas.find((a) => a[0] === 'volume' && a[1] === 'create').at(-1);
      check('el fallo se propaga', !r4.success && r4.error === 'agy falló');
      check('y el volumen del hilo nuevo se borra', f4.llamadas.some((a) => a[0] === 'volume' && a[1] === 'rm' && a.at(-1) === volNuevo));

      // BE-049 — Corte por --print-timeout con hilo nuevo: es fallo, pero el
      // hilo se tiene que poder retomar, así que su volumen vive y se anota.
      const UUID_PARCIAL = '11111111-2222-4333-8444-555555555555';
      const fp = dockerFalso();
      const ejp = sl.crearEjecutorSoloLectura({
        docker: fp.docker, aWsl: async () => '/mnt/x', raiz, aleatorio,
        ejecutarStdin: async () => ({ success: false, parcial: true, error: 'INCOMPLETE', data: { response: 'mitad', conversation_id: UUID_PARCIAL } })
      });
      const rp = await ejp.correr({ herramienta: 'agy_audit', repo, prompt: 'x' });
      const volParcial = fp.llamadas.find((a) => a[0] === 'volume' && a[1] === 'create' && String(a.at(-1)).startsWith('ro-hilo-')).at(-1);
      check('parcial: se propaga como fallo parcial', !rp.success && rp.parcial === true);
      check('parcial: el volumen del hilo no se borra', !fp.llamadas.some((a) => a[0] === 'volume' && a[1] === 'rm' && a.at(-1) === volParcial));
      check('parcial: el hilo queda anotado para retomar', ejp.hilos.obtener(UUID_PARCIAL) && ejp.hilos.obtener(UUID_PARCIAL).volumen === volParcial);

      // Fallo al preparar (el proxy no arranca): error, limpieza igual.
      const f5 = dockerFalso({ falla: (a) => a[0] === 'network' && a[1] === 'connect' });
      let lanzo5 = false;
      const ej5 = sl.crearEjecutorSoloLectura({ docker: f5.docker, aWsl: async () => '/mnt/x', raiz, aleatorio, ejecutarStdin: async () => { lanzo5 = true; return { success: true }; } });
      const r5 = await ej5.correr({ herramienta: 'agy_review', repo, prompt: 'x' });
      check('fallo al preparar → error y no se lanza agy', !r5.success && /Aislamiento en contenedor/.test(r5.error) && !lanzo5);
      check('y se limpia igual', f5.llamadas.some((a) => a[0] === 'network' && a[1] === 'rm'));

      // Cancelación: terminate hace docker stop.
      const f6 = dockerFalso();
      const ej6 = sl.crearEjecutorSoloLectura({
        docker: f6.docker, aWsl: async () => '/mnt/x', raiz, aleatorio,
        ejecutarStdin: async (bin, prompt, args, op) => { op.terminate({}); return { success: false, cancelled: true, error: 'cancelado' }; }
      });
      const r6 = await ej6.correr({ herramienta: 'agy_audit', repo, prompt: 'x' });
      await new Promise((res) => setTimeout(res, 10));
      check('cancelar para el contenedor', r6.cancelled && f6.llamadas.some((a) => a[0] === 'stop'));
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
