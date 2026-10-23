# Contributing

## Ground rules

- **Never work on `main`.** Branch first, open a pull request.
- **Zero runtime dependencies** in the MCP server. The bridge has a few; adding one needs a reason.
- **Tests are dependency-free** and drive the real MCP server over stdio with `agy` stubbed out, so they assert on
  the exact command that *would* run — no tokens, no network.

## The gates

Run them all with:

```bash
npm run gates          # every gate
npm run gates:quick    # skips the bridge suite
```

| Gate | What it checks |
|---|---|
| `unit (narrate)` | Narration unit suite |
| `npm test` | Every `test/*.test.js` suite |
| `release:check` | The marketplace pins exactly the commit of the version's tag |
| `test:mcp` | The MCP server answers over stdio |
| `bridge:test` | The Telegram bridge suite |
| `validate` | `claude plugin validate` on the marketplace and the plugin manifest |
| `test:mod` | The Claude Code mods' TypeScript tests |
| `grafo:check` | The web console's graph island: types, tests and a byte-for-byte reproducible build |

`gates` runs each gate as its own process and reads its own exit code. **Never verify a gate through a pipe**:
`node test/x.test.js | tail -5` reports the exit code of `tail`, so a red suite looks green.

The README and `REFERENCE.md` are gated too: a test compares the reference's tools table, parameter tables,
commands and skills against the code, and both indexes against GitHub's anchors. If you add a tool, a parameter or a
command, document it in `REFERENCE.md` or `npm test` fails.

## The wiki

The wiki is versioned in `wiki/` in the repo: **edit it there, by pull request**. After the change is merged to
`main`, publish it with `npm run wiki:publish` (run it with `-- --simular` first). The GitHub wiki is an output:
editing it in the browser is detected and aborts the next publish. Pages use GitHub wiki-style links; the
repo view shows them literally, the published wiki renders them.

## How changes are made

Non-trivial work follows **plan → audit of the plan → implementation on a branch → audit of the implementation →
pull request**. The audits are adversarial (`/lagrange:audit`) and run in the read-only container; a FAIL is fixed
before moving on, not argued with.

## Item IDs

Every planned change gets an ID:

| Prefix | For |
|---|---|
| `SEC-XXX` | Security findings and hardening |
| `BE-XXX` | Bugs, stability and engineering debt |
| `FEAT-XXX` | New features and capabilities |

Priorities: **P0** (security breach, secret leak, crash without recovery), **P1** (data loss, orphaned processes,
broken primary flow), **P2** (edge-case races, state leaks), **P3** (cosmetic, minor DX).

Each item records: category, priority, affected files, problem and root cause, impact, proposed solution,
verification criteria, and a status — `Proposed`, `In Progress`, `Resolved`, `Mitigated` or `Deferred`. Commit
messages and code comments cite the ID (`fix(BE-156): …`), which is how a decision is traced back.

## Releasing

Releases are pinned by commit, so the order matters:

1. Bump the version in **five** places: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
   (`metadata.version` and the plugin entry), and `.codex-plugin/plugin.json`. A test fails if they disagree.
2. Commit the change and the bump.
3. Tag **that** commit: `git tag -a vX.Y.Z -m "…"`.
4. `npm run release:stamp` writes the tag's commit into `marketplace.json`; commit it.
5. `npm run gates` (includes `release:check`).
6. `git push --follow-tags origin main`.

**Never re-tag the merge commit.** The pin is written before the stamp commit exists, so the tag can never be the
branch tip; moving it breaks `release:check` on a clean `main`. Releasing from a `release/vX.Y.Z` branch is fine:
the bump commit stays reachable after the merge.
