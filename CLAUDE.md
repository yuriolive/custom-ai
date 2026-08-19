# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

An OpenAI-compatible **AI inference marketplace**. A creator points Studio at a Hugging
Face repo; the platform resolves hardware, deploys, smoke-tests, and lists the model.
A consumer calls it with the stock `openai` SDK (`base_url` + `api_key` changed, nothing
else) and is billed per token from a prepaid wallet, split 80% creator / 20% platform.

MVP-0's acceptance test is one sentence, and it is in `docs/CONTRACTS.md`: tokens stream
from a scale-to-zero llama.cpp worker and **exactly one** `usage_transactions` row settles
with a correct split and no negative balance.

## Read before changing anything

| Doc | What it holds |
|---|---|
| `docs/CONTRACTS.md` | **FROZEN** shapes: wire format, ids, money rules, env, path ownership. If it looks wrong, say so — do not silently diverge. |
| `docs/PRD-inference-marketplace-mvp.md` | Requirements, FR-* ids referenced throughout the code comments. |
| `docs/HANDOFF.md` | Current state, measured facts (cold start, decode rate, KV size) worth not re-deriving. |
| `docs/DEPLOY.md` | Which host deploys what, and what is already configured. |
| `tools/modal/README.md` | How the Modal worker actually serves: class parameters, pools, cold start. |

## Layout

```
app/                        Next.js 15 App Router — marketplace, studio, console, playground
components/                 UI (HeroUI v3 + Tailwind v4)
lib/                        Server + client app code
  studio/server/            Deployment pipeline: probe -> ref -> smoke test
  billing/  console/  supabase/
packages/hf-probe/          HF repo probe, GGUF header parse, variant classifier
packages/anthropic-adapter/ Anthropic wire shape over the OpenAI gateway
packages/shared/            Types only, no runtime deps
supabase/migrations/        Schema, RLS, RPCs — including the placement solver
supabase/functions/gateway/ The Edge Function that serves /v1/chat/completions
tools/modal/                The llama.cpp worker (app.py) + the Python tier catalog
tools/mock-upstream/        Fake upstream SSE server, for tests and GPU-free local work
```

## Commands

```bash
npm run check      # check:env + lint (oxlint + eslint) + typecheck across all 5 tsconfigs
npm test           # node --test across app, hf-probe, gateway, mock-upstream, keygen, adapter
npm run dev        # Next dev server
```

Python worker tests: `cd tools/modal && uv run pytest`. Postgres invariants are pgTAP under
`supabase/tests/` and are the authority on billing behavior — a money change that does not
touch them is incomplete.

Always run `npm run check` before claiming a change is done. Lint is not advisory here:
oxlint rules like `no-array-sort` are enforced in CI.

## Things that are true here and are not obvious

**Money is integer micro-USD, everywhere.** No float ever enters a monetary path. Token
counts include `reasoning_content`, not just `content` — counting only `content` on a
reasoning model under-counts by up to 89%.

**The upstream is Modal, not RunPod.** RunPod is a retained second-provider shape
(NFR-EXT-001); its endpoint creation was never implemented. `UPSTREAM_PROVIDER` defaults to
`modal`; only `runpod` and `mock` (which speaks the RunPod wire shape) opt out. The two
parsers — `lib/studio/server/upstream.ts` and `supabase/functions/gateway/index.ts` — must
stay in step: a Modal-shaped `upstream_endpoint_ref` served through a RunPod-shaped URL 404s
at the upstream and reads to the client as a cold-start timeout.

**On Modal a model is not a resource.** It is a set of class parameters selecting an
autoscaled pool on first request. Nothing is "created", so nothing is rolled back. The
endpoint ref is a query string, and it is load-bearing: without it the request routes to a
pool with unbound parameters that never serves.

**The GPU tier list is not a ladder.** Memory bandwidth sets decode speed and does not track
VRAM — the L40S has more VRAM than the A100-40GB and less bandwidth; the L4 and A10 have the
same VRAM and differ 2x in speed. Selection is `argmin(price)` over tiers meeting *both* the
VRAM fit and the throughput target. Never sort the list and call it quality; never show it to
a creator as a menu.

**There are two tier catalogs and they are not the same thing.** `supabase/migrations`
(`gpu_tiers` + `solver_config`) is what runs at request time; `tools/modal/tiers.py` is what
the deploy tooling and the Python tests use. A change to solver constants or hardware prices
that lands in only one of them silently makes the two disagree.

**GPU prices come from Modal and are checkable.** `modal billing rates --json` prints the
current published rates. There is no pricing REST API to call at runtime — the rates are
seeded data, so when they move they are updated deliberately, in both catalogs.

**KV math uses the declared `key_length`, not `hidden_size / head_count`,** and hybrid
attention/SSM models only keep a KV cache on the full-attention blocks. Getting either wrong
picks a GPU two tiers too big.

**Smoke tests call the upstream directly, never the gateway** — the gateway needs a key and a
`ready` model, so routing readiness through it is circular. No `usage_transactions` row exists
for a smoke test, and none should: the platform pays for it.

**Throughput is measured over the decode window**, from first token to last — folding
time-to-first-token into the rate reports ~4 tok/s for a worker that decodes at 45.

**Model ids are `creator-handle/model-slug`, case-insensitive, and are not HF repo paths.**
The seeded model happens to coincide with one; that is a coincidence, not an alias.

## Conventions

Comments in this codebase explain **why**, especially where the obvious implementation is
wrong (see the regex note in `upstream.ts`, or the argmin note in `tiers.py`). Match that —
do not add comments that restate the line below them.

Never edit a path another agent owns without saying so; ownership is listed in
`docs/CONTRACTS.md`. `packages/shared` and `tests/fixtures` are contract surfaces.

Secrets are server-only. Nothing secret is ever prefixed `NEXT_PUBLIC_`. `MODAL_KEY` /
`MODAL_SECRET` are **proxy** tokens (`wk-` / `ws-`), not the `ak-`/`as-` API pair — an API
token can delete apps.
