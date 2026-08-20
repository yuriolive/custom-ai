import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/seo/site-url";

/**
 * `/robots.txt`.
 *
 * The rule of thumb everywhere below: `Disallow` is a *crawl* instruction, not a
 * privacy control and not an index control. Nothing here is what keeps
 * `/console` or `/api` safe — RLS, the middleware route table and per-route auth
 * do that. This file exists so a crawler spends its budget on the pages that can
 * actually rank, and so the URLs it does fetch return 200 instead of a redirect
 * to `/login`.
 *
 * Every disallowed prefix is one a crawler can reach but can never usefully
 * render:
 *
 *   /console, /studio, /playground  Session-only (`PROTECTED_PREFIXES` in
 *       `lib/supabase/middleware.ts`). An anonymous fetch 307s to `/login?next=…`,
 *       so crawling them produces nothing but login-page duplicates.
 *   /api                            Route handlers. JSON, POST-shaped, and in
 *       `/api/stripe/webhook`'s case signature-gated — never a document.
 *   /auth                           The OAuth/PKCE callback and email-confirm
 *       handlers. These consume one-time codes; a crawler fetching them burns a
 *       real user's token exchange.
 *   /login                          No unique content, and `?next=` gives it an
 *       unbounded parameter space — one crawlable URL per protected page on the
 *       site, all rendering the same form.
 *
 * `/signup` is deliberately NOT disallowed: it is a genuine public entry point
 * with its own copy, and it is in the sitemap.
 *
 * Trailing-slash-free prefixes are intentional. `Disallow: /api` also blocks
 * `/api-something`; there is no such route and never should be, whereas
 * `Disallow: /api/` would leave a bare `/api` crawlable.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/console", "/studio", "/playground", "/api", "/auth", "/login"],
    },
    // Absolute by specification: a `Sitemap:` line is the one part of
    // robots.txt that a relative path is invalid in.
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
