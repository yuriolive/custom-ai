"use client";

import { Chip } from "@heroui/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { formatBalanceMicroUsd } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";

/**
 * Wallet balance in the nav (FR-PLAY-006).
 *
 * The initial value is rendered on the server by `SiteNav`, so the first paint
 * is the real balance rather than a spinner or a stale number. After mount this
 * subscribes to Realtime UPDATEs on the user's own `profiles` row — the same
 * row the Stripe webhook credits and every settled request debits.
 *
 * WHY THE POLL IS STILL HERE. Realtime is a websocket to a separate service: it
 * can be down, blocked by a corporate proxy, or simply not have `profiles` in
 * the publication yet (the migration warns rather than fails in that case). A
 * balance that silently stops updating reads as "my top-up did not arrive", so
 * a 60 s poll backs the subscription up. Both paths write the same state.
 *
 * Signed out, this renders nothing: an anonymous visitor has no wallet, and a
 * "$0.00" chip would be a lie about an account they do not have.
 */
export function BalanceChip({
  initialBalanceMicroUsd,
  userId,
}: Readonly<{
  initialBalanceMicroUsd: number | null;
  userId: string | null;
}>) {
  const supabase = useMemo(() => createClient(), []);
  const [balance, setBalance] = useState(initialBalanceMicroUsd);

  // Server-rendered value wins on navigation: it is fresher than whatever this
  // component last saw if the user has been on another page for a while.
  useEffect(() => {
    setBalance(initialBalanceMicroUsd);
  }, [initialBalanceMicroUsd]);

  useEffect(() => {
    if (!userId) return;
    const state = { stopped: false };

    async function readBalance() {
      const { data } = await supabase
        .from("profiles")
        .select("balance_micro_usd")
        .eq("id", userId)
        .maybeSingle();
      if (!state.stopped && data) setBalance(data.balance_micro_usd as number);
    }

    const channel = supabase
      .channel(`balance:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${userId}`,
        },
        (payload) => {
          const next = (payload.new as { balance_micro_usd?: number }).balance_micro_usd;
          if (typeof next === "number" && !state.stopped) setBalance(next);
        },
      )
      .subscribe();

    const timer = setInterval(() => void readBalance(), 60_000);

    return () => {
      state.stopped = true;
      clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [supabase, userId]);

  if (userId === null || balance === null) return null;

  const isEmpty = balance <= 0;

  // At zero the chip stops being a readout and becomes the way out of the
  // dead end — FR-PLAY-006 disables the composer at zero, and this is the
  // control that fixes that.
  return (
    <Chip
      className="font-mono tabular-nums"
      color={isEmpty ? "danger" : "accent"}
      title={isEmpty ? "No balance — add funds to send a request" : "Available balance"}
      variant="soft"
    >
      {isEmpty ? <Link href="/console/wallet">Add funds</Link> : formatBalanceMicroUsd(balance)}
    </Chip>
  );
}
