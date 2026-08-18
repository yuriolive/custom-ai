import Link from "next/link";

import { appHref } from "./routes";
import { catalogHref, withCatalogQuery } from "./search-params";
import type { CatalogQuery } from "./types";

/**
 * Page navigation for the catalog (FR-MKT-005).
 *
 * Deliberately NOT a HeroUI component, and therefore not a client component:
 * HeroUI v3's `Pagination.Link` is a React Aria `<button>` and takes no `href`,
 * so building this out of it would turn crawlable page links into JavaScript
 * handlers on the one surface that has to be indexable. Plain anchors keep every
 * page of the catalog reachable without JS, and keep this whole component out of
 * the client bundle.
 */
export function CatalogPagination({
  query,
  total,
  pageSize,
}: {
  query: CatalogQuery;
  total: number;
  pageSize: number;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  const page = Math.min(query.page, pageCount);
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const linkClass =
    "border-muted/30 hover:bg-surface inline-flex h-9 items-center rounded-[calc(var(--radius)/1.5)] border px-3 text-sm font-medium";

  return (
    <nav aria-label="Catalog pages" className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted text-sm">
        {first}–{last} of {total}
      </p>

      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            className={linkClass}
            href={appHref(catalogHref(withCatalogQuery(query, { page: page - 1 })))}
            rel="prev"
          >
            ← Previous
          </Link>
        ) : (
          <span aria-disabled="true" className={`${linkClass} text-muted opacity-50`}>
            ← Previous
          </span>
        )}

        <span className="text-muted text-sm tabular-nums">
          Page {page} of {pageCount}
        </span>

        {page < pageCount ? (
          <Link
            className={linkClass}
            href={appHref(catalogHref(withCatalogQuery(query, { page: page + 1 })))}
            rel="next"
          >
            Next →
          </Link>
        ) : (
          <span aria-disabled="true" className={`${linkClass} text-muted opacity-50`}>
            Next →
          </span>
        )}
      </div>
    </nav>
  );
}
