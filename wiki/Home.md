# Lagrange

Lagrange is a plugin for **Claude Code** (and, with a narrower surface, **OpenAI Codex**) that turns Google's
**Antigravity CLI (`agy`)** into a subagent Claude can delegate to: implementation, plans, adversarial reviews and
audits, cited web research, session summaries. Around that core it adds spoken narration, a Telegram bridge and a
local web console.

This wiki explains **how it works and why it is built the way it is**. The
[Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md) stays the reference for every
command, tool and parameter - a test keeps it in sync with the code, so it is the source of truth when the two
disagree. The [README](https://github.com/KZvilla/lagrange-agent-runtime#readme) is the front page.

## Start here

| If you want to… | Read |
|---|---|
| Install, update or migrate | [[Installation]] |
| Set defaults, permissions and engines | [[Configuration]] |
| Know what you can call | [[Commands and Tools]] |
| Understand which model answers, and when another one takes over | [[Engines and Fallback]] |
| Know what actually protects your machine | [[Isolation and Security Model]] |
| Know what Lagrange does **not** protect against | [[Known Limitations]] |
| Understand a design decision | [[Decisions]] |
| Contribute | [[Contributing]] |

## The one-paragraph mental model

Claude stays in charge of your session. When it delegates, Lagrange launches `agy` as a child process with a
prompt, a model, an effort level and a permission policy, and returns what it produced. Work that only needs to
**read** (plans, reviews, audits) runs inside a Docker container over a read-only copy of your project. Work that
**writes** runs on your machine, where the permission policy is a set of instructions to the model, not a
sandbox — see [[Isolation and Security Model]]. Some roles (Souls, consolidation, read-only agents) can run on
other engines, and an opt-in fallback covers the moments `agy` cannot answer — see [[Engines and Fallback]].

## Reporting a security problem

Privately, through [GitHub Security Advisories](https://github.com/KZvilla/lagrange-agent-runtime/security/advisories/new).
See [SECURITY.md](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/SECURITY.md).
