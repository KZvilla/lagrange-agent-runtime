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
- [Codex and Other MCP Clients](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Installation#codex)
- [Telegram Bridge & Remote Control](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Telegram-Bridge)
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

Install from a release tag (or from a local clone — see [Native Codex plugin](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Installation#codex)):

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

See [Isolation and Security Model](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Isolation-and-Security-Model), [Configuration](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Configuration) and [Reference](REFERENCE.md#permission-fields).

## 🔀 Concurrent Subagent Fan-Out (`/lagrange:fanout`)

See [Fan-Out, Watch and Confined Batches](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Fan-Out-and-Confined-Batches).

## 👁️ Lagrange Watch (`/lagrange:watch`)

See [Fan-Out, Watch and Confined Batches](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Fan-Out-and-Confined-Batches#watch).

## 🎭 Persistent SKILL-Bound Agents (`cast_agent`)

See [Persistent Agents](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Persistent-Agents).

## 🫀 Souls (`alma`)

See [Souls](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Souls).

## 📨 Messages between sessions (`mensaje`)

See [Sessions and Messages](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Sessions-and-Messages#messages).

## 🧠 Recall: another account's memory

See [Sessions and Messages](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Sessions-and-Messages#recall).

## 🧩 Claude Code mods (`hooks/mods.tsx`)

See [Claude Code Mods](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Claude-Code-Mods).

## ⚙️ Model & Reasoning Effort Configuration

See [Configuration](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Configuration#where-settings-come-from).

## 📊 Telemetry & Usage Tracking (`/lagrange:usage`)

See [Session Summary and Usage](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Session-Summary-and-Usage#telemetry).

## 📋 Session Summary & Anti-Compaction (`/lagrange:summary`)

See [Session Summary and Usage](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Session-Summary-and-Usage#session-summary).

## 🎙️ Voice Checkpoint Narration (`/lagrange:narrate`)

See [Voice](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Voice#narration).

## 🗣️ Real-Time Voice Mode (`voice-chat/`)

See [Voice](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Voice#real-time-voice).

## 🌐 Deep Web Research (`/lagrange:research`)

See [Commands and Tools](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Commands-and-Tools#deep-web-research).

## 📦 Components

The component map is in [REFERENCE.md](REFERENCE.md#components).

## 🔧 Installation & Setup

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

Codex, from a release tag:

```bash
codex plugin marketplace add KZvilla/lagrange-agent-runtime --ref <release-tag>
codex plugin add lagrange@kzvilla-lagrange-codex
```

From a local clone:

```bash
codex plugin marketplace add /absolute/path/to/lagrange-agent-runtime
codex plugin add lagrange@kzvilla-lagrange-codex
```

Restart the host after installing: a running session keeps the code it started with. More detail:
[Installation](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Installation), [Telegram Bridge](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Telegram-Bridge),
[Node Network](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Node-Network), [Reference](REFERENCE.md).

## 📄 License

MIT
