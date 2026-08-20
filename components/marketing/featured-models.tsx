import Link from "next/link";

import { CatalogGrid } from "@/components/marketplace/catalog-grid";
import type { CatalogGroup } from "@/components/marketplace/types";

import { Section } from "./section";

/**
 * Section 5 — featured models (docs/UI-REDESIGN-PLAN.md §4).
 *
 * The real `GroupCard`, not a marketing lookalike. Three of them, live from the
 * catalog, over a link into the full list. It sells the supply side and doubles
 * as the catalog's entry point — and because it is the same component the catalog
 * renders, a card that regresses regresses in both places at once instead of
 * only in the place nobody checks.
 *
 * A CARD IS A MODEL HERE TOO (#26). Three cards used to be three deployments, so
 * this section could show the same model three times over — a landing page whose
 * whole point is "look how much is here" advertising one model as its entire
 * inventory. `total` is now a count of models, which is also what the hero's
 * "N models" claims.
 *
 * WITH NO PUBLIC MODELS, THIS SECTION RENDERS NOTHING. That is the state
 * production is in today (`docs/ROADMAP.md`, "what deployed does not yet mean"),
 * and it took two passes to get right:
 *
 *  - Placeholder or "coming soon" cards are out. A landing page that fakes
 *    inventory is the fastest way to lose a developer who then searches for one
 *    of the invented names.
 *  - An honest empty state is ALSO out, and the owner ruled on it directly: a
 *    section headed "Be the first model in the catalog" announces "we have
 *    nothing" in the middle of the pitch. Being accurate about it does not make
 *    it a good thing to put in front of a first-time visitor.
 *
 * So the section is absent, not empty. The creator pitch it used to carry is not
 * lost — `ForCreators` (§6) makes it two sections further down, where it is
 * addressed to a creator on purpose rather than as an apology for a missing grid.
 * Returning `null` from a section is the honest option here: no claim, no
 * apology, and the section reappears on its own the moment a model is published.
 */
export function FeaturedModels({
  groups,
  total,
  baseUrl,
}: Readonly<{ groups: CatalogGroup[]; total: number; baseUrl: string }>) {
  if (groups.length === 0) return null;

  return (
    <Section
      eyebrow="The catalog"
      id="models"
      lede="Every card carries measured throughput, the context window, the quality level and both token prices — and the snippet that calls it."
      title="Models people have already shipped"
    >
      <div className="flex flex-col gap-6">
        <CatalogGrid baseUrl={baseUrl} groups={groups} />
        <Link
          className="text-foreground hover:text-accent focus-visible:ring-accent self-start rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          href="/models"
        >
          {total > groups.length ? `Browse all ${total} models →` : "Browse the catalog →"}
        </Link>
      </div>
    </Section>
  );
}
