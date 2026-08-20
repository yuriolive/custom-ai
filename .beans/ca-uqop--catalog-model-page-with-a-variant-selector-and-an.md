---
# ca-uqop
title: 'catalog: model page with a variant selector and an offer table'
status: completed
type: feature
priority: high
created_at: 2026-08-20T05:55:52Z
updated_at: 2026-08-20T06:32:20Z
parent: ca-l5oz
---

GitHub issue #27. Phase 4 of the marketplace discovery plan. Stacks on #24 (`base_models`, PR #40) and #26 (the grouped catalog) — both already on this branch.

The model page describes **one deployment**, and that is the defect: three creators serving the same weights at three prices are three pages a shopper opens in three tabs and diffs by eye, which is the one comparison a marketplace exists to make unnecessary. The page becomes a **model**, with every visible listing of it as an offer row.

## Scope

- [x] `model_page` RPC — one server-side round trip: the anchor listing, its base model, the parent for the lineage link, and every visible listing of the model as an offer
- [x] variant selector across quality TIERS (never quant tags), each rung carrying its count and its cheapest output price
- [x] offer table, sortable on every axis a buyer compares: creator, quality, context, tok/s, TTFT p50, input price, output price
- [x] nulls sort LAST in both directions — an unmeasured listing is not the fastest offer on the page
- [x] quant tags stay disclosure-only: the tier is the label, the tag sits beside it
- [x] a copyable model id per offer, and it is the LISTING's `creator-handle/model-slug`, never `base_models.slug`
- [x] lineage link up to `parent_id`, with the root and unresolved cases rendered as distinct sentences rather than as the same blank
- [x] the licence notice a `conditional` model owes its upstream — "Built with Llama" DISPLAYED, plus the derivative-naming rule and the pass-through obligations, as content
- [x] the offer table renders at one listing too, so the page a creator sees on day one is the page a shopper sees on day thirty
- [x] nothing hardware-shaped in the RSC payload; the RPC's `jsonb` projection is the security boundary, asserted by name in pgTAP
- [x] `npm run check` + `npm test` green, 44 new pgTAP, and 375px does not overflow the document in either theme

## Out of scope, deliberately

No licence GATE — whether a `conditional` or `unknown` licence may publish at all is #29's, on the write path. No base-model URL (`/models/<base-slug>`): the addressable unit is still a listing, so the lineage link goes to a catalog search. No hybrid retrieval (#28). No resolution cascade (#25), so an unresolved listing is still a model of one. No gateway or resolve-path change.

## Summary of Changes

**`supabase/migrations/20260820005000_rpc_model_page.sql`** — `model_page(text, text, integer)`,
one `stable` SECURITY INVOKER function returning `jsonb`: the anchor listing, the base model it
serves, that model's parent, and every visible listing of the model as an offer, plus
`offer_total`. One round trip because the offer table is a PRICE COMPARISON and its rows are only
comparable inside one snapshot — two round trips can disagree, and the disagreement shows up as a
price column that does not add up against the `from` figure the reader arrived with. The
visibility block is byte-identical to `catalog_grouped`'s, so a card that says "3 listings" cannot
open a table of two. Plus `custom_models_offer_set_idx`: this scan probes `base_model_id` FIRST,
the reverse of the catalog's, so the existing index does not serve it.

**`components/marketplace/offers.ts`** (new, pure) — variant rungs and the sort. Nulls sort LAST
in both directions: an unmeasured listing has not been shown to be slow, and ranking it as zero
nominates it as the quickest offer on the page under `asc`.

**`components/marketplace/licence.ts`** + **`licence-notice.tsx`** (new) — the §5.1 notice as
CONTENT. "Built with Llama" is rendered, visibly, on the page that makes the weights available;
the derivative-naming rule and the pass-through obligations are stated beside it. A licence family
we have not read gets a one-line "there are conditions, read them", never an invented attribution
string — naming the wrong one is a licence breach performed confidently.

**`components/marketplace/lineage.ts`** (new, pure) — four states, none of them blank. `root` and
`unresolved` are opposite claims ("trained from scratch" versus "nobody has checked") and cannot
share a rendering.

**`components/marketplace/offer-board.tsx`** (new) — the selector and the sortable table. Rendered
at one offer too, so the page a creator sees on day one is the page a shopper sees on day thirty.

**`components/marketplace/model-detail.tsx`** — now the model page. The offer board is first,
above the snippet: the reader's first question is WHICH offer, and the snippet answers the second.

**`components/marketplace/queries.ts`** / **`types.ts`** — `fetchModelPage` + `mapModelPage`, and
the `ModelPage` / `ModelOffer` / `BaseModelInfo` / `ParentModelInfo` shapes. No hardware field
exists on any of them.

Verified: `npm run check`, `npm test` (386 node), `npm run build`, and 44 new pgTAP green against
a real Postgres 16 (whole suite re-run: only pgvector-dependent assertions in 07 and the dblink
concurrency file fail locally, both for want of extensions this box has no headers to build).
Rendered in a browser at 375px in both themes: the offer table scrolls inside its own container
and `document.scrollWidth` stays 375. Root, fine-tune and unresolved all render.
