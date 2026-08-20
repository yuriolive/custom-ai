"use client";

import { ListBox, Select } from "@heroui/react";

import { formatContext, formatPricePerMtoken, formatSpeed } from "@/components/marketplace/format";
import type { CatalogModel } from "@/components/marketplace/types";
import { QUOTED_EXCHANGES, quotedExchangesMicroUsd } from "@/lib/chat/models";
import { formatMicroUsd } from "@/lib/format";
import { publicEnv } from "@/lib/public-env";

/**
 * The only decision this surface asks the user to make (FR-CHAT-002).
 *
 * Labelled by CREATOR first. On a marketplace the creator is the brand — the
 * whole point of the catalog is that someone published this — and a picker that
 * showed bare model names would erase the supply side the product depends on.
 *
 * NO HARDWARE, and no quantization tag. A chat user is choosing between "fast
 * and cheap" and "slower and better"; which silicon and which quant deliver
 * that is the platform's problem (FR-MKT-002).
 */
export function ModelPicker({
  models,
  onSelect,
  selectedId,
}: Readonly<{
  models: CatalogModel[];
  onSelect: (modelId: string) => void;
  selectedId: string | null;
}>) {
  const selected = models.find((model) => model.modelId === selectedId) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Select
        aria-label="Model"
        className="w-full min-w-0 sm:w-auto sm:min-w-72"
        selectedKey={selectedId}
        onSelectionChange={(key) => onSelect(String(key))}
      >
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>

        <Select.Popover className="max-w-[min(28rem,calc(100vw-2rem))]">
          <ListBox>
            {models.map((model) => (
              <ListBox.Item
                id={model.modelId}
                key={model.modelId}
                textValue={`${model.displayName} by ${model.creatorHandle}`}
              >
                <div className="flex min-w-0 flex-col gap-0.5 py-0.5">
                  <span className="truncate text-sm font-medium">{model.displayName}</span>
                  <span className="text-muted truncate text-xs">
                    {model.creatorHandle} · {formatSpeed(model.measuredTokensPerSecond)} ·{" "}
                    {formatContext(model.contextLength)} context
                  </span>
                </div>
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>

      {selected ? (
        <p className="text-muted text-xs tabular-nums">
          {/* A per-million-token price is not a number anyone holds in their
              head. What an afternoon of use costs is. The assumption is stated
              rather than hidden, and it rounds the way the bill rounds. */}
          about {formatMicroUsd(quotedExchangesMicroUsd(selected))} per {QUOTED_EXCHANGES}{" "}
          exchanges of ~500 words each way ·{" "}
          {formatPricePerMtoken(selected.priceCompletionMicroPerMtoken)} per 1M output tokens ·
          first reply can take ~{publicEnv.coldStartEstimateSeconds}s while a worker starts
        </p>
      ) : null}
    </div>
  );
}
