"use client";

/**
 * /console overview. Pure render — the Server Component fetched the rollup and
 * handed it down as plain serializable numbers (integer micro-USD throughout).
 *
 * Every figure below goes through `formatMicroUsd`, which does the single
 * division at the last possible moment and is never read back. No arithmetic in
 * this file touches a fraction (CONTRACTS.md §Money).
 */

import { Alert, Card, Chip } from "@heroui/react";

import { formatBalanceMicroUsd, formatMicroUsd, formatTokens } from "@/lib/console/format";
import type { ConsoleSummary } from "@/lib/console/types";

import { LinkCard, Stat } from "./primitives";

export function Overview({ summary }: { summary: ConsoleSummary }) {
  const empty = summary.requests30d === 0;
  const noFunds = summary.balanceMicroUsd <= 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl leading-[1.2] font-semibold tracking-[-0.025em]">Console</h1>
        {/* handle is immutable by RLS — displayed, never offered for edit. */}
        <code className="text-muted text-sm">@{summary.handle}</code>
      </div>

      {noFunds ? (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Title>Your wallet is empty</Alert.Title>
            <Alert.Description>
              The gateway rejects requests it cannot reserve balance for, so calls will fail with a
              402 until the wallet is funded. Self-service funding is not available yet — see the
              wallet page.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Card>
        <Card.Header>
          <Card.Title>Wallet</Card.Title>
          <Card.Description>
            Available balance and the trailing 30 days of settled spend.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="grid gap-6 sm:grid-cols-3">
            <Stat
              hint="Available to spend"
              label="Balance"
              value={formatBalanceMicroUsd(summary.balanceMicroUsd)}
            />
            <Stat
              hint={
                summary.truncated
                  ? "At least this much — the window holds more rows than the rollup reads"
                  : "Settled charges only"
              }
              label="Spend · 30 days"
              value={formatMicroUsd(summary.spend30dMicroUsd)}
            />
            <Stat
              hint={`${formatTokens(summary.settled30d)} settled`}
              label="Requests · 30 days"
              value={formatTokens(summary.requests30d)}
            />
          </div>
        </Card.Content>
        <Card.Footer>
          <div className="flex flex-wrap items-center gap-2">
            <Chip color="default" variant="soft">
              Lifetime spend {formatMicroUsd(summary.lifetimeSpendMicroUsd)}
            </Chip>
            {summary.estimated30d > 0 ? (
              // Surfaced here and not only in the ledger: a developer comparing
              // their own token accounting against the bill deserves to know
              // some rows were billed from an estimate.
              <Chip color="warning" variant="soft">
                {formatTokens(summary.estimated30d)} billed from estimated tokens
              </Chip>
            ) : null}
            {summary.truncated ? (
              <Chip color="warning" variant="soft">
                30-day spend is a floor, not an exact total
              </Chip>
            ) : null}
          </div>
        </Card.Footer>
      </Card>

      {empty ? (
        <Alert status="default">
          <Alert.Content>
            <Alert.Title>No requests yet</Alert.Title>
            <Alert.Description>
              Create an API key, then point an OpenAI-compatible client at the gateway. Every call
              will show up on the usage page with its tokens, cost, and time to first token.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <LinkCard
          description="Create, rename and revoke the keys your clients authenticate with."
          href="/console/keys"
          label="Manage keys"
          title="API keys"
        />
        <LinkCard
          description="Per-request tokens, cost, status and latency, filterable by model and date."
          href="/console/usage"
          label="View usage"
          title="Usage"
        />
        <LinkCard
          description="Every credit and debit against your balance, with the balance after each."
          href="/console/wallet"
          label="View ledger"
          title="Wallet ledger"
        />
      </div>
    </div>
  );
}
