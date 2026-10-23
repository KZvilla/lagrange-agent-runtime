# Decisions

Architecture Decision Records: one page per decision that shapes the code, with the context that forced it and
what it costs. They explain **why**; [[Isolation and Security Model]] and [[Engines and Fallback]] explain
**what**.

| ADR | Decision | Origin |
|---|---|---|
| [ADR-001: Contain, don't prohibit](ADR-001-Contain-dont-prohibit) | Read-only work runs in a container; prompt guardrails are hygiene, not a boundary | SEC-020, FEAT-061 |
| [ADR-002: Isolation is verified, not assumed](ADR-002-Isolation-is-verified-not-assumed) | No "no tools" profile is trusted without a live probe for the installed CLI version | SEC-018, SEC-019 |
| [ADR-003: agy first, opt-in fallback](ADR-003-agy-first-opt-in-fallback) | Antigravity is the main engine; other engines are per-role choices or an opt-in fallback | FEAT-071/072, FEAT-097, FEAT-166/168, FEAT-173/175/176 |
| [ADR-004: The marketplace is the only channel](ADR-004-The-marketplace-is-the-only-channel) | Install and update only through the marketplace, pinned to the tag's commit | Marketplace distribution, BE-024 |

More records will be added as the wiki grows (the node network, Souls' memory, mediated tools, provenance).
