# PRD — Decentralized AI Inference Marketplace & Gateway (MVP)

| Field | Value |
|---|---|
| **Document** | Product Requirements Document — MVP |
| **Codename** | `Nexus` (working title) |
| **Version** | 1.0 |
| **Status** | Approved for Sprint 0 grooming |
| **Date** | 2026-08-17 |
| **Owner** | Principal TPM / Architect |
| **Target GA** | End of Sprint 4 (8 weeks) |

---

## Table of Contents

1. [Executive Summary & Value Proposition](#1-executive-summary--value-proposition)
2. [Target Personas & Core User Flows](#2-target-personas--core-user-flows)
3. [System Architecture & Component Interaction Flow](#3-system-architecture--component-interaction-flow)
4. [Detailed Functional Requirements](#4-detailed-functional-requirements)
5. [Complete PostgreSQL Database Schema](#5-complete-postgresql-database-schema)
6. [Non-Functional & Operational Requirements](#6-non-functional--operational-requirements)
7. [4-Sprint Implementation Roadmap & Milestones](#7-4-sprint-implementation-roadmap--milestones)
8. [Appendices](#8-appendices)

---

## 1. Executive Summary & Value Proposition

### 1.1 Problem Statement

Two populations are blocked by the same infrastructure gap.

**Model creators** — fine-tuners, quantizers, and researchers who publish thousands of derivative checkpoints to Hugging Face weekly — have no path from *artifact* to *revenue*. Publishing weights earns downloads and reputation, never dollars. Self-hosting an inference endpoint requires GPU procurement, container engineering, autoscaling, TLS, auth, metering, and payment rails. The fixed cost of monetizing a single niche model exceeds its expected lifetime revenue, so the model stays a free download and dies in obscurity.

**Application developers** are locked into the intersection of what the three or four large aggregators choose to host. Uncensored models, domain fine-tunes (legal, clinical coding, Solidity), non-English specialists, and experimental quantizations are systematically absent — they lack the volume to justify a slot on a centralized provider's roster. The developer's only alternative is renting a GPU by the hour and eating 100% of idle cost for a workload that is bursty by nature.

### 1.2 Solution

A two-sided marketplace that makes deploying a monetized inference endpoint a **90-second, four-field form**, and consuming any model on the platform a **one-line base-URL change**.

The platform is composed of three products that must ship together to have value:

| Product | What it does |
|---|---|
| **Creator Studio** | Paste a Hugging Face repo slug, declare intent — context window, minimum tokens/sec, quality level — set $/1M-token prices, toggle visibility. **The platform solves for GPU hardware**, provisions a scale-to-zero RunPod Serverless endpoint via GraphQL, verifies real throughput, and registers the model in the catalog. |
| **Inference Gateway** | A single OpenAI-compatible `POST /v1/chat/completions` surface. Any OpenAI SDK works unchanged — swap `baseURL` and `apiKey`. Models are addressed as `creator/model-slug`. |
| **Marketplace & Wallet** | Public catalog with an in-browser Playground, a pre-funded wallet topped up via Stripe Checkout, per-request metering, and automated 80/20 creator payout accounting. |

### 1.3 Value Proposition

**For creators:** *"Turn a Hugging Face repo into a revenue-generating API in 90 seconds. Zero GPUs. Zero DevOps. Zero idle cost. You set the price, you keep 80%."*

**For developers:** *"One API key, one base URL, thousands of models the big providers won't host. Pay per token, never per hour."*

### 1.4 Strategic Wedge: Scale-to-Zero Economics

The platform's defensibility rests on a single unit-economics inversion.

| | Traditional Hosted Endpoint | Nexus (RunPod Serverless, `minWorkers: 0`) |
|---|---|---|
| Idle cost for a 0-QPS model | $0.34–$2.99 / hr, continuous | **$0.00** |
| Monthly floor per model | ~$250–$2,150 | **$0.00** |
| Breakeven volume | Tens of millions of tokens/mo | **First request** |
| Long-tail viability | Economically impossible | Economically default |
| Cost paid by | Creator (fixed) | Consumer (variable, per second of GPU) |

Because idle cost is zero, the platform can host an unbounded long tail of models at **zero marginal carrying cost**. That is a structural advantage a provider running always-warm pools cannot replicate. The tradeoff — a 20–60 second cold start — is a solvable *engineering* problem (§4.2.5, §6.1) rather than an unsolvable *cost* problem, and is the single highest-leverage technical risk in this document.

### 1.5 MVP Scope Boundaries

**In scope:** text chat completions (`/v1/chat/completions`), streaming and non-streaming, public + private models, prepaid wallet, HF public + private (token-gated) repos, 80/20 accrual accounting, single region (US).

**Explicitly out of scope for MVP** — deferred with rationale:

| Deferred | Rationale |
|---|---|
| Creator **payout execution** (Stripe Connect transfers) | Earnings *accrue* in-ledger from day one; manual/automated disbursement is a Phase 2 workflow. Accrual is the hard part and ships in MVP. |
| `/v1/embeddings`, `/v1/completions`, vision, audio | Focus the gateway contract on one surface until cold-start and billing are proven. |
| Postpaid billing / invoicing | Prepaid wallet eliminates credit risk and bad debt entirely for MVP. |
| BYO-cloud / bring-your-own-GPU | RunPod-only keeps the provisioning adapter single-implementation. Interface is abstracted (§6.6) for Phase 2. |
| Multi-region routing, LoRA multiplexing, speculative decoding | Optimizations, not viability requirements. |
| Fine-tuning / training jobs | Different product. |

### 1.6 Success Metrics

| Metric | Target @ 8 weeks (GA) | Instrumentation |
|---|---|---|
| **Time-to-first-token, warm** | p50 < 400 ms · p95 < 900 ms | Gateway span `ttft_ms` |
| **Gateway routing overhead** | p95 < 10 ms (excl. upstream) | `gateway_overhead_ms` = pre-upstream wall time |
| **Cold-start success rate** | > 99.0% of cold requests deliver a first token without client disconnect | `cold_start_outcome` enum |
| **Deploy success rate** | > 90% of Creator Studio submissions reach `status='ready'` unattended | `custom_models.status` funnel |
| **Time-to-deploy** | p50 < 5 min from form submit to first successful Playground token | `ready_at - created_at` |
| **Billing integrity** | **Zero** negative balances · **zero** unbilled completed streams | Nightly reconciliation job (§6.5) |
| **Marketplace liquidity** | 50 public models · 25 paying developers · $5k GMV in month 1 | Catalog + ledger rollup |

---

## 2. Target Personas & Core User Flows

### 2.1 Personas

#### P1 — Maya, the Model Creator (supply side)

| Attribute | Detail |
|---|---|
| **Profile** | ML engineer or independent researcher. Publishes 5–20 fine-tunes/quantizations per year to Hugging Face. 200–5,000 HF followers. |
| **Technical depth** | Expert in training, PEFT, GGUF quantization. **Novice in Kubernetes, autoscaling, TLS, billing systems.** This asymmetry is the entire product thesis. |
| **Job to be done** | "I want my model used and paid for, without becoming an SRE." |
| **Pains** | No monetization path. Self-hosting burns money on idle GPUs. Reputation doesn't pay rent. |
| **Gains sought** | Passive revenue. Usage analytics that prove reach. A shareable, professional-looking model page. |
| **Success signal** | First non-zero earnings row in the Creator Studio ledger. |
| **Anti-goal** | Being asked for a Dockerfile, a YAML manifest, a GPU quota request — **or which GPU to rent.** Maya knows Q4_K_M degrades her model slightly; she does not know whether it fits on an L40S at 100k context, and she should never have to. |

#### P2 — Dev, the Application Developer (demand side)

| Attribute | Detail |
|---|---|
| **Profile** | Full-stack or AI engineer at a startup, or an indie builder. Already ships against the OpenAI SDK. |
| **Technical depth** | Fluent in TypeScript/Python and the OpenAI wire format. Zero interest in GPU orchestration. |
| **Job to be done** | "I need a specific model the big providers won't host, callable with the SDK I already use." |
| **Pains** | Aggregator catalogs lack niche/uncensored/domain models. Renting a GPU by the hour is absurd for 500 requests/day. Every new provider means a new SDK. |
| **Gains sought** | Drop-in OpenAI compatibility. Per-token pricing. Try-before-integrate. Hard spend ceiling. |
| **Success signal** | A working `curl` copied from a model card returns a token stream in under 60 seconds. |
| **Anti-goal** | A bespoke API contract. A surprise invoice. |

#### P3 — Ops, the Platform Operator (internal)

| Attribute | Detail |
|---|---|
| **Profile** | Founding engineer wearing the SRE + trust-and-safety + finance hats. |
| **Job to be done** | "Keep the ledger provably correct, keep margin positive, keep abuse off the platform, with one pair of hands." |
| **Pains** | Silent revenue leakage (unbilled streams). Negative balances. A creator's runaway endpoint burning platform GPU credit. Illegal content on a public catalog. |
| **Gains sought** | A reconciliation job that closes to zero. Per-model cost/margin visibility. A one-click model kill switch. |
| **Success signal** | Nightly reconciliation reports zero drift, unattended, for 14 consecutive days. |

### 2.2 Core User Flows

#### Flow A — Creator Onboarding & Model Deployment (P1)

```
A1  Sign up / sign in                Supabase Auth (GitHub OAuth preferred — HF-adjacent audience)
A2  Claim creator handle             UNIQUE, immutable, ^[a-z0-9][a-z0-9-]{1,38}$  → forms the `creator/` namespace
A3  Open Creator Studio → "New Deployment"
A4  Paste HF repo slug               e.g. JonathanColetti/Qwen3.8-27B-Uncensored-GGUF
A5  Platform probes HF               /api/models/{slug} → gated? private? architecture? which VARIANTS exist?
      ├─ private/gated → prompt for HF read token → encrypted into Supabase Vault (§4.3.2)
      └─ public        → skip
A6  Declare INTENT                   context window + minimum tok/s. NO GPU is chosen (§4.3.3)
A6b Pick quality from a consequence table   one row per quantization: size · resulting speed ·
                                            max context · cost floor. Platform solves hardware.
A7  Set token pricing                $/1M prompt, $/1M completion. UI shows the solver's cost floor + margin
A8  Set visibility                   Switch: Public (catalog) | Private (creator-only)
A9  Submit → status='provisioning'   Edge Function: RunPod saveTemplate → saveEndpoint (minWorkers:0, idleTimeout:30)
A10 Automated smoke test             1-token completion against the new endpoint; charged to platform, not creator
      ├─ pass → status='ready'   → catalog listing goes live (if public)
      └─ fail → status='failed'  → structured error + remediation hint surfaced in Studio
A11 Verify in Playground             Creator's own first-token latency check
A12 Monitor                          Studio analytics: requests, tokens, latency, earnings, error rate
```

**Critical path SLO:** A4 → A10 completes in under 5 minutes p50 with zero creator intervention.

#### Flow B — Developer Discovery → Integration (P2)

```
B1  Browse marketplace (unauthenticated — catalog is public, SEO-indexable)
B2  Search / filter          text query · min speed (tok/s) · min context · quality · price band · creator
B3  Open model card modal    description, pricing table, hardware, latency stats, tokens served
B4  Try in Playground        requires auth; charged to wallet; free trial grant covers first spend
B5  Sign up → wallet is created with a $1.00 promotional grant
B6  Copy snippet             Python / TypeScript / cURL, pre-filled with `creator/model-slug`
B7  Create API key           Console → key shown EXACTLY ONCE (sk-plat-…); only a SHA-256 hash is stored
B8  Top up wallet            Stripe Checkout ($5 / $20 / $100 / custom) → webhook credits balance
B9  Integrate                baseURL swap only; existing OpenAI SDK code is otherwise untouched
B10 Monitor spend            Console: usage ledger, per-key/per-model rollups, low-balance email alert
```

#### Flow C — The Billed Inference Request (system flow, P2 runtime)

```
C1   Client POST /v1/chat/completions           Authorization: Bearer sk-plat-…
C2   Gateway: parse + hash key prefix           SHA-256; single indexed lookup
C3   Gateway: resolve `creator/model-slug`      → runpod_endpoint_id, pricing, visibility, status
C4   Gateway: authorize                         balance ≥ max(min_floor, estimated_max_cost)  → else 402
C5   Gateway: open reservation (hold)           usage_transactions row, status='reserved'
C6   Gateway: proxy upstream to RunPod          stream:true ALWAYS, stream_options.include_usage:true
C7   Gateway: SSE keep-alive during cold start  `: ping` comment every 5 s until first upstream byte
C8   Upstream tokens → tee'd TransformStream    forwarded to client verbatim + usage sniffed in parallel
C9   Final chunk carries usage                  prompt_tokens, completion_tokens
C10  Settle: rpc deduct_token_cost()            SELECT … FOR UPDATE · atomic debit · 80/20 split · status='settled'
C11  Client receives [DONE]
C12  (Sad path) client disconnect / upstream 5xx → settle partial on tokens observed, or void the hold (§6.5)
```

#### Flow D — Wallet Top-Up (P2)

```
D1  Console → "Add funds" → HeroUI Modal, amount preset Chips + custom NumberField
D2  Edge Function creates a Stripe Checkout Session
      metadata: { user_id, idempotency_nonce } ; client_reference_id = user_id
D3  Redirect to Stripe-hosted Checkout          — platform NEVER touches card data (PCI SAQ-A)
D4  Stripe webhook checkout.session.completed → signature verified → rpc credit_wallet()
      UNIQUE constraint on stripe_event_id makes the credit exactly-once under webhook retry
D5  Realtime subscription updates the balance chip in the app header without a page reload
```

---

## 3. System Architecture & Component Interaction Flow

### 3.1 System Architecture (ASCII)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                     CLIENT TIER                                          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   ┌──────────────────────────────────────────┐        ┌──────────────────────────────┐   │
│   │  Next.js 15 App Router  (Vercel Edge)    │        │  3rd-party API consumers     │   │
│   │  ────────────────────────────────────    │        │  ──────────────────────────  │   │
│   │  Tailwind v4 · HeroUI v3 (React Aria)    │        │  openai-python               │   │
│   │  Vercel AI SDK  (useChat / streamText)   │        │  openai-node / ai-sdk        │   │
│   │                                          │        │  LangChain · cURL            │   │
│   │  /                  Marketplace          │        │                              │   │
│   │  /models/[c]/[s]    Model card           │        │  baseURL = <gw>/v1           │   │
│   │  /playground/[...]  Chat sandbox         │        │  apiKey  = sk-plat-…         │   │
│   │  /studio            Creator Studio       │        └──────────────┬───────────────┘   │
│   │  /console           Keys · Usage · Wallet│                       │                   │
│   └───────┬──────────────────────────┬───────┘                       │                   │
└───────────┼──────────────────────────┼───────────────────────────────┼───────────────────┘
            │ supabase-js (RLS, user JWT)│ fetch /v1/… (sk-plat-…)     │
            │                            └──────────────┬─────────────┘
            │                                           │
┌───────────▼───────────────────────────────────────────▼──────────────────────────────────┐
│                              SUPABASE (control + data plane)                             │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  ┌────────────────┐   ┌──────────────────────────────────────────────────────────────┐   │
│  │ Supabase Auth  │   │  EDGE FUNCTIONS  (Deno · globally distributed)                │   │
│  │ ────────────── │   │  ──────────────────────────────────────────────────────────   │   │
│  │ GitHub OAuth   │   │                                                              │   │
│  │ Email magic    │   │  ▸ gateway          POST /v1/chat/completions  ◀── HOT PATH   │   │
│  │ JWT → RLS      │   │       key auth → model resolve → authorize → hold            │   │
│  │ auth.users     │   │       → proxy SSE (keep-alive) → sniff usage → settle        │   │
│  └───────┬────────┘   │  ▸ gateway/models   GET /v1/models  (OpenAI-shaped catalog)  │   │
│          │            │  ▸ deploy-model     RunPod GraphQL provisioning + smoke test │   │
│          │            │  ▸ delete-model     RunPod deleteEndpoint + soft delete      │   │
│          │            │  ▸ stripe-checkout  Checkout Session creation                │   │
│          │            │  ▸ stripe-webhook   sig verify → credit_wallet()             │   │
│          │            │  ▸ reconcile-cron   stale-hold sweeper + ledger drift audit  │   │
│          │            └───────┬───────────────────────────────┬──────────────────────┘   │
│          │                    │ service_role (RLS bypass)     │ GraphQL / REST out       │
│  ┌───────▼────────────────────▼───────────────────────────┐   │                          │
│  │  POSTGRESQL 15  —  Row-Level Security on every table   │   │                          │
│  │  ───────────────────────────────────────────────────   │   │                          │
│  │   profiles            handle, balance_micro_usd         │  │                          │
│  │   api_keys            key_hash (sha256), key_prefix     │  │                          │
│  │   custom_models       hf slug, runpod_endpoint_id,      │  │                          │
│  │                       pricing, visibility, status       │  │                          │
│  │   usage_transactions  reserved → settled ledger         │  │                          │
│  │   wallet_ledger       immutable append-only cash book   │  │                          │
│  │   creator_earnings    80% accrual per creator           │  │                          │
│  │                                                         │  │                          │
│  │   RPC (PL/pgSQL, SECURITY DEFINER):                     │  │                          │
│  │     ▸ authorize_request()    balance gate + hold        │  │                          │
│  │     ▸ deduct_token_cost()    FOR UPDATE · atomic debit  │  │                          │
│  │     ▸ credit_wallet()        idempotent Stripe credit   │  │                          │
│  │     ▸ void_reservation()     release abandoned hold     │  │                          │
│  │                                                         │  │                          │
│  │   Supabase Vault (pgsodium)  encrypted HF tokens        │  │                          │
│  └─────────────────────────────────────────────────────────┘  │                          │
└───────────────────────────────────────────────────────────────┼──────────────────────────┘
                                                                │
                  ┌─────────────────────────────────────────────┴──────────────┐
                  │                                                            │
      ┌───────────▼──────────────────────────────┐            ┌────────────────▼──────────┐
      │  RUNPOD SERVERLESS                       │            │  STRIPE                   │
      │  ──────────────────────────────────────  │            │  ───────────────────────  │
      │  GraphQL  api.runpod.io/graphql          │            │  Checkout Sessions        │
      │    saveTemplate / saveEndpoint /         │            │  Webhooks (signed)        │
      │    deleteEndpoint                        │            │  PCI SAQ-A (hosted page)  │
      │                                          │            └───────────────────────────┘
      │  Inference (OpenAI-compatible passthru): │
      │    /v2/{endpoint_id}/openai/v1/chat/…    │            ┌───────────────────────────┐
      │                                          │            │  HUGGING FACE HUB         │
      │  ┌────────────────────────────────────┐  │  weights   │  ───────────────────────  │
      │  │ Worker container (scale-to-zero)   │◀─┼────────────│  /api/models/{slug}       │
      │  │  vLLM  (safetensors / AWQ / GPTQ)  │  │            │  metadata · gated · size  │
      │  │  llama.cpp server (GGUF)           │  │            │  private repos via token  │
      │  │  workersMin: 0  ·  idleTimeout: 30s│  │            └───────────────────────────┘
      │  │  GPU: 4090 24G | L40S 48G | H100   │  │
      │  └────────────────────────────────────┘  │
      └──────────────────────────────────────────┘
```

### 3.2 Component Interaction Flow — Billed Streaming Request

```
Client        Gateway (Deno Edge)         Postgres              RunPod Serverless
  │                   │                      │                        │
  ├─ POST /v1/chat ──▶│                      │                        │
  │   Bearer sk-plat  │                      │                        │
  │                   ├─ sha256(key) ───────▶│                        │
  │                   │◀─ key row + model row ┤  ◀── single JOIN, one round trip
  │                   │   (≤3 ms, indexed)   │                        │
  │                   │                      │                        │
  │                   ├─ authorize_request ─▶│  balance ≥ floor?      │
  │                   │                      │  INSERT hold (reserved)│
  │                   │◀─ txn_id ────────────┤                        │
  │                   │  ── 402 if short ──▶ │  (fail fast, no upstream call)
  │                   │                      │                        │
  │◀─ 200 + SSE hdrs ─┤   ◀── headers flushed IMMEDIATELY: the client's socket is
  │   Content-Type:   │        alive before the GPU exists. This is what makes a
  │   text/event-stream        60 s cold start survivable.
  │                   │                      │                        │
  │                   ├─ POST /openai/v1/chat/completions ───────────▶│
  │                   │     stream:true, stream_options.include_usage │
  │◀─ ": ping"  ······┤   every 5 s while upstream is silent          ├─ COLD: pull image,
  │◀─ ": ping"  ······┤                                              │  load weights,
  │◀─ ": ping"  ······┤                                              │  init CUDA graphs
  │                   │                      │        20–60 s        │  (20–60 s)
  │                   │◀───── first SSE chunk ───────────────────────┤ ◀── WARM: 200–400 ms
  │◀─ data: {delta} ──┤   TransformStream tee: forward ‖ accumulate  │
  │◀─ data: {delta} ──┤                                              │
  │        ⋮          │                                              │
  │                   │◀───── final chunk: {usage:{prompt,completion}}┤
  │                   ├─ deduct_token_cost ─▶│  BEGIN                 │
  │                   │                      │   SELECT … FOR UPDATE  │  ◀── row lock:
  │                   │                      │   balance -= cost      │  serializes concurrent
  │                   │                      │   GREATEST(0,…) guard  │  requests per user
  │                   │                      │   creator += 80%       │
  │                   │                      │   platform += 20%      │
  │                   │                      │   hold → 'settled'     │
  │                   │◀─ new_balance ───────┤  COMMIT                │
  │◀─ data: [DONE] ───┤                      │                        │
  │                   │                      │                        │
  │       (idle 30 s with no further traffic) │                       │
  │                   │                      │      ◀── RunPod scales worker to ZERO.
  │                   │                      │          Cost to creator and platform: $0.00
```

**Design invariant — headers-first streaming.** Response headers are flushed to the client *before* the upstream request is issued. Without this, a 45-second cold start would exceed the default idle timeout of most HTTP clients, CDNs, and reverse proxies, producing a client-side abort on a request that was in fact healthy. Every downstream design decision in §4.2 follows from this invariant.

### 3.3 Trust Boundaries

| Boundary | Crossing | Control |
|---|---|---|
| Browser → Postgres | `supabase-js` with user JWT | **RLS enforced.** Anon key only. No privileged operation is reachable from the client. |
| Browser → Edge Function | user JWT (app) or `sk-plat-…` (API) | Function verifies JWT via `auth.getUser()`, or hashes and looks up the API key. |
| Edge Function → Postgres | `service_role` key | RLS bypassed. Key lives only in Supabase function secrets, never in `NEXT_PUBLIC_*`. |
| Edge Function → RunPod | platform `RUNPOD_API_KEY` | Single platform-owned credential. Creators never see or supply RunPod credentials. |
| Edge Function → HF | per-model creator token | Decrypted from Vault at provisioning time only. Never logged, never returned by any API. |
| Stripe → Edge Function | `Stripe-Signature` header | `constructEventAsync` verification is mandatory; unsigned bodies are rejected with 400. |

---

## 4. Detailed Functional Requirements

Priority key: **P0** = MVP blocker · **P1** = MVP target, descopable under schedule pressure · **P2** = Phase 2.

### 4.1 Frontend — Marketplace, Studio, Playground, Console (HeroUI v3)

#### 4.1.0 HeroUI v3 Implementation Constraints (binding)

HeroUI v3 is a **breaking rewrite** of NextUI/HeroUI v2. Any engineer or code generator working from v2 knowledge will produce non-compiling code. These constraints are normative for every component in §4.1.

| Concern | v2 (must NOT be used) | v3 (required) |
|---|---|---|
| Provider | `<HeroUIProvider>` wrapper | **No provider.** Remove it entirely. |
| Component API | Flat props — `<Card title="x" />` | **Compound** — `<Card><Card.Header><Card.Title/>…` |
| Styling engine | Tailwind v3 + `@heroui/theme` | **Tailwind v4** + `@heroui/styles` |
| Packages | `@heroui/system`, `@heroui/theme` | `@heroui/react`, `@heroui/styles`, `tailwind-variants` |
| Animation | `framer-motion` dependency | CSS-driven; no extra dependency |
| Click handler | `onClick` | **`onPress`** (React Aria) |
| Variant vocabulary | visual (`flat`, `bordered`, `shadow`) | semantic (`primary`, `secondary`, `tertiary`, `danger`, `ghost`, `outline`) |
| Theming | JS theme object | CSS variables in `oklch()` |

```css
/* app/globals.css — import order is load-bearing */
@import "tailwindcss";   /* MUST be first */
@import "@heroui/styles"; /* MUST follow Tailwind */
```

> **`@heroui/react` is client-only.** The package barrel pulls in `react-aria-components`'
> Toast, which carries the `client-only` marker. Importing *anything* from `@heroui/react`
> into a React Server Component fails the build outright:
> `'client-only' cannot be imported from a Server Component module`.
>
> Every HeroUI surface must therefore sit behind a `"use client"` boundary. This does
> **not** weaken FR-MKT-006 (SSR + SEO for the public catalog): Next.js still renders
> client components to HTML on the server, so the catalog remains indexable. What it
> dictates is the composition — a Server Component does the data fetching and passes
> plain serializable props down to a client component that renders the HeroUI tree.
> Never reach for HeroUI inside a module that also touches secrets or the database.

```
FR-UI-000 (P0)  Tailwind CSS v4 + @tailwindcss/postcss configured. HeroUI v3 does not
                function on Tailwind v3.
FR-UI-001 (P0)  No <HeroUIProvider> anywhere in the tree.
FR-UI-002 (P0)  All interactive handlers use onPress. ESLint rule bans onClick on
                HeroUI components.
FR-UI-003 (P0)  Dark/light theming via `class="dark" data-theme="dark"` on <html>,
                with suppressHydrationWarning on <html> in the root layout.
FR-UI-004 (P1)  Semantic variants only. A lint rule rejects raw color utilities on
                HeroUI variant props.
```

**Verified v3 component anatomies used by this PRD** (verified against `@heroui/react` **3.2.4** as installed — an earlier revision of this document cited 3.0.5):

| Component | Required composition |
|---|---|
| `Card` | `Card.Header` › `Card.Title` + `Card.Description`, `Card.Content`, `Card.Footer` |
| `Modal` | `Modal.Backdrop` › `Modal.Container` › `Modal.Dialog` › `Modal.CloseTrigger`, `Modal.Header` › `Modal.Icon` + `Modal.Heading`, `Modal.Body`, `Modal.Footer` |
| `Table` | `Table.ScrollContainer` › `Table.Content` › `Table.Header` › `Table.Column`, `Table.Body` › `Table.Row` › `Table.Cell`, `Table.Footer` |
| `TextField` | `Label`, `Input`, `Description`, `FieldError` |
| `InputGroup` | inside `TextField`: `InputGroup.Prefix`, `InputGroup.Input` \| `InputGroup.TextArea`, `InputGroup.Suffix` |
| `Select` | `Label`, `Select.Trigger` › `Select.Value` + `Select.Indicator`, `Select.Popover` › `ListBox` › `ListBox.Item` |
| `Switch` | `Switch.Control` › `Switch.Thumb` › `Switch.Icon`, `Switch.Content` › `Label` + `Description` |
| `Slider` | `Label`, `Slider.Output`, `Slider.Track` › `Slider.Fill` + `Slider.Thumb` |
| `Tabs` | `Tabs.ListContainer` › `Tabs.List` › `Tabs.Tab` › `Tabs.Indicator`, `Tabs.Panel` |
| `Dropdown` | `Dropdown.Trigger` › `Button`, `Dropdown.Popover` › `Dropdown.Menu` › `Dropdown.Item` |
| `Badge` | `Badge.Anchor` wrapping the anchored element + `Badge` (standalone labels use `Chip`) |
| `Chip` | plain-text children auto-wrap in `Chip.Label`. **Two independent axes**: `color` is `default \| accent \| success \| warning \| danger`, `variant` is `primary \| secondary \| tertiary \| soft`. One prop does not carry both. |
| `Alert` | `Alert.Indicator` (optional) + **`Alert.Content`** › `Alert.Title` + `Alert.Description`. The prop is **`status`** (`default \| accent \| success \| warning \| danger`) — there is **no** `variant` and **no** `color` on Alert. Title/Description must not be direct children of `Alert`. |
| `ProgressBar` | **Compound, not a leaf**: `ProgressBar.Track` › `ProgressBar.Fill`, plus optional `ProgressBar.Output`. A self-closed `<ProgressBar />` renders an empty shell. |
| `TextArea` | A primitive `<textarea>`. Takes standard HTML attributes plus `rows`, `fullWidth`, `variant`. **No `minRows` / `maxRows`** — auto-grow must be implemented manually via `scrollHeight` in a layout effect. |
| `Button` | Semantic variants as shipped: `primary \| secondary \| tertiary \| outline \| ghost \| danger \| danger-soft` |
| `Autocomplete` | `Autocomplete.Trigger`, `Autocomplete.Popover` › `Autocomplete.Filter` › `SearchField` + `ListBox` |

#### 4.1.1 Public Marketplace — `/`

```
FR-MKT-001 (P0)  Responsive grid of model cards. 1 col mobile / 2 tablet / 3–4 desktop.
FR-MKT-002 (P0)  Card content: creator/slug title, truncated description (2 lines),
                 MEASURED speed Chip (tok/s), context-window Chip, quality-label Chip,
                 prompt+completion price Chips, "Try" + "Code" actions in Card.Footer.
                 NO GPU NAME APPEARS. A developer cares that it runs at 90 tok/s with a
                 100k window; which silicon delivers that is the platform's problem.
                 Speed shown is measured, never predicted (FR-DEP-053).
FR-MKT-003 (P0)  Debounced (300 ms) full-text search over name, slug, description,
                 creator handle. Postgres GIN tsvector index — never client-side filtering.
FR-MKT-004 (P0)  Filter rail is CAPABILITY-based, matching how a developer actually
                 shops: minimum speed (tok/s), minimum context window, quality level,
                 price band, creator. Filters are URL search params (shareable +
                 back-button safe). GPU tier is not a filter and is not displayed.
FR-MKT-005 (P0)  Cursor pagination, 24 per page. `Skeleton` cards during fetch —
                 never a bare spinner on the primary surface.
FR-MKT-006 (P0)  Catalog is readable UNAUTHENTICATED and server-rendered for SEO.
                 Public models only; enforced by RLS, not by client filtering.
FR-MKT-007 (P0)  Model card Modal with Tabs: Overview | Pricing | Code | Stats.
FR-MKT-008 (P0)  Code tab: Tabs for Python / TypeScript / cURL, syntax-highlighted,
                 copy button with Toast confirmation, model id pre-filled.
FR-MKT-009 (P1)  Live status Chip: ready (success) | cold (warning) | error (danger),
                 driven by a Supabase Realtime subscription on custom_models.
FR-MKT-010 (P1)  Sort: newest · most tokens served · lowest price · lowest p50 latency.
FR-MKT-011 (P1)  Empty state and zero-results state with a "Deploy your own" CTA.
```

```tsx
// components/marketplace/ModelCard.tsx — HeroUI v3 compound composition
import { Card, Chip, Button } from "@heroui/react";

export function ModelCard({ model, onTry, onCode }: ModelCardProps) {
  return (
    <Card className="flex h-full flex-col">
      <Card.Header>
        <Card.Title className="truncate font-mono text-sm">
          {model.creator_handle}/{model.slug}
        </Card.Title>
        <Card.Description className="line-clamp-2">
          {model.description}
        </Card.Description>
      </Card.Header>

      {/* Capability, not hardware. No GPU name appears anywhere on this card. */}
      <Card.Content className="flex flex-wrap gap-2">
        <Chip size="sm" variant="soft" color="accent">
          {model.measured_tokens_per_second} tok/s
        </Chip>
        <Chip size="sm" variant="soft">{fmtCtx(model.context_length)} ctx</Chip>
        <Chip size="sm" variant="soft">{qualityLabel(model.variant_quant_tag)}</Chip>
        <Chip size="sm" variant="secondary">
          ${fmtPrice(model.price_prompt_micro_usd_per_mtoken)}/M in
        </Chip>
        <Chip size="sm" variant="secondary">
          ${fmtPrice(model.price_completion_micro_usd_per_mtoken)}/M out
        </Chip>
      </Card.Content>

      <Card.Footer className="mt-auto gap-2">
        <Button variant="primary"   size="sm" onPress={() => onTry(model)}>Try</Button>
        <Button variant="secondary" size="sm" onPress={() => onCode(model)}>Code</Button>
      </Card.Footer>
    </Card>
  );
}
```

```tsx
// components/marketplace/SnippetModal.tsx — Modal + Tabs, v3 anatomy
import { Modal, Tabs, Button } from "@heroui/react";

export function SnippetModal({ model }: { model: Model }) {
  const id = `${model.creator_handle}/${model.slug}`;
  return (
    <Modal>
      <Button variant="secondary" size="sm">Code</Button>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog size="lg">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Call {id}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <Tabs defaultSelectedKey="python">
                <Tabs.ListContainer>
                  <Tabs.List aria-label="Language">
                    <Tabs.Tab id="python">Python<Tabs.Indicator /></Tabs.Tab>
                    <Tabs.Tab id="ts">TypeScript<Tabs.Indicator /></Tabs.Tab>
                    <Tabs.Tab id="curl">cURL<Tabs.Indicator /></Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
                <Tabs.Panel id="python"><CodeBlock code={pySnippet(id)} /></Tabs.Panel>
                <Tabs.Panel id="ts"><CodeBlock code={tsSnippet(id)} /></Tabs.Panel>
                <Tabs.Panel id="curl"><CodeBlock code={curlSnippet(id)} /></Tabs.Panel>
              </Tabs>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
```

**Snippet templates** (`FR-MKT-008`) — must be copy-paste runnable with only a key substitution:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<project>.supabase.co/functions/v1/gateway/v1",
    api_key="sk-plat-...",
)

stream = client.chat.completions.create(
    model="JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    messages=[{"role": "user", "content": "Explain scale-to-zero GPU inference."}],
    stream=True,
    timeout=120,  # first call may cold-start a GPU worker (20-60s)
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://<project>.supabase.co/functions/v1/gateway/v1",
  apiKey: process.env.NEXUS_API_KEY,   // sk-plat-...
  timeout: 120_000,                    // survive cold start
});

const stream = await client.chat.completions.create({
  model: "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
  messages: [{ role: "user", content: "Explain scale-to-zero GPU inference." }],
  stream: true,
});

for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

```bash
curl -N https://<project>.supabase.co/functions/v1/gateway/v1/chat/completions \
  -H "Authorization: Bearer $NEXUS_API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 180 \
  -d '{
    "model": "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    "messages": [{"role":"user","content":"Explain scale-to-zero GPU inference."}],
    "stream": true
  }'
```

#### 4.1.2 Creator Studio — `/studio`

```
FR-STU-001 (P0)  Deployment form (HeroUI Form): HF repo slug, display name, description,
                 context-window Slider, minimum-speed Slider, quality variant table,
                 prompt price, completion price, visibility Switch, optional HF token
                 (private repos). NO GPU selector.
FR-STU-002 (P0)  Live HF validation on slug blur: exists? gated? private? total weight
                 bytes? format? Result rendered as an inline Alert, not a Toast.
FR-STU-003 (P0)  HF token field appears CONDITIONALLY (repo private/gated) as a masked
                 Input with an InputGroup.Suffix reveal ToggleButton.
FR-STU-004 (P0)  NO GPU SELECTOR EXISTS. The creator sets three intent inputs —
                 context window, minimum speed (tok/s), and quality variant — and the
                 solver (§4.3.3.3) resolves hardware. Hardware appears only as a
                 read-only result inside the Deployment Plan card (FR-STU-004b).
FR-STU-004a (P0) Variant picker is a CONSEQUENCE TABLE, not a filename Select. One row
                 per discovered variant: Quality label · size · resolved GPU · predicted
                 tok/s · max context at that size · cost floor per 1M tokens. Rows that
                 violate the creator's speed/context constraints are disabled and carry
                 the specific blocking reason. Default selection = the recommended
                 variant (Q4_K_M-class, or the repo's only variant).
                 Raw quant tags (Q4_K_M) are shown as secondary disclosure, never as the
                 primary label.
FR-STU-004b (P0) Deployment Plan card, live-updating on every input change: resolved GPU,
                 predicted tok/s, max concurrent streams, VRAM breakdown
                 (weights / KV cache / overhead), and cost floor per 1M tokens.
                 A "Why this GPU?" Disclosure reveals the solver's rationale in plain
                 language. The card is the creator's entire window into hardware.
FR-STU-004c (P0) Context Slider is capped at max_position_embeddings and annotates the
                 KV-cache cost of the current value. Because KV cache collapses
                 concurrency (§4.3.3.4), moving this Slider must visibly move the cost
                 floor — that feedback is the point.
FR-STU-004d (P0) Infeasible combinations render an Alert naming the specific blocking
                 quantity with its value, plus the offered remedies from §4.3.3.5.
                 Submit is blocked only when no variant is feasible.
FR-STU-005 (P0)  Price inputs are NumberFields, step 0.01, min 0. A live panel shows the
                 solver's cost floor per 1M tokens and the creator's implied margin.
                 A price below the cost floor renders a warning Alert but is NOT blocked —
                 creators may subsidize deliberately.
FR-STU-006 (P0)  Visibility Switch with Description explaining catalog discoverability.
FR-STU-007 (P0)  Submit → optimistic 'provisioning' row + a ProgressBar stepper:
                 Validating → Creating template → Creating endpoint → Smoke test → Ready.
FR-STU-008 (P0)  Realtime status updates; terminal failure shows the RunPod/HF error
                 verbatim plus a plain-language remediation hint.
FR-STU-009 (P0)  "My Models" Table: model, status Chip, requests 24h, tokens 30d,
                 earnings 30d, actions Dropdown (Edit pricing · Toggle visibility ·
                 Playground · Delete).
FR-STU-010 (P0)  Delete is guarded by an AlertDialog requiring the slug to be typed.
                 Deletes the RunPod endpoint and SOFT-deletes the model row —
                 usage_transactions must never be orphaned.
FR-STU-011 (P1)  Analytics: 30-day token-volume chart, earnings chart, p50/p95 TTFT,
                 error-rate, cold-start ratio.
FR-STU-012 (P1)  Earnings summary Card: accrued · lifetime · pending payout, with an
                 explicit "payouts begin Phase 2" Alert to set expectations.
FR-STU-013 (P1)  Pricing edits are versioned; in-flight requests bill at the price
                 captured at request start (snapshot on the transaction row).
```

```tsx
// app/studio/new/DeployForm.tsx — v3 Form / TextField / Slider / Switch
// NOTE: there is deliberately no GPU <Select> here. Hardware is solved, not chosen.
import {
  Form, TextField, Label, Input, Description, FieldError,
  Slider, Switch, NumberField, Button, InputGroup, ToggleButton,
  Card, Chip, Alert, Disclosure,
} from "@heroui/react";

export function DeployForm() {
  const [probe, setProbe] = useState<HfProbe | null>(null);

  return (
    <Form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <TextField name="hf_repo_slug" isRequired>
        <Label>Hugging Face repository</Label>
        <Input placeholder="JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"
               onBlur={(e) => probeHf(e.currentTarget.value).then(setProbe)} />
        <Description>owner/repo — GGUF or safetensors weights.</Description>
        <FieldError />
      </TextField>

      {probe?.requiresAuth && (
        <TextField name="hf_token" isRequired type={reveal ? "text" : "password"}>
          <Label>Hugging Face read token</Label>
          <InputGroup>
            <InputGroup.Input placeholder="hf_..." />
            <InputGroup.Suffix>
              <ToggleButton isSelected={reveal} onChange={setReveal} aria-label="Reveal token">
                <EyeIcon />
              </ToggleButton>
            </InputGroup.Suffix>
          </InputGroup>
          <Description>
            Encrypted at rest in Supabase Vault. Used only to pull weights at cold start.
            Never returned by any API.
          </Description>
        </TextField>
      )}

      {/* ── Intent, not hardware. No GPU selector exists on this form. ────────── */}
      <Slider value={contextLength} onChange={setContextLength}
              minValue={2048} maxValue={probe?.maxPositionEmbeddings ?? 32768} step={2048}>
        <Label>Context window</Label>
        <Slider.Output>{fmtCtx(contextLength)} tokens</Slider.Output>
        <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        <Description>
          KV cache at this window: {fmtGB(plan?.kvBytes)} — the dominant cost driver
          past ~32k.
        </Description>
      </Slider>

      <Slider value={targetTokS} onChange={setTargetTokS}
              minValue={10} maxValue={200} step={10}>
        <Label>Minimum speed</Label>
        <Slider.Output>{targetTokS} tokens/sec per stream</Slider.Output>
        <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
      </Slider>

      {/* Quality: a consequence table, not a dropdown of cryptic filenames. */}
      <VariantTable
        variants={probe?.variants ?? []}
        contextLength={contextLength}
        targetTokS={targetTokS}
        selected={variantId}
        onSelect={setVariantId}
      />

      {/* The creator's ENTIRE window into hardware: read-only, derived, explained. */}
      <DeploymentPlanCard plan={plan} />
      <div className="grid grid-cols-2 gap-4">
        <NumberField name="price_prompt" minValue={0} step={0.01} formatOptions={USD} isRequired>
          <Label>Prompt price · $ / 1M tokens</Label>
          <Input />
          <Description>Cost floor ${fmtPrice(plan?.costFloorMicroPerMtoken)}/M</Description>
        </NumberField>
        <NumberField name="price_completion" minValue={0} step={0.01} formatOptions={USD} isRequired>
          <Label>Completion price · $ / 1M tokens</Label>
          <Input />
          <Description>Cost floor ${fmtPrice(plan?.costFloorMicroPerMtoken)}/M</Description>
        </NumberField>
      </div>

      <Switch name="is_public" defaultSelected>
        <Switch.Control><Switch.Thumb /></Switch.Control>
        <Switch.Content>
          <Label>Public</Label>
          <Description>Listed in the marketplace catalog and callable by any developer.
            Private models are callable only with your own API keys.</Description>
        </Switch.Content>
      </Switch>

      <Button type="submit" variant="primary"
              isDisabled={!plan?.feasible} isPending={isSubmitting}>
        Deploy model
      </Button>
    </Form>
  );
}

// ── The plan card. Hardware is a RESULT here, never an input. ────────────────
function DeploymentPlanCard({ plan }: { plan: Placement | null }) {
  if (!plan?.feasible) {
    return (
      <Alert variant="soft" color="danger">
        <Alert.Title>{plan?.blockingReason ?? "No feasible configuration"}</Alert.Title>
        <Alert.Description>{plan?.remedyText}</Alert.Description>
      </Alert>
    );
  }
  return (
    <Card variant="secondary">
      <Card.Header>
        <Card.Title>Deployment plan</Card.Title>
        <Card.Description>Resolved automatically from your settings.</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Chip variant="soft" color="accent">{plan.gpuLabel}</Chip>
          <Chip variant="soft">~{plan.predictedTokS} tok/s</Chip>
          <Chip variant="soft">{plan.maxConcurrent} concurrent streams</Chip>
          <Chip variant="secondary">floor ${fmtPrice(plan.costFloorMicroPerMtoken)}/M</Chip>
        </div>
        <Disclosure>
          <Disclosure.Trigger>Why this GPU?</Disclosure.Trigger>
          <Disclosure.Panel>
            <VramBreakdown
              weights={plan.weightsBytes}
              kv={plan.kvBytes}
              overhead={plan.overheadBytes}
              usable={plan.usableVramBytes}
            />
            <p>{plan.rationaleText}</p>
          </Disclosure.Panel>
        </Disclosure>
      </Card.Content>
    </Card>
  );
}
```

#### 4.1.3 Model Playground — `/playground/[creator]/[slug]`

```
FR-PLAY-001 (P0)  Chat UI on the Vercel AI SDK `useChat` transport, pointed at a
                  Next.js route handler that forwards to the gateway with the user's
                  session-scoped ephemeral key.
FR-PLAY-002 (P0)  Composer: HeroUI TextArea, auto-grow to 8 rows, Enter sends /
                  Shift+Enter newlines, Send Button disabled while streaming.
                  NOTE: v3 TextArea exposes no minRows/maxRows — auto-grow is manual
                  (measure scrollHeight in a layout effect, clamp to 8 rows).
FR-PLAY-002a (P0) Server-side route handler note: `convertToModelMessages` is ASYNC in
                  AI SDK v5+ and returns a Promise. Forgetting to await it yields a
                  Promise where the model messages are expected, and the failure
                  surfaces far from its cause.
FR-PLAY-003 (P0)  Parameter rail (Sliders): temperature 0–2 (0.05), top_p 0–1 (0.01),
                  max_tokens 1–8192, plus a system-prompt TextArea.
FR-PLAY-004 (P0)  Streaming render with a caret pulse. During cold start show a
                  "Waking GPU — first request can take up to 60s" Alert plus an
                  indeterminate ProgressBar; the copy must be explicit, because
                  unexplained 45 s of silence reads as a broken product.
FR-PLAY-005 (P0)  Per-turn cost footer: prompt tokens, completion tokens, $ charged,
                  TTFT ms, tok/s. Renders as Chips under the assistant message.
FR-PLAY-006 (P0)  Live wallet balance Chip in the header via Realtime. Balance 0 →
                  composer disabled + "Top up" CTA opening the Stripe modal.
FR-PLAY-007 (P1)  Stop-generation Button aborting the fetch (AbortController).
                  Aborted turns still settle on tokens already delivered.
FR-PLAY-008 (P1)  Copy-message, regenerate, clear-conversation actions.
FR-PLAY-009 (P1)  Error surfaces as a danger Alert inline in the thread, retaining the
                  user's input so it is not lost.
```

```tsx
// app/playground/[creator]/[slug]/Chat.tsx — Vercel AI SDK + HeroUI v3
// "use client" is MANDATORY: @heroui/react is client-only (see §4.1.0).
"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { TextArea, Slider, Label, Button, Chip, Alert, ProgressBar } from "@heroui/react";

export function Playground({ modelId }: { modelId: string }) {
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);

  // AI SDK v5+ (`ai` v7 / `@ai-sdk/react` v4): useChat no longer owns input state and
  // returns no handleInputChange/handleSubmit. The endpoint moves to a transport, and
  // per-turn parameters ride on sendMessage's second argument.
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/playground" }),
  });

  const send = () => {
    if (!input.trim()) return;
    sendMessage({ text: input }, { body: { modelId, temperature, maxTokens } });
    setInput("");
  };

  const isCold = status === "submitted";  // sent, no first token yet

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div className="flex flex-col gap-4">
        {isCold && (
          // Alert takes `status`, NOT variant/color, and Title/Description must sit
          // inside Alert.Content. ProgressBar is a SIBLING of Description, never a
          // child — Alert.Description renders a <p>, which cannot legally contain it.
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Waking GPU worker</Alert.Title>
              <Alert.Description>
                This model scales to zero when idle. The first request can take up to
                two minutes; subsequent requests respond in under a second.
              </Alert.Description>
              <ProgressBar isIndeterminate aria-label="Cold start progress">
                <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
              </ProgressBar>
            </Alert.Content>
          </Alert>
        )}

        <MessageList messages={messages} />

        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2">
          {/* TextArea is a primitive <textarea>: no minRows/maxRows. Auto-grow to 8
              rows is manual — measure scrollHeight in a layout effect and set height. */}
          <TextArea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            placeholder="Message the model…"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          {status === "streaming"
            ? <Button variant="danger"  onPress={stop}>Stop</Button>
            : <Button variant="primary" type="submit">Send</Button>}
        </form>
      </div>

      <aside className="flex flex-col gap-6">
        <Slider value={temperature} onChange={setTemperature}
                minValue={0} maxValue={2} step={0.05}>
          <Label>Temperature</Label>
          <Slider.Output />
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>

        <Slider value={maxTokens} onChange={setMaxTokens}
                minValue={1} maxValue={8192} step={1}>
          <Label>Max tokens</Label>
          <Slider.Output />
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>
      </aside>
    </div>
  );
}
```

#### 4.1.4 Developer Console & Billing — `/console`

```
FR-CON-001 (P0)  API keys Table: name, prefix (sk-plat-xxxxxxxx…), created, last used,
                 status Chip. Actions Dropdown: rename · revoke.
FR-CON-002 (P0)  Create-key Modal → full key shown ONCE in a monospace read-only field
                 with a copy Button and a danger Alert: "This is the only time this key
                 will be shown." Only a SHA-256 hash is persisted.
FR-CON-003 (P0)  Revoke via AlertDialog. Revocation is immediate (soft delete +
                 revoked_at); the gateway rejects revoked keys with 401.
FR-CON-004 (P0)  Usage ledger Table: timestamp, model, key, prompt/completion tokens,
                 cost, status Chip (settled | reserved | voided | failed), latency.
                 Cursor-paginated, filterable by model / key / date range.
FR-CON-005 (P0)  Wallet Card: balance (large, Realtime-bound), 30-day spend, "Add funds".
FR-CON-006 (P0)  Top-up Modal: amount preset Chips ($5/$20/$100) + custom NumberField
                 (min $5, max $500 MVP) → Stripe Checkout redirect.
FR-CON-007 (P0)  Stripe return handling: /console?topup=success → poll/subscribe until
                 the webhook credit lands, then Toast. Never trust the redirect alone
                 as proof of payment — the webhook is the source of truth.
FR-CON-008 (P1)  CSV export of the usage ledger for a selected date range.
FR-CON-009 (P1)  Low-balance threshold NumberField → email alert.
FR-CON-010 (P2)  Per-key spend caps and per-key model allowlists.
```

```tsx
// app/console/keys/KeyTable.tsx — v3 Table anatomy
import { Table, Chip, Dropdown, Button, Label } from "@heroui/react";

export function KeyTable({ keys }: { keys: ApiKey[] }) {
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label="API keys">
          <Table.Header>
            <Table.Column isRowHeader>Name</Table.Column>
            <Table.Column>Key</Table.Column>
            <Table.Column>Created</Table.Column>
            <Table.Column>Last used</Table.Column>
            <Table.Column>Status</Table.Column>
            <Table.Column aria-label="Actions" />
          </Table.Header>
          <Table.Body renderEmptyState={() => <EmptyKeys />}>
            {keys.map((k) => (
              <Table.Row key={k.id}>
                <Table.Cell>{k.name}</Table.Cell>
                <Table.Cell className="font-mono text-xs">{k.key_prefix}…</Table.Cell>
                <Table.Cell>{fmtDate(k.created_at)}</Table.Cell>
                <Table.Cell>{k.last_used_at ? fmtRel(k.last_used_at) : "Never"}</Table.Cell>
                <Table.Cell>
                  <Chip size="sm" variant="soft" color={k.revoked_at ? "danger" : "success"}>
                    {k.revoked_at ? "Revoked" : "Active"}
                  </Chip>
                </Table.Cell>
                <Table.Cell>
                  <Dropdown>
                    <Dropdown.Trigger>
                      <Button variant="ghost" size="sm" aria-label="Key actions"><DotsIcon /></Button>
                    </Dropdown.Trigger>
                    <Dropdown.Popover>
                      <Dropdown.Menu>
                        <Dropdown.Item onAction={() => rename(k)}><Label>Rename</Label></Dropdown.Item>
                        <Dropdown.Item onAction={() => revoke(k)}><Label>Revoke</Label></Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
```

### 4.2 Inference Gateway — `POST /v1/chat/completions`

Deployed as the Supabase Edge Function `gateway` (Deno). This is the only hot path in the system and the only component with a latency SLO.

#### 4.2.1 Contract

| Item | Specification |
|---|---|
| Route | `POST /functions/v1/gateway/v1/chat/completions` |
| Also | `GET /functions/v1/gateway/v1/models` — OpenAI-shaped catalog listing |
| Auth | `Authorization: Bearer sk-plat-<43 url-safe base64 chars>` |
| Request body | OpenAI Chat Completions object. `model` = `creator/model-slug`. |
| Honored params | `messages`, `stream`, `stream_options`, `temperature`, `top_p`, `top_k`, `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `seed`, `n` (must be 1 in MVP), `response_format` (passthrough) |
| Rejected | `tools`/`functions` (501 — Phase 2), `n > 1` (400), `logprobs` (400) |
| Response | Byte-compatible OpenAI `chat.completion` or `chat.completion.chunk` SSE stream |
| CORS | `POST, GET, OPTIONS`; `Authorization, Content-Type` allowed; browser-direct calls permitted |

```
FR-GW-001 (P0)  Wire-format fidelity: an unmodified OpenAI SDK must work with only a
                baseURL + apiKey change. Any field the SDK reads must be present with
                OpenAI's exact name, type, and nesting.
FR-GW-002 (P0)  Model addressing: `creator/model-slug` → (creator handle, model slug).
                A slug containing no "/" is a 400 with a message naming the correct form.
FR-GW-003 (P0)  Errors use the OpenAI error envelope:
                { "error": { "message", "type", "param", "code" } }
FR-GW-004 (P0)  GET /v1/models returns { object: "list", data: [{ id: "creator/slug",
                object: "model", created, owned_by: creator_handle }] } — public models
                plus the caller's own private models.
FR-GW-005 (P0)  Requests are assigned a `x-nexus-request-id` (UUIDv7) returned on every
                response, including errors, and used as the usage_transactions id.
```

#### 4.2.2 Authentication & Authorization Pipeline

Ordered to fail as cheaply as possible. Every step before the upstream call contributes to the p95 < 10 ms overhead budget.

| # | Step | Failure | Cost |
|---|---|---|---|
| 1 | Extract bearer token; assert `sk-plat-` prefix and length | 401 `invalid_api_key` | ~0 ms |
| 2 | `SHA-256` the key (Deno `crypto.subtle.digest`) | — | <1 ms |
| 3 | Single JOIN: `api_keys` (by `key_hash`) → `profiles` → `custom_models` (by handle+slug) | 401 / 404 | 2–4 ms |
| 4 | Assert key not revoked (`revoked_at IS NULL`) | 401 `revoked_api_key` | 0 ms |
| 5 | Assert model `status='ready'` and not soft-deleted | 503 `model_unavailable` | 0 ms |
| 6 | Visibility: if `visibility='private'`, assert `model.user_id = key.user_id` | **404** (not 403 — never confirm existence of a private model to a stranger) | 0 ms |
| 7 | Rate limit: sliding window per key, tier-based | 429 + `Retry-After` | <1 ms |
| 8 | `authorize_request()` RPC — balance gate + reservation | 402 `insufficient_balance` | 2–4 ms |

```
FR-GW-010 (P0)  Only a SHA-256 hash of the API key is ever stored. Plaintext exists
                exactly once, in the creation response body. No plaintext key may be
                logged, in any environment.
FR-GW-011 (P0)  Steps 3–8 execute in at most 2 Postgres round trips.
FR-GW-012 (P0)  Private-model access failure returns 404, never 403.
FR-GW-013 (P0)  last_used_at is updated ASYNCHRONOUSLY (fire-and-forget after the
                response starts). It must never sit on the critical path.
FR-GW-014 (P1)  Per-key sliding-window rate limit; 429 carries Retry-After.
```

#### 4.2.3 Balance Authorization — Reserve-then-Settle

**The core problem:** token cost is unknowable until the stream completes, but the balance must be checked before the GPU is engaged. A naive post-hoc debit lets N concurrent requests from a $0.01 wallet each pass a pre-check and collectively overdraw.

**The resolution — a two-phase reservation:**

```
Phase 1 — AUTHORIZE (before upstream)
  estimated_max_cost = ceil( est_prompt_tokens × price_prompt
                           + max_tokens        × price_completion )
      where est_prompt_tokens = ceil(total_message_chars / 3.5) × 1.15   [conservative]
  hold_amount = LEAST(estimated_max_cost, per_request_ceiling)
  REQUIRE  balance_micro_usd - outstanding_holds >= hold_amount
  INSERT usage_transactions (status='reserved', hold_micro_usd = hold_amount)

Phase 2 — SETTLE (after the stream, from real usage)
  deduct_token_cost(txn_id, prompt_tokens, completion_tokens)
    → SELECT ... FOR UPDATE on profiles
    → actual_cost computed from the price snapshot on the transaction row
    → balance -= actual_cost   (GREATEST(0, ...) is a belt-and-braces floor)
    → hold released; status='settled'
```

Available balance is therefore `balance_micro_usd − SUM(hold_micro_usd WHERE status='reserved')`, which makes concurrent overdraw structurally impossible rather than merely unlikely.

```
FR-GW-020 (P0)  A hold is opened before any upstream request and is always resolved
                to exactly one of: settled | voided | expired.
FR-GW-021 (P0)  Available balance nets outstanding holds. Concurrent requests cannot
                collectively overdraw.
FR-GW-022 (P0)  402 responses include the OpenAI error envelope plus
                `x-nexus-balance-micro-usd` and a top-up URL in the message.
FR-GW-023 (P0)  Holds are stamped expires_at = now() + 15 min. A cron sweeper voids
                expired holds (§6.5) so an orphaned hold can never permanently strand
                a user's balance.
FR-GW-024 (P0)  The price used for settlement is SNAPSHOT onto the transaction row at
                authorize time. A mid-stream price edit by the creator cannot change
                what an in-flight request costs.
```

#### 4.2.4 Upstream Proxy to RunPod

RunPod's vLLM worker exposes an OpenAI-compatible passthrough, which removes an entire translation layer:

```
POST https://api.runpod.ai/v2/{endpoint_id}/openai/v1/chat/completions
Authorization: Bearer $RUNPOD_API_KEY
Content-Type: application/json
```

```
FR-GW-030 (P0)  The gateway ALWAYS requests stream:true upstream, regardless of the
                client's `stream` value. For stream:false clients it accumulates chunks
                and emits a single assembled chat.completion object.
                RATIONALE: a non-streaming upstream call over a 60 s cold start is a
                60 s silent socket, which most HTTP clients and intermediaries abort.
                Streaming upstream unconditionally means one code path and one
                cold-start mitigation instead of two.
FR-GW-031 (P0)  stream_options.include_usage = true is injected on every upstream
                request so the terminal chunk carries authoritative token counts.
FR-GW-032 (P0)  The upstream `model` field is set to the model identifier the worker
                actually serves (from custom_models.served_model_name), not the
                platform-facing creator/slug.
FR-GW-033 (P0)  Upstream failures map to OpenAI-shaped errors:
                  RunPod 401/403 → 500 internal (platform credential fault, never
                                   the caller's fault — do not leak upstream detail)
                  RunPod 404     → 503 model_unavailable
                  RunPod 429     → 429 + Retry-After
                  worker OOM     → 500 with a "hardware tier too small" hint, and the
                                   model is flagged for creator attention
FR-GW-034 (P0)  Sanitize upstream error bodies. RunPod endpoint ids, internal
                hostnames, and stack traces must never reach a client.
FR-GW-035 (P1)  One automatic retry on a connection-level failure BEFORE any byte has
                been forwarded to the client. Never retry after the first byte —
                that would corrupt the stream.
```

#### 4.2.5 SSE Streaming, Keep-Alive & Usage Extraction

This is the highest-risk component in the MVP and the mechanism that makes scale-to-zero commercially viable.

```
FR-GW-040 (P0)  Response headers are flushed BEFORE the upstream fetch is issued:
                  Content-Type: text/event-stream
                  Cache-Control: no-cache, no-transform
                  Connection: keep-alive
                  X-Accel-Buffering: no
FR-GW-041 (P0)  While no upstream byte has arrived, emit an SSE comment line
                `: keepalive\n\n` every 5 seconds. Comment lines are ignored by every
                conforming SSE parser (including the OpenAI SDKs), so they hold the
                socket open without polluting the client's chunk iterator.
FR-GW-042 (P0)  Keep-alive stops on the first upstream byte and does not resume.
FR-GW-043 (P0)  Upstream bytes are forwarded VERBATIM. A TransformStream tees the
                stream: one branch to the client, one to the usage accumulator.
                No parse-and-reserialize — it costs latency and risks fidelity drift.
FR-GW-044 (P0)  Usage extraction, in priority order:
                  1. usage object on the terminal chunk (vLLM w/ include_usage)  [authoritative]
                  2. usage on a non-standard trailing frame (llama.cpp variants)
                  3. FALLBACK: prompt estimated from input chars, completion counted
                     from accumulated delta chars ÷ 3.5. Transaction is flagged
                     usage_estimated = true and alerts Ops.
                A completed stream is NEVER left unbilled. Revenue leakage is a worse
                failure than a slightly imprecise charge.
FR-GW-044a (P0) Also extract prompt_tokens_details.cached_tokens where the worker
                reports it (prefix-cache hit), persist it on the transaction, and pass
                it through verbatim in the client-facing usage object (FR-BIL-040…042).
                Absent field → 0, not null: a missing value means "no cache hit
                reported", which is distinct from "unknown".
FR-GW-044b (P0) RUNTIME-AWARE USAGE EXTRACTION. The two runtimes report differently and
                the gateway must not assume vLLM semantics:
                  vLLM      — usage on the terminal chunk with stream_options
                              .include_usage; cached_tokens present. Path 1 is reliable.
                  llama.cpp — usage emission on the OpenAI-compatible route is
                              BUILD-DEPENDENT, and cached_tokens is not reported at all.
                              Path 2/3 of FR-GW-044 is the EXPECTED path, not an
                              exception, and the estimated-usage alert threshold
                              (NFR-REL-004, >1%) must be evaluated per runtime or it
                              will fire continuously on every GGUF model.
                Because the MVP's acceptance target is a GGUF model, the fallback
                estimator is on the critical path from day one and must be built and
                tested in Sprint 1 — not deferred as defensive code.
FR-GW-044e (P0) REASONING MODELS: completion tokens are split across TWO delta fields.
                The MVP's own target streams chain-of-thought as
                `delta.reasoning_content` and only the final answer as `delta.content`.
                Both are generated, both consume GPU time, and both are included in the
                worker's `usage.completion_tokens`.
                Any local estimator MUST count both. Counting only `content`
                under-counts billed output by up to 89% — measured: a 27-token
                generation reported as 0 tokens. Because the shortfall lands in the
                platform's favour it produces no error, no alert, and no complaint;
                it simply bills less than the GPU time cost. Handle `delta.text`
                (legacy) as well.
FR-GW-044d (P0) SSE frame parsing must be TOLERANT, because the runtime with the least
                reliable usage reporting is also the one most likely to emit
                non-canonical framing:
                  - `data:` with no space after the colon is VALID SSE and is emitted by
                    some llama.cpp builds and by intermediate proxies
                  - CRLF line endings leave a trailing \r that must be stripped
                  - the final frame may arrive with NO trailing newline, so the decoder
                    and the residual line buffer MUST be flushed after the read loop
                    ends — that residual line is typically the usage frame
                Each of these, missed, silently demotes an authoritative usage report to
                an estimate while raising no error anywhere.
FR-GW-044c (P0) The llama.cpp worker image is pinned to a build VERIFIED to emit usage
                on the OpenAI-compatible route, and that verification is an automated
                test against the pinned tag. An image bump that silently drops usage
                reporting would move every GGUF request onto the estimator without any
                alarm firing.
FR-GW-045 (P0)  Client disconnect mid-stream: detect via request.signal / writer
                rejection, then settle on tokens observed so far. The GPU work was
                really performed and must be paid for.
FR-GW-046 (P0)  Settlement runs on a path that survives client disconnect — the
                deduct_token_cost call is NOT awaited inside the client-write path.
FR-GW-047 (P0)  Hard upstream timeouts: 90 s to first token (cold-start budget),
                300 s total stream duration. Both emit a terminating SSE error frame
                then close, so the client sees a cause rather than a dead socket.
FR-GW-048 (P0)  CORRECTED — the original form of this requirement was structurally
                impossible and contradicted FR-GW-040. Cold-start status and TTFT are
                not known until the first upstream byte arrives, which is by definition
                AFTER response headers have flushed. They therefore CANNOT be response
                headers on a streamed request. Deliver them as:
                  1. structured telemetry on the settlement path (authoritative), and
                  2. for streaming clients, a trailing SSE comment emitted just before
                     [DONE]:  `: nexus {"ttft_ms":412,"cold_start":false}\n\n`
                     Comment lines are ignored by conforming SSE parsers, so this is
                     invisible to an OpenAI SDK while remaining readable by the
                     Playground and by anyone reading the raw stream.
                Non-streaming responses MAY carry the headers, since those are buffered
                and assembled after the stream completes. Do not implement two different
                header contracts for the same route without documenting it.
```

```typescript
// supabase/functions/gateway/stream.ts — keep-alive + tee'd usage extraction
//
// ABRIDGED. The canonical implementation is the real file at this path; it adds the
// FR-GW-047 timeout races (per-read deadline for cold start and total duration, with
// reader cancellation on expiry) omitted here for readability. Do not treat this
// sketch as complete — six defects were found in an earlier revision of it, and the
// three subtlest (final-line flush, cancel()-based disconnect, coldStart fallback)
// are called out inline below because each silently corrupts billing or telemetry.
const encoder = new TextEncoder();

// SSE permits `data:` with NO space after the colon, and CRLF endings leave a stray
// \r. Some llama.cpp builds and proxies emit exactly that — on the very runtime whose
// usage reporting is already the least reliable. Matching only "data: " drops those
// frames, including the terminal usage frame.
function ingestLine(line: string, usage: UsageAccumulator): void {
  const s = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!s.startsWith("data:")) return;                 // comments, blanks, event: lines
  const payload = s.slice(5).replace(/^ /, "").trim();
  if (!payload || payload === "[DONE]") return;
  usage.ingest(payload);                              // captures usage{} or counts deltas
}

export function proxyStream(
  upstreamPromise: Promise<Response>,
  onComplete: (u: Usage, meta: StreamMeta) => void,   // fires even if the client vanished
): Response {
  const usage = new UsageAccumulator();
  const t0 = performance.now();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // ── Phase 1: hold the socket open while the GPU cold-starts ──────────────
      let firstByte = false;
      const ka = setInterval(() => {
        if (!firstByte) {
          try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* closed */ }
        }
      }, 5_000);

      let ttft: number | null = null;
      let clientGone = false;

      try {
        const upstream = await upstreamPromise;
        if (!upstream.ok || !upstream.body) throw await toGatewayError(upstream);

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let carry = "";

        // ── Phase 2: forward verbatim, sniff usage in parallel ────────────────
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          if (!firstByte) { firstByte = true; clearInterval(ka); ttft = performance.now() - t0; }

          // Branch A — client (verbatim bytes, zero transformation)
          if (!clientGone) {
            try { controller.enqueue(value); }
            catch { clientGone = true; }   // client left; keep draining upstream to bill correctly
          }

          // Branch B — usage accumulator (line-buffered SSE frame parse)
          carry += decoder.decode(value, { stream: true });
          const lines = carry.split("\n");
          carry = lines.pop() ?? "";
          for (const line of lines) ingestLine(line, usage);
        }

        // CRITICAL: flush the decoder and the final partial line. An upstream that
        // ends WITHOUT a trailing newline leaves its last frame in `carry` — and that
        // is precisely the frame carrying `usage`. Dropping it silently demotes real
        // usage to the estimator on every such response. Direct revenue leakage.
        carry += decoder.decode();
        if (carry) ingestLine(carry, usage);
      } catch (err) {
        if (!clientGone) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(toOpenAIError(err))}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch { /* closed */ }
        }
      } finally {
        clearInterval(ka);
        try { controller.close(); } catch { /* already closed */ }

        // ── Phase 3: settle. Deliberately OUTSIDE the client write path so that a
        //    disconnected client cannot cause unbilled GPU work.
        const duration = performance.now() - t0;
        onComplete(usage.result(), {
          ttftMs: ttft,
          durationMs: duration,
          // Fall back to total duration when no token ever arrived. `(ttft ?? 0) > 5000`
          // reports FALSE for a request that waited 101 s on a cold worker and then
          // failed — labelling the single worst case as warm.
          coldStart: (ttft ?? duration) > 5_000,
          clientGone,
        });
      }
    },

    // Deno and Workers signal a client hang-up through the source's cancel(), NOT by
    // throwing from enqueue() — enqueue only throws AFTER cancellation. Relying on the
    // throw alone leaves a disconnect undetected while the queue grows unbounded.
    // Do NOT abort the pump here: upstream must keep draining so billing stays correct.
    cancel() { clientGone = true; },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

#### 4.2.6 Latency Budget — p95 < 10 ms Gateway Overhead

"Overhead" is defined as wall time from request receipt to the upstream fetch being issued, plus the post-stream settlement path. It explicitly excludes upstream inference time.

| Stage | Budget (p95) | Technique |
|---|---|---|
| Parse + validate body | 1.0 ms | No schema library on the hot path; hand-rolled guards |
| SHA-256 the API key | 0.5 ms | Native `crypto.subtle` |
| Auth + model resolution | 4.0 ms | Single JOIN, covering index on `api_keys.key_hash`; Postgres co-located with the function region |
| `authorize_request()` RPC | 3.0 ms | Single RPC; one row lock; no round trip per check |
| Build upstream request | 0.5 ms | Shallow object spread |
| Header flush | 0.2 ms | Headers written before upstream fetch |
| **Total pre-upstream** | **≈9.2 ms** | Alarm threshold: p95 > 10 ms |
| Settlement (async, off critical path) | — | Not counted; happens after `[DONE]` |

```
FR-GW-050 (P0)  Instrument gateway_overhead_ms on every request. Alert if
                p95 > 10 ms over a 5-minute window.
FR-GW-051 (P0)  Zero cold-start-inducing imports on the hot path. No ORM, no heavy
                validation library, no Node compatibility shims.
FR-GW-052 (P1)  In-memory LRU (60 s TTL) for model resolution, keyed by
                creator/slug. Invalidated by a Realtime subscription on custom_models.
                Removes ~4 ms from steady-state overhead.
```

### 4.3 Creator Studio Backend — Model Registration & Provisioning

#### 4.3.1 Hugging Face Repository Validation

```
FR-DEP-001 (P0)  Validate slug shape: ^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$
FR-DEP-002 (P0)  GET https://huggingface.co/api/models/{slug} — classify the result:
                   200            → public, readable
                   401/403        → private or gated → an HF token is required
                   404            → does not exist
FR-DEP-003 (P0)  Determine weights format from the sibling file list:
                   *.gguf                    → llama.cpp worker
                   *.safetensors             → vLLM worker
                   quant_config/AWQ/GPTQ dir → vLLM worker + quantization flag
                   neither                   → reject with a clear message
FR-DEP-004 (P0)  Enumerate the repo's deployable VARIANTS and their byte sizes (§4.3.3.2).
                 A GGUF repo yields one variant per quantization, NOT one variant per repo.
                 Weight bytes are per-variant; there is no single "repo size".
FR-DEP-005 (P0)  Read max_position_embeddings from config.json as the CEILING on the
                 creator's selectable context window; else default 4096 and mark it
                 unverified. The creator's chosen window may be lower, never higher.
FR-DEP-006 (P0)  When a token is supplied, re-probe WITH the token to prove it actually
                 grants read access, before any endpoint is provisioned. Fail fast at
                 form time, not at first cold start.
FR-DEP-007 (P1)  Reject repos over the tier's practical weight ceiling with a
                 recommendation to select a larger tier.
```

#### 4.3.2 Private Repository Token Handling

> **Security requirement.** A Hugging Face read token is a bearer credential over a creator's entire private namespace. Mishandling one is a cross-account data-disclosure incident, not a bug.

```
FR-DEP-010 (P0)  HF tokens are encrypted at rest via Supabase Vault (pgsodium
                 authenticated encryption). custom_models stores only the vault
                 secret UUID — never ciphertext in a normal column, never plaintext.
FR-DEP-011 (P0)  Decryption is possible ONLY from the service_role context inside an
                 Edge Function. No RLS policy, view, or RPC exposes the plaintext to
                 any authenticated user, including the token's own owner.
FR-DEP-012 (P0)  The plaintext token is used exactly twice: (a) the validation re-probe,
                 (b) injection as HF_TOKEN into the RunPod template environment.
FR-DEP-013 (P0)  The token is never logged, never included in an error message, never
                 returned by any API response, and is redacted from all telemetry by a
                 pattern filter on /hf_[A-Za-z0-9]{30,}/.
FR-DEP-014 (P0)  Deleting a model destroys the Vault secret (vault.delete_secret) in the
                 same transaction as the soft delete.
FR-DEP-015 (P1)  Token rotation without redeploying: update the Vault secret and patch
                 the RunPod template env.
FR-DEP-016 (P1)  A token that stops working (HF 401 at cold start) transitions the model
                 to status='auth_failed' and emails the creator.
```

#### 4.3.3 Variant Selection & Capacity Planning (Hardware Abstraction)

> **Product principle.** A creator never selects a GPU. GPU selection is a constraint-satisfaction problem over VRAM, memory bandwidth, and KV-cache geometry — solvable exactly from data the platform already has, and not solvable at all by a human who just wants their model to be fast. The creator declares **intent**; the platform resolves **hardware**.

##### 4.3.3.1 What the creator actually decides

Exactly three things, all of which are product decisions rather than infrastructure decisions:

| Input | Why it must be a creator decision | Why the platform can't decide it |
|---|---|---|
| **Quality** — which quantization variant | A quality/cost tradeoff over *their* model's behavior | Only the creator knows whether Q4 degradation is acceptable for their use case |
| **Context window** — max tokens | A capability claim on their model card | Dominates cost; the creator owns the price consequence |
| **Minimum speed** — tokens/sec per stream | The experience their users get | Trades directly against cost floor |

Everything else — GPU model, VRAM headroom, KV-cache budget, concurrency ceiling, worker image, cost floor — is **derived**.

The one input creators are commonly asked for that this design deliberately *removes* is model size in parameters. Once the HF repo and the quality variant are known, weight bytes are a measured fact, not an input.

##### 4.3.3.2 Variant Discovery

A single Hugging Face repository is not a single deployable artifact. A GGUF repo typically ships 6–10 quantizations of the same weights; each is a distinct deployment with distinct size, speed, quality, and hardware requirements.

```
> **A `.gguf` file is not necessarily a servable model.** A quantizer's repo routinely
> also contains draft models for speculative decoding, vision projectors, and multiple
> *families* of the same model — all with the same quant tags in their filenames. Matching
> on the quant tag alone offers unservable files to creators as if they were models.
> §4.3.3.2a works a real repo that does exactly this.

```
FR-DEP-040 (P0)  Enumerate deployable VARIANTS from the repo file list, not just the repo.
                 GGUF:        one variant per (family, quantization) pair — see FR-DEP-041a.
                 safetensors: one variant (the repo's native precision). Repos carrying an
                              explicit quant config (AWQ / GPTQ) are that single variant.
FR-DEP-041 (P0)  Parse the quant tag from GGUF filenames, case-insensitively:
                   (IQ\d+_[A-Z]+|Q\d+_K_[SML]|Q\d+_K|Q\d+_\d+|F16|BF16|F32)
                 Unparseable .gguf files are surfaced as an 'unknown' variant, excluded
                 from the recommendation, and never auto-selected.
FR-DEP-041a (P0) CLASSIFY EVERY .gguf BY ROLE BEFORE OFFERING IT. Role is determined by
                 filename markers and by size relative to the repo's largest file:
                   'draft'    — /[-_.]draft[-_.]/          speculative-decoding draft model
                   'mmproj'   — /[-_.](mmproj|vision|clip)[-_.]/  multimodal projector
                   'lora'     — /[-_.](lora|adapter)[-_.]/  adapter, not standalone weights
                   'model'    — everything else
                 Only role='model' is deployable. Roles 'draft' and 'mmproj' are RECORDED
                 as companion assets (they are useful later — see FR-DEP-046) but are
                 never offered as variants. A size heuristic backstops the filename rule:
                 any candidate under 25% of the largest .gguf in the repo is quarantined
                 as suspected-companion and requires explicit creator confirmation.
                 WITHOUT THIS RULE a 3 GB draft model and a 0.9 GB vision projector both
                 match the quant regex and are presented as servable 27B models. One
                 serves fluent garbage at high speed; the other fails to load.
FR-DEP-041b (P0) GROUP VARIANTS BY FAMILY. The residue of the filename after stripping the
                 base model name, the quant tag, and the role markers is the FAMILY
                 discriminator (e.g. 'noMTP', 'i1', 'imat'). Variants in different
                 families are DIFFERENT MODELS with different weights and different
                 behavior, and must not collide in a map keyed on quant tag alone.
                 The creator picks a family once (default: the unsuffixed base family),
                 then picks quality within it.
FR-DEP-041c (P0) Non-weight artifacts are excluded by extension before any of the above:
                 imatrix.dat, *.json, *.md, *.txt, .gitattributes. An imatrix file is a
                 quantization input, not weights.
FR-DEP-042 (P0)  Group SPLIT GGUF files (*-00001-of-00003.gguf) into ONE variant and sum
                 their byte sizes. Treating a shard as a variant would under-estimate
                 weights by 3x and select a GPU that OOMs on first load.
FR-DEP-043 (P0)  Read the capacity solver's required architecture fields, in this order:
                   1. config.json — num_hidden_layers, num_attention_heads,
                      num_key_value_heads, hidden_size, head_dim (fall back to
                      hidden_size / num_attention_heads), max_position_embeddings,
                      torch_dtype, model_type
                   2. GGUF KEY-VALUE HEADER — for GGUF-only repos, which routinely ship
                      NO config.json at all. Read via HTTP range request over the first
                      ~1 MB of the file; a full download is never required.
                        {arch}.block_count            -> n_layers
                        {arch}.attention.head_count_kv -> n_kv_heads
                        {arch}.attention.head_count    -> n_attention_heads
                        {arch}.embedding_length        -> hidden_size
                        {arch}.context_length          -> max_position_embeddings
                   3. Neither available -> REJECT. Never guess a memory profile.
                 For a llama.cpp-native repo, path 2 is not a fallback — it is the ONLY
                 path, and must be treated as a first-class implementation, not an
                 afterthought.
FR-DEP-046 (P1)  Record discovered companion assets on the model row. A 'draft' companion
                 enables speculative decoding (P2) and can roughly double effective
                 throughput; an 'mmproj' companion signals multimodal capability, which
                 the MVP's text-only gateway does not expose. Detecting and storing them
                 now costs nothing and avoids re-probing later.
FR-DEP-044 (P0)  Detect MoE architectures (num_local_experts / num_experts_per_tok).
                 Decode throughput depends on ACTIVE parameter bytes, not total.
                 Store both weights_bytes and active_weights_bytes; the throughput model
                 uses active, the VRAM model uses total. Conflating them mis-predicts
                 speed on every MoE model by the expert ratio.
FR-DEP-045 (P1)  Repos with zero deployable variants (no weights, LoRA adapters only,
                 unsupported architecture) are rejected at form time with the reason.
```

##### 4.3.3.2a Reference fixture — the MVP target repo

`JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` is the MVP's acceptance target and doubles as the adversarial test fixture for variant discovery. It exercises every rule above. Probed values, not estimates:

| File | Bytes | Role | Family | Deployable? |
|---|---|---|---|---|
| `…-IQ2_M.gguf` | 10,624,771,968 | model | base | ✅ |
| `…-IQ4_XS.gguf` | 15,309,039,008 | model | base | ✅ |
| `…-Q4_K_M.gguf` | 16,810,714,528 | model | base | ✅ **← MVP target variant** |
| `…-Q5_K_M.gguf` | 19,535,701,408 | model | base | ✅ |
| `…-Q6_K.gguf` | 22,430,999,968 | model | base | ✅ |
| `…-Q8_0.gguf` | 29,047,084,448 | model | base | ✅ |
| `…-noMTP-{6 quants}.gguf` | 10.2–28.6 GB | model | **noMTP** | ✅ separate family |
| `…-draft-Q8_0.gguf` | 3,164,006,592 | **draft** | — | ❌ companion |
| `…-vision-f16.gguf` | 927,606,912 | **mmproj** | — | ❌ companion |
| `…-imatrix.dat` | 13,642,656 | — | — | ❌ not weights |

**What a naive tag-match implementation produces here:** 14 "variants" instead of 12, including a 3.16 GB draft model offered as a servable 27B (matches `Q8_0`) and a 0.93 GB vision projector offered as full precision (matches `F16`) — plus six `noMTP` files silently colliding with the six base files on quant tag. Three separate P0 bugs, all in one real repo, all caught by FR-DEP-041a/041b/041c.

**Two further facts this repo establishes, both of which bind elsewhere in this document:**

1. **No `config.json`.** `library_name: llama.cpp`. The GGUF-header read (FR-DEP-043 path 2) is the only way to capacity-plan the MVP's own target model.
2. **It is a llama.cpp model**, so it cannot run on the vLLM worker image. See §4.3.3.6.

**Architecture, read live from the GGUF header** (this repo has no `config.json`):

```
general.architecture = qwen35        block_count            = 65
head_count           = 24            head_count_kv          = 4
key_length (head_dim)= 256           context_length         = 262144
full_attention_interval = 4          nextn_predict_layers   = 1
ssm.state_size = 128   ssm.inner_size = 6144   ssm.group_count = 16   ssm.conv_kernel = 4
```

This is a **hybrid attention/SSM model**: of 65 blocks, only ~16 hold a growing KV cache; the other 49 carry constant-size SSM state (~77 MiB per stream, measured). See §4.3.3.3 for why that distinction dominates every number below.

**Actual solver output** for the target variant (Q4_K_M, 16.81 GB), corrected vs naive KV term:

| Context | Resolved | Streams | tok/s | KV + SSM | Cost floor µ$/Mtok | Naive term would say |
|---|---|---|---|---|---|---|
| 8,192 | rtx4090 | **6** | 45 | 0.50 GiB + 77 MiB | 1,294,182 | rtx4090, 1 stream |
| 100,000 | l40s | **3** | 39 | 6.10 GiB + 77 MiB | 5,902,253 | a100_80, 1 stream |
| 262,144 | l40s | 1 | 39 | 16.00 GiB + 77 MiB | 17,706,759 | **INFEASIBLE** |

Throughput by tier (depends only on weight bytes, so these are firm):

| Tier | Predicted tok/s |
|---|---|
| RTX 4090 24GB | 45 |
| L40S 48GB | **39 — slower than the 4090 at ~2× the price** (§4.3.3.3's "not a ladder", on the real target) |
| A100 80GB | 86 |
| H100 80GB | 149 |

Cold-start budget: 16.81 GB ÷ 300 MB/s + 45 s ≈ **101 s**, above the old fixed 90 s ceiling — the per-model budget (NFR-CACHE-010) is load-bearing for the MVP's own model. Within this single repo, `Q6_K` (22.4 GB) and `Q8_0` (29.0 GB) cross the 20 GB volume threshold while `Q4_K_M` does not, so one repo spans both weight-cache strategies.

> **Resolved — and an earlier claim in this document was wrong.** A previous revision
> asserted that hybrid SSM blocks read less of the weight set per decoded token, making
> `active_weights_bytes` a placeholder and the cost floors conservative. That conflates
> two different kinds of memory traffic. An SSM block reads **all** of its own projection
> weights on every decoded token, exactly as an attention block does. What a hybrid model
> avoids is re-reading a **KV cache that grows with context** — KV traffic, not weight
> traffic. `qwen35` reports no `expert_count`, so it is dense: every byte of the 16.81 GB
> is read per token, and `active_weights_bytes == weights_bytes` is **correct here**.
>
> Two consequences, both the opposite of what the earlier claim implied:
> - 45 tok/s is **not** a floor for that reason, and the cost floors above carry no such
>   hidden headroom. Do not book it.
> - The hybrid advantage shows up at **long** context, where a pure transformer's KV
>   re-read term grows and this model's barely does (16 of 65 blocks, plus constant SSM
>   state). A throughput model that ignores the KV-read term entirely will therefore
>   **under**-predict this model at 100k+ context.
>
> `active_weights_bytes` diverges from total only for **MoE**, and that split cannot be
> read from the header prefix — it needs the tensor-info section, which sits past the
> ~150k-entry tokenizer arrays and outside the range window. Detection of
> `expert_count` / `expert_used_count` exists so such a model can be rejected or
> re-probed rather than silently mispriced.

```
FR-DEP-047 (P0)  This repo's file list is committed as a test fixture. The variant
                 classifier must produce exactly 12 deployable variants across 2
                 families, 2 companion assets, and 0 offers of draft or mmproj files.
                 Regression on this fixture blocks merge.
```

**Quality ladder.** Quant tags are ordered by bits-per-weight and labeled honestly. The label is what the creator reads; the tag is disclosure-only.

| Tag | ~bpw | Creator-facing label | Honest quality note |
|---|---|---|---|
| `IQ2_M` | 2.7 | Minimum | Importance-matrix 2-bit. Better than `Q2_K` per bit, still heavily degraded. |
| `Q2_K` | 2.6 | Minimum | Severe degradation. Offered, never recommended. |
| `Q3_K_M` | 3.9 | Reduced | Noticeable quality loss on reasoning tasks |
| `IQ4_XS` | 4.25 | Balanced (compact) | Importance-matrix 4-bit. Smaller than `Q4_K_M` at similar quality. |
| `Q4_K_M` | 4.8 | **Balanced** | Community default. Best quality-per-byte. |
| `Q5_K_M` | 5.7 | High | Near-lossless for most tasks |
| `Q6_K` | 6.6 | Very high | Effectively indistinguishable from FP16 |
| `Q8_0` | 8.5 | Maximum | Lossless in practice |
| `F16`/`BF16` | 16 | Full precision | Reference weights; 2x the cost of Q8 for no measurable gain |
| `AWQ`/`GPTQ` | ~4.2 | Balanced (GPU-native) | 4-bit, vLLM-native, faster than GGUF on datacenter GPUs |

##### 4.3.3.3 The Capacity Solver

Pure arithmetic over probed facts. Implemented **once**, in Postgres (§5.4a), and called by both the Studio preview and the provisioning path — so the number the form promises is the number that gets provisioned. Two implementations would drift, and the drift would be a broken promise on a public model card.

**VRAM model.** At long context, KV cache — not weights — is the binding constraint.

```
head_dim            = config.head_dim (GGUF: key_length)
                      -- The hidden_size / num_attention_heads fallback is UNSAFE. On the
                      -- MVP target it yields 5120/24 = 213.33 where the true value is 256.
                      -- Treat a non-exact division as a HARD ERROR, never a rounded guess.

kv_bytes_per_token  = 2 x n_attention_layers x n_kv_heads x head_dim x kv_dtype_bytes
                        ^-- K and V
                      -- TWO independent traps live in this one line:
                      -- (a) n_kv_heads is the GQA count, NOT n_attention_heads. Confusing
                      --     them over-estimates KV by up to 8x.
                      -- (b) n_attention_layers is NOT the total block count on hybrid
                      --     attention/SSM models. The MVP target (qwen35,
                      --     full_attention_interval = 4) has 65 blocks but only ~16 that
                      --     hold a growing KV cache. Using 65 over-estimates KV by 4x —
                      --     measured: 266,240 B/token naive vs 65,536 B/token correct.

ssm_bytes_per_seq   = per-sequence SSM state on hybrid models.
                      -- CONSTANT. It does NOT scale with context length. Multiplying it
                      -- by context_length is the exact mirror-image of trap (b) and is
                      -- just as wrong. Measured on the MVP target: ~77 MiB per stream.

bytes_per_stream    = kv_bytes_per_token x context_length + ssm_bytes_per_seq
overhead_bytes      = max(2 GiB, 0.10 x weights_bytes)     -- CUDA graphs, framework, buffers
required_vram       = weights_bytes + bytes_per_stream + overhead_bytes

fits(tier)          <=>  required_vram <= tier.vram_bytes x 0.92   -- GPU_MEMORY_UTILIZATION
```

> **Why this correction is not academic.** Run against the MVP's own target model, the
> naive all-layers term declares the model's native 262,144-token context **infeasible on
> every available GPU**, and cuts an 8k deployment from 6 concurrent streams to 1 — a ~6x
> inflation of the cost floor. A creator would have been told their model cannot do what
> it plainly can, and been overcharged for what it can.

**Throughput model.** Single-stream decode is memory-bandwidth bound: every generated token requires reading the active weights once.

```
predicted_tok_s = (tier.memory_bandwidth_bytes_s x MFU) / active_weights_bytes
MFU             = 0.75   -- empirical vLLM efficiency; MUST be recalibrated from measured
                            production data (see FR-DEP-052), never left as a guess
```

**Concurrency ceiling.** What is left of VRAM after weights and overhead, divided by per-stream KV:

```
max_concurrent = floor( (tier.vram_bytes x 0.92 - weights_bytes - overhead_bytes)
                        / (kv_bytes_per_token x context_length) )
```

**Cost floor.** The number that makes the creator's pricing decision informed:

```
gpu_micro_per_sec  = tier.usd_per_hour_micro / 3600
seconds_per_mtoken = 1e6 / (predicted_tok_s x max_concurrent x assumed_utilization)
cost_floor_micro   = gpu_micro_per_sec x seconds_per_mtoken      -- micro-USD per 1M tokens
assumed_utilization = 0.35   -- config, not code. Real endpoints are not saturated.
```

**Selection rule.** Cheapest tier satisfying both constraints:

```
candidates = { t in gpu_tiers : t.is_enabled
                              AND fits(t)
                              AND predicted_tok_s(t) >= target_tok_s x 0.90 }
resolved   = argmin(candidates, usd_per_hour_micro)
```

> **The tier list is not a ladder.** L40S has 48 GB of VRAM but *less* memory bandwidth than a 24 GB RTX 4090 (864 vs 1008 GB/s) — so for a model that fits in 24 GB, "upgrading" to the L40S makes it **slower and more expensive**. No creator should be expected to know this, and any UI that presents tiers as an ordered ladder actively misleads them. This is the strongest argument for the abstraction.

##### 4.3.3.4 Worked Example — why context dominates

Qwen3-27B GGUF · 64 layers · 8 KV heads (GQA) · head_dim 128 · FP16 KV cache
→ `kv_bytes_per_token` = 2 × 64 × 8 × 128 × 2 = **262 KB per token**

| Creator asks for | Resolved GPU | Weights | KV cache | Concurrency | Speed | **Cost floor / 1M tok** |
|---|---|---|---|---|---|---|
| Balanced (Q4_K_M), **8k** ctx, ≥100 tok/s | H100 80GB | 16.2 GB | 2.1 GB | 27 streams | 155 tok/s | **$0.20** |
| Balanced (Q4_K_M), **100k** ctx, ≥100 tok/s | H100 80GB | 16.2 GB | 26.2 GB | 2 streams | 155 tok/s | **$2.68** |
| Maximum (Q8_0), **100k** ctx, ≥100 tok/s | — | 28.7 GB | 26.2 GB | 1 stream | 87 tok/s | **infeasible** |

Same model, same quant, same GPU: **a 13× cost difference driven entirely by context window.** Creators intuitively believe model size drives cost; past ~32k context, it is KV cache collapsing concurrency that drives cost. The Studio must show this, because a creator who prices a 100k-context model as if it were an 8k-context model loses money on every request.

```
FR-DEP-050 (P0)  The solver is a single Postgres function (resolve_placement) called by
                 BOTH the Studio preview and the deploy path. No second implementation.
FR-DEP-051 (P0)  Solver inputs and full outputs are snapshot onto custom_models
                 (placement_rationale jsonb) so a later tier-config change cannot
                 retroactively alter what a deployed model was promised.
FR-DEP-052 (P0)  The provisioning smoke test MEASURES real tok/s over >=64 generated
                 tokens on a warm worker and writes measured_tokens_per_second.
                   measured >= 0.90 x target -> ready
                   measured <  0.90 x target -> auto-escalate to the next tier that the
                                                solver predicts will meet target, retry
                                                ONCE, then either succeed or set status
                                                'ready' with the honest measured value
                                                and notify the creator.
FR-DEP-053 (P0)  The marketplace and model card display MEASURED throughput, never
                 predicted. A prediction shown as a spec is a promise the platform
                 has not verified.
FR-DEP-054 (P0)  KV-cache dtype is selectable by the solver (fp16 or q8_0). q8_0 KV
                 halves KV bytes at negligible quality cost and is auto-selected when
                 fp16 KV would force a more expensive tier. Recorded in the rationale.
FR-DEP-055 (P0)  gpu_tiers is a database table and gains memory_bandwidth_bytes_s.
                 It is INTERNAL: never rendered as a creator-facing choice, never
                 exposed to anon, and never shown in the public catalog.
FR-DEP-056 (P1)  Advanced disclosure ("Pin hardware") lets an expert creator override the
                 resolved tier. Collapsed by default, off the primary path, and an
                 override that the solver predicts will OOM requires acknowledging a
                 danger Alert.
FR-DEP-057 (P1)  Changing quality, context, or speed after deployment re-runs the solver;
                 a different resolved tier triggers re-provisioning behind an AlertDialog
                 warning about brief unavailability.
FR-DEP-058 (P1)  MFU and assumed_utilization are config rows, recalibrated monthly from
                 measured_tokens_per_second across live models.
```

##### 4.3.3.5 Infeasibility — the important failure paths


A constraint solver's UX is defined by what it does when there is no solution. Each case gets a specific, actionable message — never a generic "unsupported configuration".

| Case | Cause | What the Studio offers |
|---|---|---|
| **Won't fit anywhere** | weights + KV exceed the largest tier | Reduce context (show the max that fits), or step down one quality level (show the resulting size) |
| **Fits, too slow** | bandwidth-bound below target on every fitting tier | Accept the achievable speed (named explicitly, e.g. "87 tok/s"), or step down quality to shrink the read-per-token |
| **Feasible but expensive** | concurrency collapsed by long context | Show the cost floor next to the creator's entered price; warn if price < floor |
| **Only the top tier works** | large model + long context | Present it plainly with the cost floor, no upsell framing |
| **Architecture unknown** | no config.json and no GGUF metadata | Reject at form time — do not provision a model whose memory profile is unknown |

Every infeasibility message names the **specific** blocking quantity and its value ("100k context needs 26.2 GB of KV cache; the largest available GPU has 73.6 GB usable and your weights take 28.7 GB"), because a creator can only act on a number.

##### 4.3.3.6 Runtime selection — vLLM vs llama.cpp

The weights format determines the **inference runtime**, and the two runtimes are not interchangeable: different container images, different environment contracts, different KV-cache mechanics, and — critically for §4.2.5 and §6.6 — **different usage-reporting fidelity**. Runtime is derived, never chosen.

| | vLLM runtime | llama.cpp runtime |
|---|---|---|
| Triggered by | `.safetensors`, AWQ, GPTQ | `.gguf` |
| Image | `runpod/worker-v1-vllm:*` | llama.cpp serverless worker (**see FR-DEP-060**) |
| Context flag | `MAX_MODEL_LEN` | `--ctx-size` |
| Concurrency flag | `MAX_NUM_SEQS` | `--parallel` (slots) |
| Prefix caching | automatic prefix caching (APC) | slot context reuse — per-slot, not global |
| KV quantization | `KV_CACHE_DTYPE=fp8` | `--cache-type-k/v q8_0` |
| `usage` on stream | reliable w/ `include_usage` | **MEASURED PRESENT** (build `b10454`, 8/8 runs) |
| `cached_tokens` | reported | **MEASURED PRESENT and populated** (observed 42 on a shared prefix) |
| usage placement | separate trailing `choices:[]` chunk | **same** — separate trailing chunk, NOT the finish chunk |
| bonus telemetry | — | non-standard `timings` block with server-side `predicted_per_second` |
| Weight selection | whole repo | **a specific file** — the chosen variant |

```
FR-DEP-060 (P0)  Runtime is DERIVED from weights_format, never selected by a creator:
                   gguf                      -> llamacpp
                   safetensors | awq | gptq  -> vllm
                 Stored as custom_models.runtime and used to pick the image and the
                 entire env contract. A GGUF model provisioned on the vLLM image does
                 not start; a llama.cpp model is the MVP's own acceptance target, so
                 this path is P0, not a secondary format.
FR-DEP-061 (P0)  The llama.cpp worker must be given the SPECIFIC FILE of the selected
                 variant, not just the repo. vLLM resolves a repo; llama.cpp resolves a
                 file. Passing only the repo slug to a llama.cpp worker is ambiguous in
                 exactly the repos that carry many variants — i.e. all of them.
FR-DEP-062 (P0)  MVP ships BOTH worker images. GGUF is not a Phase 2 format: the model
                 the MVP exists to serve is GGUF-only (§4.3.3.2a).
FR-DEP-063 (P0)  Companion assets are NOT passed to the worker in MVP. An mmproj file
                 would enable multimodal input the text-only gateway cannot express, and
                 a draft model would change throughput characteristics the solver did
                 not plan for.
FR-DEP-064 (P1)  llama.cpp KV quantization (--cache-type-k/v q8_0) is the llama.cpp
                 expression of FR-DEP-054. The solver's kv_dtype_bytes output maps to
                 whichever flag the resolved runtime uses.
FR-DEP-065 (P2)  Speculative decoding using a discovered 'draft' companion (FR-DEP-046),
                 which can roughly double effective throughput on the same hardware.
```

##### 4.3.3.6a Modal runtime contract (verified live)

The platform runs on **Modal**, not RunPod. Modal deploys *apps*, not per-model endpoints, so the marketplace shape is a **parameterized class**: one `@app.cls(gpu=...)` per GPU tier, parameterized by model. Each distinct parameter set gets its own autoscaled, independently scale-to-zero container pool. One deploy serves N models, and the entire provisioning-mutation layer disappears.

Every item below was corrected against Modal 1.5.4 by live deployment. Trusting the pre-verification description would have failed at each point.

| Claim | Reality |
|---|---|
| GPU string `A10G` | **`A10`.** Valid set: `T4, L4, A10, L40S, A100, A100-40GB, A100-80GB, RTX-PRO-6000, H100, H100!, H200, B200, B200+, B300` |
| `container_idle_timeout` / `keep_warm` renamed | Renamed to `scaledown_window` / `min_containers`, and the old names are **hard `DeprecationError`s** in 1.5.4, not warnings. Modal's own migration guide is stale. |
| Parameters bind in the hostname | Bind via **URL query string**: `…modal.run/v1/chat/completions?model_repo=…&ctx_size=8192` |
| `requires_proxy_auth` on `@app.cls` | Goes on the **web decorator**. Auth headers are `Modal-Key` / `Modal-Secret`, **not** `Authorization: Bearer` |
| `@modal.web_server(port)` waits for readiness | **It waits only for the port to bind.** llama-server binds instantly and then returns `503 {"message":"Loading model"}` for the entire load. The first cold request fails. |

```
FR-DEP-070 (P0)  Readiness MUST be gated on llama.cpp's /health inside @modal.enter().
                 @modal.web_server returns as soon as the port is bound, which for a
                 15 GB model is ~14 s before the server can actually answer. Without
                 this gate the first request after every cold start fails with a 503
                 that looks like a platform fault. Confirmed live.
FR-DEP-071 (P0)  `--ctx-size` in llama.cpp is the TOTAL context, divided across
                 `--parallel` slots — it is NOT per-slot. Passing the per-slot value
                 silently gives each slot ctx/parallel tokens and truncates long
                 prompts at runtime with no error. The solver's context_length must be
                 multiplied by max_concurrent_streams before it is passed.
FR-DEP-072 (P0)  Do NOT put `from __future__ import annotations` in the Modal app
                 module. Modal reads runtime annotations to select a parameter
                 serializer; PEP 563 breaks it with
                 `AttributeError: 'str' object has no attribute '__name__'`.
FR-DEP-073 (P1)  `startup_timeout` on the web decorator defaults to 5 SECONDS, which is
                 useless for a multi-GB model. Set it from the per-model cold-start
                 budget (NFR-CACHE-010).
FR-DEP-074 (P1)  llama.cpp emits a non-standard `timings` block alongside `usage`,
                 carrying server-side `predicted_per_second`. That is free ground truth
                 for calibrating the solver's MFU constant against reality — capture it.
FR-DEP-075 (P1)  MFU is currently a GUESSED 0.75. Measured on L4: predicted 13 tok/s
                 vs actual 14.0-14.2, implying ~0.79. This is not academic — at the
                 default 30 tok/s target the solver picks L40S ($1.95/hr) while A10
                 misses by 1 tok/s (26 vs a 27.0 floor). Recalibrating from measured
                 data flips that choice and saves $0.85/hr. Tier selection currently
                 rests on a guessed constant and should not be treated as settled.
```

The `saveTemplate` env block in §4.3.4 below is retained as the **RunPod/vLLM** reference contract for a future second provider (NFR-EXT-001). The llama.cpp env contract, which is what MVP actually ships:

```graphql
mutation CreateTemplateLlamaCpp {
  saveTemplate(input: {
    name: "nexus-tpl-{model_uuid}"
    imageName: "{LLAMACPP_WORKER_IMAGE}"
    isServerless: true
    containerDiskInGb: 40                 # sized from the selected VARIANT, not the repo
    volumeInGb: 0                         # >0 above the volume threshold (NFR-CACHE-011)
    env: [
      { key: "MODEL_REPO",   value: "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF" }
      { key: "MODEL_FILE",   value: "Qwen3.8-27B-Uncensored-Q4_K_M.gguf" }  # FR-DEP-061
      # CTX_SIZE is TOTAL across all slots, not per-slot (FR-DEP-071):
      #   ctx_size_total = creator_context_window x max_concurrent_streams
      # e.g. 8192 x 46 = 376832. Passing 8192 here gives each of 46 slots 178 tokens.
      { key: "CTX_SIZE",     value: "376832" }
      { key: "PARALLEL",     value: "46" }        # = solver's max_concurrent_streams
      { key: "N_GPU_LAYERS", value: "999" }       # offload everything; solver proved it fits
      { key: "CACHE_TYPE_K", value: "q8_0" }      # when solver picks 1-byte KV
      { key: "CACHE_TYPE_V", value: "q8_0" }
      { key: "CONT_BATCHING", value: "1" }
      { key: "HF_HOME",      value: "/runpod-volume/hf" }
    ]
  }) { id name }
}
```

#### 4.3.4 RunPod Serverless Provisioning

Two GraphQL mutations, in order. The template captures the container and its environment; the endpoint captures the scaling policy.

> The template below is the **vLLM** contract, used for safetensors/AWQ/GPTQ. GGUF models take the llama.cpp contract in §4.3.3.6 instead — including the MVP's own acceptance target. The endpoint mutation is identical for both.

```graphql
# 1 — Container template (vLLM runtime)
mutation CreateTemplate {
  saveTemplate(input: {
    name: "nexus-tpl-{model_uuid}"
    imageName: "runpod/worker-v1-vllm:v2.7.0stable-cuda12.1.0"
    isServerless: true
    containerDiskInGb: 60          # sized from probed variant bytes + headroom
    volumeInGb: 0                  # >0 for variants above the volume threshold (NFR-CACHE-011)
    dockerArgs: ""
    env: [
      { key: "MODEL_NAME",        value: "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF" }
      { key: "QUANTIZATION",      value: "Q4_K_M" }   # the SELECTED variant (§4.3.3.2)
      { key: "MAX_MODEL_LEN",     value: "8192" }     # = creator's context window
      { key: "MAX_NUM_SEQS",      value: "27" }       # = solver's max_concurrent_streams
      { key: "GPU_MEMORY_UTILIZATION", value: "0.92" }
      { key: "ENABLE_PREFIX_CACHING",  value: "1" }   # APC — NFR-CACHE-020
      { key: "KV_CACHE_DTYPE",    value: "auto" }     # 'fp8' when solver picks q8_0 KV
      { key: "TRUST_REMOTE_CODE", value: "0" }        # NEVER 1 — see §6.2
      { key: "HF_HOME",           value: "/runpod-volume/hf" }  # volume-backed weight cache
      { key: "HF_TOKEN",          value: "<decrypted from Vault, private repos only>" }
    ]
  }) { id name }
}
```

Every env value above except `TRUST_REMOTE_CODE` and `GPU_MEMORY_UTILIZATION` is **solver output**, not a creator input. `MAX_MODEL_LEN` and `MAX_NUM_SEQS` in particular must match the placement exactly — a worker configured for more concurrent sequences than the KV budget supports will OOM under load rather than at smoke-test time, which is the worst possible moment to discover it.

```graphql
# 2 — Serverless endpoint: the scale-to-zero contract
mutation CreateEndpoint {
  saveEndpoint(input: {
    name:        "nexus-{creator_handle}-{model_slug}"
    templateId:  "{template_id_from_step_1}"
    gpuIds:      "NVIDIA GeForce RTX 4090"
    workersMin:  0            # ◀── THE product-defining parameter: zero idle cost
    workersMax:  3            # per-model concurrency ceiling; blast-radius control
    idleTimeout: 30           # seconds of inactivity before scaling to zero
    scalerType:  "QUEUE_DELAY"
    scalerValue: 4            # scale up when queue delay exceeds 4 s
    locations:   "US"
    networkVolumeId: null
  }) { id name workersMin idleTimeout }
}
```

```
FR-DEP-030 (P0)  Provisioning is an idempotent Edge Function. A retry after partial
                 failure must not orphan a RunPod template or endpoint.
FR-DEP-031 (P0)  workersMin MUST be 0 and idleTimeout MUST be 30 for every MVP
                 endpoint. These are not creator-configurable — they are the platform's
                 unit-economics guarantee.
FR-DEP-032 (P0)  workersMax defaults to 3. This bounds the worst-case GPU spend a
                 single misbehaving or viral model can generate.
FR-DEP-033 (P0)  Persist runpod_template_id and runpod_endpoint_id immediately on
                 creation, BEFORE the smoke test, so a failed smoke test still leaves a
                 deletable, non-orphaned resource.
FR-DEP-034 (P0)  Status machine:
                   draft → validating → provisioning → smoke_testing → ready
                                                    ↘ failed | auth_failed
                   ready ⇄ paused        ready → deleting → deleted
FR-DEP-035 (P0)  Smoke test: a 1-token completion against the new endpoint, 180 s
                 timeout (a first-ever cold start includes an image pull). Cost is
                 borne by the PLATFORM, never charged to the creator.
FR-DEP-036 (P0)  Provisioning failures store a structured runpod_error and a
                 human-readable remediation_hint for display in Studio.
FR-DEP-037 (P0)  Deletion calls RunPod deleteEndpoint then deleteTemplate, destroys the
                 Vault secret, and soft-deletes the model row. usage_transactions rows
                 are retained for ledger integrity.
FR-DEP-038 (P1)  Orphan reaper cron: list RunPod endpoints, diff against
                 custom_models, delete any RunPod resource with no live DB row.
```

### 4.4 Billing, Metering & Creator Royalties

#### 4.4.1 Monetary Representation

```
FR-BIL-001 (P0)  ALL money is stored as BIGINT micro-USD (1 unit = $0.000001).
                 Floating point is banned from every monetary path — application code,
                 SQL, and API payloads alike. IEEE-754 drift across millions of
                 sub-cent transactions is a correctness bug, not a rounding nuance.
FR-BIL-002 (P0)  Prices are BIGINT micro-USD per 1,000,000 tokens.
                 Example: $0.50 / 1M tokens → 500000.
FR-BIL-003 (P0)  Cost formula, integer-exact with CEIL rounding in the platform's favor:
                   cost_micro = CEIL( prompt_tokens     × price_prompt_micro     / 1e6 )
                              + CEIL( completion_tokens × price_completion_micro / 1e6 )
FR-BIL-004 (P0)  Minimum billable charge is 1 micro-USD for any request that produced
                 at least one token. A zero-cost billable request must not exist.
FR-BIL-005 (P0)  UI formats micro-USD to 6 decimal places for per-request costs and
                 2 for aggregates. Never display a rounded value as if exact.
```

#### 4.4.2 Atomic Settlement

The invariant to defend: **under any concurrency, any client behavior, and any upstream failure, `profiles.balance_micro_usd` never goes negative and no completed stream goes unbilled.**

```
FR-BIL-010 (P0)  Settlement is a single PL/pgSQL function, deduct_token_cost(), executed
                 as ONE transaction. Application code never does read-modify-write on a
                 balance.
FR-BIL-011 (P0)  The function begins with SELECT ... FOR UPDATE on the payer's profiles
                 row. This serializes all concurrent settlements for that user; the
                 lock is held for microseconds.
FR-BIL-012 (P0)  Balance updates use GREATEST(0, balance - cost) as a hard floor, and
                 record any shortfall as write_off_micro_usd on the transaction so Ops
                 can observe (rather than silently absorb) leakage.
FR-BIL-013 (P0)  deduct_token_cost is IDEMPOTENT on transaction id. A retried
                 settlement returns the original result without double-charging.
                 Retries are certain under Edge Function timeouts — idempotency is
                 mandatory, not defensive.
FR-BIL-014 (P0)  The debit, the creator credit, the platform-fee credit, the ledger
                 append, and the hold release are ONE transaction. Partial application
                 is impossible by construction.
FR-BIL-015 (P0)  The function is SECURITY DEFINER with SET search_path = public, pg_temp,
                 and EXECUTE is revoked from anon and authenticated. Only service_role
                 may call it.
```

#### 4.4.3 Revenue Split

```
FR-BIL-020 (P0)  Public models: 80% of cost accrues to the creator, 20% to the platform.
FR-BIL-021 (P0)  Private models: 0% creator accrual, 100% platform. The caller and the
                 creator are the same person — accruing to themselves would be a
                 self-dealing loop that inflates reported earnings.
FR-BIL-022 (P0)  Split percentages are configurable per model (platform_fee_bps,
                 default 2000 = 20.00%) so a promotional or negotiated rate needs no
                 code change.
FR-BIL-023 (P0)  Integer split with the remainder assigned to the PLATFORM:
                   platform_micro = CEIL(cost_micro × fee_bps / 10000)
                   creator_micro  = cost_micro - platform_micro
                 Guarantees creator_micro + platform_micro == cost_micro exactly.
FR-BIL-024 (P0)  Creator earnings accrue to creator_earnings and to
                 profiles.earnings_micro_usd. Earnings are NOT spendable as wallet
                 balance in MVP — two distinct accounts, deliberately.
FR-BIL-025 (P1)  Ops dashboard: GMV, platform revenue, GPU cost, gross margin per model.
```

#### 4.4.4 Wallet Top-Up via Stripe

```
FR-BIL-030 (P0)  Stripe Checkout Sessions only. Card data never touches platform
                 infrastructure (PCI DSS SAQ-A scope).
FR-BIL-031 (P0)  Session created server-side with metadata { user_id, nonce } and
                 client_reference_id = user_id.
FR-BIL-032 (P0)  The webhook is the ONLY source of truth for a credit. The success
                 redirect is a UI hint and is never trusted as payment proof.
FR-BIL-033 (P0)  Webhook signature verification with constructEventAsync is mandatory.
                 Unverified payloads → 400, no side effects.
FR-BIL-034 (P0)  Credits are exactly-once: wallet_ledger.stripe_event_id is UNIQUE, so
                 a duplicate webhook delivery hits a constraint violation that is
                 swallowed as a no-op 200. Stripe retries aggressively; at-least-once
                 delivery must be made effectively-once at the database layer.
FR-BIL-035 (P0)  Handle charge.refunded and charge.dispute.created by debiting the
                 wallet (floored at 0) and flagging the account for Ops review.
FR-BIL-036 (P0)  Limits: min $5, max $500 per top-up; max wallet balance $2,000 (MVP
                 AML/fraud containment).
FR-BIL-037 (P1)  New accounts receive a $1.00 promotional grant as a wallet_ledger
                 entry of kind='grant', so it is auditable and distinguishable from
                 purchased balance.
FR-BIL-038 (P1)  Email at 20% and 5% of the 30-day rolling average balance.
```

### 4.5 Tool Calling (Phase 2.1a)

MVP rejects `tools` / `functions` / `tool_choice` / `function_call` with 501. That single rejection is what makes the platform unusable for agentic clients — Cline, Aider, OpenAI Agents SDK, LangGraph, and Claude Code are all fundamentally tool-call loops. Lifting it is the highest-leverage unlock available, and it is worth doing **before** any wire-format work for a specific client.

```
FR-TOOL-001 (P1)  Accept and forward `tools`, `tool_choice`, `functions`,
                  `function_call` instead of rejecting them. Delete the 501 branch.
FR-TOOL-002 (P1)  llama.cpp must run with `--jinja` so the MODEL'S OWN chat template
                  drives tool formatting. Without it the server ignores `tools`
                  entirely and returns ordinary prose that merely looks like a tool
                  call — the worst failure mode, because it parses as success.
FR-TOOL-003 (P1)  Per-model capability flag `supports_tools`, set at provisioning by
                  probing whether the GGUF chat template declares tool support.
                  A model without it must return a clear 400, never a silent
                  prose-instead-of-tool-call.
FR-TOOL-004 (P1)  The stream tee must handle `delta.tool_calls[]`: entries carry an
                  `index`, an `id`, and `function.arguments` that arrives as
                  INCREMENTAL STRING FRAGMENTS, frequently split mid-JSON across chunk
                  boundaries. Reassembly is per-index. Forwarding stays verbatim, so
                  this affects the usage/accumulator branch only.
FR-TOOL-005 (P1)  `finish_reason: "tool_calls"` must survive to the client, and the
                  non-streaming assembler must rebuild `tool_calls[]` correctly from
                  the fragments.
FR-TOOL-006 (P1)  Tool tokens are ordinary completion tokens and are already inside
                  `usage.completion_tokens`. No billing change — but verify against a
                  real tool-calling response rather than assuming.
FR-TOOL-007 (P2)  Grammar-constrained decoding (llama.cpp GBNF) to guarantee
                  syntactically valid tool JSON, for models whose template is weak.
```

### 4.6 Anthropic Messages API — Claude Code support (Phase 2.1b)

Claude Code honors `ANTHROPIC_BASE_URL`, but it speaks the **Anthropic Messages API**, not OpenAI Chat Completions. The two differ in route, auth, request shape, content model, and streaming protocol.

| | OpenAI (what the gateway serves) | Anthropic (what Claude Code requires) |
|---|---|---|
| Route | `/v1/chat/completions` | `/v1/messages` |
| Auth | `Authorization: Bearer` | `x-api-key` + `anthropic-version` |
| System prompt | a `system` message | **top-level** `system` field |
| `max_tokens` | optional | **required** |
| Assistant content | a string | an array of typed blocks |
| Tool call | `tool_calls[].function.arguments` (JSON string) | `tool_use` block, `input` (parsed object) |
| Tool result | `{role:"tool"}` message | `tool_result` block inside a user message |
| Stream | flat `chat.completion.chunk` list | stateful event sequence: `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop` |
| Usage | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |

```
FR-ANTH-001 (P2)  Translation lives in `packages/anthropic-adapter` as PURE functions
                  with no gateway coupling, so it is testable without a running
                  gateway and reusable by a future standalone proxy.
FR-ANTH-002 (P2)  `POST /v1/messages` on the gateway, reusing the SAME auth ->
                  resolve -> authorize -> proxy -> settle pipeline. The billing path
                  is wire-format agnostic by construction and must not be duplicated.
FR-ANTH-003 (P2)  Accept `x-api-key` in addition to bearer, on this route only.
FR-ANTH-004 (P2)  Anthropic streaming block indices are sequential across the whole
                  message and shared between text and tool_use blocks. A new
                  `content_block_start` opens when OpenAI's `delta.tool_calls[].index`
                  advances, and the previous block must be explicitly closed.
FR-ANTH-005 (P2)  Anthropic reports `input_tokens` in `message_start`, but our upstream
                  reports usage only on the FINAL chunk, so we emit `message_start`
                  with `input_tokens: 0` and correct it in `message_delta`.
                  VERIFIED CONTRACT-LEGAL: `message_delta.usage` is cumulative and may
                  include `input_tokens` — Anthropic itself does this on server-tool
                  turns. It remains a deviation from a plain text turn and must be
                  documented, but it is not a protocol violation as an earlier
                  revision implied.
FR-ANTH-008 (P2)  EVERY event's `data` payload repeats the event name in a `type`
                  field: `{"type":"content_block_stop","index":0}`, not `{"index":0}`.
                  Anthropic SDK clients validate `data.type`, so emitting only the
                  `event:` line yields a stream that looks correct on the wire and
                  fails inside every real client.
FR-ANTH-009 (P2)  `stop_reason` has SEVEN values, not four: end_turn, max_tokens,
                  stop_sequence, tool_use, pause_turn, refusal,
                  model_context_window_exceeded. Map OpenAI `content_filter` ->
                  `refusal`, `function_call` -> `tool_use`, and reverse
                  `model_context_window_exceeded` -> `length`.
FR-ANTH-010 (P2)  `stop_reason: "stop_sequence"` CANNOT be reliably derived from
                  standard OpenAI output. vLLM's non-standard `choice.stop_reason`
                  carries the matched string and should be consulted first; llama.cpp
                  strips the sequence and reports nothing, so a genuine hit degrades to
                  `end_turn`. Anthropic excludes the matched sequence from the text —
                  the non-streaming path can strip it, the streaming path cannot,
                  because the bytes are already gone.
FR-ANTH-011 (P2)  Thinking blocks are `{type:"thinking", thinking:"", signature:""}`
                  and their deltas are `thinking_delta`, NOT `text_delta`. Anthropic
                  emits a `signature_delta` before `content_block_stop`; we cannot mint
                  a signature, so we send an empty one and omit the delta. Document it.
FR-ANTH-012 (P2)  `tool_choice` has a fourth variant `{type:"none"}` -> OpenAI "none".
                  `disable_parallel_tool_use` has no OpenAI equivalent and is dropped
                  with a warning rather than silently.
FR-ANTH-013 (P2)  Error mapping: `overloaded_error` is HTTP **529**, not 503. Also
                  required: billing_error (402), request_too_large (413),
                  timeout_error (504).
FR-ANTH-014 (P2)  `POST /v1/messages/count_tokens` — Claude Code CALLS this endpoint.
                  It has no OpenAI equivalent, so the gateway needs its own estimator.
                  Without it Claude Code fails before sending a single completion.
FR-ANTH-015 (P2)  CONTRACTS.md rule #3 (forward upstream bytes VERBATIM) is
                  structurally impossible on this route — re-framing OpenAI chunks into
                  Anthropic events IS the work. Usage must therefore come from the
                  translator's `message_delta.usage`, not from a byte tee. Settlement
                  must still run outside the client-write path (rule #5), and a
                  cancelled stream must call `.finish()` so partial usage still bills.
FR-ANTH-006 (P2)  Map `reasoning_content` to a `thinking` block. It is billed output
                  and must never be silently dropped.
FR-ANTH-007 (P2)  Claude Code is tool-call-driven, so §4.5 is a HARD PREREQUISITE.
                  Shipping the wire adapter first yields a client that connects and
                  then cannot do anything — worse than not shipping it.
```

> **Honest viability note.** Wire compatibility is necessary, not sufficient. Measured
> decode for the MVP target on an L4 is **14 tok/s**, and an agentic turn emits far more
> tokens than a chat turn. Three things must hold together for agentic coding to feel
> usable, and they define a distinct product tier rather than a flag:
> 1. **Tool calling** (§4.5).
> 2. **A fast tier.** The same model is predicted at ~149 tok/s on an H100 versus 14 on
>    an L4 — a 10x difference that decides whether an agent loop is usable at all.
> 3. **Always-warm** (`min_containers >= 1`, NFR-CS-006). Agent loops re-send a large,
>    stable system prompt every turn, which is the ideal prefix-cache case — but
>    scale-to-zero discards that cache every 30 s. Here, and only here, the platform's
>    core economic mechanism works directly against the use case.
>
> That combination is a coherent paid **"agent tier"**, and it should be priced and named
> as one rather than presented as ordinary inference that happens to be slow.

---

## 5. Complete PostgreSQL Database Schema

> Migration order matters: extensions → enums → tables → indexes → triggers → RLS → functions → grants. The full script below is idempotent-safe for a fresh project and is intended to live as a single Supabase migration.

### 5.1 Extensions, Enums & Helpers

```sql
-- ============================================================================
-- 00_extensions.sql
-- ============================================================================
create extension if not exists "pgcrypto"   with schema extensions;  -- gen_random_uuid, digest
create extension if not exists "pg_trgm"    with schema extensions;  -- fuzzy catalog search
create extension if not exists "supabase_vault";                     -- encrypted HF tokens
create extension if not exists "pg_cron";                            -- reconciliation jobs

-- ============================================================================
-- 01_enums.sql
-- ============================================================================
create type model_status as enum (
  'draft', 'validating', 'provisioning', 'smoke_testing',
  'ready', 'paused', 'failed', 'auth_failed', 'deleting', 'deleted'
);

create type model_visibility as enum ('public', 'private');

create type weights_format as enum ('gguf', 'safetensors', 'awq', 'gptq', 'unknown');

-- Inference runtime. DERIVED from weights_format (FR-DEP-060), never creator-selected.
-- The two are not interchangeable: different images, env contracts, KV mechanics, and
-- usage-reporting fidelity. A GGUF model on the vLLM image does not start.
create type model_runtime as enum ('vllm', 'llamacpp');

-- Role of a discovered .gguf file. ONLY 'model' is deployable (FR-DEP-041a).
-- 'draft' and 'mmproj' files carry standard quant tags in their filenames and are
-- offered as servable models by any classifier that matches on the tag alone.
create type gguf_role as enum ('model', 'draft', 'mmproj', 'lora', 'unknown');

create type txn_status as enum (
  'reserved',   -- hold open, stream in flight
  'settled',    -- billed against real token counts
  'voided',     -- released without charge (upstream failed before any token)
  'expired',    -- swept by the stale-hold reaper
  'failed'      -- terminal error; recorded for observability, not billed
);

create type ledger_kind as enum (
  'topup', 'grant', 'usage_debit', 'refund', 'chargeback', 'adjustment'
);
```

```sql
-- ============================================================================
-- 02_helpers.sql
-- ============================================================================
-- updated_at maintenance
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Integer-exact token cost. numeric intermediate then CEIL: never floats.
create or replace function public.calc_token_cost_micro(
  p_prompt_tokens      integer,
  p_completion_tokens  integer,
  p_price_prompt       bigint,   -- micro-USD per 1M tokens
  p_price_completion   bigint
) returns bigint
language sql immutable parallel safe as $$
  select greatest(
    1,  -- FR-BIL-004: minimum billable unit
      ceil(  (p_prompt_tokens::numeric     * p_price_prompt::numeric)     / 1000000 )::bigint
    + ceil(  (p_completion_tokens::numeric * p_price_completion::numeric) / 1000000 )::bigint
  );
$$;
```

### 5.2 `profiles`

```sql
-- ============================================================================
-- 10_profiles.sql
-- ============================================================================
create table public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,

  -- Identity. handle forms the `creator/` namespace and is therefore immutable.
  handle                text not null unique
                          check (handle ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  display_name          text,
  avatar_url            text,
  bio                   text check (char_length(bio) <= 500),

  -- Wallet: spendable, purchased balance. micro-USD. NEVER negative.
  balance_micro_usd     bigint not null default 0 check (balance_micro_usd >= 0),

  -- Earnings: accrued creator royalties. A SEPARATE account from balance (FR-BIL-024).
  earnings_micro_usd    bigint not null default 0 check (earnings_micro_usd >= 0),
  lifetime_earnings_micro_usd bigint not null default 0 check (lifetime_earnings_micro_usd >= 0),
  lifetime_spend_micro_usd    bigint not null default 0 check (lifetime_spend_micro_usd >= 0),

  -- Risk / ops controls
  max_balance_micro_usd bigint not null default 2000000000,   -- $2,000 (FR-BIL-036)
  is_suspended          boolean not null default false,
  suspension_reason     text,
  rate_limit_rpm        integer not null default 60 check (rate_limit_rpm > 0),

  stripe_customer_id    text unique,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on column public.profiles.balance_micro_usd is
  'Spendable prepaid wallet, micro-USD. Mutated ONLY by SECURITY DEFINER RPCs '
  '(deduct_token_cost, credit_wallet). CHECK >= 0 is the last line of defense.';

create index profiles_handle_idx on public.profiles (handle);
create index profiles_stripe_customer_idx on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- ── Auto-provision a profile on signup ──────────────────────────────────────
create or replace function public.tg_on_auth_user_created()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_base   text;
  v_handle text;
  v_n      integer := 0;
begin
  v_base := lower(regexp_replace(
              coalesce(new.raw_user_meta_data->>'user_name',
                       split_part(new.email, '@', 1),
                       'user'),
              '[^a-z0-9-]', '', 'g'));
  if char_length(v_base) < 2 then v_base := 'user' || v_base; end if;
  v_base   := left(v_base, 30);
  v_handle := v_base;

  while exists (select 1 from public.profiles where handle = v_handle) loop
    v_n := v_n + 1;
    v_handle := left(v_base, 30) || '-' || v_n;
  end loop;

  insert into public.profiles (id, handle, display_name, avatar_url)
  values (new.id, v_handle,
          new.raw_user_meta_data->>'full_name',
          new.raw_user_meta_data->>'avatar_url');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_on_auth_user_created();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

-- Own full row.
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

-- Update own row, but ONLY the genuinely user-editable columns.
--
-- ALLOWLIST, not denylist. An earlier revision enumerated the columns that must NOT
-- change, and it failed exactly as that pattern always does: `lifetime_earnings_micro_usd`,
-- `lifetime_spend_micro_usd`, and `stripe_customer_id` were added later and silently
-- became user-writable. Proven live under `SET ROLE authenticated`. Because
-- stripe_customer_id is UNIQUE, a user could squat another user's `cus_...` id and deny
-- them their Stripe linkage; lifetime_earnings drives payout reporting.
--
-- Asserting what MAY change means every future column is protected by default.
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and (select p.handle from public.profiles p where p.id = auth.uid()) = handle
    and not exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and (p.balance_micro_usd,  p.earnings_micro_usd, p.lifetime_earnings_micro_usd,
              p.lifetime_spend_micro_usd, p.max_balance_micro_usd, p.is_suspended,
              p.rate_limit_rpm, p.stripe_customer_id, p.created_at)
         is distinct from
             (balance_micro_usd,    earnings_micro_usd,   lifetime_earnings_micro_usd,
              lifetime_spend_micro_usd,  max_balance_micro_usd,   is_suspended,
              rate_limit_rpm,       stripe_customer_id,   created_at)
    )
  );

-- Defense in depth: narrow the grant itself so the policy is not the only gate.
--   grant update (display_name, avatar_url, bio) on public.profiles to authenticated;

-- No client INSERT / DELETE: the auth trigger owns creation, CASCADE owns deletion.

-- Public creator identity for the catalog, via a narrow view (no money columns).
create view public.creator_public
  with (security_invoker = true) as
  select id, handle, display_name, avatar_url, bio, created_at
  from public.profiles
  where is_suspended = false;

grant select on public.creator_public to anon, authenticated;
```

### 5.3 `api_keys`

```sql
-- ============================================================================
-- 20_api_keys.sql
-- ============================================================================
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,

  name          text not null check (char_length(name) between 1 and 60),

  -- SHA-256 hex of the full plaintext key. The plaintext is NEVER stored (FR-GW-010).
  key_hash      text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),

  -- Display-only prefix, e.g. 'sk-plat-a1b2c3d4'. Safe to show; not sufficient to auth.
  key_prefix    text not null check (key_prefix ~ '^sk-plat-[A-Za-z0-9_-]{8}$'),

  scopes        text[] not null default array['inference']::text[],

  last_used_at  timestamptz,
  request_count bigint not null default 0,
  revoked_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.api_keys is
  'Virtual platform keys (sk-plat-...). Only the SHA-256 hash is persisted. '
  'Gateway auth is a single indexed lookup on key_hash.';

-- THE hot-path index. Partial on live keys keeps it small and cache-resident.
create unique index api_keys_hash_active_idx
  on public.api_keys (key_hash) where revoked_at is null;

create index api_keys_user_idx on public.api_keys (user_id, created_at desc);

create trigger api_keys_updated_at
  before update on public.api_keys
  for each row execute function public.tg_set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.api_keys enable row level security;

-- Read own keys. key_hash is readable by its owner but is useless without the
-- plaintext preimage, so this leaks nothing exploitable.
create policy api_keys_select_own on public.api_keys
  for select to authenticated using (user_id = auth.uid());

-- Creation goes through an Edge Function (which generates entropy and returns the
-- plaintext exactly once). No client INSERT policy exists, by design.

-- Owner may rename and revoke. Owner may NOT rotate the hash in place.
create policy api_keys_update_own on public.api_keys
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and key_hash   = (select k.key_hash   from public.api_keys k where k.id = api_keys.id)
    and key_prefix = (select k.key_prefix from public.api_keys k where k.id = api_keys.id)
  );

create policy api_keys_delete_own on public.api_keys
  for delete to authenticated using (user_id = auth.uid());
```

### 5.4 `gpu_tiers` & `custom_models`

```sql
-- ============================================================================
-- 30_gpu_tiers.sql   (INTERNAL capability catalog: FR-DEP-055)
--
-- This table is solver input, NOT a creator-facing menu. It is readable by
-- authenticated users only so the Studio can render the resolved result; it is
-- never presented as a set of options to choose between.
-- ============================================================================
create table public.gpu_tiers (
  id                    text primary key,               -- 'rtx4090', 'l40s', 'h100_80'
  label                 text not null,
  vram_bytes            bigint not null check (vram_bytes > 0),
  -- Memory bandwidth drives single-stream decode throughput. NOTE: this is NOT
  -- monotonic with VRAM — the L40S has 2x the memory of a 4090 but LESS bandwidth,
  -- so a "bigger" tier can be slower. Precisely why creators must not pick tiers.
  memory_bandwidth_bytes_s bigint not null check (memory_bandwidth_bytes_s > 0),
  runpod_gpu_ids        text not null,                  -- RunPod saveEndpoint gpuIds
  usd_per_hour_micro    bigint not null check (usd_per_hour_micro > 0),
  container_disk_gb     integer not null default 60,
  supports_vllm         boolean not null default true,
  supports_llamacpp     boolean not null default true,
  is_enabled            boolean not null default true,
  sort_order            integer not null default 0
);

insert into public.gpu_tiers
  (id, label, vram_bytes, memory_bandwidth_bytes_s, runpod_gpu_ids,
   usd_per_hour_micro, container_disk_gb, sort_order) values
  ('rtx4090', 'RTX 4090 24GB', 25769803776,  1008000000000, 'NVIDIA GeForce RTX 4090',  440000,  60, 10),
  ('l40s',    'L40S 48GB',     51539607552,   864000000000, 'NVIDIA L40S',              860000,  80, 20),
  ('a100_80', 'A100 80GB',     85899345920,  1935000000000, 'NVIDIA A100 80GB PCIe',   1640000, 120, 30),
  ('h100_80', 'H100 80GB',     85899345920,  3350000000000, 'NVIDIA H100 80GB HBM3',   2990000, 120, 40);

alter table public.gpu_tiers enable row level security;
-- Authenticated only: anon has no reason to enumerate platform hardware.
create policy gpu_tiers_read_authed on public.gpu_tiers
  for select to authenticated using (is_enabled = true);

-- Solver constants, recalibrated from production measurements (FR-DEP-058).
create table public.solver_config (
  key         text primary key,
  value       numeric not null,
  description text
);
insert into public.solver_config (key, value, description) values
  ('mfu',                  0.75, 'Achieved fraction of theoretical memory bandwidth'),
  ('vram_utilization',     0.92, 'GPU_MEMORY_UTILIZATION passed to the worker'),
  ('assumed_utilization',  0.35, 'Assumed endpoint saturation used in cost-floor math'),
  ('speed_tolerance',      0.90, 'Fraction of target tok/s accepted as meeting target'),
  -- Without a reserved pool, KV is fully consumed by active sequences and every
  -- cached prefix is evicted on arrival — APC silently does nothing (NFR-CACHE-021).
  ('prefix_cache_reserve', 0.15, 'Fraction of the KV region held for prefix caching'),
  ('volume_threshold_bytes', 21474836480, 'Variants above this get a network volume'),
  ('download_bytes_per_s', 314572800, 'Assumed HF->RunPod throughput for cold-start budget');

alter table public.solver_config enable row level security;
create policy solver_config_read on public.solver_config
  for select to authenticated using (true);
```

```sql
-- ============================================================================
-- 31_custom_models.sql
-- ============================================================================
create table public.custom_models (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,

  -- ── Identity: (user_id, slug) is the addressable `creator/model-slug` ──────
  slug                text not null check (slug ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  display_name        text not null check (char_length(display_name) between 1 and 100),
  description         text check (char_length(description) <= 2000),

  -- ── Source ────────────────────────────────────────────────────────────────
  hf_repo_slug        text not null check (hf_repo_slug ~ '^[\w.-]+/[\w.-]+$'),
  hf_revision         text not null default 'main',
  served_model_name   text not null,          -- identifier the worker actually serves
  weights_format      weights_format not null default 'unknown',

  -- ── Inference runtime, DERIVED from format (FR-DEP-060). Never creator-chosen. ──
  runtime             model_runtime not null,

  -- ── Selected VARIANT (FR-DEP-040): a repo yields many, a deployment is one ─
  variant_quant_tag   text,                   -- 'Q4_K_M', 'IQ4_XS', 'AWQ', NULL = native
  -- Family discriminator (FR-DEP-041b): 'noMTP', 'i1', … NULL = the base family.
  -- Two variants sharing a quant tag but differing here are DIFFERENT MODELS.
  variant_family      text,
  -- The specific file llama.cpp must load. vLLM resolves a repo; llama.cpp resolves a
  -- file, and passing only the repo is ambiguous in any multi-quant repo (FR-DEP-061).
  variant_files       text[] not null default '{}',   -- split GGUF: all shards (FR-DEP-042)
  -- Discovered but NOT served in MVP (FR-DEP-046, FR-DEP-063):
  --   {"draft": "…-draft-Q8_0.gguf", "mmproj": "…-vision-f16.gguf"}
  companion_assets    jsonb not null default '{}'::jsonb,
  weights_bytes       bigint not null check (weights_bytes > 0),
  -- MoE: bytes actually READ per decoded token. Drives throughput, not VRAM (FR-DEP-044).
  active_weights_bytes bigint not null check (active_weights_bytes > 0),

  -- ── Architecture, probed from config.json / GGUF header (FR-DEP-043) ──────
  -- Required by the KV-cache term of the capacity solver. n_kv_heads is the GQA
  -- head count, NOT n_attention_heads — confusing them over-estimates KV by up to 8x.
  n_layers            integer check (n_layers > 0),
  n_kv_heads          integer check (n_kv_heads > 0),
  head_dim            integer check (head_dim > 0),
  kv_dtype_bytes      smallint not null default 2 check (kv_dtype_bytes in (1, 2)),
  max_position_embeddings integer,

  -- ── CREATOR INTENT (the only capacity inputs a human supplies) ────────────
  context_length          integer not null default 4096 check (context_length > 0),
  context_verified        boolean not null default false,
  target_tokens_per_second integer not null default 30
                            check (target_tokens_per_second > 0),

  -- ── Private-repo credential: Vault secret UUID ONLY (FR-DEP-010) ──────────
  hf_token_secret_id  uuid,                   -- vault.secrets(id); NULL for public repos
  requires_hf_auth    boolean not null default false,

  -- ── RESOLVED PLACEMENT — solver output, never a creator input ─────────────
  -- Nullable until the solver runs: the creator inserts intent, the Edge Function
  -- writes placement. A 'ready' model must have both (see check constraint below).
  gpu_tier_id         text references public.gpu_tiers(id),
  gpu_usd_per_hour_micro_snapshot bigint,            -- FR-DEP-051: stable cost math
  predicted_tokens_per_second integer,               -- solver estimate (internal)
  measured_tokens_per_second  integer,               -- smoke-test truth (FR-DEP-052);
                                                     -- this is what the catalog displays
  max_concurrent_streams integer check (max_concurrent_streams > 0),
  kv_bytes_per_token  bigint,
  cost_floor_micro_per_mtoken bigint,
  -- Full solver input+output snapshot: which tiers were considered, why each was
  -- rejected, the VRAM breakdown, the constants in force. Makes every placement
  -- auditable and every "why this GPU?" answer reconstructible after the fact.
  placement_rationale jsonb,
  hardware_pinned     boolean not null default false,  -- FR-DEP-056 expert override

  -- ── Weight-cache strategy & the per-model cold-start budget (§6.6 C1) ─────
  -- A single global cold-start timeout either kills healthy large models or masks
  -- dead small ones, so the budget scales with variant size.
  cold_start_budget_s integer not null default 90
                        check (cold_start_budget_s between 90 and 300),
  runpod_volume_id    text,                   -- NULL = node-cached weights only
  volume_gb           integer not null default 0 check (volume_gb >= 0),
  volume_monthly_micro_usd bigint not null default 0,  -- the real, non-zero idle cost
  prefix_caching_enabled boolean not null default true,
  cached_discount_bps integer not null default 0
                        check (cached_discount_bps between 0 and 10000),  -- FR-BIL-043

  -- ── Pricing: micro-USD per 1,000,000 tokens (FR-BIL-002) ──────────────────
  price_prompt_micro_usd_per_mtoken     bigint not null
    check (price_prompt_micro_usd_per_mtoken     between 0 and 1000000000),
  price_completion_micro_usd_per_mtoken bigint not null
    check (price_completion_micro_usd_per_mtoken between 0 and 1000000000),
  platform_fee_bps    integer not null default 2000
                        check (platform_fee_bps between 0 and 10000),
  pricing_version     integer not null default 1,

  -- ── Distribution ──────────────────────────────────────────────────────────
  visibility          model_visibility not null default 'private',
  status              model_status     not null default 'draft',

  -- ── RunPod resources ──────────────────────────────────────────────────────
  runpod_template_id  text,
  runpod_endpoint_id  text unique,
  runpod_workers_max  integer not null default 3 check (runpod_workers_max between 1 and 10),
  runpod_idle_timeout integer not null default 30 check (runpod_idle_timeout = 30),
  runpod_workers_min  integer not null default 0 check (runpod_workers_min = 0),  -- FR-DEP-031

  -- ── Diagnostics ───────────────────────────────────────────────────────────
  provisioning_error  jsonb,
  remediation_hint    text,
  last_error_at       timestamptz,

  -- ── Denormalized counters (trigger-maintained; catalog sort/display) ───────
  total_requests      bigint not null default 0,
  total_prompt_tokens bigint not null default 0,
  total_completion_tokens bigint not null default 0,
  p50_ttft_ms         integer,
  p95_ttft_ms         integer,

  -- ── Full-text search ──────────────────────────────────────────────────────
  search_vector       tsvector generated always as (
                        setweight(to_tsvector('english', coalesce(display_name, '')), 'A') ||
                        setweight(to_tsvector('english', coalesce(slug, '')),         'A') ||
                        setweight(to_tsvector('english', coalesce(hf_repo_slug, '')), 'B') ||
                        setweight(to_tsvector('english', coalesce(description, '')),  'C')
                      ) stored,

  ready_at            timestamptz,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint custom_models_user_slug_uniq unique (user_id, slug),
  -- Runtime must match format (FR-DEP-060). Enforced in the schema because a mismatch
  -- provisions a worker that cannot start, and fails 100+ seconds into a cold start.
  constraint custom_models_runtime_matches_format check (
    (weights_format = 'gguf' and runtime = 'llamacpp') or
    (weights_format in ('safetensors','awq','gptq') and runtime = 'vllm') or
    weights_format = 'unknown'),
  -- llama.cpp loads a FILE, not a repo. A GGUF deployment without one is unprovisionable.
  constraint custom_models_gguf_needs_file
    check (runtime <> 'llamacpp' or array_length(variant_files, 1) >= 1),
  -- A ready model must have a real endpoint behind it.
  constraint custom_models_ready_needs_endpoint
    check (status <> 'ready' or runpod_endpoint_id is not null),
  -- A ready model must have been placed by the solver and speed-verified.
  constraint custom_models_ready_needs_placement
    check (status <> 'ready' or (gpu_tier_id is not null
                                 and gpu_usd_per_hour_micro_snapshot is not null
                                 and max_concurrent_streams is not null
                                 and measured_tokens_per_second is not null)),
  -- Context can never exceed what the architecture supports.
  constraint custom_models_context_within_arch
    check (max_position_embeddings is null or context_length <= max_position_embeddings),
  -- A private/gated repo must carry a credential reference.
  constraint custom_models_auth_needs_secret
    check (requires_hf_auth = false or hf_token_secret_id is not null)
);

comment on column public.custom_models.hf_token_secret_id is
  'UUID of a supabase_vault secret. The plaintext HF token is reachable ONLY from '
  'service_role inside an Edge Function. No RLS policy, view, or RPC exposes it.';

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Gateway hot path: resolve creator/slug in one indexed lookup.
create index custom_models_resolve_idx
  on public.custom_models (user_id, slug)
  where deleted_at is null and status = 'ready';

-- Catalog listing.
create index custom_models_catalog_idx
  on public.custom_models (created_at desc)
  where visibility = 'public' and status = 'ready' and deleted_at is null;

create index custom_models_search_idx on public.custom_models using gin (search_vector);
create index custom_models_trgm_idx   on public.custom_models using gin (display_name extensions.gin_trgm_ops);
create index custom_models_owner_idx  on public.custom_models (user_id, created_at desc)
  where deleted_at is null;
-- Capability filters for the marketplace rail (FR-MKT-004). Indexed on what
-- developers actually filter by — speed and context — not on hardware.
create index custom_models_capability_idx
  on public.custom_models (measured_tokens_per_second desc, context_length desc)
  where visibility = 'public' and status = 'ready' and deleted_at is null;
create index custom_models_endpoint_idx on public.custom_models (runpod_endpoint_id)
  where runpod_endpoint_id is not null;

create trigger custom_models_updated_at
  before update on public.custom_models
  for each row execute function public.tg_set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.custom_models enable row level security;

-- Public catalog: anonymous read of ready, public, non-deleted models only.
create policy custom_models_select_public on public.custom_models
  for select to anon, authenticated
  using (visibility = 'public' and status = 'ready' and deleted_at is null);

-- Owner sees everything of their own, in any status.
create policy custom_models_select_own on public.custom_models
  for select to authenticated using (user_id = auth.uid());

-- Owner creates in a non-live status only. Provisioning/readiness is service_role's job,
-- and pricing/visibility cannot be smuggled past validation.
create policy custom_models_insert_own on public.custom_models
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status in ('draft', 'validating')
    and runpod_endpoint_id is null
    and runpod_template_id is null
    and runpod_workers_min = 0
    and runpod_idle_timeout = 30
  );

-- Owner edits metadata, pricing, and visibility. Owner may NOT change identity,
-- source, hardware, RunPod ids, credential reference, or counters.
create policy custom_models_update_own on public.custom_models
  for update to authenticated
  using (user_id = auth.uid() and deleted_at is null)
  with check (
    user_id = auth.uid()
    and slug               = (select m.slug               from public.custom_models m where m.id = custom_models.id)
    and hf_repo_slug       = (select m.hf_repo_slug       from public.custom_models m where m.id = custom_models.id)
    -- gpu_tier_id is NULL until the solver runs, and `NULL = NULL` is NULL — which
    -- fails WITH CHECK. Plain `=` here rejects EVERY edit to a draft model. Every
    -- nullable column compared in this policy must use `is not distinct from`.
    and gpu_tier_id is not distinct from
                             (select m.gpu_tier_id        from public.custom_models m where m.id = custom_models.id)
    and runpod_endpoint_id is not distinct from
                             (select m.runpod_endpoint_id from public.custom_models m where m.id = custom_models.id)
    and hf_token_secret_id is not distinct from
                             (select m.hf_token_secret_id from public.custom_models m where m.id = custom_models.id)
    and total_requests     = (select m.total_requests     from public.custom_models m where m.id = custom_models.id)
    and platform_fee_bps   = (select m.platform_fee_bps   from public.custom_models m where m.id = custom_models.id)
    and runpod_workers_min = 0
  );

-- No client DELETE: deletion must tear down RunPod resources and the Vault secret
-- first, so it is an Edge Function workflow ending in a soft delete.

-- Creator INSERT may not write solver output. Placement is service_role's job.
-- (Amends custom_models_insert_own from above.)
drop policy if exists custom_models_insert_own on public.custom_models;
create policy custom_models_insert_own on public.custom_models
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status in ('draft', 'validating')
    and runpod_endpoint_id is null
    and runpod_template_id is null
    and runpod_workers_min = 0
    and runpod_idle_timeout = 30
    -- Solver output columns must be empty on creator insert.
    and gpu_tier_id is null
    and measured_tokens_per_second is null
    and max_concurrent_streams is null
    and placement_rationale is null
  );
```

### 5.4a The Capacity Solver — `resolve_placement()`

Implemented in Postgres so the Studio preview and the provisioning path call **one** function. A second implementation in TypeScript would drift, and the drift would surface as a model card promising a throughput the endpoint was never provisioned to deliver.

```sql
-- ============================================================================
-- 32_resolve_placement.sql
--
-- Pure function over probed facts. Given a variant's weights, the model's
-- attention geometry, and the creator's intent, return the cheapest GPU tier
-- that satisfies both constraints — plus the full rationale.
--
-- Returns a jsonb envelope in both the feasible and infeasible cases; the
-- infeasible case carries the specific blocking quantity so the UI can render
-- an actionable message rather than "unsupported configuration" (§4.3.3.5).
-- ============================================================================
create or replace function public.resolve_placement(
  p_weights_bytes         bigint,
  p_active_weights_bytes  bigint,   -- = weights for dense; active experts for MoE
  p_n_layers              integer,
  p_n_kv_heads            integer,  -- GQA count, NOT n_attention_heads
  p_head_dim              integer,
  p_context_length        integer,
  p_target_tokens_per_second integer,
  p_kv_dtype_bytes        smallint default 2,   -- 2 = fp16, 1 = q8_0 (FR-DEP-054)
  p_pin_tier_id           text default null     -- FR-DEP-056 expert override
)
returns jsonb
language plpgsql stable parallel safe
set search_path = public, pg_temp
as $$
declare
  v_mfu            numeric;
  v_vram_util      numeric;
  v_assumed_util   numeric;
  v_tolerance      numeric;
  v_prefix_reserve   numeric;
  v_volume_threshold numeric;
  v_download_rate    numeric;

  v_kv_per_token  bigint;
  v_overhead      bigint;
  v_tier          record;
  v_usable        bigint;
  v_kv_total      bigint;
  v_required      bigint;
  v_tok_s         numeric;
  v_concurrent    integer;
  v_cost_floor    bigint;

  v_considered    jsonb := '[]'::jsonb;
  v_reject        text;
  v_best          jsonb := null;
  v_any_fits      boolean := false;
  v_fastest       numeric := 0;
  v_max_ctx_fit   integer := 0;
begin
  select max(case when key = 'mfu'                  then value end),
         max(case when key = 'vram_utilization'     then value end),
         max(case when key = 'assumed_utilization'  then value end),
         max(case when key = 'speed_tolerance'      then value end),
         max(case when key = 'prefix_cache_reserve'   then value end),
         max(case when key = 'volume_threshold_bytes' then value end),
         max(case when key = 'download_bytes_per_s'   then value end)
    into v_mfu, v_vram_util, v_assumed_util, v_tolerance, v_prefix_reserve,
         v_volume_threshold, v_download_rate
    from public.solver_config;

  -- KV cache per token: 2 (K and V) x layers x kv_heads x head_dim x dtype.
  v_kv_per_token := 2::bigint * p_n_layers * p_n_kv_heads * p_head_dim * p_kv_dtype_bytes;

  -- Framework, CUDA graphs, temp buffers.
  v_overhead := greatest(2147483648::bigint, (p_weights_bytes * 0.10)::bigint);

  for v_tier in
    select * from public.gpu_tiers
     where is_enabled
       and (p_pin_tier_id is null or id = p_pin_tier_id)
     order by usd_per_hour_micro asc
  loop
    v_usable   := (v_tier.vram_bytes * v_vram_util)::bigint;
    v_kv_total := v_kv_per_token * p_context_length;      -- one stream
    v_required := p_weights_bytes + v_kv_total + v_overhead;

    -- Single-stream decode is memory-bandwidth bound: read active weights per token.
    v_tok_s := (v_tier.memory_bandwidth_bytes_s * v_mfu) / p_active_weights_bytes;

    v_reject := null;

    if v_required > v_usable then
      v_reject := format('needs %s GB, usable %s GB',
                         round(v_required / 1073741824.0, 1),
                         round(v_usable   / 1073741824.0, 1));
    elsif v_tok_s < p_target_tokens_per_second * v_tolerance then
      v_reject := format('%s tok/s, target %s',
                         round(v_tok_s), p_target_tokens_per_second);
    end if;

    -- How many streams fit after weights + overhead, MINUS the prefix-cache pool.
    -- Reserving this pool is what makes automatic prefix caching actually retain
    -- anything under load (NFR-CACHE-021).
    v_concurrent := greatest(0, floor(
      ((v_usable - p_weights_bytes - v_overhead)::numeric * (1 - v_prefix_reserve))
      / v_kv_total)::integer);

    if v_reject is null and v_concurrent >= 1 then
      v_any_fits := true;

      -- micro-USD per 1M tokens at assumed saturation.
      v_cost_floor := ceil(
        (v_tier.usd_per_hour_micro::numeric / 3600)
        * (1000000.0 / (v_tok_s * v_concurrent * v_assumed_util))
      )::bigint;

      if v_best is null then          -- tiers iterate cheapest-first: first hit wins
        v_best := jsonb_build_object(
          'gpu_tier_id',            v_tier.id,
          'gpu_label',              v_tier.label,
          'usd_per_hour_micro',     v_tier.usd_per_hour_micro,
          'predicted_tokens_per_second', round(v_tok_s)::integer,
          'max_concurrent_streams', v_concurrent,
          'kv_bytes_per_token',     v_kv_per_token,
          'kv_bytes_total',         v_kv_total,
          'weights_bytes',          p_weights_bytes,
          'overhead_bytes',         v_overhead,
          'usable_vram_bytes',      v_usable,
          'kv_dtype_bytes',         p_kv_dtype_bytes,
          'prefix_cache_bytes',     ((v_usable - p_weights_bytes - v_overhead)
                                     * v_prefix_reserve)::bigint,
          -- Weight-cache strategy (§6.6 C1). Large variants need a network volume,
          -- which is a real fixed monthly cost that must reach the cost floor and
          -- the Deployment Plan card — the one place "$0 idle" is not literal.
          'needs_volume',           (p_weights_bytes > v_volume_threshold),
          'volume_gb',              case when p_weights_bytes > v_volume_threshold
                                      then ceil(p_weights_bytes / 1073741824.0 * 1.25)::integer
                                      else 0 end,
          'cold_start_budget_s',    least(300, greatest(90,
                                      45 + ceil(p_weights_bytes / v_download_rate)::integer)),
          'cost_floor_micro_per_mtoken', v_cost_floor);
      end if;
    end if;

    -- Track the best near-misses so infeasibility messages can be specific.
    if v_required <= v_usable then
      v_fastest := greatest(v_fastest, v_tok_s);
      -- Same prefix reserve as the concurrency calc: an advisory maximum the creator
      -- can actually deploy at, not an optimistic number that fails on submit.
      v_max_ctx_fit := greatest(v_max_ctx_fit, greatest(0, floor(
        ((v_usable - p_weights_bytes - v_overhead)::numeric * (1 - v_prefix_reserve))
        / v_kv_per_token)::integer));
    end if;

    v_considered := v_considered || jsonb_build_object(
      'tier',       v_tier.id,
      'accepted',   (v_reject is null and v_concurrent >= 1),
      'reason',     coalesce(v_reject,
                      case when v_concurrent < 1 then 'no room for a single stream'
                           else 'accepted' end),
      'predicted_tokens_per_second', round(v_tok_s)::integer,
      'required_bytes', v_required);
  end loop;

  if v_best is not null then
    return jsonb_build_object('feasible', true, 'considered', v_considered)
           || v_best;
  end if;

  -- ── Infeasible: name the blocking quantity and offer a concrete remedy ─────
  return jsonb_build_object(
    'feasible',   false,
    'considered', v_considered,
    'blocking_reason',
      case
        when not v_any_fits and v_max_ctx_fit = 0
          then 'Weights do not fit on any available GPU'
        when v_max_ctx_fit < p_context_length
          then format('Context of %s tokens does not fit; %s is the maximum at this quality',
                      p_context_length, v_max_ctx_fit)
        else format('Target of %s tok/s is unreachable; %s tok/s is the fastest available',
                    p_target_tokens_per_second, round(v_fastest))
      end,
    'max_context_at_this_quality', v_max_ctx_fit,
    'fastest_available_tokens_per_second', round(v_fastest)::integer);
end $$;

grant execute on function public.resolve_placement(
  bigint,bigint,integer,integer,integer,integer,integer,smallint,text)
  to authenticated, service_role;
-- Readable by authenticated users: the Studio calls it directly for live preview.
-- It is a pure function over public capability data and creator-supplied numbers,
-- so it discloses nothing sensitive.
```

```
FR-DB-007 (P0)  resolve_placement is the ONLY placement implementation. The Studio
                preview and the deploy path both call it. A TypeScript reimplementation
                is prohibited — drift between them becomes a public, false spec claim.
FR-DB-008 (P0)  The deploy path re-runs resolve_placement server-side and ignores any
                placement supplied by the client. A client-supplied GPU tier would let
                a creator provision an H100 while being quoted a 4090 cost floor.
```

### 5.5 `usage_transactions`

```sql
-- ============================================================================
-- 40_usage_transactions.sql
-- ============================================================================
create table public.usage_transactions (
  id                  uuid primary key,            -- request id (UUIDv7), client-visible
  user_id             uuid not null references public.profiles(id) on delete restrict,
  api_key_id          uuid references public.api_keys(id) on delete set null,
  model_id            uuid not null references public.custom_models(id) on delete restrict,
  creator_id          uuid not null references public.profiles(id) on delete restrict,

  status              txn_status not null default 'reserved',

  -- ── Reservation phase ─────────────────────────────────────────────────────
  hold_micro_usd      bigint not null default 0 check (hold_micro_usd >= 0),
  est_prompt_tokens   integer,
  max_tokens_requested integer,
  expires_at          timestamptz not null,        -- stale-hold reaper boundary

  -- ── Price snapshot (FR-GW-024): immune to mid-flight creator price edits ──
  price_prompt_micro_snapshot     bigint not null,
  price_completion_micro_snapshot bigint not null,
  platform_fee_bps_snapshot       integer not null,

  -- ── Settlement phase ──────────────────────────────────────────────────────
  prompt_tokens       integer check (prompt_tokens >= 0),
  completion_tokens   integer check (completion_tokens >= 0),
  total_tokens        integer generated always as
                        (coalesce(prompt_tokens,0) + coalesce(completion_tokens,0)) stored,
  usage_estimated     boolean not null default false,   -- FR-GW-044 fallback path used

  -- Prefix-cache hit within prompt_tokens (FR-BIL-040). Recorded ALWAYS; billed at the
  -- full rate in MVP (FR-BIL-042). Persisting it now means the pricing decision can
  -- later be made against real hit-rate data instead of speculation.
  cached_prompt_tokens integer not null default 0 check (cached_prompt_tokens >= 0),
  constraint usage_txn_cached_within_prompt
    check (prompt_tokens is null or cached_prompt_tokens <= prompt_tokens),

  cost_micro_usd      bigint check (cost_micro_usd >= 0),
  creator_micro_usd   bigint check (creator_micro_usd >= 0),
  platform_micro_usd  bigint check (platform_micro_usd >= 0),
  write_off_micro_usd bigint not null default 0 check (write_off_micro_usd >= 0),

  -- ── Observability ─────────────────────────────────────────────────────────
  ttft_ms             integer,
  duration_ms         integer,
  cold_start          boolean,
  client_disconnected boolean not null default false,
  was_streaming       boolean not null default true,
  error_code          text,
  error_message       text,

  created_at          timestamptz not null default now(),
  settled_at          timestamptz,

  -- Split must reconcile to the total, exactly (FR-BIL-023).
  constraint usage_txn_split_reconciles check (
    status <> 'settled'
    or coalesce(creator_micro_usd,0) + coalesce(platform_micro_usd,0) = coalesce(cost_micro_usd,0)
  ),
  -- A settled row must carry real token counts.
  constraint usage_txn_settled_has_usage check (
    status <> 'settled' or (prompt_tokens is not null and completion_tokens is not null)
  )
);

comment on table public.usage_transactions is
  'Append-and-settle metering ledger. Rows are INSERTed as reserved by the gateway and '
  'transitioned exactly once to settled | voided | expired | failed. service_role only.';

-- Console ledger pagination.
create index usage_txn_user_time_idx on public.usage_transactions (user_id, created_at desc);
-- Creator earnings analytics.
create index usage_txn_creator_time_idx on public.usage_transactions (creator_id, created_at desc)
  where status = 'settled';
-- Per-model rollups.
create index usage_txn_model_time_idx on public.usage_transactions (model_id, created_at desc);
-- The reaper's index: tiny, only open holds.
create index usage_txn_open_holds_idx on public.usage_transactions (expires_at)
  where status = 'reserved';
-- Ops: find estimated-usage rows needing review.
create index usage_txn_estimated_idx on public.usage_transactions (created_at desc)
  where usage_estimated = true;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.usage_transactions enable row level security;

-- Payer reads own spend.
create policy usage_txn_select_own on public.usage_transactions
  for select to authenticated using (user_id = auth.uid());

-- Creator reads settled rows for THEIR models (earnings visibility). A creator must not
-- see who called them or with which key — hence the narrow view below, not raw access.
create policy usage_txn_select_as_creator on public.usage_transactions
  for select to authenticated
  using (creator_id = auth.uid() and status = 'settled');

-- NO insert / update / delete policy for any client role. This table is written
-- exclusively by SECURITY DEFINER RPCs invoked with service_role.

-- Creator-facing projection with the payer's identity stripped.
create view public.creator_earnings_feed
  with (security_invoker = true) as
  select t.id, t.model_id, m.slug as model_slug,
         t.prompt_tokens, t.completion_tokens, t.total_tokens,
         t.creator_micro_usd, t.ttft_ms, t.cold_start, t.created_at
  from public.usage_transactions t
  join public.custom_models m on m.id = t.model_id
  where t.creator_id = auth.uid() and t.status = 'settled';

grant select on public.creator_earnings_feed to authenticated;
```

### 5.6 `wallet_ledger` & `creator_earnings`

```sql
-- ============================================================================
-- 50_wallet_ledger.sql   (immutable, append-only cash book)
-- ============================================================================
create table public.wallet_ledger (
  id                  bigserial primary key,
  user_id             uuid not null references public.profiles(id) on delete restrict,

  kind                ledger_kind not null,
  amount_micro_usd    bigint not null,        -- signed: credits > 0, debits < 0
  balance_after_micro_usd bigint not null check (balance_after_micro_usd >= 0),

  -- Exactly-once Stripe credit enforcement (FR-BIL-034).
  stripe_event_id     text unique,
  stripe_session_id   text,
  stripe_payment_intent_id text,

  usage_transaction_id uuid references public.usage_transactions(id) on delete set null,

  memo                text,
  created_at          timestamptz not null default now(),

  constraint wallet_ledger_topup_needs_event
    check (kind <> 'topup' or stripe_event_id is not null),
  constraint wallet_ledger_sign_matches_kind check (
    (kind in ('topup','grant','refund','adjustment') and amount_micro_usd <> 0) or
    (kind in ('usage_debit','chargeback')            and amount_micro_usd <  0)
  )
  -- NOTE: the strict `< 0` here is deliberate, and it makes a caller obligation
  -- explicit: a settlement whose entire cost is written off (empty wallet) moves ZERO
  -- cash, so it must NOT write a ledger row at all. An earlier revision of
  -- deduct_token_cost inserted `-(cost - write_off)` unconditionally, which is 0 in
  -- that case, raised 23514, and left the transaction stranded as 'reserved' with its
  -- hold intact — unbilled GPU work plus stranded balance. That is the NORMAL outcome
  -- whenever two requests race and the first empties the wallet, not an edge case.
  -- The ledger is a cash book: no cash moved, no row. The shortfall is recorded on
  -- usage_transactions.write_off_micro_usd instead.
);

comment on table public.wallet_ledger is
  'Immutable double-entry-style cash book. Every balance mutation on profiles MUST have '
  'exactly one row here. Nightly reconciliation asserts SUM(amount) == profiles.balance.';

create index wallet_ledger_user_time_idx on public.wallet_ledger (user_id, created_at desc);
create index wallet_ledger_kind_idx      on public.wallet_ledger (kind, created_at desc);

alter table public.wallet_ledger enable row level security;

create policy wallet_ledger_select_own on public.wallet_ledger
  for select to authenticated using (user_id = auth.uid());
-- No client write policy. Append-only via RPC. No UPDATE or DELETE policy exists at all,
-- for any role, so immutability is structural rather than procedural.

-- ============================================================================
-- 51_creator_earnings.sql
-- ============================================================================
create table public.creator_earnings (
  id                  bigserial primary key,
  creator_id          uuid not null references public.profiles(id) on delete restrict,
  model_id            uuid not null references public.custom_models(id) on delete restrict,
  usage_transaction_id uuid not null unique
                        references public.usage_transactions(id) on delete restrict,

  gross_micro_usd     bigint not null check (gross_micro_usd >= 0),
  platform_fee_micro_usd bigint not null check (platform_fee_micro_usd >= 0),
  net_micro_usd       bigint not null check (net_micro_usd >= 0),
  fee_bps_applied     integer not null,

  payout_id           uuid,                   -- Phase 2: Stripe Connect transfer
  paid_out_at         timestamptz,

  created_at          timestamptz not null default now(),

  constraint creator_earnings_reconciles
    check (net_micro_usd + platform_fee_micro_usd = gross_micro_usd)
);

-- UNIQUE on usage_transaction_id makes double-accrual impossible even if
-- deduct_token_cost is retried (FR-BIL-013).

create index creator_earnings_creator_time_idx on public.creator_earnings (creator_id, created_at desc);
create index creator_earnings_unpaid_idx on public.creator_earnings (creator_id)
  where paid_out_at is null;

alter table public.creator_earnings enable row level security;

create policy creator_earnings_select_own on public.creator_earnings
  for select to authenticated using (creator_id = auth.uid());
-- No client write policy.
```

### 5.7 The Atomic Billing Functions

```sql
-- ============================================================================
-- 60_rpc_authorize.sql
-- Phase 1 of reserve-then-settle. Gates on balance NET of outstanding holds,
-- so concurrent requests cannot collectively overdraw (FR-GW-021).
-- ============================================================================
create or replace function public.authorize_request(
  p_txn_id              uuid,
  p_user_id             uuid,
  p_api_key_id          uuid,
  p_model_id            uuid,
  p_est_prompt_tokens   integer,
  p_max_tokens          integer,
  p_was_streaming       boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance      bigint;
  v_suspended    boolean;
  v_holds        bigint;
  v_available    bigint;
  v_model        record;
  v_hold         bigint;
  v_min_floor    bigint := 100;   -- $0.0001 floor: never engage a GPU on a dust balance
begin
  -- Idempotency: a retried authorize returns the existing reservation unchanged.
  -- NOTE: an earlier revision assigned a jsonb literal into the bigint variable
  -- v_balance here, which raised on EVERY replay — the one path this branch exists
  -- to serve. Return the stored reservation directly, in the shape CONTRACTS.md
  -- declares (callers read hold_micro_usd on the replay path too).
  select hold_micro_usd into v_hold
    from public.usage_transactions where id = p_txn_id;
  if found then
    return jsonb_build_object(
      'ok', true, 'txn_id', p_txn_id, 'replayed', true,
      'hold_micro_usd',    v_hold,
      'balance_micro_usd', (select balance_micro_usd from public.profiles
                             where id = p_user_id));
  end if;

  -- Lock the payer row: serializes authorize and settle for this user.
  select balance_micro_usd, is_suspended
    into v_balance, v_suspended
    from public.profiles
   where id = p_user_id
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'user_not_found');
  end if;

  if v_suspended then
    return jsonb_build_object('ok', false, 'code', 'account_suspended');
  end if;

  select id, user_id, status, visibility, platform_fee_bps,
         price_prompt_micro_usd_per_mtoken   as pp,
         price_completion_micro_usd_per_mtoken as pc
    into v_model
    from public.custom_models
   where id = p_model_id and deleted_at is null;

  if not found or v_model.status <> 'ready' then
    return jsonb_build_object('ok', false, 'code', 'model_unavailable');
  end if;

  -- Outstanding holds for this user (open reservations not yet expired).
  select coalesce(sum(hold_micro_usd), 0)
    into v_holds
    from public.usage_transactions
   where user_id = p_user_id
     and status = 'reserved'
     and expires_at > now();

  v_available := v_balance - v_holds;

  -- Conservative worst-case cost for this request.
  v_hold := greatest(
    v_min_floor,
    public.calc_token_cost_micro(
      coalesce(p_est_prompt_tokens, 0),
      coalesce(p_max_tokens, 512),
      v_model.pp, v_model.pc)
  );

  if v_available < v_hold then
    return jsonb_build_object(
      'ok', false, 'code', 'insufficient_balance',
      'balance_micro_usd',   v_balance,
      'available_micro_usd', v_available,
      'required_micro_usd',  v_hold);
  end if;

  insert into public.usage_transactions (
    id, user_id, api_key_id, model_id, creator_id, status,
    hold_micro_usd, est_prompt_tokens, max_tokens_requested, expires_at,
    price_prompt_micro_snapshot, price_completion_micro_snapshot,
    platform_fee_bps_snapshot, was_streaming
  ) values (
    p_txn_id, p_user_id, p_api_key_id, p_model_id, v_model.user_id, 'reserved',
    v_hold, p_est_prompt_tokens, p_max_tokens, now() + interval '15 minutes',
    v_model.pp, v_model.pc, v_model.platform_fee_bps, p_was_streaming
  );

  return jsonb_build_object(
    'ok', true, 'txn_id', p_txn_id,
    'hold_micro_usd',    v_hold,
    'balance_micro_usd', v_balance);
end $$;

revoke all on function public.authorize_request(uuid,uuid,uuid,uuid,integer,integer,boolean) from public, anon, authenticated;
grant execute on function public.authorize_request(uuid,uuid,uuid,uuid,integer,integer,boolean) to service_role;
```

```sql
-- ============================================================================
-- 61_rpc_deduct_token_cost.sql
--
-- THE atomic settlement primitive. One transaction. One row lock. Idempotent.
--
-- Invariants defended here:
--   I1  profiles.balance_micro_usd can never go negative      (FOR UPDATE + GREATEST + CHECK)
--   I2  a transaction settles at most once                    (status guard + earnings UNIQUE)
--   I3  creator + platform == cost, exactly                   (integer split, remainder to platform)
--   I4  every balance mutation has exactly one ledger row     (single transaction)
--   I5  concurrent requests from one wallet cannot overdraw    (serialized by the row lock)
-- ============================================================================
create or replace function public.deduct_token_cost(
  p_txn_id             uuid,
  p_prompt_tokens      integer,
  p_completion_tokens  integer,
  p_ttft_ms            integer default null,
  p_duration_ms        integer default null,
  p_cold_start         boolean default null,
  p_usage_estimated    boolean default false,
  p_client_disconnected boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_txn         record;
  v_cost        bigint;
  v_platform    bigint;
  v_creator     bigint;
  v_balance     bigint;
  v_new_balance bigint;
  v_write_off   bigint := 0;
  v_is_public   boolean;
begin
  if p_prompt_tokens < 0 or p_completion_tokens < 0 then
    raise exception 'token counts must be non-negative (prompt=%, completion=%)',
      p_prompt_tokens, p_completion_tokens
      using errcode = '22023';
  end if;

  -- ── Lock the transaction row FIRST. Deterministic lock order (transaction
  --    then profile) across every RPC in this schema prevents deadlocks. ──────
  select * into v_txn
    from public.usage_transactions
   where id = p_txn_id
     for update;

  if not found then
    raise exception 'unknown transaction %', p_txn_id using errcode = 'P0002';
  end if;

  -- ── I2: IDEMPOTENCY. Edge Function retries are certain, not hypothetical. ──
  if v_txn.status = 'settled' then
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'txn_id',             v_txn.id,
      'cost_micro_usd',     v_txn.cost_micro_usd,
      'creator_micro_usd',  v_txn.creator_micro_usd,
      'platform_micro_usd', v_txn.platform_micro_usd,
      'balance_micro_usd',  (select balance_micro_usd from public.profiles where id = v_txn.user_id));
  end if;

  if v_txn.status not in ('reserved', 'expired') then
    raise exception 'transaction % is in terminal state %', p_txn_id, v_txn.status
      using errcode = '55000';
  end if;

  -- ── Cost from the PRICE SNAPSHOT, never from live model pricing (FR-GW-024) ─
  v_cost := public.calc_token_cost_micro(
              p_prompt_tokens, p_completion_tokens,
              v_txn.price_prompt_micro_snapshot,
              v_txn.price_completion_micro_snapshot);

  -- Zero tokens delivered → void the hold rather than charge a minimum.
  if (p_prompt_tokens + p_completion_tokens) = 0 then
    update public.usage_transactions
       set status = 'voided', prompt_tokens = 0, completion_tokens = 0,
           cost_micro_usd = 0, creator_micro_usd = 0, platform_micro_usd = 0,
           hold_micro_usd = 0, ttft_ms = p_ttft_ms, duration_ms = p_duration_ms,
           cold_start = p_cold_start, client_disconnected = p_client_disconnected,
           settled_at = now()
     where id = p_txn_id;
    return jsonb_build_object('ok', true, 'voided', true, 'cost_micro_usd', 0);
  end if;

  -- ── I3: integer split, remainder to the platform. Sum is exact. ────────────
  v_platform := ceil(v_cost::numeric * v_txn.platform_fee_bps_snapshot / 10000)::bigint;
  v_creator  := v_cost - v_platform;

  select (visibility = 'public') into v_is_public
    from public.custom_models where id = v_txn.model_id;

  -- FR-BIL-021: a creator calling their own private model accrues nothing.
  if not coalesce(v_is_public, false) or v_txn.creator_id = v_txn.user_id then
    v_platform := v_cost;
    v_creator  := 0;
  end if;

  -- ── I1 + I5: lock the payer. All concurrent settlements for this user
  --    serialize here. Lock hold time is microseconds. ────────────────────────
  select balance_micro_usd into v_balance
    from public.profiles
   where id = v_txn.user_id
     for update;

  if v_balance < v_cost then
    -- The hold should have prevented this. Record the shortfall rather than
    -- silently absorbing it, and floor the balance at zero.
    v_write_off := v_cost - v_balance;
    v_new_balance := 0;
  else
    v_new_balance := v_balance - v_cost;
  end if;

  update public.profiles
     set balance_micro_usd      = greatest(0, v_new_balance),
         lifetime_spend_micro_usd = lifetime_spend_micro_usd + (v_cost - v_write_off),
         updated_at             = now()
   where id = v_txn.user_id;

  -- ── I4: the ledger entry for this debit ────────────────────────────────────
  insert into public.wallet_ledger (
    user_id, kind, amount_micro_usd, balance_after_micro_usd,
    usage_transaction_id, memo
  ) values (
    v_txn.user_id, 'usage_debit', -(v_cost - v_write_off), greatest(0, v_new_balance),
    p_txn_id,
    format('%s prompt + %s completion tokens', p_prompt_tokens, p_completion_tokens)
  );

  -- ── Creator accrual. UNIQUE(usage_transaction_id) is the second line of
  --    defense against double accrual under a concurrent retry. ──────────────
  if v_creator > 0 then
    insert into public.creator_earnings (
      creator_id, model_id, usage_transaction_id,
      gross_micro_usd, platform_fee_micro_usd, net_micro_usd, fee_bps_applied
    ) values (
      v_txn.creator_id, v_txn.model_id, p_txn_id,
      v_cost, v_platform, v_creator, v_txn.platform_fee_bps_snapshot
    )
    on conflict (usage_transaction_id) do nothing;

    -- The aggregate MUST be gated on the accrual row actually being inserted.
    -- Updating it unconditionally double-credits a racing retry: ON CONFLICT
    -- protects the creator_earnings row, then the aggregate is bumped anyway —
    -- silently breaking reconciliation rule R5
    -- (SUM(creator_earnings.net) == SUM(profiles.lifetime_earnings)).
    get diagnostics v_accrued = row_count;
    if v_accrued > 0 then
      update public.profiles
         set earnings_micro_usd          = earnings_micro_usd + v_creator,
             lifetime_earnings_micro_usd = lifetime_earnings_micro_usd + v_creator,
             updated_at                  = now()
       where id = v_txn.creator_id;
    end if;
  end if;

  -- ── Settle the transaction and release the hold ────────────────────────────
  update public.usage_transactions
     set status              = 'settled',
         prompt_tokens       = p_prompt_tokens,
         completion_tokens   = p_completion_tokens,
         cost_micro_usd      = v_cost,
         creator_micro_usd   = v_creator,
         platform_micro_usd  = v_platform,
         write_off_micro_usd = v_write_off,
         usage_estimated     = p_usage_estimated,
         ttft_ms             = p_ttft_ms,
         duration_ms         = p_duration_ms,
         cold_start          = p_cold_start,
         client_disconnected = p_client_disconnected,
         hold_micro_usd      = 0,
         settled_at          = now()
   where id = p_txn_id;

  -- Denormalized catalog counters.
  update public.custom_models
     set total_requests          = total_requests + 1,
         total_prompt_tokens     = total_prompt_tokens + p_prompt_tokens,
         total_completion_tokens = total_completion_tokens + p_completion_tokens
   where id = v_txn.model_id;

  return jsonb_build_object(
    'ok', true,
    'txn_id',              p_txn_id,
    'cost_micro_usd',      v_cost,
    'creator_micro_usd',   v_creator,
    'platform_micro_usd',  v_platform,
    'write_off_micro_usd', v_write_off,
    'balance_micro_usd',   greatest(0, v_new_balance));
end $$;

revoke all on function public.deduct_token_cost(uuid,integer,integer,integer,integer,boolean,boolean,boolean)
  from public, anon, authenticated;
grant execute on function public.deduct_token_cost(uuid,integer,integer,integer,integer,boolean,boolean,boolean)
  to service_role;
```

```sql
-- ============================================================================
-- 62_rpc_void_and_credit.sql
-- ============================================================================
-- Release a hold with no charge: upstream failed before producing any token.
create or replace function public.void_reservation(
  p_txn_id     uuid,
  p_error_code text default null,
  p_error_message text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_updated integer;
begin
  update public.usage_transactions
     set status = 'voided', hold_micro_usd = 0,
         cost_micro_usd = 0, creator_micro_usd = 0, platform_micro_usd = 0,
         error_code = p_error_code, error_message = left(p_error_message, 1000),
         settled_at = now()
   where id = p_txn_id and status = 'reserved';
  get diagnostics v_updated = row_count;
  return jsonb_build_object('ok', true, 'voided', v_updated > 0);
end $$;

-- Idempotent Stripe credit. The UNIQUE on stripe_event_id makes a duplicate
-- webhook delivery a no-op instead of a double credit (FR-BIL-034).
create or replace function public.credit_wallet(
  p_user_id          uuid,
  p_amount_micro_usd bigint,
  p_kind             ledger_kind,
  p_stripe_event_id  text default null,
  p_stripe_session_id text default null,
  p_memo             text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_balance bigint;
  v_max     bigint;
  v_new     bigint;
begin
  if p_amount_micro_usd <= 0 then
    raise exception 'credit amount must be positive' using errcode = '22023';
  end if;

  if p_stripe_event_id is not null
     and exists (select 1 from public.wallet_ledger where stripe_event_id = p_stripe_event_id) then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;

  select balance_micro_usd, max_balance_micro_usd
    into v_balance, v_max
    from public.profiles where id = p_user_id for update;

  if not found then
    raise exception 'unknown user %', p_user_id using errcode = 'P0002';
  end if;

  v_new := v_balance + p_amount_micro_usd;
  if v_new > v_max then
    return jsonb_build_object('ok', false, 'code', 'max_balance_exceeded',
                              'max_micro_usd', v_max);
  end if;

  update public.profiles
     set balance_micro_usd = v_new, updated_at = now()
   where id = p_user_id;

  insert into public.wallet_ledger (
    user_id, kind, amount_micro_usd, balance_after_micro_usd,
    stripe_event_id, stripe_session_id, memo
  ) values (
    p_user_id, p_kind, p_amount_micro_usd, v_new,
    p_stripe_event_id, p_stripe_session_id, p_memo
  );

  return jsonb_build_object('ok', true, 'balance_micro_usd', v_new);
exception
  when unique_violation then                     -- concurrent duplicate webhook
    return jsonb_build_object('ok', true, 'replayed', true);
end $$;

revoke all on function public.void_reservation(uuid,text,text) from public, anon, authenticated;
revoke all on function public.credit_wallet(uuid,bigint,ledger_kind,text,text,text) from public, anon, authenticated;
grant execute on function public.void_reservation(uuid,text,text) to service_role;
grant execute on function public.credit_wallet(uuid,bigint,ledger_kind,text,text,text) to service_role;
```

```sql
-- ============================================================================
-- 63_reconciliation.sql   (§6.5)
-- ============================================================================
-- Sweep abandoned holds so an orphaned reservation cannot permanently strand
-- a user's spendable balance.
create or replace function public.expire_stale_holds()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  update public.usage_transactions
     set status = 'expired', hold_micro_usd = 0, settled_at = now(),
         error_code = 'hold_expired'
   where status = 'reserved' and expires_at < now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Ledger drift audit. MUST return zero rows. Any row is a P1 incident.
create or replace view public.v_balance_drift as
  select p.id as user_id, p.handle,
         p.balance_micro_usd                        as profile_balance,
         coalesce(sum(l.amount_micro_usd), 0)::bigint as ledger_sum,
         p.balance_micro_usd - coalesce(sum(l.amount_micro_usd), 0)::bigint as drift
    from public.profiles p
    left join public.wallet_ledger l on l.user_id = p.id
   group by p.id, p.handle, p.balance_micro_usd
  having p.balance_micro_usd <> coalesce(sum(l.amount_micro_usd), 0)::bigint;

select cron.schedule('expire-stale-holds', '*/5 * * * *',
                     $$select public.expire_stale_holds()$$);
```

### 5.8 Schema Summary

| Table | Rows/mo (yr-1 est.) | Written by | Read by | Retention |
|---|---|---|---|---|
| `profiles` | 1k | auth trigger, RPC | owner (RLS), public view | forever |
| `api_keys` | 3k | Edge Function | owner (RLS), gateway | forever (soft revoke) |
| `gpu_tiers` | 4 | migration / Ops | authenticated only (internal) | forever |
| `solver_config` | 4 | Ops / calibration job | authenticated only (internal) | forever |
| `custom_models` | 500 | owner (limited), Edge Function | public catalog (RLS), gateway | soft delete |
| `usage_transactions` | 5M | `service_role` RPC only | payer + creator (RLS) | 25 mo, then partition-drop |
| `wallet_ledger` | 100k | `service_role` RPC only | owner (RLS) | forever (financial record) |
| `creator_earnings` | 4M | `service_role` RPC only | creator (RLS) | forever (financial record) |

```
FR-DB-001 (P0)  RLS is ENABLED on every table in the public schema, without exception.
                A table with RLS disabled is fully readable through the anon key.
FR-DB-002 (P0)  No client role holds INSERT/UPDATE/DELETE on usage_transactions,
                wallet_ledger, or creator_earnings. Financial tables are RPC-only.
FR-DB-003 (P0)  Every SECURITY DEFINER function sets search_path = public, pg_temp
                (search_path injection hardening) and has EXECUTE revoked from
                anon and authenticated.
FR-DB-004 (P0)  CORRECTED — an earlier revision specified "usage_transactions →
                profiles(payer) → profiles(creator)", which is deterministic but is
                NOT A TOTAL ORDER, and therefore does not prevent deadlock at all.
                Two settlements with swapped roles form a cycle: A locks X as payer
                and updates Y as creator while B locks Y as payer and updates X as
                creator. Measured: 20 concurrent swapped settlements produced 19
                deadlocks (40P01); an identical-load control flowing one direction
                produced zero. Two creators who use each other's models is an
                ordinary marketplace shape, not an edge case.
                Required order: usage_transactions, then BOTH profile rows locked in
                canonical `id` order — never by role. Determinism is not the property
                that matters here; totality is.
FR-DB-005 (P1)  usage_transactions is RANGE-partitioned monthly on created_at before
                the table exceeds ~50M rows.
FR-DB-006 (P0)  UPGRADED from P1. A pgTAP suite asserts every invariant I1-I5 under
                GENUINE concurrency — real separate backends (dblink), released against
                a shared wall-clock barrier so they collide rather than queue. Simulated
                or single-connection concurrency is worthless here: a single-connection
                harness ran green over this same schema while it contained a
                100%-reproducible self-deadlock and a settlement path that stranded
                transactions. Every P1 billing defect found so far was found ONLY by
                real parallel sessions.
                The suite must also include a CONTROL scenario (identical load, no
                role-swapping) so a failure can be attributed to the structural cause
                rather than to contention.
FR-DB-007 (P0)  Concurrency tests are written by someone other than the author of the
                function under test, and are prompted to break it rather than to
                confirm it.
```

---

## 6. Non-Functional & Operational Requirements

### 6.1 Cold Starts — the Defining Constraint

Scale-to-zero is the business model, so a 20–60 second first-token latency is a *product surface*, not merely a performance defect. It must be engineered around at four layers.

| Layer | Requirement | Mechanism |
|---|---|---|
| **Protocol** | Client socket survives 60 s of upstream silence | Headers flushed pre-upstream; `: keepalive` SSE comment every 5 s (FR-GW-040/041) |
| **Transport** | No intermediary buffers the stream | `X-Accel-Buffering: no`; `Cache-Control: no-transform`; Vercel/CDN streaming passthrough verified in CI |
| **UX** | Silence is explained, not mysterious | Playground cold-start Alert + indeterminate ProgressBar (FR-PLAY-004); snippets ship with explicit long `timeout` values |
| **Docs** | Integrators configure timeouts correctly up front | Every copy-paste snippet includes a ≥120 s client timeout. A default-timeout OpenAI client will abort a legitimate cold start. |

```
NFR-CS-001 (P0)  Cold-start budget is PER MODEL, computed from variant weight bytes
                 (NFR-CACHE-010) and clamped to [90 s, 300 s]. A 4 GB model and a 40 GB
                 model do not share a timeout. Exceeding the budget emits a terminating
                 SSE error frame with code 'cold_start_timeout' — never a silently
                 dead socket.
NFR-CS-002 (P0)  Warm-path TTFT: p50 < 400 ms, p95 < 900 ms.
NFR-CS-003 (P0)  Every request records cold_start and ttft_ms. Cold-start ratio per
                 model is a first-class Ops metric.
NFR-CS-004 (P0)  idleTimeout = 30 s and workersMin = 0 are platform-enforced, not
                 creator-configurable. They are the unit-economics guarantee.
NFR-CS-005 (P1)  Opportunistic warming: on Playground page load, fire a 1-token
                 warm-up request (charged to the platform) so the user's first real
                 message hits a warm worker. This converts the worst first impression
                 in the product into a good one.
NFR-CS-006 (P2)  Paid "always-warm" tier (workersMin = 1) as a creator upsell.
NFR-CS-007 (P2)  Bake weights into a custom image or attach a RunPod network volume to
                 cut the weight-download portion of cold start.
```

### 6.2 Security

```
NFR-SEC-001 (P0)  RLS enabled on every public table. Verified by an automated test that
                  attempts cross-tenant reads with a second user's anon JWT.
NFR-SEC-002 (P0)  SUPABASE_SERVICE_ROLE_KEY, RUNPOD_API_KEY, STRIPE_SECRET_KEY, and
                  STRIPE_WEBHOOK_SECRET exist ONLY as Supabase function secrets /
                  server-side Vercel env vars. A CI check fails the build if any
                  secret-shaped value appears in a NEXT_PUBLIC_* variable or in
                  client-bundled output.
NFR-SEC-003 (P0)  API keys: 32 bytes from crypto.getRandomValues, base64url encoded,
                  prefixed sk-plat-. Stored as SHA-256 hex only. Plaintext appears in
                  exactly one HTTP response, ever, and in no log line, ever.
NFR-SEC-004 (P0)  HF tokens encrypted in Supabase Vault (pgsodium). Decrypt only in
                  service_role Edge Function context. Redact /hf_[A-Za-z0-9]{30,}/
                  from every log sink.
NFR-SEC-005 (P0)  Stripe webhooks: constructEventAsync signature verification is
                  mandatory. The raw body must be read before any JSON parsing, or
                  verification silently fails.
NFR-SEC-006 (P0)  TRUST_REMOTE_CODE = 0 on every worker template. Enabling it executes
                  arbitrary Python from a third-party HF repo inside platform-billed
                  GPU infrastructure. This is a remote code execution primitive and
                  must never be creator-configurable.
NFR-SEC-007 (P0)  Upstream error bodies are sanitized before reaching a client. RunPod
                  endpoint ids, internal hostnames, and stack traces never leak.
NFR-SEC-008 (P0)  Private models return 404 (not 403) to non-owners, so existence is
                  not confirmed to a stranger.
NFR-SEC-009 (P0)  Prompts and completions are NOT persisted in MVP. Only token counts,
                  timings, and cost are stored. This is the strongest possible privacy
                  posture and the cheapest to defend — do not weaken it without an
                  explicit product decision and a policy update.
NFR-SEC-010 (P1)  Rate limits: 60 rpm/key default (profiles.rate_limit_rpm),
                  10 deployments/day/creator, 5 top-ups/hour/user.
NFR-SEC-011 (P1)  Public catalog moderation: creator-attested content flags, an Ops
                  kill switch (status → 'paused'), and a takedown workflow. An
                  "uncensored" catalog is a content-policy surface — MVP requires a
                  documented AUP and an enforcement lever, even if enforcement is manual.
NFR-SEC-012 (P1)  Audit log for privileged actions: key creation/revocation, model
                  deletion, Ops balance adjustments, suspensions.
```

### 6.3 Timeouts

| Hop | Timeout | On expiry |
|---|---|---|
| HF metadata probe | 10 s | 400 with a "could not reach Hugging Face" message |
| RunPod GraphQL mutation | 30 s | `status='failed'`, error persisted, resources reaped |
| Provisioning smoke test | 180 s | `status='failed'` + "model did not start" hint |
| Gateway → first upstream token | `custom_models.cold_start_budget_s`, 90–300 s by variant size | SSE error frame `cold_start_timeout`; settle on 0 tokens → void |
| Gateway total stream duration | 300 s | SSE error frame `stream_timeout`; settle on tokens delivered |
| Edge Function wall clock | 400 s (platform ceiling) | Hard ceiling; the 300 s stream cap sits safely inside it |
| Client-recommended timeout | ≥120 s | Documented in every snippet |
| Stripe Checkout Session | 24 h | Session expires; no credit |
| Reservation hold | 15 min | Swept to `expired` by the 5-minute cron |

```
NFR-TO-001 (P0)  Every outbound fetch uses AbortSignal.timeout(). No unbounded network
                 call exists anywhere in the codebase.
NFR-TO-002 (P0)  Streaming responses stay inside the Edge Function wall-clock ceiling
                 with margin. The 300 s stream cap is deliberately well below 400 s.
NFR-TO-003 (P0)  Every timeout produces a settled or voided transaction. A timeout must
                 never leave a hold dangling for the reaper to find.
```

### 6.4 Performance & Scalability

| Metric | Target | Notes |
|---|---|---|
| Gateway overhead | p95 < 10 ms | Pre-upstream wall time (§4.2.6) |
| Gateway throughput | 500 concurrent streams | Edge Function horizontal scaling |
| Catalog search | p95 < 150 ms | GIN tsvector; server-rendered |
| Settlement RPC | p95 < 5 ms | Single row lock, microsecond hold |
| Marketplace LCP | < 2.0 s | RSC + streaming SSR |
| DB connections | PgBouncer transaction pooling | Edge Functions must never hold session-mode connections |

```
NFR-PERF-001 (P0)  Supabase project region matches the primary Edge Function region.
                   Cross-region DB latency would consume the entire 10 ms budget in
                   a single round trip.
NFR-PERF-002 (P0)  Auth + model resolution in ≤2 DB round trips.
NFR-PERF-003 (P1)  60 s in-memory LRU for model resolution, invalidated via Realtime.
NFR-PERF-004 (P1)  Catalog counters (total_requests, total_tokens) update via the
                   settlement RPC, not via a scan-based aggregate.
```

### 6.5 Reliability, Reconciliation & Observability

The billing system's correctness is not assertable by unit tests alone; it must be *continuously proven* against production data.

```
NFR-REL-001 (P0)  Nightly reconciliation job asserts, and pages Ops on any violation:
                    R1  no profile has balance_micro_usd < 0
                    R2  v_balance_drift returns ZERO rows
                        (SUM(wallet_ledger.amount) == profiles.balance, per user)
                    R3  every usage_transactions row older than 1 h is in a terminal
                        state (settled | voided | expired | failed)
                    R4  for every settled row: creator + platform == cost, exactly
                    R5  SUM(creator_earnings.net) == SUM(profiles.lifetime_earnings)
                    R6  every RunPod endpoint has a live custom_models row (orphan check)
NFR-REL-002 (P0)  expire_stale_holds() runs every 5 minutes via pg_cron.
NFR-REL-003 (P0)  Structured JSON logs on the gateway: request_id, user_id, model_id,
                  ttft_ms, duration_ms, prompt/completion tokens, cost, cold_start,
                  outcome, gateway_overhead_ms. Never messages, never keys, never tokens.
NFR-REL-004 (P0)  Alerts: gateway 5xx rate > 1% (5 min) · p95 overhead > 10 ms ·
                  any negative balance · any drift row · unsettled-transaction count > 0 ·
                  usage_estimated rate > 1% · deploy failure rate > 20%.
NFR-REL-005 (P1)  /health endpoint checking DB, RunPod GraphQL, and Stripe reachability.
NFR-REL-006 (P1)  Per-model circuit breaker: 5 consecutive upstream failures →
                  status='paused' + creator email. Stops a broken model from burning
                  GPU credit and generating 500s.
NFR-REL-007 (P1)  DB PITR enabled (Supabase paid tier). RTO 1 h, RPO 5 min.
NFR-REL-008 (P2)  Multi-region gateway with regional read replicas.
```

### 6.6 Caching Architecture

Six distinct caches exist in this system. They are frequently conflated, they fail in different ways, and two of them have direct billing consequences. Each is specified separately below.

> **The central tension.** Caching rewards *warm, long-lived* processes. Scale-to-zero deliberately destroys them every 30 seconds. Every cache decision below is a negotiation between those two facts, and the honest resolution is different per layer: some caches are worth persisting outside the worker, some are worth losing, and one must never be cached at all.

| # | Cache | Lives in | Survives scale-to-zero? | Billing impact |
|---|---|---|---|---|
| C1 | Model weights | RunPod node disk / network volume | Node-local: sometimes · Volume: yes | Sets cold-start duration |
| C2 | KV cache (prefix caching) | Worker VRAM | **No** | Cuts prefill cost when warm |
| C3 | Cached prompt tokens | Reported by the worker | **No** | **Directly affects what the caller pays** |
| C4 | Gateway auth/model resolution | Edge Function memory | N/A | **Must not cache auth decisions** |
| C5 | Catalog / marketplace pages | Next.js + CDN | N/A | None |
| C6 | HF metadata probes | Edge Function + Postgres | N/A | None |

#### C1 — Model weights (the cold-start driver)

The MVP's stated approach of `volumeInGb: 0` with weights "baked into the container cache" is **only true for the second cold start onward on the same physical node**, and it is not achievable per-model without building a bespoke 20–80 GB Docker image per deployment — a pipeline the MVP does not have.

**Measured on Modal, MVP target (Q4_K_M, 15.66 GiB), L4:**

| | First-ever container | Cold, Volume warm | Warm |
|---|---|---|---|
| Time to first token | **115 s** (104.0 s HF download + 9.3 s load) | **23.0 s** p50 | **0.93 s** p50 |
| Time to headers | — | 22.5 s p50 | 0.77 s p50 |
| Decode | — | 14.0 tok/s | 14.1 tok/s |

**The Volume is a 5× cold-start lever and the single highest-value optimization in this
document.** Cold start decomposes as ~8 s container + ~14 s llama.cpp load-to-healthy once
weights are local. The 101 s estimate elsewhere in this PRD was right for the first-ever
start and wrong by 5× for every start after it.

> **Warm TTFT p50 of 926 ms misses NFR-CS-002** (p50 < 400 ms, p95 < 900 ms). The last two
> settled runs reached 683/692 ms, so the target is not absurd, but it is not met today.
> Either the SLO is wrong for a 27B model on a budget GPU, or the path needs work. It must
> not be quietly restated to match what we measured.

The honest MVP behavior without a Volume:

```
First worker on a cold node    : pull image (~8 GB) + download weights from HF (size-dependent)
Subsequent workers on that node: image layer cached; weights re-downloaded unless volume-backed
```

Weight download dominates and scales with variant size — which means **the 90-second cold-start budget in §6.1 is not size-independent**:

| Variant size | HF → RunPod download @ ~300 MB/s | + load & CUDA init | Realistic first-token |
|---|---|---|---|
| 4 GB (7B Q4) | ~15 s | ~10 s | ~25 s |
| 16 GB (27B Q4) | ~55 s | ~15 s | **~70 s** |
| 40 GB (70B Q4) | ~135 s | ~25 s | **~160 s — exceeds the 90 s budget** |

```
NFR-CACHE-010 (P0)  The cold-start budget is computed per model from weights_bytes,
                    not fixed at 90 s:
                      cold_start_budget_s = 45 + (weights_bytes / 300 MB/s)
                    clamped to [90, 300]. Stored on custom_models and used as the
                    gateway's first-token timeout for that model. A single global
                    timeout either kills healthy large models or hides dead small ones.
NFR-CACHE-011 (P0)  Variants above the volume threshold (default 20 GB) MUST be backed
                    by a RunPod network volume pre-seeded with the weights at
                    provisioning time. Without it, every cold start re-downloads tens
                    of gigabytes and the model is commercially unusable.
NFR-CACHE-012 (P0)  Volume cost (~$0.07/GB/month) is a REAL fixed cost and is the one
                    place the scale-to-zero "$0 idle" claim is not literally true.
                    It must be included in the solver's cost floor and disclosed in the
                    Deployment Plan card. Overstating zero-idle to creators is a
                    trust failure, not a rounding error.
NFR-CACHE-013 (P1)  Volumes are reference-counted per (hf_repo_slug, revision, variant)
                    so N models sharing a base repo share one volume.
NFR-CACHE-014 (P1)  Orphaned-volume reaper, same pattern as the endpoint reaper.
NFR-CACHE-015 (P2)  Pre-baked images for the top-N models by traffic, eliminating the
                    download entirely.
```

#### C2 — KV cache & automatic prefix caching

vLLM's automatic prefix caching (APC) shares KV blocks across requests with a common prefix. It is a large win for exactly the workloads this platform serves — a fixed system prompt reused across calls, and multi-turn chat where turn N re-sends turns 1..N-1.

It is also **entirely lost when the worker scales to zero**, which makes its value proportional to how busy a model is:

| Model traffic | Worker state | Prefix cache hit rate | Who benefits |
|---|---|---|---|
| Cold / sporadic | scaled to zero between calls | ~0% | nobody |
| Steady (> 2 req/min) | continuously warm | high on shared prefixes | caller and platform |
| Bursty | partial | uneven | unpredictable |

**Runtime asymmetry.** vLLM's APC is a global, block-level cache shared across all requests. llama.cpp's equivalent is **per-slot context reuse** — a request only reuses a prefix if it lands on the *same slot* that served the earlier request. With `--parallel N`, a shared system prompt therefore has to be re-prefilled up to N times before every slot is warm, and any slot recycled to a different conversation loses its prefix. GGUF models get materially less cache benefit than safetensors models on identical hardware, and the platform should not claim otherwise.

```
NFR-CACHE-020 (P0)  Prefix caching is ENABLED on every worker. It costs nothing when
                    unused and is a win when warm — but the mechanism and the magnitude
                    differ by runtime:
                      vLLM:      ENABLE_PREFIX_CACHING=1  (global, block-level)
                      llama.cpp: CONT_BATCHING=1 + slot context reuse (PER-SLOT only)
NFR-CACHE-021 (P0)  The capacity solver MUST reserve a prefix-cache pool. Sizing KV to
                    exactly max_concurrent_streams leaves zero free blocks, so every
                    cached prefix is evicted immediately and APC silently does nothing.
                    Reserve 15% of the KV region (solver_config.prefix_cache_reserve)
                    and derive max_concurrent_streams from the remaining 85%.
NFR-CACHE-022 (P1)  idleTimeout is the direct lever on cache warmth. 30 s is the MVP
                    default and is deliberately aggressive toward cost. Making it
                    per-model tunable (30–300 s) is the cheapest available cache
                    improvement and belongs in the always-warm tier (NFR-CS-006).
NFR-CACHE-023 (P1)  Report cache_hit_rate per model in Studio analytics. It is the
                    creator's evidence for whether a longer idle timeout would pay.
```

#### C2a — Persisted KV cache: breaking the scale-to-zero / warm-cache tradeoff

C2 above states that prefix caching is lost whenever a worker scales to zero, and treats that as an inherent cost of the business model. **That is not actually inherent.** llama.cpp can serialize a slot's KV cache to disk and restore it, which means the cache can outlive the container.

```
llama-server --slot-save-path /runpod-volume/kv --cache-reuse 256
POST /slots/{id}?action=save    {"filename": "<prefix-hash>.bin"}
POST /slots/{id}?action=restore {"filename": "<prefix-hash>.bin"}
```

**Why this matters far more than it first appears.** Measured prompt evaluation on the MVP target (L4) is **133 tok/s** — decode is 14 tok/s, but *prefill* is the cost that dominates any workload with a large stable prefix:

| Stable prefix | Prefill from cold | KV state size | Restore @ ~1 GB/s |
|---|---|---|---|
| 4,000 tok | **30 s** | 250 MiB | ~0.24 s |
| 10,000 tok | **75 s** | 625 MiB | ~0.61 s |
| 32,000 tok | **241 s** | 2,000 MiB | ~1.95 s |

A 10k-token system prompt costs **75 seconds of prefill on every cold start**, versus well under a second to restore the same state from the Volume that already holds the weights. That is a ~100x difference on the exact bottleneck that makes agentic use unusable under scale-to-zero.

```
NFR-CACHE-024 (P2)  Persist slot KV state to the model's Volume, keyed by a hash of
                    the token prefix plus (model, variant, ctx_size, kv_dtype). Restore
                    on cold start before serving. This decouples cache warmth from
                    container lifetime, so the platform keeps scale-to-zero economics
                    AND warm-cache latency instead of trading one for the other.
NFR-CACHE-025 (P2)  The cache key MUST include every parameter that changes KV layout.
                    A restored cache from a different quantization, context size, or KV
                    dtype is silently wrong output, not an error — the worst failure
                    class in this document.
NFR-CACHE-026 (P2)  Bound it: KV state is ~64 KiB/token at fp16, so a 32k prefix is
                    2 GB per distinct prefix. Needs an LRU with a per-model byte cap
                    and a real eviction policy, or storage cost silently replaces the
                    GPU cost we removed.
NFR-CACHE-027 (P2)  Measure prefill throughput at REALISTIC prefix lengths before
                    committing. The 133 tok/s figure comes from a 71-token prompt;
                    longer prompts batch better, so the true prefill rate is likely
                    higher and the payback correspondingly smaller. The direction is
                    certain, the magnitude is not.
```

> **This revises the §4.6 conclusion.** That section argues an agentic tier must be
> always-warm (`min_containers >= 1`), because agent loops re-send a large stable system
> prompt every turn and scale-to-zero discards the cache. With persisted KV, a cold
> container can restore that prefix in under a second — so always-warm may be an
> optimization rather than a requirement, and the agent tier could keep zero idle cost.
> Do not treat §4.6's always-warm claim as settled until this is measured.

#### C2b — KV cache quantization: TurboQuant and the llama.cpp equivalent

KV cache is the term that decides GPU tier and concurrency (§4.3.3.3), so compressing it changes unit economics directly rather than marginally.

**TurboQuant** (Google Research) is a training-free, data-oblivious vector quantization for the KV cache reaching ~3.5 effective bits per value — roughly **4.6x** versus fp16 — with reported 6x memory reduction and up to 8x attention-logit speedup on H100. As of August 2026 it ships in **vLLM** and in Qdrant 1.18.

Modelled against the MVP target's real geometry (64 KiB/token at fp16):

| Context | Tier | fp16 | q8_0 (2x) | TurboQuant-class (4.6x) |
|---|---|---|---|---|
| 8,192 | RTX 4090 | 7 streams / $1.11 per M | 15 / $0.52 | **34 / $0.23** |
| 100,000 | L40S | 3 / $5.83 | 7 / $2.50 | **16 / $1.09** |
| 262,144 | RTX 4090 | infeasible | infeasible | **1 stream, feasible** |

Nearly a **5x cost reduction at 8k**, and the model's full native 262k context becomes servable on a 24 GB consumer card.

```
NFR-CACHE-028 (P1)  kv_dtype_bytes is already a solver input (FR-DEP-054). Extend it to
                    a fractional bytes-per-value so sub-8-bit KV schemes are expressible
                    at all — an integer byte count cannot represent 3.5 bits.
NFR-CACHE-029 (P1)  RUNTIME ASYMMETRY, and it is a real product consequence: TurboQuant
                    ships in vLLM, not llama.cpp. The MVP's own target is GGUF and
                    therefore capped at llama.cpp's q8_0 KV (2x). A safetensors/AWQ model
                    on vLLM can reach ~4.6x and is materially cheaper to serve at long
                    context. This is the first concrete reason to prefer the vLLM runtime
                    for a given model, and it should inform the variant recommendation —
                    not just the format detection.
NFR-CACHE-030 (P2)  Quantized KV changes output. Any KV compression must be recorded on
                    the model row and disclosed on the model card, exactly as the
                    quantization quality label is. Silently trading accuracy for margin
                    is the platform making a quality decision that belongs to the creator.
```

This is the layer with real money attached, and the one most easily got wrong.

**The correctness problem.** With APC enabled, vLLM reports the *full* prompt in `prompt_tokens` and separately reports how much of it was served from cache in `prompt_tokens_details.cached_tokens`. Billing `prompt_tokens` at the full rate therefore charges the caller for prefill work the GPU **did not perform**.

That is not fraud — it is what several major providers did before cache pricing existed — but it is a defensible-pricing question the platform should answer deliberately rather than by omission.

```
FR-BIL-040 (P0)  The gateway extracts prompt_tokens_details.cached_tokens from the
                 terminal usage chunk and persists it on usage_transactions. It is
                 recorded whether or not it is discounted, so the pricing decision can
                 be revisited against real data instead of guesses.
FR-BIL-041 (P0)  cached_tokens is passed through VERBATIM in the response usage object.
                 An OpenAI-compatible client reading prompt_tokens_details must see
                 the truth. Suppressing it to hide non-discounted billing would be
                 a deliberate misrepresentation.
FR-BIL-041a (P0) CORRECTED BY MEASUREMENT. An earlier revision asserted that llama.cpp
                 does not report cached_tokens, and rested part of the no-discount
                 argument on that. It is FALSE for the pinned build (`b10454`):
                 `prompt_tokens_details.cached_tokens` is present on the trailing usage
                 chunk and genuinely populated — 42 observed on a shared prefix, 0 when
                 cold. Cache hits ARE measurable on both runtimes.
                 FR-BIL-042's no-discount position still stands, but on the surviving
                 half of the argument only: with scale-to-zero, hit rate depends on
                 whether an unrelated caller happened to hit the same model seconds
                 earlier, so a discount is unpredictable rather than unmeasurable.
                 Do not cite measurability as the reason.
FR-BIL-042 (P0)  MVP billing: cached tokens are billed at the FULL prompt rate, and
                 this is stated plainly in the pricing docs and on every model card.
                 RATIONALE: with scale-to-zero, hit rates are near zero for the long-tail
                 models that define this platform. A discount nobody can predictably
                 earn is not a feature — it is a pricing surface that complicates every
                 invoice for negligible benefit. The honest position is a simple rate
                 plus a clear statement, not a discount with an asterisk.
FR-BIL-043 (P1)  Cost formula extended, gated on a per-model flag so the discount can
                 be enabled without a schema change:
                   billable_prompt = prompt_tokens
                                   - (cached_tokens x cached_discount_bps / 10000)
                 cached_discount_bps defaults to 0 (no discount) in MVP.
FR-BIL-044 (P1)  Studio and Console surface cached_tokens and the aggregate hit rate,
                 so the decision to enable a discount is made against measured data.
FR-BIL-045 (P2)  Explicit cache-control (OpenAI cache_control / Anthropic-style
                 breakpoints) once an always-warm tier makes hit rates predictable.
```

> **Do not** implement a cached-token discount before the always-warm tier exists. A discount whose availability depends on whether another user happened to call the same model 20 seconds earlier is not a price a developer can plan against.

#### C4 — Gateway resolution cache (and what must never be cached)

FR-GW-052 permits a 60-second in-memory LRU for model resolution. The boundary between what is cacheable and what is not is a security boundary, not an optimization.

| Datum | Cacheable? | Why |
|---|---|---|
| `creator/slug` → `runpod_endpoint_id`, `served_model_name` | **Yes**, 60 s | Changes only on redeploy |
| Model pricing | **Yes**, 60 s | Already snapshot per transaction (FR-GW-024), so staleness is harmless |
| Model `status` / `visibility` | **Yes**, 60 s, **with Realtime invalidation** | A paused or newly-private model must stop serving promptly |
| API key validity | **NO** | A revoked key must stop working immediately. Caching it creates a revocation window in which a leaked key still works. |
| Wallet balance | **NO** | Caching balance defeats the entire reserve-then-settle design and permits overdraft |
| Suspension state | **NO** | Enforcement must be immediate |

```
FR-GW-053 (P0)  Auth decisions, balance, and suspension state are NEVER cached. They
                are read inside the same transaction that opens the reservation.
                Caching any of them reintroduces the overdraft race that §4.2.3 exists
                to eliminate.
FR-GW-054 (P0)  The model-resolution cache is invalidated by a Supabase Realtime
                subscription on custom_models, plus a 60 s TTL as a backstop for a
                dropped subscription. TTL alone is not sufficient for a kill switch:
                an Ops pause must take effect in seconds, not up to a minute.
FR-GW-055 (P0)  Cache is per-isolate and non-shared. Edge Function isolates are
                ephemeral and independent; a cold isolate simply misses. No coherence
                protocol is needed or attempted.
FR-GW-056 (P1)  Emit cache_hit on every request so the ~4 ms saving claimed in
                §4.2.6 is measured rather than assumed.
```

#### C5 — Catalog and page caching

```
NFR-CACHE-050 (P0)  Public catalog and model pages use Next.js ISR, revalidate 60 s,
                    with on-demand revalidation triggered when a model's status or
                    visibility changes. A deleted or paused model must not remain
                    linkable from a cached catalog page.
NFR-CACHE-051 (P0)  Authenticated surfaces (Studio, Console, Playground) are never
                    statically cached and send Cache-Control: private, no-store.
                    A CDN-cached balance or usage ledger is a cross-tenant data leak.
NFR-CACHE-052 (P0)  Gateway responses send Cache-Control: no-store. Inference output
                    must never be cached by any intermediary.
NFR-CACHE-053 (P1)  Realtime-driven ISR revalidation so a newly ready model appears in
                    the catalog without waiting out the TTL.
```

#### C6 — Hugging Face metadata cache

```
NFR-CACHE-060 (P1)  Cache HF probe results (file list, sizes, config.json) in Postgres
                    keyed by (repo_slug, revision), 15-minute TTL. A creator adjusting
                    Sliders in the Studio re-runs the solver on every change; without
                    this cache each keystroke is an HF round trip and the form becomes
                    both slow and rate-limited by HF.
NFR-CACHE-061 (P0)  Probe results for PRIVATE repos are cached per (repo, user), never
                    globally. A global cache keyed on repo slug alone would let one
                    user learn the file list of another user's private repository.
NFR-CACHE-062 (P0)  The provisioning path re-probes with no cache. Deploying against a
                    15-minute-stale file list can provision the wrong variant.
```

### 6.7 Extensibility

```
NFR-EXT-001 (P1)  Compute provisioning sits behind a ComputeProvider interface
                  (provision, delete, invokeStream, healthCheck). RunPod is one
                  implementation. Adding Modal, Fly.io GPU, or BYO-cloud must not
                  touch gateway or billing code.
NFR-EXT-002 (P1)  Pricing is data (gpu_tiers, platform_fee_bps), never code.
NFR-EXT-003 (P2)  /v1/embeddings and /v1/completions reuse the same auth →
                  authorize → proxy → settle pipeline. The pipeline is
                  endpoint-agnostic by construction.
```

### 6.8 Compliance & Legal (MVP baseline)

```
NFR-LEG-001 (P0)  Stripe Checkout only → PCI DSS SAQ-A. No card data ever transits
                  platform infrastructure.
NFR-LEG-002 (P0)  Terms of Service + Acceptable Use Policy accepted at signup, with
                  the accepted version recorded on the profile.
NFR-LEG-003 (P0)  Creators attest they hold the right to serve the model weights they
                  register, and accept liability for the model's licence terms.
NFR-LEG-004 (P0)  Privacy policy states plainly that prompts and completions are not
                  stored (NFR-SEC-009).
NFR-LEG-005 (P1)  GDPR data-subject export and deletion. Financial records are retained
                  under the legal-obligation basis; the account is anonymized rather
                  than hard-deleted so the ledger stays intact.
NFR-LEG-006 (P1)  Creator payout terms, tax-form collection (W-9/W-8BEN), and a
                  minimum payout threshold — required before Phase 2 disbursement.
```

---

## 7. 4-Sprint Implementation Roadmap & Milestones

Four two-week sprints, 8 weeks to GA. Assumed team: 2 full-stack engineers + 1 part-time designer.

**Sequencing principle:** the highest-uncertainty component — SSE proxying across a 60 s cold start — is de-risked in **Sprint 1**, not deferred to polish. If keep-alive streaming cannot be made to work reliably through Supabase Edge Functions, the entire scale-to-zero thesis is invalid and the architecture must change. That answer is worth more in week 2 than in week 7.

### Sprint 1 (Weeks 1–2) — Foundations & Gateway Spike

**Goal:** prove a token can stream from a cold RunPod worker, through the gateway, to an OpenAI SDK client, and be billed atomically.

| # | Deliverable | Requirements |
|---|---|---|
| 1.1 | Next.js 15 + Tailwind v4 + HeroUI v3 skeleton; **no provider**, dark/light theming; CI lint banning `onClick` and v2 imports | FR-UI-000…004 |
| 1.2 | Supabase project; migrations 00–63; RLS on every table | §5, FR-DB-001…004 |
| 1.3 | Supabase Auth (GitHub OAuth + magic link); profile auto-provision trigger; handle claim | A1–A2 |
| 1.4 | `authorize_request` + `deduct_token_cost` + `credit_wallet` + `void_reservation`; **pgTAP concurrency suite proving I1–I5** | FR-BIL-010…015 |
| 1.5 | **SPIKE — manually provision one llama.cpp RunPod endpoint** serving `Qwen3.8-27B-Uncensored-Q4_K_M.gguf` (`minWorkers:0`, `idleTimeout:30`). Measure download, load, TTFT. **Verify the pinned image emits usage on the OpenAI route.** | §4.3.3.6, §4.3.4, FR-GW-044c |
| 1.5b | **Ground truth on the target repo**: read GGUF header for `block_count` / `head_count_kv` / `head_count` / `embedding_length`; commit the file list as the classifier fixture | FR-DEP-043 path 2, FR-DEP-047 |
| 1.6 | **Gateway v0:** key auth → model resolve → authorize → SSE proxy w/ keep-alive → usage extract (incl. `cached_tokens`) → settle | FR-GW-001…050, 044a, FR-BIL-040…042 |
| 1.7 | API key generation Edge Function (SHA-256, show-once) | FR-GW-010, NFR-SEC-003 |
| 1.8 | Structured logging + `gateway_overhead_ms` instrumentation | NFR-REL-003 |

**Milestone M1 — "It streams and it bills."**
`openai-python`, unmodified except `base_url` and `api_key`, streams tokens from a cold-started endpoint through the gateway against the real acceptance target — `model="JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"`. `usage_transactions` shows a `settled` row with correct cost and an 80/20 split. `gateway_overhead_ms` p95 < 10 ms. Concurrent-request test on a $0.001 wallet produces **zero** negative balances.

**Exit criteria:** M1 demonstrated live. Cold-start p50/p95 measured and recorded (expected ~101 s for this variant — §4.3.3.2a). Keep-alive verified to survive **the full measured cold start**, not a nominal 60 s, with no client abort. Usage extraction verified against the pinned llama.cpp build; if it does not emit usage, the estimator path is proven instead and its accuracy recorded.

**Risk gate:** if 1.6 cannot hold a socket through a 60 s cold start, escalate to the fallback (§8.3, R1) before Sprint 2 planning.

---

### Sprint 2 (Weeks 3–4) — Creator Studio & Automated Provisioning

**Goal:** a creator deploys a model end-to-end with zero engineer involvement.

| # | Deliverable | Requirements |
|---|---|---|
| 2.1 | HF validation Edge Function: existence, gating, architecture probe (config.json **and GGUF-header range read**), **variant enumeration with role + family classification**, shard grouping, MoE detection. Blocking regression test on the target-repo fixture. | FR-DEP-001…007, 040…047 |
| 2.1b | **Dual runtime**: llama.cpp + vLLM images, format→runtime derivation, per-runtime env contracts, file-level weight selection for GGUF | FR-DEP-060…064 |
| 2.2 | Vault-backed HF token storage; encrypt / decrypt / destroy; log redaction filter | FR-DEP-010…014 |
| 2.3 | **`resolve_placement()` solver** + `gpu_tiers` w/ bandwidth + `solver_config`; unit tests over a fixture set of real repos (dense, MoE, GQA, long-context) | FR-DEP-050…051, 054…055, FR-DB-007…008 |
| 2.4 | `deploy-model` Edge Function: server-side re-solve → `saveTemplate` → `saveEndpoint` → **throughput-measuring smoke test w/ one-tier auto-escalation** → `ready`; idempotent | FR-DEP-030…036, 052 |
| 2.5 | `delete-model` Edge Function: RunPod teardown + **volume release** + Vault destroy + soft delete | FR-DEP-037, NFR-CACHE-014 |
| 2.5b | **Weight-cache strategy**: network-volume provisioning above threshold, per-model cold-start budget, prefix caching enabled on all workers | NFR-CACHE-010…013, 020…021 |
| 2.6 | Studio deploy form: intent Sliders (context, speed), **variant consequence table**, **live Deployment Plan card**, infeasibility remedies | FR-STU-001…006, 004a…004d |
| 2.7 | Provisioning stepper with Realtime status + failure remediation hints | FR-STU-007…008 |
| 2.8 | "My Models" Table + actions Dropdown + delete AlertDialog | FR-STU-009…010 |
| 2.9 | Gateway `GET /v1/models` | FR-GW-004 |

**Milestone M2 — "90-second deploy, zero hardware decisions."** A creator pastes an HF slug (one public multi-quant GGUF repo, one private safetensors repo), sets a context window and a speed target, picks a quality row, sets prices, submits, and reaches `status='ready'` in under 5 minutes unattended. **At no point were they shown a GPU as a choice.** Both models then answer through the gateway at or above the speed advertised on their model card.

**Exit criteria:** 10 consecutive automated deploys with ≥90% success. Private-repo path verified. Deletion leaves zero orphaned RunPod resources. **Solver accuracy: `measured_tokens_per_second` within 20% of predicted across the fixture set** — outside that band, recalibrate MFU before Sprint 3.

---

### Sprint 3 (Weeks 5–6) — Marketplace, Playground & Wallet

**Goal:** a developer discovers, tries, funds, and integrates without talking to anyone.

| # | Deliverable | Requirements |
|---|---|---|
| 3.1 | Marketplace grid: Card/Chip composition, Skeleton loading, cursor pagination | FR-MKT-001…002, 005 |
| 3.2 | Full-text search + filter rail bound to URL search params | FR-MKT-003…004 |
| 3.3 | Model card Modal with Tabs + copy-paste snippets (Python/TS/cURL) | FR-MKT-007…008 |
| 3.4 | SSR + SEO for the public catalog; unauthenticated read verified against RLS | FR-MKT-006 |
| 3.5 | Playground: Vercel AI SDK `useChat`, TextArea composer, parameter Sliders | FR-PLAY-001…003 |
| 3.6 | Cold-start UX (Alert + indeterminate ProgressBar) and per-turn cost footer | FR-PLAY-004…005 |
| 3.7 | Stripe Checkout Session Edge Function + top-up Modal | FR-BIL-030…032, 036 |
| 3.8 | Stripe webhook: signature verify → `credit_wallet`; exactly-once via UNIQUE event id | FR-BIL-033…035 |
| 3.9 | Console: keys Table, usage ledger Table, wallet Card, Realtime balance | FR-CON-001…007 |
| 3.10 | Signup promotional grant ($1.00 as `kind='grant'`) | FR-BIL-037 |

**Milestone M3 — "Discover to integrate, unassisted."** A new user lands on `/`, searches, opens a model, chats in the Playground on the promo grant, tops up $5 via Stripe, creates a key, copies the Python snippet, and gets a streaming response from their own terminal. Balance and ledger are correct at every step.

**Exit criteria:** full Flow B walked by someone outside the team with no guidance. Duplicate-webhook test credits exactly once.

---

### Sprint 4 (Weeks 7–8) — Hardening, Reconciliation & Launch

**Goal:** production-ready. Correctness continuously proven, not merely asserted.

| # | Deliverable | Requirements |
|---|---|---|
| 4.1 | Nightly reconciliation job R1–R6 + `v_balance_drift` alerting | NFR-REL-001 |
| 4.2 | `expire_stale_holds` pg_cron every 5 min; orphan RunPod reaper | NFR-REL-002, FR-DEP-038 |
| 4.3 | Rate limiting: per-key rpm, deploys/day, top-ups/hour | NFR-SEC-010 |
| 4.4 | Full timeout matrix (§6.3); every fetch on `AbortSignal.timeout` | NFR-TO-001…003 |
| 4.5 | Error taxonomy audit: OpenAI-shaped envelopes, upstream sanitization, 404-for-private | FR-GW-003, 033, 034, NFR-SEC-007…008 |
| 4.5b | **Cache audit**: model-resolution LRU + Realtime invalidation; verify auth/balance/suspension are never cached; `no-store` on gateway and authenticated pages; ISR revalidation on status change | FR-GW-052…056, NFR-CACHE-050…053, 060…062 |
| 4.6 | Cross-tenant RLS penetration test; secret-leak CI check; `TRUST_REMOTE_CODE=0` audit | NFR-SEC-001…006 |
| 4.7 | Studio analytics (token volume, earnings, latency, cold-start ratio) | FR-STU-011…013 |
| 4.8 | Per-model circuit breaker + Ops kill switch (`status='paused'`) | NFR-REL-006, NFR-SEC-011 |
| 4.9 | Load test: 500 concurrent streams; verify overhead p95 and zero billing drift under load | NFR-PERF-002 |
| 4.10 | Docs site: quickstart, cold-start guidance, timeout config, error reference, AUP, ToS, privacy | NFR-LEG-002…004 |
| 4.11 | Opportunistic Playground warming | NFR-CS-005 |
| 4.12 | Accessibility pass (React Aria gives most of it free; verify focus order + contrast) | — |

**Milestone M4 — GA.** All P0 requirements met. Reconciliation closes to zero for 14 consecutive days. Load test passes with zero drift. Public launch.

**Exit criteria:** zero open P0 defects · reconciliation clean 14 days · load test green · docs published · legal pages live.

---

### 7.5 Roadmap Summary

| Sprint | Theme | Milestone | Primary risk retired |
|---|---|---|---|
| 1 | Foundations & gateway spike | M1 — streams and bills | **Cold-start SSE viability** + billing atomicity |
| 2 | Creator Studio & provisioning | M2 — 90-second deploy | Automated RunPod provisioning + credential security |
| 3 | Marketplace, Playground, wallet | M3 — unassisted integration | Two-sided UX + Stripe exactly-once |
| 4 | Hardening & reconciliation | M4 — GA | Financial correctness at scale |

### 7.6 Post-MVP Sequence (indicative)

| Phase | Scope |
|---|---|
| **P2.1** | Creator payouts (Stripe Connect), tax collection, payout threshold |
| **P2.2** | `/v1/embeddings`, `/v1/completions` |
| **P2.1a** | **Tool calling** (§4.5) — the single highest-leverage unlock; brings every agentic OpenAI client |
| **P2.1b** | **Anthropic Messages API** (§4.6) — Claude Code and Anthropic-SDK clients |
| **P2.3** | Always-warm paid tier; baked-weights images; network-volume cold-start reduction |
| **P2.4** | LoRA multiplexing (many adapters, one base model, one GPU) — a structural margin unlock |
| **P2.5** | `ComputeProvider` second implementation (Modal / Fly.io GPU); BYO-cloud |
| **P2.6** | Team accounts, per-key spend caps, org billing, postpaid invoicing |
| **P2.7** | Model quality leaderboards, community ratings, curated collections |

---

## 8. Appendices

### 8.1 Environment Variables

| Variable | Surface | Secret | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Next.js client | No | Supabase endpoint |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Next.js client | No | RLS-scoped client access |
| `NEXT_PUBLIC_GATEWAY_URL` | Next.js client | No | Base URL rendered into snippets |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Next.js client | No | Checkout redirect |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions | **Yes** | RLS bypass for RPC calls |
| `RUNPOD_API_KEY` | Edge Functions | **Yes** | GraphQL provisioning + inference |
| `RUNPOD_GRAPHQL_URL` | Edge Functions | No | `https://api.runpod.io/graphql` |
| `STRIPE_SECRET_KEY` | Edge Functions | **Yes** | Session creation |
| `STRIPE_WEBHOOK_SECRET` | Edge Functions | **Yes** | Signature verification |
| `HF_API_BASE` | Edge Functions | No | `https://huggingface.co` |
| `PLATFORM_FEE_BPS_DEFAULT` | Edge Functions | No | `2000` |
| `VLLM_WORKER_IMAGE` | Edge Functions | No | vLLM worker image tag (safetensors / AWQ / GPTQ) |
| `LLAMACPP_WORKER_IMAGE` | Edge Functions | No | GGUF worker image tag. **Pinned to a build verified to emit usage on the OpenAI route (FR-GW-044c).** Required in MVP — the acceptance target is GGUF. |

```
NFR-SEC-002 restated: a CI job greps the client bundle for every secret-shaped value
and fails the build on a hit. A service_role key in a NEXT_PUBLIC_* variable is a
total compromise of the database — RLS is bypassed by design for that role.
```

### 8.2 Gateway Error Reference

| HTTP | `error.code` | Cause | Client action |
|---|---|---|---|
| 400 | `invalid_model_format` | `model` lacks `creator/slug` form | Fix the model id |
| 400 | `unsupported_parameter` | `n > 1`, `logprobs` | Remove the parameter |
| 401 | `invalid_api_key` | Missing/malformed/unknown key | Check the key |
| 401 | `revoked_api_key` | Key revoked | Create a new key |
| 402 | `insufficient_balance` | Available balance below hold | Top up the wallet |
| 403 | `account_suspended` | Ops suspension | Contact support |
| 404 | `model_not_found` | Unknown model, **or** private model and caller is not the owner | Check the id / access |
| 429 | `rate_limit_exceeded` | Per-key rpm exceeded | Back off per `Retry-After` |
| 500 | `internal_error` | Platform fault (incl. RunPod credential failure) | Retry with backoff |
| 501 | `not_implemented` | `tools` / `functions` requested | Await Phase 2 |
| 503 | `model_unavailable` | Model not `ready`, paused, or endpoint missing | Retry later |
| 504 | `cold_start_timeout` | No first token within 90 s | Retry; the worker is likely warming |
| 504 | `stream_timeout` | Stream exceeded 300 s | Lower `max_tokens` |

### 8.3 Risk Register

| ID | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| **R1** | Supabase Edge Functions cannot reliably hold a streaming response through a 60 s cold start | **Critical** — invalidates the scale-to-zero thesis | Medium | De-risked in Sprint 1 (M1). Fallback: move the gateway to a Cloudflare Worker or a Fly.io Deno process; auth/billing RPCs are unchanged because they already live in Postgres. |
| **R2** | Cold-start latency exceeds developer tolerance regardless of engineering | High — retention | Medium | Explicit UX + docs; opportunistic warming (NFR-CS-005); paid always-warm tier (NFR-CS-006); baked-weights images (NFR-CS-007) |
| **R3** | Usage counts absent from the upstream stream → revenue leakage | High | Low–Medium | `include_usage` on vLLM; a character-based fallback that still bills and flags `usage_estimated`; alert if the estimated rate exceeds 1% |
| **R4** | Creator prices below platform GPU cost → negative margin | High | Medium | Live cost-floor display in Studio; per-model margin dashboard; `workersMax` caps blast radius; Ops kill switch |
| **R5** | Abuse of "uncensored" catalog for illegal content | High — legal/reputational | Medium | AUP at signup; creator attestation; Ops kill switch; documented takedown workflow (NFR-SEC-011) |
| **R6** | RunPod capacity unavailable for a requested GPU tier | Medium | Medium | Multi-tier fallback ordering; `503` with a clear message; `ComputeProvider` abstraction enables a second provider (NFR-EXT-001) |
| **R7** | HF token leakage across accounts | **Critical** — security incident | Low | Vault encryption; `service_role`-only decryption; log redaction; no API path returns plaintext (FR-DEP-010…014) |
| **R8** | Billing race under concurrency produces negative balances | **Critical** — direct financial loss | Low | `FOR UPDATE` serialization; holds net against balance; `CHECK >= 0`; pgTAP concurrency suite; nightly reconciliation |
| **R9** | Stripe webhook replay double-credits a wallet | High | Medium | `UNIQUE(stripe_event_id)`; `unique_violation` handled as a no-op (FR-BIL-034) |
| **R10** | HeroUI v3 built from v2 knowledge → broad rework | Medium — schedule | **High** | §4.1.0 constraints are binding; CI lint bans v2 imports and `onClick`; verified anatomies documented in this PRD |
| **R11** | Cross-region DB latency blows the 10 ms overhead budget | Medium | Low | Region pinning is a Sprint 1 setup step (NFR-PERF-001) |
| **R12** | Solver mis-predicts throughput → model card advertises a speed the endpoint can't deliver | High — public false spec | **Medium** | Smoke test measures real tok/s and auto-escalates one tier (FR-DEP-052); catalog displays **measured**, never predicted (FR-DEP-053); MFU recalibrated monthly from production (FR-DEP-058) |
| **R13** | Architecture metadata missing or wrong (`n_kv_heads` absent, non-standard config) → KV math wrong → OOM at cold start | High | Medium | Reject un-planneable repos at form time (FR-DEP-043); OOM at smoke test escalates a tier and retries once; never provision a model whose memory profile is unknown |
| **R14** | Split GGUF shards counted as separate variants → weights under-estimated 3× → GPU too small | Medium | Medium | Shard grouping is an explicit P0 requirement (FR-DEP-042) with a test fixture per split-file naming convention |
| **R15** | Creator picks a 100k window without grasping the 13× cost consequence, prices as if 8k, loses money per request | Medium | **High** | Cost floor recomputes live on every Slider move (FR-STU-004c); price-below-floor warning Alert (FR-STU-005); worked example surfaced in Studio docs |
| **R16** | Large variants (>20 GB) re-download weights on every cold start → 160 s+ TTFT → model commercially unusable | **High** | **High** | Network volume mandatory above the threshold (NFR-CACHE-011); per-model cold-start budget (NFR-CACHE-010); volume cost surfaced in the Deployment Plan card |
| **R17** | "$0 idle cost" is marketed absolutely, but volume-backed models carry ~$0.07/GB/month | Medium — trust | Medium | Volume cost is included in the solver's cost floor and disclosed on the plan card (NFR-CACHE-012); marketing copy says "no idle GPU cost", not "no cost" |
| **R18** | Cached-token discount shipped before hit rates are predictable → callers cannot plan spend, invoices become unexplainable | Medium | Medium | MVP bills cached tokens at the full rate and says so plainly (FR-BIL-042); discount gated behind the always-warm tier |
| **R19** | Gateway caches an API key or balance for performance → revoked key keeps working, or concurrent overdraft returns | **Critical** | Low | Explicit non-cacheable list (FR-GW-053); auth and balance read inside the reservation transaction; code review checklist item |
| **R20** | Variant classifier matches on quant tag alone → draft models and vision projectors offered as servable models; families collide | **High** — creator deploys a model that serves garbage or won't load | **High** (confirmed present in the MVP's own target repo) | Role + family classification (FR-DEP-041a/b); size backstop; the target repo committed as a blocking regression fixture (FR-DEP-047) |
| **R21** | GGUF treated as a secondary format → MVP's own acceptance target cannot be provisioned | **Critical** | Medium | llama.cpp runtime is P0, both images ship in MVP (FR-DEP-060…062); schema CHECK rejects a format/runtime mismatch before provisioning |
| **R22** | llama.cpp emits no usage on the stream → every GGUF request silently falls to the estimator, and the >1% estimated-usage alarm fires continuously or is muted | High — revenue accuracy | **High** | Runtime-aware extraction and per-runtime alert thresholds (FR-GW-044b); worker image pinned to a usage-emitting build with an automated test (FR-GW-044c) |
| **R23** | GGUF-only repos ship no `config.json`, so the solver cannot compute KV geometry | High | **High** (confirmed on the target repo) | GGUF header read via HTTP range request is a first-class path, not a fallback (FR-DEP-043 path 2); reject rather than guess |

### 8.4 Open Questions

| # | Question | Owner | Needed by |
|---|---|---|---|
| Q1 | Does the platform enforce a minimum price floor at or above GPU cost, or permit deliberate loss-leading? MVP assumes **permit, with a warning**. | Product | Sprint 2 |
| Q2 | Is `earnings_micro_usd` convertible to spendable `balance_micro_usd`? MVP assumes **no** — two separate accounts. | Finance | Sprint 3 |
| Q3 | Baseline `workersMax`: 3 (conservative, may throttle a viral model) or tier-dependent? | Eng | Sprint 2 |
| Q7 | When the solver can't hit the creator's target speed, does the platform deploy at the achievable speed (MVP assumption: **yes, with the real number shown**) or block until they lower the target? | Product | Sprint 2 |
| Q8 | Should q8_0 KV-cache quantization be auto-applied when it avoids a more expensive tier? It is a small, real quality change the creator didn't ask for. MVP assumes **yes, disclosed in the rationale**. | Product | Sprint 2 |
| Q9 | Is `assumed_utilization = 0.35` right for cost-floor math? Too high understates the floor and creators lose money; too low overstates it and prices become uncompetitive. Needs real data. | Finance | Sprint 4 |
| Q10 | Can one HF repo be deployed as several models at different quality levels (Balanced *and* Maximum as separate catalog entries)? Schema already supports it via `variant_quant_tag`; it is purely a slug-collision UX question. | Product | Sprint 2 |
| Q11 | Who pays for the network volume on large models — platform (absorbed into the 20% fee) or creator (a real non-zero idle cost that breaks the "$0 idle" pitch)? MVP assumes **platform absorbs, folded into the cost floor**. | Finance | Sprint 2 |
| Q12 | Should `idleTimeout` be raised above 30 s for models with steady traffic, trading idle GPU cost for prefix-cache warmth and better TTFT? Needs hit-rate data from Sprint 3. | Eng | Sprint 4 |
| Q13 | If a cached-token discount ships later, is it applied retroactively to the recorded `cached_prompt_tokens` history, or only forward? Forward-only is simpler and is the assumption. | Finance | Post-MVP |
| Q4 | Does the platform absorb cold-start GPU seconds, or is that cost embedded in creator pricing? Affects the cost-floor formula in Studio. | Finance | Sprint 2 |
| Q5 | Is `handle` permanently immutable, or changeable with a redirect? Immutability is simpler and is the MVP assumption. | Product | Sprint 1 |
| Q6 | Content moderation: pre-publication review of public models, or post-hoc takedown only? MVP assumes **post-hoc + attestation**. | Legal | Sprint 4 |

---

*End of document.*
