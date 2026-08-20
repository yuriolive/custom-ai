import type { Metadata } from "next";

/**
 * The catalog is never prerendered. It reads cookies (for the signed-in nav) and
 * queries Postgres, so it is inherently per-request — and marking it explicitly
 * stops `next build` from attempting a prerender that would need a reachable
 * database at BUILD time. Without this, a build against an unreachable Supabase
 * fails page-data collection with a minified `TypeError` that points nowhere
 * near the real cause.
 */
export const dynamic = "force-dynamic";
import { Suspense } from "react";

import { CatalogControls } from "@/components/marketplace/catalog-controls";
import { CatalogEmpty, CatalogGrid } from "@/components/marketplace/catalog-grid";
import { CatalogPagination } from "@/components/marketplace/catalog-pagination";
import { CatalogSkeleton } from "@/components/marketplace/catalog-skeleton";
import { fetchCatalogPage } from "@/components/marketplace/queries";
import type { RawSearchParams } from "@/components/marketplace/search-params";
import {
  catalogHref,
  hasActiveFilters,
  parseCatalogQuery,
} from "@/components/marketplace/search-params";
import { gatewayBaseUrl } from "@/components/marketplace/snippets";
import type { CatalogQuery } from "@/components/marketplace/types";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { SUPABASE_URL } from "@/lib/supabase/public-config";
import { createClient } from "@/lib/supabase/server";

/**
 * The public marketplace (FR-MKT-001 … 011).
 *
 * MOVED OFF `/` in the landing-page refresh (docs/UI-REDESIGN-PLAN.md §3). The
 * catalog and the landing page were the same URL, which forced one page to both
 * explain the product to a first-time visitor and let a returning developer scan
 * a list — so it opened with four paragraphs and a full-width warning banner
 * above the grid. They are two jobs and they are now two routes; `/` sells, this
 * page filters, and `next.config.ts` redirects any indexed `/?q=…` here.
 *
 * A SERVER COMPONENT, and that is the whole architecture of this page. HeroUI v3
 * is client-only (PRD §4.1.0), so the composition is: fetch here, where the
 * Supabase client and the cookie live, then hand plain serializable props to
 * client components that render the HeroUI tree. Next still renders those to HTML
 * on the server, so the catalog is fully indexable — FR-MKT-006 is satisfied by
 * the split, not weakened by it.
 *
 * The page is readable SIGNED OUT: `createClient()` produces an anon-key client
 * when there is no session, and RLS answers with public+ready rows only.
 */

const TITLE = "Model catalog — open models, per-token pricing";
const DESCRIPTION =
  "Browse open Hugging Face models — quantized, uncensored, fine-tuned — callable through " +
  "one OpenAI-compatible endpoint. Filter by measured speed, context window, quality and " +
  "price. Models scale to zero, so a first request can take up to two minutes and warm " +
  "calls answer instantly.";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<Metadata> {
  const query = parseCatalogQuery(await searchParams);
  const filtered = hasActiveFilters(query) || query.page > 1;

  return {
    title: TITLE,
    description: DESCRIPTION,
    // A filtered view is the same catalog sliced differently, so it points at
    // `/models` as canonical and is kept out of the index. Without this, every
    // shareable filter URL becomes a near-duplicate competing with the catalog
    // front page — and `follow` still lets a crawler walk through to the model
    // pages, which are the URLs actually worth ranking.
    alternates: { canonical: "/models" },
    robots: filtered ? { index: false, follow: true } : undefined,
    openGraph: pageOpenGraph({ title: TITLE, description: DESCRIPTION, path: "/models" }),
  };
}

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const query = parseCatalogQuery(await searchParams);
  const baseUrl = gatewayBaseUrl(SUPABASE_URL);

  return (
    <div className="flex flex-col gap-8">
      {/* The page head orcarouter.ai uses: the noun, then one line that says
          what the list is and what it costs to use. It replaces the four
          paragraphs of onboarding that used to sit here — that copy did not
          disappear, it moved to `/`, where a first-time visitor actually is. */}
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl leading-[1.15] font-semibold tracking-[-0.03em]">Models</h1>
        <p className="text-muted text-base">
          Every model here is deployed by its creator and callable at{" "}
          <code className="text-foreground text-sm">POST /v1/chat/completions</code>. One key, one
          prepaid balance, per-token pricing.
        </p>
      </div>

      <section aria-labelledby="catalog" className="flex flex-col gap-5">
        <h2 className="sr-only" id="catalog">
          Catalog
        </h2>

        <CatalogControls query={query} />

        {/* Keyed on the full query so a filter change re-suspends and shows
            skeleton cards (FR-MKT-005) instead of stale results with no
            indication that anything is in flight. */}
        <Suspense fallback={<CatalogSkeleton />} key={catalogHref(query)}>
          <CatalogResults baseUrl={baseUrl} query={query} />
        </Suspense>
      </section>
    </div>
  );
}

/**
 * The data-fetching half. Separated from `ModelsPage` so the `<Suspense>`
 * boundary has something to suspend on: an `async` component below the boundary
 * streams, whereas an `await` in the page body would block the whole document.
 */
async function CatalogResults({ query, baseUrl }: { query: CatalogQuery; baseUrl: string }) {
  const supabase = await createClient();
  const page = await fetchCatalogPage(supabase, query);

  if (page.models.length === 0) {
    return <CatalogEmpty catalogIsEmpty={page.catalogIsEmpty} query={query} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted text-sm" role="status">
        {page.total === 1 ? "1 model" : `${page.total} models`}
      </p>
      <CatalogGrid baseUrl={baseUrl} models={page.models} />
      <CatalogPagination pageSize={page.pageSize} query={query} total={page.total} />
    </div>
  );
}
