# Installation

## Requirements

| | |
|---|---|
| **Antigravity CLI** | `agy` on your `PATH`, logged in (`agy auth login`) |
| **Node.js** | ≥ 18 for the MCP tools; ≥ 20.12 if you run the Telegram bridge |
| **Claude Code** or **Codex** | The host that loads the plugin |
| **Docker** *(optional, recommended)* | Needed for the read-only container and confined batches — see [[Isolation and Security Model]] |

## Claude Code

Inside a session:

```text
/plugin marketplace add KZvilla/lagrange-agent-runtime
/plugin install lagrange@kzvilla-lagrange
```

or from a terminal with `claude plugin marketplace add …` / `claude plugin install …`.

**Then restart Claude Code.** `/reload-plugins` picks up commands, agents and skills, but whether it re-registers
the MCP server has changed across Claude Code versions. Restarting is the reliable way to make `agy_run` and the
other tools appear. Check with:

```bash
claude plugin list
claude plugin details lagrange@kzvilla-lagrange
```

## Updating

```bash
claude plugin marketplace update kzvilla-lagrange
claude plugin update lagrange@kzvilla-lagrange
```

Restart the sessions you had open afterwards: a running session keeps the code it started with.

Every release is **pinned to the commit of its tag** in the marketplace manifest, so you always install exactly
what was tagged — never whatever happens to be on `main`. Each version installs into its own directory and old
ones are not deleted; that is why anything that stores an absolute path (the bridge daemon, for example) must be
installed from a clone, not from the plugin copy. See [[ADR-004: The marketplace is the only channel|ADR-004-The-marketplace-is-the-only-channel]].

## Codex

```bash
codex plugin marketplace add KZvilla/lagrange-agent-runtime --ref <release-tag>
codex plugin add lagrange@kzvilla-lagrange-codex
```

Or from a local clone:

```bash
git clone https://github.com/KZvilla/lagrange-agent-runtime.git
codex plugin marketplace add /absolute/path/to/lagrange-agent-runtime
codex plugin add lagrange@kzvilla-lagrange-codex
```

Start a new thread afterwards. Codex gets the skills and MCP tools; the `/lagrange:*` slash commands are Claude
Code only. State is shared under `~/.claude/` so both hosts see the same configuration and agent memory.

## Migrating from the old install scripts

`install.ps1` and `install.sh` were removed in 0.6.0. If you used them, remove `~/.claude/skills/antigravity`
(after saving the `.env` inside it, if any) — otherwise the plugin loads twice. The scripts only cloned into that
directory, wrote nothing to `settings.json` and registered no MCP server, so removing it is the whole uninstall.
Two things need care: the `.env` inside it is git-ignored and exists nowhere else, and on Windows the bridge daemon
may be a scheduled task pointing into the directory you are about to delete.

**Linux / macOS:**

```bash
dir="$HOME/.claude/skills/antigravity"
if [ -d "$dir" ]; then
  pkill -f "$dir/telegram-bridge/bot.js" 2>/dev/null
  [ -f "$dir/.env" ] && cp "$dir/.env" "$HOME/antigravity.env.bak"
  rm -rf "$dir"
  echo "Uninstalled. Copy of .env kept at ~/antigravity.env.bak"
else
  echo "No script install found."
fi
```

**Windows (PowerShell):**

```powershell
$dir = Join-Path $env:USERPROFILE '.claude\skills\antigravity'
if (Test-Path $dir) {
    $t = Get-ScheduledTask -TaskName AntigravityTelegramBridge -ErrorAction SilentlyContinue
    if ($t -and $t.Actions[0].WorkingDirectory -like "$dir*") {
        Stop-ScheduledTask $t.TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask $t.TaskName -Confirm:$false
    }
    if (Test-Path "$dir\.env") { Copy-Item "$dir\.env" (Join-Path $env:USERPROFILE 'antigravity.env.bak') -Force }
    Remove-Item -Recurse -Force $dir
    Write-Host "Uninstalled. Copy of .env kept at $env:USERPROFILE\antigravity.env.bak"
} else { Write-Host 'No script install found.' }
```

Then restart Claude Code: `/reload-plugins` drops commands, agents and skills, but MCP tool schemas registered at
session start stay until a restart. A leftover `pluginUsage` entry in `~/.claude.json` is harmless telemetry.

## Generic MCP clients

The MCP server is plain JSON-RPC over stdio: it does not depend on Claude Code and reads no `CLAUDE_*` variable.
Claude registers it through `.mcp.json` and `${CLAUDE_PLUGIN_ROOT}`; Codex uses `.codex-plugin/plugin.json` and a
relative working directory. Both launch the same `mcp-server/index.js`.

Any other MCP client can run the server with `node` and the **absolute path** to `mcp-server/index.js` in a clone.
The server has **no npm dependencies**, so no `npm install` is needed for it. The Telegram bridge does need one
(`npm install --prefix telegram-bridge`).

```json
{ "mcpServers": { "lagrange": { "command": "node", "args": ["/abs/path/lagrange-agent-runtime/mcp-server/index.js"] } } }
```

These formats belong to each client and change more often than this page: check them against your client's docs.

## Opencode

This repository ships an `.opencode/` directory plus a committed `opencode.json`, so running `opencode` **inside a
clone** gives you close to the Claude Code experience:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "lagrange": {
        "type": "local",
        "command": ["node", "/abs/path/lagrange-agent-runtime/mcp-server/index.js"],
        "environment": { "LAGRANGE_HOST": "opencode" },
        "timeout": { "startup": 10000, "catalog": 10000, "execution": 1800000 }
      }
    }
  }
}
```

`LAGRANGE_HOST=opencode` is a **host marker** used only by the opencode config: it makes the server fail closed
instead of falling back to a Claude session. Do not add it to a shared MCP config that Claude Code also uses. The
execution timeout is 30 minutes because summaries and audits can outlive the default.

The repo-local plugin (`.opencode/plugins/lagrange.js`) injects the current `ses_...` into `agy_session_summary`
and `narrate`, so both read the opencode session without the model passing an id. It also neutralizes the Claude
Code/Codex wording in the tool descriptions. Without the plugin, pass `session_id: "ses_..."` manually; without
either, the session tools fail closed instead of reading a Claude session. The plugin is repo-local: outside the
clone, copy it to `~/.config/opencode/plugins/` and keep the marker in that opencode config.

## What does not carry over

- **Slash commands** (`/lagrange:*`) remain Claude Code-specific. Codex loads the shared `skills/**`; opencode is
  covered by its `.opencode/` integration; generic clients call the tools directly.
- **Config and state stay in `~/.claude/`** (`antigravity.json`, usage, the agent registry), even if you never use
  Claude Code. One directory per client would split the persistent agents' memory.
- **`agy_session_summary` and `narrate` need a host session source.** Claude uses its project logs; Codex uses the
  trusted session hook and fails closed on missing or ambiguous pointers; opencode (>= 2) uses
  `opencode session export` inside a clone, with the plugin or an explicit id. Generic MCP clients have no adapter,
  so use their native handoff and `say`.
- **The fan-out statusline** relies on Claude Code's `statusLine` contract.
- **Telegram:** the outbound tools work from any client. The bot's `/claude` command launches Claude Code only.
- **`agy_fanout` creates `.claude/worktrees/` in your repo.** Add `.claude/` to your `.gitignore`.
- **Host-specific names remain only where they are real contracts**, notably `~/.claude/` state and Claude
  session/statusline integrations.

## Optional pieces

`/lagrange:setup` walks you through each one and never asks for a secret in the chat:

| Track | What it sets up |
|---|---|
| `voicebox` | Local text-to-speech for narration — see [[Voice]] |
| `telegram` | Notifications, questions and voice notes to your phone — see [[Telegram Bridge]] |
| `daemon` | The bidirectional Telegram bot as a background service — see [[Telegram Bridge]] |
| `cuenta` | A second Claude account for the fallback — see [[Engines and Fallback]] |
| node | A machine joined to a server — see [[Node Network]] |
