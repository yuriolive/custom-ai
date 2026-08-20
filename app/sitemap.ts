import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { MetadataRoute } from "next";

import { fetchSitemapModels } from "@/components/marketplace/queries";
import { modelHref } from "@/components/marketplace/routes";
import { absoluteUrl } from "@/lib/seo/site-url";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/public-config";

/**
 * Never prerendered, for the same reason `app/page.tsx` is not: this reads
 * Postgres, and `next build` collecting page data against an unreachable
 * Supabase fails the build with an error that points nowhere near the cause.
 * There is a second, sitemap-specific reason on top of that one — a sitemap
 * baked at build time freezes the model list until the next deploy, so every
 * model published between deploys would be invisible to crawlers precisely
 * while it is newest. Sitemaps are fetched a handful of times a day; one
 * indexed query per fetch is not a load problem worth caching around.
 */
export const dynamic = "force-dynamic";

/**
 * `/sitemap.xml` — the public URL set.
 *
 * WHAT IS IN IT, AND WHAT IS NOT. A sitemap is a list of canonical URLs that
 * return 200 to an anonymous visitor. Four of this app's routes fail that test
 * and are excluded deliberately:
 *
 *   /models      308s to `/` (see `app/models/page.tsx` — the catalog lives at
 *                one URL on purpose). Listing a redirect asks a crawler to
 *                rediscover the destination that is already on the list.
 *   /playground  Session-only; an anonymous fetch redirects to `/login`.
 *   /login       Robots-disallowed above, and `?next=` makes it an unbounded
 *                set of identical pages.
 *   /console/**, /studio/**   Session-only, and per-user besides.
 *
 * That leaves `/`, `/pricing`, the two `/legal` pages and `/signup` as the
 * static entries, plus one URL per public model — which is the set that actually
 * earns traffic (FR-MKT-007: the model page is the addressable artifact).
 *
 * THIS LIST IS HAND-MAINTAINED and nothing fails when it falls behind: a public
 * route missing from here is simply never announced, and the omission is
 * invisible from inside the app. `/pricing` was missed exactly that way. When a
 * public route lands, it is added here in the same change.
 *
 * `changeFrequency` and `priority` are omitted throughout. Google has said for
 * years that it ignores both, and a fabricated `weekly` on a page that changes
 * hourly is worse than saying nothing. `lastModified` is the one hint that is
 * still read, so it is the one this file takes care to get honestly right.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const models = await readModels();

  // The home page IS the catalog, so its freshness is the freshness of the
  // newest model. Rows arrive newest-updated-first, so index 0 is the max — no
  // sort needed. Stamping `new Date()` here instead would claim the front page
  // changed on every crawl, which is both false and self-defeating: a
  // `lastModified` that is always "now" carries no information and gets
  // discounted.
  const catalogUpdatedAt = models[0]?.updatedAt;

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: absoluteUrl("/"),
      ...(catalogUpdatedAt ? { lastModified: new Date(catalogUpdatedAt) } : {}),
    },
    // No `lastModified` on either of these: they are hand-written copy whose
    // real change date is a deploy this route has no access to. Omitting the
    // field is a valid sitemap and an honest one.
    { url: absoluteUrl("/pricing") },
    { url: absoluteUrl("/legal/acceptable-use") },
    { url: absoluteUrl("/legal/terms") },
    { url: absoluteUrl("/signup") },
  ];

  return [
    ...staticRoutes,
    ...models.map((model) => ({
      url: absoluteUrl(modelHref(model.creatorHandle, model.slug)),
      lastModified: new Date(model.updatedAt),
    })),
  ];
}

/**
 * The model rows, or `[]` if the database is unreachable.
 *
 * DEGRADE, DO NOT FAIL. `fetchSitemapModels` already swallows a PostgREST
 * error, but a DNS or TLS failure can reject the promise outright, and an
 * unhandled rejection here would serve a 500 for `/sitemap.xml`. A crawler that
 * gets a 500 may drop the sitemap from its schedule; a crawler that gets a
 * sitemap containing only `/` and `/signup` re-walks the catalog from the front
 * page and loses nothing permanent. `fetchCatalogPage` takes the same stance
 * for the same reason — a brief Supabase outage must not take the public
 * surface down with it.
 */
async function readModels() {
  try {
    return await fetchSitemapModels(anonClient());
  } catch (error) {
    console.error("sitemap model read threw", {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * A cookie-less anon client, NOT `lib/supabase/server`'s `createClient()`.
 *
 * A sitemap is a property of the site, not of whoever fetched it: a cookie-bound
 * client would make the file's contents vary by viewer, which is incoherent for
 * a document crawlers cache and compare across fetches.
 *
 * It is also the outer half of a two-layer guard. `custom_models` has TWO select
 * policies and Postgres ORs them, so for an authenticated owner
 * `custom_models_select_own` admits their drafts in any status — reading this
 * file through a session could publish private model ids. `fetchSitemapModels`
 * writes the explicit public predicates as well, so neither layer is alone in
 * holding that line.
 *
 * A fresh client per request, never a module-scope singleton, matching
 * `createAdminClient()`.
 */
function anonClient() {
  return createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
