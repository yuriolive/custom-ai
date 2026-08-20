import type { NextConfig } from "next";

/**
 * The search-param keys `components/marketplace/search-params.ts` reads.
 *
 * Kept as a literal list rather than imported from that module: `next.config.ts`
 * is loaded by the Next CLI outside the app's module graph and outside its path
 * aliases, so an `@/components/…` import here fails at config load — before any
 * of the error reporting that would tell you why.
 *
 * If a facet is added there and not here, the only consequence is that one old
 * `/?newfacet=…` URL 200s on the landing page instead of redirecting. Add it
 * anyway.
 */
const CATALOG_PARAMS = ["q", "speed", "ctx", "quality", "price", "creator", "sort", "page"];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The scaffold owns only app/, components/ and lib/. Other agents own
  // packages/, tools/, supabase/ and tests/ — keep the Next build out of them.
  outputFileTracingExcludes: {
    "*": ["./packages/**", "./tools/**", "./supabase/**", "./tests/**"],
  },
  eslint: {
    dirs: ["app", "components", "lib"],
  },
  typedRoutes: true,

  /**
   * `/` was the catalog until the landing-page split (docs/UI-REDESIGN-PLAN.md
   * §3). Any shared or indexed `/?q=…` URL now lands on a page that ignores
   * search params entirely — which reads as "the filter is broken", not as "the
   * URL moved". These send it to `/models`.
   *
   * ONE RULE PER PARAM, because `has` entries are ANDed: a single rule listing
   * all eight would only fire on a URL carrying all eight at once. The
   * destination carries no query of its own, so Next forwards the original
   * query string intact — `/?quality=full&sort=speed` arrives at
   * `/models?quality=full&sort=speed`, not at a bare `/models` with the facets
   * dropped.
   *
   * A bare `/` matches none of these and renders the landing page, which is the
   * point.
   */
  async redirects() {
    return CATALOG_PARAMS.map((key) => ({
      source: "/",
      has: [{ type: "query" as const, key }],
      destination: "/models",
      permanent: true,
    }));
  },
};

export default nextConfig;
