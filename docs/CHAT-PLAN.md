# Consumer Chat — implementation plan

Status: **proposal**, not frozen. Written against the repo as of 2026-08-19 and the
competitive scan in §2, which was taken live on the same day.

Read `CONTRACTS.md` first. This document proposes two changes to text that is frozen
there (§4 billing identity, §7 route protection). Both are called out explicitly rather
than assumed, per the rule at the top of that file.

---

## 1. Why this exists

The Playground is a developer instrument: a scratchpad with `temperature`, `max_tokens`
and a system prompt beside the transcript. That is the right surface for someone who is
about to write code against the API. It is the wrong surface for someone who has never
heard of top-p, and it is the wrong surface for the thing this marketplace actually
needs.

The marketplace has a supply-side problem, not a UI problem: a creator lists a model
because the model gets used. `/playground` cannot generate that usage — it serves one
hardcoded model to an audience that is already technical and already has an API key.
Chat can. **Chat is demand generation for the creator side of the flywheel, and should
be scoped and judged as that, not as "a nicer playground".**

Both surfaces stay. They do not merge, and the parameters do not migrate into chat.

## 2. What the industry ships (measured 2026-08-19)

**Venice — `venice.ai/chat/classic`.** Composer, attachment button, and nothing else on
screen. The model selector's default label is `Automático` — the product's opening
position is that the user should not have to choose. Parameters sit behind a
`Configurações` button; tools behind an `Ações` button. A `Chat temporário` toggle is
offered with the copy "chats are saved in your browser, Venice never keeps a copy" —
history is a privacy feature there, not a sync feature. The agentic surface is a
**separate route** (`/chat/agent`), advertised as new, not a mode hidden inside the
normal chat.

**OrcaRouter — `orcarouter.ai/playground`.** One page, three tabs (chat / image / video).
A `Web search` toggle available on any model, with the cited sources rendered under the
answer. `Compare` fans one prompt out to up to three models side by side. Prompt chips
seed the composer. Guest mode gives a small number of free messages per day without an
account. And the funnel closer, stated as a headline feature: *"Copy the exact API
request behind any conversation — curl or SDK."*

**OpenRouter — `openrouter.ai/chat`.** Titled "AI Chat Playground — Compare AI Models
Side by Side". The load-bearing pattern is the URL: a model page links to
`/chat?models=~z-ai/glm-latest`. Every model page is an entry point into the chat with
that model preselected.

Three products, one shape:

1. **Zero inference parameters visible by default.** Model choice is the only decision.
2. **A deep link from each model page into the chat**, model preselected.
3. **A documented ramp from chat back to the API**, so the consumer surface feeds the
   developer one.
4. **Agentic / tool use is a separate, later surface**, not a checkbox on the normal chat.

## 3. Non-negotiables inherited from this repo

Nothing below is new; it is what chat has to respect.

- Model ids are `creator-handle/model-slug`, case-insensitive, **not** HF repo paths.
- Money is integer micro-USD end to end. Settlement is `deduct_token_cost`, and the split
  is `platform_micro = CEIL(cost_micro * fee_bps / 10000)`, remainder to platform.
- Token counts must include `reasoning_content`. The seeded model streams chain-of-thought.
- Errors use the OpenAI envelope with the documented `code` values.
- No GPU names in the UI (capability-only surfaces).
- Nothing secret is `NEXT_PUBLIC_`.
- Settlement runs outside the client-write path: a user closing the tab must still bill.

## 4. The billing identity problem — the actual blocker

`app/api/playground/route.ts` authenticates to the gateway with `serverEnv.platformApiKey`.
**The platform pays for every Playground turn**, and no `usage_transactions` row is
attributable to the caller. That is defensible for a single-model demo behind an
authenticated route. It is not defensible for a chat aimed at consumers: it is an
unbounded free-inference path against a metered GPU, and the creator earns nothing from
any of it.

Chat must bill the signed-in user's wallet and write a normal transaction row, so the
80/20 split reaches the creator exactly as an API call would. Three ways there:

### Option A — session-bound inference key in an httpOnly cookie *(recommended for v1)*

On the first chat turn of a session, mint a key server-side with the existing
`generateApiKey` from `@custom-ai/keygen` (`name: "Web chat"`, scopes `['inference','chat']`).
The plaintext goes into an `httpOnly`, `Secure`, `SameSite=Lax` cookie and **into nothing
else** — the plaintext invariant documented in `app/api/keys/route.ts` holds unchanged,
because the plaintext still reaches exactly one response and is never persisted
server-side. `/api/chat` reads the cookie and forwards it as the Bearer to the gateway.

- Gateway: **unchanged.** Auth, resolve, hold, stream, settle, error envelope — all reused.
- `usage_transactions` gets a real `api_key_id`, so chat spend is separable from API spend
  in the console with no schema change.
- Cost: key material lives in a cookie. It is `httpOnly`, so page script cannot read it, and
  an XSS able to steal it could already call `/api/chat` directly — the marginal exposure is
  the key outliving the tab. Bound it: revoke on sign-out and cap its lifetime.

### Option B — gateway accepts a Supabase JWT

`auth.ts` branches on token shape (`sk-plat-` prefix vs JWT), verifies with the Supabase
JWT secret, and resolves `user_id` directly. `usage_transactions.api_key_id` is nullable
(`on delete set null`) and `authorize_request` takes `p_api_key_id`, so a NULL is
representable today.

Cleaner conceptually, and the right answer the day a native or mobile client exists. But it
edits an A5-owned path, changes the frozen auth contract, and puts a second credential type
on the hot path where "never cache key validity" must hold for both. **Not v1.**

### Option C — rebuild billing inside `/api/chat` with the service role

Rejected. It would duplicate hold/stream/settle outside the gateway, and this repo already
carries one two-implementations-must-stay-in-step hazard (`lib/studio/server/upstream.ts`
vs the gateway's parser). A second one, on the money path, is not worth a saved hop.

> **CONTRACTS.md change requested (§Frontend / auth contract):** document the chat cookie
> and the `chat` scope, so a later agent does not reimplement it a second way. Option A
> needs no migration.

## 5. The other blocker: cold start

Cold start is ~90–100 s (`custom_models.cold_start_budget_s` defaults to 90; the playground
proxy allows 300 s for the whole turn). Measured decode is 14 tok/s and warm TTFT is 926 ms.
Venice and OpenRouter answer immediately. A non-technical visitor who waits 90 s for a first
token does not wait — they close the tab, and no amount of UI fixes that.

This is the largest product risk in the feature, larger than any layout question. What v1
can honestly do:

- **Reuse `components/playground/cold-start-notice.tsx`.** It exists and already says the
  true thing.
- **Never let a first-time visitor's first turn land on a cold exotic model.** Default the
  selector to the model with the most recent settled traffic — not alphabetical, not
  whatever the marketplace is promoting.
- **Label warmth in the picker.** A model with a settled transaction inside the worker's
  idle window is probably warm; everything else is "first reply takes about 90 s". State the
  number. Do not run a spinner and hope.
- Do not pretend this is solved. The real fixes (persisted KV cache, an always-warm tier)
  are on the roadmap and are out of scope here.

## 6. Scope

Requirement ids follow the PRD's convention so code comments can reference them.

### v1 — the chat itself

| id | requirement |
|---|---|
| FR-CHAT-001 | `/chat` renders a composer, a transcript, and a model selector. **No inference parameters on screen** — no temperature, no top-p, no max tokens, no system prompt. |
| FR-CHAT-002 | The selector lists public `ready` models, labelled by **creator handle + display name**. It is a marketplace; the creator is the brand. No GPU names, no quant tags. |
| FR-CHAT-003 | `/chat?model=creator/slug` preselects that model. An unknown or non-public id falls back to the default with a visible notice, never a 404. |
| FR-CHAT-004 | Every model page (`/models/[creator]/[slug]`) gets a primary CTA into FR-CHAT-003. This is the conversion path; without it the feature is a page nobody finds. |
| FR-CHAT-005 | Turns bill the signed-in user's wallet through the gateway (§4 Option A) and settle exactly one `usage_transactions` row per turn. |
| FR-CHAT-006 | Cold-start disclosure and warmth labelling per §5. |
| FR-CHAT-007 | History is local to the browser (`localStorage`), with an explicit "the platform keeps no copy" statement and a delete control. Venice's position, and it costs no schema. |
| FR-CHAT-008 | `402 insufficient_balance` renders as a top-up prompt linking to `/console/wallet`, not as a raw error. It is the one error a consumer will actually hit. |
| FR-CHAT-009 | Sign-in required. **No guest mode in v1** — see §7. |

### v2 — the ramp, and the first tool

| id | requirement |
|---|---|
| FR-CHAT-010 | "View as API" copies the equivalent `curl` / `openai` SDK snippet for the current conversation. The OrcaRouter move, and the reason a consumer surface is worth building on a developer product. |
| FR-CHAT-011 | Web search as a **server-side** retrieval step: search, inject context, render cited sources under the answer. Works with any GGUF because it never depends on the model emitting a tool call. |
| FR-CHAT-012 | Text attachment (paste-a-document), same server-side path. |

### v3 — agentic, gated on the roadmap

| id | requirement |
|---|---|
| FR-CHAT-013 | `/chat/agent` as a **separate route**, with real tool calling. Hard-blocked on roadmap item #7 — the gateway 501s `tools` today, and llama.cpp needs `--jinja` or it returns prose that merely looks like a tool call. |
| FR-CHAT-014 | Per-model `supports_tools`, detected at probe time. Tool calling in GGUF-land is per-chat-template and is not uniform; a global toggle would be a lie. |

**Deliberately out of scope:** image and video generation (no such worker exists);
multi-model compare (a second GPU spin-up per prompt against a 90 s cold start is a bad
first impression, not a feature); server-side synced history.

## 7. Guest mode — recommend against, for now

OrcaRouter and Venice both give anonymous visitors free turns. They can afford to: their
upstream is someone else's warm API at per-token cost. Here an anonymous turn spins up a
metered GPU the platform pays for outright, and the frozen route table would have to move
`/chat` from authenticated to public. It is the same free-inference shape the
`GREATEST(1, …)` minimum-billable-unit rule in CONTRACTS exists to close.

If it is wanted later it needs its own budget, a rate limit keyed on something better than
an IP, and one cheap always-warm model to spend it on. Not a flag.

> **CONTRACTS.md change requested (route table):** `/chat/**` joins the authenticated
> column alongside `/console/**`, `/studio/**`, `/playground/**`, and the prefix is added to
> `PROTECTED_PREFIXES` in `lib/supabase/middleware.ts`.

## 8. Files

All of this lands in `app/` + `components/` + `lib/`, which is A7-owned. Nothing here edits
`supabase/functions/gateway/**` or `supabase/migrations/**`.

| path | change |
|---|---|
| `app/chat/page.tsx` | new — server component, exports `metadata`, reads `?model` |
| `components/chat/chat.tsx` | new — client; transcript + composer, no parameter controls |
| `components/chat/model-picker.tsx` | new — creator-labelled, warmth-labelled |
| `components/chat/history.ts` | new — `localStorage`, versioned, delete-all |
| `app/api/chat/route.ts` | new — mints/reads the session key, proxies to the gateway |
| `lib/chat/session-key.ts` | new — mint, cookie read/write, revoke on sign-out |
| `lib/chat/models.ts` | new — public `ready` catalog query for the picker |
| `lib/supabase/middleware.ts` | `PROTECTED_PREFIXES` gains `/chat` |
| `app/models/[creator]/[slug]/page.tsx` | CTA into `/chat?model=…` |
| `components/playground/cold-start-notice.tsx` | reused as-is, or lifted to a shared path |

`components/playground/**` keeps its parameter controls and is otherwise untouched.

## 9. Acceptance test

One sentence, in the style of MVP-0's:

> A signed-in user with a funded wallet opens `/chat` from a model page, sends one message,
> reads the reply stream, and **exactly one** `usage_transactions` row settles against their
> own wallet with a correct 80/20 split — with no plaintext key persisted anywhere, no
> secret in a `NEXT_PUBLIC_*` variable, and the gateway unmodified.

## 10. Open questions

1. **Default model.** "Most recently used" is the honest warmth heuristic, but it degenerates
   on an empty production. Fall back to `NEXT_PUBLIC_DEFAULT_MODEL`?
2. **Chat keys in the console.** Hide them by scope, or show them so a user can see and revoke
   every credential able to spend their balance? Security says show; the console's key list
   currently reads as "keys you created". Leaning: show, under a separate "Sessions" block.
3. **Roadmap item #6** wants `/playground/[creator]/[slug]`. Chat's picker makes that URL shape
   cheap to reuse — worth doing both in one pass?
4. **Rate limiting.** Nothing rate-limits an authenticated caller today; the wallet is the
   limit. Adequate for chat, or does a spend-per-hour ceiling belong here?
