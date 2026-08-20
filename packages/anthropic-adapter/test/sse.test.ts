/** SSE framing and incremental decoding. */

import assert from "node:assert/strict";
import test from "node:test";

import { createSseDecoder, formatSseEvents, isDoneSentinel } from "../src/index.ts";

test("frames are split on blank lines and data: payloads extracted", () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push('data: {"a":1}\n\ndata: {"b":2}\n\n'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(d.flush(), []);
});

test("a payload split across pushes is only emitted once complete", () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push('data: {"a'), []);
  assert.deepEqual(d.push('":1}'), []);
  assert.deepEqual(d.push("\n"), []);
  assert.deepEqual(d.push("\n"), ['{"a":1}']);
});

test("CRLF line endings and comment keepalives are handled", () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push(': keepalive\r\n\r\ndata: {"a":1}\r\n\r\n'), ['{"a":1}']);
});

test("a trailing unterminated frame is recovered by flush", () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push("data: [DONE]"), []);
  const out = d.flush();
  assert.deepEqual(out, ["[DONE]"]);
  assert.equal(isDoneSentinel(out[0]!), true);
  assert.equal(isDoneSentinel('{"a":1}'), false);
});

test("multi-line data fields are joined with newlines", () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push("event: x\ndata: line1\ndata: line2\n\n"), ["line1\nline2"]);
});

test("formatSseEvents concatenates frames in order", () => {
  const out = formatSseEvents([
    { type: "ping" },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ]);
  assert.equal(
    out,
    'event: ping\ndata: {"type":"ping"}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
});
