---
description: Adversarial code review of a diff, a commit range, or specific files
argument-hint: [optional review target, default: git diff]
---

Request an adversarial code review from Google Antigravity CLI (`agy`):

Target to review (may be empty — if so, default to `git diff HEAD~1`):
$ARGUMENTS

Instructions:
1. Run `git status` or check current diff if needed to gather context.
2. Use the `mcp__lagrange__agy_review` tool with `effort: "high"` (or pass `pedido: "<id>"` and `esperar_segundos: 0` when collecting an existing manual request).
3. If manual mode returns `pedido <id> listo`, show the `<id>` and `/lagrange-review <id>` command and end the turn immediately without starting watchers, loops, or `esperar_segundos > 0`.
4. When the report arrives, present the review findings categorized by severity: Critical, Warnings, Suggestions.
