---
description: Heavyweight evidence-based audit — code against its plan, or a plan against the repo
argument-hint: [target to audit, e.g. "git diff HEAD~3" or a plan/spec text]
---

Run a deep adversarial audit from Google Antigravity CLI (`agy`):

What to audit (may be empty — see step 1 for how to default):
$ARGUMENTS

Instructions:
1. Determine the audit mode, and what `target` to pass:
   - Code changes to verify against a plan/spec → `audit_mode: "implementation"`, with the diff
     or file paths as `target`. If nothing was given, default `target` to `git diff HEAD~1`.
   - A plan/RFC to evaluate against the existing codebase → `audit_mode: "plan"`, and pass the
     **plan text itself** as `target`. There is no sensible default here: if the user asked for a
     plan audit without giving you a plan, ask them for it rather than auditing a git diff.
   - If unclear, default to `audit_mode: "implementation"`.
2. In `"implementation"` mode, pass the plan/spec/ticket/acceptance criteria as the `plan`
   argument. Without it the audit has nothing to check the code against and will have to infer
   the requirements, which it reports as a review limitation. If the user did not supply a plan,
   look for one (linked ticket, RFC, commit message, PR description) before falling back.
3. Use the `mcp__lagrange__agy_audit` tool with `effort: "high"` (unless the user asked to collect an existing manual request by 6-hex `<id>`, in which case pass `pedido: "<id>"` and `esperar_segundos: 0`).
4. If manual mode returns `pedido <id> listo`, show the `<id>` and `/lagrange-audit <id>` command and end the turn immediately without starting background watchers, sleep loops, or `esperar_segundos > 0`.
5. When collecting a ready report, present the full structured audit report: Verdict, Findings (BLOCKER/MAJOR/MINOR/NOTE), Coverage Table, Validation, and Over-engineering sections, highlighting the verdict prominently at the top.
