"use client";

import { Chip } from "@heroui/react";

import { formatMicroUsd } from "@/lib/format";
import type { WalletBalance } from "@/lib/types";

/**
 * Wallet balance in the nav (FR-PLAY-006).
 *
 * PLACEHOLDER for MVP-0: the value is hard-coded and the chip is marked as
 * such. When the schema lands (A1), swap the constant for a Supabase Realtime
 * subscription on `profiles.balance_micro_usd` — the render shape below does
 * not need to change.
 */
const PLACEHOLDER: WalletBalance = {
  balanceMicroUsd: 5_000_000, // $5.00
  isPlaceholder: true,
};

export function BalanceChip({ balance = PLACEHOLDER }: { balance?: WalletBalance }) {
  const isEmpty = balance.balanceMicroUsd <= 0;

  return (
    <Chip
      color={isEmpty ? "danger" : "accent"}
      size="sm"
      title={
        balance.isPlaceholder
          ? "Placeholder balance — wallet is not wired to Supabase yet"
          : "Available balance"
      }
      variant="soft"
    >
      {formatMicroUsd(balance.balanceMicroUsd)}
      {balance.isPlaceholder ? " (placeholder)" : ""}
    </Chip>
  );
}
