import "server-only";

import Stripe from "stripe";

import { billingServerEnv } from "./server-env";

/**
 * The Stripe client, built per call from the lazily-read secret.
 *
 * No module-scope singleton on purpose: constructing one at import time turns a
 * missing `STRIPE_SECRET_KEY` into a build-time crash for every page that
 * transitively imports this file, rather than a clear 500 on the two routes
 * that actually need Stripe.
 *
 * `apiVersion` is left at the SDK default so the pinned version travels with the
 * `stripe` dependency in package.json — one place to review when upgrading,
 * instead of a string here that silently disagrees with the types.
 */
export function createStripeClient(): Stripe {
  return new Stripe(billingServerEnv.stripeSecretKey, {
    // Identifies this integration in Stripe's own logs, which is the difference
    // between "some server" and "the wallet route" when reading a failed charge.
    appInfo: { name: "nexus-inference-wallet", version: "0.1.0" },
    maxNetworkRetries: 2,
  });
}

/** Ledger memo prefix, so a human reading wallet_ledger knows the rail. */
export const STRIPE_MEMO_PREFIX = "Stripe Checkout";
