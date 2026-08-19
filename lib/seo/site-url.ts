/**
 * The site's own absolute origin, for metadata that cannot be relative:
 * `metadataBase`, `sitemap.xml`, `robots.txt`, canonical URLs, OG image URLs and
 * JSON-LD `@id`s.
 *
 * WHY THIS IS DERIVED AND NOT AN ENV VAR. `docs/CONTRACTS.md §Environment` is a
 * frozen list and does not contain a site-URL variable. Adding one is a contract
 * change, and it is not needed: the platform deploys on Vercel (`vercel.json`),
 * which injects the origin already. So this reads Vercel's own variables rather
 * than introducing a `NEXT_PUBLIC_SITE_URL` the contract has not agreed to. If a
 * non-Vercel deployment target ever appears, THAT is the moment to amend the
 * contract — not now, silently.
 *
 * The precedence is deliberate:
 *
 *   VERCEL_PROJECT_PRODUCTION_URL — the stable production domain, identical on
 *     every deployment of the project. This is the only value a canonical URL
 *     may be built from.
 *   VERCEL_URL — the per-deployment hostname, different for every preview build.
 *     Correct for a preview to link to itself; catastrophic as a canonical,
 *     which is why it never wins over the line above.
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
