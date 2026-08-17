#!/usr/bin/env node
/**
 * measure.js — measure the real cold-start behavior the scale-to-zero thesis rests on.
 *
 * Scale-to-zero is the business model (PRD §1.4), which makes cold start a product
 * surface rather than a performance footnote. This tool produces the numbers that decide
 * whether the product works: time to response headers, time to first token, decode
 * throughput over >= 64 generated tokens, and total duration — p50/p95, cold and warm
 * reported SEPARATELY, because averaging them describes a request nobody ever makes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SINGLE MOST VALUABLE OUTPUT: `usage_finding`.
 *
 * llama.cpp's `usage` emission on the OpenAI route is BUILD-DEPENDENT (PRD §4.3.3.6:
 * "usage on stream: build-dependent"; "cached_tokens: not reported"). Nothing errors when
 * a build omits it — the stream looks perfect and the gateway silently falls back to its
 * token estimator, and billing drifts from truth with no alarm anywhere. So before an
 * image is pinned to LLAMACPP_WORKER_IMAGE, this tool answers three questions:
 *
 *   1. did a `usage` object appear on the stream AT ALL?          -> bill from real counts, or estimate
 *   2. did it carry prompt_tokens_details.cached_tokens?          -> can cached prompt tokens be
 *                                                                    billed correctly (§6.6 C3)?
 *   3. where did it appear — a separate trailing chunk, or the    -> which wire layout the gateway's
 *      finish chunk?                                                 tee must handle
 *
 * A "full" result lets the gateway bill from real counts. "basic" bills from real totals
 * with no cached-token discount. "none" forces the estimator for every single request on
 * that image — which is a decision to make deliberately, not to discover in production.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SECURITY: RUNPOD_API_KEY from env only; never logged, never written to the report.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redact, resolveApiKey } from "./runpod-client.js";
import { parseArgs } from "./provision.js";
import { IDLE_TIMEOUT_S } from "./provision.js";

export const DEFAULT_UPSTREAM = "https://api.runpod.ai";

/** Upstream route, per docs/CONTRACTS.md. */
export function upstreamUrl(baseUrl, endpointId) {
  return `${String(baseUrl).replace(/\/+$/, "")}/v2/${endpointId}/openai/v1/chat/completions`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE analyzer — the testable core. Pure, no I/O, no clock of its own.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accumulates OpenAI SSE frames and reports what was on the wire.
 * `now()` is injected so tests are deterministic and the live path uses a real clock.
 */
export function createSseAnalyzer({ now = () => performance.now(), startedAt = null } = {}) {
  const t0 = startedAt ?? now();
  let buffer = "";
  let done = false;

  const state = {
    frames: 0,
    contentTokens: 0,
    text: "",
    firstTokenAt: null,
    lastTokenAt: null,
    doneAt: null,
    finishReason: null,
    model: null,
    keepalives: 0,
    malformedFrames: 0,
    usage: null,
    usagePlacement: null,
    sawDone: false,
  };

  /** Feed a decoded chunk of the response body. */
  function push(chunk, at = now()) {
    buffer += chunk;
    let idx;
    // Frames are separated by a blank line. Tolerate \r\n — some proxies rewrite it.
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawFrame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + buffer.slice(idx).match(/^\r?\n\r?\n/)[0].length);
      handleFrame(rawFrame, at);
    }
  }

  function handleFrame(rawFrame, at) {
    for (const line of rawFrame.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // ": keepalive" — an SSE comment. The gateway emits these during upstream silence
      // (FR-GW-041); a real RunPod worker generally does not. Counted, never billed.
      if (line.startsWith(":")) { state.keepalives++; continue; }
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { state.sawDone = true; state.doneAt = at; done = true; continue; }

      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        // A truncated frame is a real failure mode, not a parse convenience. Count it —
        // a stream that silently loses frames also silently loses usage.
        state.malformedFrames++;
        continue;
      }

      state.frames++;
      if (obj.model) state.model ??= obj.model;

      const choice = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
      const delta = choice?.delta ?? {};
      const content = typeof delta.content === "string" ? delta.content : "";
      if (content.length > 0) {
        state.contentTokens++;
        state.text += content;
        state.firstTokenAt ??= at;
        state.lastTokenAt = at;
      }
      if (choice?.finish_reason) state.finishReason ??= choice.finish_reason;

      if (obj.usage && typeof obj.usage === "object") {
        state.usage = obj.usage;
        // Placement matters to the gateway's tee: a trailing chunk with choices:[] is the
        // vLLM layout; usage riding the finish chunk is the llama.cpp layout.
        const hasChoices = Array.isArray(obj.choices) && obj.choices.length > 0;
        state.usagePlacement = hasChoices ? "final" : "separate";
      }
    }
  }

  function finish(at = now()) {
    if (buffer.trim()) handleFrame(buffer, at);
    buffer = "";
    state.doneAt ??= at;
    return report(at);
  }

  function report(endAt = state.doneAt ?? now()) {
    const u = state.usage;
    const cachedTokens = u?.prompt_tokens_details?.cached_tokens;
    const cachedTokensReported = u != null && typeof cachedTokens === "number";

    // The three cases the gateway's billing path must distinguish.
    const usageShape = u == null ? "none" : cachedTokensReported ? "full" : "basic";

    const decodeSpanMs =
      state.firstTokenAt != null && state.lastTokenAt != null
        ? state.lastTokenAt - state.firstTokenAt
        : 0;

    return {
      frames: state.frames,
      malformed_frames: state.malformedFrames,
      keepalives: state.keepalives,
      saw_done: state.sawDone,
      finish_reason: state.finishReason,
      model: state.model,
      completion_tokens_observed: state.contentTokens,
      text_chars: state.text.length,
      ttft_ms: state.firstTokenAt != null ? round(state.firstTokenAt - t0) : null,
      last_token_ms: state.lastTokenAt != null ? round(state.lastTokenAt - t0) : null,
      total_ms: round(endAt - t0),
      decode_span_ms: round(decodeSpanMs),
      // Decode rate excludes TTFT: (n-1) intervals between n tokens. This is the number
      // FR-DEP-052 compares against the target, and it is NOT tokens/total_duration.
      decode_tokens_per_second:
        decodeSpanMs > 0 && state.contentTokens > 1
          ? round(((state.contentTokens - 1) / decodeSpanMs) * 1000, 2)
          : null,
      end_to_end_tokens_per_second:
        endAt > t0 && state.contentTokens > 0
          ? round((state.contentTokens / (endAt - t0)) * 1000, 2)
          : null,
      // ── The finding that decides how the gateway bills ──────────────────────
      usage_emitted: u != null,
      usage_shape: usageShape,
      usage_placement: state.usagePlacement,
      cached_tokens_reported: cachedTokensReported,
      usage: u ?? null,
      prompt_tokens: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : null,
      completion_tokens_reported: typeof u?.completion_tokens === "number" ? u.completion_tokens : null,
      cached_tokens: cachedTokensReported ? cachedTokens : null,
    };
  }

  return { push, finish, report, get done() { return done; } };
}

/** Convenience for tests and offline analysis: analyze a complete SSE body at once. */
export function analyzeSseText(text, { now } = {}) {
  let t = 0;
  const clock = now ?? (() => t++);
  const a = createSseAnalyzer({ now: clock });
  a.push(text);
  return a.finish();
}

function round(n, dp = 1) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ─────────────────────────────────────────────────────────────────────────────
// One measured request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{baseUrl:string, endpointId:string, apiKey:string|null, model:string, prompt:string,
 *          maxTokens:number, timeoutMs:number, cold:boolean, headers?:object, fetchImpl?:typeof fetch}} opts
 */
export async function runOnce(opts) {
  const {
    baseUrl, endpointId, apiKey, model, prompt,
    maxTokens = 96, timeoutMs = 300_000, cold = false,
    headers = {}, fetchImpl = fetch,
  } = opts;

  const url = upstreamUrl(baseUrl, endpointId);
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    max_tokens: maxTokens,
    temperature: 0,
    // Sent unconditionally, exactly as the gateway does (docs/CONTRACTS.md #4): vLLM emits
    // no usage without it, and llama.cpp ignores it. Branching on runtime is how the flag
    // gets dropped. Sending it here means a "none" result is a fact about the BUILD, not
    // about this tool having forgotten to ask.
    stream_options: { include_usage: true },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  const analyzer = createSseAnalyzer({ startedAt: t0 });

  const record = {
    cold,
    started_at: new Date().toISOString(),
    max_tokens_requested: maxTokens,
    ok: false,
    error: null,
    http_status: null,
    headers_ms: null,
  };

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // Time to response headers. On a cold worker this is the interval during which the
    // gateway must already have flushed ITS headers and be emitting keepalives — the
    // client socket is otherwise dead silent for the whole weight download.
    record.headers_ms = round(performance.now() - t0);
    record.http_status = res.status;
    record.content_type = res.headers.get("content-type");

    if (!res.ok) {
      const text = await res.text();
      record.error = { code: `http_${res.status}`, message: redact(text.slice(0, 500)) };
      return { ...record, ...analyzer.report(performance.now()) };
    }

    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      analyzer.push(decoder.decode(chunk, { stream: true }));
    }
    const result = analyzer.finish(performance.now());
    record.ok = result.completion_tokens_observed > 0;
    if (!record.ok) record.error = { code: "no_tokens", message: "stream produced no content tokens" };
    return { ...record, ...result };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    record.error = {
      code: aborted ? "timeout" : "transport_error",
      message: redact(aborted ? `aborted after ${timeoutMs} ms` : String(err?.message ?? err)),
    };
    return { ...record, ...analyzer.finish(performance.now()) };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistics
// ─────────────────────────────────────────────────────────────────────────────

/** Nearest-rank percentile. No interpolation: with n=3 runs, interpolating invents data. */
export function percentile(values, q) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1));
  return round(xs[idx], 1);
}

function statsFor(runs, field) {
  const vals = runs.map((r) => r[field]).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return { n: 0, p50: null, p95: null, min: null, max: null };
  return {
    n: vals.length,
    p50: percentile(vals, 0.5),
    p95: percentile(vals, 0.95),
    min: round(Math.min(...vals), 1),
    max: round(Math.max(...vals), 1),
  };
}

export function summarize(runs) {
  const ok = runs.filter((r) => r.ok);
  const group = (label) => {
    const g = ok.filter((r) => r.cold === (label === "cold"));
    return {
      runs: g.length,
      headers_ms: statsFor(g, "headers_ms"),
      ttft_ms: statsFor(g, "ttft_ms"),
      decode_tokens_per_second: statsFor(g, "decode_tokens_per_second"),
      total_ms: statsFor(g, "total_ms"),
      completion_tokens: statsFor(g, "completion_tokens_observed"),
    };
  };

  // ── The usage finding. Aggregated across ALL successful runs, and deliberately
  //    pessimistic: if ANY run failed to emit usage, the image cannot be trusted to
  //    emit it, and the gateway must be able to fall back. One good run out of five is
  //    not "it works" — it is "it works sometimes", which is worse than never.
  const shapes = ok.map((r) => r.usage_shape);
  const anyUsage = shapes.some((s) => s !== "none");
  const allUsage = shapes.length > 0 && shapes.every((s) => s !== "none");
  const allCached = ok.length > 0 && ok.every((r) => r.cached_tokens_reported);
  const anyCached = ok.some((r) => r.cached_tokens_reported);

  let verdict, billing_implication;
  if (!anyUsage) {
    verdict = "none";
    billing_implication =
      "NO usage object appeared on any stream. This image CANNOT be billed from real token counts: " +
      "every request settles from the gateway's estimator (UsageResult.source === 'estimated'). " +
      "Either pin a different llama.cpp build, or accept estimator-based billing knowingly and " +
      "monitor the drift. Do not assume the gateway will 'just get' counts — it will not, and " +
      "nothing will error to tell you.";
  } else if (!allUsage) {
    verdict = "intermittent";
    billing_implication =
      "usage appeared on SOME runs and not others. Treat this as 'none' for pinning purposes: " +
      "an intermittent source is worse than an absent one because the drift is invisible and " +
      "unreproducible. Investigate before pinning this image.";
  } else if (allCached) {
    verdict = "full";
    billing_implication =
      "usage is present on every run AND carries prompt_tokens_details.cached_tokens. The gateway " +
      "can bill from real counts and apply the cached-prompt-token handling of §6.6 C3.";
  } else {
    verdict = "basic";
    billing_implication =
      "usage is present on every run but carries NO prompt_tokens_details.cached_tokens — the " +
      "documented llama.cpp best case. The gateway bills from real prompt/completion totals; " +
      "cached prompt tokens are billed at full price because the worker does not report them. " +
      "That is correct and safe, merely not optimal.";
  }

  const placements = [...new Set(ok.map((r) => r.usage_placement).filter(Boolean))];

  return {
    total_runs: runs.length,
    ok_runs: ok.length,
    failed_runs: runs.length - ok.length,
    cold: group("cold"),
    warm: group("warm"),
    usage_finding: {
      verdict,
      usage_emitted_runs: ok.filter((r) => r.usage_emitted).length,
      cached_tokens_runs: ok.filter((r) => r.cached_tokens_reported).length,
      any_usage: anyUsage,
      all_usage: allUsage,
      any_cached_tokens: anyCached,
      all_cached_tokens: allCached,
      placements,
      billing_implication,
    },
    warnings: buildWarnings(runs, ok),
  };
}

function buildWarnings(runs, ok) {
  const w = [];
  const short = ok.filter((r) => r.completion_tokens_observed < 64);
  if (short.length) {
    w.push(
      `${short.length}/${ok.length} successful runs generated fewer than 64 tokens ` +
        `(min ${Math.min(...short.map((r) => r.completion_tokens_observed))}). Throughput measured over ` +
        `a short window is dominated by noise — FR-DEP-052 requires >= 64 generated tokens. ` +
        `Raise --max-tokens or use a prompt that elicits a longer answer.`,
    );
  }
  const malformed = runs.filter((r) => r.malformed_frames > 0);
  if (malformed.length) w.push(`${malformed.length} run(s) contained malformed SSE frames — a stream losing frames can also lose usage.`);
  const noDone = ok.filter((r) => !r.saw_done);
  if (noDone.length) w.push(`${noDone.length} run(s) ended without a [DONE] sentinel — the stream was truncated.`);
  const failed = runs.filter((r) => !r.ok);
  for (const f of failed) w.push(`run failed: ${f.error?.code} — ${f.error?.message}`);
  const mismatch = ok.filter(
    (r) => r.completion_tokens_reported != null && Math.abs(r.completion_tokens_reported - r.completion_tokens_observed) > 1,
  );
  if (mismatch.length) {
    w.push(
      `${mismatch.length} run(s) reported a completion_tokens that disagrees with the observed frame ` +
        `count by more than 1. The worker's own count is authoritative for billing, but a large gap ` +
        `means one content frame != one token on this build — do not use frame counts as an estimator basis.`,
    );
  }
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// The measurement run
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Alternates forced-cold and warm requests.
 *
 * A cold worker is forced by waiting out idleTimeout (30 s) plus a margin — after which
 * RunPod has scaled the endpoint to zero and the next request pays the full container
 * start + weight load. The warm sample is taken IMMEDIATELY after the cold one, while the
 * same worker is still alive, so the pair differ in exactly one variable.
 */
export async function measure(opts = {}) {
  const {
    baseUrl = process.env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM,
    endpointId = process.env.RUNPOD_ENDPOINT_ID,
    apiKey,
    model = "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    prompt = "Write a detailed paragraph about the history of the printing press.",
    runs = 3,
    maxTokens = 96,
    timeoutMs = 300_000,
    coldWaitS = IDLE_TIMEOUT_S + 10,
    warmPerCold = 1,
    headers = {},
    fetchImpl,
    log = () => {},
  } = opts;

  if (!endpointId) {
    throw new Error("No endpoint id. Pass --endpoint or set RUNPOD_ENDPOINT_ID.");
  }
  if (maxTokens < 64) {
    log(`[warn] --max-tokens ${maxTokens} is below the 64-token floor FR-DEP-052 requires for a throughput measurement.`);
  }

  const results = [];
  const common = { baseUrl, endpointId, apiKey, model, prompt, maxTokens, timeoutMs, headers, fetchImpl };

  for (let i = 0; i < runs; i++) {
    if (coldWaitS > 0) {
      log(`[cold ${i + 1}/${runs}] waiting ${coldWaitS}s for idleTimeout=${IDLE_TIMEOUT_S}s to scale the endpoint to zero...`);
      await sleep(coldWaitS * 1000);
    }
    log(`[cold ${i + 1}/${runs}] requesting...`);
    const cold = await runOnce({ ...common, cold: true });
    results.push(cold);
    log(`[cold ${i + 1}/${runs}] ${fmtRun(cold)}`);

    for (let j = 0; j < warmPerCold; j++) {
      log(`[warm ${i + 1}.${j + 1}] requesting immediately, same worker...`);
      const warm = await runOnce({ ...common, cold: false });
      results.push(warm);
      log(`[warm ${i + 1}.${j + 1}] ${fmtRun(warm)}`);
    }
  }

  const summary = summarize(results);
  return {
    generated_at: new Date().toISOString(),
    config: {
      base_url: baseUrl,
      endpoint_id: endpointId,
      model,
      runs,
      warm_per_cold: warmPerCold,
      max_tokens: maxTokens,
      cold_wait_s: coldWaitS,
      timeout_ms: timeoutMs,
      idle_timeout_s: IDLE_TIMEOUT_S,
      api_key_present: Boolean(apiKey),
      // The key itself is never recorded. Only whether one was used.
    },
    summary,
    runs: results,
  };
}

function fmtRun(r) {
  if (!r.ok) return `FAILED ${r.error?.code}: ${r.error?.message}`;
  return (
    `headers ${r.headers_ms}ms · TTFT ${r.ttft_ms}ms · ${r.completion_tokens_observed} tok · ` +
    `${r.decode_tokens_per_second ?? "?"} tok/s · total ${r.total_ms}ms · usage=${r.usage_shape}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Readable summary
// ─────────────────────────────────────────────────────────────────────────────

export function renderSummary(report) {
  const s = report.summary;
  const L = [];
  const bar = "═".repeat(78);
  const stat = (label, st, unit) =>
    st.n === 0
      ? `  ${label.padEnd(26)} —`
      : `  ${label.padEnd(26)} p50 ${String(st.p50).padStart(9)}${unit}   p95 ${String(st.p95).padStart(9)}${unit}   (min ${st.min} / max ${st.max}, n=${st.n})`;

  L.push(bar);
  L.push("RunPod cold-start measurement");
  L.push(bar);
  L.push(`  endpoint  ${report.config.endpoint_id}`);
  L.push(`  base URL  ${report.config.base_url}`);
  L.push(`  model     ${report.config.model}`);
  L.push(`  runs      ${s.ok_runs} ok / ${s.total_runs} total  (${s.failed_runs} failed)`);
  L.push(`  policy    idleTimeout=${report.config.idle_timeout_s}s, cold forced by a ${report.config.cold_wait_s}s wait`);
  L.push("");
  L.push(`── COLD (${s.cold.runs} runs) — the first request after scale-to-zero ` + "─".repeat(12));
  L.push(stat("time to headers", s.cold.headers_ms, "ms"));
  L.push(stat("time to first token", s.cold.ttft_ms, "ms"));
  L.push(stat("decode throughput", s.cold.decode_tokens_per_second, " tok/s"));
  L.push(stat("total duration", s.cold.total_ms, "ms"));
  L.push(stat("completion tokens", s.cold.completion_tokens, " tok"));
  L.push("");
  L.push(`── WARM (${s.warm.runs} runs) — same worker, still alive ` + "─".repeat(26));
  L.push(stat("time to headers", s.warm.headers_ms, "ms"));
  L.push(stat("time to first token", s.warm.ttft_ms, "ms"));
  L.push(stat("decode throughput", s.warm.decode_tokens_per_second, " tok/s"));
  L.push(stat("total duration", s.warm.total_ms, "ms"));
  L.push(stat("completion tokens", s.warm.completion_tokens, " tok"));

  if (s.warm.ttft_ms.p50 != null) {
    const p50ok = s.warm.ttft_ms.p50 < 400;
    const p95ok = s.warm.ttft_ms.p95 < 900;
    L.push("");
    L.push(`  NFR-CS-002 warm TTFT: p50 < 400ms ${p50ok ? "PASS" : "FAIL"} · p95 < 900ms ${p95ok ? "PASS" : "FAIL"}`);
  }
  if (s.cold.ttft_ms.p95 != null) {
    L.push(`  NFR-CS-001 cold-start budget is clamped to [90s, 300s]; measured cold TTFT p95 = ${(s.cold.ttft_ms.p95 / 1000).toFixed(1)}s`);
  }

  L.push("");
  L.push("═".repeat(78));
  L.push("USAGE FINDING — the output that decides how the gateway bills");
  L.push("═".repeat(78));
  const uf = s.usage_finding;
  L.push(`  verdict                      ${uf.verdict.toUpperCase()}`);
  L.push(`  usage object emitted         ${uf.usage_emitted_runs}/${s.ok_runs} successful runs`);
  L.push(`  prompt_tokens_details        ${uf.cached_tokens_runs}/${s.ok_runs} runs carried cached_tokens`);
  L.push(`  wire placement               ${uf.placements.length ? uf.placements.join(", ") : "n/a"}`);
  L.push("");
  for (const line of wrap(uf.billing_implication, 74)) L.push("  " + line);

  if (s.warnings.length) {
    L.push("");
    L.push("── WARNINGS " + "─".repeat(66));
    for (const w of s.warnings) for (const line of wrap("• " + w, 74)) L.push("  " + line);
  }
  L.push(bar);
  return L.join("\n");
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const word of words) {
    if ((cur + " " + word).trim().length > width) { lines.push(cur.trim()); cur = word; }
    else cur += " " + word;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `
runpod-measure — measure real cold-start behavior and the llama.cpp usage-emission fact

  node tools/runpod/measure.js --endpoint EP_ID --runs 3

  --endpoint ID      RunPod endpoint id; default $RUNPOD_ENDPOINT_ID
  --base-url URL     default $UPSTREAM_BASE_URL or ${DEFAULT_UPSTREAM}
                     (point this at tools/mock-upstream to exercise the tool offline)
  --model NAME       model string sent upstream
  --prompt TEXT      prompt; default elicits a long answer
  --runs N           cold/warm pairs; default 3
  --warm-per-cold N  warm samples after each cold one; default 1
  --max-tokens N     default 96 — must exceed 64 for a valid throughput number (FR-DEP-052)
  --cold-wait-s N    seconds to wait for scale-to-zero; default ${IDLE_TIMEOUT_S + 10}. Use 0 for a fake.
  --timeout-ms N     per-request timeout; default 300000 (a first-ever cold start pulls the image)
  --out FILE         write the JSON report here
  --json             print the JSON report to stdout instead of the readable summary
  --no-auth          omit the Authorization header (for local fakes)

RUNPOD_API_KEY is read from the environment only and never appears in the report.
`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) { process.stdout.write(USAGE); return 0; }

  const noAuth = Boolean(args.noAuth);
  let apiKey = null;
  if (!noAuth) {
    try { apiKey = resolveApiKey({ required: false }); } catch { apiKey = null; }
    if (!apiKey) {
      process.stderr.write(
        "[warn] RUNPOD_API_KEY is not set — requests will be sent without an Authorization header.\n" +
          "       That works against a local fake and will be rejected by real RunPod.\n",
      );
    }
  }

  try {
    const report = await measure({
      baseUrl: args.baseUrl ? String(args.baseUrl) : undefined,
      endpointId: args.endpoint ? String(args.endpoint) : undefined,
      apiKey,
      model: args.model ? String(args.model) : undefined,
      prompt: args.prompt ? String(args.prompt) : undefined,
      runs: args.runs !== undefined ? Number(args.runs) : undefined,
      warmPerCold: args.warmPerCold !== undefined ? Number(args.warmPerCold) : undefined,
      maxTokens: args.maxTokens !== undefined ? Number(args.maxTokens) : undefined,
      coldWaitS: args.coldWaitS !== undefined ? Number(args.coldWaitS) : undefined,
      timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
      log: (s) => process.stderr.write(s + "\n"),
    });

    if (args.out) {
      const outPath = path.resolve(String(args.out));
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, redact(JSON.stringify(report, null, 2)) + "\n", "utf8");
      process.stderr.write(`\n[report] ${outPath}\n`);
    }

    process.stdout.write(
      (args.json ? redact(JSON.stringify(report, null, 2)) : renderSummary(report)) + "\n",
    );
    return report.summary.ok_runs > 0 ? 0 : 1;
  } catch (err) {
    process.stderr.write(`\n[FAILED] ${redact(String(err?.message ?? err))}\n`);
    return 1;
  }
}

if (process.argv[1]?.endsWith("measure.js")) {
  main().then((c) => { process.exitCode = c; });
}
