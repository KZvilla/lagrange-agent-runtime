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

## The keys you will touch first

| Key | Default | What it does |
|---|---|---|
| `model` | none (agy decides) | Default model for delegated work |
| `effort` | none | Default reasoning effort; only applied to Gemini models without an effort suffix |
| `timeout_minutes` | `15` | Default for `agy_run`, `agy_plan` and the others without their own default (reviews use 20, audits 25) |
| `permissions` | see below | The ALLOW / DENY policy |
| `readonly_isolation` | `"auto"` | Where plans, reviews and audits run — see [[Isolation and Security Model]] |
| `motores` | everything on agy | Engine per role — see [[Engines and Fallback]] |
| `fallback_agy` | off | Who answers when agy cannot |
| `orquestacion_modo` | `"pedir"` | What a session orchestrating the web console may do: `operar`, `pedir` (ask before launching), `yolo` |

The Reference has the full list in the
[`set_config` row](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#mcp-tools-reference) and a complete
[example file](https://github.com/KZvilla/lagrange-agent-runtime#persistent-defaults-claudeantigravityjson).

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

## Secrets

Secrets never go in `antigravity.json`. The Telegram token, `DEEPSEEK_API_KEY` and `OPENCODE_GO_API_KEY` live in
the bridge's `.env` (on Windows, `%LOCALAPPDATA%\antigravity-telegram-bridge\.env`), which you create yourself.
Lagrange strips its own secrets from the environment of every child process that runs a model.
