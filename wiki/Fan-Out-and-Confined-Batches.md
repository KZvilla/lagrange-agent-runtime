# Fan-Out, Watch and Confined Batches

Lagrange has three ways to run work in parallel. They share the same idea — keep agents from colliding — but they
contain very different amounts.

## Fan-Out

`agy_fanout` takes a plan split into atomic tasks and runs one Antigravity subagent per task, each in its own git
worktree and branch. It is for **implementation** work that can be divided cleanly; it is not for reviews or
judgment calls.

```jsonc
{ "slug": "login-refactor", "tareas": [
  { "id": "t1", "prompt": "…", "archivos": ["src/auth/"] },
  { "id": "t2", "prompt": "…", "archivos": ["src/ui/login.tsx"] }
] }
```

### Atomic tasks and disjoint files

Every task declares the files or directories it may touch (`archivos`). The batch is validated **before spending
quota**: two tasks that overlap — the same file, a directory and a file inside it, or the same file with different
separators or casing — reject the whole batch. A task that declares `src/api/` owns the subtree; `src/apiario.js`
is a different path.

This is a contract, not a sandbox: it keeps parallel agents from editing the same file, but it does not stop an
agent from writing outside its worktree.

### Worktrees, not sandbox

Each subagent runs in a separate git worktree, on its own branch, derived from a base branch. That prevents two
agents from colliding in your checkout. It does **not** contain them: `agy` can write to absolute paths outside the
worktree.

Do not use `--sandbox` for this. Measured on Windows, it ignores the working directory, asks for UAC elevation,
leaves a mount behind, and its native file tools walk past it. The worktree is the isolation mechanism for fan-out;
the container is the real boundary for read-only work — see [[Isolation and Security Model]].

### Concurrency and quota

The default concurrency is `3`. The cap protects API rate limits and token quotas, not CPU. If a subagent hits an
HTTP 429 or a quota error, the batch pauses and retries with exponential backoff (20 s, 40 s). Code errors are not
retried blindly.

### Who does what

Subagents implement. They are told not to write or run test suites, not to merge or switch branches, and not to
spawn subagents. Claude stays in control: you and Claude review the diffs, run the tests, handle up to two
correction rounds by resuming with `conversation_id`, and merge and clean up the worktrees.

Parameters and defaults are in the [Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#agy_fanout--parameter-reference).

## Watch

`/lagrange:watch`, or `node <plugin>/mcp-server/fanout-watch.js`, opens a local, read-only console for the Lagrange
inventory. It is a viewer, not an orchestrator.

- **Live fan-out:** each running batch shows its subagents, progress, diffs and a **Stop** control. Stopping writes
  the same stop sentinel the orchestrator already reads; the subagent stops at its next check.
- **Persistent agents tab (`/agents`):** registrations, thread state, last activity and whether each agent resolves.
- **Access control (SEC-011):** the server binds to `127.0.0.1` only and every page and API request needs a
  per-launch token. Mutations need the token in a custom header, which a hostile `<form>` cannot set.
- **What it reads:** local files and, only when a section is opened, `agy agents` and local services. The initial
  summary is local-only and labels every source as local, generated, live, cached, derived or unavailable.
- **Flags:** `fanout_statusline`, `fanout_progress_log` and `fanout_control` in the configuration. The statusline
  integration is Claude Code-only.

The inventory is also described in [[Commands and Tools]] and its security model in
[[Isolation and Security Model]].

## Confined batches

`agy_lote` is the strongest isolation Lagrange has. Each task runs in its own Docker container on an `--internal`
network whose only exit is an allowlist proxy, with a read-only root, a decoy credential and none of your home
directory. The commit is then tested in a no-network runner and audited by a different model.

Nothing is merged automatically. Integration is an explicit human decision through
`/lagrange:integrar-lote`, and only with green tests and an audit PASS. Discarding the batch is the other outcome.

### Batches written by Claude

`agy_lote` can use `motor: "claude@<account>"` to have a Claude Code account write the tasks instead of agy, inside
the same container boundary. It is the only place where Claude gets edit tools from Lagrange.

- **The secret never touches the host.** The account logs in once inside the image; the OAuth lives in a Docker
  volume, never in `~/.claude-work`. A refresher renews it before each batch and exports the access token to the
  proxy; the task sees a decoy credential without a refresh token.
- **The edit profile** is `Read, Edit, Write, Glob, Grep, Bash`, `--permission-mode acceptEdits`,
  `--strict-mcp-config --safe-mode`, no session persistence and never `--resume`.
- **Probes gate it.** `sondar-claude` runs a real refresher and a real task on a throwaway repo and checks the
  tool list, the absence of MCP servers and a canary file. The result is keyed by Claude Code + Lagrange version.
- **The audit still runs on agy.** A batch written by Claude is not refused for agy's quota, but if Gemini is
  exhausted its audit fails and the batch cannot be integrated.

See [[Isolation and Security Model]] for the container boundary and [[Engines and Fallback]] for the engines.
