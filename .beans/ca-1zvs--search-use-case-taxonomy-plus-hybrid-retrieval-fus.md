---
# ca-1zvs
title: 'search: use-case taxonomy plus hybrid retrieval fused by RRF'
status: completed
type: feature
priority: high
created_at: 2026-08-20T05:58:10Z
updated_at: 2026-08-20T06:30:55Z
parent: ca-l5oz
---

GitHub #28. Two layers, because a shopper searches by WHAT THE MODEL IS FOR and
neither layer alone covers that.

## Layer A — the closed use-case vocabulary (§4.1)

`code · reasoning · chat · roleplay · uncensored · multilingual · vision ·
long-context · tool-use · math · embeddings · summarization`, closed because an
open tag cloud degrades into synonyms (`coding`/`code`/`programming`) that split
one facet three ways and make every count wrong.

The vocabulary landed with `base_models` (#24) and renders as the counted tabs
(#26). What was missing is the WRITER: with nothing filling `use_cases`, every
tab is empty and Layer A improves nothing. A deterministic classifier over the
Hugging Face tag list and the model card closes that.

## Layer B — hybrid retrieval (§4.2-4.3)

- `Supabase.ai.Session('gte-small')` inside an Edge Function: no external key, no
  new secret in CONTRACTS.md §Environment, 384 dims — which is why the column is
  384 and not 1536.
- Embed at DEPLOY time, per BASE MODEL, never per listing.
- `search_base_models(...)` fuses FTS and cosine by Reciprocal Rank Fusion,
  k = 60, in ONE Postgres RPC — not a weighted sum, because ts_rank and cosine
  distance are not on a comparable scale.
- Both arms carry the same visibility/status/deleted_at predicates the catalog
  applies.
- Skip the vector arm under 3 characters, where prefix FTS is strictly better.

## Stated honestly

At single-digit catalog size hybrid retrieval will NOT measurably beat the
existing prefix FTS. Its value is that the embedding is written at deploy time,
so there is no backfill when the catalog grows. Layer A is what improves
discovery today. gte-small is English-only: model cards are overwhelmingly
English so the corpus is fine, but a Portuguese query underperforms.

## Todo

- [x] Layer A: deterministic use-case classifier over HF tags + model card
- [x] `embed` Edge Function: query embedding + deploy-time base-model embedding
- [x] `search_base_models` RRF RPC (k = 60), one round trip, visibility-filtered
- [x] Wire the catalog search box to the hybrid path above 3 characters
- [x] pgTAP: ranking, the visibility predicates, and a semantic-only hit
- [x] `npm run check` and `npm test` green


## Summary of Changes

**Layer A — the writer the vocabulary was missing.**
`classifyUseCases` (`packages/hf-probe/src/use-cases.ts`) maps a Hugging Face repo's tags,
pipeline tag, name and model card onto the closed vocabulary. Deterministic and rule-based,
because the output is a FACET: a tab that moves between deploys because a sampler rolled
differently is not a facet, it is noise. Precision over recall throughout — a missing tag
costs one route to being found, a wrong one puts a model in front of somebody who asked for
something else and makes that tab's count a small lie. Nothing calls it yet; the row it
writes to is created by the resolution cascade (#25).

**Layer B — hybrid retrieval.**

* `supabase/functions/embed/` — `Supabase.ai.Session('gte-small')` inside the Edge Function.
  One function, two directions (query embedding, deploy-time base-model embedding) because
  the query and the document must come out of the same model or the cosine distance between
  them is a number about nothing. No external provider, therefore no new secret in
  `CONTRACTS.md` §Environment; 384 dimensions, stated once in `dimension.ts` and once in
  `public.embedding_dimension()`, pinned to each other by a test.
* `search_base_models` (20260820006000) — a prefix-FTS arm and a cosine arm over the SAME
  visible set, fused by RRF at `search_rrf_k()` = 60, in one RPC. RRF rather than a weighted
  sum because `ts_rank` and cosine distance are not on a comparable scale. It returns
  `catalog_grouped`'s envelope key-for-key, so the dispatch in `queries.ts` is three
  arguments wide and no component changed.
* `p_max_distance` (0.22, i.e. cosine similarity >= 0.78 for gte-small) is what makes the
  vector arm a retrieval: a vector index has no notion of "no match", so without a ceiling
  the arm returns the whole catalog reordered for every query.
* 50 pgTAP assertions in `09_search_rrf_test.sql`, including the acceptance criterion (a
  query matching nothing lexically and everything semantically returns the right model) and
  a drift guard: with no arms, `search_base_models` must return exactly `catalog_grouped`'s
  groups, which is the only mechanical check that the two visibility blocks agree.

**Stated honestly.** At single-digit catalog size this will not measurably beat prefix FTS;
the value is that the embedding is written at deploy time, so nothing needs a backfill later.
Layer A is what improves discovery today. gte-small is English-only, so a Portuguese query
underperforms and the lexical arm carries it.
