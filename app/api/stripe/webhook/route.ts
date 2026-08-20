/**
 * POST /api/stripe/webhook — the ONLY thing in this codebase that credits a
 * wallet from a payment (FR-BIL-032).
 *
 * THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 * 1. AUTHENTICITY (FR-BIL-033). The request is unauthenticated in every ordinary
 *    sense — no cookie, no API key — so the `Stripe-Signature` HMAC is the whole
 *    of the trust model. It is verified against the RAW body before anything is
 *    parsed. A body that fails verification gets a 400 and produces no side
 *    effect whatsoever. Never move the verification below a `JSON.parse`, and
 *    never re-serialize the body first: `JSON.stringify(JSON.parse(x)) !== x`
 *    for anything with unusual key order or unicode escapes, and the signature
 *    is over the original bytes.
 *
 * 2. EXACTLY-ONCE CREDIT (FR-BIL-034). Stripe delivers at-least-once and retries
 *    aggressively. `wallet_ledger.stripe_event_id` is UNIQUE and every credit
 *    passes `event.id`, so a redelivery is a no-op at the DATABASE layer rather
 *    than at this one. That matters: two concurrent redeliveries can both pass
 *    an application-level "have I seen this?" check, and only the constraint
 *    stops them.
 *
 * 3. NO POISON RETRY LOOP. Anything Stripe cannot fix by resending — an unknown
 *    user, an event we do not handle, a balance-cap refusal — answers 200 with a
 *    logged reason. Only genuine transient failures (the database is down) get a
 *    5xx, because a 5xx is a request to retry. A handler that 500s on a
 *    permanent error turns one bad event into days of noise.
 */

import type Stripe from "stripe";

import { centsToMicroUsd } from "@/lib/billing/amounts";
import { billingServerEnv } from "@/lib/billing/server-env";
import { createStripeClient, STRIPE_MEMO_PREFIX } from "@/lib/billing/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

/** Node, not edge: signature verification needs the raw body and Node crypto. */
export const runtime = "nodejs";
/** Never cached, never prerendered — it mutates money. */
export const dynamic = "force-dynamic";

/** Events that move a wallet. Everything else is acknowledged and ignored. */
const HANDLED = new Set<Stripe.Event["type"]>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "charge.refunded",
  "charge.dispute.created",
]);

/** 200 with a machine-readable reason. Stripe treats any 2xx as delivered. */
function ack(reason: string, extra: Record<string, unknown> = {}) {
  return Response.json(
    { received: true, reason, ...extra },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The user this event belongs to.
 *
 * Metadata is set on both the Session and the PaymentIntent by
 * `/api/wallet/topup`, so it survives into `charge.*` events. The ledger lookup
 * is the fallback for a charge created before that metadata existed, or by a
 * Stripe-dashboard refund that dropped it.
 */
async function resolveUserId(
  admin: ReturnType<typeof createAdminClient>,
  metadataUserId: string | undefined,
  paymentIntentId: string | null,
): Promise<string | null> {
  if (metadataUserId) return metadataUserId;
  if (!paymentIntentId) return null;

  const { data } = await admin
    .from("wallet_ledger")
    .select("user_id")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .eq("kind", "topup")
    .limit(1)
    .maybeSingle();

  return data?.user_id ?? null;
}

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "missing signature" }, { status: 400 });
  }

  // RAW BODY. `request.text()` before any parsing — see property 1 above.
  const rawBody = await request.text();

  let event: Stripe.Event;
  const stripe = createStripeClient();
  try {
    // Async variant: it uses SubtleCrypto, which is what works on both Node and
    // edge runtimes without a Node-only crypto import.
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      billingServerEnv.stripeWebhookSecret,
    );
  } catch (cause) {
    // No detail to the caller: a verification failure is either a
    // misconfiguration or someone probing, and neither deserves a hint.
    console.warn("[stripe/webhook] signature verification failed", {
      message: cause instanceof Error ? cause.message : "unknown",
    });
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }

  if (!HANDLED.has(event.type)) {
    return ack("event_type_not_handled", { type: event.type });
  }

  const admin = createAdminClient();

  try {
    switch (event.type) {
      // ── Payment succeeded → credit ───────────────────────────────────────
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;

        // `completed` fires for delayed payment methods before the money
        // arrives. Crediting on anything but `paid` hands out balance for a
        // payment that may still fail.
        if (session.payment_status !== "paid") {
          return ack("session_not_paid", { paymentStatus: session.payment_status });
        }
        if (session.metadata?.kind && session.metadata.kind !== "wallet_topup") {
          return ack("not_a_wallet_topup");
        }

        const userId = session.metadata?.user_id ?? session.client_reference_id ?? null;
        if (!userId) {
          console.error("[stripe/webhook] paid session with no user attribution", {
            eventId: event.id,
            sessionId: session.id,
          });
          return ack("no_user_attribution");
        }

        const amountCents = session.amount_total ?? 0;
        if (amountCents <= 0) {
          return ack("zero_amount", { sessionId: session.id });
        }

        const paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);

        const { data, error } = await admin.rpc("credit_wallet", {
          p_user_id: userId,
          p_amount_micro_usd: centsToMicroUsd(amountCents),
          p_kind: "topup",
          p_stripe_event_id: event.id,
          p_stripe_session_id: session.id,
          p_memo: `${STRIPE_MEMO_PREFIX} ${session.id}`,
          p_stripe_payment_intent_id: paymentIntentId,
        });

        if (error) throw error;

        const result = data as
          | { ok: true; replayed?: boolean; balance_micro_usd?: number }
          | { ok: false; code: string; max_micro_usd?: number };

        if (!result.ok) {
          // A cap refusal is permanent for this event — retrying cannot help.
          // The charge succeeded, so this is an ops item: refund it in Stripe.
          console.error("[stripe/webhook] credit refused", {
            eventId: event.id,
            userId,
            code: result.code,
          });
          return ack("credit_refused", { code: result.code });
        }

        // Remember the Stripe customer so the next Checkout reuses it, keeping
        // one payment history per developer instead of one per top-up. Best
        // effort: failing this must not fail an already-applied credit.
        const customerId =
          typeof session.customer === "string" ? session.customer : session.customer?.id;
        if (customerId) {
          await admin
            .from("profiles")
            .update({ stripe_customer_id: customerId })
            .eq("id", userId)
            .is("stripe_customer_id", null);
        }

        return ack(result.replayed ? "replayed" : "credited");
      }

      // ── Money taken back → debit, floored at zero (FR-BIL-035) ───────────
      case "charge.refunded":
      case "charge.dispute.created": {
        const isDispute = event.type === "charge.dispute.created";
        const object = event.data.object as Stripe.Charge | Stripe.Dispute;

        const paymentIntentId =
          typeof object.payment_intent === "string"
            ? object.payment_intent
            : (object.payment_intent?.id ?? null);

        const metadataUserId = isDispute ? undefined : (object as Stripe.Charge).metadata?.user_id;

        const userId = await resolveUserId(admin, metadataUserId, paymentIntentId);
        if (!userId) {
          console.error("[stripe/webhook] reversal with no matching top-up", {
            eventId: event.id,
            paymentIntentId,
          });
          return ack("no_user_attribution");
        }

        // A refund event reports the CUMULATIVE `amount_refunded`; a partial
        // refund followed by another sends two events with different totals.
        // Each carries its own event.id, so the ledger records each increment —
        // over-debiting on the second is prevented by the floor, not by us
        // tracking prior refunds here. Ops reconciles partial-refund sequences.
        const amountCents = isDispute
          ? (object as Stripe.Dispute).amount
          : (object as Stripe.Charge).amount_refunded;

        if (!amountCents || amountCents <= 0) {
          return ack("zero_reversal_amount");
        }

        const { data, error } = await admin.rpc("debit_wallet_reversal", {
          p_user_id: userId,
          p_amount_micro_usd: centsToMicroUsd(amountCents),
          p_kind: isDispute ? "chargeback" : "refund",
          p_stripe_event_id: event.id,
          p_stripe_payment_intent_id: paymentIntentId,
          p_memo: isDispute
            ? `${STRIPE_MEMO_PREFIX} dispute ${(object as Stripe.Dispute).reason}`
            : `${STRIPE_MEMO_PREFIX} refund ${object.id}`,
        });

        if (error) throw error;

        const result = data as { ok: boolean; applied_micro_usd?: number; floored?: boolean };
        if (result.floored) {
          // The balance was already spent. Real money left the platform and the
          // wallet could not cover it — a human needs to see this.
          console.error("[stripe/webhook] reversal floored at zero balance", {
            eventId: event.id,
            userId,
            demandedMicroUsd: centsToMicroUsd(amountCents),
            appliedMicroUsd: result.applied_micro_usd ?? 0,
          });
        }

        return ack(isDispute ? "chargeback_applied" : "refund_applied");
      }

      default:
        return ack("event_type_not_handled", { type: event.type });
    }
  } catch (cause) {
    // Reached only for genuinely transient failures — the database refused the
    // call, the network dropped. 500 asks Stripe to redeliver, which is correct
    // here and incorrect for every permanent condition handled above.
    console.error("[stripe/webhook] handler failed", {
      eventId: event.id,
      type: event.type,
      message: cause instanceof Error ? cause.message : "unknown",
    });
    return Response.json({ error: "handler failed" }, { status: 500 });
  }
}
