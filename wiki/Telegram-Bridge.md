# Telegram Bridge

The Telegram tools (`telegram_notify`, `telegram_ask`, `telegram_send_voice` and `narrate`'s `send_telegram`) need
your own bot token and chat id. **No install channel creates or copies them for you.** `/lagrange:setup telegram`
walks you through the steps and verifies the result, but deliberately never asks for the token in the chat and never
writes the file: anything typed in a session is stored in the session log, and the summary sends that log to a model.

## Setup

1. Get a bot token from [@BotFather](https://t.me/BotFather).
2. Get your numeric user id from [@userinfobot](https://t.me/userinfobot).
3. Copy `telegram-bridge/.env.example` to the durable location and fill in `TELEGRAM_BOT_TOKEN` and
   `ALLOWED_USER_IDS`.

`/lagrange:setup telegram` never asks for a secret and never writes the file for you.

## Where the `.env` lives

`.env` is git-ignored, so no install channel brings it along. It is searched in this order; the first one that
exists wins:

| # | Location | Survives `claude plugin update`? |
|---|---|---|
| 1 | `$TELEGRAM_BRIDGE_ENV_FILE` | Yes |
| 2 | `<plugin>/telegram-bridge/.env` | **No** |
| 3 | `<plugin>/.env` | **No** |
| 4 | `%LOCALAPPDATA%\antigravity-telegram-bridge\.env` (or `$XDG_STATE_HOME/...`) | **Yes** |

If you installed from the marketplace, use row 4: each version installs into its own directory and an update creates
a new, empty one. A `.env` in rows 2 or 3 is left behind. The failure is quiet: the next Telegram call reports
`No hay usuarios configurados` and lists every path it searched.

A dev checkout keeps its own `.env` next to the code. The two copies share runtime state (`state.json`,
`bridge.lock`) in the durable directory, which is what lets an installed `telegram_ask` be answered by a daemon
running from a clone.

The bidirectional bot (`telegram-bridge/bot.js`, `npm run bridge`) is only needed to message the bot *from* your
phone to start `agy` tasks or answer `telegram_ask` prompts. Outbound notifications and voice notes work without it.

## A bot per Soul

`TELEGRAM_BOTS` adds bots to the same `.env`, each tied to a Soul:

```dotenv
TELEGRAM_BOTS=alya
TELEGRAM_BOT_ALYA_TOKEN=333:CCC
TELEGRAM_BOT_ALYA_VINCULO=alma:alya
TELEGRAM_BOT_ALYA_USUARIOS=123456789   # optional; subset of ALLOWED_USER_IDS
```

A Soul's bot *is* that Soul: free text talks to it, and it only accepts `/charla`, `/alma`, `/cancel` and `/help`;
anything else points to the general bot. What the Soul says on its own (`say`, `narrate`, console schedules with
*notify Telegram*) goes out through its bot. A misconfigured bot is left out with the reason in the banner, log and
`telegram_bridge_status`; the general bot and the rest keep working. A bot can be tied to a node; see
[[Node Network]].

## Daemon from a clone

The installer **refuses to run** from a managed plugin directory (`.claude/plugins/cache/…` or `…/marketplaces/…`)
on Windows and Linux. The scheduled task and systemd unit store an absolute path; each plugin version installs into
its own directory and updates do not delete old ones. A daemon registered from `…/lagrange/0.9.1/` stays pinned to
0.9.1 forever, while the MCP tools run the new code — and nothing fails. Old versions surviving is exactly what
makes it silent.

Run `/lagrange:bridge` to see which copy each half runs, daemon state, the effective `.env` and shared state paths.
`-Force` bypasses the check if you have a case we did not anticipate.

## Bot commands

When the bidirectional daemon runs, your private chat becomes a mobile command center for Antigravity and Claude
Code:

| Command | Action |
|---|---|
| `/claude` | List trusted workspaces and launch a detached `claude --remote-control` session with inline buttons |
| `/claude <project> [account]` | Launch in that project with that account |
| `/claude status` / `stop` / `clean` | List, stop or clean remote sessions |
| `/plan <task>` | Generate an Antigravity plan with an approve button; runs as the read-only `lagrange-plan` agent |
| `/run <task>` | Start a subagent with edit permissions |
| `/resume <task>` | Continue the active conversation |
| `/status` | Active binary, version, model/effort and permissions |
| `/diff [file]` | Uncommitted changes, confined to the workspace |
| `/logs [N]` | Last N lines of the daemon log |
| `/queue` / `/cancel` | Inspect or abort queued tasks |
| `/reset` | Clear the conversation context |
| `/web` | Link to the web console |
| `/charla`, `/alma` | Talk to a Soul, inspect or prune its memory |
| `/cron` | Schedule work that runs on its own |
| `/nodo` | Choose which node answers that chat |

## Web console

`BRIDGE_WEB=1` serves a browser console on `http://127.0.0.1:4518` (`4519` inside WSL). It runs inside the bot
process, so a cast started in the browser also appears in Telegram's `/queue`, and the reverse. Nothing in it uses
the main model: Soul chat and casts run through `agy`, *listen* uses local voice servers, and the rest reads local
files.

The console has three columns: Souls and read-only agents on the left; the conversation with the selected Soul or
agent in the center; memory, context and project rules on the right. Around them: live activity, live reply,
*listen*, *prepare voice*, auto-read, settings (`/ajustes`), the board (`/tablero`), schedules (`/cron`), the sweep,
attachments, search and filters, split-into-cards, and the command palette (`Ctrl+K`). The history comes from
`tareas.json`, written only by the daemon; only Telegram tokens are redacted, so treat it like the conversations
`agy` already stores.

To enable it, add `BRIDGE_WEB=1` to the bridge `.env` and restart the daemon. Get the access link with
`npm run bridge:web` or `/web`; the link carries a random token that changes on every start. From your phone, set
`BRIDGE_WEB_TAILSCALE` and `BRIDGE_WEB_TAILSCALE_USUARIO`, use `tailscale serve` on HTTPS and open the one-time
link `/web` sends. The phone gets its own session; never use `tailscale funnel` for that port.

What it will not do: listen off loopback; run `/run`, `/plan`, `/resume` or `/claude` (Telegram only); answer
`telegram_ask`; take paths from the browser. It uses a loopback `Host` check, `Origin`/`Sec-Fetch-Site` on writes,
no CORS, 64 KB JSON bodies, a CSP with nothing inline and allowlisted model output.

## Remote control security

- **Workspace allowlist (`hasTrustDialogAccepted`).** Only projects where you accepted the trust dialog are offered
  in `/claude`; unconfirmed paths are filtered out. With several accounts, the list joins each account's trusted
  projects, and a session only launches with an account that trusts its folder. Lagrange never writes Claude's
  `.claude.json`; a folder no account trusts shows up and launching tells you the command to accept it.
- **`sesiones_claude` (global only).** `directorios` adds folders with `{ modo: "same-dir"|"worktree", cuenta }`,
  `ocultos` hides paths, `cuenta_por_defecto` picks the account and `max_sesiones` (1–10, default 3) caps
  concurrency. `ALLOWED_CLAUDE_WORKSPACES` and `deny_paths` still filter everything. Each session writes its own
  log and runs with its account folder and without Lagrange's secrets.
- **Environment sanitization.** The spawned Claude process strips internal bot tokens.
- **Mobile control.** Once launched, use the official Claude mobile or web UI to approve tool calls and review
  diffs.
