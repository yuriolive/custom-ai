/**
 * supabase/functions/gateway/usage.ts — usage extraction & estimation.
 *
 * Owned by A6. See docs/CONTRACTS.md and PRD FR-GW-044 / 044a / 044b / 044c.
 *
 * A completed stream is NEVER left unbilled. Extraction runs in priority order:
 *
 *   1. `usage` object on the terminal chunk (vLLM w/ stream_options.include_usage)
 *      -> source: "upstream"   [authoritative]
 *   2. usage on a NON-STANDARD trailing frame (llama.cpp builds): `timings`,
 *      or top-level `tokens_evaluated` / `tokens_predicted`
 *      -> source: "upstream"   [authoritative — the worker counted real tokens]
 *   3. ESTIMATE from characters: prompt from `estimateFrom.promptChars`,
 *      completion from accumulated delta characters, both / 3.5
 *      -> source: "estimated"  [flags the transaction; EXPECTED for GGUF]
 *
 * Runtime-free and dependency-free so both Deno and Node can import it.
 */

import type { UsageResult } from "../../../packages/shared/types.ts";

/** Coarse chars-per-token ratio for the fallback estimator (FR-GW-044). */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Lower number == higher authority. Mirrors FR-GW-044's priority list.
 * Deliberately a const object, not a TS `enum`: both Deno and node's native
 * type-stripping loader reject non-erasable syntax.
 */
export const UsagePriority = {
  Standard: 1, // vLLM-style `usage` object
  NonStandard: 2, // llama.cpp `timings` / tokens_evaluated
  Estimated: 3, // characters / 3.5
} as const;

export type UsagePriorityValue = (typeof UsagePriority)[keyof typeof UsagePriority];

export interface ExtractedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  priority: UsagePriorityValue;
}

// ─── low-level helpers ───────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Non-negative finite integer-ish number, else null. Never coerces strings. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/**
 * `prompt_tokens_details.cached_tokens` (FR-GW-044a).
 * ABSENT MEANS 0, NOT NULL: "no cache hit reported" is a measurement, and is
 * distinct from "unknown". llama.cpp never reports it => always 0 there.
 */
function cachedTokensOf(usage: Record<string, unknown>): number {
  const details = usage["prompt_tokens_details"];
  if (isRecord(details)) {
    const n = num(details["cached_tokens"]);
    if (n !== null) return n;
  }
  // Some proxies flatten it.
  const flat = num(usage["cached_tokens"]);
  return flat ?? 0;
}

// ─── Priority 1: standard OpenAI usage object ────────────────────────────────

function fromStandardUsage(usage: unknown): ExtractedUsage | null {
  if (!isRecord(usage)) return null;
  const prompt = num(usage["prompt_tokens"]);
  const completion = num(usage["completion_tokens"]);
  if (prompt === null && completion === null) return null;
  // An all-zero usage object carries no information; let a later frame or the
  // estimator speak instead of billing zero.
  if ((prompt ?? 0) + (completion ?? 0) === 0) return null;
  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    cachedPromptTokens: cachedTokensOf(usage),
    priority: UsagePriority.Standard,
  };
}

// ─── Priority 2: non-standard trailing frames (llama.cpp variants) ───────────

/**
 * llama.cpp's OpenAI-compatible route is build-dependent (FR-GW-044b). Observed
 * shapes, all of which are real token counts and therefore authoritative:
 *   { timings: { prompt_n, predicted_n, ... } }
 *   { tokens_evaluated, tokens_predicted }
 * Either can appear at the top level of a trailing frame or inside choices[0].
 */
function fromNonStandard(obj: Record<string, unknown>): ExtractedUsage | null {
  const carriers: Record<string, unknown>[] = [obj];
  const choices = obj["choices"];
  if (Array.isArray(choices)) {
    for (const c of choices) if (isRecord(c)) carriers.push(c);
  }

  for (const c of carriers) {
    const timings = c["timings"];
    if (isRecord(timings)) {
      const prompt = num(timings["prompt_n"]) ?? num(timings["n_prompt_tokens"]);
      const completion = num(timings["predicted_n"]) ?? num(timings["n_decoded"]);
      if ((prompt ?? 0) + (completion ?? 0) > 0) {
        return {
          promptTokens: prompt ?? 0,
          completionTokens: completion ?? 0,
          cachedPromptTokens: 0, // llama.cpp does not report cache hits (FR-BIL-041a)
          priority: UsagePriority.NonStandard,
        };
      }
    }
    const evaluated = num(c["tokens_evaluated"]);
    const predicted = num(c["tokens_predicted"]);
    if ((evaluated ?? 0) + (predicted ?? 0) > 0) {
      return {
        promptTokens: evaluated ?? 0,
        completionTokens: predicted ?? 0,
        cachedPromptTokens: 0,
        priority: UsagePriority.NonStandard,
      };
    }
  }
  return null;
}

/**
 * Extract usage from one already-parsed SSE data payload, priority 1 then 2.
 * Returns null when the frame carries no usage at all (the common case).
 */
export function extractUsage(obj: unknown): ExtractedUsage | null {
  if (!isRecord(obj)) return null;
  return fromStandardUsage(obj["usage"]) ?? fromNonStandard(obj);
}

/** Characters contributed by one chunk's deltas, for the estimator. */
export function deltaChars(obj: unknown): number {
  if (!isRecord(obj)) return 0;
  const choices = obj["choices"];
  if (!Array.isArray(choices)) return 0;
  let n = 0;
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = choice["delta"];
    if (isRecord(delta)) {
      if (typeof delta["content"] === "string") n += (delta["content"] as string).length;
      if (typeof delta["reasoning_content"] === "string") {
        n += (delta["reasoning_content"] as string).length;
      }
    }
    // Legacy / completions-style frames.
    if (typeof choice["text"] === "string") n += (choice["text"] as string).length;
  }
  return n;
}

export function estimateTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

// ─── Accumulator ─────────────────────────────────────────────────────────────

export interface UsageAccumulatorOptions {
  /** Characters of the rendered prompt, for the priority-3 estimate. */
  promptChars?: number;
}

/**
 * Fed one SSE `data:` payload at a time by stream.ts. Keeps the
 * highest-authority usage seen and, in parallel, always counts delta characters
 * so the estimator is ready the instant the stream ends without usage.
 */
export class UsageAccumulator {
  #best: ExtractedUsage | null = null;
  #completionChars = 0;
  #promptChars: number;
  #sawAnyFrame = false;

  constructor(opts: UsageAccumulatorOptions = {}) {
    this.#promptChars = Math.max(0, opts.promptChars ?? 0);
  }

  /** Raw payload from a `data:` line. `[DONE]` and junk are ignored safely. */
  ingest(payload: string): void {
    const trimmed = payload.trim();
    if (trimmed === "" || trimmed === "[DONE]") return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // Never let a malformed frame kill a billable stream.
    }
    this.#sawAnyFrame = true;
    this.#completionChars += deltaChars(obj);
    const found = extractUsage(obj);
    if (found && (this.#best === null || found.priority < this.#best.priority)) {
      this.#best = found;
    }
  }

  /** Accumulated completion characters (exposed for tests/telemetry). */
  get completionChars(): number {
    return this.#completionChars;
  }

  get sawAnyFrame(): boolean {
    return this.#sawAnyFrame;
  }

  result(): UsageResult {
    if (this.#best !== null) {
      return {
        promptTokens: this.#best.promptTokens,
        completionTokens: this.#best.completionTokens,
        cachedPromptTokens: this.#best.cachedPromptTokens,
        source: "upstream",
      };
    }
    return {
      promptTokens: estimateTokens(this.#promptChars),
      completionTokens: estimateTokens(this.#completionChars),
      cachedPromptTokens: 0,
      source: "estimated",
    };
  }
}
