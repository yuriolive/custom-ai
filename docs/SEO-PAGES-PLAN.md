# Public / marketing page plan

Competitive read of OpenRouter, Together AI, Venice, Modal and OrcaRouter (URL
inventories pulled 2026-08-19), mapped onto what this app already has. Two goals,
which pull in the same direction but are not the same goal:

1. **Rank.** Own the long-tail queries a person types before they know we exist.
2. **Look established.** A site with 6 routes reads as a weekend project. The
   pages below are the ones whose *absence* is what makes a site look small —
   pricing, docs, status, legal, changelog, a blog with dates on it.

## What exists today

`/`, `/models`, `/models/[creator]/[slug]`, `/playground`, `/console/*`,
`/studio/*`, `/login`, `/signup`. No `sitemap.ts`, no `robots.ts`, no JSON-LD,
no `metadataBase`, no title template, no OG image. `MARKETING_LINKS` holds two
entries by design (`components/marketing/links.ts`) — it grows as routes land.

## What the competitors actually publish

| Pattern | Who does it | Their URL shape |
|---|---|---|
| Per-model page | all five | `/{creator}/{slug}`, `/models/{slug}` |
| Head-to-head compare | OpenRouter, OrcaRouter | `/compare/{a}-vs-{b}` |
| "Best X for Y" collection | Modal (`/resources/*`), OpenRouter (`/collections/*`) | `/resources/best-open-source-code-llms-ai-coding-agents` |
| Usage leaderboard | OpenRouter | `/rankings`, `/apps` |
| Provider / author hub | OpenRouter, Together | `/openai`, `/models-providers/meta` |
| Integration guide per tool | Venice (deepest), Together | `/guides/integrations/claude-code` |
| Glossary / evergreen explainer | Modal | `/gpu-glossary/device-hardware/tensor-core` |
| Pricing | all five | `/pricing` |
| Trust centre + security page | Modal, Together, OpenRouter | `trust.<domain>`, `/docs/guide/security` |
| Changelog | Modal, Venice, OpenRouter | `/changelog` |
| Case studies | Together | `/customers/cursor` |
| Brand kit | Venice | `/brand` |
| i18n | OrcaRouter (zh/ru/ar/de), Venice (pt-BR) | `/{locale}/...` |

Note what OrcaRouter does with the *uncensored* niche —
`/models/obsidian/qwen3.8-27b` titled "Qwen3.8 27B Uncensored (Aggressive) API"
plus blog posts on refusal-rate benchmarks. That is our niche too, and it is
under-served by the big three.

## P0 — SEO plumbing (no new pages, blocks everything else)

Nothing below ranks without these. Half a day of work.

- `app/sitemap.ts` — static routes + every `ready` public model, from the same
  RLS-filtered query the catalog uses.
- `app/robots.ts` — allow crawl, point at the sitemap, disallow `/console`,
  `/studio`, `/api`.
- `metadataBase` + `title.template` (`"%s | <brand>"`) in `app/layout.tsx`. Today
  every page emits a bare title and relative OG URLs.
- `app/opengraph-image.tsx` (static) and a per-model dynamic OG image.
- JSON-LD: `Organization` + `WebSite` on the root, `Product`/`SoftwareApplication`
  with `offers` (per-token price) on model pages, `BreadcrumbList` on nested routes.
- Model-page metadata formula, copying what ranks:
  `"{Model} API — pricing, context, quantization | {brand}"`.

## P1 — pages we can generate from data we already hold

This is the leverage. The GGUF probe (`packages/hf-probe`), the GPU tier catalog
(`gpu_tiers` + `tools/modal/tiers.py`) and the measured decode rates in
`docs/HANDOFF.md` are a corpus none of the five competitors publishes. Programmatic
pages built on it are defensible, not thin.

1. **`/models/[creator]/[slug]` deepening.** Today it is a catalog detail view.
   Add, from the probe: quantization variant table (Q4_K_M vs Q5_K_M vs Q8 with
   file size), context window, KV-cache size at 4k/32k/128k, the GPU tier the
   solver picks and why, measured tok/s, cold-start seconds, per-token price, and
   a copy-paste `openai` SDK snippet. Every one of those is a query.
2. **`/compare/[a]-vs-[b]`.** Generated from adjacent catalog entries, not from a
   cross-product — cap at pairs that share a family or a use case, and
   `noindex` the rest. Title: `"{A} vs {B} — price, context, speed"`.
3. **`/creators/[handle]`.** Creator profile: models, total tokens served, joined
   date. Doubles as the marketplace's social proof and gives creators a page to
   link to, which is free backlinks.
4. **`/collections/[slug]`** — curated hubs: uncensored, roleplay, coding,
   multilingual, embedding, tiny-models-for-edge. Editorial intro + live filtered
   catalog. This is OpenRouter's `/collections/roleplay` play.
5. **`/rankings`** — models by tokens served, last 7/30 days, from
   `usage_transactions`. Fresh, link-worthy, and it makes the marketplace look
   busy. Only ship it once the numbers are not embarrassing.
6. **`/gpu/[tier]`** — one page per tier in `gpu_tiers`: VRAM, memory bandwidth,
   Modal price/hour, which models fit, what decode rate to expect. Modal's GPU
   glossary is the proof this ranks; ours has prices and fit data theirs does not.
7. **`/tools/vram-calculator`** — params × quant × context → VRAM, using the real
   KV math (declared `key_length`, hybrid-attention aware). Manual inputs, no
   repo needed. Highest-intent free-tool query in this space, and it ends with
   "or just call it here".
8. **`/simulate` — paste a Hugging Face repo, get the deployment plan.** The
   single strongest page on this list, and the one the rest of the plan was
   missing: it is the *product* rendered as a public page. Signed out, no
   account, one input box. Output = what Studio already computes:

   - the variants the probe found (Q4_K_M, Q5_K_M, Q8_0 …) with file sizes;
   - attention geometry, KV cache at 4k / 32k / 128k;
   - the GPU tier the solver picks, the tiers it rejected, and **why** —
     `argmin(price)` over tiers meeting both the VRAM fit and the throughput
     target, which is the part every competitor hides behind a menu;
   - expected decode rate, cold-start seconds, price per 1M tokens;
   - "Deploy this" → signup, pre-filled. The conversion path is the page itself.

   SEO: this is the answer to *"does {model} fit on an L4"*, *"how much VRAM does
   {model} need"*, *"cheapest GPU to run {model}"* — asked about every new repo
   the week it drops, by people who have not chosen a provider yet. Cache every
   simulation and the crawlable URL `/simulate/{org}/{repo}` becomes a growing
   page cluster keyed to Hugging Face's own release cadence, at zero editorial
   cost.

   **This does not reuse `POST /api/studio/probe`.** That route requires a
   session on purpose — without it, it is an open unauthenticated proxy to
   arbitrary Hugging Face URLs (see the comment in the handler). The public
   simulator needs its own route with: public repos only and **no `hfToken`
   field accepted at all**, a strict `{org}/{repo}` slug pattern validated before
   any fetch, per-IP rate limiting, and results persisted so repeat and crawler
   traffic is served from cache instead of re-probing the CDN. Same solver, same
   KV math, different trust boundary.

## P2 — hand-written pages that make the site look like a company

- `/pricing` — per-token table, the 80/20 split stated plainly, no hourly GPU
  bill, worked cost example. Every competitor has this; its absence is glaring.
- `/docs/*` — quickstart, OpenAI compatibility, authentication, streaming,
  errors, rate limits, billing. Venice and Together get enormous indexed surface
  here. Ours can be MDX in-app; a separate docs subdomain is not worth it yet.
- `/docs/integrations/{claude-code,cline,openclaw,vercel-ai-sdk,langchain,continue,aider,openwebui,sillytavern}`
  — one page per tool, each a real config snippet. Venice's version of this is
  the single highest-yield page cluster on their site. Cheap: the base URL and
  key format are the only variables.
- `/for-creators` — deploy from a Hugging Face repo, 80% revenue share, what the
  pipeline does (probe → tier → smoke test). The supply-side landing page.
- `/uncensored-models` — the niche page. States the policy honestly, links the
  collection. Own this before someone else does.
- `/blog` — engineering posts, not marketing filler. We have real material:
  cold-start measurements, why the tier list is not a ladder, KV math with
  `key_length`, throughput measured over the decode window. This is Modal's whole
  playbook.
- `/changelog` — dated entries. Nothing signals "alive" more cheaply.
- `/status` — even a static page pointing at an uptime provider.
- `/security` and `/privacy` — data retention on prompts, what the gateway logs.
  Enterprise-shaped buyers look for this first.
- `/legal/terms`, `/legal/privacy`, `/legal/acceptable-use` — the AUP is not
  optional given the uncensored positioning.
- `/about` — who is behind it. Anonymous infra sites do not get trusted with a
  prepaid wallet.

## P3 — later, once there is traffic to justify it

`/customers/[slug]` case studies · `/brand` kit · i18n (`pt-BR` first, then `zh`) ·
`/apps` showcase of things built on the API · glossary cluster · comparison
landing pages against named competitors (`/vs/openrouter`), which only work once
we can back the claims with our own numbers.

## Sequencing

P0 → P1.1 (model page depth) → **P1.8 `/simulate`** → P2 pricing + docs +
integrations → P1.2–4 (compare, creators, collections) → the rest. P1.5
`/rankings` waits on volume. `/simulate` jumps the queue because it is the only
P1 page that is simultaneously the demo, the conversion funnel and a programmatic
page cluster — and because P1.7's calculator is a strict subset of it.

Two rules that keep this from backfiring: a generated page ships only when it
carries data no other page has (otherwise `noindex` it), and no nav link points
at a route that does not exist — the rule `components/marketing/links.ts` already
enforces at build time.

## Clone-to-another-tier, and grouping deployments in the catalog

Raised while reviewing this plan, and it belongs here rather than in a product doc
because the second half of it is a **precondition for P1.1 ranking at all**.

### Clone is cheap and needs no contract change

`custom_models` already stores one row per *deployment*, not per model: the probe
output (repo, revision, variant, `variant_files`, architecture), the creator
intent (`context_length`, `target_tokens_per_second`), the solver's placement
(`gpu_tier_id`, snapshotted price, `measured_tokens_per_second`), the pricing and
the counters all live on the same row. `hardware_pinned` (FR-DEP-056) and
`tools/modal/deploy.py --pin-tier` already exist.

So "clone this on faster hardware" is: copy the probe and architecture columns
verbatim, take a new `slug`, raise `target_tokens_per_second` or pin a tier, and
re-run the solver. On Modal the GPU is a decorator argument — one class per tier,
so a different tier is a different hostname and a genuinely different pool
(`tools/modal/README.md`). No re-probe, no provisioning, no rollback path.

Two guards worth building in from the start:

- **Refuse a no-op clone.** If the resolved placement is identical to the
  source's, the clone lands on the same pool and is the same speed at the same
  price — a duplicate row and a duplicate catalog entry for nothing. Compare the
  resolved `(gpu_tier_id, ctx, parallel, variant_files)` and reject before insert.
- **Show the cost side.** A faster tier has a higher `gpu_usd_per_hour_micro_snapshot`
  and therefore a higher `cost_floor_micro_per_mtoken`. The clone screen has to
  put "2.4x tok/s, 1.9x price floor" next to each other, or creators will clone
  onto hardware they cannot price competitively.

Cross-*provider* clone (Modal → RunPod, for more tok/s at another vendor) is the
same UI, but the RunPod endpoint-creation path was never implemented
(NFR-EXT-001). Tier-level clone ships now; provider-level clone slots into the
same screen later.

### Grouping is not optional once cloning exists

Today the same repo + variant deployed twice produces two catalog cards and two
`/models/{creator}/{slug}` URLs with near-identical content. Cloning turns that
from an edge case into the normal case, and near-duplicate pages competing with
each other is exactly the failure `app/page.tsx` already guards against for
filtered catalog views.

**Group presentationally, on `(hf_repo_slug, variant_quant_tag, variant_family)`.**
All three parts matter — per FR-DEP-041b two variants sharing a quant tag but
differing in `variant_family` are different models and must not merge. The grouped
model page then carries what makes OpenRouter's model pages rank: one canonical
URL, and beneath it a table of every deployment with tier, measured tok/s,
cold-start budget, price per 1M tokens and creator. Each deployment keeps its own
`creator/model-slug` id and its own page, canonicalised to the group.

This changes nothing frozen: no new id shape, no gateway change,
`gateway_resolve` still looks up by (handle, slug), `upstream_endpoint_ref` is
already deliberately non-unique because pools are shared (20260818000200).

**Routing between deployments is a different, much larger question.** An alias id
that picks the cheapest or fastest deployment per request would change the id
contract in `docs/CONTRACTS.md`, add a resolution path the gateway does not have,
and — the part with no obvious answer — break revenue attribution: the 80/20 split
assumes one creator per served request, and a router decides on the caller's
behalf whose model earns. Worth designing; not worth bundling into the catalog
grouping that unblocks the SEO work.
