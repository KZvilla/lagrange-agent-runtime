---
name: lagrange-audit
description: Runs a Lagrange audit request (an adversarial audit) left in .lagrange/agy/pedidos/ of this project and writes the report where Lagrange collects it. Use when the user runs /lagrange-audit, optionally with a 6-hex request id, or asks to run a Lagrange audit request.
---

# lagrange-audit

Lagrange (a Claude Code plugin) does not launch agy: when it needs an adversarial audit it writes a request file and the user
runs it here, in their own agy session.

1. **Find the request.** With an id (6 hex characters, e.g. `a1b2c3`), the request is
   `.lagrange/agy/pedidos/<id>.md` at the root of this project. Without an id, list
   `.lagrange/agy/pedidos/*.md` whose frontmatter says `tipo: audit` and that have no
   `.lagrange/agy/informes/<id>.md` yet: if there is exactly one, use it; if there are several, show them (id,
   `creado`, `rama`) and ask which one; if there is none, say so and stop.
2. **Read the whole request** and follow its instructions. It carries the full process, the task and, in
   `.lagrange/agy/pedidos/<id>/`, the git context (status, log, diffs). The code is in this working tree.
3. **Write the report** to the exact path in the request's `informe:` field, starting with the exact header the
   request gives (`---
id: <id>
---`). The report MUST contain exactly one of these lines: `## Verdict: PASS`, `## Verdict: PASS WITH RESERVATIONS` or `## Verdict: FAIL`, alone on its line: Lagrange rejects it otherwise.
4. Do not edit any other file of the project. When done, tell the user: "Informe <id> listo: recogelo en Claude Code."
