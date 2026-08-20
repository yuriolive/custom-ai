---
# ca-s0cx
title: 'probe: resolve a repo to its base model, and stop discarding the licence'
status: completed
type: feature
priority: high
created_at: 2026-08-20T04:40:01Z
updated_at: 2026-08-20T05:03:35Z
parent: ca-l5oz
---

GitHub issue #25. Phase 2 of the marketplace discovery plan, stacked on #24 (ca-7z3e), whose schema it is the first writer for.

Resolve a Hugging Face repo to the base model it is a variant of, so the catalog can group listings, and capture the licence in the same fetch. Both are properties of the base model, not of the quant repo: a community re-quantization routinely carries `other` or omits the licence entirely, and a permissive string on a quant repo does not relicense the weights underneath it.

## The cascade

| # | Signal | Where | Action |
|---|---|---|---|
| 1 | `cardData.base_model` + `base_model_relation` | `GET /api/models/{id}?full=true` | auto-link |
| 2 | `general.base_model.0.repo_url` | GGUF KV header | auto-link |
| 3 | Architecture fingerprint | already probed | suggest only |
| 4 | Normalized name | `deriveBaseName()` | suggest only |

Auto-link on 1 or 2 ONLY. A fine-tune has an identical architecture fingerprint to its parent — same layers, same heads, same vocab — so grouping on architecture alone merges Qwen3-8B with SomeLab/Qwen3-8B-Uncensored and presents the fine-tune's output as the base model's. `base_model_relation` answers the same question without asking: quantized -> link to the parent, finetune/merge/adapter -> create a child.

Whatever fires is written to `custom_models.base_model_match`, so a wrong grouping is explainable afterwards and a re-resolution pass can find every row grouped on a weak signal.

## Scope

- [x] hf.ts: request `?full=true`, type `cardData`
- [x] gguf.ts: read `general.base_model.*` off the parsed header
- [x] new identity.ts: pure fingerprint + name scoring + the cascade, unit-tested
- [x] new license.ts: licence id -> commercial_hosting enum, pure
- [x] model-card.ts: keep the frontmatter licence instead of discarding it
- [x] lib/studio/server: run the cascade in the deploy pipeline, upsert base_models, persist the match
- [x] components/studio: the confirm step, only when no declared signal fired
- [x] node tests: each signal, and the fine-tune-is-not-a-variant case
- [x] npm run check + npm test pass

The publish gate on an `unknown` licence is #29, NOT this bean.


## Summary of Changes

**The cascade** lives in `packages/hf-probe/src/identity.ts`, pure and unit-tested.
`resolveBaseModelIdentity` is the only function allowed to decide a repo links, and it links
only on a DECLARED signal: `cardData.base_model` (+ `base_model_relation`) or the GGUF header's
`general.base_model.*`. Signals 3 and 4 return ranked suggestions capped at 0.75 confidence and
are never applied — the fine-tune-is-not-a-variant case is a test, not a comment.

Where a declaration names a parent but no relation (every GGUF header — the format has no
relation key), the relation is inferred from the normalized names: equal means the same weights
repackaged; anything else is recorded as DERIVED. The asymmetry is deliberate — a wrong split is
cosmetic, a wrong merge serves a fine-tune's output under the base model's name.

**Licence** capture is `packages/hf-probe/src/license.ts` (id -> `commercial_hosting`, with
non-commercial / no-derivatives patterns checked BEFORE the table so an uncatalogued id can never
fall through to permissive) plus `lib/studio/card.ts`, which now keeps the frontmatter licence
`model-card.ts` used to discard. `license: other` + `license_name: qwen-research` classifies as
`prohibited` rather than `unknown`, and an unrecognised name never downgrades a recognised id.

**Persistence** is `lib/studio/server/base-model.ts`: it upserts `base_models` (fill-in only,
never overwrite — a re-quantization saying `other` must not blank a licence somebody established),
links the listing to the parent for a quantization and to a new child row for a
finetune/merge/adapter, and writes `custom_models.base_model_match` on every path including
`unresolved`. Candidates are READ with the caller's session client so RLS keeps somebody's private
fine-tune out of another creator's audit trail; writes use the service role. Nothing here can fail
a deployment.

**UI**: `components/studio/base-model-step.tsx` tells the creator when the repo declared its own
parent, and asks only when it did not — two options per candidate (these ARE it / derived FROM it)
plus "something else", nothing preselected, and leaving it unanswered is a supported outcome.

`npm run check` and `npm test` pass; node tests go from 349 to 390.

The publish gate on an unknown licence is #29 and was deliberately not implemented here.
