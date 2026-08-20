---
# ca-alos
title: Docs carry commands that do not run and test counts that do not match
status: completed
type: task
priority: normal
created_at: 2026-08-20T01:39:51Z
updated_at: 2026-08-20T01:52:01Z
---

Audit every runnable command and hard-coded number across the docs; fix what is wrong, replace numbers that will go stale with the command that produces them.

## Todo
- [x] Grep every doc + CI workflow for runnable commands and hard-coded numbers
- [x] Run each locally runnable command before calling it right or wrong
- [x] Fix the wrong commands
- [x] Fix or de-freeze the stale counts
- [x] `npm run check` + `npm test` green
- [x] Report what could not be verified, and why

## Summary of Changes

Every command in `docs/`, `tools/modal/README.md` and `.github/workflows/*.yml` was
executed before being called right or wrong, with `.github/workflows/ci.yml` as the
authority on what CI actually runs. Eight lines were wrong across six files.

**Stale counts, de-frozen.** `docs/ROADMAP.md` said "263 node tests + 129 pgTAP + 41
python". Measured on this branch: node is 336 (335 pass, 1 skipped) across 6 test groups,
python is 48, and pgTAP is 201 — every one of the three was wrong. The roadmap line no
longer carries numbers at all; it names the four CI jobs and the three commands that
produce the counts, because that line has now gone stale twice.

**Point-in-time records got new numbers, not deleted ones.** `docs/HANDOFF.md` is
explicitly the measured-facts doc, so its `**Tests:**` line was updated in place
(253/129/41 -> 336/201/48) with the measurement date and the note that the pgTAP figure
is the sum of the `plan()` declarations rather than a Docker run.

**`npm run check` was described as four `tsc` projects.** It is six (`app`, `hf-probe`,
`mock-upstream`, `gateway`, `keygen`, `anthropic-adapter`), and it also runs `check:env`
and `check:migrations`, which the description omitted. Fixed in `docs/DESIGN.md` §5's
checklist without freezing a new count.

**`tools/modal/README.md` claimed `test_measure.py` has 41 tests.** It has 42; the count
is dropped rather than re-frozen, since the command two sections down prints it. The same
file told its reader that `docs/CONTRACTS.md` §Environment "does not yet list" `MODAL_KEY`
/ `MODAL_SECRET` and that its owner should add them — the frozen contract lists both, so
the instruction was a no-op pointing at work already done. Removed.

**`.github/workflows/ci.yml` said `db reset` applies "all 21 migrations".** There are 32.
The comment now names `supabase/migrations` instead of counting it. The same file's
`pgtap (201 billing invariants)` job name was checked and is *correct* — it was the docs
that disagreed with it. Its "It had 41 tests that CI never ran" is deliberately left: it
is past tense about why the job was added, not a claim about today.

**`docs/DEPLOY.md` had two sections numbered 5** ("Stripe — wallet top-up" and
"Post-deploy verification"), and `docs/ROADMAP.md` pointed at "the `DEPLOY.md` §5
verification" — a reference that could not resolve. Renumbered the second to §6 and
followed the reference.

### Verified working, no change needed

`node tools/keygen/cli.ts create --user <h> --name <n> --i-know-this-is-production` (all
three flags exist), `python tools/modal/deploy.py --dry-run` and `--pin-tier l4 --parallel
1`, bare `python -m unittest test_measure|test_tier_drift` from `tools/modal` (system
Python 3.13.5 satisfies `requires-python >=3.13`, and the project has no runtime deps),
every `npm run *` invocation in the docs, `git merge mvp-0-foundation` (the branch still
exists locally and on the remote), and the README's GPU ladder table, which matches
`tiers.py` on VRAM, bandwidth and price for all four rows.

Flag shapes confirmed via `--help` for the commands that need credentials or Docker to
actually run: `modal billing rates --json`, `modal workspace proxy-tokens
create|list|delete`, `modal app stop|list`, `vercel project protection`, `npx supabase
secrets set --project-ref`, `npx supabase start -x`, `npx supabase db reset --local`,
`npx supabase test db --local`, `stripe listen --forward-to`, `stripe trigger --add`.

### Not verified

The pgTAP total of 201 is the sum of the seven `plan()` declarations (4+14+25+39+31+41+47),
not a run — that needs Docker and `npx supabase start`. Nothing credentialed was executed:
no `modal deploy`, no `sync_rates.py --check`, no live `measure.py`, no Stripe or Vercel
mutation, and none of the `DEPLOY.md` curl verifications against the deployed gateway.

### Reported, not fixed

`CLAUDE.md` and `AGENTS.md` both describe `npm run check` as "check:env + lint + typecheck
across all 5 tsconfigs" — wrong on both halves (six tsconfigs, and `check:migrations` is
missing). Left alone deliberately: those two files are the surface of the open PR #21,
which already carries the `uv run pytest` fix, and editing the same region here would
conflict. Worth folding into that PR.

`docs/CONTRACTS.md` is frozen and its commands and counts are all correct. Its
`## Directory layout & file ownership` block does not list `packages/anthropic-adapter`,
`tools/keygen`, `tools/modal`, `lib/` or `.beans/` — reported to its owner, not edited.
