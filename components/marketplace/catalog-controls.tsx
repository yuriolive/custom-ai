"use client";

import {
  Button,
  Chip,
  Disclosure,
  Drawer,
  Label,
  ListBox,
  Radio,
  RadioGroup,
  SearchField,
  Select,
} from "@heroui/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatContext, priceBandLabel, qualityLabel, qualityNote } from "./format";
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

type Option = { key: string; label: string; note?: string };

/** The eyebrow role, used for every facet heading and the sort label. */
const EYEBROW = "text-muted text-[0.6875rem] font-medium tracking-[0.08em] uppercase";

/**
 * Navigate by rewriting the URL.
 *
 * THE URL IS THE STATE. There is no local copy of the filter state anywhere in
 * this file except the search box's own text, which needs one so typing is not
 * throttled by the network. Everything else reads from the `query` prop the
 * server parsed out of the URL and writes back through `withCatalogQuery` /
 * `catalogHref`, which is what makes a filtered catalog shareable in a Slack
 * message and the back button behave (FR-MKT-004).
 */
function useCatalogNav(query: CatalogQuery) {
  const router = useRouter();

  return useCallback(
    (patch: Partial<CatalogQuery>, replace = false) => {
      const href = appHref(catalogHref(withCatalogQuery(query, patch)));
      // `scroll: false` so changing a filter does not yank the viewport back to
      // the marketing copy above the grid.
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [query, router],
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

/** The active facets, in rail order. Drives the drawer's `Filters (N)` count. */
function activeFacets(query: CatalogQuery): { label: string }[] {
  const active: { label: string }[] = [];
  if (query.minSpeed != null) active.push({ label: `${query.minSpeed}+ tok/s` });
  if (query.minContext != null) {
    active.push({ label: `${formatContext(query.minContext)}+ context` });
  }
  if (query.quality) active.push({ label: qualityLabel(query.quality) });
  if (query.price) active.push({ label: priceBandLabel(query.price) });
  if (query.creator) active.push({ label: `@${query.creator}` });
  return active;
}

/**
 * The capability filter rail (FR-MKT-004, UI-REDESIGN-PLAN §6).
 *
 * Five `Disclosure` groups opening to `Radio` rows, not five `Select` popovers.
 * The difference is that the whole facet is visible at once: a popover shows the
 * one value you already chose and hides the five you are choosing between, which
 * is exactly backwards for a discovery surface where the rungs themselves are
 * the information ("does anything here even do 120 tok/s?").
 *
 * Exported so a future two-column page layout can place it directly in a
 * `grid lg:grid-cols-[220px_1fr]` without going through `CatalogControls`.
 *
 * The rail is capability-shaped on purpose: speed, context, quality, price,
 * creator. There is no hardware facet, because a developer does not choose a
 * GPU — they choose a throughput and a context window (FR-MKT-002).
 */
export function CatalogFacetRail({
  query,
  creators = [],
}: {
  query: CatalogQuery;
  /**
   * Creator handles present in the catalog. The Creator facet only appears when
   * there is more than one to choose between — a single-option filter is a
   * control that cannot change anything.
   */
  creators?: readonly string[];
}) {
  const go = useCatalogNav(query);
  const active = activeFacets(query);

  const speedOptions: Option[] = [
    { key: ANY, label: "Any speed" },
    ...SPEED_STEPS.map((n) => ({ key: String(n), label: `${n}+ tok/s` })),
  ];
  const contextOptions: Option[] = [
    { key: ANY, label: "Any context" },
    ...CONTEXT_STEPS.map((n) => ({ key: String(n), label: `${formatContext(n)}+` })),
  ];
  const qualityOptions: Option[] = [
    { key: ANY, label: "Any quality" },
    ...QUALITY_TIERS.map((tier) => ({
      key: tier,
      label: qualityLabel(tier),
      // `full` is the one rung whose name does not explain itself — "Full
      // precision" reads as marketing unless it says what it costs and does
      // not cost. The rest of the ladder is self-describing at this size.
      note: tier === "full" ? qualityNote(tier) : undefined,
    })),
  ];
  const priceOptions: Option[] = [
    { key: ANY, label: "Any price" },
    ...PRICE_BANDS.map((band) => ({ key: band, label: priceBandLabel(band) })),
  ];
  const creatorOptions: Option[] = [
    { key: ANY, label: "Any creator" },
    ...creators.map((handle) => ({ key: handle, label: `@${handle}` })),
  ];

  // Shown when there is a real choice, and also when a creator filter is already
  // set — otherwise an active facet would have no control to clear it from.
  const showCreator = creators.length > 1 || query.creator != null;

  return (
    <div className="flex flex-col gap-1">
      <Facet
        label="Speed"
        onChange={(key) => go({ minSpeed: key === ANY ? null : Number(key) })}
        options={speedOptions}
        value={query.minSpeed == null ? ANY : String(query.minSpeed)}
      />
      <Facet
        label="Context"
        onChange={(key) => go({ minContext: key === ANY ? null : Number(key) })}
        options={contextOptions}
        value={query.minContext == null ? ANY : String(query.minContext)}
      />
      <Facet
        label="Quality"
        onChange={(key) => go({ quality: key === ANY ? null : (key as QualityTier) })}
        options={qualityOptions}
        value={query.quality ?? ANY}
      />
      <Facet
        label="Price"
        onChange={(key) => go({ price: key === ANY ? null : (key as PriceBand) })}
        options={priceOptions}
        value={query.price ?? ANY}
      />
      {showCreator ? (
        <Facet
          label="Creator"
          onChange={(key) => go({ creator: key === ANY ? null : key })}
          options={creatorOptions}
          value={query.creator ?? ANY}
        />
      ) : null}

      {active.length > 0 ? (
        <div className="pt-2">
          <Button onPress={() => go(CLEARED)} size="sm" variant="ghost">
            Clear filters
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Search, sort, and the rail — the default composition, so the page keeps
 * working unchanged while the two-column layout is built elsewhere.
 *
 * THIS WHOLE THING LIVES OUTSIDE THE CATALOG'S `<Suspense>` BOUNDARY on purpose.
 * Inside it, every debounced keystroke would remount the search box as the
 * boundary re-suspends, throwing away the caret and the focus ring mid-word.
 * The result count therefore lives with the results, not here. Moving this
 * component inside the boundary — including by moving the rail into a
 * suspended column — reintroduces that bug.
 */
export function CatalogControls({
  query,
  creators = [],
}: {
  query: CatalogQuery;
  creators?: readonly string[];
}) {
  const go = useCatalogNav(query);
  const [text, setText] = useState(query.q);
  const debounce = useRef<number | null>(null);

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

  const sortOptions: Option[] = CATALOG_SORTS.map((sort) => ({
    key: sort,
    label: SORT_LABEL[sort],
  }));

  const active = activeFacets(query);

  return (
    <section aria-label="Search and filter models" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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

        <div className="flex shrink-0 items-center gap-2">
          <span className={EYEBROW} id="catalog-sort-label">
            Sort
          </span>
          <Select
            aria-labelledby="catalog-sort-label"
            className="w-auto min-w-40"
            onSelectionChange={(key) => go({ sort: String(key) as CatalogSort })}
            selectedKey={query.sort}
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              {/* Static children rather than the `items` render-prop form: the
                  sort list is a fixed constant and needs no key inference. */}
              <ListBox>
                {sortOptions.map((option) => (
                  <ListBox.Item id={option.key} key={option.key} textValue={option.label}>
                    {option.label}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      </div>

      {/* Below `lg:` the rail cannot hold a column of its own, so it moves into
          a Drawer behind a counted trigger. The count is the number of active
          facets, which is the only thing a collapsed rail still has to report.
          The active chips sit beside it for the same reason — with the rail
          hidden, they are the only visible record of what is filtering the
          grid. Above `lg:` the rail itself shows all of that, so neither
          appears. */}
      <div className="flex flex-wrap items-center gap-2 lg:hidden">
        <Drawer>
          <Drawer.Trigger>
            <Button size="sm" variant="secondary">
              {active.length > 0 ? `Filters (${active.length})` : "Filters"}
            </Button>
          </Drawer.Trigger>

          <Drawer.Backdrop>
            <Drawer.Content placement="left">
              <Drawer.Dialog>
                <Drawer.Header>
                  <Drawer.Heading>Filters</Drawer.Heading>
                  <Drawer.CloseTrigger />
                </Drawer.Header>
                <Drawer.Body>
                  {/* The same rail, not a second implementation of it. Selecting
                      a value navigates and leaves the drawer open, which is
                      right: filtering is usually more than one decision. */}
                  <CatalogFacetRail creators={creators} query={query} />
                </Drawer.Body>
              </Drawer.Dialog>
            </Drawer.Content>
          </Drawer.Backdrop>
        </Drawer>

        {active.map((item) => (
          <Chip color="accent" key={item.label} size="sm" variant="soft">
            {item.label}
          </Chip>
        ))}
      </div>

      {/* The default desktop placement: a real rail, capped so it does not
          stretch to the grid's full width. A future page layout can drop
          `CatalogControls` in favour of `CatalogFacetRail` in its own column. */}
      <div className="hidden max-w-[220px] lg:block">
        <CatalogFacetRail creators={creators} query={query} />
      </div>
    </section>
  );
}

/**
 * One facet: a `Disclosure` whose panel is a `RadioGroup`.
 *
 * Radios, not checkboxes — every facet in `CatalogQuery` is a single value
 * (`minSpeed`, `quality`, …), so a multi-select control would be lying about
 * what the URL can express. The `Any …` row IS the clear affordance for its own
 * facet, which is why it is a real option rather than a separate button.
 *
 * Open by default when the facet is set, so a shared URL shows you which rung
 * it landed on without a click.
 */
function Facet({
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
    <Disclosure defaultExpanded={value !== ANY}>
      <Disclosure.Heading>
        <Disclosure.Trigger className="w-full text-left">
          {/* The flex row is a nested <span>, not utilities on the trigger
              itself. HeroUI ships `.disclosure__trigger` with `display:
              inline-block`, and a component-slot rule beating a Tailwind
              utility is exactly the cascade fight `model-card.tsx` documents on
              `.card__content` — losing it here would leave `Disclosure.Indicator`
              with no flex container for its `ms-auto`, so the chevron would sit
              hard against the label. Nesting sidesteps it. */}
          <span className={`border-border flex w-full items-center gap-2 border-b py-2 ${EYEBROW}`}>
            {label}
            <Disclosure.Indicator />
          </span>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body>
          {/* No spacing utilities on the group: HeroUI's `.radio-group` already
              lays a vertical group out and puts `mt-4` on each row, and adding a
              `gap` on top compounds with it rather than replacing it. */}
          <RadioGroup aria-label={label} onChange={onChange} value={value}>
            {options.map((option) => (
              <Radio key={option.key} value={option.key}>
                <Radio.Content>
                  <Radio.Control>
                    <Radio.Indicator />
                  </Radio.Control>
                  <Label>{option.label}</Label>
                </Radio.Content>
                {/* A sibling of `Radio.Content`, per HeroUI's radio structure —
                    the stylesheet indents `[data-slot="description"]` to line up
                    under the label. */}
                {option.note ? <span data-slot="description">{option.note}</span> : null}
              </Radio>
            ))}
          </RadioGroup>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
