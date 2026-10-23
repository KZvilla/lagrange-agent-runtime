# Known Limitations

Trade-offs that are documented and accepted. If you find one of them is **worse** than described here, that is a
security report — see [SECURITY.md](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/SECURITY.md).

## Containment

- **On your machine, permissions are instructions.** `allow`, `deny`, `deny_paths`, `deny_commands` and
  `mode: "plan"` shape what the model does; they do not stop a model that ignores them. `agy_run`, fan-out
  subagents, `agy_research` and `agy_session_summary` run under that regime.
- **A git worktree does not confine writes.** `agy_fanout` uses one per subagent to avoid collisions; agy can still
  write to absolute paths outside it.
- **`sandbox: true` restricts the terminal only**, and on Windows it is harmful (ignores the working directory, asks
  for UAC, leaves a mount). Audits always force it off.
- **The `git status` check after a read-only call only sees that repository.** Gitignored paths, writes elsewhere
  and killed processes are invisible to it, and your own edits during the run show up too.
- **The container cannot run your tests.** It has no `node_modules` and a read-only disk: run the gates yourself
  before asking for an audit.

## Agents and tools

- **A read-only `cast_agent` still reaches every MCP server you configured.** Antigravity injects its MCP tools into
  every agent regardless of the tool allowlist. `read_only` removes the native write tools; it is not a sandbox
  against MCP.
- **An agent's thread identity is fixed when the thread is created.** Resuming a thread with a different agent is
  silently ignored by agy, so isolation-sensitive threads are always born with the right agent.

## Engines and fallback

- **The fallback only covers "agy cannot run".** A timeout, an invalid model or a cancellation fails as-is.
- **DeepSeek and OpenCode Go have no live streaming** for Souls: the reply arrives whole.
- **OpenCode Go read-only runs are one-shot**: no `conversation_id` to follow up.

## Platforms

- **macOS has no service manager for the bridge daemon.** Run `npm run bridge` in a terminal or write your own
  launchd unit; an untested unit would fail at boot with nobody watching.
- **On Linux, `systemd --user` needs linger** (`loginctl enable-linger`) or the daemon is gone after the next reboot.
- **Each plugin version installs into its own directory and old ones are not deleted.** Install the daemon from a
  clone, never from the plugin copy, or it stays pinned to an old version.

## Out of scope

- Anything that requires prior control of your user account: a local attacker with your privileges already has
  what Lagrange protects.
- Vulnerabilities in `agy`, Claude Code, Codex, OpenCode, Voicebox, Docker or Telegram themselves.
