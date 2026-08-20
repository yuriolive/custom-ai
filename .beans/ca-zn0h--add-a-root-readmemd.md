---
# ca-zn0h
title: Add a root README.md
status: completed
type: task
priority: normal
created_at: 2026-08-20T01:04:30Z
updated_at: 2026-08-20T01:10:31Z
---

The repo has no README. CLAUDE.md and AGENTS.md are agent-facing; a human landing on the repo gets nothing.

## Todo
- [x] Consumer quickstart (stock openai SDK, model-id form, cold start)
- [x] Honest status: MVP-0 deployed, production empty
- [x] Local dev with UPSTREAM_PROVIDER=mock (no GPU spend)
- [x] Commands, layout, docs index, beans pointer, deploy topology
- [x] No invented commands; no unverified URLs

## Summary of Changes

`README.md` (new): what this is, the consumer quickstart lifted from the frozen
contract, honest status (deployed but unpopulated), local dev against
`UPSTREAM_PROVIDER=mock`, commands, layout, docs index, the beans pointer, and the
three-host deploy table. The gateway origin is left as `<gateway>` — the same placeholder
`docs/CONTRACTS.md` uses — rather than guessing a public URL.

Every command in it was executed before it was written. Two corrections fell out of that:

- **`uv run pytest` never worked.** `tools/modal/pyproject.toml` declares no runtime deps
  and its `dev` group is `ruff` only; pytest is not installed, so the documented command
  fails with "program not found". The suite is stdlib `unittest`, and CI runs
  `uv run --locked python -m unittest test_measure test_tier_drift` — 48 tests, passing.
  Fixed in `CLAUDE.md` and `AGENTS.md` (which had inherited the wrong command from it).
- **Test counts were stale.** `docs/ROADMAP.md` says 263 node tests; the suite now runs
  316 (1 skipped), the anthropic-adapter's 53 having landed since. README states the
  measured numbers; the roadmap line was left alone as narrative.
