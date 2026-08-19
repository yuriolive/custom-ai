/**
 * Unit tests for usage extraction (FR-GW-044 / 044a / 044b).
 * Run: node --test supabase/functions/gateway/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHARS_PER_TOKEN,
  deltaChars,
  estimateTokens,
  extractUsage,
  UsageAccumulator,
} from "./usage.ts";

const chunk = (content: string) =>
  JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });

test("priority 1: standard usage object on the terminal chunk", () => {
  const acc = new UsageAccumulator({ promptChars: 40 });
  acc.ingest(chunk("hello"));
  acc.ingest(
    JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    }),
  );
  assert.deepEqual(acc.result(), {
    promptTokens: 11,
    completionTokens: 7,
    cachedPromptTokens: 4,
    source: "upstream",
  });
});

test("priority 1: cached_tokens absent means 0, never null (FR-GW-044a)", () => {
  const acc = new UsageAccumulator();
  acc.ingest(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  const r = acc.result();
  assert.equal(r.cachedPromptTokens, 0);
  assert.notEqual(r.cachedPromptTokens, null);
});

test("priority 2: llama.cpp `timings` trailing frame", () => {
  const acc = new UsageAccumulator({ promptChars: 100 });
  acc.ingest(chunk("abc"));
  acc.ingest(
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      timings: { prompt_n: 23, predicted_n: 41, predicted_per_second: 12.3 },
    }),
  );
  assert.deepEqual(acc.result(), {
    promptTokens: 23,
    completionTokens: 41,
    cachedPromptTokens: 0,
    source: "upstream",
  });
});

test("priority 2: llama.cpp top-level tokens_evaluated / tokens_predicted", () => {
  const acc = new UsageAccumulator();
  acc.ingest(JSON.stringify({ tokens_evaluated: 9, tokens_predicted: 15 }));
  assert.deepEqual(acc.result(), {
    promptTokens: 9,
    completionTokens: 15,
    cachedPromptTokens: 0,
    source: "upstream",
  });
});

test("priority 2: timings nested inside choices[0]", () => {
  const acc = new UsageAccumulator();
  acc.ingest(JSON.stringify({ choices: [{ timings: { prompt_n: 2, predicted_n: 5 } }] }));
  const r = acc.result();
  assert.equal(r.source, "upstream");
  assert.equal(r.completionTokens, 5);
});

test("priority 1 wins over priority 2 regardless of arrival order", () => {
  const acc = new UsageAccumulator();
  acc.ingest(JSON.stringify({ timings: { prompt_n: 1, predicted_n: 1 } }));
  acc.ingest(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 200 } }));
  acc.ingest(JSON.stringify({ timings: { prompt_n: 1, predicted_n: 1 } }));
  const r = acc.result();
  assert.equal(r.promptTokens, 100);
  assert.equal(r.completionTokens, 200);
});

test("priority 3: no usage anywhere => estimated, non-zero completion", () => {
  const acc = new UsageAccumulator({ promptChars: 35 });
  const body = "The quick brown fox jumps over the lazy dog.";
  for (const c of body) acc.ingest(chunk(c));
  const r = acc.result();
  assert.equal(r.source, "estimated");
  assert.equal(r.promptTokens, Math.ceil(35 / CHARS_PER_TOKEN));
  assert.equal(r.completionTokens, Math.ceil(body.length / CHARS_PER_TOKEN));
  assert.ok(r.completionTokens > 0, "a completed stream is never left unbilled");
  assert.equal(r.cachedPromptTokens, 0);
});

test("an all-zero usage object does not suppress the estimator", () => {
  const acc = new UsageAccumulator({ promptChars: 10 });
  acc.ingest(chunk("hello world"));
  acc.ingest(JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 } }));
  const r = acc.result();
  assert.equal(r.source, "estimated");
  assert.ok(r.completionTokens > 0);
});

test("malformed frames and [DONE] never throw and never bill zero", () => {
  const acc = new UsageAccumulator({ promptChars: 7 });
  acc.ingest("[DONE]");
  acc.ingest("");
  acc.ingest("{not json");
  acc.ingest(chunk("hi there"));
  const r = acc.result();
  assert.equal(r.source, "estimated");
  assert.equal(r.completionTokens, estimateTokens("hi there".length));
});

test("deltaChars counts content, reasoning_content and legacy text", () => {
  assert.equal(deltaChars({ choices: [{ delta: { content: "abc" } }] }), 3);
  assert.equal(deltaChars({ choices: [{ delta: { reasoning_content: "abcd" } }] }), 4);
  assert.equal(deltaChars({ choices: [{ text: "ab" }] }), 2);
  assert.equal(deltaChars({ choices: [{ delta: { content: null } }] }), 0);
  assert.equal(deltaChars(null), 0);
});

test("deltaChars counts tool_calls name and argument fragments (FR-TOOL-004)", () => {
  const open = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_x",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        }],
      },
    }],
  };
  // The name, and nothing else — `id` and `type` are framing, not decoded text.
  assert.equal(deltaChars(open), "get_weather".length);

  const fragment = {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] } }],
  };
  assert.equal(deltaChars(fragment), 5);

  // Parallel calls in one frame both count.
  assert.equal(
    deltaChars({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: "ab" } },
            { index: 1, function: { arguments: "cde" } },
          ],
        },
      }],
    }),
    5,
  );

  // Junk in the array must not throw on a billable stream.
  assert.equal(deltaChars({ choices: [{ delta: { tool_calls: [null, 7, {}] } }] }), 0);
  assert.equal(deltaChars({ choices: [{ delta: { tool_calls: "nope" } }] }), 0);
});

test("a tool-only stream never estimates zero completion tokens", () => {
  // The whole reason FR-TOOL-004 touches this file: a tool-calling turn emits no
  // `content` at all, so a content-only count bills real GPU work as nothing and
  // shouldVoid then releases the hold.
  const acc = new UsageAccumulator({ promptChars: 400 });
  acc.ingest(JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "c",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        }],
      },
    }],
  }));
  acc.ingest(JSON.stringify({
    choices: [{
      delta: { tool_calls: [{ index: 0, function: { arguments: '{"location":"Lisbon"}' } }] },
    }],
  }));
  acc.ingest(JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));

  const result = acc.result();
  assert.equal(result.source, "estimated");
  assert.ok(result.completionTokens > 0, "tool arguments are billable completion tokens");
});

test("extractUsage returns null for ordinary content chunks", () => {
  assert.equal(extractUsage(JSON.parse(chunk("x"))), null);
  assert.equal(extractUsage("[DONE]"), null);
});
