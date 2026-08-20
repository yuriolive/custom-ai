/**
 * OpenAI SSE -> Anthropic SSE. The stateful part, and the part that breaks
 * clients when it is subtly wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicStreamTranslator,
  anthropicErrorEvent,
  formatSseEvent,
  translateSseText,
  translateStream,
} from "../src/index.ts";
import type {
  AnthropicStreamEvent,
  OpenAIStreamChunk,
  OpenAIStreamDelta,
  OpenAIStreamToolCallDelta,
} from "../src/types.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function chunk(
  delta: OpenAIStreamDelta,
  finish: "stop" | "length" | "tool_calls" | "content_filter" | null = null,
): OpenAIStreamChunk {
  return {
    id: "chatcmpl-str1",
    object: "chat.completion.chunk",
    model: "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function text(s: string): OpenAIStreamChunk {
  return chunk({ content: s });
}

function tool(...calls: OpenAIStreamToolCallDelta[]): OpenAIStreamChunk {
  return chunk({ tool_calls: calls });
}

function usageChunk(prompt: number, completion: number): OpenAIStreamChunk {
  return {
    id: "chatcmpl-str1",
    object: "chat.completion.chunk",
    model: "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  };
}

/** One compact line per event, for exact-sequence assertions. */
function sig(e: AnthropicStreamEvent): string {
  switch (e.type) {
    case "message_start":
      return `message_start id=${e.message.id} in=${e.message.usage.input_tokens} out=${e.message.usage.output_tokens}`;
    case "content_block_start": {
      const b = e.content_block;
      if (b.type === "tool_use") return `content_block_start ${e.index} tool_use ${b.id}/${b.name}`;
      return `content_block_start ${e.index} ${b.type}`;
    }
    case "content_block_delta": {
      const d = e.delta;
      if (d.type === "text_delta")
        return `content_block_delta ${e.index} text ${JSON.stringify(d.text)}`;
      if (d.type === "thinking_delta")
        return `content_block_delta ${e.index} thinking ${JSON.stringify(d.thinking)}`;
      if (d.type === "input_json_delta")
        return `content_block_delta ${e.index} json ${JSON.stringify(d.partial_json)}`;
      return `content_block_delta ${e.index} signature`;
    }
    case "content_block_stop":
      return `content_block_stop ${e.index}`;
    case "message_delta":
      return `message_delta stop=${e.delta.stop_reason} seq=${JSON.stringify(e.delta.stop_sequence)} in=${e.usage.input_tokens} out=${e.usage.output_tokens}`;
    case "message_stop":
      return "message_stop";
    case "ping":
      return "ping";
    case "error":
      return `error ${e.error.type}`;
  }
}

function run(
  chunks: OpenAIStreamChunk[],
  options: ConstructorParameters<typeof AnthropicStreamTranslator>[0] = {},
): { events: AnthropicStreamEvent[]; warnings: string[] } {
  const t = new AnthropicStreamTranslator({ pingEveryDeltas: 0, ...options });
  const events: AnthropicStreamEvent[] = [];
  for (const c of chunks) events.push(...t.push(c));
  events.push(...t.finish());
  return { events, warnings: t.warnings };
}

// ─── tests ──────────────────────────────────────────────────────────────────

test("text then two sequential tool calls produces the exact Anthropic sequence", () => {
  const { events, warnings } = run([
    chunk({ role: "assistant" }),
    text("Let me "),
    text("check."),
    tool({ index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: "" } }),
    tool({ index: 0, function: { arguments: '{"file_' } }),
    tool({ index: 0, function: { arguments: 'path":"/a.ts"}' } }),
    tool({ index: 1, id: "call_b", type: "function", function: { name: "Grep", arguments: "" } }),
    tool({ index: 1, function: { arguments: '{"pattern":"TO' } }),
    tool({ index: 1, function: { arguments: 'DO"}' } }),
    chunk({}, "tool_calls"),
    usageChunk(2048, 137),
  ]);

  assert.deepEqual(events.map(sig), [
    "message_start id=msg_str1 in=0 out=0",
    "content_block_start 0 text",
    "ping",
    'content_block_delta 0 text "Let me "',
    'content_block_delta 0 text "check."',
    "content_block_stop 0",
    "content_block_start 1 tool_use call_a/Read",
    'content_block_delta 1 json "{\\"file_"',
    'content_block_delta 1 json "path\\":\\"/a.ts\\"}"',
    "content_block_stop 1",
    "content_block_start 2 tool_use call_b/Grep",
    'content_block_delta 2 json "{\\"pattern\\":\\"TO"',
    'content_block_delta 2 json "DO\\"}"',
    "content_block_stop 2",
    "message_delta stop=tool_use seq=null in=2048 out=137",
    "message_stop",
  ]);
  assert.deepEqual(warnings, []);
});

test("indices are one sequential space shared by text, thinking and tool_use blocks", () => {
  const { events } = run([
    chunk({ reasoning_content: "hmm" }),
    text("hi"),
    tool({ index: 0, id: "c1", function: { name: "A", arguments: "{}" } }),
    text("more"),
    tool({ index: 0, id: "c2", function: { name: "B", arguments: "{}" } }),
    chunk({}, "tool_calls"),
  ]);

  const starts = events.filter((e) => e.type === "content_block_start");
  assert.deepEqual(
    starts.map((e) => e.index),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    starts.map((e) => e.content_block.type),
    ["thinking", "text", "tool_use", "text", "tool_use"],
  );

  // Every start is matched by exactly one stop at the same index, in order.
  const stops = events.filter((e) => e.type === "content_block_stop").map((e) => e.index);
  assert.deepEqual(stops, [0, 1, 2, 3, 4]);
});

test("argument fragments split mid-JSON pass through byte-for-byte as partial_json", () => {
  // The normal case: OpenAI splits arguments at arbitrary offsets, including
  // inside a key name, inside a string value, and between a value and its comma.
  const full = '{"file_path":"/repo/src/very/long/path.ts","limit":100,"offset":0}';
  const cuts = [3, 9, 14, 27, 41, 48, 55, 60];
  const fragments: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    fragments.push(full.slice(prev, c));
    prev = c;
  }
  fragments.push(full.slice(prev));

  const { events } = run([
    tool({ index: 0, id: "call_x", function: { name: "Read", arguments: "" } }),
    ...fragments.map((f) => tool({ index: 0, function: { arguments: f } })),
    chunk({}, "tool_calls"),
  ]);

  const jsonDeltas: string[] = [];
  for (const e of events) {
    if (e.type === "content_block_delta" && e.delta.type === "input_json_delta") {
      jsonDeltas.push(e.delta.partial_json);
    }
  }

  // Reassembling the partial_json values must reproduce the original exactly:
  // nothing re-parsed, nothing re-serialized, nothing lost at a boundary.
  assert.equal(jsonDeltas.join(""), full);
  assert.deepEqual(JSON.parse(jsonDeltas.join("")), {
    file_path: "/repo/src/very/long/path.ts",
    limit: 100,
    offset: 0,
  });
  // Empty fragments are not forwarded as no-op deltas.
  assert.ok(jsonDeltas.every((d) => d.length > 0));
});

test("a stream ending with finish_reason tool_calls closes the open tool block first", () => {
  const { events } = run([
    tool({ index: 0, id: "call_only", function: { name: "Bash", arguments: '{"command":"ls"}' } }),
    chunk({}, "tool_calls"),
    usageChunk(11, 22),
  ]);

  assert.deepEqual(events.map(sig), [
    "message_start id=msg_str1 in=0 out=0",
    "content_block_start 0 tool_use call_only/Bash",
    "ping",
    'content_block_delta 0 json "{\\"command\\":\\"ls\\"}"',
    "content_block_stop 0",
    "message_delta stop=tool_use seq=null in=11 out=22",
    "message_stop",
  ]);
});

test("reasoning_content produces a thinking block with thinking_delta events", () => {
  const { events } = run([
    chunk({ reasoning_content: "The user asks for " }),
    chunk({ reasoning: "the GCD. Euclid." }),
    text("The answer is 21."),
    chunk({}, "stop"),
    usageChunk(30, 90),
  ]);

  assert.deepEqual(events.map(sig), [
    "message_start id=msg_str1 in=0 out=0",
    "content_block_start 0 thinking",
    "ping",
    'content_block_delta 0 thinking "The user asks for "',
    'content_block_delta 0 thinking "the GCD. Euclid."',
    "content_block_stop 0",
    "content_block_start 1 text",
    'content_block_delta 1 text "The answer is 21."',
    "content_block_stop 1",
    "message_delta stop=end_turn seq=null in=30 out=90",
    "message_stop",
  ]);
});

test("reasoning is never silently dropped even when it is the whole response", () => {
  const { events, warnings } = run([
    chunk({ reasoning_content: "only thinking" }),
    chunk({}, "stop"),
  ]);
  const thinking = events.filter(
    (e) => e.type === "content_block_delta" && e.delta.type === "thinking_delta",
  );
  assert.equal(thinking.length, 1);
  // No usage reported anywhere -> loud warning, because this is billed output.
  assert.ok(warnings.some((w) => /never reported usage/.test(w)));
});

test("message_start reports input_tokens 0 and message_delta corrects it", () => {
  const { events } = run([text("hi"), chunk({}, "stop"), usageChunk(4096, 12)]);

  const start = events[0];
  assert.equal(start!.type, "message_start");
  assert.deepEqual(start!.message.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(start!.message.stop_reason, null);
  assert.equal(start!.message.stop_sequence, null);
  assert.deepEqual(start!.message.content, []);
  assert.equal(start!.message.role, "assistant");
  assert.equal(start!.message.type, "message");

  const md = events.find((e) => e.type === "message_delta")!;
  assert.deepEqual(md.usage, { input_tokens: 4096, output_tokens: 12 });
});

test("a caller-supplied input_tokens estimate is used in message_start", () => {
  const { events } = run([text("hi"), chunk({}, "stop")], { inputTokens: 900 });
  const start = events[0];
  assert.equal(start!.type, "message_start");
  assert.equal(start!.message.usage.input_tokens, 900);
  const md = events.find((e) => e.type === "message_delta")!;
  // Upstream reported nothing, so the estimate is carried through rather than 0.
  assert.equal(md.usage.input_tokens, 900);
});

test("every finish_reason produces the right streamed stop_reason", () => {
  const cases: [Parameters<typeof chunk>[1], string][] = [
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["content_filter", "refusal"],
    [null, "null"],
  ];
  for (const [finish, want] of cases) {
    const { events } = run([text("x"), chunk({}, finish)]);
    const md = events.find((e) => e.type === "message_delta")!;
    assert.equal(String(md.delta.stop_reason), want, String(finish));
  }
});

test("a streamed stop-sequence hit reports stop_sequence", () => {
  // vLLM reports the matched string on the choice.
  const reported = run([
    text("answer"),
    {
      ...chunk({}, "stop"),
      choices: [{ index: 0, delta: {}, finish_reason: "stop", stop_reason: "END" }],
    },
  ]);
  const md1 = reported.events.find((e) => e.type === "message_delta")!;
  assert.equal(md1.delta.stop_reason, "stop_sequence");
  assert.equal(md1.delta.stop_sequence, "END");

  // Or the sequence is still present at the end of the streamed text.
  const suffix = run([text("answer"), text("\n\nHuman:"), chunk({}, "stop")], {
    stopSequences: ["\n\nHuman:"],
  });
  const md2 = suffix.events.find((e) => e.type === "message_delta")!;
  assert.equal(md2.delta.stop_reason, "stop_sequence");
  assert.equal(md2.delta.stop_sequence, "\n\nHuman:");
});

test("pings are emitted on the configured cadence", () => {
  const t = new AnthropicStreamTranslator({ pingEveryDeltas: 3 });
  const events: AnthropicStreamEvent[] = [];
  for (let i = 0; i < 9; i++) events.push(...t.push(text(`t${i}`)));
  events.push(...t.finish());
  // One ping after the first content_block_start, then one every 3 deltas.
  assert.equal(events.filter((e) => e.type === "ping").length, 4);
});

test("an empty stream still emits a legal, complete message", () => {
  const { events } = run([], { messageId: "msg_empty" });
  assert.deepEqual(events.map(sig), [
    "message_start id=msg_empty in=0 out=0",
    "content_block_start 0 text",
    "content_block_stop 0",
    "message_delta stop=null seq=null in=0 out=0",
    "message_stop",
  ]);
});

test("a tool call with no id gets a generated one and a warning", () => {
  const { events, warnings } = run([
    tool({ index: 0, function: { name: "Read", arguments: "{}" } }),
    chunk({}, "tool_calls"),
  ]);
  const start = events.find((e) => e.type === "content_block_start")!;
  assert.equal(start.content_block.type, "tool_use");
  assert.match((start.content_block as { id: string }).id, /^toolu_stream_0$/);
  assert.ok(warnings.some((w) => /no id/.test(w)));
});

test("a tool name arriving after the block opened is reported, not silently lost", () => {
  const { warnings } = run([
    tool({ index: 0, id: "call_late", function: { arguments: "" } }),
    tool({ index: 0, function: { name: "Read" } }),
    chunk({}, "tool_calls"),
  ]);
  assert.ok(warnings.some((w) => /arrived after content_block_start/.test(w)));
});

test("non-JSON argument fragments stream through without throwing", () => {
  const { events, warnings } = run([
    tool({ index: 0, id: "call_bad", function: { name: "Read", arguments: "not json at all" } }),
    chunk({}, "tool_calls"),
    usageChunk(1, 1),
  ]);
  const d = events.find((e) => e.type === "content_block_delta")!;
  // Streaming never parses arguments, so invalid JSON is simply forwarded; it is
  // the consumer's accumulate-then-parse step that discovers the problem.
  assert.deepEqual(d.delta, { type: "input_json_delta", partial_json: "not json at all" });
  assert.deepEqual(warnings, []);
});

test("SSE framing carries both an event: line and a matching data.type", () => {
  const frame = formatSseEvent({ type: "message_stop" });
  assert.equal(frame, 'event: message_stop\ndata: {"type":"message_stop"}\n\n');

  const delta = formatSseEvent({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"a":' },
  });
  assert.equal(
    delta,
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}\n\n',
  );

  assert.equal(
    formatSseEvent(anthropicErrorEvent("overloaded_error", "Overloaded")),
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
  );
});

test("the async generator wrapper produces the same sequence", async () => {
  async function* src(): AsyncGenerator<OpenAIStreamChunk> {
    yield text("a");
    yield text("b");
    yield chunk({}, "stop");
    yield usageChunk(7, 8);
  }
  const out: AnthropicStreamEvent[] = [];
  for await (const e of translateStream(src(), { pingEveryDeltas: 0 })) out.push(e);
  assert.deepEqual(out.map(sig), [
    "message_start id=msg_str1 in=0 out=0",
    "content_block_start 0 text",
    "ping",
    'content_block_delta 0 text "a"',
    'content_block_delta 0 text "b"',
    "content_block_stop 0",
    "message_delta stop=end_turn seq=null in=7 out=8",
    "message_stop",
  ]);
});

test("raw SSE text in, Anthropic SSE text out, across arbitrary network boundaries", async () => {
  const upstream =
    'data: {"id":"chatcmpl-1","model":"m","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n' +
    ": keepalive\n\n" +
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":"{\\"p\\":"}}]},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6}}\n\n' +
    "data: [DONE]\n\n";

  // Slice the body at 7-byte boundaries, which lands mid-JSON and mid-frame.
  async function* src(): AsyncGenerator<string> {
    for (let i = 0; i < upstream.length; i += 7) yield upstream.slice(i, i + 7);
  }

  let out = "";
  const warnings: string[] = [];
  for await (const s of translateSseText(src(), { pingEveryDeltas: 0 }, warnings)) out += s;

  const names = out
    .split("\n")
    .filter((l) => l.startsWith("event: "))
    .map((l) => l.slice(7));
  assert.deepEqual(names, [
    "message_start",
    "content_block_start",
    "ping",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.ok(out.includes('"partial_json":"{\\"p\\":"'));
  assert.ok(out.includes('"partial_json":"1}"'));
  assert.ok(out.includes('"input_tokens":5,"output_tokens":6'));
  assert.deepEqual(warnings, []);
});
