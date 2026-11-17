---
description: Architectural implementation plan from Antigravity - plan mode, asked not to change anything
---

Request an architectural and implementation plan from Google Antigravity CLI (`agy`):

Task:
$ARGUMENTS

Instructions:
1. Use the `lagrange_plan` tool with `effort: "high"` (or pass `request_id: "<id>"` and `wait_seconds: 0` when collecting an existing manual request).
2. If manual mode returns `pedido <id> listo`, show the `<id>` and `/lagrange-plan <id>` command and end the turn immediately without starting watchers, loops, or `wait_seconds > 0`.
3. Review the returned plan and present it clearly to the user.
4. Keep the `conversation_id` handy when running in auto mode so the user can easily execute the plan with `/lagrange/run` or `lagrange_run`.
