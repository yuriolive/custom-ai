import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";

/**
 * The catalog shell — `/models` and `/models/[creator]/[slug]`.
 *
 * Same nav and footer as `(marketing)`; the only difference is the container,
 * and that difference is the point of having two groups instead of one. A
 * visitor reading the landing page is being sold to and the sections are
 * full-bleed; a visitor on the catalog is scanning a list and wants a measure
 * they can track. `max-w-7xl` rather than the landing's `max-w-6xl` because a
 * facet rail plus a card grid needs the extra column (UI-REDESIGN-PLAN.md §6).
 */
export default function CatalogLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <MarketingNav />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-10 sm:px-6">{children}</main>
      <MarketingFooter />
    </div>
  );
}
