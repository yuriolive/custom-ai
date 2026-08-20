import Link from "next/link";

import { categoryLabel } from "./format";
import { appHref } from "./routes";
import { catalogHref, withCatalogQuery } from "./search-params";
import type { CatalogCounts, CatalogQuery, ModelCategory } from "./types";
import { MODEL_CATEGORIES } from "./types";

/**
 * Counted category tabs — `All 42 · Code 11 · Reasoning 8` (UI-REDESIGN-PLAN
 * §2.3, deferred there for want of the `GROUP BY` this issue's RPC now runs).
 *
 * LINKS, NOT TABS, and therefore not a client component. HeroUI v3's `Tabs` is a
 * React Aria tablist whose items are buttons: building this out of it would turn
 * twelve crawlable category URLs into JavaScript handlers on the one surface that
 * has to be indexable, and would put the selected tab in React state instead of
 * in the URL, where every other piece of catalog state lives (FR-MKT-004). The
 * markup is a `<nav>` of anchors with `aria-current`, which is what a set of
 * links that change the page actually is.
 *
 * A TAB ONLY EXISTS WHEN IT HAS ROWS. The counts come back sparse — a category no
 * visible model declares is absent rather than zero — so an empty tab is not
 * rendered at all. A zero tab is a control that is guaranteed to disappoint, and
 * with twelve categories in the vocabulary most of them are empty at MVP-0 scale.
 * The exception is the currently selected tab, which stays visible even at zero:
 * removing the control that is describing the current page leaves no way back.
 *
 * THE COUNTS MATCH THE ROWS. Both come out of one `catalog_grouped` call over one
 * filtered set, so `Code 11` above ten rows is not a state this can reach — see
 * the category CTEs in 20260820001000 for why the two agree by construction
 * rather than by coincidence.
 */
export function CategoryTabs({ query, counts }: { query: CatalogQuery; counts: CatalogCounts }) {
  const tabs = MODEL_CATEGORIES.filter(
    (category) => (counts.categories[category] ?? 0) > 0 || query.category === category,
  );

  // One tab is not a choice. With nothing to switch between, the strip is a label
  // that costs a row of vertical space on every visit.
  if (tabs.length === 0) return null;

  return (
    <nav aria-label="Model categories">
      {/* `overflow-x-auto` on the scroller and `shrink-0` on each pill: twelve
          tabs cannot fit at 375px, and the alternative to a scrolling strip is
          the page itself scrolling sideways. `-mx-1 px-1` keeps the focus ring
          of the first and last pill from being clipped by the scroll box. */}
      <ul className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1 py-1">
        <Tab
          count={counts.all}
          href={hrefFor(query, null)}
          label="All"
          selected={!query.category}
        />
        {tabs.map((category) => (
          <Tab
            count={counts.categories[category] ?? 0}
            href={hrefFor(query, category)}
            key={category}
            label={categoryLabel(category)}
            selected={query.category === category}
          />
        ))}
      </ul>
    </nav>
  );
}

/** Switching tabs resets to page 1, which `withCatalogQuery` already does. */
function hrefFor(query: CatalogQuery, category: ModelCategory | null): string {
  return catalogHref(withCatalogQuery(query, { category }));
}

function Tab({
  href,
  label,
  count,
  selected,
}: {
  href: string;
  label: string;
  count: number;
  selected: boolean;
}) {
  return (
    <li className="shrink-0">
      <Link
        // `aria-current="page"` rather than `aria-selected`: these are links to
        // other URLs, and `aria-selected` outside a real tablist is ignored by
        // screen readers.
        aria-current={selected ? "page" : undefined}
        className={
          selected
            ? "bg-surface-secondary text-foreground border-border-strong focus-visible:ring-accent inline-flex h-8 items-center gap-1.5 rounded-field border px-3 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
            : "text-muted hover:text-foreground hover:bg-surface focus-visible:ring-accent inline-flex h-8 items-center gap-1.5 rounded-field border border-transparent px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        }
        href={appHref(href)}
      >
        {label}
        <span className="text-muted text-xs tabular-nums">{count}</span>
      </Link>
    </li>
  );
}
