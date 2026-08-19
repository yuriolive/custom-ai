"use client";

/**
 * /console/usage — FR-CON-004. The per-request ledger.
 *
 * Reads go straight from the browser: `usage_transactions` is SELECT-own under
 * RLS (CONTRACTS.md §Frontend / auth contract), so pagination and filtering
 * re-run the exact same `fetchUsagePage` the Server Component used for the first
 * paint. No route handler sits in the middle, and no query here passes a user id
 * — Postgres decides what this session can see.
 *
 * Pagination is keyset, not offset: the ledger grows by a row on every request
 * ever made, and OFFSET on that table gets slower the further back you look
 * while also skipping or repeating rows when new ones land mid-scroll.
 */

import { Button, Chip, Label, ListBox, Select, Table } from "@heroui/react";
import { useCallback, useMemo, useState } from "react";

import {
  dateInputToIsoEnd,
  dateInputToIsoStart,
  formatDateTime,
  formatMicroUsd,
  formatMs,
  formatTokens,
} from "@/lib/console/format";
import { fetchUsagePage, type UsagePage } from "@/lib/console/queries";
import type { CalledModel, UsageRow } from "@/lib/console/types";
import { createClient } from "@/lib/supabase/client";

import { EmptyPanel, ErrorPanel, PanelHeader, TableSkeleton, UsageStatusChip } from "./primitives";

const ALL_MODELS = "__all__";

type Filters = {
  /** `YYYY-MM-DD` or "" — the value shape of an `<input type="date">`. */
  from: string;
  modelId: string | null;
  to: string;
};

const NO_FILTERS: Filters = { from: "", modelId: null, to: "" };

export function UsagePanel({
  initialPage,
  models,
  userId,
}: {
  initialPage: UsagePage;
  models: CalledModel[];
  /**
   * The caller's own id, from the verified server-side session.
   *
   * Not a security boundary — RLS still decides what this session may read, and
   * this value is the user's own id, which they already hold in their session
   * cookie. It is a CORRECTNESS filter: `usage_transactions` also grants read
   * access to settled rows for models the caller created, and those are other
   * people's spend. See lib/console/queries.ts.
   */
  userId: string;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [rows, setRows] = useState<UsageRow[]>(initialPage.rows);
  const [cursor, setCursor] = useState(initialPage.nextCursor);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [phase, setPhase] = useState<"idle" | "filtering" | "appending">("idle");
  const [error, setError] = useState<string | null>(null);

  /** Reload from the top with a new filter set. */
  const applyFilters = useCallback(
    async (next: Filters) => {
      setFilters(next);
      setPhase("filtering");
      setError(null);
      try {
        const page = await fetchUsagePage(supabase, userId, {
          fromIso: next.from ? dateInputToIsoStart(next.from) : null,
          modelId: next.modelId,
          toIso: next.to ? dateInputToIsoEnd(next.to) : null,
        });
        setRows(page.rows);
        setCursor(page.nextCursor);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unexpected error.");
      } finally {
        setPhase("idle");
      }
    },
    [supabase, userId],
  );

  /** Append the next keyset page. */
  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setPhase("appending");
    setError(null);
    try {
      const page = await fetchUsagePage(supabase, userId, {
        cursor,
        fromIso: filters.from ? dateInputToIsoStart(filters.from) : null,
        modelId: filters.modelId,
        toIso: filters.to ? dateInputToIsoEnd(filters.to) : null,
      });
      setRows((current) => [...current, ...page.rows]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unexpected error.");
    } finally {
      setPhase("idle");
    }
  }, [cursor, filters, supabase, userId]);

  const isFiltered = filters.modelId !== null || filters.from !== "" || filters.to !== "";
  const estimatedCount = rows.filter((row) => row.usage_estimated).length;

  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        description="One row per request, straight from the billing ledger. Cost is the amount actually charged against your wallet, computed from the price snapshot taken when the request was authorized."
        title="Usage"
      />

      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-48">
          <Select
            onSelectionChange={(key) => {
              const value = String(key);
              void applyFilters({
                ...filters,
                modelId: value === ALL_MODELS ? null : value,
              });
            }}
            selectedKey={filters.modelId ?? ALL_MODELS}
          >
            <Label>Model</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id={ALL_MODELS}>All models</ListBox.Item>
                {/* Only models this account has actually called — a full catalog
                    list would offer filters that can only ever return nothing. */}
                {models.map((model) => (
                  <ListBox.Item id={model.id} key={model.id}>
                    {model.label}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>

        <DateFilter
          label="From"
          onChange={(value) => void applyFilters({ ...filters, from: value })}
          value={filters.from}
        />
        <DateFilter
          label="To"
          onChange={(value) => void applyFilters({ ...filters, to: value })}
          value={filters.to}
        />

        {isFiltered ? (
          <Button onPress={() => void applyFilters(NO_FILTERS)} size="sm" variant="ghost">
            Clear filters
          </Button>
        ) : null}
      </div>

      {estimatedCount > 0 ? (
        <div>
          {/* FR-GW-044's fallback path, made visible. A developer reconciling
              their own token counts against this bill needs to know which rows
              were billed from an estimate rather than reported usage. */}
          <Chip color="warning" variant="soft">
            {formatTokens(estimatedCount)} of the rows below were billed from estimated token counts
          </Chip>
        </div>
      ) : null}

      {error ? <ErrorPanel detail={error} onRetry={() => void applyFilters(filters)} /> : null}

      {phase === "filtering" ? (
        <TableSkeleton columns={7} rows={6} />
      ) : rows.length === 0 ? (
        <EmptyPanel
          action={
            isFiltered ? (
              <Button onPress={() => void applyFilters(NO_FILTERS)} variant="outline">
                Clear filters
              </Button>
            ) : null
          }
          description={
            isFiltered
              ? "No requests match this model and date range. Widen the range, or clear the filters to see everything."
              : "Nothing has been billed to this account yet. Create an API key and make a request — it will appear here within a second of settling, with its tokens, cost and time to first token."
          }
          title={isFiltered ? "No matching requests" : "No usage yet"}
        />
      ) : (
        <>
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label="Usage transactions">
                <Table.Header>
                  <Table.Column isRowHeader>Time (UTC)</Table.Column>
                  <Table.Column>Model</Table.Column>
                  <Table.Column className="text-end whitespace-nowrap">Tokens in</Table.Column>
                  <Table.Column className="text-end whitespace-nowrap">Tokens out</Table.Column>
                  <Table.Column className="text-end">Cached</Table.Column>
                  <Table.Column className="text-end">Cost</Table.Column>
                  <Table.Column>Status</Table.Column>
                  <Table.Column className="text-end">TTFT</Table.Column>
                  <Table.Column>Start</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((row) => (
                    <Table.Row id={row.id} key={row.id}>
                      <Table.Cell className="whitespace-nowrap tabular-nums">
                        {formatDateTime(row.created_at)}
                      </Table.Cell>
                      <Table.Cell>
                        <code className="font-mono text-xs">
                          {/* Null when the model row is no longer readable —
                              deleted, or made private after the call. */}
                          {row.model_slug ?? row.model_display_name ?? "—"}
                        </code>
                      </Table.Cell>
                      <Table.Cell className="text-end tabular-nums">
                        <span className="inline-flex items-center gap-1.5">
                          {formatTokens(row.prompt_tokens)}
                          {row.usage_estimated ? (
                            <Chip color="warning" variant="soft">
                              est
                            </Chip>
                          ) : null}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="text-end tabular-nums">
                        {formatTokens(row.completion_tokens)}
                      </Table.Cell>
                      <Table.Cell className="text-muted text-end tabular-nums">
                        {row.cached_prompt_tokens > 0
                          ? formatTokens(row.cached_prompt_tokens)
                          : "—"}
                      </Table.Cell>
                      <Table.Cell className="text-end font-medium tabular-nums">
                        {/* A `reserved` row has no cost yet, only a hold. Showing
                            the hold as if it were a charge would misstate the
                            bill, so the two are labelled differently. */}
                        {row.status === "settled"
                          ? formatMicroUsd(row.cost_micro_usd)
                          : row.hold_micro_usd > 0
                            ? `${formatMicroUsd(row.hold_micro_usd)} held`
                            : formatMicroUsd(row.cost_micro_usd)}
                      </Table.Cell>
                      <Table.Cell>
                        <span className="inline-flex items-center gap-1.5">
                          <UsageStatusChip status={row.status} />
                          {row.error_code ? (
                            <code className="text-danger font-mono text-xs" title={row.error_code}>
                              {row.error_code}
                            </code>
                          ) : null}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="text-end tabular-nums">
                        {formatMs(row.ttft_ms)}
                      </Table.Cell>
                      <Table.Cell>
                        {row.cold_start === null ? (
                          <span className="text-muted">—</span>
                        ) : row.cold_start ? (
                          <Chip color="warning" variant="soft">
                            cold
                          </Chip>
                        ) : (
                          <Chip color="default" variant="soft">
                            warm
                          </Chip>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>

          <div className="flex items-center justify-between gap-3">
            <span className="text-muted text-sm tabular-nums">
              {formatTokens(rows.length)} row{rows.length === 1 ? "" : "s"}
              {cursor ? " so far" : ""}
            </span>
            {cursor ? (
              <Button
                isDisabled={phase === "appending"}
                onPress={() => void loadMore()}
                variant="outline"
              >
                {phase === "appending" ? "Loading…" : "Load more"}
              </Button>
            ) : (
              <span className="text-muted text-sm">End of ledger</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A native date input.
 *
 * Deliberate: `<input type="date">` is keyboard accessible, localized by the
 * platform, and understood by every password-manager-free autofill path. A
 * custom calendar popover here would be more code for a control that has to
 * produce exactly the `YYYY-MM-DD` string `dateInputToIso*` already parses.
 */
function DateFilter({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <input
        // A native date input, not HeroUI's DatePicker: this filter round-trips a
        // plain `yyyy-mm-dd` through the URL and the native control already gives
        // that for free with the platform's own calendar and keyboard handling.
        // It wears the field tokens so it matches every HeroUI input beside it.
        className="border-field-border bg-field text-field-foreground focus-visible:ring-accent rounded-field h-9 border px-3 text-sm tabular-nums focus-visible:ring-2 focus-visible:outline-none"
        onChange={(event) => onChange(event.target.value)}
        type="date"
        value={value}
      />
    </label>
  );
}
