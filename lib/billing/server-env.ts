import "server-only";

/**
 * Stripe credentials and the one public URL Checkout redirects back to.
 *
 * `server-only` makes importing this from a `"use client"` module a build
 * error. `STRIPE_SECRET_KEY` can move money and `STRIPE_WEBHOOK_SECRET` is what
 * separates a real Stripe callback from anyone on the internet POSTing a
 * "payment succeeded" body at us — neither may ever carry a NEXT_PUBLIC_ prefix
 * (CONTRACTS.md §Environment), and `npm run check:env` fails the build if one
 * does.
 *
 * Read lazily through getters so a missing variable fails the one request that
 * needs it, with a clear message, instead of the module graph of every page
 * downstream of an import.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

export const billingServerEnv = {
  /** Secret. Never log, never echo into a response body. */
  get stripeSecretKey(): string {
    return required("STRIPE_SECRET_KEY");
  },

  /** Secret. The HMAC key for `Stripe-Signature` verification (FR-BIL-033). */
  get stripeWebhookSecret(): string {
    return required("STRIPE_WEBHOOK_SECRET");
  },

  /**
   * Absolute origin used to build Checkout's `success_url` / `cancel_url`.
   *
   * Prefers an explicit `SITE_URL`, then Vercel's per-deployment
   * `VERCEL_PROJECT_PRODUCTION_URL`, then localhost. Stripe rejects a relative
   * URL, and a wrong one strands a paying developer on someone else's domain,
   * so this returns an origin with no trailing slash and nothing else.
   */
  get siteUrl(): string {
    const explicit = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;
    if (explicit) return explicit.replace(/\/+$/, "");
    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
    return "http://localhost:3000";
  },
} as const;
