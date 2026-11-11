---
name: fanout
description: "[skill, loads itself] How to run several Antigravity subagents concurrently, one git worktree each, with agy_fanout. Use when a plan is already broken into atomic tasks and the user wants them implemented in parallel, or mentions fan-out, subagentes concurrentes, paralelizar tareas, worktrees por subagente, or splitting implementation work across several agy instances. Covers when not to fan out, the disjointness and interface contract between tasks, how to brief each task, what the worktree does and does not isolate, and the review, test and merge work that stays with the host agent."
user-invocable: false
---

# Concurrent fan-out of Antigravity subagents

`agy_fanout` runs N `agy` subagents in parallel, each in its own git worktree and branch. It implements and stops there: reviewing, testing, and integrating stay with you.

## When not to use it

- **The tasks overlap in files.** The validator rejects the batch, and it is right: in series they finish sooner than a merge conflict gets resolved.
- **Fewer than three tasks.** The fixed cost of worktrees, review, and integration does not pay off. Use `agy_run`.
- **Exploratory work.** Fan-out assumes a closed plan. If you cannot yet say which files each part touches, it is not decomposed: use `agy_plan` first.
- **You want each task tested and audited for you.** `agy_lote` takes the same task shape, runs each task in a container, runs the tests without network, and audits each commit with a different model. Prefer it when confinement or a verdict per task matters more than speed; nothing is merged automatically there either.

## What the worktree isolates

**It separates branches. It does not confine the subagent.** A subagent with auto-approved permissions can read and write any absolute path on the machine. Assume that before launching it on a repository with secrets on disk.

**Permissions are prompt text.** `allow`, `deny`, and the list of files a task may touch are instructions the model usually follows. `soloLectura: true` runs a task in plan mode, which is the closest thing to "do not edit" available, and it is not enforced either. The `agy-cli` skill covers this under "Permissions and isolation".

**There is no sandbox option, on purpose.** agy's `--sandbox` ignores the requested working directory, leaks file writes into the main repository, requires UAC elevation on Windows, which no headless concurrent run can answer, and leaves a mount behind.

**Two worktrees cannot share a branch.** Each subagent gets a new branch derived from the base. "Everyone works on our branch" is not possible in git.

## The task contract

### Disjoint in files

Worktrees isolate execution, not integration: if two tasks touch the same file, the conflict does not disappear, it moves to the merge. `agy_fanout` validates disjointness **before** creating worktrees or spending quota and rejects the whole batch on any overlap. Split the tasks again, or run those two in series.

```json
{
  "id": "auth",
  "prompt": "Implement rate limiting for the login endpoint...",
  "archivos": ["src/auth.js", "src/middleware/rate-limit.js"],
  "skill": "agency-backend-architect"
}
```

- `archivos`: paths relative to the repository root. A trailing slash marks a whole subtree (`src/api/`). Absolute paths and `..` are rejected.
- Do not list test files. Subagents are told not to write or run tests.
- `modelo` and `effort` are optional per task and per batch. Omit them unless the user asked: the configured defaults apply. Effort is `low`, `medium`, or `high`; there is no `xhigh`.
- `soloLectura`: plan mode for that task.

### Coupled through interfaces

Disjoint files are necessary, not sufficient. Two tasks that share no file can still depend on each other: one calls the function the other defines, or both read the same type, route, config key, or event. Each subagent works blind to the others, so each one will invent its own version.

Before launching:

- **Write the shared contract into the prompt of every task that depends on it**: the exact signature, type, route, or key, as text.
- **Or build the shared piece first, in series**, commit it to the base branch, and fan out from there.

### Briefing each task

Each subagent starts with no conversation, no knowledge of the plan, and no idea other tasks exist. Its prompt must stand alone:

- what to build and what to leave alone;
- the files it owns, and the files it may read for reference;
- the contracts it shares with other tasks, written out;
- the project conventions that apply, stated, not assumed;
- the observable behavior that means it is done. Not "the tests pass": it cannot run them.

### The `skill` field

Optional. It names an installed skill, from the catalog that `cast_agent` lists with `action: "skills"`. Its body enters the subagent's prompt as **guidance**, between the rules and the task and subordinate to the rules: if the skill says "run the tests", the rules win. It gives a task a role or a style. It grants no permission, nothing enforces it, and it is not a `cast_agent`: no identity, thread, or memory.

The batch is rejected before creating worktrees if the skill does not exist, is empty, or is larger than 48 KB. `agy_lote` accepts the same field and also rejects a skill that mentions an absolute host path, or a final prompt above 120 KB.

## The cycle

`agy_fanout` covers steps 1 to 3. From step 4 on the work is yours, and that boundary is deliberate.

1. **Decompose** into atomic tasks, disjoint in files, with shared contracts written down.

2. **Validate and launch** with `agy_fanout`. It resolves the base branch (never `main`/`master`: from there it creates `feat/<slug>`; from `dev`/`develop` or a working branch it uses that one), creates one worktree and one branch per task under `.claude/worktrees/`, and runs them in batches with a concurrency cap and quota backoff.

3. **Collect** the result of each task: branch, status, attempts, and `conversation_id`. The output does not list worktree paths; `git worktree list` maps each branch to its path.

4. **Check what each task actually touched.** For each branch, compare `git diff --name-only <base>..<branch>` with the task's `archivos`. A file outside the list is a finding before any review starts.

5. **Screen** each diff with `agy_review`, passing `git diff <base>..<branch>` as the target. It is a first filter that keeps N full diffs out of your context. It still costs quota per task, so skip it for trivial diffs you can read directly.

6. **Audit** what the filter flags, plus the full diff of anything critical. For a blocking verdict use `agy_audit`.

7. **Correct** by resuming the task: `agy_run` with its `conversation_id` and `cwd` set to its worktree. Two rounds at most; after that, take the task yourself. Without a limit this becomes an expensive loop.

8. **Test, yourself.** Subagents are forbidden to write and run tests. This is not distrust: a model that writes the code and its own test optimizes for the test passing, not for the code working.

9. **Integrate, yourself**, merging the branches in order into the base. Subagents never merge. Run the tests again on the merged result: tasks that pass alone can fail together.

10. **Clean up** with `git worktree remove <path>` and `git branch -d <branch>` for each merged task. Leave any worktree that still holds unmerged commits and tell the user about it.

## While it runs

Step 2 is a single blocking MCP call. Each subagent has its own time limit (15 minutes by default), and with more tasks than the concurrency cap the batches run one after another, so a large fan-out can take several times that. A host with a shorter MCP deadline will give up before the tool returns; size the batch accordingly.

To follow it live, the user can run `/lagrange/watch`: a read-only local console that shows each task's progress and diff and can stop a subagent. It is a script the user launches in a terminal, not something to start in the background yourself.

Claude Code can also enable, from track E of the `setup` skill, a progress line in the statusline (`🔀 fanout <slug>: 3/5 ok · 1 reintentando(429) · 1 corriendo`). That statusline is Claude Code-only in the MVP; it is not announced in Codex.

## Choosing the concurrency

The cap exists for quota, not CPU. The default is 3. Raising it multiplies the risk of a 429 and, with a large N, saturates your own context in the review phase. Check `agy_usage` before a large batch: its quota status says when the quota is already strained.

Quota failures are retried with exponential backoff, twice. Code errors are not retried: repeating them costs the same and returns the same.
