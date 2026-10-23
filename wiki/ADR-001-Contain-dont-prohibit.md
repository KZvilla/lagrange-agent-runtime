# ADR-001: Contain, don't prohibit

**Status:** Accepted (mitigated in v0.46.0) · **Origin:** SEC-020, building on the confined batches of FEAT-061

## Context

Plans, reviews and audits were meant to be read-only. They were launched with `--mode plan` and a permission policy
whose `deny`, `deny_paths` and `deny_commands` were turned into lines at the top of the prompt. The tool
descriptions said edits were "impossible" and the policy "enforced", and the MCP annotations told clients the tools
were read-only, so a client could approve them without asking.

None of it was enforced. With `--dangerously-skip-permissions`, which every delegating call needs to run headless,
plan mode still runs commands. Measured incidents:

- an audit with `deny_commands: ["node*", "npm*"]` ran the full test suite;
- the same audit, with `deny: ["edit"]`, wrote a 64 KB copy of `git diff` into the audited worktree — caught only
  because `git status` was checked before committing;
- an earlier "read-only" audit ran `kill -Name node -Force` and took down the bridge daemon and the MCP servers.

## Decision

Stop pretending the prompt is a barrier, and put the read-only tools behind a real one.

1. **Honesty first.** Tool descriptions, the documentation and the skills say that `deny_*` and plan mode are
   instructions to the model. The read-only MCP annotations were removed.
2. **Detection.** Read-only tools snapshot `git status` before and after and report every change they caused,
   without reverting anything.
3. **Containment.** `agy_plan`, `agy_review` and `agy_audit` run in the same container as confined batches: an
   internal network behind an allowlist proxy, a decoy token, a read-only root, and a snapshot of the project
   without gitignored or `deny_paths` files.

Once the container has worked on a machine, `auto` never falls back to the host silently.

## Consequences

- An audit cannot write your repository, reach your processes or read your home directory.
- It also cannot run your tests: the gates are the caller's job before asking for an audit.
- Each call pays about half a minute of setup (token refresh, proxy, network).
- `agy_research` and `agy_session_summary` stay on the host with detection only — the residual risk is documented
  in [[Known Limitations]].
- `agy_run` and fan-out still write on the host by design; their guardrails remain hygiene. Work that must be both
  writing and contained goes through `agy_lote`.
