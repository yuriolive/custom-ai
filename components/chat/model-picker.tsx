"use client";

import { Modal, useOverlayState } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";

import { CreatorBadge } from "@/components/chat/creator-badge";
import { CheckIcon, ChevronUpDownIcon, SearchIcon } from "@/components/chat/icons";
import { formatContext, formatPricePerMtoken, formatSpeed } from "@/components/marketplace/format";
import type { CatalogModel } from "@/components/marketplace/types";
import { QUOTED_EXCHANGES, quotedExchangesMicroUsd } from "@/lib/chat/models";
import { formatMicroUsd } from "@/lib/format";

/**
 * The only decision this surface asks the user to make (FR-CHAT-002).
 *
 * A PILL that opens a searchable palette, not a form control. Two reasons, both
 * visible the moment the catalog grows past a handful of rows: a dropdown of
 * hundreds of models is unusable without search, and a `<Select>` sitting in the
 * page chrome reads as a setting to configure before starting — which is exactly
 * the impression this surface exists to avoid. The pill says what you are
 * talking to; pressing it asks what you would rather talk to.
 *
 * The numbers a shopper decides on — speed, context, price — live INSIDE the
 * palette rows, next to the model they describe, rather than as a permanent
 * line of small print under the header.
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
  /**
   * `useOverlayState` rather than a bare `useState` wired to `isOpen`.
   *
   * HeroUI's `Modal` root is React Aria's `DialogTrigger`, which expects a
   * [trigger, overlay] child pair. This one has no trigger child — the pill
   * lives outside it — so the root treats the backdrop as the trigger and
   * wraps it in a press responder, and a press anywhere inside the dialog
   * re-opens it as fast as the row handler closes it. Handing the root the
   * state object directly is the documented escape hatch and makes close()
   * authoritative.
   */
  const overlay = useOverlayState();
  const [query, setQuery] = useState("");
  const selected = models.find((model) => model.modelId === selectedId) ?? null;

  // ⌘K / Ctrl+K, the shortcut every palette in this category uses. Bound on the
  // window so it works with focus in the composer, which is where it always is.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      overlay.toggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return models;
    return models.filter((model) =>
      `${model.displayName} ${model.creatorHandle} ${model.modelId}`.toLowerCase().includes(needle),
    );
  }, [models, query]);

  return (
    <>
      <button
        aria-haspopup="dialog"
        className="border-border bg-surface hover:border-muted text-foreground flex max-w-full min-w-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors"
        onClick={() => overlay.open()}
        type="button"
      >
        {selected ? <CreatorBadge handle={selected.creatorHandle} /> : null}
        <span className="truncate font-medium">
          {selected ? selected.displayName : "Choose a model"}
        </span>
        {selected ? (
          <span className="text-muted hidden truncate text-xs sm:inline">
            {selected.creatorHandle}
          </span>
        ) : null}
        <ChevronUpDownIcon className="text-muted size-3.5" />
      </button>

      {/*
        MOUNTED ONLY WHILE OPEN, with a bare `isOpen`.

        `Modal` is React Aria's `DialogTrigger`, which pairs [trigger, overlay]
        children. This one has no trigger child — the pill lives outside it, so
        the palette can be opened by ⌘K as well — and in that shape the root
        treats the backdrop as its trigger and never gets an overlay to unmount.
        Passing `isOpen={false}` to a mounted Modal therefore does nothing: the
        dialog opens once and then ignores Escape, an outside click and the row
        press alike (measured, not assumed).

        Conditional mounting sidesteps it entirely and is the pattern the
        working dialogs in this app already use — see `model-dialogs.tsx`, which
        passes a bare `isOpen` for the same reason.
      */}
      {overlay.isOpen ? (
        <Modal
          isOpen
          onOpenChange={(open) => {
            overlay.setOpen(open);
            if (!open) setQuery("");
          }}
        >
          <Modal.Backdrop>
            <Modal.Container size="lg">
              <Modal.Dialog>
                <Modal.Header>
                  <Modal.Heading>Choose a model</Modal.Heading>
                </Modal.Header>

                <Modal.Body className="flex flex-col gap-3">
                  <div className="border-border focus-within:border-muted flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors">
                    <SearchIcon className="text-muted" />
                    {/* A plain input: this one lives inside its own bordered row,
                      and HeroUI's TextField would draw a second box around it. */}
                    <input
                      aria-label="Search models"
                      autoFocus
                      className="text-foreground placeholder:text-muted min-w-0 flex-1 bg-transparent text-sm outline-none"
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search by model or creator…"
                      value={query}
                    />
                    <span className="text-muted shrink-0 text-xs tabular-nums">
                      {results.length} of {models.length}
                    </span>
                  </div>

                  <ul className="max-h-[min(26rem,60dvh)] overflow-y-auto">
                    {results.length === 0 ? (
                      <li className="text-muted px-2 py-6 text-center text-sm">
                        Nothing matches “{query.trim()}”.
                      </li>
                    ) : (
                      results.map((model) => {
                        const isSelected = model.modelId === selectedId;
                        return (
                          <li key={model.modelId}>
                            <button
                              className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors ${
                                isSelected ? "bg-surface" : "hover:bg-surface"
                              }`}
                              onClick={() => {
                                onSelect(model.modelId);
                                overlay.close();
                                setQuery("");
                              }}
                              type="button"
                            >
                              <CreatorBadge handle={model.creatorHandle} size="md" />
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="truncate text-sm font-medium">
                                  {model.displayName}
                                </span>
                                <span className="text-muted truncate text-xs tabular-nums">
                                  {model.creatorHandle} ·{" "}
                                  {formatSpeed(model.measuredTokensPerSecond)} ·{" "}
                                  {formatContext(model.contextLength)} context ·{" "}
                                  {formatPricePerMtoken(model.priceCompletionMicroPerMtoken)} / 1M
                                  out
                                </span>
                              </span>
                              {isSelected ? <CheckIcon className="text-accent" /> : null}
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                </Modal.Body>

                <Modal.Footer>
                  <p className="text-muted text-xs">
                    Every model here is published by a creator and billed per token from your
                    wallet. Nothing is charged for the time a worker spends waking up.
                  </p>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * The one-line honesty strip under the composer.
 *
 * It replaces the paragraph of small print that used to sit under the model
 * control. Same three facts — what it costs, that the wallet pays, that an idle
 * model is slow to start — in the place every product in this category puts its
 * disclaimer, where it is readable and not in the way.
 */
export function ModelFooterNote({
  coldStartSeconds,
  model,
}: Readonly<{ coldStartSeconds: number; model: CatalogModel | null }>) {
  if (!model) {
    return (
      <p className="text-muted text-center text-xs">
        Pick a model to start. Replies are AI-generated — check anything you rely on.
      </p>
    );
  }

  return (
    <p className="text-muted text-center text-xs tabular-nums">
      about {formatMicroUsd(quotedExchangesMicroUsd(model))} per {QUOTED_EXCHANGES} exchanges,
      billed per token from your wallet · first reply takes ~{coldStartSeconds}s if the model is
      idle · replies are AI-generated
    </p>
  );
}
