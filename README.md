# Lagrange — Antigravity for Claude Code and Codex

![Version](https://img.shields.io/github/package-json/v/KZvilla/lagrange-agent-runtime?color=blue)
![Platform](https://img.shields.io/badge/platform-Windows%20|%20Linux%20|%20macOS-lightgrey)
![Dependencies](https://img.shields.io/badge/dependencies-0-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License](https://img.shields.io/badge/license-MIT-yellow)

A dual-host plugin that integrates **Google Antigravity CLI (`agy`)** with Claude Code and OpenAI Codex as an autonomous subagent and pair-programming partner.

Delegate deep reasoning, architectural planning, TDD implementation, adversarial code reviews and cited web research to Antigravity, running directly in your terminal. Claude Code remains fully supported; Codex uses the same skills and MCP server through its native plugin manifest.

**Documentation:** [Reference](REFERENCE.md) (tools, parameters, commands, components) · [Wiki](https://github.com/KZvilla/lagrange-agent-runtime/wiki) (guides, architecture, ADRs).

---

## 📑 Table of Contents

- [Quick Start](#-quick-start)
- [Features](#-features)
- [Prerequisites](#-prerequisites)
- [Slash Commands](#️-slash-commands)
- [MCP Tools Reference](#-mcp-tools-reference)
- [Permissions (ALLOW / DENY)](#️-granular-permissions-system-allow--deny)
- [Concurrent Subagent Fan-Out (`/lagrange:fanout`)](#-concurrent-subagent-fan-out-lagrangefanout)
- [Lagrange Watch (`/lagrange:watch`)](#️-lagrange-watch-lagrangewatch)
- [Persistent SKILL-Bound Agents (`cast_agent`)](#-persistent-skill-bound-agents-cast_agent)
- [Souls (`alma`)](#-souls-alma)
- [Messages between sessions (`mensaje`)](#-messages-between-sessions-mensaje)
- [Recall: another account's memory](#-recall-another-accounts-memory)
- [Claude Code mods (`hooks/mods.tsx`)](#-claude-code-mods-hooksmodstsx)
- [Model & Effort Configuration](#️-model--reasoning-effort-configuration)
- [Telemetry (`/lagrange:usage`)](#-telemetry--usage-tracking-lagrangeusage)
- [Session Summary & Anti-Compaction](#-session-summary--anti-compaction-lagrangesummary)
- [Voice Checkpoint Narration](#️-voice-checkpoint-narration-lagrangenarrate)
- [Real-Time Voice Mode (`voice-chat/`)](#️-real-time-voice-mode-voice-chat)
- [Deep Web Research (`/lagrange:research`)](#-deep-web-research-lagrangeresearch)
- [Components](#-components)
- [Installation & Setup](#-installation--setup)
- [Codex and Other MCP Clients](#codex-and-other-mcp-clients)
- [Telegram Bridge & Remote Control](#-telegram-bridge-setup-manual--never-automated)
- [License](#-license)

---

## ⚡ Quick Start

### Claude Code

**1. Install** - two commands inside Claude Code, any platform:

```text
/plugin marketplace add KZvilla/lagrange-agent-runtime
/plugin install lagrange@kzvilla-lagrange
```

**2. Restart Claude Code.** `/reload-plugins` picks up commands, agents and
skills, but the MCP tool schemas of a running session are the ones registered
at startup - a restart is what makes `agy_run` and friends appear.

**3. Try it:**

```text
/lagrange:run Analiza este proyecto y describí la arquitectura
```

```text
/lagrange:review
```

```text
/lagrange:summary
```

```text
/lagrange:narrate
```

```text
/lagrange:research "Latest patterns for Claude Code plugins in 2026"
```

```text
/lagrange:usage
```

### Codex

Install from a release tag (or from a local clone — see [Native Codex plugin](#native-codex-plugin)):

```bash
codex plugin marketplace add KZvilla/lagrange-agent-runtime --ref <release-tag>
codex plugin add lagrange@kzvilla-lagrange-codex
```

Start a new Codex thread after installing so it discovers the plugin's skills
and MCP tools. Ask it to use `$agy-cli` or describe the delegation in natural
language; Claude-only `/lagrange:*` commands do not apply in Codex. The plugin
keeps its current state under `~/.claude/` during the MVP so Claude Code and
Codex do not split agent memory or configuration.

---

## 🚀 Features

| | Feature | Description |
|---|---------|-------------|
| 🤖 | **Autonomous Subagent** | Claude spins up Antigravity to execute complex tasks, multi-step refactors, and test suites |
| 🔀 | **Concurrent Fan-Out** | Runs parallel Antigravity subagents across isolated git worktrees with disjoint-file safety checks (`/lagrange:fanout`) |
| 👁️ | **Lagrange Watch** | Inspect the local Lagrange inventory by source, plus live fan-out progress, diffs and stop controls (`/lagrange:watch`) |
| 🧠 | **Dual Model Intelligence** | Combines Claude with Gemini models (3.8 Flash) with configurable reasoning effort |
| 🎙️ | **Voice Checkpoint Narration** | Zero-Claude-token spoken status updates with declarative voice routing, independent Souls, and text-only degradation |
| 🗣️ | **Real-Time Voice Mode** | Full-duplex spoken conversation with barge-in, mic capture, Silero VAD and independent Soul/acoustic routing through local Voicebox or OmniVoice providers |
| 📋 | **Anti-Compaction Session Summary** | Analyzes raw JSONL session logs with Gemini (1M context) to generate persistent, structured Markdown docs before context degrades |
| 🌐 | **Cited Web Research** | Leverages Antigravity's native web search and synthesis capabilities that Claude Code lacks out of the box |
| 📱 | **Telegram Bridge & Remote Control** | Control tasks from your phone, approve plans, receive voice notes, and launch `claude --remote-control` sessions |
| 🛡️ | **Granular Permissions** | ALLOW / DENY capabilities, forbidden paths, forbidden commands, and sandbox isolation |
| ⏱️ | **Robust Timeouts** | Auto-injects `--print-timeout` (15m default, 20m for reviews, 25m for audits) to prevent premature drops |
| 📊 | **Live Telemetry** | Token usage, thinking tokens, context caching savings, and context window saturation |
| 🔄 | **Multi-Turn Continuity** | `conversation_id` enables back-and-forth iteration with full workspace memory |
| ⚙️ | **Flexible Config** | Per-prompt, per-project JSON, or environment variables |
| ⚡ | **Zero Dependencies** | Lightweight stdio MCP server in pure Node.js |

---

## 📋 Prerequisites

| Requirement | Details |
|-------------|---------|
| **Node.js** | **≥ 20.12** for the Telegram bridge (it loads `.env` with `process.loadEnvFile`); ≥ 18 is enough if you only use the `agy_*` MCP tools |
| **Antigravity CLI** | `agy` or `agy.exe` installed and on your `PATH` ([Install guide](https://antigravity.google/cli)) |
| **Claude Code** | Active Claude Code terminal session |
| **Google API Key** | Configured for Antigravity (`GEMINI_API_KEY` or `agy auth login`) |

---

## 🛠️ Slash Commands

The command table is in [REFERENCE.md](REFERENCE.md#slash-commands).

> **Tip:** You can also ask Claude naturally — *"Delegale a agy que resuma esta sesión"*, *"¿Qué voces tengo disponibles?"* o *"Cuando termines, ejecuta la narración con Cloud Finch"* — and it will pick the right tool automatically.

---

## 🔧 MCP Tools Reference

The tool table, the parameter tables and their defaults are in [REFERENCE.md](REFERENCE.md#mcp-tools-reference).

---

## 🛡️ Granular Permissions System (ALLOW / DENY)

### Permission Fields

The fields and defaults are in [REFERENCE.md](REFERENCE.md#permission-fields).

### Read-only isolation (SEC-020)

`agy_plan`, `agy_review` and `agy_audit` run inside the same Docker boundary as the confined batches (`agy_lote`): a container on an `--internal` network whose only way out is the allowlist proxy, with a decoy token (the real one lives in the proxy), a read-only root, no MCP servers and none of your home directory. What the subagent sees:

- **`/trabajo`, a read-only snapshot of the working tree**: tracked and untracked files as they are on disk, uncommitted changes included. Gitignored files and files matching `deny_paths` are not copied, so in this mode `deny_paths` is a real exclusion, not a request. The snapshot is built without writing to git: `git ls-files` lists, Node copies; nothing touches your index or `.git/objects`, and `git diff`/`status` run with `--attr-source` set to the empty tree so no `.gitattributes` filter runs.
- **No `.git`.** The branch, `git status`, the last 20 commits and the diffs (uncommitted, and against the merge-base with `origin/HEAD`/`main`) are files in `/trabajo/.lagrange-auditoria/`, with `deny_paths` hunks removed.
- **One Docker volume per thread** for agy's state, so `conversation_id` works across calls (measured: a second container resumed the thread). Threads last 24 hours; a thread started on the host cannot be resumed in the container. Pass plans and specs inline: host paths do not exist inside.

It cannot write your repository, run your tests or touch host processes. It also cannot run the test suite (no `node_modules`, read-only disk): run the gates yourself first.

**Mode:** `readonly_isolation` in `.claude/antigravity.json` (or `set_config`), and `isolation: "container" | "host"` per call.

| `readonly_isolation` | Behavior |
|---|---|
| `"auto"` (default) | Container when the batch infrastructure is installed and healthy (`npm run lotes -- imagenes`, `npm run lotes -- login`). The first time it works, a marker is written and **auto never falls back to the host again**: a missing image or a stopped Docker is an error, not a silent downgrade. Before that, it runs on the host with a ⚠️ warning at the top of the output. |
| `"container"` | Always the container; error if it is not available. `isolation: "host"` is refused. |
| `"host"` | As before phase 2: agy on the host, where it can run commands and write files. |

The output footer says where each call ran (`Isolation: container …` or `Isolation: host — reason`). Setup adds a token refresh, a proxy and a network per call (about half a minute).

**Still on the host:** `agy_research` (it needs to reach arbitrary sites, and the proxy only allows exact hosts by design) and `agy_session_summary` (its input is your own session log). They keep the before/after `git status` check below.

**What changed while it ran (SEC-020).** `agy_plan`, `agy_review`, `agy_audit` and `agy_research` take a `git status` snapshot of the repository that contains `cwd` before and after the run, and their output lists every difference as a transition (`clean → .M`, `?? → gone`, a moved `HEAD`…). Nothing is reverted or deleted. The check only sees that repository: gitignored paths, writes elsewhere and killed processes are invisible to it, and a change you make yourself during the run shows up too. These tools carry no MCP read-only annotation, so your client may ask for approval on each call.

> [!IMPORTANT]
> **How these are enforced, and how far that goes (on the host).** Only three things reach the CLI as real flags: `--mode plan`, `--sandbox` and `--dangerously-skip-permissions`. Everything else — `allow`, `deny`, `deny_paths`, `deny_commands` — is injected as natural-language guardrails at the top of the subagent's prompt. They shape behavior reliably in practice, but they are instructions to a model, not a sandbox: treat them as hygiene and blast-radius reduction, **not** as a security boundary against a determined or malfunctioning agent. **`mode: "plan"` is not a read-only boundary either:** every delegating tool also passes `--dangerously-skip-permissions`, and with it plan mode still runs shell commands. In practice that has meant an audit that ran the test suite despite `deny_commands: ["node*"]`, wrote a 64 KB `diff.diff` into the audited worktree despite `deny: ["edit"]`, and, earlier, one that killed every `node` process on the machine. The only real containment is a container that sees nothing but a copy of the project — the executor of the confined batches, which `agy_plan`, `agy_review` and `agy_audit` now use (see [Read-only isolation](#read-only-isolation-sec-020)). A git worktree is not one: agy writes to absolute paths outside it.
>
> **`sandbox: true` is narrower than it sounds, and on Windows it is actively harmful.** Its own help text says *"terminal restrictions"*, and that is exactly what it is: measured on `agy` v1.1.26, it blocks shell reads, shell writes and `curl`, while the native tools walk straight past it — the subagent still writes files, still reads absolute paths outside its workspace, and still fetches URLs. Worse, it mounts a jail over the working directory, so a `cwd` you passed is ignored and writes land in the main repository instead; it triggers a UAC elevation prompt, which rules out headless or concurrent use; and it leaves a mount that outlives the process. A git worktree via `cwd` (what `agy_fanout` does, without exposing `sandbox`) keeps concurrent subagents from colliding in the main checkout, but it does not confine them either: agy writes to absolute paths outside it.

> **Audit deadlines have three owners.** `agy_review` defaults to a 20-minute CLI deadline and a 21-minute process watchdog; `agy_audit` uses 25/26 minutes. The confined batch auditor also uses 25/26 minutes, but runs behind the persistent batch state after the web request returns. An MCP host may impose a shorter transport deadline (some cut calls near 300 seconds). Lagrange honors `notifications/cancelled` and terminates the process tree; a client that silently drops its pending request cannot be inferred from a quiet JSON-mode model. In that case raise the host deadline or use an existing persistent/background path instead of retrying blindly.

### Fallback to a secondary Claude account when agy cannot run (FEAT-097)

When agy runs out of quota, is not installed or is down, Lagrange can retry with a **secondary Claude account**
(`motores.cuentas`, FEAT-085) through the `claude` engine. It is **off by default** and **global only**: with it on,
those texts — including a full session transcript for `agy_session_summary` — and soul chats go to that account.

```json
{
  "motores": { "cuentas": { "trabajo": { "configDir": "~/.claude-work" } } },
  "fallback_agy": "claude@trabajo"
}
```

Set it in `~/.claude/antigravity.json` or with `set_config` (`scope: "global"`; a project config cannot turn it on).
The account must be listed in `motores.cuentas`; otherwise the value is ignored with a warning.

| Work | Model | Effort |
|---|---|---|
| Texts: persona rewrite, `say` polish, `narrate` script, `agy_session_summary` (and its strict review) | Haiku 5.5 | low |
| Voice-chat consolidation | Haiku 5.5 | default (medium) |
| Soul chat | Haiku 5.5 | `medium` |
| Read-only cast | Sonnet | `medium` |

- **agy stays first.** The account only answers when agy cannot: quota (`Resets in …` is remembered and shared by the
  MCP, the bot and the consolidator, so agy is not retried until then), agy missing, or agy unavailable. A timeout, an
  invalid model or a cancellation never switch engines.
- **Same isolation as any `claude@<account>` role.** Texts, souls and consolidation run with the `sin-tools` profile
  (no tools, `--safe-mode --strict-mcp-config`); texts use a neutral system prompt instead of the soul's voice. Casts
  use `lectura` (Read/Grep/Glob); a read/write agent has no fallback. Without current isolation probes for that
  account the request has no fallback (the probes start in the background), and the account's 5-hour quota brake
  applies: it never moves to another account.
- **Only roles without a fixed engine.** A role set in `motores.roles` never falls back. A soul or agent keeps a
  separate thread per engine: the fallback continues its `claude@<account>` thread, or starts one.
- Output, soul journal and provenance name the real writer — `🎭 En personaje, escrito por Claude · trabajo (agy sin
  cuota hasta …)` — and usage is recorded under `claude@<account>`. The web console shows
  `agy → Claude · <account> (fallback)` while the quota window is open.
- The Codex fallback of FEAT-093 (`"fallback_agy": "codex"`) was retired: the value is ignored with a warning.

#### DeepSeek as the fallback (FEAT-168, FEAT-167)

`"fallback_agy": "deepseek"` sends the same work to the DeepSeek API (`deepseek-flash`, the engine of FEAT-166) instead
of a Claude account. Same rules: off by default, global only (Settings, `set_config scope:"global"` or the file), agy
stays first, the quota window is shared, a timeout or cancellation never switches. The key is the one in the bridge
`.env` (`DEEPSEEK_API_KEY`); without it the request keeps agy's error and says why.

| Work | Effort |
|---|---|
| Texts (persona, `say`, `narrate`, `agy_session_summary`) | `low`, no tools, no thread, neutral system prompt |
| Soul chat | `low`, with the soul's voice and its own `deepseek` thread (started with the memory snapshot) |
| Voice-chat consolidation | `high` |
| `agy_audit`, `agy_review` | `max`, read-only tools (below) |
| `agy_plan` | `high`, read-only tools |
| Casts | no fallback (the DeepSeek engine does not run casts) |

**Read-only tools for `agy_audit` / `agy_review` / `agy_plan`.** DeepSeek gets three tools implemented in Node —
`list_files`, `read_file`, `grep` — over a **snapshot** of the working tree built exactly like the container's (SEC-020):
`git ls-files -co --exclude-standard`, no `.git`, no gitignored files, no `deny_paths`, no links, and the git context in
`.lagrange-auditoria/`. `.env*` files are left out even if tracked. A path outside that list, with `..`, absolute, or
that turned into a link after the list was built is refused; `grep` runs in a worker that is killed after 10 s, so a
model-written regex cannot hang the MCP. There is no shell, no write and no network besides the API call; the snapshot
is deleted afterwards. Up to 80 steps; the report keeps the same shape as agy's, says `Fallback: DeepSeek (agy sin cuota
hasta …)` and the isolation line, and usage is recorded once under `deepseek`. A call resuming an agy thread
(`conversation_id`) never falls back, and if `readonly_isolation: "container"` refuses to run, DeepSeek does not run
either.

The same three tools accept `engine: "deepseek"` to run DeepSeek **on request** without launching agy (it rejects
`conversation_id` and `isolation`, and ignores `model`/`effort`). It is meant for when you ask for it, not as an
automatic second opinion.

#### OpenCode Go as the fallback (FEAT-175)

`"fallback_agy": "opencode-go"` sends texts, Soul chat and voice-chat consolidation to the OpenCode Go plan
(`deepseek-v4.1-flash`, the engine of FEAT-173) with the same efforts as DeepSeek (`low`, `low`, `high`) and the same
rules. The key is `OPENCODE_GO_API_KEY` in the bridge `.env`. Since FEAT-176 it also covers `agy_audit` /
`agy_review` / `agy_plan`, like DeepSeek (below); casts have no fallback there either.

#### OpenCode Go with read-only tools (FEAT-176)

`agy_audit`, `agy_review` and `agy_plan` accept `engine: "opencode-go"`: the same read-only loop, tools and snapshot as
DeepSeek, on the OpenCode Go plan (`deepseek-v4.1-flash`; `max` for audits and reviews, `high` for plans), on request
only. Go spreads requests over several upstream providers and one of them may answer without `reasoning_content`;
DeepSeek's upstream then rejects the history, so with Go every assistant message goes back with the field (`''` when it
did not come). Measured on 2026-10-21: a full audit in `max` (75 steps, 9 M tokens, 98 % cached) took about 1 % of the
5-hour window and 1 % of the week. Effort for the Soul roles on Go is now `low`, `high` or `max`.

### Confined batches written by Claude (FEAT-131)

`agy_lote` can have **Claude Code** write the tasks instead of agy — with `motor: "claude@<account>"` — inside the
**same container boundary** as agy: `--internal` network, allowlist proxy, read-only root, a flat copy of the worktree
as the only writable mount. It is the only place where Claude gets edit tools from Lagrange: `agy_run` and
`agy_fanout` run on the host, where nothing but the prompt would confine it. It is **never chosen automatically**.

```text
npm run lotes -- imagenes-claude          # Claude Code (pinned version) + the proxy with the Claude profiles
npm run lotes -- login-claude trabajo     # prints the one-time interactive login into a Docker volume
npm run lotes -- sondar-claude trabajo    # the edit-profile probes; required before the first batch
```

- **The secret never touches the host.** The account logs in once *inside* the image; the OAuth lives in the volume
  `lagrange-claude-<account>-home`, a session separate from the account's login on the host (`~/.claude-work` is never
  read). Before each batch a refresher container renews it and exports the access token to the proxy; the task only
  sees a decoy `.credentials.json` without `refreshToken`, and the proxy swaps the decoy for the real token on
  `POST api.anthropic.com/v1/messages` and nothing else. Token renewal (`platform.claude.com`) is only open to the
  refresher.
- **The edit profile:** `Read, Edit, Write, Glob, Grep, Bash`, `--permission-mode acceptEdits`,
  `--strict-mcp-config --safe-mode`, no session persistence, never `--resume`. The account must be listed in
  `motores.cuentas`. Models are Claude aliases or ids (default `sonnet`); effort is validated per model (Haiku takes
  none).
- **Probes gate it.** `sondar-claude` runs the real refresher and a real task on a throwaway repo and decides on
  evidence: the `init` lists exactly those tools, no MCP servers and `apiKeySource: "none"`, and a canary file reaches
  the commit only through the sync. The result is keyed by Claude Code + Lagrange version: after an update of either,
  run it again.
- **The audit still runs on agy.** A batch written by Claude is not refused for agy's quota (that is the point), but
  if Gemini is exhausted its audit errors and the batch cannot be integrated until it is audited.
- When Gemini is low, the quota prompt before `agy_lote` (FEAT-111) adds **«Usar claude@<account>»** — only with
  current probes and at least 20 % of that account's 5-hour window left, read from what is already saved. Choosing it
  asks the model to relaunch the same batch with that `motor`. Usage and the 5-hour quota are recorded under
  `claude@<account>`.

### Per-Call Example

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

### Persistent Defaults (`.claude/antigravity.json`)

```json
{
  "model": "gemini-3.8-flash",
  "effort": "high",
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
        "audio": {
          "profile": "Rowan Vale",
          "provider": "voicebox",
          "engine": "qwen",
          "model_size": "0.6B"
        }
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

> **Scope:** Place in `~/.claude/antigravity.json` for global defaults, or `.claude/antigravity.json` in a project root for per-project overrides.
> A project-level `voice_setup` replaces the complete global block; defaults,
> identities and fallbacks are never deep-merged across scopes.

---

## 🔀 Concurrent Subagent Fan-Out (`/lagrange:fanout`)

Execute multiple Antigravity subagents **in parallel**, each in its own dedicated `git worktree` (`.claude/worktrees/agy-<slug>-<n>`) and branch (`wt/agy-<slug>-<n>`, off the base branch `feat/<slug>`), reserving auditing, testing, and integration for Claude.

```text
/lagrange:fanout
```

Or point directly to a planned task list or spec:
```text
/lagrange:fanout plans/my-plan.md
```

### The Atomic Task & Disjointness Contract

Fan-out only pays off if tasks are **strictly disjoint in files**. Worktrees isolate execution, not integration: if two concurrent subagents modify the same file, the collision is not avoided, merely postponed to merge time.

Before spending any model quota or spawning processes, `agy_fanout` validates the file allocation:
- Each task declares `id`, `prompt`, and `archivos` (repo-relative paths; a trailing `/` denotes a whole subtree).
- Absolute paths and path traversal (`..`) are strictly rejected.
- If two tasks touch the same file or overlapping subtrees, the entire batch is **rejected upfront** with clear collision diagnostics.

### Why Git Worktrees over `--sandbox`

As measured on `agy` v1.1.26, `--sandbox` only restricts terminal commands, mounts a jail that ignores `cwd`, triggers Windows UAC elevation prompts (blocking headless parallel runs), and still allows native file tools to write outside the workspace.

Instead, `agy_fanout` gives each subagent its own physical `git worktree` derived from a clean base branch:
- Keeps concurrent subagents from colliding in the main checkout. It is not a write boundary: agy can still write to absolute paths outside the worktree (only the confined batches of `agy_lote` run in a container).
- Never touches or checks out `main` or `master` directly.
- Avoids branch locking conflicts (git forbids two worktrees on the same branch).

### Concurrency Capping & Quota Backoff

- **Concurrency Cap (`concurrencia`)**: Defaults to `3` subagents running simultaneously. The cap protects API rate limits and token quotas, not CPU.
- **Automatic Quota Backoff**: If any subagent encounters an HTTP 429 or quota limit error, `agy_fanout` pauses and retries with exponential backoff (`20s`, `40s`). Code execution errors are never retried unnecessarily.

### Division of Responsibilities

Subagents are strictly scoped to **implement**:
- Prompt guardrails explicitly instruct them: do not write or run test suites, do not merge or switch branches, and do not spawn subagents.
- **Claude stays in control:** You and Claude review the resulting diffs (using `/lagrange:review` in parallel if desired), execute local test suites, handle up to two correction rounds resuming by `conversation_id`, and perform the final branch merge and worktree cleanup.

Parameters: [REFERENCE.md](REFERENCE.md#agy_fanout--parameter-reference).

---

## 👁️ Lagrange Watch (`/lagrange:watch`)

Watch is a standalone, read-only local console. Its dashboard inventories fan-out batches, persistent agents, Souls, shared memory and Voicebox profiles while labeling every source as local, generated, live, cached, derived or unavailable. Network services and `agy agents` are queried only when their section is opened; the initial summary reads local state only.

```bash
node <plugin>/mcp-server/fanout-watch.js            # global dashboard
node <plugin>/mcp-server/fanout-watch.js --slug X   # open a specific batch
node <plugin>/mcp-server/fanout-watch.js --port 4600
```

It prints a tokenized `http://127.0.0.1:4517/...` URL and holds the terminal until `Ctrl+C`. **You run it; nothing auto-spawns it.** The token is required on every page and API request.

The dashboard links to `/fanout`, `/agents`, `/almas`, `/memories` and `/profiles`. Voicebox discovery never starts the service: a failed live query falls back to the existing profile cache and says so. `mcp-memory` bootstrap output is explicitly a derived preview, not context already loaded into a cast. This release does not add editing endpoints.

### Live fan-out

Each subagent gets a card showing:

- **Live prose**, joined into readable paragraphs. `agy` streams `text_delta` in chunks split *mid-word*, so the raw events have to be reassembled — the viewer does it by `step_index` as they arrive, without buffering, so a subagent killed mid-sentence still shows everything it emitted.
- **Tool calls**, visually distinct from prose (`🔧 run_command → npm test`). This is usually the most informative line on the card: it says which file is being touched, which command is running.
- **Elapsed time** (live while running, frozen when finished), **attempt count** when a task retried, and **why it failed** — the actual error text, quota exhaustion, or the operator's stop reason.
- **Model, branch and the files the task declared**, which makes the disjointness contract visible at a glance.
- A **Detener** button that stops that subagent.

The header reports the batch total, and distinguishes a finished batch (`terminado en 4m00s`) from one that has simply gone quiet (`sin novedad hace 12m`) — useful because a crashed or cancelled fan-out otherwise looks identical to a running one forever.

### The persistent-agents tab (`/agents`)

The same viewer also lists your persistent agents — and, more usefully, **what each one has actually learned**. Click a row to expand its accumulated criteria: every decision and correction it committed to `mcp-memory`, with the date and how many times that memory has actually been used to rehydrate it. That last number is what separates criteria that earn their place in the token budget from criteria that just sit there.

The viewer does not need a fan-out batch to start. Without one, the global dashboard and persistent inventory remain available; `/fanout` shows the empty state.

What this view deliberately does **not** have: decision gates (there is no escalation protocol — that item was dropped after an adversarial audit) and a live "running" state (`cast_agent` runs synchronously inside the MCP server and leaves no on-disk trace while it does, so no other process can observe it). The states it shows are only the ones that can actually be read.

### Access control (`SEC-011`)

Listening on loopback never protected you from your own browser: any page open in another tab can POST to `127.0.0.1` with a simple request that does not even trigger a CORS preflight. Before this, that was enough for an arbitrary site to stop one of your subagents — and the persistent-agent dashboard (`FEAT-023`) wants to put *approval gates* on the same surface.

So the viewer now prints a URL carrying a **per-session token**:

```
http://127.0.0.1:4517/?t=7f3c…
```

Open the full URL — trimming the `?t=` gives you a 403. The token is random per launch, lives only in the process, and four layers back it up, none sufficient alone:

| Layer | Stops |
|---|---|
| Token on `GET /` and `GET /api/eventos` | Any other local process or tab reading your prompts and generated code |
| Token required in the `x-lagrange-token` **header** for mutations | A hostile `<form>`, which cannot set a custom header |
| CORS preflight refused (`OPTIONS` → 405) | A `fetch` from another origin trying to send that header |
| `Origin` / `Sec-Fetch-Site` validated, `Host` must be loopback | Cross-site POSTs and DNS rebinding |

### Stopping a subagent

The stop button writes a small sentinel file that the orchestrator picks up on its next poll (a couple of seconds), then kills that subagent's process tree. The same thing is available from any terminal:

```bash
node <plugin>/mcp-server/fanout-stop.js <repoPath> <slug> <taskId> ["motivo"]
```

Stopping is about **cost and queue time**, not safety — the worktree already contains any damage. A stuck subagent holds a slot in its batch and keeps burning quota. A worktree with half-committed work is preserved, never deleted, by the normal cleanup.

### What it reads (and where)

Everything lives under `.claude/worktrees/` in your repo — the viewer only reads what the fan-out already writes:

| File | Purpose |
|------|---------|
| `.fanout-status-<slug>.json` | Orchestration state per task (also drives the statusline) |
| `.agy-progress-<slug>-<taskId>.jsonl` | Raw NDJSON stream from that subagent, one event per line |
| `.fanout-stop-<slug>-<taskId>.json` | Stop request sentinel, consumed by the orchestrator |

> **Security:** the server binds to `127.0.0.1` only and there is no option to expose it. These logs contain your prompts and generated code, which is why every page and API request also needs the per-launch token described in [Access control](#access-control-sec-011).

Prefer a single subagent in a plain terminal? `node <plugin>/mcp-server/fanout-tail.js <rutaLog> <nombre>` tails one log with the same formatting.

### Fan-out configuration flags

Set in `.claude/antigravity.json` (or via `set_config`):

| Flag | Default | Effect |
|------|---------|--------|
| `fanout_statusline` | `true` | Write the live progress file the statusline script renders |
| `fanout_progress_log` | `true` | Write the per-subagent NDJSON log that `/lagrange:watch` renders |
| `fanout_control` | `true` | Watch for stop sentinels and kill a subagent early when one appears |

---

## 🎭 Persistent SKILL-Bound Agents (`cast_agent`)

`agy_run` is generic and stateless. `agy_fanout` spawns ephemeral workers that write code and disappear. Neither fits the third kind of work: **judgment** — code review, security audit, planning, reality checks — where you want the *same* reviewer every time, one that remembers what it already told you.

A **cast agent** has a fixed identity derived from an installed SKILL, keeps its own conversation thread across sessions, and rehydrates its accumulated criteria from `mcp-memory` before each cast.

```
cast_agent  action:"skills"                                  → what SKILLs you can derive from
cast_agent  action:"register"  agent:"reviewer"  skill:"agency-code-reviewer"
cast_agent  action:"cast"      agent:"reviewer"  prompt:"Review the diff on this branch"
cast_agent  action:"list"                                    → who exists, who resolves, thread state
cast_agent  action:"exportar"  agent:"reviewer"                → registration inputs → portable envelope (never agent.md)
cast_agent  action:"importar"  agent:"reviewer"  archivo:"..." → preview (no `confirmar`); add `confirmar:true` to apply
```

### How the identity is enforced

Registering an agent writes `~/.gemini/config/agents/<name>/agent.md`: the SKILL body becomes the agent's system prompt, and a `tools:` allowlist in the frontmatter cuts down its native tool inventory. For a read-only agent, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `notebook_edit` and `run_command` are simply **not in its context** — this is an absence, not an instruction.

Two more layers back that up:

- **`--mode plan`** is added to every cast of a read-only agent. Unlike `allow`/`deny` (which travel as prompt text — see the permissions section), this is a real CLI flag.
- **Resolution is verified before every cast.** `agy --agent <unknown-name>` does *not* fail: it silently falls back to the default agent with full write tools. So `cast_agent` checks the name against `agy agents` first and **aborts the cast** if it does not resolve, or if that check itself cannot be run.

> ### ⚠️ What `read_only` does *not* cover
>
> Antigravity injects `call_mcp_tool`, `list_resources` and `read_resource` into every agent regardless of the `tools:` allowlist. A read-only cast agent therefore still reaches **every MCP server you have configured** — including ones that drive a browser or write data. The allowlist closes the native write tools; it is not a boundary against MCP. `cast_agent action:"register"` prints exactly which servers stay reachable. Treat `read_only` as "will not edit your files directly", not as a sandbox.

### Memory and threads

- **Thread:** the `conversation_id` of each agent is persisted in `~/.claude/antigravity-agents-state.json` and replayed with `--conversation` on the next cast. Long threads grow the input token count on every turn — use `action:"forget"` to start a fresh thread without losing the agent's long-term memory, or `fresh: true` for a one-off.
- **What it writes back:** at the end of each cast the agent is asked for a short `<memoria>` block — what it concluded and why — which is committed as `decisions` (and `user_corrections`) through `commit_session_legacy`. That is the only channel the rehydration actually rereads: a commit with empty arrays lands as a `session_legacy` observation that `get_bootstrap_profile` never looks at. Errors are deliberately *not* sent: the service turns them into mistake notes that carry no `agent_id`, so they would leak into every other agent's profile. The cast reports how many entries it captured — if an agent stops emitting the block it stops learning, and that would otherwise be silent.
- **Long-term memory:** rehydration uses `get_bootstrap_profile` from `mcp-memory`, which enforces a token budget server-side (`budget_tokens`, default 2048). Isolation between agents is by native `agent_id`, not by `store` — and it is a filter, not a partition: the service shares any *mistake note* that carries no `agent_id` with every agent, while preferences and decisions are filtered strictly. Requires `MCP_BOOTSTRAP_ENABLED=true` on the memory service; without it the profile comes back as an empty shell and `cast_agent` correctly reports no context recovered. After each cast, `commit_session_legacy` records what the agent learned.
- **Degradation is silent and deliberate:** if the memory service is unreachable, disabled, or has nothing useful to say, the cast still runs — it just reports `Contexto recuperado: — no (<reason>)` instead of injecting an empty profile into the prompt.

Parameters: [REFERENCE.md](REFERENCE.md#cast_agent--parameter-reference).

---

## 🫀 Souls (`alma`)

A Soul is a durable identity and memory that can speak through any compatible
acoustic profile. It is not owned by a Voicebox profile.

- **Narration uses a Soul only when explicitly selected.** `voice_setup.identity.soul` or the per-call `soul` argument selects an existing `alma.md`; choosing an acoustic `voice` never creates or selects a Soul implicitly. Missing Souls degrade visibly to neutral. `say` and `narrate` write Soul-authored scripts as the tool-less `lagrange-alma` agent.
- **You can talk to a Soul on Telegram, and that is where it remembers.** `/charla [soul] <message>` starts a conversation, replying to one of its messages continues it, and `/charla nuevo` opens a clean thread. It answers from its own memory and reports what it retained. `/alma` shows that memory with stable ids; `/alma olvidar <id>` prunes it. The [local web console](#-local-web-console-bridge_web1) offers the same chat and memory view in a browser.
- **Voice chat keeps Soul and timbre separate.** The Python loops resolve the acoustic route from `--voice` or `voice_setup` and prime identity only from `--soul` or `identity.soul`. Nothing is written mid-conversation: on `stop`, after at least three turns, a detached process consolidates the transcript for the selected Soul. No Soul means no consolidation.
- **Emoji reactions go back to the authoring soul.** Reacting to one of its Telegram replies or narrated voice notes produces one short text response with the soul's current thread and memory. Removed/custom emoji, progress messages and bursts inside ten seconds are ignored; changing the emoji on the same message never answers twice.
- **Memory reaches the chat and the voice chat, never the narrations.** A narration may only rewrite what it was given (REWRITE ONLY), and memory would add facts. Each narration only leaves a line in the soul's diary.

```
~/.claude/lagrange-almas/        (override: LAGRANGE_ALMAS_DIR)
  usuario.md        what the souls know about you, shared by every voice (cap: 1375 chars)
  archivo-usuario.md  what left usuario.md: archived or rejected for the cap (cap: 64 KB)
  brisa/
    alma.md         identity: seeded once from the Voicebox profile, then yours to edit
    memoria.md      the soul's memory of the relationship (cap: 2200 chars)
    archivo.md      what left memoria.md: archived or rejected for the cap (cap: 64 KB)
    contaminados.json  threads that saw outside content (FEAT-172): no memory writes there
    diario.jsonl    a diary written by code, not by the model; rotated
    hilos/<uuid>.jsonl  conversation threads of the DeepSeek / OpenCode Go engines (the API keeps no state)
  .pendientes/      voice-chat transcripts waiting to be consolidated; retried, and dropped after 24h
```

```
alma  action:"semilla"  voz:"Marina Sol"      → explicitly create a Soul from that profile
alma  action:"ver"      voz:"brisa"            → identity, memory with ids, diary
alma  action:"olvidar"  voz:"brisa"  id:"m3"  → delete one entry (memory, archive and old deep-memory copies; tm…/tu… for cap rejections)
alma  action:"listar"                         → souls on disk, voices without one
alma  action:"agente"                         → install / verify the lagrange-alma agent
alma  action:"exportar"  voz:"brisa"          → portable envelope: alma.md (secrets redacted) + active memory
alma  action:"importar"  voz:"brisa"  archivo:"..."               → preview only (no `confirmar`: never writes)
alma  action:"importar"  voz:"brisa"  archivo:"..."  confirmar:true  confirmacion:"..." → applies
```

- **Seeding matches the name exactly.** "Marina" can find a unique "Marina Sol" profile, but "Mara" never guesses "Marabelle", and there is no fallback voice: seeding another profile's Soul is worse than not seeding. Re-seeding an existing Soul needs `forzar: true`, and it keeps the previous file as `alma.md.anterior`.
- **Memory entries have stable ids** (`- [m3] [2026-09-12] …`, `u2` in `usuario.md`). Ids are never reused, the caps are hard, and a write that would exceed them is rejected rather than silently dropping something. The files are plain text: edit them by hand whenever you want.
- **Memory is scanned before it is written.** Invisible characters, command-shaped text ("run this command", not "run a marathon"), URLs and secret-shaped strings are rejected. This is the hygiene layer. The hard barrier is the agent:
- **Soul calls will run as `lagrange-alma`, an agent with `tools: []`.** Verified live, that leaves it with *no* native tools at all. Note that `tools:` with no items is **not** empty: agy then grants a default read set. The MCP roster still arrives (see SEC-010 above), but soul calls never pass `--dangerously-skip-permissions`, so agy denies it on its own. And because agy fixes a thread's identity on its first turn, soul threads are always born as this agent, never converted.
- Writes from several processes (MCP, Telegram bot, background consolidation) go through a per-file lock and an atomic rename. A lock that cannot be taken fails the write instead of writing without it.
- The files are local, never versioned and never logged.
- **The archive (FEAT-171) keeps what no longer fits in memory, readable.** When a Soul *archives* an entry to make room (`archivar m5`, optionally `archivar m5 #games` in the chat), it moves to `archivo.md` with its id and original date; an entry rejected for the cap goes there too, with a synthetic id (`tm…`/`tu…`). The entry is written to the archive *first*, under the memory file's lock, and only then removed from memory: if the archive refuses it (full, scanner, lock), it stays where it was. Same one-line format as the memory, plus an optional `#topic` — the souls directory opens as an Obsidian vault. When a chat thread is born, a local word search over the archive (Spanish-aware: accents, plurals, conjugations by prefix, filler words ignored) brings at most 3 entries that share at least two meaningful words with your first message (one, if your message is a single word of 5+ letters), framed as "may be unrelated". A continued thread gets nothing new (frozen snapshot); the diary records which ids each new thread received. Every entry is scanned when written and scanned again before reaching the prompt, since you can edit the file by hand. `olvidar` is a real forget: from the chat, `/alma olvidar`, the web console or `alma`, it deletes the entry from memory and archive. `exportar`/`importar` and node migration carry the archive with its ids.
- **Mediated tools (FEAT-172): the Soul asks, the code acts.** Souls still have no tools. In a Telegram or web-console chat turn (not reactions, not scheduled runs) a Soul may end its first pass with a single request in its `<alma>` block — `buscar: <words>` (its own archive), `buscar-web: <query>` or `leer-link: <url>` — and nothing else. The code runs it and a second pass answers on the same thread and engine; everything else from the first pass (prose, memory and board operations) is discarded, and a request in the second pass is ignored. `/cancel` between passes stops the second one. The reply footer shows what was asked (`🔎`, `🔗`), including a web query that was refused.
- **Photos and web content go through an isolated mediator.** Reply with a photo (or an uncompressed image document) to one of a Soul's messages, send one to a Soul's own bot, or use the photo button in the web console: a one-shot `deepseek-flash` call that knows nothing about the Soul (no `alma.md`, memory, `usuario.md`, history or tools) describes it, and the Soul gets that description framed as data. A photo sent outside a Soul conversation still opens a card (FEAT-065), even during a fresh chat. Web search and page reading use DeepSeek's Search & Fetch APIs (`DEEPSEEK_API_KEY`, $0.75 per 1000 successful calls each); the same mediator summarizes the results, and the Soul sees the summary plus title and domain of each source, never raw pages or URLs.
- **Outside content taints the thread, not just the turn.** Once a thread has seen a photo description, search results or a page, it writes no memory and touches no board until it is renewed (`/charla nuevo`, the 6-hour window, DeepSeek's cap): an injection can act on any later turn. The mark lives in `<soul>/contaminados.json` and fails closed if unreadable. The diary keeps what you wrote, never the mediator's text, and the next thread's snapshot shows only your side of a tainted turn. Web queries are capped (100 chars, 12 words, only `lang:`/`after:`/`before:` operators, no URLs); in a tainted thread a query is refused if it carries a word from what the Soul knows about you (`usuario.md`, its memory, its archive) that you did not write in that turn and the mediators did not bring, so an injection cannot make it leak that through the query. Rephrasing — in English too, which is how the model reasons — is allowed. `leer-link` only opens a URL you wrote in that turn or one a search returned in that thread.
- **Continuity without extra calls.** Every chat turn tells agy and Claude the date (DeepSeek already gets it). The diary keeps what you said, and a new thread's "Últimas interacciones" lists your last five exchanges (you → the Soul, reactions, voice chats; not memory-operation lines) and how long ago the last one was.
- **Deep memory (FEAT-046) is now legacy for Souls.** `mcp-memory` is no longer searched and gets no new copies (its stock image only embeds English, and it returns no score filtered by store). `npm run almas-profunda -- volcar <soul> [--confirmar]` brings what only lives there (archived and cap-rejected entries, the Soul's and the shared ones) into the archive once, keeping ids and dates; without `--confirmar` it only shows what it would do. `olvidar` still deletes old copies there. `buscar <soul> <query>` remains for diagnosis; `importar` is obsolete. Casts and agy keep using `mcp-memory` as before.
- **Export/import (FEAT-051) moves identity, memory and `usuario.md` between machines through a portable JSON envelope, never a raw file copy.** `alma.md` is redacted before it leaves the machine (secret-shaped substrings only — URLs and imperative phrasing are left alone, since the identity file *is* the voice's instruction); an envelope coming back in is redacted again and additionally scanned for order/injection patterns, which are reported but never silently stripped — an identity you brought from another machine is untrusted input in a way one you edited by hand is not. Import always previews first (diff for identity, accept/reject counts for memory) and only writes on a second call with `confirmar: true` and the exact token the preview returned; a stale token (destino changed since the preview) is a conflict, not a second guess. Memory entries import as `agregar` operations through the same `aplicar()` a manual edit uses — never a file replacement — so they inherit its lock, cap and scan, and keep their original date instead of being stamped with the import date. `cast_agent action:"exportar"|"importar"` does the analogous thing for a persisted agent's registration inputs (skill, tools, description, addendum, `project_id`) — never `agent.md` itself, and never the agent's accumulated `mcp-memory` criteria, which the import says out loud rather than leaving to be discovered on the first cast. Neither direction ever talks to Voicebox: a "voice profile" export (`tipo:"voz"`) is a read-only reference for reseeding an `alma.md` by hand, never something Voicebox can load back.

### Engines per role: Souls and read-only casts on Claude (FEAT-072)

By default everything runs on Antigravity. You can move a **role** to `claude -p` (your Claude Code subscription) for better judgment — a Soul, the background consolidation, or a read-only reviewer — without giving it more privileges:

```jsonc
// ~/.claude/antigravity.json  (or set_config motores:{…})
{
  "motores": {
    "roles": {
      "alma":        { "motor": "claude", "modelo": "sonnet", "esfuerzo": "medium" },
      "alma:tm":     { "motor": "antigravity", "modelo": "gemini-3.8-flash", "esfuerzo": "high" },
      "consolidar":  { "motor": "antigravity" },
      "cast:lagrange-reviewer": { "motor": "claude", "modelo": "opus", "esfuerzo": "high" }
    },
    "claude": { "bin": null, "freno_cuota_5h": 0.8 }
  }
}
```

- **Roles:** `alma`, `alma:<soul>` (wins over `alma`, FEAT-075), `consolidar`, `consolidar:<soul>` (wins over `consolidar` for that Soul's voice-chat consolidation, FEAT-079), `cast`, and `cast:<agent>` (wins over `cast`). A per-subject role replaces the general one **as a whole**: it never inherits a missing `modelo` or `esfuerzo` from it. A role on `claude` **must** name `modelo`: the CLI never picks one on its own. `esfuerzo` is passed as-is (`low`…`max`); models without effort support (Haiku 4.5) ignore it. An invalid `roles` section is reported and ignored **entirely** — everything stays on Antigravity, never half-applied.
- **Only two profiles exist on Claude.** A Soul runs with **zero tools** (`--tools ""`) and the same voice instructions agy gets as `lagrange-alma`; a read-only cast gets `Read,Grep,Glob` with `--restricted`. A cast with write access never runs on Claude. Every launch — every `--resume` included — repeats `--safe-mode --strict-mcp-config --permission-mode default --permission-prompts none`, so the child loads neither Lagrange's MCP server nor your hooks, and never inherits `auto` mode. The prompt goes through stdin (never argv), and the child's environment is stripped of the parent session's variables (SEC-019).
- **Isolation is verified, not assumed (SEC-018).** Before a role on Claude runs, five short probes (C1–C7, on Haiku) must have passed for the installed Claude Code and Lagrange versions: no tools, no MCP servers, no hooks, no writes. The bot runs them in the background at startup when a role uses Claude; `alma action:"agente" sondas:true` runs them on demand and shows the evidence. Until they pass, the call is refused with the reason — never silently moved to another engine.
- **Binary:** `motores.claude.bin`, then `PATH`, then `%USERPROFILE%\.local\bin\claude.exe`. An npm `.cmd` shim is rejected (it cannot be launched without a shell): point `bin` at `claude.exe`.
- **Cost stays visible.** The Telegram footer shows `model · claude`, `agy_usage` shows usage per engine and the Claude 5-hour/7-day quota, and `freno_cuota_5h` (opt-in, 0–1) refuses scheduled/background work above that utilization. Your own requests are never braked.
- **From the web console (FEAT-075).** Each Soul's and each read-only agent's side panel shows its engine (`claude · sonnet · medium`, and whether it is its own or inherited) and lets you change provider, model and effort. Only combinations the model accepts are offered (the same per-model effort table `set_config` validates against), and a rejected one saves nothing. The console edits only per-subject roles (`alma:<soul>`, `consolidar:<soul>` in the Soul's *Consolidación* block, `cast:<agent>`); the general `alma`, `consolidar` and `cast` stay with `set_config`. Moving a subject to Claude starts its isolation probes in the background and shows their state; switching a Soul's provider starts a new thread on that provider (its memory stays), and switching back within 6 hours resumes the previous one. The next turn uses the change — no restart.
- Narration, `agy_run/plan/audit/review/research/fanout` and the voice session always stay on Antigravity.

#### DeepSeek as the Souls' understudy (FEAT-166)

agy is the main actor; **DeepSeek** (`deepseek-flash`, DeepSeek V4.1 Flash) is an optional understudy for **Souls and their consolidation only** (`alma`, `alma:<soul>`, `consolidar`, `consolidar:<soul>`), over the DeepSeek API with no third-party harness:

```jsonc
// ~/.claude/antigravity.json — GLOBAL only
{ "motores": { "roles": { "alma:alya": { "motor": "deepseek", "modelo": "deepseek-flash", "esfuerzo": "low" } } } }
```

- **The key lives only in the bridge `.env`** (`DEEPSEEK_API_KEY=` in `%LOCALAPPDATA%\antigravity-telegram-bridge\.env`, the same file as the Telegram token). The engine reads just that variable from the file on every request; the daemon removes it from its own environment after loading the `.env`, so no child process can inherit it (SEC-027 strips Lagrange's other secrets from every child that runs a model). It never appears in results, logs, the diary, `telegram_bridge_status` (which only says whether it is set) or the web console (which shows *key set/missing* and your balance).
- **Global configuration only.** A DeepSeek role sends the Soul's memory to a third party with *your* key, so a cloned repository cannot choose it: a `deepseek` role in a project's `.claude/antigravity.json` is dropped with a warning, and `set_config scope:"project"` rejects it. (Claude roles from a project still work: they use the subscription you already chose for Lagrange.) Note that a project that defines `motores.roles` replaces the global table as a whole.
- **Nothing to configure.** URL, key variable, model (`deepseek-flash` only: DeepSeek ships new versions under the same name and routes Pro to Flash) and the thread cap are constants; there is no `motores.deepseek` section. `esfuerzo` is `low` (default), `high` or `max`.
- **No tools, by construction.** The request body comes from a fixed whitelist and never carries `tools`; a response with `tool_calls` is an error. There is no process that could run anything, so — like agy's `sin-tools` — this profile is *verified by construction* rather than by SEC-018 probes.
- **The thread is ours.** The API keeps no state, so each Soul's conversation is stored in `<soul>/hilos/<uuid>.jsonl` (the reply without its `<alma>`/`<tablero>` blocks, sanitized). The file is the source of truth: if it is missing, truncated or past 64k prompt tokens, the next turn starts a new thread **with the memory snapshot** — a failed turn never leaves a Soul without memory. The date goes in the last message of each turn, so the prefix stays cacheable. "New thread" (`/charla nuevo`) never deletes a thread file.
- **Limits in phase 1:** no live streaming (the reply arrives whole), no fallback to Claude when DeepSeek fails (a role on DeepSeek is fixed), and agy must still be installed. To use DeepSeek only when agy cannot, instead of fixing a role on it, see `"fallback_agy": "deepseek"` (FEAT-168). Cost is not estimated (`costoUsd` stays empty); the console shows your DeepSeek balance instead.

#### OpenCode Go for Soul chat and consolidation (FEAT-173, FEAT-175)

An optional engine for **Soul roles only** (`alma`, `alma:<soul>`, and since FEAT-175 `consolidar`, `consolidar:<soul>`; never casts): DeepSeek V4.1 Flash served by an [OpenCode Go](https://opencode.ai/docs/go/) subscription instead of the DeepSeek API. The key goes in the bridge `.env` as `OPENCODE_GO_API_KEY` (not `OPENCODE_API_KEY`, which belongs to the opencode CLI); like DeepSeek's, it never reaches any child process.

```json
{ "motores": { "roles": { "alma": { "motor": "opencode-go", "modelo": "deepseek-v4.1-flash", "esfuerzo": "low" } } } }
```

- **Same construction as `deepseek`:** whitelisted body with no tools, the thread stored on our side, the date in the last message. It sends its own user agent and an `x-opencode-session` header equal to the thread id, as Go asks. Effort is `low` (default), `high` or `max` (FEAT-176).
- **If Go cannot answer, agy does.** An upstream 429 ("Endpoint is unavailable") or 502/503 is retried twice; any other failure — another 429 (quota), a missing key — repeats the turn (or the consolidation) once on agy, with the bot's model, and the footer says `agy (fallback: OpenCode Go no pudo)`. It never chains on to `fallback_agy`.
- **Quota in the console.** Go reports its 5-hour, weekly and monthly windows (`/v1/usage`); the Soul panel's engine block and Ajustes → Motores show them as percentages. An engine that cannot report a quota shows nothing.
- **Global configuration only**, as with DeepSeek. Go's terms describe it as meant for coding agents; Soul role-play is not that kind of traffic.

## 📨 Messages between sessions (`mensaje`)

Two Claude Code sessions on the same machine (two terminals, two projects) can talk to each other through the Telegram daemon, which keeps a list of the open sessions and one mailbox per session:

```
mensaje  accion:"agentes"                                  → the open sessions (local/<name>), this one marked
mensaje  accion:"enviar"  para:"tests-bridge"  texto:"…"   → delivered now, or an error now (no queue)
mensaje  accion:"enviar"  para:"…"  texto:"…"  esperar:300 → and wait up to 5 minutes for the reply
mensaje  accion:"leer"                                     → what other agents sent this session (3 at a time)
mensaje  accion:"responder"  id:"m_…"  texto:"…"
mensaje  accion:"nombre"  nombre:"tests-bridge"            → by default a session is named after its folder
mensaje  accion:"silenciar"  si:true
```

- **How the other session finds out.** Plugin hooks tell it that it has mail when it finishes a turn, when you type, and — if it is idle — they wake it up (an `asyncRewake` hook). The hooks only say *who* wrote; the text is read with `mensaje leer`, where it arrives marked as a message from another agent, not from you.
- **Pre-approve the tool.** A session that is woken up while you are away needs to call `mensaje` without a permission prompt, or it stops there waiting for you. Add `mcp__plugin_lagrange_lagrange__mensaje` to `permissions.allow` (or answer *don't ask again* the first time).
- **It is not you.** The receiving session is told to treat it as a colleague's request and to ask you before anything destructive, outside its project, or that you did not ask for. Its own permission mode still applies.
- **Brakes.** A conversation of 10 back-and-forths between agents stops and asks you; a session can send 30 messages an hour. Texts are capped at 8 KB and secrets are redacted.
- **Needs the daemon** (`npm run bridge:daemon:start`). Codex sessions can send and read, but are not notified.
- **Across nodes.** In a node network, `agentes` lists every session of the network as `<node>/<name>` (each node sends its list to the server), and `para:"casa-wsl/tests-bridge"` reaches a session on another node through the server. The receiving side decides: a message from another node is accepted only where `BRIDGE_NODO_PERMITE=ejecutar` (on the server too, which is a destination like any node), because it makes that session act with its own permissions. Two sessions on the same node never need the server. There is still no queue: a disconnected node or a missing session is an error right away.
- **The server's voice.** A node without Voicebox that runs `say` or `narrate` with Telegram (and without local playback) sends the final text to the server, which synthesizes it with its own Voicebox and delivers the voice note, one at a time (up to 5 waiting). If the server cannot either, the text goes out as before. Without a `voice`, the server uses its own voice setup, or the documented default for the language (Diego Alvarez for Spanish, Emily for English). A node that reaches Voicebox on another machine (WSL in mirrored mode uses the Windows one at `127.0.0.1:17493`) downloads the generated audio over HTTP, with no shared folder or `VOICEBOX_DIR` needed. The console's *Sesiones* view lists the agents of the network (never the messages).

## 🧠 Recall: another account's memory

Claude Code keeps its automatic memory per account (`<account folder>/projects/<project>/memory/`). With a second account on the same machine (for example a `claude-work` shell function that sets `CLAUDE_CONFIG_DIR=~/.claude-work`), what one account learned about a project is invisible to the other. `recall` reads it across:

```
recall                              → which accounts have memory for this project (the session's own is not listed)
recall  desde:"work"                → that account's MEMORY.md and notes, up to 40 KB, wrapped as data
recall  desde:"principal"  archivos:["x.md"]   → only those notes
```

- **Read-only.** It never writes to any account. The `recall` skill tells the agent how to keep what is useful: compare with its own memory, verify against the code, save adapted notes with their origin, never copy in bulk.
- **Explicit source.** `principal` is the default Claude Code folder; other accounts come from `motores.cuentas`. Nothing is read unless you name it.
- **Data, not instructions.** Each note comes wrapped as `<nota archivo="…" modificada="…">` (`modificada` is the file's last write, UTC), and the output says it comes from another account.
- **Confined.** Only regular `.md` files inside that `memory/` folder are read: symlinks and junctions are skipped.
- **Same machine only.** A git worktree has its own memory; pass the main clone as `cwd`.
- **Setting up the second account** (the folder, the `claude-work` command, registering it in `motores.cuentas`) is Track F of `/lagrange:setup cuenta`: links for `agents/`, `skills/` and `commands/`, `settings.json` copied without credentials, and the login left to you.

## 🧩 Claude Code mods (`hooks/mods.tsx`)

On Claude Code builds with mods, Lagrange loads one module (`hooks/hooks.json` → `"modules"`). Older builds and other hosts keep the command hooks; Codex never sees it.

- **Mailbox notice (FEAT-100).** New `mensaje` messages wake an idle session with a plugin prompt instead of a blocked Stop. Only the notice; the text still comes through the `mensaje` tool.
- **Panel (FEAT-101).** `/lagrange-panel` opens a side panel with the running fan-out, quota used and the Lagrange version in each account. While a fan-out runs, its line shows in the status line (unless your status line already runs `fanout-statusline.js`).
- **Network in the panel (FEAT-121).** A **Red** section in `/lagrange-panel`: this daemon (name, role, version), each node it knows with its connection and the Lagrange version *its daemon* reports, and what each lane is running or queueing. The data comes from the local daemon (`GET /red` on the local link, the same token as `mensaje`): names, versions and counts only, no hosts or ids. A toast also tells you, once, when a node drops, comes back, runs another Lagrange version, or when the daemon stops answering — checked 20 s after the session starts and every 5 minutes, panel open or not.
- **Background toasts (FEAT-135).** A toast when something finishes or changes while you look elsewhere: a fan-out in this repo or a confined batch (`agy_lote`, from any session) that finished, an exhausted quota window that freed up (agy groups and every Claude account, decided by the clock), this account crossing 90 % of its 5-hour window (once per window), and a new message in the band. What this session is waiting on is not announced: it arrives as the tool result. No toast on start or after a mod reload — the first look is the baseline. Batches and quota are checked every minute (panel open or not) through `panel.js avisos`, which returns ids, states and counts only. Pick the kinds with `set_config background_toasts` (`all` by default, `none`, or a list of `fanout`, `lotes`, `cuota`, `mensajes`).
- **What could run on Haiku 5.5 (FEAT-117, measurement only).** The mod classifies every model request of the session — a main-loop step that only chains read-only tools (`Read`, `Grep`, `Glob`…), any other main-loop step, or a subagent's step by type — and adds up steps, tokens, cache reads and models across sessions. `/lagrange-haiku` shows the table and the share of tokens that would be candidates; nothing is rerouted. The cache column matters: prompt caching is per model, so switching models mid-turn rereads the context uncached. The `agy` subagent itself now runs on `haiku` (it only relays to agy's tools; the reasoning is Gemini's).
- **Claude Code in the Providers view (FEAT-137).** The web console's *Proveedores* tab has a second card next to Antigravity CLI: the Claude Code version Lagrange runs, the latest release from [anthropics/claude-code](https://github.com/anthropics/claude-code) with the notes of every version in between, and `claude update` to copy. Lagrange leaves Claude Code's own updater alone (unlike agy's) and never runs the update. The card also shows the Claude Code version the confined-batch image pins (flagged when it lags behind the installed one) and whether each account's batch probes are still current.
- **Summary with full context (FEAT-103).** `/lagrange-resumen [full|decisions|changes|debugging|handoff]` first shows how much context it would reread; `/lagrange-resumen <focus> si` runs it with `$.model.fork` (the session's own model and prompt cache) and saves the document to `~/.claude/session-summaries/<date>-<id>-fork.md`. Only the path and the token cost come back to the conversation. It rereads the whole conversation, so in long sessions `agy_session_summary` is cheaper.
- **Guards (FEAT-102).** Rules in `~/.claude/antigravity.json` that stop a `Bash` or `PowerShell` command from Claude and tell the model why:

  ```json
  "guardas": [
    { "secuencia": ["git", "switch", "main"], "motivo": "the daemon runs from this checkout",
      "vence": "2026-10-09T05:37:00Z", "raiz": "C:/work/my-project" },
    { "secuencia": ["stop-process", "*", "node"], "motivo": "kills the daemon and the Lagrange MCP servers" }
  ]
  ```

  `secuencia` is 1–8 whole words that must appear together, case-insensitive, after quotes and backslashes are dropped; `*` stands for any words in between. No regular expressions. `vence` (optional) turns the rule off at that time; `raiz` (optional) limits it to one project folder. The file is reread every 10 s.

  It is a good-faith brake, not a barrier: an obfuscated command (variables, base64, a script file) can slip past. It only sees Claude's `Bash` and `PowerShell` tools, not what agy runs (SEC-020), and it adds to `permissions.deny`, which does not see inside `bash -c "…"`. The file is global, so a rule applies to every account that opens that folder. Lagrange ships no rules.

## ⚙️ Model & Reasoning Effort Configuration

### 1. Per Call / Prompt

Ask Claude naturally:

> *"Claude, delegale esta tarea a agy usando el modelo `gemini-3.8-flash` y effort `high`"*

| Parameter | Values |
|-----------|--------|
| `model` | `"gemini-3.8-flash"` |
| `effort` | `"low"`, `"medium"`, `"high"` |

### 2. Persistent Defaults via Tool

> *"Configurá agy por defecto con modelo gemini-3.8-flash y effort high"*

### 3. Environment Variables

**Windows (PowerShell):**
```powershell
$env:AGY_MODEL = "gemini-3.8-flash"
$env:AGY_EFFORT = "high"
$env:AGY_TIMEOUT_MINUTES = "20"
```

**Linux / macOS (Bash / Zsh):**
```bash
export AGY_MODEL="gemini-3.8-flash"
export AGY_EFFORT="high"
export AGY_TIMEOUT_MINUTES="20"
```

---

## 📊 Telemetry & Usage Tracking (`/lagrange:usage`)

Antigravity automatically tracks token consumption, context caching efficiency, and context window saturation across all subagent calls.

```text
/lagrange:usage
```

To reset session counters:

```text
/lagrange:usage reset
```

### Metrics Reported

| Category | Details |
|----------|---------|
| **Model Specs** | Context window (1M for Gemini Flash), max output tokens, reasoning effort |
| **Session Totals** | Delegated calls, input/output/thinking tokens, cache reuse, total duration |
| **Last Invocation** | Tokens consumed, context saturation bar (`[████████░░░░] 62.4%`), conversation ID |
| **Quota Health** | `HEALTHY` · `RATE_LIMITED` · `QUOTA_EXCEEDED` |

---

## 📋 Session Summary & Anti-Compaction (`/lagrange:summary`)

Claude Code's automatic context compaction can be lossy — intermediate decisions, edge cases, and reasoning get dropped as sessions grow. 

Antigravity solves this by reading the raw session JSONL log from `~/.claude/projects/`, pre-processing and stripping noise in Node.js, and feeding the structured transcript to **Gemini's 1M-token context window** to generate a persistent Markdown summary with YAML frontmatter.

```text
/lagrange:summary
```

You can also target specific areas:
- `/lagrange:summary decisions` — focus on architectural rationale and choices
- `/lagrange:summary changes` — focus on modified files and code diffs
- `/lagrange:summary debugging` — focus on errors, root causes, and fixes
- `/lagrange:summary handoff` — **context transfer for a fresh session**, not documentation: it prioritizes findings that exist only in the conversation over anything recoverable from `git log`, and ends in a copy-paste prompt. Use it before compacting.

Summaries are automatically saved to `~/.claude/session-summaries/<YYYY-MM-DD>-<session-id>.md`.

### Declare what must survive

The `agy_session_summary` tool takes `key_points`: short sentences the agent running
the session knows matter and that a reader of the log cannot recover — method rules
and invariants learned the hard way, findings whose evidence is scattered, approaches
already tried and discarded.

Each one is injected as mandatory *and verified mechanically* in the result. It exists
because that class of content was lost in **6 of 6** runs, across two models, at ~100k
input tokens — not a context-length problem, just content nothing marked as important.

### Every summary is checked against the repository

A mechanical verification runs on every call and **cannot hallucinate**, because it
compares the document against facts extracted from the log and against git: commit
SHAs cited, the version the session actually ended at, file coverage, and the declared
`key_points`. Its findings come back with the summary.

`strict: true` turns a blocking finding into a failed call and adds a second
adversarial pass. That pass is **advisory and never blocks** — measured, it rejected a
correct document for "inventing" terms that appeared dozens of times in the transcript
it had been given.

### Hearing it

`narrate: true` sends a short digest through the configured voice route. The digest is written in the
same call that produces the document, by something that just read the whole session —
narrating the finished document instead reaches only its first few percent.

---

## 🎙️ Voice Checkpoint Narration (`/lagrange:narrate`)

Narrate a spoken status update after a task or checkpoint. FEAT-049 v3 treats
the words, their authoring identity, and their acoustic delivery as separate
decisions: Voicebox and OmniVoice are delivery providers, not identities.

### Zero-Claude-Token Architecture
Claude **does not** generate or summarize the text in its context window. Instead:
1. Claude simply invokes `/lagrange:narrate` (or the `narrate` tool).
2. The plugin locates Claude Code's session log (`.jsonl`), extracts the latest task checkpoint (user goal, modified files, and final test execution status).
3. The plugin invokes Gemini CLI (`agy`) with `--effort low` to draft a concise 2-3 sentence conversational spoken script in ~1-2 seconds (using Gemini quota, **0 Claude tokens**).
4. The pure resolver chooses only declared, verifiably available audio resources. The activation phase then coordinates providers and VRAM. If no route can be used, the completed script is returned as `text-only` instead of being lost.

Running `/lagrange:narrate` plays the result on your speakers. When `narrate` is called programmatically, local playback is off by default (`local_playback: false`) so background narration doesn't startle anyone — it still reaches your phone if the Telegram bridge is configured.

### Speaking a specific text (`say`)

`narrate` writes its own script and takes no text, which is exactly what you want for "tell me how it went" — and exactly what you don't want when the agent has a particular sentence to say. That is `say`:

```json
{ "text": "El deploy termino, treinta y cinco pruebas en verde." }
```

It shares the whole emission pipeline with `narrate` — same resolver,
activation, text-only fallback, local playback and Telegram delivery — and
differs only in where the words come from. Two things are worth knowing:

- **The text is sanitized locally, always.** Markdown, code blocks, file paths, URLs and emoji are stripped (none of them survive being read aloud), and anything shaped like a bot token is redacted *before* synthesis. That matters because the spoken text also becomes the Telegram caption and lands in `daemon.log`.
- **`polish: true` is opt-in, not the default.** It has Gemini rewrite the text in spoken style, which is worth a few seconds for a raw log or long output, and wasted latency for a sentence you already phrased for the ear. The polish prompt is a *rewrite* instruction, not a summarize-from-facts one: it is explicitly forbidden from adding information the message didn't contain, so a narration can never invent a status that wasn't reported.

### Usage

```text
/lagrange:narrate
```

With a fictitious explicit profile or language preference:
```text
/lagrange:narrate "Cloud Finch"  # one-shot consent for that exact acoustic profile
/lagrange:narrate en             # use the declared English route from voice_setup
/lagrange:narrate es             # use the declared Spanish route from voice_setup
```

Or ask Claude conversationally:
> *"Cuando termines, narralo con el perfil Marina Sol."*
> *"Narra el último checkpoint en inglés usando la Soul brisa."*

### Voice setup v3: identity and sound are independent

`voice_setup` is the only source of implicit voice preference. Detecting a
profile, sample, model or running server never makes it a default. A fresh
installation without a configured setup remains `unconfigured` and does not
start audio services on its own.

Each language default has two independent parts:

- `identity`: `neutral`, an explicit persistent `soul`, or the compatibility
  mode `profile`.
- `audio`: a profile plus its provider and, for Voicebox, its engine/model
  evidence. Qwen routes require an explicit `model_size`; OmniVoice routes do
  not accept `engine` or `model_size`.

The complete fictitious example in [Persistent Defaults](#persistent-defaults-claudeantigravityjson)
means: Spanish text is authored by Soul `brisa` and normally spoken with
`Marina Sol` through OmniVoice; English is neutral and uses `Rowan Vale`
through Voicebox. Only the listed alternatives may be tried, in order. An
acoustic fallback never changes the authoring Soul.

Per-call selection remains ergonomic and does not require setup:

```json
{
  "text": "The migration finished successfully.",
  "voice": "Cloud Finch",
  "language": "en",
  "soul": "brisa"
}
```

Here `voice` authorizes that acoustic profile for this call only; `soul`
selects an already-existing identity independently. If `Cloud Finch` cannot be
synthesized, the resolver does not silently substitute another profile. A
contradictory language or unavailable route yields a diagnostic `text-only`
result while preserving the message. `send_telegram: false` is always honored;
when Telegram is enabled, a text-only Soul message keeps its reaction authorship.

To explicitly keep a new installation unconfigured:

```json
{
  "voice_setup": {
    "version": 3,
    "status": "unconfigured",
    "languages": []
  }
}
```

`narrate_voices` can inspect live or cached capabilities and setup roles,
but discovery never starts Voicebox/OmniVoice, loads or downloads a model,
generates audio, pins VRAM, or seeds a Soul.

### A voice per Claude account (session identity)

Each Claude account on the machine can have its own voice: the session
identity of `identidad_sesion` (the name, emblem and colour of the status line)
takes an optional `voz` block:

```json
"identidad_sesion": {
  "principal": { "nombre": "Spica", "emblema": "✦", "color": "cian",
                 "voz": { "es": "Priscilla", "en": "Emily", "idioma": "es" } }
}
```

When `say`, `narrate` or `agy_session_summary` (with `narrate: true`) get no
`voice` and no `soul`, **in a Claude Code session**, they speak with the voice
of that session's account, exactly as if that voice had been asked for: Voicebox
starts headless if needed, and a profile that cannot be synthesized is never
replaced by another one. The spinner and the Telegram caption show the identity
name (`Spica`), not the profile. The persona stays off unless `personality: true`
is passed. The precedence is: the requested voice or Soul, then the session
identity, then `voice_setup`, then text without audio.

The client is recognised by the `clientInfo.name` of the MCP handshake
(`claude-code`), not by environment variables: Codex and opencode do not get an
identity, even when they inherit `CLAUDE_CONFIG_DIR` from a Claude session. The
account comes from `CLAUDE_CONFIG_DIR` (none means `principal`; the others are
matched against `motores.cuentas`). `identidad_sesion` is read from the global
configuration only, and the voice is set with `set_config identidad_voz:
{ cuenta, es, en, idioma }`, which writes only the `voz` block. The account
must already have a `nombre`: the identity itself (`nombre`, `emblema`,
`color`) is edited by hand in `~/.claude/antigravity.json`.

### Voicebox without the desktop app

The desktop app does not need to be open. On Windows, once an explicit request
or configured route has authorized Voicebox, the plugin can start its server
headless — the CUDA backend under
`%APPDATA%\sh.voicebox.app\backends\cuda\` (downloaded the first time you open
the app), falling back to the CPU one in Program Files — with the app's own data
directory, so the same voices are there. If the app *is* open, nothing is started.

GPU memory is managed for you:

- **One TTS model at a time.** Switching to a voice that uses another model frees
  the previous one first, unless it was used in the last 30 s by another session.
- **Pin a model** with `keep_model: true` on `say`/`narrate`, or
  `voice_model` action `pin`: it stays loaded until `release` or `unload`.
  Asking for a voice on a different model while one is pinned is refused with a
  clear message rather than silently evicting it.
- **Idle release.** A small keeper process frees unpinned models after
  `voicebox_idle_unload_minutes` (10) and shuts the headless server down after
  `voicebox_idle_shutdown_minutes` (30). It never unloads or stops a Voicebox the
  desktop app started.
- **VRAM guard.** A model is not loaded when `nvidia-smi` says it would not fit.

While a voice server runs, the statusline shows a line such as
`🎙️ voicebox cuda · qwen-tts-1.7B 📌 · VRAM 5.4/24.0 GB` — VRAM **in use** over
total, measured live (`nvidia-smi`, cached 3 s), with a `⚠` above 85 %
(disable it with `statusline_voicebox: false`). State and logs live in
`~/.claude/lagrange-voicebox/`.

### OmniVoice (optional second voice engine)

[OmniVoice](https://github.com/k2-fsa/OmniVoice) clones the same Voicebox
voices from their samples, about ten times faster than Qwen 1.7B (≈6 s for 36 s
of audio) and in ~2 GB of VRAM, with somewhat flatter prosody. Once installed:

- New v3 setups declare the provider per route. `modo` only orders compatible
  providers when a one-shot voice request leaves the provider unspecified.
- `provider` is the advanced per-call override; `motor` remains its legacy
  alias. Contradictory aliases fail visibly instead of choosing one.
- `voz_por_perfil` (e.g. `{"Nyotengu": "voicebox"}`) is a provider preference for
  an **explicit** voice (asked for, or the session identity voice), with or
  without `voice_setup` (BE-114): that engine is tried first and the other one is
  the fallback, always with the same profile, and the output says when the
  preference could not be honored. It never changes the routes declared in
  `voice_setup`, and an explicit `provider`/`motor`/`engine` in the call wins.
- Voicebox stays the source of truth for voices and samples; a small cache lets
  OmniVoice keep narrating if Voicebox is down.
- Its own server (port 17494) frees its model and shuts down when idle, like
  the Voicebox keeper; one TTS model stays resident across both engines.

Install (Windows + NVIDIA, ~8 GB into `%LOCALAPPDATA%\lagrange-omnivoice`):
`npm run omnivoice:install`. The OmniVoice weights are **CC-BY-NC** (non-commercial).

If no declared provider can be reached or started, the plugin preserves the
content as text and returns stable reason codes such as `sample_missing`,
`model_not_downloaded`, `provider_unavailable`, or `setup_required`.

### 🎭 Personality from the Voicebox profile (no code changes)

The `profile` identity mode can adapt naturalness and style to the profile card in Voicebox. It is an ephemeral
compatibility mode: it creates no Soul and no persistent memory.

- **`description`**: the identity, accent or tone (e.g. *"Uruguayan internet comedian with a raspy voice"* or *"Professional Spanish radio host"*).
- **`personality`**: idioms, attitude and verbal tics (e.g. *"Bizarre, irreverent humor; celebrates euphorically when the tests pass"*).

Gemini (`agy`) can read those fields to rewrite the script without changing its facts. For a persistent identity use
`identity: { "mode": "soul", "soul": "<key>" }` or the one-off `soul` argument; the Soul must already exist.

---

## 🗣️ Real-Time Voice Mode (`voice-chat/`)

Full-duplex spoken conversation with Antigravity — not a Claude Code slash command, since a persistent audio loop with real-time barge-in doesn't fit Claude Code's request/response tool-call model. Instead, `voice-chat/*.py` are standalone companion scripts that talk to the same MCP server (`agy_voice_stream` — see MCP Tools Reference above) as a client over the same stdio JSON-RPC protocol Claude Code itself uses, keeping one long-lived `agy.exe` process alive across turns instead of paying a cold start per message.

- `voice-chat/text_loop.py` — console input, zero pip dependencies (stdlib only).
- `voice-chat/voice_loop.py` — real microphone input via Silero VAD, with real barge-in: the instant it detects you starting to speak, it cuts playback and cancels any in-flight Voicebox synthesis.

Both use the same global-plus-project `voice_setup` resolution as Node. They
exit with `setup_required` before starting a provider or opening the microphone
unless a persisted setup or explicit `--voice` authorizes the route. `--soul`
selects identity independently. The microphone loop also verifies its STT model
before opening the device and refuses conflicting VRAM pins (`--soltar-pin`
releases one); it needs `pip install -r voice-chat/requirements.txt`
(`sounddevice`, `silero-vad`, `numpy`).

**Progress signals.** While agy works, the chat plays short pre-recorded cues in the chat voice (OmniVoice only, cached between sessions): "Pensando", "Buscando en la web", "Leyendo la página", "Revisando archivos", and, named after the MCP server agy is calling, "Usando el navegador" (playwright, puppeteer, chrome), "Consultando la memoria" and "Revisando la agenda" (calendar servers). Any other tool is "Usando una herramienta"; during a turn you authorized, "Ejecutando un comando" and "Escribiendo el archivo" as well. At most three per turn and never the same one twice; `--senal-ms 0` turns them off.

**Project directory.** The chat treats the directory you launch it from as the project: agy runs its commands there. Without it, agy's shell starts in its own `~/.gemini/antigravity-cli/scratch/` folder, and `git status` answers "not a git repository".

**Confirmation brake.** Both loops open the session with `confirmacion: true`. agy then runs without `--dangerously-skip-permissions`, so it denies shell commands, MCP calls (browsing included) and `read_url` on its own. When a turn ends with something denied, the chat asks out loud ("Agy quiere ejecutar el comando git status. ¿Lo hago?"). A short "sí" (four words or fewer) relaunches agy with full permissions on the same conversation for that turn only, and the chat goes back to the braked session right after; any other answer drops the question. In `voice_loop.py`, saying "pará" during that turn stops it. agy does not gate `write_to_file`, so the chat says when agy changed a file without asking. `--mode plan` is not a brake: it does not stop shell commands.

```bash
# Console-only, zero extra dependencies
python voice-chat/text_loop.py --voice "Cloud Finch" --language en --soul brisa

# Real microphone + VAD
python voice-chat/voice_loop.py --voice "Marina Sol" --language es --stt-model turbo

# Omit --voice/--language to use voice_setup.default_language and its route
python voice-chat/text_loop.py
```

Run either script with `--help` for the full flag list (TTS engine/model overrides, VAD sensitivity, input device selection, VRAM unload-on-exit).

---

## 🌐 Deep Web Research (`/lagrange:research`)

Delegate deep web research and live doc searches directly to Antigravity, which leverages Gemini's native search tools and Vertex AI:

```text
/lagrange:research "Best practices for Claude Code hooks and lifecycle events 2026"
```

Returns a structured report with an Executive Summary, Key Findings, Cited Source URLs, and direct relevance to your current project.

Backed by the `agy_research` MCP tool, which is read-only and requires the `network` capability. If `network` is denied (or absent from `allow`), the tool returns an explicit error rather than producing a report from the model's memory — a research report with citations it never actually fetched is worse than no report.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `topic` | `string` | *required* | The research topic or question |
| `project_context` | `string` | — | How this relates to your project, to focus the Relevance section |
| `recency` | `string` | — | Source recency constraint (e.g. `"past 6 months"`); older sources get flagged |
| `conversation_id` | `string` | — | Resume a research thread for follow-ups without re-running the search |
| `permissions` | `object` | — | Per-call policy override (read-only regardless) |

---

## 📦 Components

The component map is in [REFERENCE.md](REFERENCE.md#components).

---

## 🔧 Installation & Setup

### Marketplace (recommended)

Inside a Claude Code session:

```text
/plugin marketplace add KZvilla/lagrange-agent-runtime
/plugin install lagrange@kzvilla-lagrange
```

Or from a terminal:

```bash
claude plugin marketplace add KZvilla/lagrange-agent-runtime
claude plugin install lagrange@kzvilla-lagrange
```

This is the managed path: enable/disable, user vs. project scope, a visible
version, and updates through `claude plugin marketplace update` instead of a
`git reset --hard` over your working copy.

### Migrating from a script install

`install.ps1` and `install.sh` were removed in 0.6.0. They cloned into
`~/.claude/skills/antigravity` and updated with `git reset --hard`, which
overwrote local changes and gave no version to point at. The marketplace does
the same job with a pinned `sha`, real versions and a managed lifecycle.

If you installed with them, remove the old clone: the two channels install to
different places, so keeping both means Claude Code loads the plugin **twice**
- duplicate commands, duplicate MCP tools.

The scripts only ever cloned into `~/.claude/skills/antigravity`; they wrote
nothing to `settings.json` and registered no MCP server, so removing that
directory is the whole uninstall. Two things deserve care, and both snippets
below handle them: the `.env` inside it is git-ignored and exists nowhere else,
and on Windows the bridge daemon may be a scheduled task pointing into the
directory you are about to delete.

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
    # Only unregister the bridge daemon if it was installed FROM this copy.
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

Then **restart Claude Code** - `/reload-plugins` drops commands, agents and
skills, but MCP tool schemas registered at session start stay until a restart.

A leftover `pluginUsage` entry in `~/.claude.json` is harmless telemetry; there
is nothing else to clean up.

### Post-Install

Restart Claude Code, then verify from a terminal:

```bash
claude plugin list
claude plugin details lagrange@kzvilla-lagrange
```

### Codex and Other MCP Clients

The MCP server is plain JSON-RPC over stdio: it does not depend on Claude Code
and reads no `CLAUDE_*` variable. Claude registers it through `.mcp.json` and
`${CLAUDE_PLUGIN_ROOT}`; Codex uses `.codex-plugin/plugin.json` and
a relative working directory that its plugin loader resolves against the
installed plugin root. Both launch the same `mcp-server/index.js`.

#### Native Codex plugin

This repository includes a native Codex manifest, the six shared skills and a
repo-local marketplace. The local installation flow, verified with Codex CLI
0.154.0, is:

```bash
git clone https://github.com/KZvilla/lagrange-agent-runtime.git
codex plugin marketplace add /absolute/path/to/lagrange-agent-runtime
codex plugin add lagrange@kzvilla-lagrange-codex
```

For a tagged release, Codex also accepts a Git marketplace source:

```bash
codex plugin marketplace add KZvilla/lagrange-agent-runtime --ref <release-tag>
codex plugin add lagrange@kzvilla-lagrange-codex
```

Use a new thread after installation. Skills refer to semantic tool names such as
`agy_plan` and `agy_run`; Codex resolves the host-specific MCP namespace.

The full matrix is in [REFERENCE.md](REFERENCE.md#host-capability-matrix).

#### Generic MCP clients

Any other MCP client can run the server with `node` and the **absolute path**
to `mcp-server/index.js` in a clone. The server has **no npm dependencies**, so
no `npm install` is needed for it. The Telegram bridge does need one
(`npm install --prefix telegram-bridge`).

**opencode** (`opencode.json`):

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

`LAGRANGE_HOST=opencode` is a **host marker** used only by the opencode config:
it makes the server fail closed instead of falling back to a Claude session. Do
not add it to a shared MCP config that Claude Code also uses. The execution
timeout is 30 minutes because summaries and audits can outlive the default.

#### Repo-local opencode integration

This repository ships an `.opencode/` directory plus a committed `opencode.json`,
so running `opencode` **inside a clone** gives you close to the Claude Code
experience, not just the raw tools:

| Claude Code | opencode in this repo |
|---|---|
| `/lagrange:run`, `/lagrange:plan`, … | `/lagrange/run`, `/lagrange/plan`, … (13 commands in `.opencode/commands/lagrange/`) |
| `agents/agy.md` subagent | `@lagrange` (`.opencode/agents/lagrange.md`) |
| `skills/*/SKILL.md` | `.opencode/skills/*/SKILL.md` |
| `mcp__plugin_lagrange_lagrange__agy_run` | `lagrange_agy_run` (server name is prefixed) |
| `agy_session_summary` / `narrate` on the current session | same tools, reading the opencode session with `opencode session export` |

The committed `opencode.json` registers the MCP server with a **relative** path,
so no absolute path is needed when the opencode workspace is the clone. Outside
the clone, register the server with the absolute-path config shown above.

The repo-local plugin (`.opencode/plugins/lagrange.js`) injects the current
`ses_...` into `agy_session_summary` and `narrate`, so both read the opencode
session without the model passing an id. It also neutralizes the Claude
Code/Codex wording in the tool descriptions. Without the plugin, pass
`session_id: "ses_..."` manually; without either, the session tools fail closed
instead of reading a Claude session.

Because opencode namespaces MCP tools by server name, the ported commands,
subagent and skills use `lagrange_<tool>` names (e.g. `lagrange_agy_run`) instead
of Claude Code's `mcp__plugin_lagrange_lagrange__agy_run`.

**Clients with an `mcpServers` block:**

```json
{ "mcpServers": { "lagrange": { "command": "node", "args": ["/abs/path/lagrange-agent-runtime/mcp-server/index.js"] } } }
```

These formats belong to each client and change more often than this README:
check them against your client's docs.

**What works in generic clients:** every MCP tool (`agy_*`, `cast_agent`,
`telegram_*`). `agy` has to be installed either way.

**What does not carry over:**

- **Slash commands** (`/lagrange:*`) remain Claude Code-specific. Codex loads
  the shared `skills/**` directly; opencode is covered by its `.opencode/`
  integration; generic clients call the tools directly.
- **Config and state stay in `~/.claude/`** (`antigravity.json`, usage, the agent
  registry), even if you never use Claude Code. This is deliberate: one
  directory per client would split the persistent agents' memory.
- **`agy_session_summary` and `narrate` need a host session source.** Claude
  Code uses its project logs; Codex uses the packaged, trusted session hook and
  fails closed on missing or ambiguous pointers; opencode (>= 2) uses
  `opencode session export` inside a clone, with the repo-local plugin or an
  explicit `session_id`. Generic MCP clients have no adapter, so use their
  native handoff and `say` there.

  The plugin is repo-local: it loads only when opencode runs inside the clone.
  Outside the clone, copy `.opencode/plugins/lagrange.js` to
  `~/.config/opencode/plugins/` and keep `LAGRANGE_HOST=opencode` in that
  opencode config. The manual copy is not covered by the release ritual.
- **The fan-out statusline** relies on Claude Code's `statusLine` contract.
- **Telegram:** the outbound tools (`telegram_notify`, `telegram_ask`,
  `telegram_send_voice`) work from any client. The bot's `/claude` command
  (Remote Control) launches Claude Code only.
- **`agy_fanout` creates `.claude/worktrees/` in your repo.** Add `.claude/` to
  your `.gitignore`.
- **Host-specific names remain only where they are real contracts**, notably
  the temporary `~/.claude/` state namespace and Claude session/statusline
  integrations.

### 🔐 Telegram Bridge Setup (Manual — Never Automated)

The Telegram tools (`telegram_notify`, `telegram_ask`, `telegram_send_voice`, and `narrate`'s `send_telegram` option) need your own bot token and chat ID in a `.env` file. **No install channel ever creates or copies them for you** — an installer that silently provisioned credentials would be a much worse security default than asking you to do it once, yourself.

`/lagrange:setup telegram` walks you through the steps below and verifies the result by sending a test notification. It deliberately never asks for the token in the chat and never writes the file for you: anything typed into a Claude Code conversation is stored in the session JSONL, and `agy_session_summary` embeds that raw log into a prompt sent to Gemini — so a token pasted in chat can reach a third-party model through this plugin's own tooling. It tells you which file to create; you fill it in.

1. Get a bot token from [@BotFather](https://t.me/BotFather) on Telegram.
2. Get your numeric user ID from [@userinfobot](https://t.me/userinfobot).
3. Copy the example file and fill in both values:
   ```bash
   cp telegram-bridge/.env.example .env
   ```
   (edit `TELEGRAM_BOT_TOKEN` and `ALLOWED_USER_IDS` in the new `.env`)

#### Where the `.env` has to live

`.env` is git-ignored on purpose, so no install channel ever brings it along — only tracked files are fetched. It is searched for in this order, and the first one that exists wins:

| # | Location | Survives `claude plugin update`? |
|---|---|---|
| 1 | `$TELEGRAM_BRIDGE_ENV_FILE` (an exact path, if you set it) | Yes |
| 2 | `<plugin>/telegram-bridge/.env` | **No** — inside the versioned install directory |
| 3 | `<plugin>/.env` | **No** — same reason |
| 4 | `%LOCALAPPDATA%\antigravity-telegram-bridge\.env`<br>(`$XDG_STATE_HOME/antigravity-telegram-bridge/.env` elsewhere) | **Yes** |

**If you installed from the marketplace, use row 4.** Each version is installed into its own directory (`.../lagrange/<version>/`), and an update creates a new, empty one — a `.env` in rows 2 or 3 is left behind in the previous version. The failure is quiet: nothing breaks at startup, and the next Telegram tool call simply reports `No hay usuarios configurados`. That message now lists every path it searched, so you can see which one it expected.

Rows 2 and 3 stay first in the order so that existing installs and dev checkouts keep using exactly the file they already use.

```bash
# Marketplace install — durable location (Windows)
mkdir -p "$LOCALAPPDATA/antigravity-telegram-bridge"
cp telegram-bridge/.env.example "$LOCALAPPDATA/antigravity-telegram-bridge/.env"
```

A dev checkout keeps its own `.env` next to the code:

```bash
git clone https://github.com/KZvilla/lagrange-agent-runtime.git
cd lagrange-agent-runtime
cp telegram-bridge/.env.example .env    # then fill in the two values
npm run bridge
```

Note that the two copies share their **runtime state** regardless (`state.json` and `bridge.lock` live in the same durable directory), which is what lets an installed `telegram_ask` be answered by a daemon running from a clone.

The bidirectional bot (`telegram-bridge/bot.js`, started with `npm run bridge` from the repo root) is only needed if you want to message the bot *from* your phone to kick off `agy` tasks or answer `telegram_ask` prompts — outbound notifications and voice notes work without it.

To keep it running across logins, `npm run bridge:daemon:install` — the same command everywhere; a dispatcher picks the service manager:

| Platform | Service manager | Logs | Notes |
|---|---|---|---|
| Windows | Task Scheduler, at logon | `telegram-bridge/daemon.log` | — |
| Linux | `systemd --user` | `journalctl --user -u lagrange-telegram-bridge` | Run `sudo loginctl enable-linger $USER` or it stops at logout and never starts at boot |
| macOS | **not supported** | — | `npm run bridge` in a terminal, or write your own launchd unit pointing at `bot.js` |

macOS ships no launchd unit on purpose: an untested service manager fails at system boot, when nobody is watching, while the user believes they have a daemon. The limit is declared rather than half-met.

**On Linux, linger is the step people miss.** A `systemd --user` service is tied to the user's login session: without linger it looks healthy right after installing and is silently gone after the next reboot. The installer detects it and prints the fix; `npm run bridge:daemon` reports it too.

#### A bot per Soul (optional)

`TELEGRAM_BOT_TOKEN` is the general bot. You can add more bots to the same `.env`, each one tied to a Soul:

```dotenv
TELEGRAM_BOTS=alya
TELEGRAM_BOT_ALYA_TOKEN=333:CCC
TELEGRAM_BOT_ALYA_VINCULO=alma:alya
TELEGRAM_BOT_ALYA_USUARIOS=123456789   # optional; defaults to ALLOWED_USER_IDS, must be a subset
```

The same daemon runs all of them. A Soul's bot *is* that Soul: free text talks to it (no 30-minute window), and it only accepts `/charla`, `/alma`, `/cancel` and `/help`; anything else, attachments included, points you to the general bot. Whatever that Soul says on its own (`say` and `narrate` with a Soul, and console schedules with *notify Telegram*) goes out through its bot, and a schedule created with `/cron` answers through the bot it was created in. A misconfigured bot is left out with the reason in the banner, the log and `telegram_bridge_status`; the general bot and the rest keep working. A bot can also be tied to a node (`TELEGRAM_BOT_WSL_VINCULO=nodo:casa-wsl`, on the server): the server keeps the token and forwards that bot's updates to the node, which answers with its own bridge (`/status`, `/run`, plans and their buttons run there), through a narrow API: its own bot or the general one, only to that bot's users, only editing its own messages, with its buttons prefixed so they always come back to it. It needs `BRIDGE_NODO_PERMITE=ejecutar` on the node. In the general bot, `/nodo` picks which node answers that chat (`/nodo servidor` goes back).

#### Several machines: server and nodes (optional)

Windows and WSL on the same PC (with `networkingMode=mirrored`) can stop being islands. One install is the **server** (`BRIDGE_ROL=servidor`, needs `BRIDGE_WEB=1`): it keeps the Telegram bot and the web console. The other is a **node** (`BRIDGE_ROL=nodo`): no token and no console of its own.

```bash
# on the server
npm run bridge:nodo -- invitar
# on the node (then restart its daemon)
npm run bridge:nodo -- unirse http://127.0.0.1:4518 ABCD-EFGH-JKLM
```

The pairing code is single-use, expires in 10 minutes and dies after 5 wrong tries. After that, both sides prove who they are with Ed25519 keys on every reconnection, so no secret travels. The server console gets a node selector; what it may do there is set by the node (below). `telegram_notify`, `telegram_ask` and `say`/`narrate` from a Claude session on the node reach your phone through the server's bot, prefixed with the node name. Plain messages queue while the server is down; voice notes and questions fail right away. `npm run bridge:nodo -- listar | revocar <name> | estado | salir` manage the pairing.

**What the server may do on a node is decided by the node** (`BRIDGE_NODO_PERMITE` in its `.env`): `lectura` (default) only looks; `operar` adds board, Soul and schedule changes that launch nothing, use no GPU and delete no work; `ejecutar` also launches agents, uses the GPU, changes the model and discards batches. The server anticipates with a 403, the node enforces it, and every remote action is logged on both sides without the request text.

**Souls live on the server.** A node (protocol 2) keeps no Souls of its own: `alma`, `say`/`narrate` with a Soul, voice chat and the connector's memory all read the server's, and the Souls' views in the console never carry the node prefix. By default a node only reads them; `npm run bridge:nodo -- almas <node> escritura` (on the server) lets it write the diary, upload voice-chat turns for consolidation, forget, seed and import. If the server is down, narration goes out without a Soul and pending consolidations wait on the node. Souls, Soul cards and Soul schedules a node already had move with `npm run bridge:nodo -- migrar-almas [--simular]` (on the node): memories are merged without duplicates, a different identity is kept aside as `alma.md.nodo-<name>`, and nothing is deleted locally until the server confirms. The server keeps a read-only replica of each node's board, so a Soul sees and annotates cards on every node, and the console's **Todos** option shows the board and schedules of the whole network, with disconnected nodes at their last known state.

**Another machine:** set `BRIDGE_NODOS_ESCUCHAR=<tailscale-ip>:<port>` on the server. It opens a second listener that only serves `/nodo/*` (the console stays on loopback), and only on the Tailscale interface or the WireGuard one you name in `BRIDGE_NODOS_INTERFAZ_CIFRADA`. A `100.x` address on your internet interface (ISP CGNAT) is refused. The node joins with `unirse http://<name>.ts.net:<port> <code>`, or `--interfaz-cifrada <iface>` for another private address, and every connection re-checks where the name resolves. Unauthenticated requests are rate-limited per IP. The firewall rule is yours to add (`invitar` prints it).

#### The daemon must be installed from a clone, not from the plugin copy

The installer **refuses to run** from a managed plugin directory (`.claude/plugins/cache/…` or `…/marketplaces/…`) — on both Windows and Linux — and the reason is worth stating because the failure it prevents is invisible.

The scheduled task and the systemd unit each store an **absolute path**. Each plugin version installs into its own directory, and updating does not delete the old ones — so a daemon registered from `…/lagrange/0.9.1/` stays pinned to 0.9.1 forever. After the next update, the bot runs the old code while the MCP tools run the new one, and *nothing fails*: no error, no warning, just two halves of the same bridge on different code. If old versions were deleted the daemon would crash at startup and you would know; that they survive is exactly what makes this silent.

Run `/lagrange:bridge` at any time to see which copy each half is running, along with daemon state, the effective `.env`, and the shared state paths. (`-Force` bypasses the check if you have a case we did not anticipate.)

### 📱 Telegram Bot Commands & Claude Remote Control

When running the bidirectional daemon (`bot.js`), your private Telegram chat becomes an autonomous mobile command center for both Antigravity and Claude Code:

| Command | Action |
|---------|--------|
| `/claude` | List authorized workspaces from the `.claude.json` of every Claude account (plus `sesiones_claude`, below) and launch a detached `claude --remote-control` session with interactive inline buttons. With sessions running, it lists them first |
| `/claude <project> [account]` | Launch in that project, with that account (`principal` or one of `motores.cuentas`). Without an account: the one fixed for the folder, else `cuenta_por_defecto` when the project trusts it, else buttons to pick one |
| `/claude status` | List the running Claude Code remote sessions (project, account, PID, mode), with a stop button for each |
| `/claude stop [all\|project\|account]` | Terminate a session's process tree cleanly (`taskkill /T` on Windows / SIGTERM). With several running and no argument, it asks which |
| `/claude clean [id]` | Interactive worktree cleanup to safely prune completed task worktrees |
| `/plan <task>` | Generate an Antigravity plan with an inline `[✅ Ejecutar cambios]` button to approve execution. Plain text messages go here too. The plan runs as the `lagrange-plan` agent (read tools only: files and web) without `--dangerously-skip-permissions`, so it cannot write files or run commands, and your MCP tools are denied; `--mode plan` alone does not stop either. The button opens a **new** session that gets the plan text, because agy fixes an agent's tools when its thread starts. If agy cannot resolve `lagrange-plan`, the plan is refused rather than run with the default agent. Replying to a plan adjusts it in the same read-only thread; a plan never resumes a `/run` session |
| `/run <task>` | Start a new Antigravity subagent session with direct edit permissions |
| `/resume <task>` | Continue the current active conversation thread (`conversation_id`). When that thread is a plan, it opens a new session with your instruction and the plan, like the button |
| `/status` | Report active `agy` binary, version, current model/effort, and permission policies |
| `/diff [file]` | Uncommitted changes in the workspace (untracked files included); with a file, its patch. Answers instantly, never queued. Paths are confined to the workspace, git runs with `--literal-pathspecs`, and files matching `deny_paths` are never shown — the rest of the content does reach Telegram |
| `/logs [N]` | Last N lines (default 30, max 100) of the daemon log: `daemon.log` on Windows, the journal on Linux. For finding out why something failed — if the bot is down, this cannot answer either |
| `/queue` / `/cancel` | Inspect or abort queued tasks |
| `/reset` | Clear the current conversation context and start fresh |
| `/web` | Link to the web console (below), when it is enabled; with Tailscale set up, a single-use link to open it from your phone |

#### 🌐 Local web console (`BRIDGE_WEB=1`)

The same daemon can also serve a browser console on `http://127.0.0.1:4518` (`4519` when the daemon runs inside WSL), for use from a browser on the daemon's machine. Nothing in it uses the main model: Soul chat and casts run through `agy`, *listen* uses the local voice servers, and the rest reads local files (and writes a Soul's memory only when you add or forget an entry). It runs inside the bot process, so a cast started in the browser also appears in Telegram's `/queue`, and the reverse.

The console has three columns:

- **Left:** your Souls and read-only agents, each with its live state (thinking, queued, or last activity).
- **Center:** the conversation with the selected Soul or agent. The history covers turns from both the browser and Telegram. Each one is marked with where it came from.
- **Right:** the Soul's memory, with a two-step *forget* and *+ Add memory*, or the agent's context (last project, casts, thread and memory). A memory you add goes through the same checks as the ones a Soul saves (no URLs, no instructions, no duplicates, size cap). One added under "what they know about you" is shared by every Soul.
  - **Saved criterio (FEAT-079):** an agent's side panel has a *Criterio guardado* section with what it has accumulated in `mcp-memory` (its decisions and your corrections, newest first, how often each was used to rehydrate a cast). Read-only; it is queried only while the section is open, and secrets are redacted as in the rules viewer.
- **Project rules (FEAT-076/077):** for an agent, the *Project* block lists the rules files of its current thread's project (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.agents/AGENTS.md`, `.github/copilot-instructions.md` and the root `.md` files they link to) and opens them in a read-only viewer. Measured on Claude Code 2.1.281 and agy 1.2.9, **no engine loads these files by itself in a cast**: `--safe-mode` and `--restricted`, which keep a Claude cast isolated, each turn `CLAUDE.md` off, and `agy -p` loads none of them. So every cast, from the bridge or from `cast_agent`, gets a short `<reglas-del-proyecto>` block with the file *names* (canonical first, never their contents) and is told to read them with its read-only tools when the request touches the project.

Around them:

- **Top bar:** daemon, model, lanes, and a two-step cancel menu for the Soul and cast lanes.
- **Theme:** follows the system, or pick light or dark.
- **Focus mode:** `F` folds both side columns, `Esc` brings them back.
- **Addresses:** every view has its own (`/alma/<key>`, `/agente/<name>`, `/tablero`, `/sesiones`, `/logs`), so a reload keeps your place.
- **Live activity:** while a cast or a `/run` is working, the console shows which tool it just opened (read a file, searched, ran a command). In focus mode you see the whole timeline; outside it, the latest step. Casts from the bot run with `--output-format stream-json` for this. The `cast_agent` MCP tool keeps using JSON.
- **Live reply:** a Soul or a cast shows its answer while it writes it, as plain text, and the formatted answer replaces it when it finishes. The memory block the agent appends is hidden from its first character, even when it arrives split across chunks. Partial text is never saved and is not replayed to a tab that reconnects. Soul chats from the bot also run with `stream-json`; `alma` and the voice chat keep using JSON.
- **Listen:** every finished Soul or cast answer has a *listen* button. The daemon speaks it with the same voice resolution as `say`: the Soul's own voice, OmniVoice first, and the same VRAM care. The text is cleaned the same way (no code, links or paths) and capped at about 1200 characters. One clip at a time; the first one after the voice server was idle can take up to a minute while the model loads. If no voice is set up, the button says why.
- **Prepare voice and auto-read:** the conversation header has a *Prepare voice* button that loads that Soul's voice ahead of time (starting OmniVoice and loading its weights, or preloading Qwen), so the first clip doesn't wait. It doesn't pin the model and nothing in the console unloads it: the idle timers still free it. Next to it, *Auto-read* reads aloud, in order, the answers in the open conversation that finish after you tick it; older answers keep their *listen* button. It starts unticked on every page load, and unticking it, switching conversations or pressing *listen* stops what is playing. Browsers hold back audio in a hidden tab, so answers that finish while the tab is hidden play when you come back. Voice operations from the browser run one at a time; two voice clients in different processes (for example `say` from another session) can still race for VRAM, as before.
- **Settings (`/ajustes`, FEAT-134):** edits this machine's global `~/.claude/antigravity.json` without touching JSON: the **identities** of each Claude account (name, emblem, status-line colour, voice per language and default language; an account without one can get it), the **voice** (`voice_setup`: default voice per language, its engine and model, up to 3 fallbacks; and `voz_por_perfil`, the preferred engine per voice), the **Voicebox profiles** (read-only: language, type, engine, whether they have a character, who uses them, and warnings such as a sample too long for OmniVoice), the **engines** (the role table, the Claude accounts read-only, and `fallback_agy`), and **General** (FEAT-159): agy's default `model`, `effort` and `timeout_minutes` (1–120), where `agy_plan`/`agy_review`/`agy_audit` run (`readonly_isolation`), which background toasts the mod shows (`background_toasts`), and each engine's 5-hour quota brake (`motores.claude`/`motores.antigravity.freno_cuota_5h`). It warns when a project `antigravity.json` or an environment variable (`LAGRANGE_SOLO_LECTURA`, `AGY_*`) changes what applies; `set_config` validates `model`, `effort` and `timeout_minutes` with the same rules. *Test* plays a fixed sentence in the browser with the voice and engine on screen, without saving. *Save* sends everything in one request, all or nothing, under the same lock as `set_config`: each section carries the version it was read with, and if another tab, a `set_config` or the other account changed that section meanwhile, nothing is overwritten and the console shows it. Keys it does not know are kept, an unreadable file is never touched, and the previous file is kept as `antigravity.json.bak-ajustes`. Changes apply on the next call, with no restart. Settings always edits **this** machine: it is never forwarded to a node, and a node never runs it by RPC.
- **Board (`/tablero`):** every task in five columns: *To do*, queued, working, done, and failed or cancelled. It uses the full width, with a detail panel on the right.
  - **To do:** cards you plan ahead, with a title, the request, a Soul or a read-only agent, and (for an agent) a project. They don't run until you press *Launch*, or *Save and launch* when you create them. Everything is checked again at launch: the Soul must still exist, the agent must still be read-only, and the project must still resolve. A launched card goes through the same queue as a chat or a cast, and two quick clicks queue it once. To do holds up to 100 cards, and a card can be edited or deleted (in two steps) until you launch it.
  - **Detail:** click any card, including Telegram `/run` and `/plan` jobs, to see the full request, live activity, the result (with *listen*), its event history and notes. The open card goes in the address (`/tablero?t=<id>`), so a reload keeps it, and `Esc` closes it. *Open chat* takes you to the conversation.
  - **Notes:** add notes to any card, in any state (up to 30 per card, 1000 characters each). They are for you only: no Soul or agent reads them yet.
- **The clock (`FEAT-060`): things can now happen without you.** `/cron nueva cada 2h | alya | anything odd in the repo?` schedules work that runs on its own; `/cron` alone lists what is scheduled, and `/cron pausar <id>`, `/cron seguir <id>` and `/cron borrar <id>` manage it. Schedules are `cada 2h`, `en 30m` or a five-field cron — natural language is deliberately not accepted, because a scheduler that needs a model to know *when* to run fails exactly where nobody is watching.
  - **A schedule can only do what a card can do:** a chat with a Soul or a cast to a read-only agent. The `/run` lane is not schedulable, just as it is not launchable from the web, and there are no script jobs. The worst a runaway schedule can do is spend quota and fill the board.
  - **The model is frozen when you create it** and passed explicitly on every run. This is spend control, not convenience: agy's `/model` is global, so a 3 a.m. job could otherwise wake up using an expensive model someone picked for something else.
  - **Its own lane.** Scheduled work runs in a `programado` lane so a job from the small hours is not holding the Soul lane when you sit down in the morning, and a scheduled chat with a Soul always opens a **fresh thread** — otherwise it would interleave with the conversation you are having with it.
  - **Caps and safety:** up to 48 runs a day per schedule and 200 across all of them, a schedule that fails five times in a row pauses itself and says why, and missed runs while the machine was off are **counted, not replayed** (after eight hours off, a two-hourly job runs once, not four times). Mark one silent and it only speaks when it has something to report.

- **The sweep (`FEAT-064`): what is piling up while nobody looks.** Roughly once a week the bridge takes stock of To do cards you never launched, proposals nobody accepted, Souls you have not talked to, agents you never cast and fan-out worktrees you never integrated. Ageing is plain date arithmetic — active, then stale at 14 days, then archivable at 30 — so it costs nothing, cannot hallucinate and does not need quota.
  - **It writes a report and deletes nothing.** Not a card, not a memory, not a worktree. The report lands in `barridos/` inside the bridge data directory and the sweep leaves **one** To do card linking it, never one per finding — a pile of maintenance cards would bury what a Soul actually wanted to tell you. It skips its own cards, so sweeps never end up reporting sweeps.
  - **Worktrees are listed, never cleaned.** A fan-out batch you did not integrate has unmerged commits, so it counts as dirty and `limpiarWorktrees` refuses to remove it — rightly. The sweep names them; removing them is your call.
  - It needs no scheduler: a threshold check when the daemon starts, and every six hours after that, is enough. Git commands run with a timeout so an unreachable repo cannot freeze the bot.

  - **Attachments from Telegram (`FEAT-065`):** send the bot a photo or a document and it keeps the file, then hands you **the path** — the contract the old refusal already promised (*"tell me the path of the file on your machine"*). With a caption, it also opens a To do card whose request is your caption plus `Adjunto: <path>`; without one, it just replies with the path. The file itself is **material, never an instruction**: nothing of its content is injected into any prompt, and only an agent you launch later may read it. Only images and plain text are accepted (an allowlist, so `.exe`, `.ps1`, `.bat`, archives and anything else are refused), each file up to 10 MB with 200 MB for the folder, and the stored name is rebuilt from scratch so a crafted filename cannot escape the folder. Files live in `adjuntos/` inside the bridge data directory.
  - **Search and filters:** `/` focuses the search box. It looks at titles, full requests and notes, ignoring accents and case, and runs on the daemon. You can also filter by who (Souls, agents, jobs, fan-out, or one Soul or agent), project, origin and today, and group the working column by who.
  - **Back to To do:** a failed, cancelled or interrupted chat or cast can go back as a new card with the same request, Soul or agent, and project, linked to the original. The original stays as it was.
  - **Retry and cancel:** remove or cancel a single task, or retry a failed chat or cast. A cast retry reuses the project by id and checks again that the agent is read-only. Telegram `/run` and `/plan` jobs are shown but can't be launched, cancelled or retried from the browser.
- **Split into cards:** in the detail of a *To do* card, *Split into cards…* asks a read-only agent (the orchestrator) to read the card, and the project if it needs to, and propose 2 to 6 child cards. Any read-only agent can orchestrate; `LAGRANGE_ORQUESTADOR` in the bridge `.env` only picks the one preselected.
  - The split runs as a normal cast in the cast lane, and a card can have only one split running at a time. The children arrive as proposals linked to their parent card. Each one is assigned to the orchestrator itself, another read-only agent (it inherits the parent's project unless the orchestrator names another), a Soul, or nobody. A child for a Soul goes through the full checks, instructions included: if it doesn't pass, it stays unassigned.
  - Nothing runs by itself: you accept, launch, edit or discard each child. If the parent was launched or deleted before the split finished, no children are created.
  - The parent's detail lists its children with a progress bar, and its card shows a counter. Each child links back to its parent. A failed child sent *back to To do* stays a child of the same parent.
  - A split can't be retried or sent back: split the card again.
- **Souls on the board:** in every chat turn a Soul sees a short summary of the board (up to 12 cards: its own first, then what is open, then the latest finished; no results). It can end its reply with a `<tablero>` block to propose cards or to note cards it just saw. The rule is **a Soul proposes, you launch**:
  - A proposal lands in *To do* marked with a dashed border and its author, assigned to the Soul itself, to a read-only agent (with a project matched by name), or unassigned when neither resolves. You can *Accept* it (it becomes your card), *Launch* it (which also accepts it), edit it, or *Discard* it. The *Who* filter has a *Proposals* option.
  - At most 2 proposals and 3 operations per turn, and 5 pending proposals per Soul. A proposal can't contain links, secrets or block tags. A note from a Soul goes through the same checks as a memory it saves.
  - A Soul only sees notes on its own cards (the last 3). Your notes reach it as they are, with the block tags neutralized.
  - The reply footer has a 📋 line with what it did (cards proposed, cards noted, anything rejected), in the browser and in Telegram, and every proposal, note, rejection and discard is written to the Soul's journal. Reactions and the voice chat don't see the board.
  - The summary adds tokens to every turn: set `LAGRANGE_ALMAS_TABLERO=0` in the bridge `.env` to turn it off.
- **Fan-out:** each `agy_fanout` batch from your known projects, active or updated in the last 24 hours, is one card with a progress bar and a chip per subtask. In its detail, a running subtask has *Stop*, which leaves the same stop request the orchestrator already reads, and the subtask stops at its next check. The daemon first checks that the batch and the subtask exist and are running, and never returns paths. Subtask errors are not shown. The board refreshes fan-out every 10 seconds while visible, and a project whose disk does not answer within 500 ms is skipped and named.
- **Confined batches:** from an eligible parent card, *Prepare batch…* launches its accepted child cards through the same isolated Docker pipeline as `agy_lote`. Build the images and sign in with `agy` first. The form shows the effective model, effort, concurrency, time limits and quota health; every worker requires an explicit, disjoint file scope and may have an argv-style test. Progress, tests, audits and bounded diffs remain available after closing the tab. This review surface never integrates commits: you must explicitly integrate them in a later workflow, or discard the batch with the two-step control.
- **Command palette (`Ctrl+K`):** talk to a Soul, cast an agent, jump to a view, toggle focus or theme, or cancel a lane. Cancelling a lane asks for a second Enter.

The history comes from a task log, `tareas.json` next to `state.json`, written only by the daemon:
- **What it keeps:** the last 200 finished chats, casts and jobs, plus everything still open or in To do, with texts capped at 16 KB. Each task also keeps its notes and its last 30 events. For `/run` and `/plan` jobs it keeps only status, timing and tool activity, not their output. Activity is kept in memory while a task runs and saved to the file when the task closes.
- **After a restart:** anything the previous run left open is marked as interrupted. To do cards are kept as they are.
- **Format:** older files are completed field by field when read, without overwriting anything already there, so going back to an older daemon keeps notes and history (though its 200-task cap counts To do cards too). A file written by a newer version is read but never written.
- **Sensitivity:** only Telegram tokens are redacted, so treat the file like the conversations `agy` already stores.

1. Add `BRIDGE_WEB=1` to the bridge `.env` (optionally `BRIDGE_WEB_PORT`) and restart the daemon (`npm run bridge:daemon:stop` then `npm run bridge:daemon:start`).
   Without `BRIDGE_WEB_PORT` the console listens on `4518`, or `4519` inside WSL, so a Windows daemon and a WSL daemon on the same PC (mirrored networking shares loopback) each keep their own port. If that port is taken it tries the next 9 and logs which one it got; with `BRIDGE_WEB_PORT` set it uses that port or none. If it could not listen, `/web` says why instead of "off".
2. Get the access link with `npm run bridge:web` (`npm run bridge:web -- --open` opens the browser) or with `/web` in Telegram. The link carries a random token that changes on every daemon start. Opening it sets an `HttpOnly`, `SameSite=Strict` cookie named after the port (`lg_web_4518`), so two consoles on the same machine do not log each other out, and redirects to the clean URL.
3. **From your phone (optional, over Tailscale).** Set `BRIDGE_WEB_TAILSCALE` to this PC's tailnet name (`my-pc.tail1234.ts.net`) and `BRIDGE_WEB_TAILSCALE_USUARIO` to your Tailscale login, restart the daemon, and run once on this PC (with HTTPS enabled for the tailnet): `tailscale serve --bg --https=443 http://127.0.0.1:4528` (`npm run bridge:web` prints the exact command). The daemon opens a second port on loopback (the console's + 10, or `BRIDGE_WEB_TAILSCALE_PORT`) that only Tailscale Serve reaches and that only answers requests carrying your Tailscale user. Then `/web` in Telegram sends `https://my-pc.tail1234.ts.net/login?c=…`, a link valid for 10 minutes and a single use, and the daemon sends you one on every start (`BRIDGE_WEB_TAILSCALE_AVISO=0` turns that off). The phone gets its own session, separate from this PC's token, which never leaves the machine; after a daemon restart, ask `/web` again. From the phone the console can do everything it does here. Never use `tailscale funnel` for that port.

What it will not do:

- **Listen off loopback.** `BRIDGE_WEB_HOST` accepts only `127.0.0.1`, `localhost` or `::1`. The phone console is also on loopback, behind Tailscale Serve; Lagrange never runs `tailscale` itself.
- **Run the main lane.** `/run`, `/plan`, `/resume` and `/claude` stay Telegram-only, and the console cannot cancel a Telegram `/run`.
- **Answer `telegram_ask`.** Those questions still go to Telegram.
- **Take paths from the browser.** Projects are chosen by id from `~/.claude.json`, and only agents registered as read-only can be cast.

It uses the same defenses as Lagrange Watch (`SEC-011`): a loopback `Host` check against DNS rebinding (on the phone port, the tailnet name, the `Tailscale-User-Login` of your account and its own `Secure` cookie instead), `Origin`/`Sec-Fetch-Site` checks on writes, no CORS preflight, and JSON bodies capped at 64 KB. The interface is plain static files under a CSP that allows nothing inline (audio plays from a `blob:` URL), and it loads no external fonts or scripts. Model output is rebuilt with an allowlist and never injected as HTML. Local filtering software that intercepts loopback traffic (AdGuard, for example) may rewrite that CSP on the way to the browser. A busy port or a bad setting is logged, and the bot keeps working over Telegram. `/lagrange:bridge` reports whether the console is active.

#### Claude Remote Control Security Guardrails

- **Workspace Allowlist (`hasTrustDialogAccepted`)**: Only projects where you have already accepted the trust dialog on your PC are offered in the `/claude` selection menu. Unconfirmed paths are filtered out to prevent unauthorized terminal execution. With several accounts (FEAT-085), the list joins the trusted projects of each one, and a session only launches with an account that trusts its folder. Lagrange never writes Claude Code's `.claude.json`: a folder you add by hand that no account trusts yet shows up in the list, and launching it tells you the exact command to accept the trust dialog once (with that account's `CLAUDE_CONFIG_DIR`).
- **`sesiones_claude` (FEAT-169, global `~/.claude/antigravity.json` only)**: `directorios` adds folders (`{ "<path>": { "modo": "same-dir"|"worktree", "cuenta": "<account>" } }`), `ocultos` hides paths, `cuenta_por_defecto` picks the account when a project trusts several, and `max_sesiones` (1–10, default 3) caps the sessions running at once. `ALLOWED_CLAUDE_WORKSPACES` and `deny_paths` still filter everything, added folders included. A project-level file cannot set it. Each session writes its own log, `claude-session-<account>-<id>.log`, in the bridge data folder, and runs with its account's folder and without Lagrange's secrets. With more than one account the default session name is `Mobile-<folder>-<nickname>`.
- **Environment Sanitization**: The spawned Claude process inherits a sanitized environment that strips internal bot tokens (`TELEGRAM_BOT_TOKEN`).
- **Mobile Control**: Once launched, simply open the official Claude mobile app (iOS/Android) or web interface to approve tool calls and review diffs in real time with the official UI.

---

## 📄 License

MIT
