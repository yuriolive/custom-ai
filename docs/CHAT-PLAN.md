# Consumer Chat — implementation plan

Status: **v1 is implemented** (`/chat`, `/api/chat`, `lib/chat/`, `components/chat/`).
v2 and v3 remain proposals. Written against the repo as of 2026-08-19 and the
competitive scan in §2, which was taken live on the same day.

Read `CONTRACTS.md` first. Both of the frozen-text changes this document requested were
raised before being taken, and both have now landed there: `/chat/**` is in the
authenticated route table, and the chat session cookie is documented alongside the other
things the browser may not do directly.

§11 records what v1 actually decided, including where it deliberately does less than the
plan asked for.

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
| FR-CHAT-013 | `/chat/agent` as a **separate route**, with real tool calling. **Unblocked:** roadmap item #7 landed — the gateway forwards `tools` / `tool_choice` and the worker passes `--jinja`, without which llama.cpp ignores `tools` and returns prose that merely looks like a tool call. |
| FR-CHAT-014 | Offer tools only where `custom_models.supports_tools` says so. **Already exists**, measured at provisioning from the chat template, and it is THREE-state: `true`, a measured `false`, and `null` for rows provisioned before the column. The chat must treat `null` as "unknown", not as "yes" — the whole point of the flag is that GGUF tool support is per-chat-template and a global toggle would be a lie. |
| FR-CHAT-015 | Third-party tool connectors — a catalog of integrations the user grants once and any model can then call. See §7.5. |

## 7.5 Tool connectors — the shape to leave room for

Recorded now so the architecture does not foreclose it, in the same spirit as the parked
Phase-3 items in `ROADMAP.md`. Nothing here is scheduled.

Once FR-CHAT-013 exists, the interesting question stops being "can the model call a tool"
and becomes "whose tools, and who holds the credentials". Three ways to answer it, and
they are not exclusive:

**Platform-owned tools.** Web search, a code sandbox, a URL fetcher. The platform holds
the credential, the cost folds into the turn, and nothing about the user's accounts is
involved. This is where FR-CHAT-011 already starts, and it is the only kind that needs no
consent flow.

**MCP servers.** The de-facto standard for "here is a tool server, here are its tools".
A user (or a creator, per model) points the chat at an MCP endpoint and its tools become
callable. The attraction is that it is a protocol rather than a vendor: anything that
speaks MCP works, including things the platform has never heard of.

**Aggregators — Composio and its kind.** One integration that brings hundreds: Gmail,
Slack, Notion, GitHub, Linear, calendars. The user authorises each app once, on the
provider's side, and the platform never sees those credentials. This is the cheapest path
to "the chat can actually do things in my accounts", and it is what makes an agent tier
worth paying for rather than a demo.

What has to be true before any of it ships, stated now because retrofitting it is where
these features go wrong:

- **The credential boundary is the whole design.** OAuth grants to third-party accounts
  are not `api_keys` rows, are not micro-USD, and must not end up in the same table
  because they are both "secrets". They need their own storage, their own revocation UI,
  and a per-connector consent record — what was granted, when, by whom.
- **A tool call is an action, not a completion.** Sending an email on a model's say-so is
  irreversible, and the gateway's whole safety story today is that the worst outcome is a
  wasted token. Anything with a side effect needs an explicit confirmation step in the UI
  before it fires, per connector, and a log of what fired.
- **Billing is not just tokens any more.** A tool call is latency the user pays for in
  wall-clock and often a third-party quota. `usage_transactions` has no shape for that,
  and inventing one on the fly during an agent sprint is how a billing model gets a float
  in it.
- **Per-model capability, not a global switch.** `supports_tools` already carries this for
  tool calling; connectors inherit it. A model whose chat template cannot emit a tool call
  must not be offered a connector list — and one whose flag is `null` is unknown, not
  capable.

The cheap decision that keeps the door open was already made elsewhere: tool support is a
per-model capability flag, not a property of the chat surface. Connectors ride on that.

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

## 11. What v1 actually shipped

Implemented against §6, with the differences below. They are recorded because a plan that
is quietly not what was built is worse than no plan.

**Billing went with §4 Option A, unchanged.** `lib/chat/session-key.ts` mints an
`sk-plat-` key scoped `['inference','chat']`, named `Web chat (browser session)`, and puts
the plaintext in one httpOnly cookie. The gateway was not modified. Three things the plan
did not spell out and the implementation had to decide:

- **The cookie is validated against the database on every turn**, by hashing it and doing
  the same indexed `key_hash` lookup the gateway does. The alternative — discovering a
  revoked key when the gateway answers 401 — happens mid-stream, after the response
  headers have flushed, which is the one moment nothing can be done about it.
- **Three chat keys per account, oldest revoked to make room.** The plaintext is
  unrecoverable, so every new browser session can only mint. Without a cap, a user who
  clears cookies weekly walks into the console's 25-key ceiling and cannot create an API
  key any more.
- **Sign-out revokes the key**, before the auth session it belongs to is destroyed.
  Otherwise the auth cookie goes and a credential that can spend the wallet stays behind
  in the browser.

**History became a thread list, not a single conversation.** Still `localStorage`, still
no server copy (FR-CHAT-007). A "New chat" that destroys the previous one is not a chat
product, and the storage shape was the cheap half of the work.

**Cost is shown as an estimate, and says so.** The gateway does not surface the settled
figure to its callers yet, so each turn is priced from the model's own published prices
using the ledger's own arithmetic — integer micro-USD, CEIL each side, one-microdollar
floor. It errs in the direction of the bill rather than under-quoting it. The exact charge
stays where it is authoritative, on `/console/usage`.

**Per-model warmth labelling was NOT built** — §5 asked for it. There is no signal for it
in the schema today: `total_requests` is a lifetime counter and `p50_ttft_ms` is
warm-worker latency, and neither answers "is a worker up right now". What shipped instead
is the honest half: the default model is the most-requested one (the closest proxy the
public projection allows), and the cold-start wait is stated as a number both in the model
line and in the notice that appears while the worker wakes. A real badge needs a
`last_request_at` column or a view, which is a migration and belongs to A1.

**A retry affordance was added.** `presentChatError` marks only the two timeouts
retryable, and only those get a "Try again" button. Offering retry on a 402 would be a
product spending someone's attention on an error that is guaranteed to repeat.

**The turn meter is now shared with the playground** (`lib/turn-metrics.ts`). Both routes
proxy the same gateway and report the same numbers; two copies drift, and they drift in
the direction of under-reporting tokens.

**The model control is a palette, not a form control.** First cut was a `<Select>`
with a paragraph of price small print beside it, which read as a setting to configure
before starting — the exact impression this surface exists to avoid, and unusable the
moment the catalog outgrows a handful of rows. It is now a pill showing what you are
talking to, opening a searchable palette (⌘K) whose rows carry the speed, context and
price of the model they name. The one line of small print moved under the composer,
where every product in this category puts its disclaimer.

**The blank state centres itself.** Composer, heading and openers sit in the middle of
the canvas until the first message, then the composer drops to the bottom and the
transcript takes the space. A composer pinned to the bottom of an empty page reads as
the footer of a page that failed to load.

**A HeroUI Modal that stays mounted cannot be closed.** `Modal` is React Aria's
`DialogTrigger`, which pairs [trigger, overlay] children; with no trigger child the root
treats the backdrop as its trigger and never gets an overlay to unmount, so
`isOpen={false}` does nothing and the dialog ignores Escape, an outside click and its own
row presses alike. Measured in a browser, not assumed. Every dialog here is therefore
mounted only while open, which is what the working dialogs in `model-dialogs.tsx` already
do. **`CreateKeyDialog` in `components/console/key-dialogs.tsx` and the Add-funds dialog
in `top-up-dialog.tsx` both use the always-mounted shape and are likely to have the same
defect** — reported, not fixed here.

**The rail's list-level actions live on the list header.** "Delete all" spent a version
at the bottom of the rail, under the privacy footnote, styled as a link. That is where a
footnote goes, not where the control that erases every conversation goes. It is now in an
overflow menu on the "Conversations" header — adjacent to what it acts on — and behind a
confirm dialog, while deleting a single conversation is a bin on its own row, revealed on
hover and on keyboard focus.

### Verified

`npm run check` and `npm test` green; `next build` compiles `/chat` and `/api/chat`. In a
local dev server: `/chat` redirects to `/login?next=%2Fchat` when signed out, the model
page CTA links to `/chat?model=…` with the model preselected, the transcript renders
fenced code with a copy control, the per-turn estimate matches the arithmetic above by
hand, and an unauthenticated POST to `/api/chat` renders as "You are signed out" with a
sign-in link rather than a raw envelope. No horizontal overflow at 375px; dark mode
correct.

**Not verified end to end:** a real billed turn. That needs a signed-in session and a
funded wallet, and it is the acceptance test in §9 — run it before calling this done in
production.
