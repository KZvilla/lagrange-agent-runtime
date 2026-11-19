# Configuration

## Where settings come from

Lagrange reads `antigravity.json` from two places, in this order:

1. **Global** — `~/.claude/antigravity.json`
2. **Project** — `.claude/antigravity.json` in the project root

The project file wins key by key. Two merge rules are worth knowing:

- `permissions` is merged one level deep: a project that sets `deny_commands` replaces the global
  `deny_commands` list, it does not append to it.
- `voice_setup` and `motores.roles` are replaced **as a whole** by the project's version.

You can also set most keys with the `set_config` tool (`scope: "global"` or `"project"`), and the model, effort and
timeout with environment variables (`AGY_MODEL`, `AGY_EFFORT`, `AGY_TIMEOUT_MINUTES`). A value passed in a call
beats all of them.

### Per-call

`run`, `plan`, `review`, `audit` and the other delegating tools accept `model`, `effort` and
`timeout_minutes` in the call. `effort` accepts `low`, `medium` or `high`, and `xhigh` with Gemini 4 Hydrogen when you ask for it in the call (never as a default); `max` belongs to the DeepSeek/OpenCode Go
read-only engines. Models that do not support effort reject an explicit value. `timeout_minutes` must be an integer
from 1 to 120; an invalid per-call value is rejected before launching.

### Persistent defaults

`set_config` writes the same keys to the global or project file. `timeout_minutes` is validated between 1 and 120.

### Environment variables

`AGY_MODEL`, `AGY_EFFORT` and `AGY_TIMEOUT_MINUTES` set defaults for the current process; they are useful for a
one-off shell. `AGY_RUN_MAX_CONCURRENT` (integer 1..8, default 2) caps concurrent `run` calls in one MCP process;
an invalid value falls back to 2 with a `stderr` warning. It does not throttle `fanout`, which keeps its own
per-batch cap.

## Per-call example

```json
{
  "prompt": "Investigate the authentication bug in src/server/auth.ts",
  "permissions": {
    "deny": ["edit"],
    "deny_paths": [".env*", "config/secrets.json"],
    "sandbox": true
  }
}
```

## A complete example

```json
{
  "model": "gemini-4-hydrogen",
  "effort": "medium",
  "timeout_minutes": 15,
  "permissions": {
    "allow": ["read", "edit", "commands"],
    "deny": [],
    "deny_paths": [".env*", "**/*.key", "**/*.pem"],
    "deny_commands": ["git push*", "npm publish*", "rm -rf*"],
    "sandbox": false
  },
  "fanout_statusline": true,
  "fanout_progress_log": true,
  "fanout_control": true,
  "voice_setup": {
    "version": 3,
    "status": "configured",
    "languages": ["es", "en"],
    "default_language": "en",
    "defaults": {
      "es": {
        "identity": { "mode": "soul", "soul": "brisa" },
        "audio": { "profile": "Marina Sol", "provider": "omnivoice" }
      },
      "en": {
        "identity": { "mode": "neutral" },
        "audio": { "profile": "Rowan Vale", "provider": "voicebox", "engine": "qwen", "model_size": "0.6B" }
      }
    },
    "fallbacks": {
      "es": [
        { "profile": "Cobre Claro", "provider": "voicebox", "engine": "kokoro" }
      ],
      "en": [
        { "profile": "Juniper Reed", "provider": "omnivoice" }
      ]
    }
  }
}
```

The `voice_setup` block is documented in [[Voice]]; the `set_config` row is in the
[Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#mcp-tools-reference).

## Global-only keys

Some settings decide **which account, key or third party sees your data**. A repository you cloned must not be
able to choose that for you, so these are read **only from the global file**; in a project file they are ignored
with a warning:

| Key | Why it is global-only |
|---|---|
| `fallback_agy` | Sends texts, Soul chats and session transcripts to another account or provider |
| `motores.cuentas` | Which Claude logins exist |
| Roles on `deepseek` / `opencode-go` in `motores.roles` | Sends a Soul's memory to a third party with your key |
| `identidad_sesion` | Which voice each Claude account speaks with |
| `sesiones_claude` | Remote Claude Code sessions launched from the console |
| `orquestacion_modo` | How much a session may do in the web console without asking you |
| `agy_modo` | Whether Lagrange may launch agy at all; a cloned repository must not turn it back on |
| `guardas` / `guardas_efecto` | Which commands ask or deny for every account; a cloned repository must not choose that |

## The keys you will touch first

| Key | Default | What it does |
|---|---|---|
| `model` | none (agy decides) | Default model for delegated work |
| `effort` | none | Default reasoning effort (`low`, `medium` or `high`; `xhigh` is ignored with a warning); only applied to Gemini models without an effort suffix. Without it Gemini 4 Hydrogen runs `medium`, and `audit` `high` |
| `timeout_minutes` | `15` | Default for `run`, `plan` and the others without their own default (reviews use 20, audits 25, images 10) |
| `permissions` | see below | The ALLOW / DENY policy |
| `guardas_efecto` | `"ask"` | Whether a matching guard asks or denies; `"deny"` keeps the old hard stop, and an invalid value also falls back to `deny` |
| `readonly_isolation` | `"auto"` | Where plans, reviews and audits run — see [[Isolation and Security Model]] |
| `motores` | everything on agy | Engine per role — see [[Engines and Fallback]] |
| `fallback_agy` | off | Who answers when agy cannot |
| `orquestacion_modo` | `"pedir"` | What a session orchestrating the web console may do: `operar`, `pedir` (ask before launching), `yolo` |
| `agy_modo` | `"auto"` | `"manual"`: Lagrange never launches agy (no `agy_*` model calls, batches on agy, the bot, isolation probes or `/usage` refresh); tools with `fallback_agy` use it, and `audit` / `review` / `plan` write a request for you to run in your agy (`npm run agy:plugin` installs its `/lagrange-audit`, `/lagrange-review` and `/lagrange-plan` skills; add `-- --statusline` or `-- --statusline-stack` for a status bar with context, quota and pending requests, or `-- --statusline-off` to remove it) and collect the report with `request_id: "<id>"`, or take `engine: "opencode-go"` / `"deepseek"`. You run agy yourself, in your own terminal. Meant for an account that already got a Google warning for automated use. `LAGRANGE_AGY_MODO=manual` also forces it |

The Reference has the full list in the
[`set_config` row](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#mcp-tools-reference) and a complete
[example file](#a-complete-example).

## Permissions

```json
{
  "permissions": {
    "allow": ["read", "edit", "commands", "network"],
    "deny": [],
    "deny_paths": [".env*", "**/*.key", "**/*.pem"],
    "deny_commands": ["git push*", "git reset --hard*", "npm publish*", "rm -rf /*",
                      "Stop-Process -Name*", "kill -Name*", "taskkill /IM*", "taskkill /F /IM*", "pkill*", "killall*"],
    "sandbox": false
  }
}
```

Those are the defaults. Read [[Isolation and Security Model]] before relying on them: on your machine they are
**instructions to the model**, not a barrier. Inside the read-only container, `deny_paths` becomes real — the
matching files are not copied in at all.

The policy applies to every delegating tool except `image`: `run` plus the no-edit ones (`plan`,
`review`, `audit`, `research`, `session_summary`). The no-edit tools always tell the subagent not to
edit, whatever the policy says, and run it with `--mode plan`; `commands`, `network`, `deny_paths` and
`deny_commands` travel with that instruction. `image` uses a fixed `read` + `network` / no `edit` / no `commands`
policy in an empty temporary directory and only propagates `deny_paths`; its default timeout is 10 minutes.
`sandbox` also applies except to `audit`, which always forces it off because the Windows implementation is
harmful for long headless audits. Each tool's output footer prints the policy it ran under. The field table is in the
[Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#permission-fields).

## Secrets

Secrets never go in `antigravity.json`. The Telegram token, `DEEPSEEK_API_KEY` and `OPENCODE_GO_API_KEY` live in
the bridge's `.env` (on Windows, `%LOCALAPPDATA%\antigravity-telegram-bridge\.env`), which you create yourself.
Lagrange strips its own secrets from the environment of every child process that runs a model.

### Secrets in KeePassXC (optional)

A credential in the `.env` can be a reference instead of a value: `DEEPSEEK_API_KEY=keepassxc:deepseek`. Lagrange then
asks KeePassXC (2.7 or later) for the entry `lagrange://deepseek` in the group `Lagrange`, over KeePassXC's
browser-integration protocol. The browser extension is not needed. Use a separate `.kdbx` just for Lagrange.

- **Which variables:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_<NAME>_TOKEN`, `LAGRANGE_MEMORY_TOKEN`, `DEEPSEEK_API_KEY`
  and `OPENCODE_GO_API_KEY`. `ALLOWED_USER_IDS` and `TELEGRAM_NOTIFY_CHAT_ID` are IDs, not credentials, and stay
  literal. A literal keeps working.
- **Setup:** in KeePassXC, enable *Settings → Browser Integration* (no browser has to be ticked) and open the
  database. Then, from the plugin folder:
  1. `node scripts/secretos.mjs asociar`: KeePassXC asks you to name the connection.
  2. `node scripts/secretos.mjs migrar --simular` shows what would change; `migrar` does it. For each credential
     in plain text it creates the entry, reads it back, and only then rewrites that line. It never overwrites an
     entry that already exists with another value, and it keeps no copy of the old `.env` (make your own first if
     you want one).
  3. `node scripts/secretos.mjs probar`: yes or no for each secret, never the value.
  4. Restart the daemon.
- **When it is read:** the Telegram tokens and the memory token once, when the daemon starts. If the database is
  locked, the daemon asks KeePassXC to show the unlock window and waits; if KeePassXC is closed, it retries. With
  no association or no entry, it stops and says which variable and why. The engine keys are read on each request
  and cached in memory for 5 minutes; a failed read is not cached.
- **Dialogs you may miss:** KeePassXC's dialogs make no sound and do not take focus. When a key request waits more
  than 2 seconds, the daemon tells you on Telegram.
- **Status:** `telegram_bridge_status` marks the tokens kept in KeePassXC and lists any it could not read as
  *no verificable*. It also shows a daemon that is waiting for KeePassXC, and warns about credentials still in plain
  text. *Ajustes* in the web console says *Key en KeePassXC* and shows a failed last read.
- **What it protects:** the `.env` no longer holds credentials, so a process that copies it gets nothing. A process
  running as you that reads the association (`keepassxc.json` in the data directory) can still ask KeePassXC on
  Lagrange's behalf. What limits that is KeePassXC: auto-lock on inactivity, *Remember* left off for the keys with
  a balance, and revoking the association (*Database → Database settings → Browser Integration*).
- **The daemon as the only reader (2.4.0 and later):** while the daemon is running, the MCP server, `notify.js` and
  the engines ask it for the engine keys and bot tokens, over loopback with their own credential
  (`secretos.json`, rotated on every start). The daemon keeps each key in memory for 16 hours
  (`LAGRANGE_SECRETOS_CACHE`, from `5m` to `24h`, or `daemon` for the life of the process) and asks KeePassXC once
  per entry, so a locked database stops nothing until the cache expires. Never written to disk. With the daemon down,
  each process reads KeePassXC directly, as before. The terminal's daemon dialog (*Salud*) shows which entries are
  cached and for how long, never the value, with *Olvidar todo*. `LAGRANGE_SECRETOS_INTERMEDIARIO=0` in the `.env`
  turns it off.
  - **The trade-off:** while a key is cached, any process running as you that reads `secretos.json` gets it without
    a KeePassXC dialog, even with the database locked. Today that same process can already read the association.
- **Not covered:** a daemon in WSL with KeePassXC on Windows (the named pipe is not reachable from WSL). The Linux
  and macOS socket paths come from KeePassXC's sources and are untested; `LAGRANGE_KEEPASSXC_SOCKET` overrides them.
