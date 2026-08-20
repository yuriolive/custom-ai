"use client";

import type { RefObject } from "react";
import { useLayoutEffect } from "react";

import { ArrowUpIcon, StopIcon } from "@/components/chat/icons";

const MAX_ROWS = 10;
const LINE_HEIGHT_PX = 24;
const VERTICAL_PADDING_PX = 24;

/**
 * The composer.
 *
 * One rounded field with the send control inside it, which is what every chat
 * product in this category converged on and is not a style choice: the box IS
 * the affordance, so a button floating outside it reads as page furniture
 * rather than as the way to send.
 *
 * A native `<textarea>`, not HeroUI's `TextArea`. The component draws its own
 * border, ring and background, and nesting it here produces a box inside a box.
 * It also has no `minRows`/`maxRows`, so the auto-grow below would be needed
 * either way.
 */
export function Composer({
  inputRef: ref,
  isBusy,
  onChange,
  onStop,
  onSubmit,
  value,
}: Readonly<{
  /** Owned by the parent so a suggestion press can hand the caret over. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  isBusy: boolean;
  onChange: (value: string) => void;
  onStop: () => void;
  onSubmit: () => void;
  value: string;
}>) {

  // Grow to `MAX_ROWS`, then scroll inside.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const max = MAX_ROWS * LINE_HEIGHT_PX + VERTICAL_PADDING_PX;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [value]);

  const canSend = value.trim().length > 0 && !isBusy;

  return (
    <form
      className="border-border bg-surface focus-within:border-muted flex items-end gap-2 rounded-3xl border p-2 pl-4 transition-colors"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        aria-label="Message"
        className="text-foreground placeholder:text-muted max-h-[16rem] min-h-[2.75rem] flex-1 resize-none bg-transparent py-2.5 text-sm leading-6 outline-none"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Ask anything…"
        ref={ref}
        rows={1}
        value={value}
      />

      {isBusy ? (
        <button
          aria-label="Stop generating"
          className="bg-foreground text-background flex size-9 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-90"
          onClick={onStop}
          type="button"
        >
          <StopIcon className="size-3.5" />
        </button>
      ) : (
        <button
          aria-label="Send message"
          className="bg-accent text-accent-foreground flex size-9 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-40"
          disabled={!canSend}
          type="submit"
        >
          <ArrowUpIcon className="size-4" />
        </button>
      )}
    </form>
  );
}
