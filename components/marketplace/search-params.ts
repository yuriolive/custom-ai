/**
 * The catalog's query state lives in the URL and nowhere else (FR-MKT-004).
 *
 * That is not a stylistic preference. A filter held in React state is invisible
 * to the back button, cannot be shared in a Slack message, cannot be
 * server-rendered, and cannot be indexed. Round-tripping through the URL costs
 * one navigation and buys all four.
 *
 * Pure module: imported by both the Server Component that reads
 * `searchParams` and the `"use client"` filter rail that writes them.
 */

import type { CatalogQuery, CatalogSort, PriceBand, QualityTier } from "./types";
import { CATALOG_SORTS, PRICE_BANDS, QUALITY_TIERS } from "./types";

export const PAGE_SIZE = 24;

/** Next.js 15 hands `searchParams` as a promise of this shape. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

const DEFAULT_SORT: CatalogSort = "newest";

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function positiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  if (!value) return null;
  return allowed.includes(value as T) ? (value as T) : null;
}

/**
 * Parse a URL into a normalized query.
 *
 * Every unparseable value degrades to "no filter" rather than throwing. A
 * hand-edited or truncated URL must still render the catalog — a 500 on
 * `?speed=abc` is a self-inflicted outage on the front door.
 */
export function parseCatalogQuery(raw: RawSearchParams): CatalogQuery {
  const handle = first(raw.creator)?.trim().toLowerCase() ?? "";

  return {
    q: (first(raw.q) ?? "").trim().slice(0, 120),
    minSpeed: positiveInt(first(raw.speed)),
    minContext: positiveInt(first(raw.ctx)),
    quality: oneOf<QualityTier>(first(raw.quality), QUALITY_TIERS),
    price: oneOf<PriceBand>(first(raw.price), PRICE_BANDS),
    // Handles are `^[a-z0-9][a-z0-9-]{1,38}$` by schema CHECK. Anything else
    // cannot match a row, so it is dropped rather than sent to Postgres.
    creator: /^[a-z0-9][a-z0-9-]{1,38}$/.test(handle) ? handle : null,
    sort: oneOf<CatalogSort>(first(raw.sort), CATALOG_SORTS) ?? DEFAULT_SORT,
    page: positiveInt(first(raw.page)) ?? 1,
  };
}

/**
 * Serialize back to a query string. Defaults are omitted so the canonical
 * catalog URL is a bare `/models` — which is also what belongs in the
 * `<link rel=canonical>`.
 */
export function catalogQueryToSearchParams(query: CatalogQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.minSpeed != null) params.set("speed", String(query.minSpeed));
  if (query.minContext != null) params.set("ctx", String(query.minContext));
  if (query.quality) params.set("quality", query.quality);
  if (query.price) params.set("price", query.price);
  if (query.creator) params.set("creator", query.creator);
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}

/**
 * `/models` when nothing is set, `/models?q=…` otherwise.
 *
 * The default USED TO BE `/`, because the catalog was the front page. It is not
 * any more (docs/UI-REDESIGN-PLAN.md §3) and the default is the whole fix: every
 * facet, every pagination arrow and every "clear filters" link runs through here,
 * so one wrong default would have sent all of them to the landing page — which
 * ignores search params entirely, so the filter would have silently done nothing.
 */
export function catalogHref(query: CatalogQuery, pathname = "/models"): string {
  const qs = catalogQueryToSearchParams(query).toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Apply a partial change. Any change other than paging resets to page 1 —
 * landing on page 4 of a two-page result set is a dead end the user did not ask
 * for.
 */
export function withCatalogQuery(query: CatalogQuery, patch: Partial<CatalogQuery>): CatalogQuery {
  const next = { ...query, ...patch };
  if (patch.page === undefined) next.page = 1;
  return next;
}

/** True when any filter or search term is active — drives the zero-results copy. */
export function hasActiveFilters(query: CatalogQuery): boolean {
  return Boolean(
    query.q ||
    query.minSpeed != null ||
    query.minContext != null ||
    query.quality ||
    query.price ||
    query.creator,
  );
}

export const EMPTY_QUERY: CatalogQuery = {
  q: "",
  minSpeed: null,
  minContext: null,
  quality: null,
  price: null,
  creator: null,
  sort: DEFAULT_SORT,
  page: 1,
};
