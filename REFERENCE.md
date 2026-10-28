# Lagrange Reference

The [README](README.md) is the front page. This file holds what is derived from the code and gated by `npm test`:
the tool table, the parameter tables, permission fields, slash commands, components and the host capability matrix.

## Table of Contents
- [Slash Commands](#slash-commands)
- [MCP Tools Reference](#mcp-tools-reference)
- [`agy_run` — Full Parameters](#agy_run--full-parameters)
- [`agy_fanout` — Parameter Reference](#agy_fanout--parameter-reference)
- [`cast_agent` — Parameter Reference](#cast_agent--parameter-reference)
- [Permission Fields](#permission-fields)
- [Host capability matrix](#host-capability-matrix)
- [Components](#components)

## Slash Commands

| Command | Description |
|---------|-------------|
| `/lagrange:run <prompt>` | Delegate any task to Antigravity (read + write) |
| `/lagrange:plan <task>` | Generate an architectural plan (read-only, no file changes) |
| `/lagrange:fanout [plan]` | Run atomic tasks in parallel, one Antigravity subagent per isolated git worktree |
| `/lagrange:watch [slug]` | Open the local Lagrange inventory; with a slug, open that fan-out directly |
| `/lagrange:review [target]` | Adversarial code review on staged/unstaged diffs or specific files |
| `/lagrange:audit [target]` | Heavyweight, evidence-based adversarial audit (Mode 1: Code vs Plan, Mode 2: Plan vs Repo) |
| `/lagrange:summary [focus]` | Generate structured session summary from Claude Code's raw JSONL logs (`full`, `decisions`, `changes`, `debugging`, `handoff`) |
| `/lagrange:narrate [voice/lang]` | Narrate the latest task/checkpoint with an explicit profile or the configured `voice_setup` route |
| `/lagrange:voices [lang]` | Inspect live/cached profiles, configured roles, languages, and service health without starting providers |
| `/lagrange:research <topic>` | Conduct deep web research with cited sources and structured insights |
| `/lagrange:usage` | Display token telemetry, context saturation, and quota health |
| `/lagrange:bridge` | Diagnose the Telegram bridge: daemon state, which copy of the code each half runs, credentials and shared state |
| `/lagrange:setup [track]` | Guided setup for the optional pieces — Voicebox, Telegram notifications, the bidirectional daemon, a second Claude account, native opencode (`voicebox`, `telegram`, `daemon`, `cuenta`, `opencode`) |
| `/lagrange:integrar-lote <batch id>` | Integrate a confined batch (`agy_lote`) into its base branch — one merge per task, only with green tests and an audit PASS |

> **Tip:** You can also ask Claude naturally — *"Delegale a agy que resuma esta sesión"*, *"¿Qué voces tengo disponibles?"* o *"Cuando termines, ejecuta la narración con Cloud Finch"* — and it will pick the right tool automatically.

---

## MCP Tools Reference

The tools exposed via the MCP server: `agy_*` tools (the ones whose result Antigravity produces, or that report on it), Lagrange tools without a prefix (your host adds the server's: `lagrange_say` in opencode, `mcp__plugin_lagrange_lagrange__say` in Claude Code), `telegram_*` bridge tools, and `cast_agent`. `npm test` checks this table against what the server actually registers:

| Tool | Mode | Default Timeout | Description |
|------|------|-----------------|-------------|
| `agy_run` | read + write | 15m | Execute a full subagent session with optional permission guardrails |
| `agy_fanout` | read + write | 15m/subagent | Concurrent fan-out: validates the tasks are disjoint in files, one worktree + branch each, batched with a concurrency cap and quota backoff |
| `agy_lote` | isolated (containers) | per task | Confined batch: each atomic task runs in its own Docker container, its commit is tested in a no-network runner and audited by a different model; nothing is merged automatically (`/lagrange:integrar-lote` does it, only with green tests and an audit PASS). With `motor: "claude@<account>"`, Claude Code writes the tasks in the same container — see [Confined batches written by Claude](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Fan-Out-and-Confined-Batches#confined-batches) |
| `agy_plan` | isolated (container) | 15m | Step-by-step architectural / implementation plan over a read-only snapshot of the working tree — see [Read-only isolation](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Isolation-and-Security-Model#the-read-only-container) |
| `agy_review` | isolated (container) | 20m | Adversarial code review on git diffs or specific files, over the same snapshot |
| `agy_audit` | isolated (container) | 25m | Rigorous adversarial audit with severity rubric (BLOCKER, MAJOR, MINOR), over the same snapshot; always forces `sandbox=false` |
| `agy_research` | no-edit (prompt) | 20m | Deep web research with cited sources — requires the `network` capability, errors out if denied |
| `agy_session_summary` | no-edit (prompt) | 15m | Parse session JSONL and generate structured summary doc with Gemini |
| `agy_voice_stream` | conversational | persistent (no fixed timeout) | Manage a long-lived, streaming `agy.exe` process for low-latency voice chat ("Modo Charla") — the backend behind `voice-chat/` |
| `narrate` | audio/text | 3m | Update of the latest checkpoint through the configured voice route, with text-only preservation when audio is unavailable; it writes the script from the session log |
| `say` | audio TTS | — (3m with `polish`) | Speak a specific text you already have. Sanitized locally by default (markdown, paths, URLs, emoji stripped; secrets redacted); `polish: true` has Gemini condense it first |
| `narrate_voices` | read-only | — | Inspect live/cached profiles, setup state, languages, roles, and service health; never starts a provider or loads a model |
| `voice_model` | GPU memory | — | Start Voicebox headless (or OmniVoice with `engine: "omnivoice"`), and pin / release / unload the TTS model in VRAM across both (`status` is read-only) |
| `agy_usage` | — | — | Session token telemetry, context window saturation, model limits, quota health |
| `agy_status` | — | — | Binary path, CLI version, active model/effort defaults, permission policies |
| `set_config` | — | — | Persist model, effort, timeout, permissions, the versioned `voice_setup` block, the voice of a session identity (`identidad_voz`), engines (`motores`, `fallback_agy`), `readonly_isolation`, `orquestacion_modo`, fan-out display flags and Voicebox/OmniVoice tuning |
| `telegram_notify` | outbound | - | Push a notification (with optional file attachment) to your phone - see [Telegram Bridge Setup](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Telegram-Bridge#setup) |
| `telegram_ask` | Human-in-the-Loop | 5m | Ask a question with tappable choice buttons and block until you answer on your phone |
| `telegram_send_voice` | outbound audio | — | Send an audio file (or the latest Voicebox generation) as a native voice note |
| `cast_agent` | read-only by default | 15m | Cast a persistent, SKILL-bound agent that keeps its identity, thread and accumulated criteria across sessions — see [Persistent Agents](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Persistent-Agents) |
| `telegram_bridge_status` | read-only | — | Diagnose the bridge: daemon state, which copy of the code each half runs, where credentials and shared state resolve — `/lagrange:bridge` |
| `recall` | read-only | — | Read this project's Claude Code memory from another Claude account on this machine; never writes — see [Recall](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Sessions-and-Messages#recall) |
| `mensaje` | local, via the daemon | up to 10m (`esperar`) | Messages between Claude Code sessions on this machine or on other nodes: list them, send, read, reply, with an optional wait for the answer — see [Messages between sessions](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Sessions-and-Messages#messages) |
| `alma` | local files | — | Manage Souls independently from acoustic profiles: list, inspect, explicitly seed and prune identity/memory files; install the tool-less `lagrange-alma` agent — see [Souls](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Souls) |
| `consola` | local, via the web console | up to 10m (`esperar`) | Orchestrate the web console from the session: board, batches and recipes through its REST API, with a plan the user watches live. What it may do depends on `orquestacion_modo`: `operar` never launches, `pedir` (default) holds every launch, integration or discard until you approve it in the console, `yolo` does not ask. Settings, Soul memory and schedules are never reachable |
| `conocimiento` | local files | — | The project's shared knowledge base (`~/.claude/lagrange-conocimiento/`, Open Knowledge Format), common to every account and session: recent log, search, read, write notes, mark a note as confirmed by the user. What it returns is data written by other sessions; secrets are redacted |

### `agy_run` — Full Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | *required* | Task instructions for Antigravity |
| `model` | `string` | configured | Model override; without one, the configured default, and without that agy's own (`gemini-3.8-flash`) |
| `effort` | `string` | configured | Reasoning effort: `"low"`, `"medium"`, `"high"`. The configured default applies only to Gemini models without an effort suffix; with none, agy decides (Flash: `medium`) |
| `mode` | `string` | `"accept-edits"` | `"accept-edits"` (read+write) or `"plan"` (no edits requested — not enforced, see below) |
| `permissions` | `object` | — | Granular ALLOW/DENY policies (see below) |
| `conversation_id` | `string` | — | Resume a previous conversation |
| `continue_session` | `boolean` | — | Continue the most recent conversation (`-c`) |
| `timeout_minutes` | `number` | `15` | Max runtime in minutes |
| `cwd` | `string` | — | Requested project directory. The absolute path is used for the agy process and framed as the default `Cwd` of `run_command`; this is guidance, not confinement |
| `dangerously_skip_permissions` | `boolean` | `true` | Run headlessly without interactive prompts |

---

### `agy_fanout` — Parameter Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `slug` | `string` | *required* | Short identifier for the batch (names base branch and worktrees) |
| `tareas` | `object[]` | *required* | Array of atomic tasks (must be disjoint in `archivos`) |
| `tareas[].id` | `string` | *required* | Unique identifier for the task |
| `tareas[].prompt` | `string` | *required* | Implementation instructions for the subagent |
| `tareas[].archivos` | `string[]` | *required* | Repo-relative files or directories (`dir/`) this task may touch |
| `tareas[].modelo` | `string` | — | Per-task model override |
| `tareas[].effort` | `string` | batch `effort` | Per-task reasoning effort (`"low"`, `"medium"`, `"high"`) |
| `tareas[].soloLectura` | `boolean` | `false` | Run task in read-only plan mode (`--mode plan`) |
| `tareas[].skill` | `string` | — | Name of an installed SKILL whose body is injected into this subagent's prompt as guidance, below the subagent rules; grants no permissions. The batch is rejected before spending quota if it is missing, empty or too large |
| `concurrencia` | `number` | `3` | Maximum concurrent subagents running at once |
| `modelo` | `string` | configured | Default model for the batch |
| `effort` | `string` | configured | Default effort for the batch (the configured default applies only to Gemini models without an effort suffix) |
| `cwd` | `string` | repo root | Repository root directory |
| `timeout_minutes` | `number` | `15` | Per-subagent timeout limit in minutes |
| `aprobacion` | `string` | — | With a console orchestration open in mode `pedir` (see `consola`), the approval id the user granted; call again with the same arguments |

### `cast_agent` — Parameter Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `action` | `string` | `"cast"` | `cast`, `register`, `unregister`, `list`, `skills`, `forget`, `exportar`, `importar` |
| `agent` | `string` | — | Agent name. Required for `cast`, `register`, `unregister`, `forget` |
| `prompt` | `string` | — | Required for `cast` |
| `skill` | `string` | — | SKILL to derive the identity from. Required for `register` |
| `read_only` | `boolean` | `true` | On `register`: tool allowlist without write tools, plus `--mode plan` on every cast |
| `project_id` | `string` | — | Scopes the agent's memory to one project |
| `fresh` | `boolean` | `false` | Ignore the stored thread and start a new one, same identity and memory |
| `memory` | `boolean` | `true` | Rehydrate before and commit after. `false` skips `mcp-memory` entirely |
| `budget_tokens` | `integer` | `2048` | Token budget for the rehydrated context |
| `addendum` | `string` | — | On `register`: project-specific text appended to `agent.md` after the SKILL body, taking precedence over it. Re-registering without it keeps the previous one; `""` removes it |
| `archivo` | `string` | — | `exportar`: destination path (defaults under `~/.claude/lagrange-almas-exportes/`); `importar`: the envelope to read (required) |
| `forzar` | `boolean` | `false` | `exportar`: overwrite `archivo` when it exists and is not a Lagrange envelope |
| `confirmar` | `boolean` | `false` | `importar`: `false` only previews and never writes; `true`, after reviewing the preview, applies it |
| `aprobacion` | `string` | — | With a console orchestration open in mode `pedir` (see `consola`), the approval id the user granted; call again with the same arguments |
| `model` / `effort` / `timeout_minutes` / `cwd` | | configured, `15` | As in `agy_run` |

## Permission Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allow` | `string[]` | `["read", "edit", "commands", "network"]` | Capabilities explicitly allowed |
| `deny` | `string[]` | `[]` | Capabilities blocked. Denying `"edit"` forces `--mode plan` |
| `deny_paths` | `string[]` | `[".env*", "**/*.key", "**/*.pem"]` | Paths forbidden from access |
| `deny_commands` | `string[]` | `["git push*", "git reset --hard*", "npm publish*", "rm -rf /*", "Stop-Process -Name*", "kill -Name*", "taskkill /IM*", "taskkill /F /IM*", "pkill*", "killall*"]` | Shell commands prohibited (killing processes by name would also take down the daemon and the MCP servers) |
| `sandbox` | `boolean` | `false` | Enables native terminal sandbox (`--sandbox`) |

Denying `"network"` tells the subagent not to search or fetch URLs (a prompt guardrail), and makes `agy_research` fail with an explicit error instead of answering from memory.

**Scope:** the policy applies to every delegating tool — `agy_run` plus the no-edit ones (`agy_plan`, `agy_review`, `agy_audit`, `agy_research`, `agy_session_summary`). The no-edit tools always tell the subagent not to edit, whatever the policy says, and run it with `--mode plan`; `commands`, `network`, `deny_paths` and `deny_commands` travel with that instruction. `sandbox` also applies except to `agy_audit`, which always forces it off because the Windows implementation is actively harmful for long headless audits. Each tool's output footer prints the policy it ran under.

## Host capability matrix

| Capability | Claude Code | Codex MVP |
|---|---:|---:|
| Planning, implementation, review, audit and research | Full | Full |
| Persistent agents, fan-out and Almas | Full | Full; effective permissions are verified in the next phase |
| Explicit speech with `say` and outbound Telegram | Full | Full |
| `agy_session_summary` | Full | Full after trusting the packaged session hook |
| Automatic checkpoint narration with `narrate` | Full | Full after trusting the packaged session hook; otherwise use `say` |
| Fan-out statusline | Full | Not supported |
| Telegram `/claude` reverse control | Full | Claude Code only |
| Slash commands | `/lagrange:*` | Not applicable; use skills or semantic tool intent |

## Components

| Component | Path | Description |
|-----------|------|-------------|
| **MCP Server** | `mcp-server/index.js` | Zero-dependency JSON-RPC stdio server (tools listed in [MCP Tools Reference](#mcp-tools-reference)) |
| | `mcp-server/fanout.js` | Orchestrator for concurrent subagent fan-out across git worktrees |
| | `mcp-server/fanout-watch.js` | Local Lagrange inventory and live fan-out viewer — HTTP + SSE on loopback, zero dependencies |
| | `mcp-server/watch-inventory.js` | Local-first read model for agents, Souls, memory, batches and voice profiles |
| | `mcp-server/fanout-estado.js` | Per-batch state, per-subagent progress log paths, and stop sentinels |
| | `mcp-server/fanout-tail.js` | Formats one subagent's NDJSON log; also `tail -f` for a single subagent |
| | `mcp-server/fanout-stop.js` | CLI to request a running subagent be stopped |
| | `mcp-server/fanout-statusline.js` | Renders fan-out progress into the Claude Code statusline |
| | `mcp-server/lib/sentence-chunker.js` | Groups streamed `text_delta` fragments into complete sentences for TTS |
| **Subagent** | `agents/agy.md` | Autonomous subagent definition (`lagrange:agy` / `agy`) |
| **Skills** | `skills/agy-cli/SKILL.md` | Context-aware delegation guidelines |
| | `skills/adversarial-review/SKILL.md` | Skeptical, evidence-based audit guidelines |
| | `skills/session-summary/SKILL.md` | Session summary & anti-compaction skill |
| | `skills/setup/SKILL.md` | Guided setup for Voicebox, Telegram and the daemon — never handles secrets |
| | `skills/fanout/SKILL.md` | Concurrent subagents orchestration in isolated git worktrees |
| | `skills/recall/SKILL.md` | Bring a project's memory from another Claude account and save it with judgment |
| **Daemon** | `telegram-bridge/daemon.mjs` | Platform dispatcher — same npm command everywhere |
| | `telegram-bridge/daemon.ps1` | Windows: Task Scheduler, at logon |
| | `telegram-bridge/daemon.sh` | Linux: `systemd --user`, journald logs |
| | `telegram-bridge/claude-launcher.js` | Lifecycle engine & process manager for Claude Code Remote Control |
| **Commands** | `commands/run.md` | `/lagrange:run <prompt>` |
| | `commands/plan.md` | `/lagrange:plan <task>` |
| | `commands/fanout.md` | `/lagrange:fanout [plan]` |
| | `commands/watch.md` | `/lagrange:watch [slug]` |
| | `commands/review.md` | `/lagrange:review [target]` |
| | `commands/audit.md` | `/lagrange:audit [target]` |
| | `commands/summary.md` | `/lagrange:summary [focus]` |
| | `commands/narrate.md` | `/lagrange:narrate [voice/lang]` |
| | `commands/voices.md` | `/lagrange:voices [lang]` |
| | `commands/research.md` | `/lagrange:research <topic>` |
| | `commands/usage.md` | `/lagrange:usage` |
| | `commands/bridge.md` | `/lagrange:bridge` |
| | `commands/setup.md` | `/lagrange:setup [track]` |
| | `commands/integrar-lote.md` | `/lagrange:integrar-lote <batch id>` |
| **Tests** | `test/` | Dependency-free suites that drive the MCP server over real stdio with `agy` stubbed — `npm test`, or `npm run gates` for every gate at once |
| **Voice Chat** | `voice-chat/text_loop.py` / `voice_loop.py` | Real-Time Voice Mode companion scripts (console / real mic + VAD) |
| **Distribution** | `.claude-plugin/marketplace.json` | Marketplace manifest - the recommended install channel |
| | `scripts/stamp-release.mjs` | Pins the marketplace entry to the release tag's commit sha (`npm run release:stamp`) |
| | `scripts/wiki-publicar.mjs` | Publishes `wiki/` to the GitHub wiki (`npm run wiki:publish`) |

---
