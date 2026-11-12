'use strict';

/**
 * BE-173 - Segunda rebanada: `telegram_bridge_status`.
 *
 * Diagnostico de solo lectura del bridge de Telegram: servicio, daemon vivo,
 * rol, consola web, copias de codigo, credenciales, estado compartido,
 * versiones, bots y red. Vive fuera de `index.js` para poder probarlo sin
 * arrancar el MCP; el `switch` de `handleToolCall` sigue siendo la tabla de
 * ruteo y delega aca.
 *
 * El cuerpo se movio 1:1. Las dependencias entran por parametro
 * (`{ config, loadConfig, recall, instalaciones, bridgeDir, propiaDir,
 * platform, execFileSync }`) para inyectar dobles en los tests; `bridgeDir` y
 * `propiaDir` tienen como default las rutas reales desde `mcp-server/tools/`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync: execFileSyncPorDefecto } = require('node:child_process');

async function manejarEstadoBridge(args, deps = {}) {
  const {
    config = {},
    loadConfig,
    recall,
    instalaciones,
    bridgeDir = path.join(__dirname, '..', '..', 'telegram-bridge'),
    propiaDir = path.join(__dirname, '..', '..'),
    platform = process.platform,
    execFileSync = execFileSyncPorDefecto
  } = deps;


  // Import dinamico de un modulo ESM desde este servidor CommonJS. Se
  // prefiere a duplicar la resolucion de rutas: si las dos copias
  // discreparan, esta herramienta mentiria precisamente sobre lo que existe
  // para detectar discrepancias.
  let rutas;
  try {
    const { pathToFileURL } = require('node:url');
    rutas = await import(pathToFileURL(path.join(bridgeDir, 'paths.js')).href);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `No se pudo cargar telegram-bridge/paths.js: ${err.message}` }]
    };
  }

  const dataDir = rutas.bridgeDataDirPath();
  const stateFile = path.join(dataDir, 'state.json');
  const lockFile = path.join(dataDir, 'bridge.lock');

  // De donde saldria el bot si lo arrancara la tarea programada. Es LA
  // comparacion que importa: el daemon guarda una ruta absoluta y puede
  // apuntar a una copia distinta de la que sirve estas herramientas.
  let daemonDir = null;
  let daemonTaskState = null;
  let gestorServicios = null;

  if (platform === 'win32') {
    gestorServicios = 'Task Scheduler';
    try {
      const ps = execFileSync('powershell', [
        '-NoProfile', '-Command',
        "$t = Get-ScheduledTask -TaskName 'AntigravityTelegramBridge' -ErrorAction SilentlyContinue; " +
        "if ($t) { \"$($t.State)`n$($t.Actions.Arguments)\" }"
      ], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }).trim();
      if (ps) {
        const [estado, taskArgs] = ps.split(/\r?\n/);
        daemonTaskState = estado || null;
        const m = (taskArgs || '').match(/"?([A-Za-z]:[\\/][^"]*?)[\\/]daemon-hidden\.vbs"?/i)
          || (taskArgs || '').match(/"?([A-Za-z]:[\\/][^"]*?)[\\/]bot\.js"?/i);
        if (m) daemonDir = m[1];
      }
    } catch {}
  } else if (platform === 'linux') {
    gestorServicios = 'systemd --user';
    try {
      // `WorkingDirectory` es la ruta que daemon.sh escribe en la unidad, y
      // es la que interesa: revela desde que copia del bridge se registro.
      const out = execFileSync('systemctl', [
        '--user', 'show', 'lagrange-telegram-bridge.service',
        '-p', 'ActiveState', '-p', 'WorkingDirectory', '-p', 'LoadState'
      ], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const campos = Object.fromEntries(
        out.trim().split(/\r?\n/).map(l => {
          const i = l.indexOf('=');
          return i === -1 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)];
        })
      );
      if (campos.LoadState && campos.LoadState !== 'not-found') {
        daemonTaskState = campos.ActiveState || null;
        if (campos.WorkingDirectory) daemonDir = campos.WorkingDirectory;
      }
    } catch {}
  }

  // El mismo criterio con el que `telegram_ask` decide si puede preguntar
  // (paths.js): si divergieran, status diría «vivo» y el ask se negaría.
  const daemon = rutas.estadoDaemon({ dataDir });
  const botVivo = daemon.vivo;
  const lock = daemon.pid !== null ? { pid: daemon.pid, startedAt: daemon.startedAt } : null;
  // BE-053 — El rol del daemon vivo (del lock); sin daemon, el del `.env`.
  const rolDaemon = (botVivo && daemon.rol) || rutas.informeEnv(bridgeDir).rol || 'solo';

  let stateInfo = null;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    stateInfo = {
      chats: Object.keys(s.chats || {}).length,
      asksPendientes: Object.values(s.pendingAsks || {}).filter(a => a.status === 'pending').length,
      // BE-051 — Lo que sigue en la forma de antes. Si aparece después de
      // reiniciar el daemon, hay un notify.js viejo (el plugin instalado)
      // escribiendo: reacciones sin bot y preguntas sin `botId`.
      reaccionesViejas: Object.keys(s.reaccionables || {})
        .filter(k => !k.startsWith('web:') && !/^\d+:-?\d+:\d+$/.test(k)).length,
      asksSinBot: Object.values(s.pendingAsks || {}).filter(a => a && !a.botId).length
    };
  } catch {}

  // FEAT-052 — Solo si está activa y dónde; el link con token no sale acá.
  let web = null;
  try {
    const { pathToFileURL } = require('node:url');
    const { leerAccesoWeb } = await import(pathToFileURL(path.join(bridgeDir, 'web', 'acceso.js')).href);
    web = leerAccesoWeb({ dataDir });
  } catch {}

  const envCandidatos = rutas.bridgeEnvCandidates(bridgeDir);
  const envActivo = envCandidatos.find(f => fs.existsSync(f)) || null;
  const envDuradero = path.join(dataDir, '.env');

  // El .env que usaria el DAEMON, que puede salir de otra copia del codigo
  // y por tanto de otro fichero. Es el mismo desfase que se arreglo para
  // state.json, pero en credenciales, y no se ve desde ningun lado: cada
  // mitad lee el suyo y ninguna sabe de la otra.
  let envDaemon = null;
  if (daemonDir) {
    try {
      envDaemon = rutas.bridgeEnvCandidates(daemonDir).find(f => fs.existsSync(f)) || null;
    } catch {}
  }
  const norm2 = (p) => p ? path.resolve(p).replace(/\\/g, '/').toLowerCase() : null;
  const envDistinto = envDaemon && envActivo && norm2(envDaemon) !== norm2(envActivo);
  let envIguales = null;
  if (envDistinto) {
    // Se comparan los BYTES, nunca el contenido: si son copias identicas la
    // division es inofensiva, y si difieren hay que decirlo sin revelar nada.
    try {
      envIguales = fs.readFileSync(envDaemon).equals(fs.readFileSync(envActivo));
    } catch { envIguales = null; }
  }

  const norm = (p) => p ? path.resolve(p).replace(/\\/g, '/').toLowerCase() : null;
  const mismaCopia = daemonDir ? norm(daemonDir) === norm(bridgeDir) : null;
  const enCopiaGestionada = /(\.claude|claude)\/plugins\/(cache|marketplaces)\//i.test(norm(bridgeDir) || '');

  let out = '### 🌉 Estado del Telegram Bridge\n\n';

  out += '**Daemon**\n';
  if (daemonTaskState) {
    out += `- Servicio (${gestorServicios}): \`${daemonTaskState}\`\n`;
    out += `- Bot en ejecución: ${botVivo ? `✅ PID ${lock.pid} (desde ${lock.startedAt || 'desconocido'})` : '❌ no hay proceso vivo'}\n`;
  } else if (gestorServicios) {
    out += `- Servicio (${gestorServicios}): _no registrado_ (\`npm run bridge:daemon:install\` desde un clon)\n`;
    if (botVivo) {
      out += `- Bot en ejecución: ✅ PID ${lock.pid} — arrancado a mano, no por el gestor de servicios\n`;
    }
  } else {
    // macOS y cualquier otra: el bridge funciona, solo que sin daemon.
    out += `- Servicio: _no hay gestor soportado en ${platform}_ (arráncalo con \`npm run bridge\`)\n`;
    out += `- Bot en ejecución: ${botVivo ? `✅ PID ${lock.pid} (desde ${lock.startedAt || 'desconocido'})` : '❌ no hay proceso vivo'}\n`;
  }

  out += `- Rol: \`${rolDaemon}\`${botVivo ? '' : ' _(del `.env`; no hay daemon vivo)_'}\n`;
  if (rolDaemon === 'nodo') {
    out += '- Consola web: _no aplica_ — los nodos no sirven consola (se ve desde la del servidor)\n';
    // FEAT-089 — Emparejamiento y conexión, de `nodo.json` y `enlace.json`.
    let red = null;
    try {
      const { pathToFileURL } = require('node:url');
      red = (await import(pathToFileURL(path.join(bridgeDir, 'red', 'admin.js')).href)).estado(dataDir);
    } catch {}
    if (!red || !red.emparejado) {
      out += '- Telegram: ⚠️ este nodo no está emparejado (`npm run bridge:nodo -- unirse <url> <código>`)\n';
    } else {
      const conexion = red.conectado ? '✅ conectado' : `❌ desconectado${red.estado ? ` (${red.estado})` : ''}`;
      out += `- Servidor de la red: ${red.servidor} — ${conexion}; este nodo es \`${red.nombre}\`\n`;
      out += '- Telegram: sale por el bot del servidor, con el prefijo del nodo\n';
    }
  } else if (web && web.vivo) {
    out += `- Consola web: ✅ ${web.url} (link de acceso: \`npm run bridge:web\` o \`/web\` en Telegram)\n`;
    // FEAT-170 — La del teléfono, por Tailscale Serve. La pista de un 403 por usuario está en /logs.
    if (web.tailnet?.url) out += `- Teléfono (Tailscale): ✅ ${web.tailnet.url} para ${web.tailnet.usuario} → 127.0.0.1:${web.tailnet.puerto} (link con \`/web\` en Telegram; si da 403, mirá \`/logs\`)\n`;
    else if (web.tailnet?.apagado) out += `- Teléfono (Tailscale): ⚠️ apagado — ${web.tailnet.apagado}\n`;
  } else if (web) {
    out += '- Consola web: ⚠️ quedó el archivo de acceso de un daemon que ya no corre\n';
  } else {
    out += '- Consola web: _apagada_ (`BRIDGE_WEB=1` en el `.env` para activarla)\n';
  }

  out += '\n**Qué código corre cada mitad**\n';
  out += `- Herramientas MCP: \`${bridgeDir}\`${enCopiaGestionada ? ' _(copia gestionada del plugin)_' : ''}\n`;
  out += `- Daemon del bot: ${daemonDir ? `\`${daemonDir}\`` : '_desconocido_'}\n`;
  if (mismaCopia === true) {
    out += '- ✅ Ambas mitades corren la misma copia.\n';
  } else if (mismaCopia === false) {
    out += '- ⚠️ **Corren copias distintas.** El estado y las credenciales se comparten, así que\n';
    out += '  el human-in-the-loop funciona igual; pero un cambio de código solo lo verá la mitad\n';
    out += '  que lo tenga. Si algo no se comporta como esperas tras editar o actualizar, es aquí.\n';
  }

  // FEAT-095 — Versiones: esta sesión, el daemon y lo instalado en cada cuenta. Solo lee
  // `package.json` y `plugins/installed_plugins.json`; un fallo aquí no tumba el diagnóstico.
  try {
    const versionDe = (dir) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null; } catch { return null; }
    };
    const propia = versionDe(propiaDir);
    const versionDaemon = daemonDir ? versionDe(path.dirname(daemonDir)) : null;
    const fuentesCuentas = recall.fuentes({ cuentas: (config.motores && config.motores.cuentas) || {}, env: process.env });
    const instaladas = instalaciones.versionesInstaladas({ todas: fuentesCuentas.todas, actual: fuentesCuentas.actual });
    // FEAT-191 — Con agy en modo manual, ni el daemon ni el bot lanzan agy.
    if (require('../lib/agy-modo.js').enModoManual()) out += '\n**agy: modo manual** (FEAT-191): Lagrange no lanza agy; lo corrés vos en tu terminal.\n';
    out += '\n**Versiones de Lagrange**\n';
    out += `- Esta sesión (herramientas MCP): ${propia ? `\`${propia}\`` : '_desconocida_'}\n`;
    out += `- Daemon del bot: ${versionDaemon ? `\`${versionDaemon}\`` : '_desconocida_'}\n`;
    for (const i of instaladas) {
      const marca = i.propia ? ' _(esta sesión)_' : '';
      let detalle;
      if (i.estado === 'instalado') detalle = `\`${i.version}\`${i.sha ? ` (${i.sha})` : ''}`;
      else if (i.estado === 'sin-plugin') detalle = '_Lagrange no está instalado_';
      else if (i.estado === 'sin-carpeta') detalle = '_la carpeta no existe desde aquí_';
      else if (i.estado === 'ambiguo') detalle = `_varias instalaciones, no se elige una:_ ${i.claves.map((c) => `${c.clave} ${c.version || '?'}`).join(', ')}`;
      else detalle = '_no se pudo leer el registro de plugins_';
      out += `- Cuenta \`${i.cuenta}\`${marca}: ${detalle} — \`${i.dir}\`\n`;
    }
    const avisos = instalaciones.avisosDeDeriva({ propia, daemon: versionDaemon, instalaciones: instaladas });
    for (const a of avisos) out += `- ⚠️ ${a}\n`;
    // Solo se confirma lo que se pudo comparar: con el daemon o esta sesión desconocidos, no.
    if (!avisos.length) {
      const datosVersiones = { propia, daemon: versionDaemon, instalaciones: instaladas };
      if (instalaciones.sinDeriva(datosVersiones)) out += '- ✅ Sin deriva: la sesión, el daemon y las cuentas están en la misma versión.\n';
      else if (instalaciones.todoComparable(datosVersiones)) out += '- ℹ️ Las versiones no coinciden, pero nada pide actualizarse (algo está adelantado respecto del resto).\n';
      else out += '- ℹ️ Sin avisos, pero no se pudo comparar todo (falta una versión o no es x.y.z, o el registro de una cuenta no se pudo leer).\n';
    }
  } catch {}

  out += '\n**Credenciales (.env)**\n';
  out += envActivo ? `- Herramientas MCP usan: \`${envActivo}\`\n` : '- ⚠️ No se encontró ningún `.env` para las herramientas MCP.\n';
  if (envDaemon) out += `- Daemon del bot usa: \`${envDaemon}\`\n`;

  if (envDistinto) {
    out += '- ⚠️ **Cada mitad lee un `.env` distinto.**';
    if (envIguales === true) {
      out += ' Ahora mismo son idénticos, así que no hay síntoma —\n';
      out += '  pero editar uno solo los desincroniza sin que nada lo avise.\n';
    } else if (envIguales === false) {
      out += ' **Y su contenido NO coincide.**\n';
      out += '  Si difieren en el token o en `ALLOWED_USER_IDS`, el bot y las notificaciones\n';
      out += '  actúan como dos bots distintos. Borra el que sobre y deja solo el duradero.\n';
    } else {
      out += ' No se pudo comparar su contenido.\n';
    }
    out += `  El duradero, que ambas mitades comparten, es: \`${envDuradero}\`\n`;
  } else if (envActivo && path.resolve(envActivo) !== path.resolve(envDuradero)) {
    out += `- ℹ️ Ubicación duradera recomendada: \`${envDuradero}\`\n`;
    out += '  (un `.env` dentro del directorio de una versión se pierde en el próximo `claude plugin update`)\n';
  } else if (envActivo) {
    out += '- ✅ En la ubicación duradera: sobrevive a `claude plugin update`.\n';
  }

  // FEAT-091 — Los bots del .env que usa el daemon (o el de las
  // herramientas). Sin tokens: nombre, id, vínculo y usuarios, y los
  // descartados con su motivo. Si su polling anda lo dice el banner.
  try {
    const { pathToFileURL } = require('node:url');
    const { leerBots, describirBot } = await import(pathToFileURL(path.join(bridgeDir, 'bots.js')).href);
    const envBots = envDaemon || envActivo;
    if (envBots && typeof require('node:util').parseEnv === 'function') {
      // BE-065 — Con el rol del daemon: sin él, los bots de nodo salen como descartados.
      const { bots, errores } = leerBots(require('node:util').parseEnv(fs.readFileSync(envBots, 'utf8')), { rol: rolDaemon });
      out += '\n**Bots de Telegram**\n';
      for (const b of bots) out += `- ${describirBot(b)}\n`;
      for (const e of errores) out += `- ⚠️ ${e}\n`;
      // FEAT-166 — Solo si está; sin el valor y sin red (esta tool es local: el saldo está en la consola).
      const envKeys = require('node:util').parseEnv(fs.readFileSync(envBots, 'utf8'));
      const hayDeepseek = Boolean(String(envKeys.DEEPSEEK_API_KEY || '').trim());
      out += `- DeepSeek (motor de almas, FEAT-166): ${hayDeepseek ? 'key configurada' : '_sin `DEEPSEEK_API_KEY`_'}\n`;
      // FEAT-173 — Solo si está la key, algún rol usa el motor o es el fallback (BE-155); sin red, como la de DeepSeek.
      const hayGo = Boolean(String(envKeys.OPENCODE_GO_API_KEY || '').trim());
      const cfgGo = loadConfig();
      const usaGo = cfgGo.fallbackAgy === 'opencode-go'
        || Object.values(((cfgGo.motores) || {}).roles || {}).some((r) => r && r.motor === 'opencode-go');
      if (hayGo || usaGo) out += `- OpenCode Go (motor de almas y fallback, FEAT-173/175): ${hayGo ? 'key configurada' : '_sin `OPENCODE_GO_API_KEY`: los turnos y la consolidación caen a agy_'}\n`;
    }
  } catch {}

  out += '\n**Estado compartido**\n';
  out += `- Directorio de datos: \`${dataDir}\`\n`;
  out += `- \`state.json\`: ${stateInfo ? `✅ ${stateInfo.chats} chat(s), ${stateInfo.asksPendientes} ask(s) pendiente(s)` : '_todavía no existe_'}\n`;
  if (stateInfo && (stateInfo.reaccionesViejas || stateInfo.asksSinBot)) {
    out += `  - Formato anterior a BE-051: ${stateInfo.reaccionesViejas} reacción(es) sin bot, ${stateInfo.asksSinBot} pregunta(s) sin \`botId\`. Se leen como del bot principal y se van solas; si siguen apareciendo, el plugin instalado es anterior y conviene actualizarlo.\n`;
  }
  out += `- \`bridge.lock\`: ${lock ? `PID ${lock.pid}` : '_ninguno_'}\n`;
  out += '- Ambas copias resuelven aquí, que es lo que permite responder desde el móvil\n';
  out += '  un `telegram_ask` registrado por la otra.\n';

  return { content: [{ type: 'text', text: out }] };
}

module.exports = { manejarEstadoBridge };
