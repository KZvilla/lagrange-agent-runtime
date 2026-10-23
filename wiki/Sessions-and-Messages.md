# Sessions and Messages

Two Claude Code sessions on the same machine — two terminals, two projects — can talk through the Telegram daemon.
The daemon keeps the open sessions and one mailbox per session.

## Messages

```
mensaje accion:"agentes"                                   # open sessions; this one marked
mensaje accion:"enviar" para:"tests-bridge" texto:"…"      # delivered now, or an error now
mensaje accion:"enviar" para:"." texto:"…" esperar:300     # wait up to 5 minutes for the reply
mensaje accion:"leer"                                      # what others sent, 3 at a time
mensaje accion:"responder" id:"m_…" texto:"…"
mensaje accion:"nombre" nombre:"tests-bridge"
mensaje accion:"silenciar" si:true
```

- **How the other session finds out.** Plugin hooks tell it it has mail when it finishes a turn, when you type, and,
  if it is idle, wake it with an `asyncRewake` hook. The hooks only say *who* wrote; the text is read with
  `mensaje leer` and arrives marked as a message from another agent, not from you.
- **Pre-approve the tool.** A session woken while you are away needs to call `mensaje` without a prompt. Add
  `mcp__plugin_lagrange_lagrange__mensaje` to `permissions.allow`, or answer *don't ask again* the first time.
- **It is not you.** The receiver treats it as a colleague's request and asks you before anything destructive,
  outside its project, or that you did not ask for. Its own permission mode still applies.
- **Brakes.** Ten back-and-forths between agents stop and ask you; a session can send 30 messages an hour. Texts are
  capped at 8 KB and secrets are redacted.
- **Needs the daemon** (`npm run bridge:daemon:start`). Codex sessions can send and read, but are not notified.
- **Across nodes.** `agentes` lists every session as `<node>/<name>`; `para:"casa-wsl/tests-bridge"` reaches another
  node through the server. A message from another node is accepted only where `BRIDGE_NODO_PERMITE=ejecutar` on
  the receiver and the server, because it makes that session act with its own permissions. There is no queue: a
  disconnected node or a missing session is an error right away. See [[Node Network]].
- **The server's voice.** A node without Voicebox that runs `say` or `narrate` with Telegram sends the final text to
  the server, which synthesizes and delivers the voice note, one at a time. Without a `voice`, the server uses its
  own setup or the documented default for the language. A node that reaches Voicebox on another machine downloads
  the audio over HTTP. The console's *Sesiones* view lists agents, never messages.

## Recall

Claude Code keeps automatic memory per account (`<account>/projects/<project>/memory/`). With a second account on
the same machine, what one learned about a project is invisible to the other. `recall` reads across:

```
recall                                            # accounts with memory for this project
recall desde:"work"                               # that account's MEMORY.md and notes, up to 40 KB
recall desde:"principal" archivos:["x.md"]        # only those notes
```

- **Read-only.** It never writes to any account. The `recall` skill tells the agent how to keep what is useful:
  compare with its own memory, verify against the code, save adapted notes with their origin, never copy in bulk.
- **Explicit source.** `principal` is the default Claude folder; other accounts come from `motores.cuentas`.
  Nothing is read unless you name it.
- **Data, not instructions.** Each note is wrapped as `<nota archivo="…" modificada="…">`, with the file's last
  write in UTC, and the output says it comes from another account.
- **Confined.** Only regular `.md` files inside that `memory/` folder are read; symlinks and junctions are skipped.
- **Same machine only.** A worktree has its own memory; pass the main clone as `cwd`.
- **Second account setup** is Track F of `/lagrange:setup cuenta`: links for `agents/`, `skills/` and `commands/`,
  `settings.json` copied without credentials, and the login left to you. See [[Engines and Fallback]] for
  `motores.cuentas`.

Parameters are in the [Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#mcp-tools-reference).
