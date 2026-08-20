"use client";

import { Card, Chip, Table } from "@heroui/react";
import Link from "next/link";

import { formatCreditValue } from "@/lib/format";

import { CopyModelId } from "./copy-model-id";
import {
  categoryLabel,
  formatCompact,
  formatContext,
  formatLatency,
  formatPricePerMtoken,
  formatServedBy,
  formatSpeed,
  qualityChipLabel,
  qualityLabel,
  qualityNote,
  weightsPublisher,
} from "./format";
import { LicenceNotice } from "./licence-notice";
import type { Lineage } from "./lineage";
import { lineageOf, LINEAGE_PREFIX, lineageSummary } from "./lineage";
import { OfferBoard } from "./offer-board";
import { offerCreatorCount } from "./offers";
import { appHref } from "./routes";
import { catalogHref, EMPTY_QUERY, withCatalogQuery } from "./search-params";
import { SnippetTabs } from "./snippet-tabs";
import type { ModelPage } from "./types";

/**
 * THE MODEL PAGE (FR-MKT-007, #27).
 *
 * The PRD models this as a Modal with Overview / Pricing / Code / Stats tabs. It
 * is a real page here instead, at `/models/[creator]/[slug]`, for reasons the
 * modal cannot satisfy: a model needs a shareable URL, a `<title>` and `<meta>` a
 * link preview can read, and a place for search engines to land. The modal
 * survives on the card for the one thing it is genuinely better at — getting the
 * snippet in front of someone without leaving the grid.
 *
 * ── What changed in #27, and why ────────────────────────────────────────────
 * This page used to describe ONE DEPLOYMENT. Three creators serving the same
 * weights at three prices were three pages a shopper opened in three tabs and
 * diffed by eye — which is exactly the comparison a marketplace exists to make
 * unnecessary. The page is now a MODEL: the offer board is the first thing under
 * the title, because price competition is the most valuable thing a marketplace
 * can show and it is only visible when the prices are in one column.
 *
 * ── One URL, two subjects, and the line between them ────────────────────────
 * The route segments are still a LISTING's addressable id, and that is
 * deliberate: it means the URL a developer shares and the string they pass as
 * `model` are the same two tokens (CONTRACTS.md, top). So the page has two
 * subjects and every element belongs to exactly one of them:
 *
 *   THE MODEL     the `<h1>`, the lineage line, the use-case chips, the licence.
 *   THE LISTING   the callable id, the snippet, the price table, the measured
 *                 figures — all of them `page.listing`'s, and all of them below
 *                 the offer board that says which of several listings it is.
 *
 * Mixing the two is the whole risk. A snippet naming one listing under a title
 * naming the model would teach the wrong id; a price table sitting under a model
 * name would state a price the model does not have.
 *
 * NO HARDWARE IS SHOWN. Not the GPU tier, not the worker count, not the predicted
 * throughput — and there is no prop through which it could arrive: `ModelPage`
 * has no GPU field at all (types.ts). A developer integrating this needs to know
 * how fast it runs, how much it remembers, how good the weights are and what it
 * costs; which silicon delivers that is the platform's problem (FR-MKT-002).
 */
export function ModelDetail({ page, baseUrl }: { page: ModelPage; baseUrl: string }) {
  const { listing, model, offers, offerTotal, parent } = page;
  const tokensServed = listing.totalPromptTokens + listing.totalCompletionTokens;
  const lineage = lineageOf(model, parent);
  // The MODEL's name where one is resolved, the listing's where none is. A
  // listing name is the honest fallback rather than a placeholder: until #25's
  // cascade runs, "Qwen3.8 27B Uncensored (Q6_K)" is the most specific true
  // thing the platform knows about these weights.
  const modelName = model?.displayName ?? listing.displayName;
  const publisher = weightsPublisher(model?.slug ?? null);
  const creatorCount = offerCreatorCount(offers);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="text-muted text-sm">
          <Link className="hover:text-foreground" href="/models">
            Catalog
          </Link>
          <span aria-hidden="true"> / </span>
          <Link
            className="hover:text-foreground"
            href={appHref(
              catalogHref(withCatalogQuery(EMPTY_QUERY, { creator: listing.creatorHandle })),
            )}
          >
            {listing.creatorHandle}
          </Link>
        </nav>

        {/* The MODEL's name, and prose rather than mono: after grouping this is a
            display name, not an identifier. The callable id has its own row
            below, where a reader looking for something to paste will find it. */}
        <h1 className="text-xl font-semibold break-words sm:text-2xl">{modelName}</h1>

        <LineageLine lineage={lineage} />

        {/* THE PROVENANCE LINE. Not decoration: without "weights by qwen · served
            by alice", a creator who did nothing but run a deploy reads as the
            author of the model — and on this page that misreading is worse than
            on the card, because the title above is the model's name. The first
            clause is omitted rather than guessed; until the cascade resolves a
            base model the platform genuinely does not know who published the
            weights. */}
        <p className="text-muted text-sm">
          {publisher ? (
            <>
              weights by <span className="text-foreground">{publisher}</span>
              {" · "}
            </>
          ) : null}
          served by{" "}
          <span className="text-foreground">
            {formatServedBy(listing.creatorHandle, creatorCount)}
          </span>
        </p>

        {model && model.categories.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {/* What the model is FOR, from the closed `use_cases` vocabulary —
                the same values the catalog's counted tabs filter on, so a chip
                here and a tab there always mean the same thing. Outline pills,
                visually distinct from the soft quality chip below: the soft one
                is a judgement about the artifact, these are what it accepts
                (DESIGN.md §3.2). */}
            {model.categories.map((category) => (
              <Chip className="border-border border" key={category} size="sm" variant="tertiary">
                {categoryLabel(category)}
              </Chip>
            ))}
          </div>
        ) : null}
      </header>

      {/* ── THE OFFER BOARD, FIRST ──────────────────────────────────────────
          Above the snippet, which is a reordering from the pre-#27 page and the
          point of the issue. The snippet was first when the page described one
          deployment, because choosing it was already done. Now the reader's
          first question is WHICH offer, and answering the second question first
          would price the page's own listing as though it were the only one. */}
      <section aria-labelledby="offers" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold" id="offers">
          Offers
        </h2>
        <OfferBoard
          currentListingId={listing.id}
          modelName={modelName}
          offerTotal={offerTotal}
          offers={offers}
        />
      </section>

      {/* Everything from here down is THIS LISTING, and the eyebrow says so.
          Without it the price table reads as the model's price, and the model
          does not have one. */}
      <div className="flex flex-col gap-2">
        <p className="text-muted text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
          The offer you are reading
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* The callable id: `creator-handle/model-slug`, and never the base
              model's slug, which looks like an id and resolves to nothing. The
              copy button is here as well as on this listing's row in the table
              above — duplicated on purpose, because this is where a reader who
              has already chosen looks for something to paste, and a reader who
              has to scroll back up to a table row to copy an id will retype it
              instead, which is how the wrong id gets into a codebase. */}
          <code className="font-mono text-sm break-all">{listing.modelId}</code>
          <CopyModelId modelId={listing.modelId} />
        </div>
        <p className="text-muted text-sm">
          {listing.displayName}
          {listing.creatorDisplayName ? ` · by ${listing.creatorDisplayName}` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <Chip color="success" variant="soft">
            Ready
          </Chip>
          <Chip color="accent" variant="soft">
            {formatSpeed(listing.measuredTokensPerSecond)} measured
          </Chip>
          <Chip variant="soft">
            {formatContext(listing.contextLength)} context
            {listing.contextVerified ? " · verified" : ""}
          </Chip>
          <Chip
            title={`${qualityLabel(listing.qualityTier)} — ${qualityNote(listing.qualityTier)}`}
            variant="soft"
          >
            {qualityChipLabel(listing.qualityTier)}
          </Chip>
          {/* DISCLOSURE, not the label — the tier chip beside it is the label. */}
          {listing.quantTag ? <Chip variant="soft">{listing.quantTag}</Chip> : null}
        </div>
      </div>

      <section aria-labelledby="call-it" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold" id="call-it">
          Call it
        </h2>
        <SnippetTabs baseUrl={baseUrl} modelId={listing.modelId} />
      </section>

      {model?.summary || listing.description ? (
        <section aria-labelledby="about" className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold" id="about">
            About this model
          </h2>
          {/* The MODEL's summary describes the weights and is true of every
              offer; the LISTING's description describes one build of them. Both
              are shown when both exist, in that order, because collapsing them
              would attribute one creator's words to the model itself. */}
          {model?.summary ? (
            <p className="text-muted max-w-3xl text-sm whitespace-pre-line">{model.summary}</p>
          ) : null}
          {listing.description ? (
            <p className="text-muted max-w-3xl text-sm whitespace-pre-line">
              {listing.description}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* THE LICENCE. Rendered for every resolved model, whatever its posture —
          see the header of `licence-notice.tsx` for why the section's absence
          would be ambiguous. An unresolved listing gets the honest short form:
          the platform has not read a licence because it has not identified the
          weights. */}
      {model ? (
        <LicenceNotice model={model} />
      ) : (
        <section aria-labelledby="licence" className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold" id="licence">
            Licence
          </h2>
          <p className="text-muted max-w-3xl text-sm">
            The platform has not matched these weights to a known model, so no licence has been read
            for them. Check the upstream repository before you build on this listing commercially.
          </p>
        </section>
      )}

      <section aria-labelledby="pricing" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold" id="pricing">
          Pricing
        </h2>
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={`Token pricing for ${listing.modelId}`}>
              <Table.Header>
                <Table.Column isRowHeader>Tokens</Table.Column>
                <Table.Column>Per 1M tokens</Table.Column>
                <Table.Column>Per 1k tokens</Table.Column>
              </Table.Header>
              <Table.Body>
                <Table.Row id="prompt">
                  <Table.Cell>Input (prompt)</Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {formatPricePerMtoken(listing.pricePromptMicroPerMtoken)}
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {formatPricePerMtoken(Math.round(listing.pricePromptMicroPerMtoken / 1_000))}
                  </Table.Cell>
                </Table.Row>
                <Table.Row id="completion">
                  <Table.Cell>Output (completion)</Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {formatPricePerMtoken(listing.priceCompletionMicroPerMtoken)}
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {formatPricePerMtoken(
                      Math.round(listing.priceCompletionMicroPerMtoken / 1_000),
                    )}
                  </Table.Cell>
                </Table.Row>
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
        {/* The same value line the catalog card carries, from the same helper.
            A per-token price is not a number anyone holds in their head; what a
            fixed top-up buys is. Floored, so it never promises tokens a balance
            cannot pay for. */}
        <p className="text-sm tabular-nums">
          {formatCreditValue(
            listing.pricePromptMicroPerMtoken,
            listing.priceCompletionMicroPerMtoken,
          )}
        </p>
        <p className="text-muted text-xs">
          Billed on tokens actually processed, rounded up, with a one-microdollar minimum per
          request. Reasoning models bill their chain-of-thought as output tokens, because that is
          what the GPU generated. There is no charge for the time a worker spends waking up.
        </p>
      </section>

      <section aria-labelledby="capability" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold" id="capability">
          Measured performance
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            hint="From the post-deployment smoke test on this exact variant — not an estimate."
            label="Throughput"
            value={formatSpeed(listing.measuredTokensPerSecond)}
          />
          <Stat
            hint="Median time to the first token on a WARM worker. A cold first call is dominated by the wake-up, not by this number."
            label="p50 first token"
            value={formatLatency(listing.p50TtftMs)}
          />
          <Stat
            hint="95th percentile time to first token on a warm worker."
            label="p95 first token"
            value={formatLatency(listing.p95TtftMs)}
          />
          <Stat
            hint="Input plus output tokens served through the gateway, all time."
            label="Tokens served"
            value={tokensServed > 0 ? formatCompact(tokensServed) : "—"}
          />
        </div>
        <p className="text-muted text-xs">
          {listing.totalRequests > 0
            ? `${formatCompact(listing.totalRequests)} requests served.`
            : "No requests served yet — latency figures appear once real traffic has been measured."}{" "}
          Quality: <strong className="text-foreground">{qualityLabel(listing.qualityTier)}</strong>{" "}
          — {qualityNote(listing.qualityTier)}
        </p>
      </section>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Try it without writing code</Card.Title>
          <Card.Description>
            The playground streams through the same gateway, with per-turn cost metering, so you can
            see the cold start and the warm speed for yourself before you integrate.
          </Card.Description>
        </Card.Header>
        <Card.Footer>
          <Link className="text-accent text-sm font-medium hover:underline" href="/playground">
            Open the playground →
          </Link>
        </Card.Footer>
      </Card>
    </div>
  );
}

/**
 * `based on Qwen3 8B` — or the honest version of that sentence when there is no
 * parent, or no resolved model at all.
 *
 * NEVER BLANK. An original and an unidentified listing would render identically
 * as nothing, and they are opposite claims: "trained from scratch" versus "nobody
 * has checked". `lineage.ts` keeps the four states apart and this renders them.
 *
 * The link, where there is one, goes to a CATALOG SEARCH rather than to the
 * parent's own page, because a base model has no page: the platform's addressable
 * unit is a listing (`creator-handle/model-slug`), and `base_models.slug` is a
 * weights publisher plus a model name, which resolves to nothing. When the parent
 * has no visible listings the name is plain text — a link to a search that
 * returns nothing reads as a broken page rather than as a model nobody serves.
 */
function LineageLine({ lineage }: { lineage: Lineage }) {
  const summary = lineageSummary(lineage);

  return (
    <p className="text-muted text-sm" title={lineage.note}>
      {LINEAGE_PREFIX}{" "}
      {lineage.kind === "derived" && lineage.searchQuery ? (
        <Link
          className="text-accent hover:underline"
          href={appHref(catalogHref(withCatalogQuery(EMPTY_QUERY, { q: lineage.searchQuery })))}
        >
          {summary}
        </Link>
      ) : (
        <span className="text-foreground">{summary}</span>
      )}
      {/* The reason, inline rather than only in a tooltip: a title attribute is
          invisible on a touch device, and this sentence is the one that
          distinguishes "original" from "unchecked". */}
      <span className="block text-xs">{lineage.note}</span>
    </p>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div
      className="border-border bg-surface flex flex-col gap-1 rounded-lg border p-4"
      title={hint}
    >
      <span className="text-muted text-xs font-medium tracking-wide uppercase">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}
