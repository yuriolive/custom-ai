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
 * FR-CON-005/006/007: balance, "Add funds" → Stripe Checkout, and return
 * handling. The return handling is the subtle part. `?topup=success` proves
 * only that Stripe redirected the browser here — it is not payment proof and is
 * never treated as one (FR-BIL-032). The credit lands when the signed webhook
 * reaches `/api/stripe/webhook`, which can be a moment after the redirect, so
 * this page polls its own balance for a short window and reports honestly if
 * the credit has not landed by the end of it.
 */

import { Alert, Button, Card, Chip, Table } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { TopUpDialog } from "./top-up-dialog";

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

  const [balance, setBalance] = useState(balanceMicroUsd);
  const [isDialogOpen, setDialogOpen] = useState(false);
  /** null = no return in progress. Drives the banner under the balance. */
  const [returnState, setReturnState] = useState<
    "waiting" | "credited" | "cancelled" | "slow" | null
  >(null);

  /**
   * Post-Checkout return (FR-CON-007).
   *
   * `window.location.search`, not `useSearchParams`: this component is the only
   * consumer, and the hook forces a Suspense boundary on the whole subtree for
   * a value read exactly once, on mount.
   *
   * The poll is bounded at ~30 s. Stripe's webhook is normally faster than the
   * redirect, but a retry can take longer, and a spinner that never resolves is
   * a worse answer than "it hasn't landed yet, here's what that means".
   */
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("topup");
    if (!param) return;

    // Drop the parameter immediately: a refresh must not replay the banner, and
    // the session id in the URL has no business surviving in browser history.
    window.history.replaceState(null, "", window.location.pathname);

    if (param !== "success") {
      setReturnState("cancelled");
      return;
    }

    setReturnState("waiting");
    // A mutable object rather than a plain `let`: the cleanup below flips it
    // from outside the async function, and a captured primitive reads as a
    // loop-invariant to both a human and the linter.
    const poll = { cancelled: false };
    const startedAt = Date.now();

    async function pollUntilCredited() {
      while (!poll.cancelled && Date.now() - startedAt < 30_000) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        if (poll.cancelled) return;

        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        const { data: profile } = await supabase
          .from("profiles")
          .select("balance_micro_usd")
          .eq("id", user.id)
          .single();

        // Compared against the SERVER-RENDERED balance, not the current state:
        // any change at all means the webhook has been through, and a
        // concurrent usage debit is as good a signal as the credit itself.
        if (profile && profile.balance_micro_usd !== balanceMicroUsd) {
          setBalance(profile.balance_micro_usd);
          // The credit exists, so the ledger row does too — reload the first
          // page rather than prepending a row this component invented.
          const page = await fetchLedgerPage(supabase);
          if (poll.cancelled) return;
          setRows(page.rows);
          setCursor(page.nextCursor);
          setReturnState("credited");
          return;
        }
      }
      // Timed out. Not an error — the webhook is the authority and may simply
      // be behind. Say so instead of silently clearing the banner.
      if (!poll.cancelled) setReturnState("slow");
    }

    void pollUntilCredited();
    return () => {
      poll.cancelled = true;
    };
  }, [balanceMicroUsd, supabase]);

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
            <Stat label="Available" value={formatBalanceMicroUsd(balance)} />
            <Stat label="Lifetime spend" value={formatMicroUsd(lifetimeSpendMicroUsd)} />
          </div>

          {returnState === "waiting" ? (
            <Alert className="mt-4" status="default">
              <Alert.Content>
                <Alert.Title>Confirming your payment</Alert.Title>
                <Alert.Description>
                  Stripe is telling us about the payment. Your balance updates here as soon as it
                  does — you can leave this page.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {returnState === "credited" ? (
            <Alert className="mt-4" status="success">
              <Alert.Content>
                <Alert.Title>Funds added</Alert.Title>
                <Alert.Description>
                  Your balance and the ledger below are up to date.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {returnState === "slow" ? (
            <Alert className="mt-4" status="warning">
              <Alert.Content>
                <Alert.Title>Payment taken, credit not landed yet</Alert.Title>
                <Alert.Description>
                  This is normally seconds. The credit is applied when Stripe&rsquo;s confirmation
                  reaches us, so refreshing in a minute should show it. If it is still missing in an
                  hour, contact support with the date and amount — nothing is lost.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {returnState === "cancelled" ? (
            <Alert className="mt-4" status="default">
              <Alert.Content>
                <Alert.Title>Checkout cancelled</Alert.Title>
                <Alert.Description>You were not charged.</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
        </Card.Content>
        <Card.Footer>
          <div className="flex flex-col gap-2">
            <Button onPress={() => setDialogOpen(true)} variant="primary">
              Add funds
            </Button>
            <p className="text-muted max-w-prose text-xs">
              Paid through Stripe Checkout — card details never reach this site. Credit is applied
              from Stripe&rsquo;s signed confirmation, not from returning to this page, so a closed
              tab never loses a payment.
            </p>
          </div>
        </Card.Footer>
      </Card>

      <TopUpDialog isOpen={isDialogOpen} onClose={() => setDialogOpen(false)} />

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
                {/* A numeric column's HEADER has to carry `text-end` too. The
                    cells below already did; the headers did not, so every money
                    column had a start-aligned label sitting over end-aligned
                    figures. `whitespace-nowrap` stops "Balance after" wrapping
                    to two lines and dragging the header row's height with it. */}
                <Table.Header>
                  <Table.Column isRowHeader>Time (UTC)</Table.Column>
                  <Table.Column>Kind</Table.Column>
                  <Table.Column className="text-end">Amount</Table.Column>
                  <Table.Column className="text-end whitespace-nowrap">Balance after</Table.Column>
                  <Table.Column>Memo</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((row) => (
                    <Table.Row id={String(row.id)} key={row.id}>
                      <Table.Cell className="whitespace-nowrap tabular-nums">
                        {formatDateTime(row.created_at)}
                      </Table.Cell>
                      <Table.Cell>
                        {/* `whitespace-nowrap`: the label "Top-up" breaks at its
                            hyphen, and a two-line chip sets the height of the
                            whole row. */}
                        <Chip
                          className="whitespace-nowrap"
                          color={row.amount_micro_usd > 0 ? "success" : "default"}
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
                      {/* A Stripe memo carries a 60-character `cs_test_…`
                          session id. Unconstrained it takes the width every
                          other column needs, which is what squeezed the money
                          columns and wrapped their headers. Truncated with the
                          full value in `title`, so nothing is lost. */}
                      <Table.Cell className="text-muted">
                        <span
                          className="block max-w-[22ch] truncate lg:max-w-[36ch]"
                          title={row.memo ?? undefined}
                        >
                          {row.memo ?? "—"}
                        </span>
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
              <Button isDisabled={isAppending} onPress={() => void loadMore()} variant="outline">
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
            A request first reserves an estimated maximum, then settles at the real token count.
            Only the settled amount appears here as a <code className="font-mono">Usage</code> debit
            — the reservation itself never touches this ledger.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    </div>
  );
}
