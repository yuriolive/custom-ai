---
# ca-hy84
title: Integrate beans issue tracker and agent configuration
status: completed
type: task
priority: high
created_at: 2026-08-20T00:47:50Z
updated_at: 2026-08-20T00:54:48Z
---

Add hmans/beans as the work tracker for this repo and wire it into the agent surfaces (CLAUDE.md, AGENTS.md, .claude/settings.json hooks), then seed the open ROADMAP work as beans.

## Todo
- [x] `beans init` + repo-derived id prefix in `.beans.yml`
- [x] `.claude/settings.json` SessionStart + PreCompact hooks running `beans prime`
- [x] CLAUDE.md work-tracking section, layout entry, commands
- [x] AGENTS.md for non-Claude agents
- [x] `.beans/` path ownership in docs/CONTRACTS.md
- [x] Seed open ROADMAP items as milestones/epics/features
- [x] `npm run check` green

## Summary of Changes

- `.beans.yml` — prefix `ca-` (id_length 4). `beans init` had derived it from the
  directory name, which inside a git worktree is the branch name; every bean created
  from a worktree would have carried a different prefix.
- `.claude/settings.json` (new, committed) — `SessionStart` and `PreCompact` hooks run
  `beans prime`, so the tracker contract survives a compaction. `settings.local.json`
  is untouched.
- `CLAUDE.md` — new "Work tracking — beans, not todo lists" section right after the
  intro (prime-first instruction, command crib, install, alpha caveat, and the
  beans-vs-ROADMAP.md division of labour), `.beans/` added to the Layout block, and a
  `docs/ROADMAP.md` row added to the docs table.
- `AGENTS.md` (new) — entry point for non-Claude agents: prime first, then read
  CLAUDE.md as its body, then `npm run check` / `npm test` / pgTAP before claiming done.
- `docs/CONTRACTS.md` — one line in the ownership block: `.beans/` is the single
  shared, everyone-writes path.
- `.prettierignore` — `.beans/` excluded; prettier would reflow bean bodies and the next
  `beans update` would write them back.
- Seeded 24 beans from `docs/ROADMAP.md`: 4 milestones (P0–P3), the Creator Studio epic
  with 5 features, the design epic, and the P1/P2/P3 items. Sequencing from the
  roadmap's "suggested order" is encoded as `blocked-by`: operator settings → populate
  production → Creator Studio → design. Shipped work (Stripe top-up, FR-TOOL-001…006)
  was not seeded; only its remaining slice was.

Verified: `beans check` passes, `beans list --ready` shows operator settings as the one
startable P0 task, `beans roadmap` renders, `npm run check` green. `CLAUDE.md` still
fails `prettier --check` — it did before this change too (the repo has never been
formatted; that is P3 bean `ca-jlxz`).
