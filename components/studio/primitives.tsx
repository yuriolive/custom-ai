"use client";

/**
 * Shared Creator Studio pieces: the sticky-summary shell, the definition list
 * the summary carries, and the model status chip.
 *
 * The ⓘ explanation affordance moved to `components/label-hint.tsx` — the
 * marketplace snippet block needs it too.
 *
 * `"use client"` because everything here touches `@heroui/react`, whose barrel
 * is client-only (PRD §4.1.0).
 */

import { Chip } from "@heroui/react";
import type { ReactNode } from "react";

import type { ModelStatus } from "@/lib/studio/types";

// ─── The sticky-summary primitive (docs/DESIGN.md §3.9) ─────────────────────

/**
 * Two-column form shell: fields left, a sticky summary panel right.
 *
 * Below `lg:` the panel is NOT sticky and moves BELOW the form. A sticky panel
 * at 375px eats the viewport, and the CTA is reachable by scrolling to the end
 * of the form, which is where a person expects it.
 */
export function SummaryLayout({
  children,
  summary,
}: Readonly<{
  children: ReactNode;
  summary: ReactNode;
}>) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0">{children}</div>
      {/* `top-20` clears the 56px nav plus a gap. `self-start` is what makes
          sticky work inside a grid — without it the item stretches to the row
          height and has nothing to stick within. */}
      <aside className="border-border bg-surface flex flex-col gap-4 rounded-lg border p-5 lg:sticky lg:top-20 lg:self-start">
        {summary}
      </aside>
    </div>
  );
}

/**
 * A borderless two-column definition list. Labels left, figures right.
 *
 * `tabular-nums` on every value: a column of proportional digits shimmers as it
 * updates, and this list updates on every slider movement.
 */
export function DetailList({
  rows,
}: Readonly<{
  rows: { label: string; value: ReactNode; key: string }[];
}>) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
      {rows.map((row) => (
        <div className="contents" key={row.key}>
          <dt className="text-muted text-xs">{row.label}</dt>
          <dd className="text-end font-mono text-sm tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Status ─────────────────────────────────────────────────────────────────

/**
 * `custom_models.status`, coloured by what it means to the creator.
 *
 * `color` and `variant` are INDEPENDENT axes on a v3 Chip — `color` carries the
 * semantics, `variant` carries the weight. One prop does not do both.
 */
const STATUS_COLOR: Record<ModelStatus, "default" | "accent" | "success" | "warning" | "danger"> = {
  draft: "default",
  validating: "accent",
  provisioning: "accent",
  smoke_testing: "accent",
  ready: "success",
  paused: "warning",
  failed: "danger",
  auth_failed: "danger",
  deleting: "warning",
  deleted: "default",
};

const STATUS_LABEL: Record<ModelStatus, string> = {
  draft: "Draft",
  validating: "Validating",
  provisioning: "Provisioning",
  smoke_testing: "Measuring",
  ready: "Ready",
  paused: "Paused",
  failed: "Failed",
  auth_failed: "Token rejected",
  deleting: "Deleting",
  deleted: "Deleted",
};

export function ModelStatusChip({ status }: Readonly<{ status: ModelStatus }>) {
  return (
    <Chip color={STATUS_COLOR[status]} size="sm" variant="soft">
      {STATUS_LABEL[status]}
    </Chip>
  );
}

// ─── Page chrome ────────────────────────────────────────────────────────────

export function StudioHeader({
  action,
  description,
  title,
}: Readonly<{
  action?: ReactNode;
  description?: ReactNode;
  title: string;
}>) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-muted max-w-prose text-sm">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
