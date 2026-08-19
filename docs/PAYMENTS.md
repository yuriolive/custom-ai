# Payments — wallet funding rails

How balance gets into `profiles.balance_micro_usd`. Stripe is built and is the
default rail. Crypto is designed here and not yet built.

Read `docs/PRD-inference-marketplace-mvp.md` §4.4.4 first — FR-BIL-030…038 are
the requirements this document implements and extends.

---

## 0. The invariant every rail must satisfy

Nothing below is negotiable per-provider. A rail that cannot satisfy all five
does not ship.

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I1 | A credit happens **only** from a source the server verified cryptographically. Success redirects are UI hints. | Webhook signature / on-chain proof |
| I2 | A credit is **exactly-once** under provider retries. | `wallet_ledger.stripe_event_id` UNIQUE → generalised to `provider_event_id` |
| I3 | `SUM(wallet_ledger.amount) == profiles.balance_micro_usd`, always. | `credit_wallet` / `debit_wallet_reversal` write both in one transaction |
| I4 | Balance never goes negative. | `CHECK (balance_micro_usd >= 0)` + `greatest(0, …)` floor |
| I5 | Every balance movement is auditable back to a provider object id. | ledger `provider_*` columns + memo |

The database, not the handler, is what enforces I2 and I4. Two concurrent
webhook redeliveries both pass an application-level "have I seen this?" check;
only the UNIQUE constraint stops the double credit.

---

## 1. Shipped: Stripe Checkout (fiat cards)

```
Browser                Next.js                    Stripe                 Postgres
   │  POST /api/wallet/topup                          │                       │
   ├──────────────────────▶│ auth + amount limits     │                       │
   │                       ├─ checkout.sessions.create ▶                       │
   │◀── { url } ───────────┤                          │                       │
   ├─ redirect ────────────────────────────────────────▶ hosted card page      │
   │                       │◀── POST /api/stripe/webhook (signed) ──┤          │
   │                       ├─ constructEventAsync (HMAC) ───────────┤          │
   │                       ├─ rpc credit_wallet(event.id, …) ──────────────────▶
   │◀── Realtime balance ──┴───────────────────────────────────────────────────┤
```

| Piece | File |
|-------|------|
| Amount limits, $ ↔ cents ↔ micro-USD | `lib/billing/amounts.ts` |
| Stripe client, secrets | `lib/billing/stripe.ts`, `lib/billing/server-env.ts` |
| Session creation | `app/api/wallet/topup/route.ts` |
| Signed webhook, credit + reversals | `app/api/stripe/webhook/route.ts` |
| RPCs (`credit_wallet`, `debit_wallet_reversal`) | `supabase/migrations/20260818000300_stripe_topup.sql` |

Limits: min $5, max $500 per top-up, max $2,000 account balance (FR-BIL-036).
Refunds and disputes debit the wallet floored at zero and set
`profiles.flagged_for_review_at` (FR-BIL-035). Card data never touches this
deployment — SAQ-A scope.

**Fees, for comparison below:** 2.9% + $0.30 per card charge. On a $5 top-up
that is 8.9%; on $100, 3.2%. This is the number crypto has to beat.

---

## 1.1 One platform for card + crypto + ACH — enable them on Stripe

The requirement "a single platform that takes credit card, crypto, ACH and the
rest" has an answer that is already installed. Stripe accepts, under one
contract, one dashboard and one webhook:

| Method | Notes |
|---|---|
| Cards, Link, Apple Pay, Google Pay | shipped and working |
| **ACH Direct Debit** | requires the Stripe account to have a **US (USD) bank account** |
| **Crypto — USDC on Ethereum, Solana, Polygon, Base** | **1.5%**, settles to fiat on the same payout rails as cards |
| Local methods (Pix and boleto in Brazil, SEPA, iDEAL, …) | per-country, same Checkout Session |

Stripe's crypto flow is the processor pattern of §3 without the second vendor:
it creates a one-time deposit address, watches the chain for confirmations, and
posts a settled Charge. Checkout renders the QR plus a WalletConnect handoff.
Turning it on is Dashboard → Payments → Payment methods.

**What this costs us in code: essentially nothing, by construction.** The
webhook handler credits only when `payment_status === "paid"` and already
subscribes to `checkout.session.async_payment_succeeded` — which is precisely
the event a delayed method (ACH, crypto) fires when the money actually arrives,
minutes or days after the redirect. A new payment method is therefore invisible
to `credit_wallet`: same `event.id` idempotency, same ledger row, same
reconciliation. And because `app/api/wallet/topup/route.ts` deliberately does
**not** pin `payment_method_types`, the session inherits whatever the dashboard
has enabled — so turning on ACH or crypto is a dashboard change and zero lines
of code.

Two caveats worth knowing before promising it to anyone:

- **ACH needs a US entity.** A BRL-settling Brazilian account cannot accept ACH
  Direct Debit. For that audience the equivalent lever is **Pix**, which is
  cheaper than cards and which every Brazilian developer already has.
- **ACH returns and crypto finality arrive late.** An ACH debit can be returned
  days after we credited the wallet — by which time the balance may be spent.
  That is exactly what `debit_wallet_reversal`'s floor-at-zero path is for, and
  why the floored case logs loudly instead of failing quietly.

**Recommendation: make Stripe the single platform.** Take a second vendor only
for a reason Stripe cannot cover — non-USDC assets, chains outside those four,
or a crypto rate closer to 1% — and note that Coinbase Commerce's ~0.5 point
advantage on crypto is not worth a second ledger integration, a second webhook
signature scheme and a second reconciliation job until crypto volume is real.
The §3 comparison stays as the answer to "if not Stripe, then who".

---

## 2. Crypto — the decision

Three questions, in order. They are separable, and the wrong order is what makes
crypto payment projects sprawl.

1. **Who holds the coins?** Processor (they do) vs. treasury (you do).
2. **Who watches the chain?** Provider webhook vs. your own verifier.
3. **Which chain and asset?** Determined by 1 and 2, not the other way round.

### 2.1 Recommendation

**Ship a hosted processor first, on stablecoins only. Add wallet-connect +
on-chain verification second, as a parallel rail, once volume justifies the
custody work.**

The reason is not technical difficulty — the wallet-connect design in §4 is
about a week of work. It is that self-custody moves treasury key management,
reorg handling, sweep economics, and money-transmission exposure onto you, and
none of that is differentiating for an inference marketplace. Buy the boring
half first; build it only when the fee saving exceeds the operational cost.

---

## 3. Hosted processors compared

Fees and feature sets change; verify against each provider's current pricing
page before committing. Figures below are the published rates as understood at
time of writing and are directional, not contractual.

| | **Coinbase Commerce** | **NOWPayments** | **Helio** |
|---|---|---|---|
| Model | Hosted checkout + `x-cc-webhook-signature` (HMAC-SHA256) | Hosted invoice or API + IPN HMAC signature | Hosted "pay link" / embeddable widget + webhook |
| Fee | ~1% | ~0.5% | ~1% (lower on volume) |
| Chains | Base, Ethereum, Polygon, Solana, and other majors | 100+ chains, 300+ assets | Solana-first, plus EVM chains and Bitcoin |
| Settlement | USDC (self-custody payout to your wallet) | Crypto or auto-convert; fiat off-ramp via partners | Crypto; fiat off-ramp on business plans |
| Custody of your funds | Non-custodial payouts to your address | Custodial until payout | Non-custodial to your wallet |
| KYC on **you** | Coinbase business account | Business verification for fiat off-ramp | Business account |
| KYC on **payer** | None | None | None |
| Confirmation handling | Theirs | Theirs | Theirs |
| Under/overpayment | Handled, with tolerance windows | Handled, configurable | Handled |
| Best when | You want the most credible brand and Base-native USDC | You want maximum asset coverage and the lowest fee | Your users live on Solana; best UX and links/social checkout |

**Pick for this project: Coinbase Commerce.**

- Base + native USDC is exactly the pair §4.3 recommends for the eventual
  self-custody rail, so the chain choice does not have to be relitigated later.
- Non-custodial payout means the processor never holds platform revenue.
- The webhook shape (signed JSON, `event.id`, charge object with `payments[]`)
  maps onto the existing `credit_wallet` idempotency contract with no new
  concepts.

Choose **NOWPayments** instead if long-tail asset coverage is a real acquisition
argument (it usually is not for a developer tool priced in USD). Choose **Helio**
if the audience is Solana-native — its UX is the best of the three, but it
concentrates you on a chain whose USDC liquidity story is different from Base's.
Note that Helio now trades as **MoonPay Commerce** (§3.1); it is one product, not
two options.

### 3.1 Also evaluated: BitPay, MoonPay Commerce, Transak, Crossmint

All four accept payments as a merchant — MoonPay Commerce and Transak are not
on-ramps only, which an earlier draft of this document got wrong. What separates
them is **which methods one contract covers** and **what the payer must do**.

| | Acceptance methods | Settlement | Fee (verify) | Fit here |
|---|---|---|---|---|
| **BitPay** | Crypto: USDC on 6 chains, BTC, Lightning | Fiat (USD/EUR/GBP/CAD/AUD) or hold crypto | 2% + **$0.25** under $500k/mo; 1% + $0.25 above $1M | Works; the fixed $0.25 ruins a $5 top-up |
| **MoonPay Commerce** (this is what hel.io is now — Helio was acquired) | Crypto: USDC, USDT, ETH, SOL, BTC. Card path funds the crypto for the payer | Instant crypto, or auto-convert to USD/EUR/GBP | ~1% | Strongest crypto-first option after Coinbase Commerce |
| **Transak** | On/off-ramp plus merchant flows (Transak One card→on-chain delivery, Stream address-based off-ramp) | Crypto or fiat | Card 3.5–5.5%; SEPA ~0.99% | No productized checkout to match MoonPay's paylinks/subscriptions |
| **Crossmint** | Card, Apple Pay, Google Pay, many tokens; embedded wallets, guest checkout | Crypto or fiat | Processor fee + ~1–1.5% FX spread (fiat leg routes via MoonPay/Banxa) | Priced for delivering an on-chain asset; we deliver a database row |

Three things they share, and each one costs us something:

- **No ACH.** None of them is a US bank-debit acquirer. A wallet funded by ACH
  needs a card/bank processor, which means a second vendor no matter which of
  these we pick.
- **Card is a wrapper, not a rail.** Where they accept a card, they are buying
  crypto on the payer's behalf, so the payer goes through *their* KYC and the
  all-in cost is 3.5%+ — worse than Stripe's card rate, for more friction.
- **Amount fidelity on the card→crypto path.** What lands is
  quoted-minus-fees-minus-gas. Our ledger is exact integer micro-USD; a rail
  that delivers "about $20" pushes rounding policy into billing.

Where they still earn a place: as the **crypto-only** rail if Stripe's crypto
coverage (USDC on four chains) is too narrow, or as the "I have no USDC" path
inside the self-custody rail of §4, with the widget's destination set to the
deposit intent's treasury address.

### 3.2 What integrating one costs

Roughly a day, because the wallet half is already built:

1. `POST /api/wallet/topup/crypto` — create a hosted charge for the same
   validated amount, `metadata: { user_id }`.
2. `POST /api/crypto/webhook` — verify the provider HMAC over the **raw** body,
   then call `credit_wallet` with `provider_event_id = <provider event id>`.
3. Migration in §5 to make the ledger provider-agnostic.
4. UI: a second button in the top-up modal.

The exactly-once, floor-at-zero, and reconciliation machinery is reused
unchanged. That reuse is the entire argument for doing the ledger
generalisation (§5) **before** the second rail rather than after.

---

## 4. Design: wallet-connect + on-chain verification (self-custody)

The rail to build second. No processor, no percentage fee — only gas, paid by
the payer.

### 4.1 Flow

```
Browser (wagmi + viem)          Next.js                     Chain / Indexer        Postgres
  │ connect wallet                  │                             │                    │
  │ POST /api/wallet/topup/onchain  │                             │                    │
  ├────────────────────────────────▶│ mint deposit intent:        │                    │
  │                                 │  { id, user_id, amount,     │                    │
  │◀── intent + treasury address ───┤    memo_nonce, expires_at } ─────────────────────▶ deposit_intents
  │ USDC.transfer(treasury, amount) │                             │                    │
  ├──────────────────────────────────────────────────────────────▶│ tx mined           │
  │ POST /api/wallet/topup/onchain/claim { intentId, txHash }      │                    │
  ├────────────────────────────────▶│ verify tx via RPC ─────────▶│                    │
  │                                 │◀── receipt + logs ──────────┤                    │
  │                                 │ assert: Transfer event,     │                    │
  │                                 │  token == USDC, to ==       │                    │
  │                                 │  treasury, value >= amount, │                    │
  │                                 │  confirmations >= N          │                    │
  │                                 ├─ credit_wallet(provider_event_id = chainId:txHash:logIndex) ─▶
  │◀── new balance ─────────────────┤                             │                    │
```

A watcher (Alchemy/Helius webhook on the treasury address, or a polling cron)
runs the identical verification for users who close the tab before claiming.
Both paths converge on the same idempotency key, so whichever arrives first
credits and the second is a no-op.

### 4.2 The verification, precisely

The claim endpoint must assert **all** of these before crediting. Every one of
them is a real exploit if skipped:

| Check | Attack if skipped |
|-------|-------------------|
| Receipt `status == success` | Reverted tx credits balance |
| A `Transfer` **log** from the canonical USDC contract — not the tx `to` field | Any contract call that merely *mentions* the treasury credits balance |
| `log.address` equals the hardcoded USDC address for that chain | Attacker deploys a worthless token named "USDC" and transfers a million of it |
| `to` equals the treasury address | Transfer to a third party credits balance |
| `value >= intent.amount`, using the token's 6 decimals | Underpayment credits a full top-up |
| `confirmations >= N` (Base: ~10; Ethereum: use finalized) | Reorg reverses a credited transfer |
| Idempotency key `chainId:txHash:logIndex`, UNIQUE | One transfer claimed repeatedly, or by two users |
| Intent not expired and not already claimed | Old intent replayed at a stale price |
| Transfer `blockTimestamp >= intent.created_at` | An **old, unrelated** transfer to the treasury is claimed by whoever finds it first |

The last two are the ones people miss. A treasury address is public; every
historical inbound transfer to it is a claimable coupon unless intents are
time-bounded and one-shot.

Do the verification with the node's own logs (`eth_getTransactionReceipt` +
`eth_getLogs`), never with a wallet-supplied payload. The browser tells you a
transaction *hash*; it is not a source of truth about what that hash did.

### 4.3 Chain and asset

**Base, native USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals).**

| Option | Verdict |
|--------|---------|
| **Base + USDC** | **Pick this.** Sub-cent gas, Circle-native USDC (not a bridged wrapper), viem/wagmi tooling, ~2s blocks, and the same chain Coinbase Commerce settles on — so the processor rail and this rail share a treasury. |
| Solana + USDC | Excellent fees and finality; separate SDK stack (`@solana/web3.js`, wallet-adapter) and a second verifier. Add only if the audience demands it. |
| Ethereum L1 + USDC | $1–5+ gas per transfer destroys a $5 top-up. Support later for large-ticket only, if at all. |
| Multi-chain EVM (Arbitrum, Polygon, …) | Same viem code, one treasury address, per-chain USDC address table. Cheap to add once Base works. Do **not** start here. |
| Native ETH/SOL/BTC | No. Price volatility between quote and confirmation makes the credit amount an argument. Stablecoins only. |

Stablecoins only, priced in USD, is what keeps the wallet a wallet rather than a
trading position.

### 4.4 Treasury and key handling

The part that is not code:

- The treasury is a **receive-only** address. Nothing in the web app holds a key
  that can spend from it — the app only ever reads the chain.
- Sweeps to cold storage are a manual or separately-hosted operation with keys
  that never enter Vercel's environment.
- Prefer a Safe (multisig) over an EOA for anything holding meaningful balance.
- One address per chain, hardcoded in server config and asserted against a
  checksum constant — not read from a mutable table an SSRF or SQL bug could
  edit.
- Rotating the treasury address must not invalidate in-flight intents: store the
  destination address **on the intent row** and verify against that, not against
  the current config value.

### 4.5 Compliance sketch (not legal advice)

Accepting crypto for your own services is not, on its face, money transmission —
you sell inference and receive payment. The features that change that answer are
the ones to avoid: **do not offer withdrawals of wallet balance**, do not convert
between assets for users, and do not let one user's balance move to another.
The current design already forbids all three: balance is non-transferable,
non-refundable-to-crypto, and spendable only on the platform. Keep it that way
without counsel, and get counsel before adding creator payouts in crypto —
that direction (paying third parties) is where the analysis genuinely changes.

Sanctions screening on deposit addresses (Chainalysis/TRM API on the payer
address before credit) is the one control worth adding on day one of the
self-custody rail; a processor does this for you.

---

## 5. Prerequisite migration: make the ledger provider-agnostic

`wallet_ledger` is Stripe-shaped today: `stripe_event_id`, `stripe_session_id`,
`stripe_payment_intent_id`, plus
`check (kind <> 'topup' or stripe_event_id is not null)`. That CHECK makes a
crypto top-up literally unrepresentable. Do this **before** the second rail:

```sql
create type public.payment_provider as enum ('stripe', 'coinbase_commerce', 'onchain');

alter table public.wallet_ledger
  add column provider          public.payment_provider,
  add column provider_event_id text,
  add column provider_ref      text;   -- session id / charge id / chainId:txHash:logIndex

-- Backfill, then make the Stripe columns generated mirrors or drop them.
update public.wallet_ledger
   set provider = 'stripe',
       provider_event_id = stripe_event_id,
       provider_ref = coalesce(stripe_session_id, stripe_payment_intent_id)
 where stripe_event_id is not null;

create unique index wallet_ledger_provider_event_uidx
  on public.wallet_ledger (provider, provider_event_id)
  where provider_event_id is not null;

alter table public.wallet_ledger
  drop constraint wallet_ledger_topup_needs_event,
  add constraint wallet_ledger_topup_needs_event
    check (kind <> 'topup' or provider_event_id is not null);
```

`credit_wallet` then takes `(p_provider, p_provider_event_id, p_provider_ref)`
and every rail shares one exactly-once path. The UNIQUE index is on the
*pair*, so two providers can never collide on an id, and the partial predicate
keeps grants and adjustments (which have no provider) out of it.

New tables for the self-custody rail only:

```sql
create table public.deposit_intents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id),
  chain_id      integer not null,
  token_address text not null,
  treasury_address text not null,          -- pinned per intent (§4.4)
  amount_micro_usd bigint not null,
  payer_address text,                      -- captured at connect, screened
  status        text not null default 'pending',  -- pending|claimed|expired
  claimed_tx    text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);
```

---

## 6. Order of work

| # | Step | Status |
|---|------|--------|
| 1 | Stripe Checkout + webhook + reversals | **done** |
| 2 | Enable ACH (US only) + crypto + Pix as Stripe payment methods (§1.1) | next — dashboard only, zero code |
| 3 | Provider-agnostic ledger migration (§5) | before any second vendor |
| 4 | Second crypto rail *only if* §1.1 coverage proves too narrow (§3) | conditional |
| 5 | `deposit_intents` + claim endpoint + Base/USDC verifier (§4.2) | after 3 |
| 6 | Treasury watcher webhook (Alchemy) for closed-tab claims | with 5 |
| 7 | Sanctions screening on payer address | with 5 |

Each step reuses `credit_wallet`, the append-only ledger, and the nightly
reconciliation job. No rail gets its own balance arithmetic — that is the single
rule that keeps I3 true as rails multiply.
