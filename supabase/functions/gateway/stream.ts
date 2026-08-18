/**
 * supabase/functions/gateway/stream.ts — headers-first SSE proxy with
 * keep-alive, verbatim forwarding, a tee'd usage accumulator, disconnect
 * survival and hard timeouts.
 *
 * Owned by A6. Contract: docs/CONTRACTS.md "Gateway wire contract" 1-3 and 5,
 * PRD FR-GW-040…048.
 *
 * The whole point of this file: a 100 s GPU cold start must be survivable by an
 * ordinary HTTP client. That requires (a) the response headers on the wire
 * BEFORE the upstream fetch resolves, and (b) something on the socket every 5 s
 * while the GPU boots. Everything else here exists so that billing stays
 * correct no matter how the stream ends.
 *
 * Deliberately does NOT import errors.ts (owned by A5): the terminating error
 * frame is built locally from the frozen OpenAIErrorEnvelope shape so this
 * module has zero intra-gateway dependencies.
 */

import type {
  GatewayErrorCode,
  OpenAIErrorEnvelope,
  StreamMeta,
  UsageResult,
} from "../../../packages/shared/types.ts";
import { UsageAccumulator } from "./usage.ts";

const encoder = new TextEncoder();

/** FR-GW-041. */
export const KEEPALIVE_INTERVAL_MS = 5_000;
export const KEEPALIVE_FRAME = ": keepalive\n\n";
/** FR-GW-047 / §4.2.5 defaults. Per-model cold-start budget is 90–300 s. */
export const DEFAULT_COLD_START_BUDGET_MS = 300_000;
export const DEFAULT_TOTAL_BUDGET_MS = 300_000;
/** A first token slower than this means the worker was scaled to zero. */
export const COLD_START_TTFT_THRESHOLD_MS = 5_000;

export interface ProxyStreamOptions {
  /** Budget to FIRST upstream byte. Per-model, 90–300 s. Never hardcode 90 s. */
  coldStartBudgetMs: number;
  /** Budget for the whole stream, measured from proxyStream() entry. */
  totalBudgetMs: number;
  /** Rendered prompt size, for the priority-3 usage estimate (FR-GW-044). */
  estimateFrom?: { promptChars: number };
}

/** SSE response headers. FR-GW-040. */
export function sseHeaders(): Headers {
  return new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/** An error we raise ourselves and can render as a terminating SSE frame. */
export class StreamError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  constructor(code: GatewayErrorCode, message: string, status = 502) {
    super(message);
    this.name = "StreamError";
    this.code = code;
    this.status = status;
  }
}

function envelope(err: unknown): OpenAIErrorEnvelope {
  if (err instanceof StreamError) {
    return {
      error: {
        message: err.message,
        type: err.status === 504 ? "server_error" : "upstream_error",
        param: null,
        code: err.code,
      },
    };
  }
  const code = (err as { code?: GatewayErrorCode } | null)?.code;
  return {
    error: {
      message: err instanceof Error ? err.message : "upstream stream failed",
      type: "server_error",
      param: null,
      // Anything unclassified is an internal error; never invent a billing code.
      code: (code ?? "internal_error") as GatewayErrorCode,
    },
  };
}

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * Race a promise against a deadline. On expiry the returned promise rejects
 * with a StreamError; the losing read is abandoned (we tear the reader down
 * immediately afterwards, so no bytes are silently dropped from a live stream).
 */
function withDeadline<T>(p: Promise<T>, ms: number, err: StreamError): Promise<T> {
  if (!Number.isFinite(ms)) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(err), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Proxy an upstream SSE response to the client.
 *
 * The returned Response is constructed synchronously — its headers are on the
 * wire before `upstreamPromise` settles (FR-GW-040).
 *
 * `onComplete` fires exactly once on EVERY path: normal end, upstream error,
 * cold-start timeout, total-stream timeout, and client disconnect. Settlement
 * therefore lives outside the client-write path (FR-GW-046, contract rule 5).
 */
export function proxyStream(
  upstreamPromise: Promise<Response>,
  onComplete: (usage: UsageResult, meta: StreamMeta) => void,
  opts: ProxyStreamOptions,
): Response {
  const coldStartBudgetMs = opts.coldStartBudgetMs ?? DEFAULT_COLD_START_BUDGET_MS;
  const totalBudgetMs = opts.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const usage = new UsageAccumulator({ promptChars: opts.estimateFrom?.promptChars ?? 0 });
  const t0 = now();

  let firstByte = false;
  let clientGone = false;
  let ttftMs: number | null = null;
  let settled = false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const settle = (): void => {
    if (settled) return; // onComplete fires exactly once.
    settled = true;
    const durationMs = now() - t0;
    onComplete(usage.result(), {
      ttftMs,
      durationMs,
      // A stream that never produced a first byte and ran past the threshold is
      // a cold start that failed — recording it as warm would hide the cost.
      coldStart: (ttftMs ?? durationMs) > COLD_START_TTFT_THRESHOLD_MS,
      clientGone,
    });
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Writes to the client. Every client write goes through here so a
      // disconnect can never take down the drain loop (FR-GW-045).
      const write = (bytes: Uint8Array): void => {
        if (clientGone) return;
        try {
          controller.enqueue(bytes);
        } catch {
          clientGone = true; // Client left. Keep draining upstream: it is billable.
        }
      };

      // ── Phase 1: hold the socket open while the GPU cold-starts ───────────
      keepAlive = setInterval(() => {
        if (firstByte || clientGone) return; // FR-GW-042: stops, never resumes.
        write(encoder.encode(KEEPALIVE_FRAME));
      }, KEEPALIVE_INTERVAL_MS);

      // Run the pump detached: `start` must not block Response construction,
      // which is what puts the headers on the wire before upstream resolves.
      void (async () => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const remainingTotal = () => totalBudgetMs - (now() - t0);
          const coldDeadline = () =>
            Math.min(coldStartBudgetMs - (now() - t0), remainingTotal());

          const upstream = await withDeadline(
            upstreamPromise,
            coldDeadline(),
            new StreamError(
              "cold_start_timeout",
              "Upstream did not respond within the cold-start budget",
              504,
            ),
          );
          if (!upstream.ok) {
            throw new StreamError(
              "internal_error",
              `Upstream returned HTTP ${upstream.status}`,
              upstream.status,
            );
          }
          if (!upstream.body) {
            throw new StreamError("internal_error", "Upstream returned no body");
          }

          reader = upstream.body.getReader();
          const decoder = new TextDecoder(); // streaming: carries partial UTF-8
          let carry = "";

          // Feed one SSE line to the usage accumulator (tee branch B).
          const ingestLine = (rawLine: string): void => {
            // SSE allows CRLF; strip a trailing CR before anything else.
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            if (!line.startsWith("data:")) return; // comments, blank lines, other fields
            // The single space after the colon is OPTIONAL in SSE. Some
            // llama.cpp builds and proxies emit `data:{...}`.
            const payload = line.slice(5);
            usage.ingest(payload);
          };

          // ── Phase 2: forward verbatim, sniff usage in parallel ────────────
          for (;;) {
            const budget = firstByte ? remainingTotal() : coldDeadline();
            const expired = firstByte
              ? new StreamError(
                "stream_timeout",
                "Upstream stream exceeded the total time budget",
                504,
              )
              : new StreamError(
                "cold_start_timeout",
                "Upstream produced no tokens within the cold-start budget",
                504,
              );

            const { done, value } = await withDeadline(reader.read(), budget, expired);
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            if (!firstByte) {
              firstByte = true;
              clearInterval(keepAlive);
              ttftMs = now() - t0;
            }

            // Branch A — client. VERBATIM bytes, zero transformation.
            write(value);

            // Branch B — usage accumulator, line-buffered across chunk
            // boundaries and across split multi-byte UTF-8 sequences.
            carry += decoder.decode(value, { stream: true });
            const lines = carry.split("\n");
            carry = lines.pop() ?? "";
            for (const line of lines) ingestLine(line);
          }

          // Flush the decoder and the final partial line. Upstreams that end
          // without a trailing newline would otherwise drop their LAST frame —
          // which is exactly the frame that carries usage.
          carry += decoder.decode();
          if (carry.length > 0) ingestLine(carry);
        } catch (err) {
          // FR-GW-047: the client must see a cause, never a dead socket.
          const frame = `data: ${JSON.stringify(envelope(err))}\n\n`;
          write(encoder.encode(frame));
          write(encoder.encode("data: [DONE]\n\n"));
          // Tear down upstream so a timed-out request stops burning GPU time.
          try {
            await reader?.cancel();
          } catch {
            /* already gone */
          }
        } finally {
          clearInterval(keepAlive);
          try {
            controller.close();
          } catch {
            /* already closed or cancelled */
          }
          // ── Phase 3: settle, deliberately OUTSIDE the client write path.
          settle();
        }
      })();
    },

    /**
     * The client hung up. In Deno/Workers this — not an enqueue throw — is the
     * signal that actually fires. We do NOT abort the pump: the GPU work is
     * real and must be billed (FR-GW-045).
     */
    cancel() {
      clientGone = true;
    },
  });

  return new Response(body, { status: 200, headers: sseHeaders() });
}
