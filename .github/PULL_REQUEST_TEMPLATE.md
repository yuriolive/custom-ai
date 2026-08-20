## What changed

<!-- What this does, and why. Link the bean(s) it closes: `.beans/ca-xxxx`. -->

## Checks

Run these locally — CI is the backstop, not the first run.

- [ ] `npm run check` — check:env, check:migrations, oxlint, eslint, typecheck across all 5 tsconfigs
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run format:check`

Conditional, by what the diff touches:

- [ ] `tools/modal/` — `cd tools/modal && uv run --locked python -m unittest test_measure test_tier_drift`
      plus `ruff check .` and `ruff format --check .` (stdlib `unittest`; pytest is not installed)
- [ ] `supabase/functions/gateway/` — `deno check`, `deno lint`, `deno fmt --check` in that directory
      (node's type-stripping cannot see a Deno-only error)
- [ ] `supabase/` — `npx supabase test db --local supabase/tests`
- [ ] Nothing conditional applies

## Money

All money is integer micro-USD. No float enters a monetary path — not in SQL, not in TS, not in JSON.
Token counts include `reasoning_content`, not only `content`.

Does this change touch a monetary path (pricing, holds, settlement, token counting, the 80/20 split,
the `GREATEST(1, …)` floor)?

- [ ] No.
- [ ] Yes — and `supabase/tests/` moved with it. pgTAP is the authority on billing behavior;
      a money change that does not touch it is incomplete.

## Frozen contracts

`docs/CONTRACTS.md` freezes the wire format, ids, money rules, env names, RPC signatures, and path
ownership. Other work is built against that text.

- [ ] No divergence.
- [ ] Diverges — raised explicitly below, with what and why. <!-- Never silently. -->

Path ownership: if this edits a path owned by another agent, say so here.

## Migrations

- [ ] No new migration.
- [ ] New migration in `supabase/migrations/`, `npm run check:migrations` passes.
      `version` is the primary key of `supabase_migrations.schema_migrations`, so a duplicate
      numeric prefix aborts `db reset` partway through — it has already happened twice.

## GPU tiers

The two catalogs must stay in step: `supabase/migrations` (`gpu_tiers` + `solver_config`) runs at
request time, `tools/modal/tiers.py` backs the deploy tooling and the Python tests. Landing a
hardware or price change in only one makes them silently disagree.

- [ ] Not touched.
- [ ] Touched — both catalogs updated, `test_tier_drift` passes.

## Notes for the reviewer

<!-- What you are unsure about. What you did not do and why. If a check fails, say so with the
     output rather than leaving its box unchecked. -->
