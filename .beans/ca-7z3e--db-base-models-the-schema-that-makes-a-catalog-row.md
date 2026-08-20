---
# ca-7z3e
title: 'db: base_models — the schema that makes a catalog row a model, not a deployment'
status: completed
type: feature
priority: high
created_at: 2026-08-20T03:28:19Z
updated_at: 2026-08-20T03:46:03Z
parent: ca-l5oz
---

GitHub issue #24. Phase 1 of the marketplace discovery plan, and the only irreversible step, so it ships alone and first: it blocks #25 (probe/resolve), #26 (grouped catalog), #28 (search) and #31 (trust/suspend), which other agents build on concurrently.

custom_models has no notion of *which model* a row is — a row is a deployment (one creator, one repo, one quantization, one price). Six quantizations of Qwen3-8B are six unrelated cards, the quality facet deletes cards instead of picking a variant, and two creators serving the same weights at different prices render as two cards a shopper has to diff by eye.

## Scope

- [x] public.commercial_hosting enum: allowed | conditional | prohibited | unknown
- [x] public.base_models: canonical slug, display name, summary, family, parameter count
- [x] parent_id self-reference — a fine-tune is its OWN base model with a parent, never a variant of what it was trained from
- [x] architecture fingerprint columns, for the suggest-only arm of the resolution cascade
- [x] use_cases text[] over the closed vocabulary (code/reasoning/chat/roleplay/uncensored/multilingual/vision/long-context/tool-use/math/embeddings/summarization)
- [x] embedding extensions.vector(384) + create extension vector — the dimension is gte-small's and lives in one place
- [x] licence: license_id, license_name, license_url, commercial_hosting
- [x] custom_models: base_model_id FK, base_model_match jsonb, license_ack_at, license_ack_version, suspended_at, suspension_reason
- [x] custom_models_variant_uniq — the duplicate-listing unique index, coalesce on both nullable variant columns
- [x] RLS matching the existing shape, with suspended_at and the platform-written columns pinned out of the creator's own policies
- [x] grants (anon/authenticated/service_role) — nothing is auto-exposed since CLI 2.10
- [x] pgTAP coverage for every new constraint and every pin
- [x] npm run check + npm test green

## Out of scope, deliberately

No money column, settlement RPC or existing pgTAP invariant changes. custom_models_resolve_idx and the gateway resolve path are untouched — the addressable model id stays creator-handle/model-slug, and base_models is never reachable from the gateway.

## Summary of Changes

One migration, `supabase/migrations/20260820000100_base_models.sql`, plus
`supabase/tests/07_base_models_test.sql` (88 assertions) and a seed fixture.

**One file, not two.** The halves depend on each other in opposite directions:
`custom_models.base_model_id` needs `base_models` to exist, and the `base_models`
visibility predicate reads `custom_models.suspended_at`. Either split order leaves a
database state where one half is granted to `anon` without the policy that constrains it.

**Decisions worth carrying forward:**

- `base_models` has no `visibility` column — it inherits visibility from the listings that
  serve it, through a SECURITY DEFINER oracle `base_model_visible_to(id, viewer)`. Definer
  because the predicate must reach `parent_id` (a parent served only through fine-tunes
  still has to be nameable for the §5.2 provenance line), and reading `base_models` from
  inside a `base_models` policy is infinite RLS recursion. Without the gate, a creator who
  privately deploys their own fine-tune publishes its name to the anonymous internet.
- All six new `custom_models` columns are pinned out of `custom_models_insert_own` and
  `custom_models_update_own`. `suspended_at` is the sharp one: a takedown its target can
  clear is not a takedown. Deploys already insert through the service-role admin client
  (`lib/studio/server/admin.ts`), so the pins cost the existing pipeline nothing.
- `custom_models_select_public` gained `suspended_at is null`, so a suspension is real at
  the RLS layer for every reader at once. The GATEWAY is untouched by design — #24 is
  forbidden from the resolve path, so stopping the stream is #31's work. Nothing regresses
  meanwhile: no surface writes the column yet.
- The 384 constant lives in `public.embedding_dimension()`; pgTAP pins the column typmod
  to it, since SQL cannot take a typmod from a function.
- `public.text_array_to_string(text[], text)` exists because the built-in `array_to_string`
  is STABLE (its volatility comes from `anyarray`) and a GENERATED column rejects that.
- Added `base_models.license_version`, beyond the issue's enumerated licence columns:
  `custom_models.license_ack_version` has nothing to be compared against without it, which
  would make a stale ack indistinguishable from a missing one.

**Validated:** `npm run check` and `npm test` green; 289 pgTAP assertions green from an
empty database. Docker is unavailable in this sandbox, so `supabase db reset` was
reproduced against a local Postgres 16 with pgvector and pgTAP and a minimal Supabase shim
(roles + `auth.users` + `auth.uid()`); `05_concurrency_test.sql` was skipped there because
its dblink dials a Docker network alias. Both branches of the pgvector schema guard were
exercised, including the relocate path.
