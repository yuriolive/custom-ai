# custom-ai

An OpenAI-compatible **AI inference marketplace**.

A creator points Studio at a Hugging Face repo; the platform resolves the hardware,
deploys, smoke-tests, and lists the model. A consumer calls it with the stock `openai`
SDK — `base_url` and `api_key` changed, nothing else — and is billed per token from a
prepaid wallet, split 80% creator / 20% platform.

## Calling a model

```python
from openai import OpenAI

client = OpenAI(base_url="<gateway>/v1", api_key="sk-plat-...")
stream = client.chat.completions.create(
    model="jonathancoletti/qwen3.8-27b-uncensored-gguf",
    messages=[{"role": "user", "content": "hi"}],
    stream=True,
    timeout=180,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

Two things that surprise people:

- **Model ids are `creator-handle/model-slug`, not Hugging Face repo paths.** Case does
  not matter — both halves are lowercased before lookup — but names do. The seeded id
  happening to equal an HF path is a coincidence, not an alias.
- **Workers scale to zero, so the first request wakes a GPU.** Budget ~100 s for a cold
  start and keep the client timeout generous; that is why the snippet passes
  `timeout=180`.

## Status

MVP-0 is deployed: the gateway Edge Function is live on Supabase, the llama.cpp worker
is deployed on Modal at $0 idle, migrations are applied, and the web app is on Vercel.
CI is green across its four jobs — node, python, deno and pgTAP — plus ruff and both
formatters; the commands below reproduce each suite locally rather than trusting a
count frozen here. A real billed inference has been verified end to end **locally**
and against an **authenticated** Modal endpoint.

Deployed does **not** yet mean populated: production has zero models, zero users, and
zero API keys, because models can currently only be added by SQL. Creator Studio is the
gap that closes it — see the P0 milestone in the tracker below.

## Local development

Requires Node >= 22.18.

```bash
npm ci
cp .env.example .env.local     # then fill in; nothing secret is ever NEXT_PUBLIC_*
npm run dev                    # http://localhost:3000
```

`.env.example` ships with `UPSTREAM_PROVIDER=mock`, which points the gateway at
`tools/mock-upstream` — a zero-dependency fake SSE upstream. That is the intended way to
work locally and in tests: the full request path, no GPU and no spend.

```bash
npm start -w @custom-ai/mock-upstream    # 127.0.0.1:8787
```

For the database, auth, and the gateway Edge Function, run the Supabase stack the way CI
does — Docker required:

```bash
npx supabase start
npx supabase db reset --local
```

## Commands

```bash
npm run check     # check:env + check:migrations + lint (oxlint + eslint) + typecheck
npm test          # node --test across app, hf-probe, gateway, mock-upstream, keygen, adapter
npm run dev       # Next dev server
npm run build     # production build; `npm run build:local` runs check first
```

Two suites live outside `npm test`:

```bash
cd tools/modal && uv run --locked python -m unittest test_measure test_tier_drift test_supervisor
npx supabase test db --local supabase/tests    # pgTAP; needs `supabase start` first
```

The pgTAP suite is the authority on billing behaviour — a money change that does not
touch it is incomplete.

Lint is not advisory here: oxlint rules like `no-array-sort` are enforced in CI.

## Layout

| Path                          | What lives there                                                        |
| ----------------------------- | ----------------------------------------------------------------------- |
| `app/`                        | Next.js 15 App Router — marketplace, studio, console, playground        |
| `components/`                 | UI (HeroUI v3 + Tailwind v4)                                            |
| `lib/`                        | Server + client app code, including the deployment pipeline and billing |
| `packages/hf-probe/`          | HF repo probe, GGUF header parse, variant classifier                    |
| `packages/anthropic-adapter/` | Anthropic wire shape over the OpenAI gateway                            |
| `packages/shared/`            | Types only, no runtime deps                                             |
| `supabase/migrations/`        | Schema, RLS, RPCs — including the placement solver                      |
| `supabase/functions/gateway/` | The Edge Function serving `/v1/chat/completions`                        |
| `tools/modal/`                | The llama.cpp worker + the Python tier catalog                          |
| `tools/mock-upstream/`        | Fake upstream SSE server, for tests and GPU-free local work             |
| `.beans/`                     | Issue tracker — one Markdown file per issue                             |

## Docs

| Doc                                                                              | What it holds                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md)                                         | **Frozen** shapes: wire format, ids, money rules, env, path ownership     |
| [`docs/PRD-inference-marketplace-mvp.md`](docs/PRD-inference-marketplace-mvp.md) | Requirements, the FR-* ids referenced throughout the code                 |
| [`docs/HANDOFF.md`](docs/HANDOFF.md)                                             | Measured facts — cold start, decode rate, KV size — worth not re-deriving |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                                             | What is left, in which order, and what was decided against                |
| [`docs/DEPLOY.md`](docs/DEPLOY.md)                                               | Which host deploys what, and what is already configured                   |
| [`docs/DESIGN.md`](docs/DESIGN.md) · [`docs/PAYMENTS.md`](docs/PAYMENTS.md)      | Visual language; payment rails including the unbuilt crypto path          |
| [`tools/modal/README.md`](tools/modal/README.md)                                 | How the worker actually serves: class parameters, pools, cold start       |

## Issue tracking

Issues live in [`.beans/`](.beans) as Markdown, managed with
[beans](https://github.com/hmans/beans) and committed alongside the code they describe.

```bash
brew install hmans/beans/beans   # or: go install github.com/hmans/beans@latest
beans list --ready               # what is startable right now
beans tui                        # interactive board
```

`docs/ROADMAP.md` is the narrative — priority order and reasoning. The beans hold the
same work as state: status, blockers, checklists.

## Deploying

Three hosts, and the repo holds **zero** deploy secrets — both Git integrations
authorize via OAuth in their own dashboards.

| Piece                                   | Host     | Deployed by                                       |
| --------------------------------------- | -------- | ------------------------------------------------- |
| Postgres, Auth, `gateway` Edge Function | Supabase | Supabase's GitHub integration, on merge to `main` |
| Next.js web app                         | Vercel   | Vercel's Git integration, on push                 |
| llama.cpp inference worker              | Modal    | `modal deploy` from a workstation                 |

Full runbook, including the verification step that proves a real billed request:
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Contributing with an AI agent

Read [`AGENTS.md`](AGENTS.md) first (Claude Code reads [`CLAUDE.md`](CLAUDE.md), which is
the same guidance in full). Both start the same way: run `beans prime`, then work against
a bean.
