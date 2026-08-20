---
# ca-vp7l
title: 'catalog: group the catalog by model instead of by deployment'
status: completed
type: feature
priority: high
created_at: 2026-08-20T04:43:43Z
updated_at: 2026-08-20T05:38:16Z
parent: ca-l5oz
---

GitHub issue #26. Phase 3 of the marketplace discovery plan. Stacks on #24 (`base_models`, PR #40) — the grouping pointer already exists on this branch.

The catalog card is a **deployment**, and that is the defect: six quantizations of one model draw six unrelated cards, the quality facet *deletes* cards instead of picking a variant within one, and two creators serving identical weights render as two cards a shopper has to diff by eye. The card becomes a **model**, aggregated over its ready, public, unsuspended listings.

## Scope

- [x] `catalog_grouped` RPC — one server-side query: grouping, filtering, aggregates, facet counts, category counts, pagination
- [x] aggregates are `min(price)` / `max(tok_s)` / `max(context)`, each LABELLED a best case (`from`, `best`, `up to`)
- [x] the quality facet filters WITHIN a group: `Maximum` keeps every model with at least one maximum-quality listing and quotes that listing, instead of dropping the model because its cheapest listing was Q4
- [x] provenance line — `weights by qwen · served by alice`
- [x] counted category tabs over `base_models.use_cases`, counts matching the rows the tab returns
- [x] counts on the facet rail, computed with the facet's own dimension excluded (real drill-down semantics)
- [x] `N listings` on the card, linking to the quoted listing's model page
- [x] nothing hardware-shaped in the RSC payload; the RPC's `jsonb` projection is the security boundary
- [x] visibility/status predicates in ONE clearly-named place, so #31's `suspended_at` lands as an additive predicate
- [x] `npm run check` + `npm test` green; 375px does not overflow in either theme

## Out of scope, deliberately

No base-model detail page (`/models/<base-slug>`) — the card still links to the quoted listing's existing `/models/[creator]/[slug]`. No embedding/vector search (#28). No resolution cascade (#25), so unresolved listings (`base_model_id is null`) stay one-listing groups. No gateway or resolve-path change.

## Summary of Changes

**`supabase/migrations/20260820001000_rpc_catalog_grouped.sql`** — `catalog_grouped`, one
`stable` SECURITY INVOKER function returning `jsonb`. One filtered CTE (`listing`) feeds the
page, the total, the category counts and all five facet counts, which is what makes
"the tab count equals the rows the tab returns" a guarantee rather than a coincidence: two
round trips can disagree, one snapshot cannot. Plus
`custom_models_catalog_group_idx`, partial on the same NULL checks the function applies.

Deliberate choices, each commented in place:

- **SECURITY INVOKER, not DEFINER.** RLS stays the floor under the function's own
  predicates. A definer function would skip `base_model_visible_to` per base row and would
  make this one file the only thing between `anon` and every private draft.
- **The visibility predicates live in ONE named CTE** (`visible_listing`), so #31's
  operator suspension is an additive `and` rather than a rewrite of six aggregations.
  `suspended_at is null` is already there and already tested.
- **The quality ladder and the price bands are passed IN, not restated in SQL.** A second
  copy of those constants is exactly the two-GPU-catalog failure CLAUDE.md documents.
- **Facet counts exclude their own dimension.** A rail whose counts include its own active
  filter reports the thing you already chose and zero for everything else.
- **Aggregates come from the MATCHING listings**, and the quoted listing is the cheapest of
  them. So with `quality=maximum` the `from` price is a price you can pay at maximum
  quality, and both prices on the card come from one real listing rather than being a
  min-of-each-column pair nobody offers.

**`supabase/tests/08_catalog_grouped_test.sql`** — 50 pgTAP tests. Three listings are one
card; an unresolved listing is its own card; a suspended, soft-deleted or private listing
contributes to no aggregate and no count (each is priced or measured so a leak shows up in
a number the file already pins); `maximum` keeps a model whose cheapest listing is Q4 and
quotes its Q6; every category tab count equals the total that category returns.

**The TypeScript half** — `CatalogGroup` / `CatalogCounts` / `CatalogGroupPage`,
`fetchCatalogGroups`, a rebuilt `GroupCard` (labelled `BEST TOK/S` · `MAX CONTEXT` ·
`FROM /1M OUT`, the provenance line, `N listings`, category chips, and the QUOTED listing's
platform id under the copy button — not `base_models.slug`, which looks like an id and
404s), counted `CategoryTabs` as real links, counts on the facet rail, and the two-column
layout from UI-REDESIGN-PLAN §6. The rail moved inside the Suspense boundary because a
count has to come from the same query as the rows; search and sort stayed outside because
they own the caret. `fetchCatalogPage` and `ModelCard` are gone — the landing page's
featured grid is grouped too, so its "N models" is a count of models.

## Verified

`npm run check`, `npm test` (363 node), `npm run build`, and 339 pgTAP against a real
Supabase Postgres 17. Rendered in a browser: one model with three listings reads
"3 listings"; the `Chat 1` tab returns exactly 1 card; `?quality=maximum` keeps the model
and re-quotes it at "2 listings" / $2.40; no horizontal overflow at 375px in either theme.
