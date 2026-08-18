# Roadmap — what's left, in priority order

Written to survive a context reset. Assumes no memory of the sessions that produced
the current state. Read `HANDOFF.md` for measured facts and `DEPLOY.md` for the live
topology.

**Where things stand:** MVP-0 is deployed. The gateway is ACTIVE on Supabase
(`verify_jwt: false`, v3), Modal is deployed at $0 idle, migrations are applied, the
web app is on Vercel. 263 node tests + 129 pgTAP + 41 python, CI green. A real billed
inference has been verified end to end **locally** and against an **authenticated**
Modal endpoint.

**What "deployed" does not yet mean:** production has zero models, zero users, zero
API keys. Migrations created empty tables and seeds are correctly ignored, so the
product cannot currently be populated *through itself*.

---

## P0 — blocks a usable product

### 1. Creator Studio
The single biggest gap. Models can only be added by SQL, so the marketplace has no
supply side and nobody but the operator can list anything.

Already built and unused: the whole capacity solver (`resolve_placement` in
migrations), variant classification (`packages/hf-probe`), and the placement fields on
`custom_models`. The UI is the missing half.

Needs (PRD §4.1.2, FR-STU-001…013):
- HF repo probe on blur → variant **consequence table** (quality / size / GPU /
  tok-s / max ctx / cost floor per row), not a filename dropdown
- intent inputs only: context window + minimum tok/s + quality. **No GPU selector** —
  hardware is solved, and §4.3.3.3 explains why a human cannot pick it correctly
- live Deployment Plan card with a "Why this GPU?" disclosure
- provisioning stepper, Realtime status, failure remediation hints
- "My Models" table with pricing edit, visibility toggle, delete behind an AlertDialog

Blocked on nothing. This is pure product work against finished infrastructure.

### 2. Populate production (interim, hours not days)
Until Studio exists, production needs one creator profile, the Qwen model row pointed
at the live Modal endpoint, a funded caller, and a key minted against **production**
(never the committed fixture — see the seed warning in `DEPLOY.md`). Do this via
`tools/keygen` + SQL, then run the `DEPLOY.md` §5 verification for a real billed
request through the deployed stack.

### 3. Two dashboard settings (operator, 5 minutes)
- **Auth URLs** — still `http://127.0.0.1:3000`; confirmation emails are unusable
- **SSO scope** — `all_except_custom_domains` protects production too, so the public
  site demands a Vercel login. Attach a custom domain or narrow to preview-only

---

## P1 — blocks real users

### 4. Frontend polish + design system
Currently functional and plain. Target: Modal's visual language (see
`docs/DESIGN.md`, produced separately) with together.ai as a secondary reference.

Constraints that already exist and must not be broken:
- HeroUI v3 only — compound components, `onPress`, `Alert status=`, and
  `@heroui/react` is **client-only** (Server Component fetches, client renders)
- capability-only surfaces: **no GPU names** anywhere in the UI
- measured, never predicted, throughput on cards
- light **and** dark must both be correct; 375px must not overflow

### 5. Stripe wallet top-up
Deferred by explicit decision. Wallets can only be funded by SQL `credit_wallet`
today, so no self-service developer can pay. Schema, ledger and idempotency are done
(FR-BIL-030…038) — only Checkout + the webhook are missing.

### 6. `/playground/[creator]/[slug]`
The Playground serves one hardcoded model. Correct with one public model; broken the
moment a second exists, and the marketplace cards already link to it.

---

## P2 — unlocks agentic clients

### 7. Tool calling — do this before the Anthropic work
Highest-leverage single change in the backlog. The gateway currently 501s `tools`,
which makes it unusable for **Cline, Aider, OpenAI Agents SDK, LangGraph** and Claude
Code alike.

PRD §4.5. The trap: llama.cpp needs `--jinja` so the model's own chat template drives
tool formatting; without it the server ignores `tools` and returns prose that *looks*
like a tool call, which parses as success.

### 8. Anthropic Messages API → Claude Code
`packages/anthropic-adapter` is **already built and tested** (53 tests) and unused.
Remaining: `/v1/messages` route, `x-api-key` auth, and
`POST /v1/messages/count_tokens` — which Claude Code calls, and without which it
fails before sending a single completion.

§4.5 is a hard prerequisite: Claude Code is a tool-call loop, so shipping the wire
adapter first yields a client that connects and can do nothing.

Honest viability: 14 tok/s measured. Agentic coding needs tool calling **and** a fast
tier (~149 tok/s predicted on H100) **and** always-warm. That combination is a paid
"agent tier", not a flag.

---

## P3 — quality and ops

| Item | Why it matters |
|---|---|
| **Warm TTFT 926 ms vs 400 ms SLO** | Measured miss, unresolved. Either the target is wrong for a 27B on a budget GPU, or the path needs work. Do not restate the SLO to match the measurement. |
| **MFU is a guessed 0.75** (measured ~0.79) | Decides A10 vs L40S and $0.85/hr. Tier selection currently rests on a guess. |
| **Persisted KV cache** (§6.6 C2a) | Prefill dominates: a 10k-token prefix costs ~75 s cold vs ~0.6 s restored from Volume. May remove the always-warm requirement for the agent tier entirely. |
| **Supabase Branching** | Removes production service-role key from preview environments. Threshold: the first real user. |
| **One-time `prettier` + `deno fmt` pass** | Both `format:check` steps are advisory; the repo has never been formatted. Do it as its own commit so it buries nothing. |
| **`active_weights_bytes` for MoE** | Correct for this dense model; needs the tensor-info section for MoE, which is outside the header range window. |

---

## Decided, not open

**Cached-token pricing: no discount.** Reconfirmed by the owner with the competitive
context known — together.ai advertises `Cached Input` as a headline number on every
model card, so this choice has a real cost. It stands anyway because under
scale-to-zero the hit rate depends on whether an unrelated caller hit the same model
seconds earlier, and a discount nobody can predictably earn is a pricing surface, not
a feature. `cached_prompt_tokens` is recorded on every transaction regardless, so the
decision can be revisited against real hit-rate data rather than argument.
**Trigger to revisit: the always-warm tier existing** (NFR-CS-006), which is what makes
a hit rate predictable enough to price.

**Production email is unconfigured and blocks signup.** `enable_confirmations = true`
with no `[auth.email.smtp]` block means production falls back to Supabase's built-in
sender, which is rate-limited to a few per hour and not intended for production. Fix
with real SMTP before any real user; for an operator account, create the user in
Dashboard → Authentication → Users with auto-confirm and skip email entirely.

**GitHub OAuth needs credentials, not code.** `signInWithOAuth` is wired and the
authorize URL was verified correct including PKCE. Missing only a GitHub OAuth App
(callback `https://gexxzdlppbplfpfqhszf.supabase.co/auth/v1/callback`) and its client
id/secret in Dashboard → Authentication → Providers.

---

## Parked — Phase 3 (§4.7)

Abliteration-as-a-service (Heretic) and LoRA/fine-tuning. Recorded only so the
architecture does not foreclose them. Two cheap decisions keep the door open: a
nullable `derived_from_model_id` on `custom_models`, and not deleting the
lora/adapter branch of the companion classifier because nothing consumes it yet.

---

## Suggested order

1. **#3** (5 minutes, operator) — unblocks sign-up and public access
2. **#2** (hours) — proves the deployed stack bills a real request
3. **#1 Creator Studio** — turns it into a product other people can use
4. **#7 Tool calling** — the cheapest large capability win
5. **#4 Design** — do it once Studio exists, so the new surfaces get the same treatment
6. **#5 Stripe** — needed before anyone can pay
7. **#8 Claude Code**, then P3

The consistent lesson from every bug found so far: **failures here are silent rather
than loud.** Wrong-length seed keys, floats into integer columns, public Modal
endpoints, a dead column name inside an RLS policy, counting only `content` on a
reasoning model, balances rounding up. Where a check is cheap, make the failure loud —
`seed.sql`'s assertion block and the in-migration RLS assertions are the pattern.
