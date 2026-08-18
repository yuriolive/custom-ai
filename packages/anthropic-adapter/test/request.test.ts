/** Anthropic Messages request -> OpenAI Chat Completions request. */

import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapterError, translateRequest } from "../src/index.ts";
import type {
  AnthropicMessagesRequest,
  OpenAIFunctionTool,
  OpenAIMessage,
} from "../src/types.ts";

/**
 * The shape Claude Code actually sends: a long system prompt split into cached
 * text blocks, several turns of history, real JSON-Schema tools, an assistant
 * turn containing tool_use, and the user turn carrying the tool_result back.
 */
function claudeCodeRequest(): AnthropicMessagesRequest {
  return {
    model: "claude-opus-5",
    max_tokens: 8192,
    system: [
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.\nYou are an interactive CLI tool that helps users with software engineering tasks.",
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: "# Tone and style\nYou should be concise, direct, and to the point." },
    ],
    messages: [
      { role: "user", content: "read package.json and tell me the test script" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file." },
          {
            type: "tool_use",
            id: "toolu_01A",
            name: "Read",
            input: { file_path: "/repo/package.json", limit: 50 },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01A",
            content: [{ type: "text", text: '{"scripts":{"test":"node --test"}}' }],
          },
        ],
      },
      { role: "user", content: "thanks, now grep for TODO" },
    ],
    tools: [
      {
        name: "Read",
        description: "Reads a file from the local filesystem.",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "The absolute path to the file to read" },
            limit: { type: "number", description: "The number of lines to read" },
          },
          required: ["file_path"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      },
      {
        name: "Grep",
        description: "Content search built on ripgrep.",
        input_schema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
            "-i": { type: "boolean" },
          },
          required: ["pattern"],
        },
      },
      {
        name: "Bash",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
    tool_choice: { type: "auto" },
    stop_sequences: ["\n\nHuman:"],
    temperature: 0,
    top_p: 0.95,
    top_k: 40,
    stream: true,
  };
}

test("a Claude Code-shaped request translates end to end", () => {
  const { request, warnings } = translateRequest(claudeCodeRequest());

  // System becomes ONE leading system message, blocks joined.
  assert.equal(request.messages[0]!.role, "system");
  assert.match(request.messages[0]!.content as string, /^You are Claude Code/);
  assert.match(request.messages[0]!.content as string, /# Tone and style/);

  const roles = request.messages.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool", "user"]);

  // The assistant tool_use became assistant.tool_calls with STRINGIFIED args.
  const assistant = request.messages[2] as OpenAIMessage;
  assert.equal(assistant.content, "I'll read the file.");
  assert.equal(assistant.tool_calls?.length, 1);
  assert.equal(assistant.tool_calls![0]!.id, "toolu_01A");
  assert.equal(assistant.tool_calls![0]!.type, "function");
  assert.equal(assistant.tool_calls![0]!.function.name, "Read");
  assert.equal(
    assistant.tool_calls![0]!.function.arguments,
    '{"file_path":"/repo/package.json","limit":50}',
  );

  // The user-role tool_result became its own {role:"tool"} message.
  const toolMsg = request.messages[3] as OpenAIMessage;
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "toolu_01A");
  assert.equal(toolMsg.content, '{"scripts":{"test":"node --test"}}');

  // max_tokens is carried, never invented.
  assert.equal(request.max_tokens, 8192);

  // Sampling params.
  assert.equal(request.temperature, 0);
  assert.equal(request.top_p, 0.95);
  assert.equal(request.top_k, 40);
  assert.equal(request.stream, true);
  assert.deepEqual(request.stop, ["\n\nHuman:"]);
  assert.deepEqual(request.stream_options, { include_usage: true });

  assert.deepEqual(warnings, []);
});

test("tools: only the schema FIELD is renamed, the JSON Schema body is byte-identical", () => {
  const req = claudeCodeRequest();
  const { request } = translateRequest(req);
  const tools = request.tools as OpenAIFunctionTool[];

  assert.equal(tools.length, 3);
  assert.equal(tools[0]!.type, "function");
  assert.equal(tools[0]!.function.name, "Read");
  assert.equal(tools[0]!.function.description, "Reads a file from the local filesystem.");
  assert.deepEqual(tools[0]!.function.parameters, req.tools![0]!.input_schema);
  assert.equal(
    JSON.stringify(tools[1]!.function.parameters),
    JSON.stringify(req.tools![1]!.input_schema),
  );

  // A tool with no description must not grow an undefined `description` key.
  assert.equal("description" in tools[2]!.function, false);
});

test("tool_choice maps across all four forms", () => {
  const base = { model: "m", max_tokens: 1, messages: [] } as AnthropicMessagesRequest;
  assert.equal(translateRequest({ ...base, tool_choice: { type: "auto" } }).request.tool_choice, "auto");
  assert.equal(translateRequest({ ...base, tool_choice: { type: "any" } }).request.tool_choice, "required");
  assert.equal(translateRequest({ ...base, tool_choice: { type: "none" } }).request.tool_choice, "none");
  assert.deepEqual(
    translateRequest({ ...base, tool_choice: { type: "tool", name: "Grep" } }).request.tool_choice,
    { type: "function", function: { name: "Grep" } },
  );
});

test("missing max_tokens is rejected, not defaulted", () => {
  const req = claudeCodeRequest();
  delete (req as Partial<AnthropicMessagesRequest>).max_tokens;

  assert.throws(
    () => translateRequest(req),
    (err: unknown) => {
      assert.ok(err instanceof AnthropicAdapterError);
      assert.equal(err.anthropicType, "invalid_request_error");
      assert.equal(err.status, 400);
      assert.match(err.message, /max_tokens/);
      assert.deepEqual(err.toResponseBody(), {
        type: "error",
        error: { type: "invalid_request_error", message: err.message },
      });
      return true;
    },
  );

  // Non-integer and out-of-range are rejected too.
  assert.throws(() => translateRequest({ ...req, max_tokens: 1.5 }), AnthropicAdapterError);
  assert.throws(() => translateRequest({ ...req, max_tokens: 0 }), AnthropicAdapterError);
});

test("a string system prompt and string message content both work", () => {
  const { request } = translateRequest({
    model: "m",
    max_tokens: 16,
    system: "be brief",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(request.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ]);
});

test("no system field means no system message is fabricated", () => {
  const { request } = translateRequest({
    model: "m",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0]!.role, "user");
});

test("image blocks become image_url parts; base64 becomes a data URI", () => {
  const { request } = translateRequest({
    model: "m",
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
        ],
      },
    ],
  });
  assert.deepEqual(request.messages[0]!.content, [
    { type: "text", text: "what is this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "image_url", image_url: { url: "https://example.com/a.png" } },
  ]);
});

test("multiple tool_results in one user turn fan out to multiple tool messages", () => {
  const { request } = translateRequest({
    model: "m",
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "ra" },
          { type: "tool_result", tool_use_id: "b", content: "rb", is_error: true },
          { type: "text", text: "keep going" },
        ],
      },
    ],
  });
  assert.deepEqual(request.messages, [
    { role: "tool", tool_call_id: "a", content: "ra" },
    { role: "tool", tool_call_id: "b", content: "rb" },
    { role: "user", content: "keep going" },
  ]);
});

test("input thinking blocks are dropped with a warning, or kept as text on request", () => {
  const msg: AnthropicMessagesRequest = {
    model: "m",
    max_tokens: 16,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "prior CoT", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  const dropped = translateRequest(msg);
  assert.equal(dropped.request.messages[0]!.content, "answer");
  assert.equal(dropped.warnings.length, 1);
  assert.match(dropped.warnings[0]!, /thinking/);

  const kept = translateRequest(msg, { thinkingBlocks: "text" });
  assert.equal(kept.request.messages[0]!.content, "prior CoTanswer");
  assert.deepEqual(kept.warnings, []);
});

test("the thinking config and metadata are reported as dropped, not silently lost", () => {
  const { warnings } = translateRequest({
    model: "m",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 4096 },
    metadata: { user_id: "u1" },
  });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => /thinking/.test(w)));
  assert.ok(warnings.some((w) => /metadata/.test(w)));
});

test("model can be overridden for gateway routing and stream_options suppressed", () => {
  const { request } = translateRequest(
    { model: "claude-opus-5", max_tokens: 4, messages: [], stream: true },
    { model: "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF", includeUsage: false },
  );
  assert.equal(request.model, "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF");
  assert.equal(request.stream_options, undefined);
});
