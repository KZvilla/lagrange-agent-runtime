/**
 * Configuración del plugin: variables de entorno más `.claude/antigravity.json`
 * global y del proyecto (el del proyecto gana).
 *
 * Vivía en `index.js`. Se extrajo (FEAT-055) para que el daemon de Telegram
 * resuelva la voz con la misma configuración que `agy_say`: `index.js` no se
 * puede importar, porque arranca el servidor MCP al cargarse.
 */

const fs = require('node:fs');
const path = require('node:path');
const vb = require('../voicebox-server.js');

function loadConfig(cwd = process.cwd()) {
  const config = {
    defaultModel: process.env.AGY_MODEL || null,
    defaultEffort: process.env.AGY_EFFORT || null,
    defaultTimeoutMinutes: parseInt(process.env.AGY_TIMEOUT_MINUTES, 10) || 15,
    voiceboxUrl: process.env.VOICEBOX_URL || null,
    voiceboxPort: parseInt(process.env.VOICEBOX_PORT, 10) || null,
    ...vb.CONFIG_POR_DEFECTO,
    fanoutStatusline: true,
    fanoutStatuslineDelegate: null,
    fanoutControl: true,
    fanoutStopCheckIntervalMs: parseInt(process.env.AGY_FANOUT_STOP_INTERVAL_MS, 10) || 2000,
    fanoutProgressLog: true,
    permissions: {
      allow: ['read', 'edit', 'commands', 'network'],
      deny: [],
      deny_paths: ['.env*', '**/*.key', '**/*.pem'],
      deny_commands: ['git push*', 'git reset --hard*', 'npm publish*', 'rm -rf /*'],
      sandbox: false
    },
    configFile: null
  };

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const globalPath = path.join(homeDir, '.claude', 'antigravity.json');
  const projectPath = path.join(cwd, '.claude', 'antigravity.json');

  if (fs.existsSync(globalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
      if (parsed.model) config.defaultModel = parsed.model;
      if (parsed.effort) config.defaultEffort = parsed.effort;
      if (parsed.timeout_minutes) config.defaultTimeoutMinutes = parsed.timeout_minutes;
      if (parsed.voicebox_url) config.voiceboxUrl = parsed.voicebox_url;
      if (parsed.voicebox_port) config.voiceboxPort = parsed.voicebox_port;
      if (parsed.fanout_statusline !== undefined) config.fanoutStatusline = !!parsed.fanout_statusline;
      if (parsed.fanout_statusline_delegate !== undefined) config.fanoutStatuslineDelegate = parsed.fanout_statusline_delegate;
      if (parsed.fanout_control !== undefined) config.fanoutControl = !!parsed.fanout_control;
      if (parsed.fanout_stop_check_interval_ms !== undefined) config.fanoutStopCheckIntervalMs = parsed.fanout_stop_check_interval_ms;
      if (parsed.fanout_progress_log !== undefined) config.fanoutProgressLog = !!parsed.fanout_progress_log;
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
      vb.aplicarClavesVoicebox(config, parsed);
      config.configFile = globalPath;
    } catch {}
  }

  if (fs.existsSync(projectPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
      if (parsed.model) config.defaultModel = parsed.model;
      if (parsed.effort) config.defaultEffort = parsed.effort;
      if (parsed.timeout_minutes) config.defaultTimeoutMinutes = parsed.timeout_minutes;
      if (parsed.voicebox_url) config.voiceboxUrl = parsed.voicebox_url;
      if (parsed.voicebox_port) config.voiceboxPort = parsed.voicebox_port;
      if (parsed.fanout_statusline !== undefined) config.fanoutStatusline = !!parsed.fanout_statusline;
      if (parsed.fanout_statusline_delegate !== undefined) config.fanoutStatuslineDelegate = parsed.fanout_statusline_delegate;
      if (parsed.fanout_control !== undefined) config.fanoutControl = !!parsed.fanout_control;
      if (parsed.fanout_stop_check_interval_ms !== undefined) config.fanoutStopCheckIntervalMs = parsed.fanout_stop_check_interval_ms;
      if (parsed.fanout_progress_log !== undefined) config.fanoutProgressLog = !!parsed.fanout_progress_log;
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
      vb.aplicarClavesVoicebox(config, parsed);
      config.configFile = projectPath;
    } catch {}
  }

  return config;
}

module.exports = { loadConfig };
