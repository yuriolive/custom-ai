/**
 * The site's own absolute origin, for metadata that cannot be relative:
 * `metadataBase`, `sitemap.xml`, `robots.txt`, canonical URLs, OG image URLs and
 * JSON-LD `@id`s.
 *
 * THE PRECEDENCE MATCHES `lib/billing/server-env.ts`'s `siteUrl`, DELIBERATELY.
 * That getter builds Stripe Checkout's success and cancel URLs from the same
 * notion of "where this site lives", and two answers to that question is a real
 * bug, not a stylistic one: on a custom domain, Stripe would return a paying
 * developer to `example.com` while every canonical tag pointed at
 * `project.vercel.app`, splitting the site in two for both the user and the
 * crawler. The two implementations are kept separate only because the billing
 * one sits on a money path and is not worth churning for a metadata change;
 * they must not be allowed to drift.
 *
 *   SITE_URL — declared in `.env.example` under "server-only, non-secret", read
 *     by the billing helper, and now listed in `docs/CONTRACTS.md §Environment`
 *     alongside the note that these two readers must not drift. Set it for a
 *     custom domain.
 *   VERCEL_PROJECT_PRODUCTION_URL — the stable production domain, identical on
 *     every deployment of the project. Safe for a canonical URL.
 *   VERCEL_URL — the per-deployment hostname, different for every preview build.
 *     Correct for a preview to link to itself; catastrophic as a canonical,
 *     which is why it never wins over the two lines above.
 *   http://localhost:3000 — dev.
 *
 * SERVER-ONLY IN PRACTICE. Neither Vercel variable is `NEXT_PUBLIC_`-prefixed,
 * so in a `"use client"` module both read `undefined` and every caller silently
 * gets the localhost fallback. Call this from server components, route handlers,
 * `generateMetadata`, `sitemap.ts` and `robots.ts` only. It deliberately does
 * not import `server-only`: `next.config.ts` and other build-time config are
 * legitimate callers and are not part of the React server graph.
 */

const DEV_ORIGIN = "http://localhost:3000";

/**
 * Vercel supplies these as bare hostnames — `example.com`, not
 * `https://example.com` — so the scheme has to be added here. Prefixing
 * unconditionally would produce `https://https://…` the day that changes, hence
 * the check.
 */
function withScheme(host: string): string {
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

/** The absolute origin, with no trailing slash. */
export function siteOrigin(): string {
  const host =
    process.env.SITE_URL?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    "";

  const origin = host ? withScheme(host) : DEV_ORIGIN;
  return origin.replace(/\/+$/, "");
}

/** `siteOrigin()` as a `URL`, which is the shape `metadataBase` wants. */
export function siteUrl(): URL {
  return new URL(siteOrigin());
}

/** An absolute URL for a site-relative path. `absoluteUrl("/models")`. */
export function absoluteUrl(path: string): string {
  return new URL(path.startsWith("/") ? path : `/${path}`, `${siteOrigin()}/`).toString();
}
