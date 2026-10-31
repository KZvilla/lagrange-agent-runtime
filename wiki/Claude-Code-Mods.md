# Claude Code Mods

On Claude Code builds with mods, Lagrange loads one module (`hooks/hooks.json` → `"modules"`). Older builds and
other hosts keep the command hooks; Codex never sees the module.

- **Mailbox notice (FEAT-100).** New `mensaje` messages wake an idle session with a plugin prompt instead of a
  blocked Stop. Only the notice; the text still comes through the `mensaje` tool. See [[Sessions and Messages]].
- **Panel (FEAT-101).** `/lagrange-panel` opens a side panel with the running fan-out, quota used and the Lagrange
  version in each account. While a fan-out runs, its line shows in the status line unless your status line already
  runs `fanout-statusline.js`.
- **Network in the panel (FEAT-121).** A **Red** section shows this daemon (name, role, version), each node it knows
  with its connection and the version its daemon reports, and what each lane is running or queueing. It reads
  `GET /red` on the local link with the same token as `mensaje`; names, versions and counts only, no hosts or ids.
  A toast tells you once when a node drops, comes back, runs another version, or the daemon stops answering —
  20 s after the session starts and every 5 minutes, panel open or not.
- **Background toasts (FEAT-135).** A toast when something finishes or changes while you look elsewhere: a fan-out
  in this repo or a confined batch from any session, an exhausted quota window that freed up, this account crossing
  90 % of its 5-hour window (once per window), and a new message. What the current session is waiting on is not
  announced; it arrives as the tool result. No toast on start or after a mod reload. Batches and quota are checked
  every minute through `panel.js avisos`, which returns ids, states and counts only. Pick the kinds with
  `set_config background_toasts` (`all`, `none`, or a list of `fanout`, `lotes`, `cuota`, `mensajes`).
- **What could run on Haiku 5.5 (FEAT-117, measurement only).** The mod classifies every model request — a
  main-loop step that only chains read-only tools, any other main-loop step, or a subagent step by type — and adds
  up steps, tokens, cache reads and models across sessions. `/lagrange-haiku` shows the table and the share of
  tokens that would be candidates; nothing is rerouted. Prompt caching is per model, so switching mid-turn rereads
  the context uncached. The `agy` subagent itself runs on Haiku because it only relays to agy's tools.
- **Claude Code in the Providers view (FEAT-137).** The web console's *Proveedores* tab shows the Claude Code
  version Lagrange runs, the latest release with the notes in between, and `claude update` to copy. Lagrange never
  runs Claude's updater. The card also shows the version the confined-batch image pins and whether each account's
  batch probes are current.
- **Summary with full context (FEAT-103).** `/lagrange-resumen [full|decisions|changes|debugging|handoff]` first
  shows how much context it would reread; `/lagrange-resumen <focus> si` runs it with `$.model.fork` (the session's
  own model and prompt cache) and saves the document to `~/.claude/session-summaries/<date>-<id>-fork.md`. Only the
  path and token cost come back. It rereads the whole conversation, so in long sessions `agy_session_summary` is
  cheaper. See [[Session Summary and Usage]].
- **Resume from a handoff (FEAT-182).** In a session with no turns yet, after `/clear` or a relaunch, the band offers
  the project's newest handoff from the last 7 days: `[s]` resume, `[p]` copy, `[x]` not now. `[s]` sends a short
  prompt with the path and the agent reads the document with `Read`, so it arrives as tool output rather than as your
  words. `[s]` and `[x]` remember that handoff per account (`handoff-visto`) until the file changes; `[p]` does not.
  The band never clears the session for you. Nothing is offered in sessions with turns, in `-p`, VS Code or mobile.
  The "Handoff saved" row now stays 5 minutes, with `[p]` and `[x]`, unless a new context threshold replaces it.
- **Guards (FEAT-102).** Rules in `~/.claude/antigravity.json` that stop a `Bash` or `PowerShell` command from
  Claude and tell the model why:

  ```json
  "guardas": [
    { "secuencia": ["git", "switch", "main"], "motivo": "the daemon runs from this checkout",
      "vence": "2026-10-09T05:37:00Z", "raiz": "C:/work/my-project" },
    { "secuencia": ["stop-process", "*", "node"], "motivo": "kills the daemon and the Lagrange MCP servers" }
  ]
  ```

  `secuencia` is 1–8 whole words that must appear together, case-insensitive, after quotes and backslashes are
  dropped; `*` stands for any words in between. No regular expressions. `vence` turns the rule off at that time;
  `raiz` limits it to one project folder. The file is reread every 10 s.

  It is a good-faith brake, not a barrier: an obfuscated command (variables, base64, a script file) can slip past.
  It only sees Claude's `Bash` and `PowerShell`, not what agy runs (SEC-020), and it adds to `permissions.deny`,
  which does not see inside `bash -c "…"`. The file is global, so a rule applies to every account that opens that
  folder. Lagrange ships no rules.
