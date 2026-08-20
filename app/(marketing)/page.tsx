import type { Metadata } from "next";

import { ClosingCta } from "@/components/marketing/closing-cta";
import { ColdStart } from "@/components/marketing/cold-start";
import { FeaturedModels } from "@/components/marketing/featured-models";
import { ForCreators } from "@/components/marketing/for-creators";
import { Hero } from "@/components/marketing/hero";
import { ProofStrip } from "@/components/marketing/proof-strip";
import { Quickstart } from "@/components/marketing/quickstart";
import { MarketingContainer } from "@/components/marketing/section";
import { fetchCatalogPage } from "@/components/marketplace/queries";
import { EMPTY_QUERY } from "@/components/marketplace/search-params";
import { gatewayBaseUrl } from "@/components/marketplace/snippets";
import { publicEnv } from "@/lib/public-env";
import { SUPABASE_URL } from "@/lib/supabase/public-config";
import { createClient } from "@/lib/supabase/server";

/**
 * Never prerendered. `MarketingNav` reads the session cookie and this page
 * queries Postgres for the model count, so it is per-request either way — and
 * marking it explicitly stops `next build` from attempting a prerender that
 * would need a reachable database at BUILD time. Without this, a build against
 * an unreachable Supabase fails page-data collection with a minified
 * `TypeError` that points nowhere near the real cause.
 */
export const dynamic = "force-dynamic";

/**
 * The landing page (docs/UI-REDESIGN-PLAN.md §4).
 *
 * `/` USED TO BE THE CATALOG, with four paragraphs of onboarding and a
 * full-width amber warning banner stacked above the grid. That page was doing
 * two jobs badly: explaining the product to someone who had never heard of it,
 * and letting a returning developer filter a list. The catalog is now `/models`
 * and this page sells.
 *
 * THE SECTION RHYTHM IS THE DESIGN. Every section below is
 * `display h2 → one muted sentence → a product artifact`, in that order, via the
 * `Section` primitive — measured off resend.com. A page where each section
 * announces itself the same way reads as one document; a page where each invents
 * its own header reads as a template. The one deliberate break is `ClosingCta`,
 * which is centred, and that break is what marks the end.
 *
 * NOTHING HERE IS A CLAIM WE CANNOT BACK. Every figure on the proof strip is
 * measured (`docs/HANDOFF.md`) or contractual (the 80/20 split the schema
 * enforces); the model count is real or the copy goes generic; the featured grid
 * renders live rows or makes the creator pitch instead of showing placeholder
 * cards. Tool calling is a roadmap item and is named as one.
 *
 * ONE `await`, DEGRADING. `fetchCatalogPage` catches its own errors and returns
 * an empty page rather than throwing (see its comment), so the front door
 * survives Supabase being briefly unreachable — it renders the zero-models
 * branch instead of a 500.
 */

const TITLE = "Serverless inference marketplace — open models, per-token pricing";
const DESCRIPTION =
  "Call open Hugging Face models — quantized, uncensored, fine-tuned — through one " +
  "OpenAI-compatible endpoint. Per-token pricing, no hourly GPU bill. Models scale to " +
  "zero, so a first request can take up to two minutes while a worker starts.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
  },
};

/** How many live cards the featured section shows. Three fits the grid exactly. */
const FEATURED_COUNT = 3;

export default async function LandingPage() {
  const baseUrl = gatewayBaseUrl(SUPABASE_URL);

  const supabase = await createClient();
  // `EMPTY_QUERY` sorts by newest and asks for an exact count, so this one read
  // answers both questions the page has: how many public models exist, and which
  // three to show. A separate count query would be a second round trip for a
  // number this result already carries.
  const catalog = await fetchCatalogPage(supabase, EMPTY_QUERY);
  const featured = catalog.models.slice(0, FEATURED_COUNT);

  // The snippet has to name a model, and it should name a real one. Falling back
  // to `NEXT_PUBLIC_DEFAULT_MODEL` LOWERCASED: platform ids are lowercase by
  // schema CHECK, while that variable holds the Hugging Face casing. Both
  // resolve — `resolve.ts` lowercases each half — but rendering the HF casing
  // here would teach a visitor an id shape that only works by coincidence
  // (UI-REDESIGN-PLAN.md §1.1, L6).
  const snippetModelId = featured[0]?.modelId ?? publicEnv.defaultModel.toLowerCase();

  return (
    <>
      <Hero baseUrl={baseUrl} modelCount={catalog.total} />

      <ProofStrip />

      {/* The sections share one container so their headers line up with the
          hero's left edge. The container is here rather than inside each section
          because `Section` owns vertical rhythm and nothing else — giving it a
          width would make every future section re-decide the page's measure. */}
      <MarketingContainer>
        <Quickstart baseUrl={baseUrl} modelId={snippetModelId} />
        <ColdStart />
        <FeaturedModels baseUrl={baseUrl} models={featured} total={catalog.total} />
        <ForCreators />
      </MarketingContainer>

      <ClosingCta />
    </>
  );
}
