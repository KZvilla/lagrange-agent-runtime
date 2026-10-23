# Commands and Tools

Lagrange exposes two surfaces: **slash commands** (`/lagrange:*`, Claude Code only) that you type, and **MCP
tools** that Claude (or Codex) calls on its own when you ask in plain language. Most commands are thin wrappers
around one tool.

This page groups them by what they are for. The exact parameters, defaults and timeouts live in the
[Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#mcp-tools-reference); a test fails if
that table and the server drift apart, so trust it over any copy.

## Delegating work to agy

| Tool | Command | Writes? | Where it runs |
|---|---|---|---|
| `agy_run` | `/lagrange:run` | Yes | Your machine |
| `agy_plan` | `/lagrange:plan` | No | Read-only container |
| `agy_review` | `/lagrange:review` | No | Read-only container |
| `agy_audit` | `/lagrange:audit` | No | Read-only container |
| `agy_research` | `/lagrange:research` | No | Your machine (it needs the open web) |
| `agy_session_summary` | `/lagrange:summary` | Writes the summary file | Your machine |

`agy_plan`, `agy_review` and `agy_audit` also accept `engine: "deepseek"` or `"opencode-go"` when you ask for it
explicitly — see [[Engines and Fallback]].

## Parallel and confined work

| Tool | Command | What it does |
|---|---|---|
| `agy_fanout` | `/lagrange:fanout` | Several agy subagents at once, one git worktree each, only if their files are disjoint |
| `agy_lote` | — | A **confined batch**: each task in its own container, tested in a no-network runner and audited by a different model |
| — | `/lagrange:integrar-lote` | Merges a confined batch into its base branch, only with green tests and an audit PASS |
| — | `/lagrange:watch` | Local viewer for fan-outs, agents, Souls and batches |

A worktree keeps parallel subagents from colliding; it does **not** stop them writing elsewhere. Only `agy_lote`
contains them. See [[Fan-Out, Watch and Confined Batches|Fan-Out-and-Confined-Batches]] and
[[Isolation and Security Model]].

## Persistent agents and Souls

| Tool | What it does |
|---|---|
| `cast_agent` | A reviewer or auditor built from a SKILL that keeps its identity, thread and learned criteria across sessions — see [[Persistent Agents]] |
| `alma` | Souls: identities with memory that speak through narration, Telegram and voice chat — see [[Souls]] |

## Voice

| Tool | Command | What it does |
|---|---|---|
| `narrate` | `/lagrange:narrate` | Speaks a summary of the latest checkpoint |
| `say` | — | Speaks a text you already have |
| `narrate_voices` | `/lagrange:voices` | Lists profiles and service health without starting anything |
| `voice_model` | — | Starts the TTS server and pins or unloads the model in VRAM |
| `agy_voice_stream` | — | Backend of the real-time voice chat |

See [[Voice]] for setup, identities, Voicebox, OmniVoice and real-time voice.

## Telegram, sessions and the console

| Tool | What it does |
|---|---|
| `telegram_notify`, `telegram_ask`, `telegram_send_voice` | Reach your phone; `telegram_ask` blocks until you tap an answer — see [[Telegram Bridge]] |
| `telegram_bridge_status` (`/lagrange:bridge`) | Diagnoses the daemon and shows which Lagrange version each part runs |
| `mensaje` | Messages between Claude Code sessions, on this machine or on other nodes — see [[Sessions and Messages]] |
| `consola` | Lets a session drive the web console; gated by `orquestacion_modo` — see [[Telegram Bridge]] |
| `conocimiento` | A knowledge base shared by every session and account on the machine |
| `recall` | Reads this project's memory from another Claude account, read-only — see [[Sessions and Messages]] |

## Deep web research

`agy_research` (or `/lagrange:research <topic>`) runs a cited web research task. It needs the `network` capability;
if denied, it fails with an explicit error instead of answering from memory. It runs on the host because it needs
the open web, and it takes a `git status` snapshot before and after and reports any change. A `project_context`
argument focuses the relevance section, `recency` constrains the sources, and `conversation_id` resumes a research
thread. The output is a structured report with sources. Parameters are in the
[Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#mcp-tools-reference).

## Status and settings

`agy_status`, `agy_usage` (`/lagrange:usage`) and `set_config`. `/lagrange:setup` configures the optional pieces —
see [[Installation]].
