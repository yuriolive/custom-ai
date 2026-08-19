/**
 * POST /api/wallet/topup — create one Stripe Checkout Session (FR-BIL-030/031).
 *
 * WHAT THIS ROUTE DOES NOT DO: credit anything. It creates a hosted Checkout
 * Session and returns its URL. The wallet moves in `POST /api/stripe/webhook`
 * and nowhere else (FR-BIL-032). A developer who replays this endpoint, edits
 * the returned URL, or lands on the success page without paying gets exactly
 * zero micro-USD.
 *
 * PCI SCOPE. Card data never touches this deployment — the browser is redirected
 * to Stripe's own page, which keeps the platform in SAQ-A (FR-BIL-030). That is
 * why there is no card field anywhere in this codebase and must not be one.
 *
 * The user id comes from the verified session cookie, never from the body. The
 * body carries an amount and nothing else; a `user_id` there would be a
 * straight account-funding-attribution bug at best.
 */

import { billingServerEnv } from "@/lib/billing/server-env";
import { createStripeClient, STRIPE_MEMO_PREFIX } from "@/lib/billing/stripe";
import {
  exceedsMaxBalance,
  formatUsdFromMicro,
  microUsdToCents,
  validateTopupAmount,
} from "@/lib/billing/amounts";
import { createClient } from "@/lib/supabase/server";

/** Node, not edge: the Stripe SDK expects Node crypto and streams. */
export const runtime = "nodejs";
/** Reads a session cookie and calls a payment API — never prerender, never cache. */
export const dynamic = "force-dynamic";

type ErrorCode =
  | "unauthenticated"
  | "invalid_request_body"
  | "invalid_amount"
  | "max_balance_exceeded"
  | "account_suspended"
  | "checkout_failed"
  | "internal_error";

/** Same envelope the gateway, playground proxy and keys route use. */
function errorResponse(status: number, code: ErrorCode, message: string) {
  return Response.json(
    { error: { message, type: "invalid_request_error", param: null, code } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  // ── 1. Session ────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return errorResponse(401, "unauthenticated", "Sign in to add funds.");
  }

  // ── 2. Amount. Validated by the same function the modal uses. ─────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request_body", "Body must be JSON.");
  }
  const rawAmount =
    typeof body === "object" && body !== null && "amountUsd" in body
      ? String((body as { amountUsd: unknown }).amountUsd ?? "")
      : "";

  const amount = validateTopupAmount(rawAmount);
  if (!amount.ok) {
    return errorResponse(400, "invalid_amount", amount.message);
  }

  // ── 3. Account state. Read under RLS as the user — this is their own row. ─
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("balance_micro_usd, max_balance_micro_usd, is_suspended, stripe_customer_id")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return errorResponse(500, "internal_error", "Could not read your account.");
  }
  if (profile.is_suspended) {
    return errorResponse(
      403,
      "account_suspended",
      "This account is suspended. Contact support before adding funds.",
    );
  }

  // Pre-flight only. `credit_wallet` re-checks the cap at credit time, because
  // the balance can move between this check and the webhook, and the RPC is the
  // authority (FR-BIL-036).
  if (
    exceedsMaxBalance(
      profile.balance_micro_usd,
      amount.microUsd,
      profile.max_balance_micro_usd,
    )
  ) {
    return errorResponse(
      400,
      "max_balance_exceeded",
      `That would put your balance over the ${formatUsdFromMicro(
        profile.max_balance_micro_usd,
      )} account cap. Spend down or top up a smaller amount.`,
    );
  }

  // ── 4. Checkout Session ──────────────────────────────────────────────────
  try {
    const stripe = createStripeClient();
    const origin = billingServerEnv.siteUrl;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // `client_reference_id` AND `metadata.user_id` (FR-BIL-031). Belt and
      // braces: the webhook reads metadata first and falls back to the
      // reference, because the two are populated by different Stripe flows and
      // a session that arrives with neither must be dropped, not guessed at.
      client_reference_id: user.id,
      metadata: { user_id: user.id, kind: "wallet_topup" },
      payment_intent_data: {
        metadata: { user_id: user.id, kind: "wallet_topup" },
        description: `${STRIPE_MEMO_PREFIX} — wallet top-up`,
      },
      ...(profile.stripe_customer_id
        ? { customer: profile.stripe_customer_id }
        : { customer_email: user.email ?? undefined, customer_creation: "always" as const }),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: microUsdToCents(amount.microUsd),
            product_data: {
              name: "Nexus Inference wallet credit",
              description:
                "Prepaid balance for API and Playground usage. Non-transferable.",
            },
          },
        },
      ],
      // The success page is a UI hint, never proof of payment (FR-BIL-032). It
      // polls the balance; the webhook is what moved it.
      success_url: `${origin}/console/wallet?topup=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/console/wallet?topup=cancelled`,
      // Checkout Sessions expire in 24h by default; 30 minutes keeps an
      // abandoned tab from resurrecting a stale price hours later.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    if (!session.url) {
      return errorResponse(502, "checkout_failed", "Stripe did not return a checkout URL.");
    }

    return Response.json(
      { url: session.url, sessionId: session.id },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    // Deliberately generic to the client: a Stripe error message can carry
    // account identifiers. The detail goes to the server log only, and never
    // includes the secret key (the SDK redacts it, and we do not echo it).
    console.error("[wallet/topup] checkout session creation failed", {
      userId: user.id,
      message: cause instanceof Error ? cause.message : "unknown",
    });
    return errorResponse(502, "checkout_failed", "Could not start checkout. Try again.");
  }
}
