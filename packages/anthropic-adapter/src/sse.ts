/**
 * SSE framing helpers. Pure string work — no I/O, no streams API dependency, so
 * the same code runs under Deno's Edge runtime and Node's test runner.
 */

import type { AnthropicStreamEvent } from "./types.ts";

/**
 * Serialize one Anthropic stream event as an SSE frame.
 *
 * Anthropic frames carry BOTH a named `event:` line and a `data:` line whose JSON
 * repeats the same name in its `type` field. Clients key off the `event:` line;
 * the Anthropic SDKs additionally validate `data.type`. Emitting only one of the
 * two breaks one class of client or the other.
 */
export function formatSseEvent(event: AnthropicStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatSseEvents(events: readonly AnthropicStreamEvent[]): string {
  let out = "";
  for (const e of events) out += formatSseEvent(e);
  return out;
}

/**
 * Incremental decoder for an OpenAI SSE body.
 *
 * `push()` accepts an arbitrary slice of the response body — network chunk
 * boundaries fall inside frames and even inside individual JSON tokens — and
 * returns the `data:` payloads that completed within it. `[DONE]` is surfaced as
 * the literal string so the caller can distinguish end-of-stream from a chunk.
 */
export interface SseDecoder {
  push(text: string): string[];
  /** Any trailing frame not terminated by a blank line. */
  flush(): string[];
}

export function createSseDecoder(): SseDecoder {
  let buffer = "";

  const drain = (final: boolean): string[] => {
    const out: string[] = [];
    // Frames end at a blank line; tolerate both \n\n and \r\n\r\n.
    const normalized = buffer.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n\n");
    const tail = final ? "" : (parts.pop() ?? "");
    if (final) buffer = "";
    else buffer = tail;

    for (const frame of parts) {
      if (frame.trim().length === 0) continue;
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        // `:` comment lines are keepalives (CONTRACTS.md #2) — not payload.
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) out.push(data.join("\n"));
    }
    return out;
  };

  return {
    push(text: string): string[] {
      buffer += text;
      return drain(false);
    },
    flush(): string[] {
      return drain(true);
    },
  };
}

/** True for the OpenAI end-of-stream sentinel. */
export function isDoneSentinel(payload: string): boolean {
  return payload.trim() === "[DONE]";
}
