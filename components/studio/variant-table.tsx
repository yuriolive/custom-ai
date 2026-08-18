"use client";

/**
 * The variant picker — FR-STU-004a.
 *
 * THIS IS A CONSEQUENCE TABLE, NOT A DROPDOWN OF FILENAMES, and the difference
 * is the whole point of the surface. A `Select` of `Qwen3.8-27B-Q4_K_M.gguf`,
 * `…-Q5_K_M.gguf`, `…-IQ2_M.gguf` asks the creator to already know what those
 * strings cost. This table answers it: one row per discovered variant, showing
 * what choosing it DOES — the resolved GPU, the predicted speed, the maximum
 * context that fits, and the cost floor that follows.
 *
 * Rows that violate the creator's own constraints are visibly disabled and
 * carry their specific blocking reason IN THE ROW, not in a tooltip. A tooltip
 * would hide the one piece of information that tells the creator which slider
 * to move.
 *
 * Raw quant tags (`Q4_K_M`) are secondary text in mono, never the row's primary
 * label — the label is the honest quality word from the ladder.
 *
 * Every number in every row came from `resolve_placement()`. Nothing here
 * computes one.
 */

import { Chip, Table } from "@heroui/react";
import type { Selection } from "react-aria-components";

import { formatGiB, formatPricePerMtoken, qualityNote } from "@/lib/studio/format";
import type { Placement, StudioVariant, VariantPlacement } from "@/lib/studio/types";

/**
 * Hardware appears in this column and inside the Deployment Plan, and nowhere
 * else in the product (docs/DESIGN.md §4 item 8). It is a read-only RESULT of
 * the creator's intent — there is no GPU selector on this form, and this column
 * is not one: it cannot be sorted by, filtered on, or chosen.
 */
function gpuCell(placement: Placement): string {
  return placement.feasible ? placement.gpuLabel : "—";
}

function speedCell(placement: Placement): string {
  return placement.feasible ? `${placement.predictedTokensPerSecond}` : "—";
}

/**
 * The largest context this variant can actually serve.
 *
 * NOT derived here. `resolve_placement_batch` probes the solver at the
 * architecture's own ceiling and reports what it says, so this column shows the
 * creator their headroom rather than a bare "it fits" — which answers a
 * question they did not ask and hides the one they did.
 */
function maxContextCell(entry: VariantPlacement | undefined): string {
  if (!entry) return "—";
  if (entry.maxContext !== null && entry.maxContext > 0) {
    return entry.maxContext.toLocaleString("en-US");
  }
  // No architecture ceiling was known, so the only figure available is the one
  // an infeasible envelope carries.
  if (!entry.placement.feasible && entry.placement.maxContextAtThisQuality > 0) {
    return entry.placement.maxContextAtThisQuality.toLocaleString("en-US");
  }
  return "—";
}

export function VariantTable({
  contextLength,
  isLoading,
  onSelect,
  placements,
  selectedId,
  variants,
}: {
  contextLength: number;
  isLoading: boolean;
  onSelect: (id: string) => void;
  /** One entry per deployable variant, keyed by variant id. */
  placements: Map<string, VariantPlacement>;
  selectedId: string | null;
  variants: StudioVariant[];
}) {
  const deployable = variants.filter((v) => v.deployable);

  // Ordered by quality, cheapest first, so the ladder reads as a ladder even
  // though the hardware behind it is not one.
  const ordered = deployable.toSorted((a, b) => (a.bitsPerWeight ?? 99) - (b.bitsPerWeight ?? 99));

  // React Aria owns disabled rows through the collection, not through a prop on
  // the row: `disabledKeys` on the table is what makes a row unselectable by
  // pointer AND by keyboard. Styling a row without this leaves it clickable.
  const disabledKeys = new Set(
    ordered.filter((v) => placements.get(v.id)?.placement.feasible !== true).map((v) => v.id),
  );

  const selection: Selection =
    selectedId && !disabledKeys.has(selectedId) ? new Set([selectedId]) : new Set();

  return (
    <div className="flex flex-col gap-2">
      <Table>
        <Table.ScrollContainer>
          <Table.Content
            aria-label="Quality variants and what each one costs"
            disabledKeys={disabledKeys}
            selectedKeys={selection}
            selectionMode="single"
            onSelectionChange={(keys) => {
              // "all" is unreachable in single-selection mode, and an empty set
              // means the row was toggled off. Neither should clear a required
              // choice, so only a real key changes anything.
              if (keys === "all") return;
              const first = [...keys][0];
              if (typeof first === "string") onSelect(first);
            }}
          >
            <Table.Header>
              <Table.Column isRowHeader>Quality</Table.Column>
              <Table.Column className="text-end">Size</Table.Column>
              {/* The one hardware column in the product, and it is an output. */}
              <Table.Column className="hidden sm:table-cell">Runs on</Table.Column>
              <Table.Column className="text-end">tok/s</Table.Column>
              <Table.Column className="hidden text-end md:table-cell">Max context</Table.Column>
              <Table.Column className="text-end">Cost floor / 1M</Table.Column>
            </Table.Header>
            <Table.Body>
              {ordered.map((variant) => {
                const entry = placements.get(variant.id);
                const placement = entry?.placement;
                const feasible = placement?.feasible === true;
                const note = qualityNote(variant.quantTag);

                return (
                  <Table.Row
                    className={feasible ? undefined : "opacity-50"}
                    id={variant.id}
                    key={variant.id}
                  >
                    <Table.Cell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">
                          {variant.qualityLabel}
                          {variant.family ? (
                            <Chip className="ml-2" color="default" size="sm" variant="soft">
                              {variant.family}
                            </Chip>
                          ) : null}
                        </span>
                        {/* Disclosure only. Never the primary label. */}
                        {variant.quantTag ? (
                          <span className="text-muted font-mono text-xs">{variant.quantTag}</span>
                        ) : null}
                        {/* The blocking reason lives in the row, with its value,
                            because it names the slider to move. */}
                        {placement && !placement.feasible ? (
                          <span className="text-danger text-xs">{placement.blockingReason}</span>
                        ) : note ? (
                          <span className="text-muted hidden text-xs lg:block">{note}</span>
                        ) : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-end tabular-nums">
                      {formatGiB(variant.weightsBytes)}
                    </Table.Cell>
                    <Table.Cell className="text-muted hidden sm:table-cell">
                      {placement ? gpuCell(placement) : "—"}
                    </Table.Cell>
                    <Table.Cell className="text-end tabular-nums">
                      {placement ? speedCell(placement) : "—"}
                    </Table.Cell>
                    <Table.Cell className="hidden text-end tabular-nums md:table-cell">
                      {maxContextCell(entry)}
                    </Table.Cell>
                    <Table.Cell className="text-end tabular-nums">
                      {placement?.feasible
                        ? formatPricePerMtoken(placement.costFloorMicroPerMtoken)
                        : "—"}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>

      <p aria-live="polite" className="text-muted text-xs">
        {isLoading
          ? "Re-solving capacity…"
          : `Speeds and costs are for a ${contextLength.toLocaleString("en-US")}-token context window. Moving the context slider moves every row.`}
      </p>
    </div>
  );
}

/** Variants that resolve today, quality-ordered — the remedy list's source. */
export function feasibleAlternatives(
  variants: StudioVariant[],
  placements: VariantPlacement[],
  excludeId: string | null,
): { id: string; qualityLabel: string }[] {
  const byId = new Map(variants.map((v) => [v.id, v]));
  return placements
    .filter((p) => p.placement.feasible && p.variantId !== excludeId)
    .map((p) => byId.get(p.variantId))
    .filter((v): v is StudioVariant => v !== undefined)
    .toSorted((a, b) => (b.bitsPerWeight ?? 0) - (a.bitsPerWeight ?? 0))
    .map((v) => ({ id: v.id, qualityLabel: v.qualityLabel }));
}
