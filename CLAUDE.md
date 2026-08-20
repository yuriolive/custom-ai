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

## Work tracking — beans, not todo lists

**IMPORTANT: before you do anything else, run `beans prime` and heed its output.**

Issues ("beans") live in `.beans/` as one Markdown file each, committed with the code
they describe, managed by the [`beans`](https://github.com/hmans/beans) CLI. They
replace `TodoWrite` and any ad-hoc todo list — a bean survives a context reset and
lands in the same commit as its change, which a scratch list does not.

```bash
beans prime                      # the agent contract — read it before anything else
beans list --json --ready        # what is actually startable (unblocked, not done)
beans show --json <id>           # body, todo items, relationships
beans create --json "T" -t task -s in-progress   # before starting work no bean covers
beans update --json <id> -s completed            # only when no "- [ ]" items remain
beans check                      # validates config + links; run after hand-editing a bean
beans tui                        # interactive board, for humans
```

Install: `brew install hmans/beans/beans`, or `go install github.com/hmans/beans@latest`.
Beans is alpha — its CLI surface can move between releases, so trust `beans <cmd> --help`
over anything memorised, including this file.

`docs/ROADMAP.md` stays the narrative: priority order, the reasoning behind it, and what
was decided against. The beans carry the same work as *state* — status, blockers,
checklists. When the two disagree, the beans are right about status and the roadmap is
right about intent; fix whichever is stale instead of deleting the other.

Bean bodies are prose and are in `.prettierignore`. Never reformat them by hand: the next
`beans update` rewrites the file and the reformat comes back as churn.

## Read before changing anything

| Doc | What it holds |
|---|---|
| `docs/CONTRACTS.md` | **FROZEN** shapes: wire format, ids, money rules, env, path ownership. If it looks wrong, say so — do not silently diverge. |
| `docs/PRD-inference-marketplace-mvp.md` | Requirements, FR-* ids referenced throughout the code comments. |
| `docs/HANDOFF.md` | Current state, measured facts (cold start, decode rate, KV size) worth not re-deriving. |
| `docs/DEPLOY.md` | Which host deploys what, and what is already configured. |
| `docs/ROADMAP.md` | What is left and in which order, and what was decided against. Beans hold the *status* of the same work. |
| `tools/modal/README.md` | How the Modal worker actually serves: class parameters, pools, cold start. |

## Layout

```
.beans/                     Issue tracker — one Markdown file per bean, git-tracked
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
npm run check      # check:env + check:migrations + lint (oxlint + eslint) + typecheck
npm test           # node --test across app, hf-probe, gateway, mock-upstream, keygen, adapter
npm run dev        # Next dev server
```

Python worker tests are stdlib `unittest`, not pytest — `pyproject.toml` declares no
runtime deps and pytest is not installed, so `uv run pytest` fails with "program not
found". Run what CI runs:
`cd tools/modal && uv run --locked python -m unittest test_measure test_tier_drift`.
Postgres invariants are pgTAP under
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
