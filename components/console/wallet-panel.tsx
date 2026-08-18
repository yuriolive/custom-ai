"use client";

/**
 * /console/wallet — the cash book.
 *
 * `wallet_ledger` is append-only and has no client write policy at all: not for
 * INSERT, not for UPDATE, not for DELETE, for any role (see
 * 20260817001000_wallet_ledger.sql). Its immutability is structural, not
 * procedural. This page is therefore read-only by construction, and reads go
 * straight from the browser under RLS.
 *
 * FR-CON-005/006/007 specify a "Add funds" button and a Stripe Checkout
 * redirect. Stripe is out by decision for this build, so the place a top-up
 * control would live carries a disabled control that says exactly that. A button
 * that looks live and does nothing is worse than no button: it costs the
 * developer a click, then their trust in every other control on the page.
 */

import { Alert, Button, Card, Chip, Table } from "@heroui/react";
import { useCallback, useMemo, useState } from "react";

import {
  formatDateTime,
  formatBalanceMicroUsd,
  formatMicroUsd,
  formatSignedMicroUsd,
  formatTokens,
  ledgerKindLabel,
} from "@/lib/console/format";
import { fetchLedgerPage } from "@/lib/console/queries";
import type { LedgerRow } from "@/lib/console/types";
import { createClient } from "@/lib/supabase/client";

import { EmptyPanel, ErrorPanel, PanelHeader, Stat, TableSkeleton } from "./primitives";

/** Credits are positive by the `wallet_ledger_sign_matches_kind` constraint. */
function amountClass(micro: number): string {
  if (micro > 0) return "text-success";
  if (micro < 0) return "text-foreground";
  return "text-muted";
}

export function WalletPanel({
  balanceMicroUsd,
  initialPage,
  lifetimeSpendMicroUsd,
}: {
  balanceMicroUsd: number;
  initialPage: { nextCursor: number | null; rows: LedgerRow[] };
  lifetimeSpendMicroUsd: number;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [rows, setRows] = useState<LedgerRow[]>(initialPage.rows);
  const [cursor, setCursor] = useState<number | null>(initialPage.nextCursor);
  const [isAppending, setAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;
    setAppending(true);
    setError(null);
    try {
      const page = await fetchLedgerPage(supabase, cursor);
      setRows((current) => [...current, ...page.rows]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unexpected error.");
    } finally {
      setAppending(false);
    }
  }, [cursor, supabase]);

  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        description="Every movement of your balance, in the order it happened. This table and your balance are reconciled nightly — if they ever disagree, the ledger is right."
        title="Wallet"
      />

      <Card>
        <Card.Header>
          <Card.Title>Balance</Card.Title>
          <Card.Description>
            Held against in-flight requests and debited on settlement.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="grid gap-6 sm:grid-cols-2">
            <Stat
              emphasis
              label="Available"
              value={formatBalanceMicroUsd(balanceMicroUsd)}
            />
            <Stat
              label="Lifetime spend"
              value={formatMicroUsd(lifetimeSpendMicroUsd)}
            />
          </div>
        </Card.Content>
        <Card.Footer>
          <div className="flex flex-col gap-2">
            {/* The honest disabled state. Not a stub handler, not a "coming
                soon" toast — a control that cannot be pressed, next to the
                reason it cannot. */}
            <Button isDisabled variant="primary">
              Add funds — unavailable
            </Button>
            <p className="text-muted max-w-prose text-xs">
              Self-service funding is not built in this release: there is no
              payment processor wired up, so there is no way to add funds from
              this page. Balances are credited out of band (a{" "}
              <code className="font-mono">grant</code> row below). Ask an
              operator if you need more.
            </p>
          </div>
        </Card.Footer>
      </Card>

      {error ? <ErrorPanel detail={error} onRetry={() => void loadMore()} /> : null}

      {rows.length === 0 ? (
        <EmptyPanel
          description="Your wallet has no entries yet. Credits and per-request debits will both appear here, each with the balance it left behind."
          title="No ledger entries"
        />
      ) : (
        <>
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label="Wallet ledger">
                <Table.Header>
                  <Table.Column isRowHeader>Time (UTC)</Table.Column>
                  <Table.Column>Kind</Table.Column>
                  <Table.Column>Amount</Table.Column>
                  <Table.Column>Balance after</Table.Column>
                  <Table.Column>Memo</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((row) => (
                    <Table.Row id={String(row.id)} key={row.id}>
                      <Table.Cell className="whitespace-nowrap tabular-nums">
                        {formatDateTime(row.created_at)}
                      </Table.Cell>
                      <Table.Cell>
                        <Chip
                          color={row.amount_micro_usd > 0 ? "success" : "default"}
                          size="sm"
                          variant="soft"
                        >
                          {ledgerKindLabel(row.kind)}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell
                        className={`text-end font-medium tabular-nums ${amountClass(row.amount_micro_usd)}`}
                      >
                        {formatSignedMicroUsd(row.amount_micro_usd)}
                      </Table.Cell>
                      <Table.Cell className="text-end tabular-nums">
                        {formatBalanceMicroUsd(row.balance_after_micro_usd)}
                      </Table.Cell>
                      <Table.Cell className="text-muted">
                        {row.memo ?? "—"}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>

          <div className="flex items-center justify-between gap-3">
            <span className="text-muted text-sm tabular-nums">
              {formatTokens(rows.length)} entr{rows.length === 1 ? "y" : "ies"}
              {cursor !== null ? " so far" : ""}
            </span>
            {cursor !== null ? (
              <Button
                isDisabled={isAppending}
                onPress={() => void loadMore()}
                variant="outline"
              >
                {isAppending ? "Loading…" : "Load more"}
              </Button>
            ) : (
              <span className="text-muted text-sm">End of ledger</span>
            )}
          </div>
        </>
      )}

      {isAppending ? <TableSkeleton columns={5} rows={2} /> : null}

      <Alert status="default">
        <Alert.Content>
          <Alert.Title>Why a debit can differ from a hold</Alert.Title>
          <Alert.Description>
            A request first reserves an estimated maximum, then settles at the
            real token count. Only the settled amount appears here as a{" "}
            <code className="font-mono">Usage</code> debit — the reservation
            itself never touches this ledger.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    </div>
  );
}
