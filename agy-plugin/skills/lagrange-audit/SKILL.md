---
name: lagrange-audit
description: Runs a Lagrange audit request (an adversarial audit) from this project's audit queue (.lagrange/auditorias/, or the older .lagrange/agy/) and hands the report back to the session that asked for it. Use when the user runs /lagrange-audit, optionally with a 6-hex request id, or asks to run, list or pick up a Lagrange audit request.
---

# lagrange-audit

Lagrange (a plugin for Claude Code, opencode and agy) does not launch agy: when a session needs an adversarial audit it
leaves a request in this project's audit queue, and any other session (this one included) can run it. You never audit
a request this conversation asked for: that one is for someone else.

## With the Lagrange MCP (the `audit_queue` tool is available)

Use it for every step, always with `cwd` set to the absolute path of this project's root; it checks who you are, so
do not edit the queue's files by hand.

1. **Find the request.** With an id (6 hex characters, e.g. `a1b2c3`), go to step 2. Without one, call
   `audit_queue` with `action: "list"` (`which: "to_audit"`): resume the row marked "tomado por vos" if there is one,
   otherwise use the first row (the newest); say which one you took and, if there were more, name their ids
   (FEAT-200). With none, say so and stop. If `list` is empty but
   `.lagrange/agy/pedidos/` has an `tipo: audit` request without a report, it is an older request: follow
   **Without the MCP** for that one.
2. **Take it:** `audit_queue` with `action: "take"` and `id`. The reply carries the whole request (process, task and
   the git context folder). If `take` says there is no such request but `.lagrange/agy/pedidos/<id>.md` exists, it is
   an older request: follow **Without the MCP** for that one. If someone else holds it, say who and stop; take it over with `force: true` only if the
   user asks.
3. **Audit** exactly as the request says. The code is in this working tree. Do not edit any file of the project.
4. **Submit the full report:** `audit_queue` with `action: "submit"`, `id` and `report` (the report in Markdown). It
   must contain exactly one of these lines, alone on its line: `## Verdict: PASS`, `## Verdict: PASS WITH RESERVATIONS`
   or `## Verdict: FAIL`. If the tool lists problems, fix them and submit again. If you cannot finish, release it
   (`action: "release"`).
5. Tell the user: "Informe <id> listo: lo recoge la sesión que lo pidió."

## Without the MCP (only files)

1. **Find the request.** With an id, it is `.lagrange/auditorias/pedidos/<id>.md` or, for an older request,
   `.lagrange/agy/pedidos/<id>.md`, at the root of this project. Without an id, list the `*.md` in both folders whose
   frontmatter says `tipo: audit` and that have no `informes/<id>.md` next to them yet (in `.lagrange/auditorias/`,
   also skip the ones with a `tomados/<id>.json`, which another session is auditing). Use the one with the newest
   `creado`; if there were more, name their ids (FEAT-200). If there is none, say so and stop.
2. **Read the whole request** and follow its instructions. It carries the full process, the task and, in
   `pedidos/<id>/`, the git context (status, log, diffs). The code is in this working tree.
3. **Write the report** to the exact path in the request's `informe:` field, starting with the exact header
   `---` / `id: <id>` / `---`. The report MUST contain exactly one line `## Verdict: PASS`,
   `## Verdict: PASS WITH RESERVATIONS` or `## Verdict: FAIL`, alone on its line: Lagrange rejects it otherwise.
4. Do not edit any other file of the project. When done, tell the user: "Informe <id> listo: recogelo en la sesión
   que lo pidió."
