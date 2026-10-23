# ADR-004: The marketplace is the only channel

**Status:** Accepted (scripts retired in v0.6.0) · **Origin:** marketplace distribution plan, BE-024 (canonical
repository metadata)

## Context

Lagrange used to install by piping a remote script into the shell. `install.ps1` / `install.sh` cloned the
repository into `~/.claude/skills/antigravity` and updated it with `git fetch` + `git reset --hard origin/main`.
That meant:

- local changes were overwritten without warning;
- there was no version to point at — you ran whatever `main` was at that moment;
- no enable/disable, no user vs. project scope, no managed uninstall.

## Decision

- Distribute **only** through the Claude Code plugin marketplace (and the Codex equivalent).
- **Pin every release to the commit of its tag** in `.claude-plugin/marketplace.json`, as the official marketplace
  does. The pin is written by `npm run release:stamp`, never by hand, and `release:check` verifies it on every gate
  run — a stale pin would publish the previous version without any error.
- Retire the install scripts once the marketplace had carried several releases and clean updates; keep the
  uninstall instructions, rewritten as a migration guide.
- Rename the marketplace to `kzvilla-lagrange` so the command a user types names the project, not Google's product.

## Consequences

- Users get real versions, managed updates and no surprise overwrites.
- Releasing has a strict order (bump, tag the bump commit, stamp, commit the stamp), documented in [[Contributing]].
  Re-tagging a merge commit breaks the pin.
- Each version installs into its own directory and **old ones are kept**. Anything that stores an absolute path —
  the bridge daemon's scheduled task or systemd unit — must be installed from a clone, or it stays on the old
  version silently. The daemon installer refuses to run from a plugin copy for this reason.
- The cache grows by one copy per release; nothing purges it.
