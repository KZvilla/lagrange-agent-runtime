# Known Limitations

Trade-offs that are documented and accepted. If you find one of them is **worse** than described here, that is a
security report - see [SECURITY.md](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/SECURITY.md).

For known technical debt and deliberately deferred work, see [[Technical Debt]].

## Containment

- **On your machine, permissions are instructions.** `allow`, `deny`, `deny_paths`, `deny_commands` and
  `mode: "plan"` shape what the model does; they do not stop a model that ignores them. `agy_run`, fan-out
  subagents, `agy_research` and `agy_session_summary` run under that regime.
- **`agy_run` rejects `dangerously_skip_permissions: false`.** Without skip agy still does not gate
  `write_to_file`/`replace_file_content`, and the JSON output cannot report denials. For a tool-limited run, use
  `agent` with an installed read-only agent (for example `lagrange-plan`, when present) or `cast_agent`.
- **A git worktree does not confine writes.** `agy_fanout` uses one per subagent to avoid collisions; agy can still
  write to absolute paths outside it.
- **`sandbox: true` restricts the terminal only**, and on Windows it is harmful (ignores the working directory, asks
  for UAC, leaves a mount). Audits always force it off.
- **The `git status` check after a read-only call only sees that repository.** Gitignored paths, writes elsewhere
  and killed processes are invisible to it, and your own edits during the run show up too.
- **The container cannot run your tests.** It has no `node_modules` and a read-only disk: run the gates yourself
  before asking for an audit.
- **Guards and the damage preview are good-faith brakes.** In Claude Code they only see `Bash`/`PowerShell`; in
  opencode they only see the `shell` tool, not `agy_run` or MCP tools. Obfuscated commands (variables, base64, a
  script) can slip past, and a guard scoped to a project is evaluated against the session directory, not the shell
  tool's `workdir`.
- **The opencode damage preview does not see the shell tool's `workdir`.** Permission evaluation does not receive
  it, so a relative path such as `rm -r tracked-dir` under a different `workdir` can pass unmeasured; `ls-files`
  also runs from the session root, so an absolute path to another repository misses its tracked files. The guards
  without `raiz` still deny the forced variants (`rm -rf`, `Remove-Item -Recurse`, `git reset --hard`, …) in any
  `workdir`. Measuring the target's git `toplevel` was audited for FEAT-187 and left as debt: it only covers
  absolute paths and nested repositories, not the relative-`workdir` case.

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

## Voice and Telegram

- **The fan-out statusline is Claude Code-only.** It relies on Claude Code's `statusLine` contract.
- **`/run` and `/plan` are launched from Telegram only.** The web console shows them but cannot launch, cancel or
  retry them.
- **The console cannot answer `telegram_ask`.** Those questions still go to Telegram.
- **Voice needs a declared, available provider.** Without Voicebox, OmniVoice or a configured route, narration
  degrades to text with a reason (`setup_required`, `sample_missing`, `model_not_downloaded`,
  `provider_unavailable`). See [[Voice]].
- **The microphone loop needs Python dependencies** (`sounddevice`, `silero-vad`, `numpy`) and verifies its STT
  model before opening the device.

## Out of scope

- Anything that requires prior control of your user account: a local attacker with your privileges already has
  what Lagrange protects.
- Vulnerabilities in `agy`, Claude Code, Codex, OpenCode, Voicebox, Docker or Telegram themselves.
