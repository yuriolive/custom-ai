/** OpenAI Chat Completions response (non-streaming) -> Anthropic Message. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  mapFinishReason,
  mapStopReason,
  translateResponse,
  translateUsage,
} from "../src/index.ts";
import type { OpenAIChatResponse } from "../src/types.ts";

function resp(partial: Partial<OpenAIChatResponse>): OpenAIChatResponse {
  return {
    id: "chatcmpl-abc123",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    choices: [],
    ...partial,
  };
}

test("text becomes a content ARRAY with one text block, not a bare string", () => {
  const { message } = translateResponse(
    resp({
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello there." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 25, completion_tokens: 4, total_tokens: 29 },
    }),
  );

  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.equal(message.id, "msg_abc123");
  assert.equal(message.model, "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF");
  assert.deepEqual(message.content, [{ type: "text", text: "Hello there." }]);
  assert.equal(message.stop_reason, "end_turn");
  assert.equal(message.stop_sequence, null);
});

test("usage renames both fields and does NOT invent total_tokens", () => {
  const { message } = translateResponse(
    resp({
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
    }),
  );
  assert.deepEqual(message.usage, { input_tokens: 1234, output_tokens: 56 });
  assert.equal("total_tokens" in message.usage, false);
});

test("usage carries cached prompt tokens and reasoning tokens when present", () => {
  assert.deepEqual(
    translateUsage({
      prompt_tokens: 100,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 64 },
      completion_tokens_details: { reasoning_tokens: 180 },
    }),
    {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 64,
      output_tokens_details: { thinking_tokens: 180 },
    },
  );
  assert.deepEqual(translateUsage(undefined), { input_tokens: 0, output_tokens: 0 });
});

test("tool_calls become tool_use blocks with input PARSED from the arguments string", () => {
  const { message, warnings } = translateResponse(
    resp({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Let me look.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "Read", arguments: '{"file_path":"/a.ts","limit":10}' },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "Grep", arguments: '{"pattern":"TODO"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  );

  assert.deepEqual(warnings, []);
  assert.deepEqual(message.content, [
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/a.ts", limit: 10 } },
    { type: "tool_use", id: "call_2", name: "Grep", input: { pattern: "TODO" } },
  ]);
  assert.equal(message.stop_reason, "tool_use");
});

test("malformed tool arguments are reported, not thrown", () => {
  const { message, warnings } = translateResponse(
    resp({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_bad", type: "function", function: { name: "Read", arguments: '{"file_path": ' } },
              { id: "call_arr", type: "function", function: { name: "Grep", arguments: "[1,2]" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
  );

  assert.deepEqual(message.content, [
    { type: "tool_use", id: "call_bad", name: "Read", input: {} },
    { type: "tool_use", id: "call_arr", name: "Grep", input: {} },
  ]);
  assert.equal(warnings.length, 3); // two bad calls + the missing-usage warning
  assert.ok(warnings.some((w) => /call_bad.*not valid JSON/.test(w)));
  assert.ok(warnings.some((w) => /call_arr.*non-object/.test(w)));
});

test("reasoning_content becomes a leading thinking block", () => {
  const { message } = translateResponse(
    resp({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            reasoning_content: "The user wants X. I should do Y.",
            content: "Y.",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 40 },
    }),
  );
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "The user wants X. I should do Y.", signature: "" },
    { type: "text", text: "Y." },
  ]);
});

test("every finish_reason maps, in both directions", () => {
  assert.equal(mapFinishReason("stop"), "end_turn");
  assert.equal(mapFinishReason("length"), "max_tokens");
  assert.equal(mapFinishReason("tool_calls"), "tool_use");
  assert.equal(mapFinishReason("function_call"), "tool_use");
  assert.equal(mapFinishReason("content_filter"), "refusal");
  assert.equal(mapFinishReason(null), null);

  assert.equal(mapStopReason("end_turn"), "stop");
  assert.equal(mapStopReason("stop_sequence"), "stop");
  assert.equal(mapStopReason("max_tokens"), "length");
  assert.equal(mapStopReason("model_context_window_exceeded"), "length");
  assert.equal(mapStopReason("tool_use"), "tool_calls");
  assert.equal(mapStopReason("refusal"), "content_filter");
  assert.equal(mapStopReason("pause_turn"), "stop");
  assert.equal(mapStopReason(null), null);
});

test("finish_reason length becomes max_tokens", () => {
  const { message } = translateResponse(
    resp({
      choices: [
        { index: 0, message: { role: "assistant", content: "truncat" }, finish_reason: "length" },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4096 },
    }),
  );
  assert.equal(message.stop_reason, "max_tokens");
});

test("a stop-sequence hit becomes stop_sequence and the sequence is removed from the text", () => {
  // Path 1: the server left the sequence in the text.
  const suffix = translateResponse(
    resp({
      choices: [
        { index: 0, message: { role: "assistant", content: "answer\n\nHuman:" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { stopSequences: ["\n\nHuman:"] },
  );
  assert.equal(suffix.message.stop_reason, "stop_sequence");
  assert.equal(suffix.message.stop_sequence, "\n\nHuman:");
  assert.deepEqual(suffix.message.content, [{ type: "text", text: "answer" }]);

  // Path 2: vLLM reports the matched string on the choice and strips the text.
  const reported = translateResponse(
    resp({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "answer" },
          finish_reason: "stop",
          stop_reason: "END",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { stopSequences: ["END"] },
  );
  assert.equal(reported.message.stop_reason, "stop_sequence");
  assert.equal(reported.message.stop_sequence, "END");
  assert.deepEqual(reported.message.content, [{ type: "text", text: "answer" }]);

  // Path 3: llama.cpp strips it and reports nothing -> plain end_turn.
  const silent = translateResponse(
    resp({
      choices: [
        { index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { stopSequences: ["\n\nHuman:"] },
  );
  assert.equal(silent.message.stop_reason, "end_turn");
  assert.equal(silent.message.stop_sequence, null);
});

test("an empty response still produces one legal content block", () => {
  const { message, warnings } = translateResponse(resp({ choices: [] }));
  assert.deepEqual(message.content, [{ type: "text", text: "" }]);
  assert.equal(message.stop_reason, null);
  assert.ok(warnings.some((w) => /no usage/.test(w)));
});

test("n>1 is reported and truncated to choice[0]", () => {
  const { warnings } = translateResponse(
    resp({
      choices: [
        { index: 0, message: { role: "assistant", content: "a" }, finish_reason: "stop" },
        { index: 1, message: { role: "assistant", content: "b" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );
  assert.ok(warnings.some((w) => /2 choices/.test(w)));
});
