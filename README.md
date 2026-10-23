# Lagrange — Antigravity for Claude Code and Codex

![Version](https://img.shields.io/github/package-json/v/KZvilla/lagrange-agent-runtime?color=blue)
![Platform](https://img.shields.io/badge/platform-Windows%20|%20Linux%20|%20macOS-lightgrey)
![Dependencies](https://img.shields.io/badge/dependencies-0-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License](https://img.shields.io/badge/license-MIT-yellow)

Lagrange puts the [Google Antigravity CLI (`agy`)](https://antigravity.google/cli) behind Claude Code and Codex: deep reasoning, architectural planning, TDD implementation, adversarial review and cited research, delegated from the session you already use.

Claude stays in charge. When it delegates, Lagrange launches `agy` with a prompt, model, effort and permission policy, and returns what it produced. The MCP server is dependency-free Node.js; the plugin ships the skills, commands, Claude Code mods and the optional voice and Telegram bridges.

**Documentation:** [Reference](REFERENCE.md) (tools, parameters, components) · [Wiki](https://github.com/KZvilla/lagrange-agent-runtime/wiki) (guides, architecture, ADRs) · [Installation](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Installation)

---

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Commands and Tools](#commands-and-tools)
- [Documentation](#documentation)
- [Security model](#security-model)
- [License](#license)

---

## Quick Start

### Claude Code

Inside a session:

```text
/plugin marketplace add KZvilla/lagrange-agent-runtime
/plugin install lagrange@kzvilla-lagrange
```

**Restart Claude Code after installing.** `/reload-plugins` picks up commands, agents and skills, but the MCP tool schemas are registered at startup; a restart is what makes `agy_run` and the other tools appear.

Then try:

```text
/lagrange:plan Analyze this project and propose an implementation plan
/lagrange:review
/lagrange:audit
```

### Codex

Install from a release tag:

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

Start a new Codex thread after installing. Codex gets the skills and MCP tools; the `/lagrange:*` slash commands are Claude Code only. The plugin keeps its current state under `~/.claude/` during the MVP so Claude Code and Codex do not split agent memory or configuration.

### Updating

```bash
claude plugin marketplace update kzvilla-lagrange
claude plugin update lagrange@kzvilla-lagrange
```

Restart the host afterwards. Migration from the old install scripts, generic MCP clients and the repo-local opencode integration are in [Installation](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Installation).

---

## Features

| Capability | What it gives you |
|---|---|
| **Delegated reasoning** | `agy_run`, `agy_plan`, `agy_review`, `agy_audit` and `agy_research`, with model, effort, timeout and permissions per call. |
| **Parallel and confined work** | `agy_fanout` runs subagents in separate git worktrees with a disjoint-file contract; it prevents collisions, not writes outside the worktree. `agy_lote` runs confined batches in Docker; `/lagrange:watch` shows the progress. |
| **Agents that remember** | `cast_agent` builds a persistent reviewer from a SKILL; `alma` gives a Soul an identity and curated memory. |
| **Voice** | Narration that spends zero Claude tokens, and a real-time voice loop with barge-in through Voicebox or OmniVoice. |
| **Context that survives compaction** | `agy_session_summary` turns the raw session log into a checked Markdown document; `/lagrange:usage` reports tokens, cache and quota. |
| **From the phone** | Telegram notifications and questions, a local web console, remote `claude` sessions and a server/node network. |

Per-call, project and environment configuration, `conversation_id` continuity and every other detail are in [REFERENCE.md](REFERENCE.md) and the wiki.

---

## Prerequisites

| Requirement | Details |
|---|---|
| **Node.js** | ≥ 20.12 for the Telegram bridge (it loads `.env` with `process.loadEnvFile`); ≥ 18 for the `agy_*` MCP tools alone. |
| **Antigravity CLI** | `agy` or `agy.exe` installed and on your `PATH`, logged in with `agy auth login` ([install guide](https://antigravity.google/cli)). |
| **Host** | Claude Code or Codex; the plugin loads the same MCP server in both. |
| **Docker** *(optional, recommended)* | Needed for the read-only container and confined batches. With `readonly_isolation: "auto"`, plans, reviews and audits use the host only until the container has worked once; after that, a missing Docker is an error, not a silent downgrade. |

---

## Commands and Tools

The [Reference](REFERENCE.md) is derived from the code and gated: [Slash Commands](REFERENCE.md#slash-commands) · [MCP Tools](REFERENCE.md#mcp-tools-reference) · [Permission Fields](REFERENCE.md#permission-fields) · [Host Capability Matrix](REFERENCE.md#host-capability-matrix) · [Components](REFERENCE.md#components).

For how the surfaces fit together — commands, tools, skills and the workflows that combine them — see [Commands and Tools](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Commands-and-Tools).

---

## Documentation

The wiki is the manual. Start with the page that matches what you want to do.

| If you want to… | Read |
|---|---|
| Install, update or migrate | [Installation](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Installation) |
| Set defaults, permissions and engines | [Configuration](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Configuration) |
| Know what you can call | [Commands and Tools](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Commands-and-Tools) |
| Run work in parallel or in containers | [Fan-Out, Watch and Confined Batches](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Fan-Out-and-Confined-Batches) |
| Keep a reviewer with memory across sessions | [Persistent Agents](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Persistent-Agents) |
| Give a voice a durable identity and memory | [Souls](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Souls) |
| Send messages between sessions or read another account's memory | [Sessions and Messages](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Sessions-and-Messages) |
| Summarize a session or read usage | [Session Summary and Usage](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Session-Summary-and-Usage) |
| Hear checkpoints, or talk in real time | [Voice](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Voice) |
| Understand which model answers, and when another one takes over | [Engines and Fallback](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Engines-and-Fallback) |
| Set up Telegram, remote control or the web console | [Telegram Bridge](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Telegram-Bridge) |
| Join several machines | [Node Network](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Node-Network) |
| Use Claude Code's panel, toasts and guards | [Claude Code Mods](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Claude-Code-Mods) |
| Know what actually protects your machine | [Isolation and Security Model](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Isolation-and-Security-Model) |
| Know what Lagrange does **not** protect against | [Known Limitations](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Known-Limitations) |
| Understand a design decision | [Decisions](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Decisions) |
| Contribute | [Contributing](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Contributing) |

---

## Security model

Lagrange runs agents that can execute commands and write files. Before you delegate, know which part is a boundary:

- On your machine, `allow`, `deny`, `deny_paths`, `deny_commands` and `mode: "plan"` are **instructions to the model**, not a barrier.
- The real boundary is the container: with the default `readonly_isolation: "auto"`, `agy_plan`, `agy_review`, `agy_audit` and `agy_lote` run in Docker with a read-only snapshot, an internal network and an allowlist proxy.

Read [Isolation and Security Model](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Isolation-and-Security-Model) and [Known Limitations](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Known-Limitations) before relying on either. To report a vulnerability, use [SECURITY.md](SECURITY.md).

---

## License

MIT — see [LICENSE](LICENSE).
