"use client";

import { Button, Chip, ListBox, SearchField, Select } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatContext, priceBandLabel, qualityLabel } from "./format";
import { appHref } from "./routes";
import { catalogHref, withCatalogQuery } from "./search-params";
import type { CatalogQuery, CatalogSort, PriceBand, QualityTier } from "./types";
import { CATALOG_SORTS, PRICE_BANDS, QUALITY_TIERS } from "./types";

/** Debounce for the search box (FR-MKT-003). */
const SEARCH_DEBOUNCE_MS = 300;

/** The rungs offered for "at least this fast". */
const SPEED_STEPS = [20, 40, 60, 90, 120] as const;

/** The rungs offered for "at least this much context". */
const CONTEXT_STEPS = [8_192, 32_768, 128_000, 200_000, 1_000_000] as const;

const SORT_LABEL: Readonly<Record<CatalogSort, string>> = {
  newest: "Newest",
  speed: "Fastest",
  tokens: "Most tokens served",
  price: "Lowest price",
  latency: "Lowest latency",
};

const ANY = "__any__";

type Option = { key: string; label: string };

/**
 * The capability filter rail (FR-MKT-004).
 *
 * Every control writes to the URL and reads back from the `query` prop the
 * server parsed out of it. There is no local copy of the filter state — the URL
 * IS the state, which is what makes a filtered catalog shareable in a Slack
 * message and the back button behave. The one exception is the search box's own
 * text, which needs a local value so typing is not throttled by the network.
 *
 * The rail is capability-shaped on purpose: speed, context, quality, price,
 * creator. There is no hardware facet, because a developer does not choose a
 * GPU — they choose a throughput and a context window (FR-MKT-002).
 */
export function CatalogControls({ query }: { query: CatalogQuery }) {
  const router = useRouter();
  const [text, setText] = useState(query.q);
  const debounce = useRef<number | null>(null);

  const go = useCallback(
    (patch: Partial<CatalogQuery>, replace = false) => {
      const href = appHref(catalogHref(withCatalogQuery(query, patch)));
      // `scroll: false` so changing a filter does not yank the viewport back to
      // the marketing copy above the grid.
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [query, router],
  );

  // The server is the source of truth: a back/forward navigation changes
  // `query.q` under us, and the box has to follow it.
  useEffect(() => {
    setText(query.q);
  }, [query.q]);

  useEffect(() => {
    if (text === query.q) return;
    if (debounce.current !== null) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      // `replace`, not `push`: one history entry per keystroke-pause makes the
      // back button useless. The URL is still complete and shareable, which is
      // what FR-MKT-004 actually requires.
      go({ q: text }, true);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
    };
  }, [text, query.q, go]);

  const speedOptions: Option[] = [
    { key: ANY, label: "Any speed" },
    ...SPEED_STEPS.map((n) => ({ key: String(n), label: `${n}+ tok/s` })),
  ];
  const contextOptions: Option[] = [
    { key: ANY, label: "Any context" },
    ...CONTEXT_STEPS.map((n) => ({
      key: String(n),
      label: `${formatContext(n)}+ context`,
    })),
  ];
  const qualityOptions: Option[] = [
    { key: ANY, label: "Any quality" },
    ...QUALITY_TIERS.map((tier) => ({ key: tier, label: qualityLabel(tier) })),
  ];
  const priceOptions: Option[] = [
    { key: ANY, label: "Any price" },
    ...PRICE_BANDS.map((band) => ({ key: band, label: priceBandLabel(band) })),
  ];
  const sortOptions: Option[] = CATALOG_SORTS.map((sort) => ({
    key: sort,
    label: SORT_LABEL[sort],
  }));

  const active: { label: string; clear: Partial<CatalogQuery> }[] = [];
  if (query.minSpeed != null) {
    active.push({
      label: `${query.minSpeed}+ tok/s`,
      clear: { minSpeed: null },
    });
  }
  if (query.minContext != null) {
    active.push({
      label: `${formatContext(query.minContext)}+ context`,
      clear: { minContext: null },
    });
  }
  if (query.quality) {
    active.push({
      label: qualityLabel(query.quality),
      clear: { quality: null },
    });
  }
  if (query.price) {
    active.push({ label: priceBandLabel(query.price), clear: { price: null } });
  }
  if (query.creator) {
    active.push({ label: `@${query.creator}`, clear: { creator: null } });
  }

  return (
    <section aria-label="Search and filter models" className="flex flex-col gap-3">
      {/* This whole rail lives OUTSIDE the catalog's <Suspense> boundary on
          purpose. Inside it, every debounced keystroke would remount the search
          box as the boundary re-suspends, throwing away the caret and the focus
          ring mid-word. The result count therefore lives with the results, not
          here. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField
          aria-label="Search models by name, slug, description or creator"
          className="sm:max-w-sm"
          fullWidth
          onChange={setText}
          value={text}
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Search models, creators…" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      </div>

      <div className="flex flex-wrap gap-2">
        <FacetSelect
          label="Minimum speed"
          onChange={(key) => go({ minSpeed: key === ANY ? null : Number(key) })}
          options={speedOptions}
          value={query.minSpeed == null ? ANY : String(query.minSpeed)}
        />
        <FacetSelect
          label="Minimum context"
          onChange={(key) => go({ minContext: key === ANY ? null : Number(key) })}
          options={contextOptions}
          value={query.minContext == null ? ANY : String(query.minContext)}
        />
        <FacetSelect
          label="Quality"
          onChange={(key) => go({ quality: key === ANY ? null : (key as QualityTier) })}
          options={qualityOptions}
          value={query.quality ?? ANY}
        />
        <FacetSelect
          label="Price band"
          onChange={(key) => go({ price: key === ANY ? null : (key as PriceBand) })}
          options={priceOptions}
          value={query.price ?? ANY}
        />
        <FacetSelect
          label="Sort by"
          onChange={(key) => go({ sort: key as CatalogSort })}
          options={sortOptions}
          value={query.sort}
        />
      </div>

      {active.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {active.map((item) => (
            <Chip color="accent" key={item.label} variant="soft">
              {item.label}
            </Chip>
          ))}
          <Button onPress={() => go(CLEARED)} size="sm" variant="ghost">
            Clear filters
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Every facet at once — what "Clear filters" writes. Sort and search survive. */
const CLEARED: Partial<CatalogQuery> = {
  minSpeed: null,
  minContext: null,
  quality: null,
  price: null,
  creator: null,
};

function FacetSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <Select
      aria-label={label}
      className="w-auto min-w-40"
      onSelectionChange={(key) => onChange(String(key))}
      selectedKey={value}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        {/* Static children rather than the `items` render-prop form: the option
            lists here are fixed constants, and static collections need no key
            inference. */}
        <ListBox>
          {options.map((option) => (
            <ListBox.Item id={option.key} key={option.key} textValue={option.label}>
              {option.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
