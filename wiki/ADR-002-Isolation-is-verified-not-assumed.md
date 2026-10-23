# ADR-002: Isolation is verified, not assumed

**Status:** Accepted (v0.43.0) · **Origin:** SEC-018, SEC-019

## Context

Souls, voice-chat consolidation and narration put **text written by a model** into prompts: a Soul's memory, what
it knows about the user, transcripts. If that text carries an injection, the only thing that makes it harmless is
that the engine reading it has **no way to act** — no native tools and no MCP.

Lagrange had already learned that CLI flags do not always do what they say:

- `--sandbox` leaked writes outside the working directory;
- plan mode with `--dangerously-skip-permissions` ran commands;
- an agent with `tools: []` still received Antigravity's MCP bridge tools;
- `--agent` on a resumed thread was silently ignored.

When a second engine (`claude -p`) was added for Souls, there was no reason to believe it would be different.

## Decision

**No isolation profile is trusted without a live probe for the installed CLI version, on any engine.**

- Each engine declares profiles (`sin-tools`, `lectura`). Before a role runs on a profile, short probes must have
  passed for the exact CLI and Lagrange versions installed: no tools, no MCP servers, no hooks, no writes.
- If the probes have not passed, the call is **refused with the reason** — never silently moved to another engine
  (fail-closed).
- On agy, the barrier is two conditions together, and the probes test both: an agent with no tools **and** a launch
  without `--dangerously-skip-permissions`, so agy denies MCP calls on its own.
- On Claude, every launch — resumes included — repeats `--safe-mode --strict-mcp-config` and an empty tool list;
  the prompt goes through stdin and the child's environment is stripped of the parent session's variables.
- Engines that are plain HTTP APIs (`deepseek`, `opencode-go`) are **verified by construction** instead: the request
  body comes from a fixed whitelist that never carries tools, and a response asking for a tool call is an error.

## Consequences

- Updating Claude Code or agy re-triggers the probes; until they pass, roles on that engine wait.
- The probes cost a few short calls on a small model; the bot runs them in the background at startup.
- The evidence is inspectable on demand (`alma action:"agente" sondas:true`).
- A new engine cannot be added by declaring it safe: it needs probes or a by-construction argument.
