---
description: Heavyweight evidence-based audit - code against its plan, or a plan against the repo
---

Adversarial audit, through Lagrange:

What was given (may be empty - see step 1):
$ARGUMENTS

Instructions:
1. Decide what the argument is:
   - **A 6-hex request id** (e.g. `a1b2c3`) -> step 2.
   - **"pendientes"** (or "pending") -> call `lagrange_audit_queue` with `action: "list"` and show the table. If the user
     asked for the requests they made, pass `que: "mios"`. End there.
   - **Anything else, or nothing** -> a new audit, step 3.
2. **A request id: the role comes from the request, not from a keyword.** Call `lagrange_audit_queue` with
   `action: "collect"`, the `id` and `wait_seconds: 0`:
   - **Report ready** -> present it (step 5).
   - **Pending and yours** -> show the id and how to run it, and end the turn (no watchers, no waiting).
   - **Pending and it is someone else's** (the result says "No es tuyo") -> this session audits it: `action: "take"` with
     the `id`, follow the returned request step by step (it carries the full adversarial process; use the
     adversarial-review skill), do not edit any file, then `action: "submit"` with the whole report. If `entregar`
     lists format problems, fix them and deliver again. If you cannot finish, `action: "release"`. Tell the user the
     report is ready for the session that asked.
   - **A legacy agy request** (the result points to `/lagrange-audit <id>`): collect it with `lagrange_audit` and
     `request_id: "<id>"`, `wait_seconds: 0`, as before.
3. **A new audit.** Determine the mode and the target:
   - Code changes to verify against a plan/spec -> `audit_mode: "implementation"`, with the diff or file paths as
     `target`. If nothing was given, default `target` to `git diff HEAD~1`. Pass the plan/spec/ticket/acceptance
     criteria as `plan`; if the user did not supply one, look for it (linked ticket, RFC, commit message, PR
     description) before falling back.
   - A plan/RFC to evaluate against the existing codebase -> `audit_mode: "plan"`, with the **plan text itself** as
     `target`. There is no sensible default: if the user asked for a plan audit without giving a plan, ask for it.
   - If unclear, default to `"implementation"`.
4. **Where it runs depends on the mode and on what the user named:**
   - The user named a programmatic provider (`opencode-go`, `deepseek`) -> `lagrange_audit` with that `engine`:
     it runs on its own in any mode.
   - Otherwise call `lagrange_audit_queue` with `action: "request"`, the mode, `target` and `plan`. In manual mode it
     writes the request to the queue and returns its id: show the id and how to run it in each harness, and **end the
     turn immediately** - no background watchers, no sleep loops, no `wait_seconds > 0`. Collect later with
     `action: "collect"` (or, for a legacy agy request, `lagrange_audit` with `request_id: "<id>"`).
   - If `pedir` answers that agy_modo is "auto", the audit is programmatic: use `lagrange_audit` with
     `effort: "high"`.
5. When presenting a ready report, show the full structured audit: Verdict, Findings (BLOCKER/MAJOR/MINOR/NOTE),
   Coverage Table, Validation, and Over-engineering, with the verdict prominently at the top, and who audited it.
