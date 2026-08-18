"use client";

/**
 * The small pieces every console surface repeats: section chrome, the three
 * table states (loading / empty / error), a stat readout, and a copy button.
 *
 * `"use client"` because everything here touches `@heroui/react`, whose barrel is
 * client-only (PRD §4.1.0).
 */

import { Alert, Button, Card, Chip, Skeleton } from "@heroui/react";
import Link from "next/link";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * `typedRoutes` is on in next.config.ts, so `Link`'s href is a checked route
 * union rather than `string`. Deriving the type from the component keeps this
 * working whether or not that flag is set.
 */
type Href = ComponentProps<typeof Link>["href"];

// ─── Section chrome ─────────────────────────────────────────────────────────

export function PanelHeader({
  action,
  description,
  title,
}: Readonly<{
  action?: React.ReactNode;
  description?: React.ReactNode;
  title: string;
}>) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl leading-[1.2] font-semibold tracking-[-0.025em]">{title}</h1>
        {description ? <p className="text-muted max-w-prose text-sm">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ─── Table states ───────────────────────────────────────────────────────────

/**
 * Skeleton rows, never a spinner (PRD quality bar / FR-MKT-005 precedent).
 *
 * A spinner throws the layout away and then rebuilds it, so the page jumps when
 * data lands. Rows of the right height in the right columns mean the only thing
 * that changes on arrival is the text.
 */
export function TableSkeleton({ columns, rows = 5 }: Readonly<{ columns: number; rows?: number }>) {
  const rowKeys = Array.from({ length: rows }, (_, i) => `r${i}`);
  const colKeys = Array.from({ length: columns }, (_, i) => `c${i}`);

  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="border-border divide-separator divide-y overflow-hidden rounded-xl border"
    >
      <span className="sr-only">Loading…</span>
      {rowKeys.map((rowKey) => (
        <div className="flex items-center gap-4 px-4 py-3.5" key={rowKey}>
          {colKeys.map((colKey, index) => (
            <Skeleton
              className={`h-4 ${index === 0 ? "w-40" : "w-20"} ${index > 1 ? "hidden sm:block" : ""}`}
              key={colKey}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Placeholder for the overview's wallet card, at the same height as the real
 * one so the page does not reflow when the rollup lands.
 */
export function StatsSkeleton() {
  return (
    <div aria-busy="true" className="border-border flex flex-col gap-6 rounded-xl border p-6">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-4 w-24" />
      {/* Mirrors `Stat`'s three bands at the same heights, so the only thing that
          changes when the rollup lands is the text. */}
      <div className="grid gap-6 sm:grid-cols-3">
        {["a", "b", "c"].map((slot) => (
          <div className="flex flex-col gap-1" key={slot}>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="mt-1 h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The state a brand-new account actually sees on all three tables.
 *
 * Designed rather than defaulted: a bare "no rows" on an account that has never
 * made a request tells the developer nothing about what to do next, so every
 * caller supplies the next action.
 */
export function EmptyPanel({
  action,
  description,
  title,
}: Readonly<{
  action?: React.ReactNode;
  description: React.ReactNode;
  title: string;
}>) {
  return (
    // A dashed rule reads weaker than a solid one at the same colour, so this
    // frame steps up to `border-tertiary` to stay visible in both themes.
    <div className="border-border-tertiary flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
      <p className="text-base font-medium">{title}</p>
      <p className="text-muted max-w-md text-sm">{description}</p>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

/**
 * A read that failed. Used both by the route-level `error.tsx` boundaries and
 * inline when a client-side page fetch fails.
 */
export function ErrorPanel({
  detail,
  onRetry,
  title = "Could not load this data",
}: Readonly<{
  detail?: string;
  onRetry?: () => void;
  title?: string;
}>) {
  return (
    <Alert status="danger">
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>
          {detail && detail.length > 0
            ? detail
            : "The request did not complete. This is usually transient."}
        </Alert.Description>
        {onRetry ? (
          <div className="pt-3">
            <Button onPress={onRetry} size="sm" variant="outline">
              Try again
            </Button>
          </div>
        ) : null}
      </Alert.Content>
    </Alert>
  );
}

// ─── Stats ──────────────────────────────────────────────────────────────────

/**
 * One figure with a label. `tabular-nums` so a column of these does not shimmer
 * as digits change width.
 *
 * EVERY FIGURE IN A STAT GRID IS THE SAME SIZE, deliberately. The balance used to
 * render at text-4xl beside text-xl siblings, and the size jump made the row read
 * as three things at three different heights rather than one line of figures —
 * the labels were aligned to the pixel and it still looked broken, because the
 * eye tracks the numbers, not the labels. A stat row is a comparison; anything
 * that makes one column structurally taller than its neighbours defeats it.
 *
 * Hierarchy inside the row comes from order and from the label, which is what a
 * reader uses anyway. The three bands — label, figure, hint — line up across all
 * columns: `h-full` takes the stretch a grid item already gets, and `mt-auto`
 * drops every hint to a common baseline at the foot of the row even when some
 * columns have no hint at all.
 */
export function Stat({
  hint,
  label,
  value,
}: Readonly<{
  hint?: React.ReactNode;
  label: string;
  value: string;
}>) {
  return (
    <div className="flex h-full flex-col gap-1">
      <span className="text-muted font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        {label}
      </span>
      <span className="text-2xl font-semibold tracking-[-0.02em] tabular-nums">{value}</span>
      {hint ? <span className="text-muted mt-auto pt-1 text-xs">{hint}</span> : null}
    </div>
  );
}

/** A card that links somewhere — the overview's route into the sub-pages. */
export function LinkCard({
  description,
  href,
  label,
  title,
}: Readonly<{
  description: string;
  href: Href;
  label: string;
  title: string;
}>) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        <Card.Description>{description}</Card.Description>
      </Card.Header>
      <Card.Footer>
        <Link className="text-accent text-sm font-medium hover:underline" href={href}>
          {label} →
        </Link>
      </Card.Footer>
    </Card>
  );
}

// ─── Copy ───────────────────────────────────────────────────────────────────

/**
 * Copy-to-clipboard with a confirmed state.
 *
 * `navigator.clipboard` needs a secure context and can be denied outright, so a
 * failure says so instead of pretending it worked — the caller may be copying
 * the only visible instance of a credential, and a silent failure there costs
 * the user the key.
 */
export function CopyButton({
  fullWidth = false,
  label = "Copy",
  value,
}: Readonly<{
  fullWidth?: boolean;
  label?: string;
  value: string;
}>) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(() => {
    const settle = (next: "copied" | "failed") => {
      setState(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2_500);
    };

    if (!navigator.clipboard?.writeText) {
      settle("failed");
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => settle("copied"),
      () => settle("failed"),
    );
  }, [value]);

  return (
    <div className="flex flex-col gap-1">
      <Button
        fullWidth={fullWidth}
        onPress={copy}
        size="sm"
        variant={state === "copied" ? "secondary" : "primary"}
      >
        {state === "copied" ? "Copied" : label}
      </Button>
      {/* Announced, and visible: a denied clipboard must not look like success. */}
      <span aria-live="polite" className="text-danger text-xs">
        {state === "failed" ? "Copy failed — select the text and copy manually." : ""}
      </span>
    </div>
  );
}

// ─── Status chips ───────────────────────────────────────────────────────────

const USAGE_STATUS_COLOR: Record<string, "success" | "warning" | "danger" | "default"> = {
  settled: "success",
  reserved: "warning",
  expired: "warning",
  voided: "default",
  failed: "danger",
};

/** `usage_transactions.status`, coloured by what it means for the wallet. */
export function UsageStatusChip({ status }: Readonly<{ status: string }>) {
  return (
    <Chip color={USAGE_STATUS_COLOR[status] ?? "default"} variant="soft">
      {status}
    </Chip>
  );
}

/** Active / revoked for a key. */
export function KeyStatusChip({ revokedAt }: Readonly<{ revokedAt: string | null }>) {
  const revoked = revokedAt !== null;
  return (
    <Chip color={revoked ? "danger" : "success"} variant="soft">
      {revoked ? "Revoked" : "Active"}
    </Chip>
  );
}
