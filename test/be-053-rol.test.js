/**
 * BE-053 — El daemon arranca sin token en `rol = nodo`.
 *
 * Todo lo que importa `bot.js`, `paths.js` o `notify.js` corre en un proceso
 * hijo con `TELEGRAM_BRIDGE_DATA_DIR` temporal: los tres cargan el `.env` al
 * importarse, y sin eso leerían el `.env` real de la máquina.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');
const { resolverBash } = require('../mcp-server/lib/bash');

const REPO_ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(REPO_ROOT, 'telegram-bridge');
const url = (f) => JSON.stringify(pathToFileURL(path.join(BRIDGE, f)).href);

/** Corre `codigo` (módulo ES) en un hijo aislado y devuelve lo que imprima tras `RESULTADO `. */
function enHijo(codigo, { dataDir, env = {} } = {}) {
  const limpio = { ...process.env };
  for (const k of ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS', 'BRIDGE_ROL', 'BRIDGE_WEB', 'TELEGRAM_BOTS', 'TELEGRAM_BRIDGE_ENV_FILE']) delete limpio[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...limpio, TELEGRAM_BRIDGE_DATA_DIR: dataDir, TELEGRAM_BRIDGE_STATE_FILE: path.join(dataDir, 'state.json'), ...env }
  });
  const linea = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RESULTADO '));
  if (!linea) return { error: `${r.stdout || ''}${r.stderr || ''}`.slice(-800) };
  return JSON.parse(linea.slice('RESULTADO '.length));
}

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'be-053-'));
  const nuevoDir = (n) => { const d = path.join(raiz, n); fs.mkdirSync(d, { recursive: true }); return d; };
  try {
    await group('leerRol', () => {
      const r = enHijo(`
        const { leerRol } = await import(${url('paths.js')});
        console.log('RESULTADO ' + JSON.stringify({
          vacio: leerRol({}), espacios: leerRol({ BRIDGE_ROL: ' NODO ' }), solo: leerRol({ BRIDGE_ROL: 'solo' }),
          servidor: leerRol({ BRIDGE_ROL: ' Servidor ' }), foo: leerRol({ BRIDGE_ROL: 'foo' })
        }));
      `, { dataDir: nuevoDir('rol') });
      check('se ejecuta', !r.error, r.error);
      if (r.error) return;
      check('vacío → solo', r.vacio.rol === 'solo' && r.vacio.error === null);
      check('" NODO " → nodo', r.espacios.rol === 'nodo');
      check('solo → solo', r.solo.rol === 'solo');
      check('servidor → servidor (FEAT-089)', r.servidor.rol === 'servidor' && r.servidor.error === null, r.servidor.error);
      check('foo → error con la lista', r.foo.rol === null && /solo, nodo, servidor/.test(r.foo.error), r.foo.error);
    });

    await group('planDeArranque', () => {
      const r = enHijo(`
        const { planDeArranque } = await import(${url('bot.js')});
        const T = '1234567890:AAFakeTokenForTestingOnly_DoNotUse';
        console.log('RESULTADO ' + JSON.stringify({
          soloSinToken: planDeArranque({}),
          soloConToken: planDeArranque({ TELEGRAM_BOT_TOKEN: T, ALLOWED_USER_IDS: '1', BRIDGE_WEB: '1' }),
          soloSinUsuarios: planDeArranque({ TELEGRAM_BOT_TOKEN: T }),
          nodoSinToken: planDeArranque({ BRIDGE_ROL: 'nodo' }),
          nodoConToken: planDeArranque({ BRIDGE_ROL: 'nodo', TELEGRAM_BOT_TOKEN: T }),
          nodoConWeb: planDeArranque({ BRIDGE_ROL: 'nodo', BRIDGE_WEB: '1' }),
          servidor: planDeArranque({ BRIDGE_ROL: 'servidor', TELEGRAM_BOT_TOKEN: T, ALLOWED_USER_IDS: '1' })
        }));
      `, { dataDir: nuevoDir('plan') });
      check('se ejecuta', !r.error, r.error);
      if (r.error) return;
      check('solo sin token → fatal, como hoy', /TELEGRAM_BOT_TOKEN/.test(r.soloSinToken.fatal || ''), r.soloSinToken.fatal);
      const s = r.soloConToken;
      check('solo con token → polling, web según BRIDGE_WEB, sin mantenerVivo', s.polling && s.web && !s.mantenerVivo && !s.fatal && s.token);
      check('solo sin ALLOWED_USER_IDS → aviso', r.soloSinUsuarios.avisos.some((a) => /ALLOWED_USER_IDS/.test(a)));
      const n = r.nodoSinToken;
      check('nodo sin token → sin fatal, sin polling ni web, mantenerVivo', !n.fatal && !n.polling && !n.web && n.mantenerVivo && n.rol === 'nodo');
      check('nodo sin token no avisa de ALLOWED_USER_IDS', n.avisos.length === 0, n.avisos.join(' | '));
      const nt = r.nodoConToken;
      check('nodo con token → aviso de token ignorado, token null, sin polling',
        nt.avisos.some((a) => /se ignora/.test(a)) && nt.token === null && !nt.polling);
      check('nodo con BRIDGE_WEB=1 → aviso, web false', r.nodoConWeb.avisos.some((a) => /consola/.test(a)) && r.nodoConWeb.web === false);
      check('servidor sin BRIDGE_WEB=1 → fatal (FEAT-089)', /BRIDGE_WEB=1/.test(r.servidor.fatal || ''), r.servidor.fatal);
    });

    await group('Lock con rol', () => {
      const dir = nuevoDir('lock');
      const r = enHijo(`
        import fs from 'node:fs';
        import path from 'node:path';
        const { datosDeLock, mensajeLockOcupado } = await import(${url('bot.js')});
        const { estadoDaemon } = await import(${url('paths.js')});
        const dir = process.env.TELEGRAM_BRIDGE_DATA_DIR;
        const escrito = datosDeLock('nodo');
        fs.writeFileSync(path.join(dir, 'bridge.lock'), JSON.stringify(escrito));
        const conRol = estadoDaemon({ dataDir: dir });
        const { rol, ...sinRol } = escrito;
        fs.writeFileSync(path.join(dir, 'bridge.lock'), JSON.stringify(sinRol));
        const viejo = estadoDaemon({ dataDir: dir });
        fs.writeFileSync(path.join(dir, 'bridge.lock'), String(process.pid));
        const legado = estadoDaemon({ dataDir: dir });
        fs.unlinkSync(path.join(dir, 'bridge.lock'));
        const sinLock = estadoDaemon({ dataDir: dir });
        const lock = { pid: 42, startedAt: 'ayer' };
        console.log('RESULTADO ' + JSON.stringify({
          escrito, conRol: conRol.rol, viejo: viejo.rol, legado: legado.rol, sinLock: sinLock.rol,
          soloSolo: mensajeLockOcupado({ lock: { ...lock, rol: 'solo' }, file: 'f', rolActual: 'solo', dataDir: dir }),
          nodoNodo: mensajeLockOcupado({ lock: { ...lock, rol: 'nodo' }, file: 'f', rolActual: 'nodo', dataDir: dir }),
          viejoNodo: mensajeLockOcupado({ lock, file: 'f', rolActual: 'nodo', dataDir: dir })
        }));
      `, { dataDir: dir });
      check('se ejecuta', !r.error, r.error);
      if (r.error) return;
      check('el JSON del lock lleva rol', r.escrito.rol === 'nodo' && Number.isInteger(r.escrito.pid));
      check('estadoDaemon devuelve el rol del lock', r.conRol === 'nodo', r.conRol);
      check('un lock JSON sin rol se lee solo', r.viejo === 'solo', r.viejo);
      check('un lock legado (solo el PID) se lee solo', r.legado === 'solo', r.legado);
      check('sin lock, rol null', r.sinLock === null);
      check('solo contra solo: el texto de 409 de siempre', r.soloSolo.some((l) => /409/.test(l)));
      check('nodo contra nodo: habla del directorio de datos y nombra el rol',
        r.nodoNodo.some((l) => /directorio de datos/.test(l) && /rol nodo/.test(l)) && !r.nodoNodo.some((l) => /409/.test(l)));
      check('lock de otro rol: lo nombra', r.viejoNodo.some((l) => /rol solo/.test(l)) && r.viejoNodo.some((l) => /Este arranque es rol nodo/.test(l)), r.viejoNodo.join(' | '));
    });

    await group('Programaciones en un nodo: se posponen sin contar fallo', () => {
      const r = enHijo(`
        const botMod = await import(${url('bot.js')});
        const prog = await import(${url('programaciones.js')});
        const f = (h) => new Date(2026, 8, 26, h, 0);
        const p = prog.crear({ titulo: 'guardia', pedido: 'p', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' }, horario: 'cada 1h', origen: 'web', ahora: () => f(1) }).programacion;
        const res = await botMod.dispararProgramacion(p, { ahora: () => f(3) });
        const despues = prog.obtener(p.id);
        console.log('RESULTADO ' + JSON.stringify({ res, despues }));
      `, { dataDir: nuevoDir('prog') });
      check('se ejecuta', !r.error, r.error);
      if (r.error) return;
      check('sin canal web ni ALLOWED_USER_IDS → "sin destino"', r.res.ok === false && r.res.motivo === 'sin destino', JSON.stringify(r.res));
      check('no cuenta fallo', (r.despues.fallosSeguidos || 0) === 0);
      check('queda el motivo "no hay a quién avisarle"', JSON.stringify(r.despues).includes('no hay a quién avisarle'));
      check('no cuenta disparo', (r.despues.disparos || 0) === 0);
    });

    await group('Consulta de los instaladores (paths.js --informe-env)', () => {
      const datos = nuevoDir('informe');
      const envNodo = path.join(datos, '.env');
      fs.writeFileSync(envNodo, 'BRIDGE_ROL=nodo\n');
      const limpio = { ...process.env };
      for (const k of ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS', 'BRIDGE_ROL', 'TELEGRAM_BRIDGE_ENV_FILE']) delete limpio[k];
      // Un directorio del bridge sin .env propio: gana el del directorio de datos.
      const falso = nuevoDir('bridge-falso/telegram-bridge');
      const correr = (extraEnv = {}) => execFileSync(process.execPath, [path.join(BRIDGE, 'paths.js'), '--informe-env', falso], {
        encoding: 'utf8', env: { ...limpio, TELEGRAM_BRIDGE_DATA_DIR: datos, ...extraEnv }
      });
      const salida = correr();
      check('encuentra el .env que solo está en el directorio de datos', salida.includes(`USA\t${envNodo}`), salida);
      check('devuelve el rol del .env', /^ROL\tnodo$/m.test(salida), salida);
      check('informa que no hay token (sin revelar nada)', /^TOKEN\t0$/m.test(salida));
      fs.writeFileSync(path.join(falso, '.env'), 'TELEGRAM_BOT_TOKEN=1:x\nALLOWED_USER_IDS=1\n');
      const dos = correr();
      check('con dos .env gana el del bridge, en el orden de paths.js', dos.includes(`USA\t${path.join(falso, '.env')}`) && dos.includes(`IGNORA\t${envNodo}`), dos);
      check('y el rol es el del ganador', /^ROL\tsolo$/m.test(dos) && /^TOKEN\t1$/m.test(dos));
      check('no imprime valores', !dos.includes('1:x'));
      fs.unlinkSync(path.join(falso, '.env'));
      const malo = correr({ BRIDGE_ROL: 'foo' });
      check('un rol inválido sale como ERROR', /^ERROR\tBRIDGE_ROL=foo no es un rol válido/m.test(malo), malo);
      fs.unlinkSync(envNodo);
      const nada = correr();
      check('sin .env: NINGUNO y la ruta duradera', /^NINGUNO\t-$/m.test(nada) && nada.includes(`DURADERO\t${envNodo}`), nada);
    });

    await group('Instaladores: estático', () => {
      const ps1 = fs.readFileSync(path.join(BRIDGE, 'daemon.ps1'), 'utf8');
      const sh = fs.readFileSync(path.join(BRIDGE, 'daemon.sh'), 'utf8');
      check('daemon.ps1 usa la consulta de paths.js', /paths\.js'\)\s+'--informe-env'/.test(ps1));
      check('daemon.ps1 ya no arma su propia lista de .env', !/\$envRoot/.test(ps1) && !/\$envLocal/.test(ps1));
      check('daemon.ps1 condiciona el token al rol', /if \(\$rol -ne 'nodo'\)/.test(ps1));
      check('daemon.ps1 sigue guardado en UTF-8 con BOM', fs.readFileSync(path.join(BRIDGE, 'daemon.ps1'))[0] === 0xEF);
      check('daemon.sh usa la consulta de paths.js', /paths\.js" --informe-env/.test(sh));
      check('los dos dicen cómo instalar un nodo sin .env', /BRIDGE_ROL=nodo en/.test(ps1) && /BRIDGE_ROL=nodo en/.test(sh));
      check('daemon.sh tiene el mensaje de WSL', /systemd=true/.test(sh) && /wsl --shutdown/.test(sh));
    });

    await group('daemon.sh: mensaje de WSL sin systemd', () => {
      const BASH = resolverBash();
      if (!BASH) { check('omitido, sin bash de Git', true); return; }
      const dir = nuevoDir('wsl');
      const procWsl = path.join(dir, 'version-wsl');
      const procLinux = path.join(dir, 'version-linux');
      fs.writeFileSync(procWsl, 'Linux version 6.6.87.2-microsoft-standard-WSL2\n');
      fs.writeFileSync(procLinux, 'Linux version 6.8.0-generic\n');
      const script = path.join(dir, 'probar.sh');
      const sh = path.join(BRIDGE, 'daemon.sh').replace(/\\/g, '/');
      fs.writeFileSync(script, [
        '#!/usr/bin/env bash',
        "C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_OFF=''",
        `eval "$(sed -n '/^info()/,/^fail()/p' "${sh}")"`,
        `eval "$(sed -n '/^es_wsl()/,/^}/p' "${sh}")"`,
        `eval "$(sed -n '/^require_systemd()/,/^}/p' "${sh}")"`,
        // Sin systemctl: se lo tapa con una función que falla.
        'systemctl() { return 1; }',
        'require_systemd'
      ].join('\n'));
      const correr = (proc) => spawnSync(BASH, [script], { encoding: 'utf8', env: { ...process.env, PROC_VERSION: proc.replace(/\\/g, '/') } });
      const wsl = correr(procWsl);
      check('en WSL sugiere systemd=true en /etc/wsl.conf', /systemd=true/.test(wsl.stderr) && /wsl --shutdown/.test(wsl.stderr), wsl.stderr);
      const linux = correr(procLinux);
      check('fuera de WSL sigue sugiriendo linger', /enable-linger/.test(linux.stderr) && !/wsl\.conf/.test(linux.stderr), linux.stderr);
    });

    await group('daemon.ps1: Test-Prerequisites con un nodo', () => {
      const ps = ['powershell', 'pwsh'].find((exe) => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']).status === 0);
      if (!ps) { check('omitido, sin PowerShell', true); return; }
      const datos = nuevoDir('ps-datos');
      const probar = (contenido) => {
        if (contenido === null) { try { fs.unlinkSync(path.join(datos, '.env')); } catch {} }
        else fs.writeFileSync(path.join(datos, '.env'), contenido);
        // Se cargan las funciones REALES del script (sin ejecutar su switch final).
        const cmd = [
          "$ErrorActionPreference = 'Stop'",
          `$BridgeDir = '${BRIDGE.replace(/'/g, "''")}'`,
          "$BotScript = Join-Path $BridgeDir 'bot.js'",
          `$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $BridgeDir 'daemon.ps1'), [ref]$null, [ref]$null)`,
          "$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object { $_.Name -in @('Info','Ok','Warn','Fail','Get-NodePath','Test-Prerequisites') }",
          'foreach ($f in $fns) { . ([scriptblock]::Create($f.Extent.Text)) }',
          '$null = Test-Prerequisites',
          "Write-Host 'PASO'"
        ].join('; ');
        const limpio = { ...process.env };
        for (const k of ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS', 'BRIDGE_ROL', 'TELEGRAM_BRIDGE_ENV_FILE']) delete limpio[k];
        return spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
          encoding: 'utf8', timeout: 60000, env: { ...limpio, TELEGRAM_BRIDGE_DATA_DIR: datos }
        });
      };
      // El bridge del repo no tiene .env propio en CI; si lo tuviera, ganaría él.
      if (fs.existsSync(path.join(BRIDGE, '.env')) || fs.existsSync(path.join(REPO_ROOT, '.env'))) {
        check('omitido: hay un .env junto al código que taparía al del directorio de datos', true);
        return;
      }
      const nodo = probar('BRIDGE_ROL=nodo\n');
      const salidaNodo = `${nodo.stdout}${nodo.stderr}`;
      check('encuentra el .env del directorio de datos y no exige token con rol nodo', nodo.status === 0 && /PASO/.test(salidaNodo) && /rol nodo/.test(salidaNodo), salidaNodo.slice(-600));
      const solo = probar('ALLOWED_USER_IDS=1\n');
      check('en solo sigue exigiendo el token', solo.status !== 0 && /Falta TELEGRAM_BOT_TOKEN/.test(`${solo.stdout}${solo.stderr}`), `${solo.stdout}${solo.stderr}`.slice(-400));
      const nada = probar(null);
      const salidaNada = `${nada.stdout}${nada.stderr}`;
      check('sin .env falla y nombra la ruta duradera y cómo instalar un nodo', nada.status !== 0 && /BRIDGE_ROL=nodo en/.test(salidaNada), salidaNada.slice(-400));
    });

    await group('actualizarDaemon con rol nodo', async () => {
      const { actualizarDaemon } = await import(pathToFileURL(path.join(BRIDGE, 'actualizar.js')).href);
      let t = 0;
      const verbos = [];
      const lineas = [];
      let estado = { vivo: true, pid: 100, rol: 'nodo' };
      let web = 0;
      const codigo = await actualizarDaemon({
        correrVerbo: async (v) => { verbos.push(v); if (v === 'stop') estado = { vivo: false, pid: null, rol: null }; return 0; },
        mostrarLink: async () => { web++; return 0; },
        leerAccesoWeb: () => { web++; return null; },
        estadoDaemon: () => { if (verbos.includes('start') && t >= 1000) estado = { vivo: true, pid: 200, rol: 'nodo' }; return estado; },
        rolSinDaemon: () => 'solo',
        log: (l) => lineas.push(l),
        ahora: () => t,
        dormir: async (ms) => { t += ms; }
      });
      check('termina bien', codigo === 0);
      check('stop y start', verbos.join(',') === 'stop,start');
      check('termina al ver otro PID en el lock, con rol nodo', lineas.some((l) => /PID 200/.test(l) && /rol nodo/.test(l)), lineas.join(' | '));
      check('no espera la consola ni muestra un link', web === 0);
      check('no sugiere BRIDGE_WEB', !lineas.some((l) => /BRIDGE_WEB/.test(l)));

      // Sin daemon vivo, el rol sale del .env.
      t = 0; verbos.length = 0; lineas.length = 0;
      estado = { vivo: false, pid: null, rol: null };
      const sinDaemon = await actualizarDaemon({
        correrVerbo: async (v) => { verbos.push(v); return 0; },
        mostrarLink: async () => 0,
        leerAccesoWeb: () => null,
        estadoDaemon: () => (verbos.includes('start') ? { vivo: true, pid: 300, rol: 'nodo' } : estado),
        rolSinDaemon: () => 'nodo',
        log: (l) => lineas.push(l),
        ahora: () => t,
        dormir: async (ms) => { t += ms; }
      });
      check('sin daemon previo usa el rol del .env', sinDaemon === 0 && lineas.some((l) => /PID 300/.test(l)), lineas.join(' | '));

      // Si nunca aparece, falla en vez de quedarse esperando.
      t = 0; lineas.length = 0;
      const nunca = await actualizarDaemon({
        correrVerbo: async () => 0,
        mostrarLink: async () => 0,
        leerAccesoWeb: () => null,
        estadoDaemon: () => ({ vivo: false, pid: null, rol: null }),
        rolSinDaemon: () => 'nodo',
        log: (l) => lineas.push(l),
        ahora: () => t,
        dormir: async (ms) => { t += ms; }
      });
      check('sin lock nuevo, sale con error y manda a los logs', nunca === 1 && lineas.some((l) => /bridge:daemon:logs/.test(l)));
    });

    await group('notify.js en un nodo', () => {
      const dir = nuevoDir('notify');
      fs.writeFileSync(path.join(dir, '.env'), 'BRIDGE_ROL=nodo\n');
      const r = enHijo(`
        const n = await import(${url('notify.js')});
        let texto = null;
        try { await n.sendTelegramNotification({ message: 'hola' }); } catch (e) { texto = e.message; }
        console.log('RESULTADO ' + JSON.stringify({ texto, solo: n.errorSinCredenciales('x', {}) }));
      `, { dataDir: dir });
      check('se ejecuta', !r.error, r.error);
      if (r.error) return;
      check('el error dice que es un nodo y que Telegram llega por el servidor', /nodo/.test(r.texto || '') && /FEAT-089/.test(r.texto || ''), r.texto);
      check('no manda a configurar un .env', !/Para que las credenciales sobrevivan/.test(r.texto || ''));
      check('en solo no cambia nada', r.solo === null);
    });

    // BE-097 — Con un .env cargado al que le falta algo, el error nombra ese archivo.
    await group('BE-097: notify.js con un .env cargado sin ALLOWED_USER_IDS ni token', () => {
      const dir = nuevoDir('notify-097');
      fs.writeFileSync(path.join(dir, '.env'), 'BRIDGE_ROL=solo\n');
      const r = enHijo(`
        const n = await import(${url('notify.js')});
        let sinUsuarios = null;
        try { await n.sendTelegramNotification({ message: 'hola' }); } catch (e) { sinUsuarios = e.message; }
        let sinToken = null;
        try { await n.sendTelegramNotification({ message: 'hola', targetChatId: '1' }); } catch (e) { sinToken = e.message; }
        console.log('RESULTADO ' + JSON.stringify({ sinUsuarios, sinToken }));
      `, { dataDir: dir });
      check('se ejecuta', !r.error, r.error);
      if (r.error) return;
      const env = path.join(dir, '.env');
      for (const [caso, texto] of [['sin ALLOWED_USER_IDS', r.sinUsuarios], ['sin token', r.sinToken]]) {
        check(`${caso}: nombra el .env cargado`, (texto || '').includes(env) && /Se usó el \.env de/.test(texto || ''), texto);
        check(`${caso}: no dice "No se encontró ningún .env"`, !/No se encontró ningún \.env/.test(texto || ''));
        check(`${caso}: no sugiere moverlo (ya es el duradero)`, !/conviene moverlo/.test(texto || ''));
      }
    });
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
