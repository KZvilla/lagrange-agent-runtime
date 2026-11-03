# Technical Debt and Deferred Work

This is the public, curated view of Lagrange's known technical debt and deliberately deferred work. It says what is open, how urgent it is, and what would trigger work on it. The detailed register, evidence, file paths and implementation notes stay in local, unversioned notes; this page deliberately omits them.

**Snapshot based on the 2026-11-01 review; updated 2026-11-03 after v1.63.7.**

## How to read this page

Priorities and statuses follow [[Contributing]] (P0–P3; `Proposed`, `In Progress`, `Mitigated`, `Deferred`). A `Deferred` item is not being worked on now; the trigger column says what would reopen it, or notes that it waits on an explicit decision.

## Register

| ID | Item | Priority | Status | Why it matters | Trigger / next step |
|---|---|---|---|---|---|
| BE-173 | MCP server entry point | P3 | In Progress | The entry point is still large, but the Telegram outbound tools now live in their own module. | Extract the next domain (bridge status, then voice), one per change, with the same tests. |
| BE-176 | Bridge test suite | P3 | In Progress | A single large suite still makes failures slower to isolate, but the shared fixture, the import test, the formatter tests and the paths/environment tests now live in their own files. | Extract the next group, with the same assertions. |
| BE-012 | Sandbox mount cleanup | P3 | Mitigated | Sandbox can leave mounts behind on Windows; fan-out does not use it and audits force it off. | Reopen if a default workflow needs `sandbox: true` on Windows. |
| FEAT-129 | Knowledge format: phases 2–3 | P3 | Deferred | Souls and casts still split memory between old and new stores. | Reopen when the knowledge-format specification advances. |
| FEAT-050 | Watch: controlled editing | P3 | Deferred | Watch remains read-only. | Reopen after the four controlled-edit operations are specified and tested. |
| FEAT-174 | Souls: photo mediator via OpenCode Go | P3 | Deferred | Photo description still uses the direct DeepSeek route. | Reopen after the OpenCode Go evaluation closes. |
| BE-020 / FEAT-046 | Souls: voice for reactions and deep search | P3 | Deferred | Reactions are text-only and deep search is limited. | Reopen when a real operational need appears. |
| FEAT-006 | Codex packaging as a fallback | P3 | Deferred | Codex is kept as a fallback, without new packaging work. | Reopen if Codex becomes a supported distribution channel again. |
| FEAT-109 | Mods idea catalog | P3 | Deferred | The catalog has ideas without a single plan. | Reopen when a specific idea gets a concrete use case. |
| FEAT-158 F4 | Fallback escalation | P3 | Deferred | Fallback does not escalate beyond the configured step. | Reopen only by explicit decision if single-step fallback proves insufficient. |
| — | Marketplace phase 4: official listing | P3 | Deferred | Distribution is not yet listed in the official marketplace. | Reopen when ready to submit the official marketplace form and test a clean install. |
| — | Telegram bridge: second authorized user | P3 | Deferred | Some bridge flows assume a single authorized user. | Revisit before adding a second authorized user. |

## Recently resolved

- **BE-171** — node network state persistence: corrupt state is quarantined instead of overwritten, and mutations require the lock. Fixed in v1.63.1.
- **BE-172** — shared atomic writes: the server and bridge now use common helpers with retry for transient Windows file locks. Fixed in v1.63.2.
- **BE-175** — optional UI startup diagnostics: a subsystem that fails to start now leaves a named line instead of disappearing silently. Fixed in v1.63.3.

## Monitored, not opened

These are known costs or risks that do not justify an item yet:

- **Test-suite timing.** The full suite is sequential and some tests use fixed waits on purpose; if it grows, split the largest groups first and replace fixed waits with polling where possible.
- **Optional voice dependencies.** The Python microphone loop declares its packages without pinned versions; pin them if an install breaks.
- **Node version declaration.** The root package does not declare `engines`; the bridge does. Add it if onboarding hits a version mismatch.

## What this page does not include

This page is deliberately high-level. It omits paths, logs, session or conversation IDs, personal data, security findings (`SEC-*`) and reproduction steps; those stay in local, unversioned notes.

## Related

- [[Known Limitations]]
- [[Contributing]]
- [[Node Network]]
- [[Telegram Bridge]]
- [[Souls]]
- [[Engines and Fallback]]
- [[Isolation and Security Model]]
