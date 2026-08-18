"use client";

/**
 * The Deployment Plan — FR-STU-004b, FR-STU-004d, docs/DESIGN.md §3.9 / §3.11.
 *
 * This card is the creator's ENTIRE window into hardware, and the boundary is
 * exact: a GPU name appears here as a read-only RESULT, because the creator is
 * accountable for the cost floor it implies. It is never an input — there is no
 * GPU selector on this form — and it never travels outward to the catalog, a
 * model card, the playground or the console (DESIGN.md §4 item 8).
 *
 * THE SHAPE RULE THAT MAKES THE STICKY PANEL WORK (§3.9): the empty state and
 * the resolved state occupy the same slot and are the same shape, so the panel
 * does not resize as the form becomes valid. The detail list reserves its rows
 * rather than growing into them. A summary panel that jumps as the user types
 * is worse than no summary panel.
 *
 * Every figure below is `resolve_placement()`'s output, transcribed. There is
 * no arithmetic in this file.
 */

import { Alert, Button, Disclosure } from "@heroui/react";

import { formatMicroUsd } from "@/lib/format";
import {
  formatContext,
  formatGiB,
  formatPricePerMtoken,
  formatSeconds,
  formatTokensPerSecond,
} from "@/lib/studio/format";
import type { Placement } from "@/lib/studio/types";
import type { Remedy } from "@/lib/studio/placement";

import { DetailList } from "./primitives";

/** Six rows, always six rows. See the shape rule above. */
const PLACEHOLDER_ROWS = [
  { key: "quality", label: "Quality", value: "—" },
  { key: "speed", label: "Predicted speed", value: "—" },
  { key: "streams", label: "Concurrent streams", value: "—" },
  { key: "weights", label: "Weights", value: "—" },
  { key: "kv", label: "KV cache", value: "—" },
  { key: "floor", label: "Cost floor / 1M", value: "—" },
];

export function DeploymentPlan({
  contextLength,
  isSolving,
  onApplyRemedy,
  placement,
  qualityLabel,
  remedies,
}: Readonly<{
  contextLength: number;
  isSolving: boolean;
  onApplyRemedy: (remedy: Remedy) => void;
  placement: Placement | null;
  qualityLabel: string | null;
  remedies: Remedy[];
}>) {
  return (
    <>
      <h2 className="text-base font-semibold tracking-tight">Deployment plan</h2>

      <PlanBody
        contextLength={contextLength}
        isSolving={isSolving}
        onApplyRemedy={onApplyRemedy}
        placement={placement}
        qualityLabel={qualityLabel}
        remedies={remedies}
      />
    </>
  );
}

/**
 * The panel has exactly three states and they are mutually exclusive: nothing
 * probed yet, a resolved plan, or no configuration that fits. Written as early
 * returns rather than a stacked ternary so each state reads on its own.
 */
function PlanBody({
  contextLength,
  isSolving,
  onApplyRemedy,
  placement,
  qualityLabel,
  remedies,
}: Readonly<{
  contextLength: number;
  isSolving: boolean;
  onApplyRemedy: (remedy: Remedy) => void;
  placement: Placement | null;
  qualityLabel: string | null;
  remedies: Remedy[];
}>) {
  if (placement === null) return <EmptyBody isSolving={isSolving} />;

  if (placement.feasible) {
    return (
      <FeasibleBody
        contextLength={contextLength}
        placement={placement}
        qualityLabel={qualityLabel}
      />
    );
  }

  return <InfeasibleBody onApplyRemedy={onApplyRemedy} placement={placement} remedies={remedies} />;
}

/**
 * The empty state, written to the same length as the resolved summary's first
 * line so the panel is the same height before and after (§3.9). It is a
 * sentence, never a spinner: a spinner in this slot claims work is in flight
 * when nothing has been typed yet.
 */
function EmptyBody({ isSolving }: Readonly<{ isSolving: boolean }>) {
  return (
    <>
      <p className="text-muted text-sm">
        {isSolving
          ? "Solving capacity for this repository…"
          : "Enter a Hugging Face repository to see the hardware, speed and cost floor your settings resolve to."}
      </p>
      <DetailList rows={PLACEHOLDER_ROWS} />
    </>
  );
}

function FeasibleBody({
  contextLength,
  placement,
  qualityLabel,
}: Readonly<{
  contextLength: number;
  placement: Extract<Placement, { feasible: true }>;
  qualityLabel: string | null;
}>) {
  return (
    <>
      {/* The resolved silicon, named plainly and once. The sentence is built
          from explicit fragments rather than wrapped JSX text, so no line break
          can silently become — or stop being — a space. */}
      <p className="text-sm">
        <span>{"Runs on "}</span>
        <span className="font-medium">{placement.gpuLabel}</span>
        <span>{" at "}</span>
        <span className="tabular-nums">
          {formatTokensPerSecond(placement.predictedTokensPerSecond)}
        </span>
        <span>{"."}</span>
      </p>

      <DetailList
        rows={[
          { key: "quality", label: "Quality", value: qualityLabel ?? "—" },
          {
            key: "speed",
            label: "Predicted speed",
            value: formatTokensPerSecond(placement.predictedTokensPerSecond),
          },
          {
            key: "streams",
            label: "Concurrent streams",
            value: String(placement.maxConcurrentStreams),
          },
          // The VRAM breakdown is three rows of one figure each, not a chart.
          // A three-segment bar of three numbers is decoration.
          { key: "weights", label: "Weights", value: formatGiB(placement.weightsBytes) },
          {
            key: "kv",
            label: `KV cache @ ${formatContext(contextLength)}`,
            value: formatGiB(placement.kvBytesTotal),
          },
          {
            key: "floor",
            label: "Cost floor / 1M",
            value: formatPricePerMtoken(placement.costFloorMicroPerMtoken),
          },
        ]}
      />

      {/* The predicted figure is not what the catalog will show. Saying so here
          is cheaper than a creator discovering it on their own model card. */}
      <p className="text-muted text-xs">
        Predicted from memory bandwidth. The marketplace shows the speed measured on the real worker
        after deployment, never this one.
      </p>

      <WhyThisGpu placement={placement} />
    </>
  );
}

/**
 * FR-STU-004d. The Alert names the specific blocking quantity WITH its value,
 * and each remedy is a button that APPLIES itself to the form — a remedy the
 * creator has to translate into a slider movement themselves is only half a
 * remedy.
 *
 * The Alert IS the reason the CTA is disabled, so no separate hint line is
 * added below the button (§3.9 disabled-CTA discipline).
 */
function InfeasibleBody({
  onApplyRemedy,
  placement,
  remedies,
}: Readonly<{
  onApplyRemedy: (remedy: Remedy) => void;
  placement: Extract<Placement, { feasible: false }>;
  remedies: Remedy[];
}>) {
  return (
    <>
      <Alert status="danger">
        <Alert.Content>
          <Alert.Title>No configuration fits</Alert.Title>
          <Alert.Description>{placement.blockingReason}</Alert.Description>
        </Alert.Content>
      </Alert>

      {remedies.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted text-xs">Apply one of these:</p>
          <div className="flex flex-wrap gap-2">
            {remedies.map((remedy) => (
              <Button
                key={`${remedy.kind}:${remedy.value}`}
                onPress={() => onApplyRemedy(remedy)}
                size="sm"
                variant="tertiary"
              >
                {remedy.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <WhyThisGpu placement={placement} />
    </>
  );
}

/**
 * FR-STU-004b's own wording, collapsed by default.
 *
 * The panel shows what the solver actually did: every tier it considered and
 * why each was accepted or rejected. This is the answer to the question the
 * absent GPU selector provokes — and it is also the argument for the selector's
 * absence, because the list makes the non-ladder visible: on the MVP's own
 * target an L40S has twice a 4090's VRAM and is SLOWER, at twice the price.
 *
 * `Disclosure.Content` / `Disclosure.Body`, not `Disclosure.Panel` — the PRD's
 * §4.1.2 sketch says `Panel` and no such subcomponent exists in 3.2.4.
 */
function WhyThisGpu({ placement }: Readonly<{ placement: Placement }>) {
  return (
    <Disclosure>
      <Disclosure.Trigger className="text-accent text-sm">Why this GPU?</Disclosure.Trigger>
      <Disclosure.Content>
        <Disclosure.Body className="flex flex-col gap-3 pt-2">
          {placement.feasible ? (
            <>
              <p className="text-muted text-sm">
                The cheapest tier that both fits the weights and meets your minimum speed. Decode
                speed is bounded by memory bandwidth, so it depends on how many bytes are read per
                token — not on how much memory a card has.
              </p>
              <DetailList
                rows={[
                  {
                    key: "usable",
                    label: "Usable VRAM",
                    value: formatGiB(placement.usableVramBytes),
                  },
                  {
                    key: "overhead",
                    label: "Framework overhead",
                    value: formatGiB(placement.overheadBytes),
                  },
                  {
                    key: "ssm",
                    label: "Recurrent state / stream",
                    value:
                      placement.ssmStateBytesPerSeq > 0
                        ? formatGiB(placement.ssmStateBytesPerSeq)
                        : "none",
                  },
                  {
                    key: "attn",
                    label: "Layers holding KV",
                    value: `${placement.nAttentionLayers} of ${placement.nLayers}`,
                  },
                  {
                    key: "cold",
                    label: "Cold-start budget",
                    value: formatSeconds(placement.coldStartBudgetS),
                  },
                  {
                    key: "hourly",
                    label: "Hardware cost / hour",
                    value: formatMicroUsd(placement.usdPerHourMicro),
                  },
                ]}
              />
              {placement.needsVolume ? (
                <p className="text-muted text-xs">
                  These weights exceed the node cache threshold, so a {placement.volumeGb} GB
                  network volume is provisioned to hold them. That volume is a standing monthly cost
                  — the one place &ldquo;$0 idle&rdquo; is not literal.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted text-sm">
              No tier satisfied both constraints. Every candidate and the reason it was rejected is
              below.
            </p>
          )}

          <div className="flex flex-col gap-1">
            {placement.considered.map((tier) => (
              <div className="flex items-baseline justify-between gap-3 text-xs" key={tier.tier}>
                <span className={tier.accepted ? "text-foreground" : "text-muted"}>
                  {tier.tier}
                </span>
                <span className="text-muted text-end tabular-nums">
                  {tier.predictedTokensPerSecond} tok/s · {tier.reason}
                </span>
              </div>
            ))}
          </div>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
