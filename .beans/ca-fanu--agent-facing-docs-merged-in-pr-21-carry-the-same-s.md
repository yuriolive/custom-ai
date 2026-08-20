---
# ca-fanu
title: Agent-facing docs merged in PR 21 carry the same stale counts and a wrong build claim
status: completed
type: task
priority: normal
created_at: 2026-08-20T01:57:11Z
updated_at: 2026-08-20T02:02:43Z
---

PR #21 landed README.md and AGENTS.md on main. Both repeat the six-tsconfig error and the node test count, and README.md claims `npm run build` runs check:env, which it does not.

## Todo
- [x] Re-measure `npm test` on main (PR #18 landed after the last count)
- [x] Confirm whether `npm run build` runs `check:env`
- [x] Verify the rest of README.md's commands actually run
- [x] Fix CLAUDE.md, AGENTS.md, README.md
- [x] `npm run check` + `npm test` green

## Summary of Changes

PR #21 merged, putting `README.md` and `AGENTS.md` on main. Both inherited the wrong
`npm run check` description from `CLAUDE.md`, and the README's freshly-measured test count
was already stale.

**`npm run check` was wrong in all three files, on both halves.** It was described as
"check:env + lint + typecheck across all 5 tsconfigs". The script is
`check:env && check:migrations && lint && typecheck`, and `typecheck` covers six projects
(`app`, `hf-probe`, `mock-upstream`, `gateway`, `keygen`, `anthropic-adapter`) — verified by
running it and counting the `tsc` invocations. `check:migrations` was missing from the
description entirely, which matters: it is the guard against two migration files colliding
on a numeric prefix, the failure that has already turned CI red twice. The tsconfig count is
now unstated rather than re-frozen at six.

**`npm run build` does not run `check:env`,** which the README claimed. `build` is
`next build` and nothing else — no `prebuild` hook, and `next.config.ts` does not invoke
`lib/scripts/check-env.mjs`. Grepped every reference: only `npm run check` and CI's own
separate step call it. The script that does check first is `build:local`
(`npm run check && next build`), which the README did not mention. Both corrected.

**The README's node count was stale one day after it was written.** It said 316; `npm test`
on main runs 336 (335 pass, 1 skipped). Its Python figure of 48 was correct. Rather than
write 336 and watch it rot a third time, that sentence now names the four CI jobs and points
at the Commands section below it, which already carries the commands that produce the counts.

### Verified working, no change needed

`npm start -w @custom-ai/mock-upstream` (the workspace script exists, and `cli.ts` defaults
to host `127.0.0.1` port `8787`, exactly as the comment says), `npm ci`,
`cp .env.example .env.local`, `npx supabase start`, `npx supabase db reset --local`,
`npx supabase test db --local supabase/tests`, `cd tools/modal && uv run --locked python -m
unittest test_measure test_tier_drift` (the fix from #21, now correct in every file),
`beans list --ready` and `beans tui`, `engines.node >= 22.18`, and the seeded model id in the
Python snippet, which matches `supabase/seed.sql`.

### Not verified

`brew install hmans/beans/beans` — no Homebrew on this machine. The `go install` alternative
beside it is what was actually used. The README's "~100 s" cold-start budget is left alone:
`docs/HANDOFF.md` measures 115 s first-ever and 23 s with the weights volume warm, so a
round number in advice about client timeouts is fair rather than wrong.

`CLAUDE.md` fails `prettier --check` on main already (an unformatted table and `*state*` vs
`_state_`), independent of this change. Not fixed here — the repo-wide format pass is its own
tracked item, and doing it inside this diff would bury it.
