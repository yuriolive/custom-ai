---
# ca-zim3
title: 'trust: report path and an operator-only per-listing suspend'
status: completed
type: feature
priority: high
created_at: 2026-08-20T04:42:11Z
updated_at: 2026-08-20T05:19:11Z
parent: ca-l5oz
blocked_by:
    - ca-7z3e
---

GitHub #31, phase 8 of the marketplace discovery plan (§5.5). Stacks on #24 (ca-7z3e),
which already added `custom_models.suspended_at` / `suspension_reason`, pinned both out
of the two creator RLS policies, and taught `custom_models_select_public` to hide a
suspended row. What is missing is everything around that column: nothing writes it,
nothing reports a listing, and the gateway still serves one.

## Why the column and not `visibility`

`visibility` sits inside `custom_models_update_own`. A takedown expressed as a
visibility flip is a takedown its target can undo, which is not a takedown. `status`
is the provisioning state machine and the deploy pipeline would clobber it on the next
write. `profiles.is_suspended` is the creator-level hammer and is already honoured by
`creator_public`, but suspending a whole account over one bad listing is too blunt.

## Scope

- [x] `model_reports` — the report inbox, with RLS that lets a signed-in visitor file
      one report per listing and read only their own
- [x] `profiles.is_operator` + `is_platform_operator()`, so the operator check lives in
      the database rather than in a route handler
- [x] operator RPCs: suspend, lift, dismiss, and the queue read — each self-guarded, so
      a creator calling them directly gets 42501
- [x] `gateway_resolve` returns `modelSuspendedAt`; the gateway 404s on it exactly the
      way it 404s a private model, and `/v1/models` drops it
- [x] the catalog queries gain an additive `suspended_at is null` predicate
- [x] a report path on the model page
- [x] an operator surface at `/operator` that acts on a report
- [x] pgTAP proving a creator cannot clear their own suspension through ANY policy or RPC
- [x] `npm run check` and `npm test` green


## Summary of Changes

**`supabase/migrations/20260820002000_trust_reports_and_suspension.sql`** — `model_reports`
(the inbox, with the report taxonomy as two enums), `profiles.is_operator`,
`is_platform_operator()`, four operator RPCs (suspend / lift / dismiss / queue read), a
recreate of `custom_models_update_own`, and `gateway_resolve` returning `modelSuspendedAt`.

Three decisions worth remembering:

1. **The operator check is in Postgres, not in a handler.** The RPCs are granted to
   `authenticated` and each re-checks `is_platform_operator(auth.uid())`, raising 42501.
   A creator's JWT reaches PostgREST directly and never has to pass through a Next.js
   route, so a handler-side check is not a check. It also means the app never needs the
   service-role key to moderate.
2. **`is_operator` needed no new policy.** `profiles_update_own` (20260817002100) is an
   allowlist over display_name/avatar_url/bio and the UPDATE privilege is narrowed to
   those three, so a new column is read-only to its owner by construction. Asserted in 08
   rather than assumed.
3. **A soft-delete escape existed and is closed.** `deleted_at` is not pinned and
   `custom_models_variant_uniq` is partial on it, so a suspended creator could delete the
   listing, free its variant slot, and re-list unsuspended. `deleted_at` is now pinned
   *while suspended only*, in WITH CHECK rather than USING — a USING filter would make a
   forbidden write match zero rows and succeed silently instead of raising 42501, which
   would have broken 07's assertion about exactly that statement.

**Gateway** — `suspended_at` joins `deleted_at` in the unconditional 404 branch, above the
visibility branch, because there is no owner exemption: a private model still serves its
creator, a suspended one serves nobody. `/v1/models` drops it too. No WHERE clause was
added to the RPC, so a revoked key asking for a suspended model still gets its 401.

**Catalog** — four additive `.is("suspended_at", null)` predicates, deliberately the
smallest possible diff in `components/marketplace/queries.ts` because #26 is rewriting it.

**Surfaces** — a quiet report dialog on the model page (direct INSERT under RLS, the house
convention, no route handler); `/operator` with the queue and the three actions, 404 for
everyone else; and the suspension with its reason on the creator's own Studio row, since
Studio is the only place its target can see it at all.

## Verified

`npm run check` and `npm test` (353 pass / 1 skipped) green; `supabase db reset` applies
from zero and all **374 pgTAP** pass, including 07 with its tripwire flipped. Beyond the
suites, against a live local stack: the model page and catalog drop a suspended listing
while the owner's Studio row keeps it; `/operator` 404s for anon and renders the queue for
a real operator session; the three RPCs return 42501 to the creator and succeed for the
operator over PostgREST; every error code the report dialog maps is the one PostgREST
actually returns; and the real `gateway_resolve` RPC drives `resolveRequest` to a 404
byte-identical to a nonexistent model, reverting to "would serve" the moment the
suspension is lifted.

## Deferred

`ca-jy33` (wire the Realtime `custom_models` subscription — the 60 s LRU is currently the
only invalidation, so a takedown is up to a minute late on a warm isolate, the same bound
a visibility flip already lives with) and `ca-7lpg` (whether re-listing the same weights
as a NEW listing after a takedown is evasion — a product decision, and blocking it needs
a record that outlives the listing).
