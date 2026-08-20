"use client";

import { Chip, Table } from "@heroui/react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { CopyModelId } from "./copy-model-id";
import {
  formatContext,
  formatLatency,
  formatPricePerMtoken,
  formatSpeedValue,
  qualityChipLabel,
  qualityLabel,
  qualityNote,
} from "./format";
import type { OfferSort, OfferSortKey } from "./offers";
import {
  DEFAULT_OFFER_SORT,
  filterOffersByTier,
  nextOfferSort,
  sortOffers,
  variantTiers,
} from "./offers";
import { modelHref } from "./routes";
import type { ModelOffer, QualityTier } from "./types";

/**
 * THE OFFER BOARD: a variant selector over a sortable table of every listing of
 * one model (#27).
 *
 * This is the reason the model page exists. Three creators serving the same
 * weights at three prices used to be three pages a shopper opened in three tabs
 * and diffed by eye — which is the one comparison a marketplace exists to make
 * unnecessary. Price competition is only visible when the prices are on one
 * screen, in one column, sorted.
 *
 * ── Always rendered, even at one offer ──────────────────────────────────────
 * The issue leaves this open, and the answer here is yes. A one-row table is a
 * little noisy; a page that CHANGES SHAPE at two listings is worse, because the
 * page a creator sees on day one is then not the page a shopper sees on day
 * thirty, and the creator has no way to know what their listing will look like
 * beside a competitor's. The single-offer case reads as "one offer" — a fact
 * about the market for these weights — rather than as a missing feature.
 *
 * ── The quality tier is the label; the quant tag is the detail ──────────────
 * The selector's buttons are TIERS (`Balanced`, `Very high`), never tags. A
 * selector built from tags would offer `IQ4_XS` and `Q4_K_M` as two separate
 * choices for what is one decision, and would make a shopper learn the
 * quantization ladder in order to use the page. The tag still appears — in the
 * Quality cell, beside the tier, as disclosure — because a reader who does know
 * the ladder needs to see exactly which build they are buying.
 * `components/marketplace/format.ts` already ruled on this; this component
 * follows it rather than re-deciding.
 *
 * ── Sorting is client-side, and that is not a violation of rule 1 ───────────
 * See the header of `offers.ts`. The short version: the complete offer set is
 * the page's subject and already arrived in the one round trip that rendered the
 * page, so re-sorting server-side would re-fetch the same rows in a different
 * order. Nothing here drops a row without printing the count of what it dropped.
 *
 * NO HARDWARE APPEARS HERE, and there is no prop through which it could:
 * `ModelOffer` has no GPU field at all (types.ts). Every speed figure is measured
 * throughput from the post-deployment smoke test, never the solver's prediction
 * (FR-MKT-002).
 */
export function OfferBoard({
  offers,
  offerTotal,
  currentListingId,
  modelName,
}: {
  offers: ModelOffer[];
  /** Every offer that exists. Differs from `offers.length` only above the cap. */
  offerTotal: number;
  /** The listing whose URL this is. Its row is marked, never moved. */
  currentListingId: string;
  /** For the table's accessible name, so the caption is not a bare "Offers". */
  modelName: string;
}) {
  const [tier, setTier] = useState<QualityTier | null>(null);
  const [sort, setSort] = useState<OfferSort>(DEFAULT_OFFER_SORT);

  const tiers = useMemo(() => variantTiers(offers), [offers]);

  // A tier the reader selected can only be one that had offers, so a selection
  // with no rung is reachable in exactly one way: the offers prop changed
  // underneath it. Falling back to every offer is the recoverable state — an
  // empty table whose selected button no longer exists is not, and this has to
  // be resolved BEFORE the rows are filtered or the table would empty itself
  // while the strip showed `All` as the active button.
  const shownTier = tiers.some((rung) => rung.tier === tier) ? tier : null;

  const rows = useMemo(
    () => sortOffers(filterOffersByTier(offers, shownTier), sort),
    [offers, shownTier, sort],
  );

  return (
    <div className="flex flex-col gap-4">
      <VariantSelector
        offerCount={offers.length}
        onSelect={setTier}
        selected={shownTier}
        tiers={tiers}
      />

      {/* Per DESIGN.md §3.5: the scroll container carries the border and clips
          its own corners, and it is what scrolls at 375px. Seven columns cannot
          fit on a phone, and the alternative to this box scrolling is the
          DOCUMENT scrolling sideways, which is a hard no. */}
      <Table>
        <Table.ScrollContainer className="border-border overflow-hidden rounded-lg border">
          <Table.Content
            aria-label={`Offers for ${modelName}`}
            onSortChange={(descriptor) =>
              // The direction React Aria proposes is discarded on purpose: it
              // opens every new column ascending, which asks "who is slowest?"
              // on the first click of the speed column. `nextOfferSort` opens
              // each axis best-first and flips on a repeat click.
              setSort((current) => nextOfferSort(current, descriptor.column as OfferSortKey))
            }
            sortDescriptor={{
              column: sort.key,
              direction: sort.direction === "asc" ? "ascending" : "descending",
            }}
          >
            <Table.Header>
              {/* The row header holds the creator AND the callable id: the id is
                  the highest-frequency thing on the row, and putting it in a
                  seventh column would park the copy button off-screen at 375px
                  behind a horizontal scroll. */}
              <SortableColumn isRowHeader label="Creator" sortKey="creator" />
              <SortableColumn label="Quality" sortKey="quality" />
              <SortableColumn label="Context" numeric sortKey="context" />
              <SortableColumn label="Tok/s" numeric sortKey="speed" />
              <SortableColumn label="TTFT p50" numeric sortKey="latency" />
              <SortableColumn label="Input /1M" numeric sortKey="priceIn" />
              <SortableColumn label="Output /1M" numeric sortKey="priceOut" />
            </Table.Header>
            <Table.Body>
              {rows.map((offer) => (
                <OfferRow
                  isCurrent={offer.listingId === currentListingId}
                  key={offer.listingId}
                  offer={offer}
                />
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>

      <OfferFootnote
        offerTotal={offerTotal}
        shown={rows.length}
        total={offers.length}
        tierLabel={shownTier ? qualityChipLabel(shownTier) : null}
      />
    </div>
  );
}

/**
 * One sortable column head.
 *
 * `Table.SortableColumnHeader` is HeroUI's indicator wrapper and it needs the
 * `sortDirection` from `Table.Column`'s render prop — which is why every column
 * here is a render function rather than a bare label.
 */
function SortableColumn({
  label,
  sortKey,
  isRowHeader,
  numeric,
}: {
  label: string;
  sortKey: OfferSortKey;
  isRowHeader?: boolean;
  numeric?: boolean;
}) {
  return (
    <Table.Column
      allowsSorting
      // `whitespace-nowrap` on every head: a wrapped two-line column label in a
      // scrolling table makes the header taller than the rows it describes.
      className={numeric ? "text-end font-mono whitespace-nowrap uppercase" : "whitespace-nowrap"}
      id={sortKey}
      isRowHeader={isRowHeader}
    >
      {({ sortDirection }) => (
        <Table.SortableColumnHeader sortDirection={sortDirection}>
          {label}
        </Table.SortableColumnHeader>
      )}
    </Table.Column>
  );
}

/**
 * One offer.
 *
 * The creator handle links to that listing's page — the offer's own URL, whose
 * snippet and price table are the ones that apply to it. That is why the row
 * does not swap the page's content in place: the snippet below the table has to
 * name a real id, and a page whose URL says one listing while its code block says
 * another teaches the wrong id (CONTRACTS.md, top).
 */
function OfferRow({ offer, isCurrent }: { offer: ModelOffer; isCurrent: boolean }) {
  return (
    <Table.Row className={isCurrent ? "bg-surface-secondary" : undefined} id={offer.listingId}>
      <Table.Cell>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Link
              className="hover:text-accent focus-visible:ring-accent rounded-field text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
              href={modelHref(offer.creatorHandle, offer.slug)}
            >
              {offer.creatorHandle}
            </Link>
            {/* The row the reader is standing on. Without it the highlight is a
                colour with no stated meaning, and the page's own prices read as
                one arbitrary row of the table. */}
            {isCurrent ? (
              <Chip size="sm" variant="soft">
                reading
              </Chip>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {/* The LISTING's id — `creator-handle/model-slug` — and never the
                base model's slug, which looks like an id and resolves to
                nothing.

                `whitespace-nowrap`, NOT the `break-all` the catalog card uses,
                and the difference is the scroll container. A card has nowhere to
                scroll, so a long id must wrap inside it; a table cell does, and
                wrapping here collapsed the column to two characters wide at
                375px and turned every row into a twelve-line tower. An id is
                also the one string on the page that has to be readable in one
                piece to be trusted. */}
            <code className="text-muted font-mono text-xs whitespace-nowrap">{offer.modelId}</code>
            <CopyModelId modelId={offer.modelId} />
          </div>
        </div>
      </Table.Cell>

      <Table.Cell className="whitespace-nowrap">
        <span className="flex items-center gap-1.5">
          <Chip
            size="sm"
            title={`${qualityLabel(offer.qualityTier)} — ${qualityNote(offer.qualityTier)}`}
            variant="soft"
          >
            {qualityChipLabel(offer.qualityTier)}
          </Chip>
          {/* DISCLOSURE, not the label. Muted mono beside the tier, so a reader
              who knows the ladder sees the exact build and one who does not is
              not asked to. */}
          {offer.quantTag ? (
            <code className="text-muted font-mono text-xs">{offer.quantTag}</code>
          ) : null}
        </span>
      </Table.Cell>

      <Table.Cell className="text-end font-mono whitespace-nowrap tabular-nums">
        {formatContext(offer.contextLength)}
        {/* An unverified window is the creator's configuration; a verified one
            was checked against the running worker. The difference matters at
            262k and is invisible without saying so. */}
        {offer.contextVerified ? null : <span className="text-muted"> *</span>}
      </Table.Cell>

      <Table.Cell className="text-end font-mono whitespace-nowrap tabular-nums">
        {formatSpeedValue(offer.measuredTokensPerSecond)}
      </Table.Cell>

      <Table.Cell className="text-muted text-end font-mono whitespace-nowrap tabular-nums">
        {formatLatency(offer.p50TtftMs)}
      </Table.Cell>

      <Table.Cell className="text-end font-mono whitespace-nowrap tabular-nums">
        {formatPricePerMtoken(offer.pricePromptMicroPerMtoken)}
      </Table.Cell>

      <Table.Cell className="text-end font-mono font-medium whitespace-nowrap tabular-nums">
        {formatPricePerMtoken(offer.priceCompletionMicroPerMtoken)}
      </Table.Cell>
    </Table.Row>
  );
}

/**
 * The variant selector: one button per quality rung this model is served at.
 *
 * Buttons and React state, not links and URL state — which is the opposite of
 * the catalog's category tabs, deliberately. Those tabs change WHICH MODELS a
 * crawlable page lists, so they have to be URLs. This narrows the rows of a
 * table whose complete contents are already on the page; routing it through the
 * URL would cost a server round trip to re-fetch rows the browser is holding,
 * and would put a second canonical URL on the one page whose canonical is its
 * model id.
 *
 * `All` is a real button and the default. Every rung carries its count and its
 * cheapest output price, so choosing a quality is a priced decision rather than
 * a guess followed by a look at the table.
 */
function VariantSelector({
  tiers,
  selected,
  onSelect,
  offerCount,
}: {
  tiers: ReturnType<typeof variantTiers>;
  selected: QualityTier | null;
  onSelect: (tier: QualityTier | null) => void;
  offerCount: number;
}) {
  // One rung is not a choice: with nothing to switch between, the strip is a
  // label costing a row of vertical space on every visit. The same reasoning as
  // `CategoryTabs`, and the Quality column still carries the tier per row.
  if (tiers.length < 2) return null;

  return (
    <div aria-label="Quality" className="flex flex-col gap-1" role="group">
      <span className="text-muted text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        Quality
      </span>
      {/* `overflow-x-auto` with `shrink-0` pills, matching `CategoryTabs`: six
          rungs do not fit at 375px and the alternative is the document
          scrolling sideways. `-mx-1 px-1` keeps the focus ring off the clip. */}
      <div className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1 py-1">
        <TierButton
          count={offerCount}
          label="All"
          onSelect={() => onSelect(null)}
          selected={selected === null}
        />
        {tiers.map((rung) => (
          <TierButton
            count={rung.count}
            key={rung.tier}
            label={rung.label}
            onSelect={() => onSelect(rung.tier)}
            price={formatPricePerMtoken(rung.fromCompletionMicro)}
            selected={selected === rung.tier}
            title={`${qualityLabel(rung.tier)} — ${qualityNote(rung.tier)}`}
          />
        ))}
      </div>
    </div>
  );
}

const TIER_BUTTON_BASE =
  "focus-visible:ring-accent inline-flex h-8 shrink-0 items-center gap-1.5 rounded-field border px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none";

/**
 * A plain `<button>`, not a HeroUI `Button`.
 *
 * `aria-pressed` is what makes a set of toggles announce their state, and it is
 * the correct role here: these are not links (the URL does not change) and not a
 * tablist (there is no tabpanel per rung — one table is filtered). Styled to
 * match `CategoryTabs`' pills so a reader who has just come from the catalog
 * recognises the control.
 */
function TierButton({
  label,
  count,
  price,
  selected,
  onSelect,
  title,
}: {
  label: string;
  count: number;
  price?: string;
  selected: boolean;
  onSelect: () => void;
  title?: string;
}) {
  return (
    <button
      aria-pressed={selected}
      className={
        selected
          ? `${TIER_BUTTON_BASE} bg-surface-secondary text-foreground border-border-strong`
          : `${TIER_BUTTON_BASE} text-muted hover:text-foreground hover:bg-surface border-transparent`
      }
      onClick={onSelect}
      title={title}
      type="button"
    >
      {label}
      <span className="text-muted text-xs tabular-nums">{count}</span>
      {price ? <span className="text-muted text-xs tabular-nums">from {price}</span> : null}
    </button>
  );
}

/**
 * What the table is and is not showing.
 *
 * Three facts, and each one exists because its absence would be a silent
 * truncation: how many rows are visible under the active tier, how many offers
 * this model has, and — if the RPC's cap ever fires — how many it did not send.
 * A price comparison that quietly omits rows reads as "these are all the offers".
 */
function OfferFootnote({
  shown,
  total,
  offerTotal,
  tierLabel,
}: {
  shown: number;
  total: number;
  offerTotal: number;
  tierLabel: string | null;
}) {
  const capped = offerTotal > total;

  return (
    <p className="text-muted text-xs tabular-nums">
      {tierLabel
        ? `${shown} of ${total} offers at ${tierLabel.toLowerCase()} quality.`
        : `${total} ${total === 1 ? "offer" : "offers"}.`}{" "}
      {capped
        ? `Showing the ${total} cheapest of ${offerTotal} — the rest are not on this page. `
        : ""}
      Prices are per 1M tokens. A context window marked <span aria-hidden="true">*</span>
      <span className="sr-only">with an asterisk</span> is the creator&rsquo;s configuration rather
      than a figure verified against the running worker.
    </p>
  );
}
