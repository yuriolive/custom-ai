"use client";

import { Card, Chip, Table } from "@heroui/react";
import Link from "next/link";

import { formatCreditValue } from "@/lib/format";

import {
  formatCompact,
  formatContext,
  formatLatency,
  formatPricePerMtoken,
  formatSpeed,
  qualityChipLabel,
  qualityLabel,
  qualityNote,
} from "./format";
import { ReportModelButton } from "./report-model";
import { appHref } from "./routes";
import { catalogHref, EMPTY_QUERY, withCatalogQuery } from "./search-params";
import { SnippetTabs } from "./snippet-tabs";
import type { CatalogModel } from "./types";

/**
 * The model page (FR-MKT-007).
 *
 * The PRD models this as a Modal with Overview / Pricing / Code / Stats tabs. It
 * is a real page here instead, at `/models/[creator]/[slug]`, for reasons the
 * modal cannot satisfy: a model needs a shareable URL, a `<title>` and
 * `<meta>` a link preview can read, and a place for search engines to land. The
 * modal survives on the card for the one thing it is genuinely better at —
 * getting the snippet in front of someone without leaving the grid.
 *
 * NO HARDWARE IS SHOWN. Not the GPU tier, not the worker count, not the predicted
 * throughput. A developer integrating this needs to know how fast it runs, how
 * much it remembers, how good the weights are and what it costs; which silicon
 * delivers that is the platform's problem (FR-MKT-002).
 */
export function ModelDetail({
  model,
  baseUrl,
  viewerId,
}: {
  model: CatalogModel;
  baseUrl: string;
  /**
   * The signed-in visitor's id, or `null`. Passed down from the page rather than
   * read here: this is a client component, and `getUser()` on the server is the
   * only read that verifies the cookie's signature (see lib/supabase/server).
   */
  viewerId: string | null;
}) {
  const tokensServed = model.totalPromptTokens + model.totalCompletionTokens;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="text-muted text-sm">
          <Link className="hover:text-foreground" href="/">
            Catalog
          </Link>
          <span aria-hidden="true"> / </span>
          <Link
            className="hover:text-foreground"
            href={appHref(
              catalogHref(withCatalogQuery(EMPTY_QUERY, { creator: model.creatorHandle })),
            )}
          >
            {model.creatorHandle}
          </Link>
        </nav>

        <h1 className="font-mono text-xl font-semibold break-all sm:text-2xl">{model.modelId}</h1>
        <p className="text-muted text-sm">
          {model.displayName}
          {model.creatorDisplayName ? ` · by ${model.creatorDisplayName}` : ""}
        </p>

        <div className="flex flex-wrap gap-2">
          <Chip color="success" variant="soft">
            Ready
          </Chip>
          <Chip color="accent" variant="soft">
            {formatSpeed(model.measuredTokensPerSecond)} measured
          </Chip>
          <Chip variant="soft">
            {formatContext(model.contextLength)} context
            {model.contextVerified ? " · verified" : ""}
          </Chip>
          <Chip variant="soft">{qualityChipLabel(model.qualityTier)}</Chip>
          {model.quantTag ? <Chip variant="soft">{model.quantTag}</Chip> : null}
        </div>
      </header>

      {/* The snippets come FIRST, above description and stats. It is the thing a
          developer opened this page for. */}
      <section aria-labelledby="call-it" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold" id="call-it">
          Call it
        </h2>
        <SnippetTabs baseUrl={baseUrl} modelId={model.modelId} />
      </section>

      {model.description ? (
        <section aria-labelledby="about" className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold" id="about">
            About this model
          </h2>
          <p className="text-muted max-w-3xl text-sm whitespace-pre-line">{model.description}</p>
        </section>
      ) : null}

      <section aria-labelledby="pricing" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold" id="pricing">
          Pricing
        </h2>
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={`Token pricing for ${model.modelId}`}>
              <Table.Header>
                <Table.Column isRowHeader>Tokens</Table.Column>
                <Table.Column>Per 1M tokens</Table.Column>
                <Table.Column>Per 1k tokens</Table.Column>
              </Table.Header>
              <Table.Body>
                <Table.Row id="prompt">
                  <Table.Cell>Input (prompt)</Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {formatPricePerMtoken(model.pricePromptMicroPerMtoken)}
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {formatPricePerMtoken(Math.round(model.pricePromptMicroPerMtoken / 1_000))}
                  </Table.Cell>
                </Table.Row>
                <Table.Row id="completion">
                  <Table.Cell>Output (completion)</Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {formatPricePerMtoken(model.priceCompletionMicroPerMtoken)}
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {formatPricePerMtoken(Math.round(model.priceCompletionMicroPerMtoken / 1_000))}
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
          {formatCreditValue(model.pricePromptMicroPerMtoken, model.priceCompletionMicroPerMtoken)}
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
            value={formatSpeed(model.measuredTokensPerSecond)}
          />
          <Stat
            hint="Median time to the first token on a WARM worker. A cold first call is dominated by the wake-up, not by this number."
            label="p50 first token"
            value={formatLatency(model.p50TtftMs)}
          />
          <Stat
            hint="95th percentile time to first token on a warm worker."
            label="p95 first token"
            value={formatLatency(model.p95TtftMs)}
          />
          <Stat
            hint="Input plus output tokens served through the gateway, all time."
            label="Tokens served"
            value={tokensServed > 0 ? formatCompact(tokensServed) : "—"}
          />
        </div>
        <p className="text-muted text-xs">
          {model.totalRequests > 0
            ? `${formatCompact(model.totalRequests)} requests served.`
            : "No requests served yet — latency figures appear once real traffic has been measured."}{" "}
          Quality: <strong className="text-foreground">{qualityLabel(model.qualityTier)}</strong> —{" "}
          {qualityNote(model.qualityTier)}
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

      {/* Last on the page, and quiet. A prominent report control next to "Call
          it" reads as a warning about the listing it sits on, and every listing
          would carry it. It still has to be findable without reading the legal
          pages, which is why it is on the page at all (§5.5). */}
      <footer className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-6">
        <p className="text-muted text-xs">
          Something wrong with this listing — a licence, a rights claim, or the acceptable use
          policy? An operator can take it down.
        </p>
        <ReportModelButton modelId={model.modelId} modelUuid={model.id} viewerId={viewerId} />
      </footer>
    </div>
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
