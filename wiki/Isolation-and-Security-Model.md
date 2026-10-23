# Isolation and Security Model

Lagrange runs agents that can execute commands and write files on your machine. This page says plainly what
contains them and what does not.

## Three levels, from weakest to strongest

| Level | Used by | What it really stops |
|---|---|---|
| **Prompt guardrails** | `agy_run`, `agy_research`, `agy_session_summary`, fan-out subagents | Nothing by force. `allow`, `deny`, `deny_paths`, `deny_commands` are written into the prompt as instructions |
| **Git worktree** | `agy_fanout` | Collisions between parallel subagents in your checkout. **Not** writes elsewhere: agy writes to absolute paths outside the worktree |
| **Container** | `agy_plan`, `agy_review`, `agy_audit`, `agy_lote` | Writes to your repository, access to your home directory and host processes, and network beyond an allowlist |

Only the last one is a boundary. The first two are hygiene that reduces the blast radius of a well-behaved model.

### Why the guardrails are not a boundary

Only three things reach `agy` as real flags: `--mode plan`, `--sandbox` and `--dangerously-skip-permissions`.
Every delegating call passes the last one, and with it plan mode still runs shell commands. This is not
theoretical: before the container existed, read-only audits ran the test suite despite `deny_commands`, wrote a
64 KB file into the audited tree despite `deny: ["edit"]`, and once killed every `node` process on the machine.

`sandbox: true` is narrower than its name: it restricts the terminal, while agy's native file tools walk past it.
On Windows it also ignores the working directory, asks for UAC elevation and leaves a mount behind, so Lagrange
never enables it for audits.

The default `deny_commands` includes `pkill*`, `taskkill /IM*` and friends for that reason: killing processes by
name takes down the bridge daemon and the MCP servers along with whatever the agent meant to stop.

## The read-only container

With `readonly_isolation: "auto"` (the default), plans, reviews and audits run in Docker once the batch
infrastructure is installed:

- an `--internal` network whose only exit is an **allowlist proxy**;
- a **decoy token** inside — the real credential lives in the proxy, which swaps it in only for the exact API call;
- a read-only root, no MCP servers, none of your home directory;
- your project as a **snapshot**: tracked and untracked files as they are on disk, minus gitignored files and
  anything matching `deny_paths`. No `.git`; the branch, status, recent commits and diffs are provided as files.

The first time the container works, a marker is written and `auto` **never silently falls back to the host
again** — a stopped Docker becomes an error, not a downgrade. `"container"` makes that strict from the start;
`"host"` turns it off.

`agy_research` (needs the open web) and `agy_session_summary` (its input is your own session log) still run on the
host. They, like plan, review and audit, compare `git status` before and after and report every change they
caused; nothing is reverted.

## Engines without tools

Souls, consolidation and narration put **model-written text** into prompts — memory, transcripts. A prompt
injection hidden there must find no way to act, so those roles run on a profile with **no tools at all**:

- on **agy**, a dedicated agent with no tools, launched without `--dangerously-skip-permissions` so agy denies any
  MCP call on its own;
- on **Claude**, `--tools ""` with `--safe-mode --strict-mcp-config`, the prompt on stdin and a stripped environment;
- on **DeepSeek / OpenCode Go**, a request body built from a fixed whitelist that never carries tools.

For agy and Claude this is checked by probes for the installed CLI version before use, and refused until they
pass. See [[ADR-002: Isolation is verified, not assumed|ADR-002-Isolation-is-verified-not-assumed]].

## Content from outside

Photos, web searches and pages reach a Soul only through an isolated mediator that knows nothing about the Soul,
and the Soul sees a description framed as data. A thread that has seen outside content is **tainted**: it writes no
memory and touches no board until it is renewed.

## Secrets

- The Telegram token and API keys live only in the bridge `.env`. The daemon removes them from its own environment
  after loading, and Lagrange strips them from every child that runs a model.
- They never appear in tool results, logs or the web console (which only says whether a key is set).
- `/lagrange:setup` never asks for a secret in the chat: anything typed there is stored in the session log, and the
  session summary sends that log to a model.

## Local services

- The **web console** listens on loopback only and checks that the `Host` is loopback too (against DNS rebinding).
  A per-launch token is exchanged for an `HttpOnly; SameSite=Strict` cookie; mutations also check `Origin` /
  `Sec-Fetch-Site`; there is no CORS and the CSP allows nothing inline. Phone access goes through Tailscale Serve
  on a separate channel with its own cookie, the Tailscale login header and a one-time code.
- The **fan-out viewer** also listens on `127.0.0.1` only and requires a per-launch token on every request;
  mutations need it in a custom header, which a hostile `<form>` cannot set.
- The **node network** pairs with a single-use code and then authenticates with Ed25519 keys; across machines it only
  listens on a Tailscale or WireGuard interface. Each node decides what the server may do on it.

## See also

- [[Known Limitations]]
- [[ADR-001: Contain, don't prohibit|ADR-001-Contain-dont-prohibit]]
- [SECURITY.md](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/SECURITY.md) — how to report a vulnerability
