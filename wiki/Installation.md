# Installation

## Requirements

| | |
|---|---|
| **Antigravity CLI** | `agy` on your `PATH`, logged in (`agy auth login`) |
| **Node.js** | ≥ 18 for the MCP tools; ≥ 20.12 if you run the Telegram bridge |
| **Claude Code** or **Codex** | The host that loads the plugin |
| **Docker** *(optional, recommended)* | Needed for the read-only container and confined batches — see [[Isolation and Security Model]] |

## Claude Code

Inside a session:

```text
/plugin marketplace add KZvilla/lagrange-agent-runtime
/plugin install lagrange@kzvilla-lagrange
```

or from a terminal with `claude plugin marketplace add …` / `claude plugin install …`.

**Then restart Claude Code.** `/reload-plugins` picks up commands, agents and skills, but whether it re-registers
the MCP server has changed across Claude Code versions. Restarting is the reliable way to make `agy_run` and the
other tools appear. Check with:

```bash
claude plugin list
claude plugin details lagrange@kzvilla-lagrange
```

## Updating

```bash
claude plugin marketplace update kzvilla-lagrange
claude plugin update lagrange@kzvilla-lagrange
```

Restart the sessions you had open afterwards: a running session keeps the code it started with.

Every release is **pinned to the commit of its tag** in the marketplace manifest, so you always install exactly
what was tagged — never whatever happens to be on `main`. Each version installs into its own directory and old
ones are not deleted; that is why anything that stores an absolute path (the bridge daemon, for example) must be
installed from a clone, not from the plugin copy. See [[ADR-004: The marketplace is the only channel|ADR-004-The-marketplace-is-the-only-channel]].

## Codex

```bash
codex plugin marketplace add KZvilla/lagrange-agent-runtime --ref <release-tag>
codex plugin add lagrange@kzvilla-lagrange-codex
```

Start a new thread afterwards. Codex gets the skills and MCP tools; the `/lagrange:*` slash commands are Claude
Code only. State is shared under `~/.claude/` so both hosts see the same configuration and agent memory.

## Migrating from the old install scripts

`install.ps1` and `install.sh` were removed in 0.6.0. If you used them, remove `~/.claude/skills/antigravity`
(after saving the `.env` inside it, if any) — otherwise the plugin loads twice. The README has
[ready-made snippets](https://github.com/KZvilla/lagrange-agent-runtime#migrating-from-a-script-install).

## Optional pieces

`/lagrange:setup` walks you through each one and never asks for a secret in the chat:

| Track | What it sets up |
|---|---|
| `voicebox` | Local text-to-speech for narration |
| `telegram` | Notifications, questions and voice notes to your phone (you create the `.env` yourself) |
| `daemon` | The bidirectional Telegram bot as a background service (Windows Task Scheduler / `systemd --user`) |
| `cuenta` | A second Claude account for the fallback — see [[Engines and Fallback]] |
