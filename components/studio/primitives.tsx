"use client";

/**
 * Shared Creator Studio pieces: the sticky-summary shell, the field label with
 * an accessible explanation affordance, the definition list the summary carries,
 * and the model status chip.
 *
 * `"use client"` because everything here touches `@heroui/react`, whose barrel
 * is client-only (PRD §4.1.0).
 */

import { Chip, Tooltip } from "@heroui/react";
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
      <aside className="border-default bg-surface flex flex-col gap-4 rounded-lg border p-5 lg:sticky lg:top-20 lg:self-start">
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

/**
 * A field label with an ⓘ affordance opening a Tooltip.
 *
 * The trigger is a real `<button>` rather than a `title` attribute or a bare
 * span: a tooltip that only exists on hover is unreachable by keyboard and
 * invisible on touch. `type="button"` because this lives inside a form and a
 * bare button submits it.
 *
 * This is NOT a HeroUI `Label` — the field's own `Label` is rendered by the
 * caller inside its `TextField`/`Slider`, and nesting two labels for one input
 * gives the field two accessible names.
 */
export function LabelHint({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Tooltip>
      {/* `render` swaps the trigger's default <div> for a real <button>. The
          default is not focusable, so the tooltip would be keyboard-unreachable
          — which is the entire reason this is not a `title` attribute.
          `type="button"` because this lives inside a form, where a bare button
          submits it. */}
      <Tooltip.Trigger<"button">
        aria-label="What this means"
        className="text-muted hover:text-foreground focus-visible:ring-accent inline-flex size-4 shrink-0 items-center justify-center rounded-full align-middle transition-colors focus-visible:ring-2 focus-visible:outline-none"
        render={(props) => <button {...props} type="button" />}
      >
        <svg
          aria-hidden="true"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
        </svg>
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-64 text-xs">{children}</Tooltip.Content>
    </Tooltip>
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
