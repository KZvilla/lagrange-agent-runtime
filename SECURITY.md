# Security Policy

Lagrange runs autonomous agents on your machine, holds credentials (Telegram bot tokens, API keys, OAuth sessions
for a second Claude account) and exposes local services (the bridge daemon, the web console, the node network). We
take reports about any of that seriously.

## Supported versions

The Claude Code marketplace pins every install to the commit of the latest release tag, so only the **latest
release** receives security fixes. A fix ships as a new patch version; there are no backports.

| Version            | Supported |
| ------------------ | --------- |
| Latest release     | ✅        |
| Any older release  | ❌ — update with `claude plugin marketplace update kzvilla-lagrange`, then `claude plugin update lagrange@kzvilla-lagrange` |

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/KZvilla/lagrange-agent-runtime/security/advisories/new)
(Security tab → *Report a vulnerability*).

A useful report includes:

- the Lagrange version (`telegram_bridge_status` prints it) and the host: Claude Code or Codex, OS, and whether the
  bridge runs as server or node;
- the component involved (MCP server, Telegram bridge, web console, node network, container executor, hooks/mods…);
- steps to reproduce, and what an attacker gains: what they need beforehand and what they reach afterwards;
- a proof of concept if you have one.

**Never include real secrets** — bot tokens, API keys, OAuth files, `.env` contents or session logs. Redact them or
use dummy values; we will ask for anything else we need.

### What to expect

This is a small, maintainer-run project, so timelines are best-effort:

- **Acknowledgement** within 7 days.
- **Initial assessment** (confirmed or not, and a severity) within 14 days.
- **Fix** in a patch release as soon as it is ready; critical issues (secret exposure, remote code execution) go first.

Fixed issues are published as a GitHub Security Advisory and recorded in the project's `SEC-XXX` backlog. You will be
credited in the advisory unless you prefer otherwise. Please give us a reasonable window to ship the fix before any
public disclosure; we will agree on a date with you.

## Scope

In scope — anything in this repository, in particular:

- **Secret handling:** a bot token, API key or OAuth credential reaching a log, a tool result, the web console, a child
  process that runs a model, a Telegram message or a third-party model.
- **The web console and the bridge's local endpoints:** bypassing the per-launch token, CSRF from a browser tab, or
  anything that makes them reachable beyond loopback.
- **The node network:** joining or impersonating a node without a valid pairing, escaping the permission level a node
  grants (`lectura` / `operar` / `ejecutar`), or reaching `/nodo/*` from outside the encrypted interface.
- **Telegram:** a user outside `ALLOWED_USER_IDS` (or a Soul bot's user list) getting the bot to act.
- **The container boundary** used by `agy_plan`, `agy_review`, `agy_audit` and the confined batches (`agy_lote`):
  reading the host, reaching the network past the allowlist proxy, or obtaining the real token instead of the decoy.
- **Souls and imported envelopes:** content that gets past the memory scan and turns into instructions or a tool call.
- **Supply chain of the plugin itself:** the marketplace pin, the release scripts, vendored files.

## Known limitations (not vulnerabilities)

These are documented trade-offs. A report that only restates one of them will be closed, but a report that shows one
of them is **worse than documented** is welcome.

- **Guardrails on the host are instructions, not a sandbox.** `allow`, `deny`, `deny_paths` and `deny_commands` reach
  agy as prompt text; `mode: "plan"` still runs commands; a git worktree does not confine writes. The only real
  containment is the container executor. See [Isolation and Security Model](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Isolation-and-Security-Model)
  and the field table in [REFERENCE.md](REFERENCE.md#permission-fields).
- **`sandbox: true`** in agy restricts the terminal only, and on Windows it is harmful (see
  [Isolation and Security Model](https://github.com/KZvilla/lagrange-agent-runtime/wiki/Isolation-and-Security-Model)).
- **A read-only `cast_agent`** still reaches every MCP server you configured; `read_only` closes native write tools,
  not MCP.
- **Anything that requires prior control of your user account** (reading files in your home directory, attaching to
  your processes, editing your `.env`) is outside the threat model: a local attacker with your privileges already has
  what Lagrange protects.
- **Vulnerabilities in upstream tools** — Antigravity CLI (`agy`), Claude Code, Codex, OpenCode, Voicebox, Docker,
  Telegram — should go to their vendors. If Lagrange makes one of them exploitable where it would not be otherwise,
  that part is in scope.
