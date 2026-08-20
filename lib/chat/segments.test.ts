/**
 * Unit tests for reply segmentation.
 * Run: npm run test:app
 *
 * The streaming case is the one that matters. A fence arrives half-open on
 * every reply that contains code, and if an unterminated block did not render
 * as a code block immediately the transcript would visibly reflow the moment
 * the closing fence landed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitSegments } from "./segments.ts";

describe("splitSegments", () => {
  it("returns nothing for an empty string", () => {
    assert.deepEqual(splitSegments(""), []);
  });

  it("treats prose as one text segment, newlines intact", () => {
    assert.deepEqual(splitSegments("line one\nline two"), [
      { type: "text", id: 0, text: "line one\nline two" },
    ]);
  });

  it("splits prose around a fenced block and keeps the language tag", () => {
    const reply = "Here you go:\n```python\nprint(1)\n```\nThat is it.";
    assert.deepEqual(splitSegments(reply), [
      { type: "text", id: 0, text: "Here you go:" },
      { type: "code", id: 1, code: "print(1)", language: "python", closed: true },
      { type: "text", id: 4, text: "That is it." },
    ]);
  });

  it("renders an unterminated fence as an open code block", () => {
    assert.deepEqual(splitSegments("Try:\n```ts\nconst a = 1"), [
      { type: "text", id: 0, text: "Try:" },
      { type: "code", id: 1, code: "const a = 1", language: "ts", closed: false },
    ]);
  });

  it("handles a fence with no language", () => {
    assert.deepEqual(splitSegments("```\nplain\n```"), [
      { type: "code", id: 0, code: "plain", language: null, closed: true },
    ]);
  });

  it("takes only the first word of a fence info string", () => {
    const [segment] = splitSegments("```js title=demo.js\nx\n```");
    assert.equal(segment?.type === "code" && segment.language, "js");
  });

  it("drops whitespace-only runs between blocks", () => {
    const segments = splitSegments("```\na\n```\n\n```\nb\n```");
    assert.equal(segments.length, 2);
    assert.equal(segments.every((s) => s.type === "code"), true);
  });

  it("keeps blank lines INSIDE a code block", () => {
    const [segment] = splitSegments("```\na\n\nb\n```");
    assert.equal(segment?.type === "code" && segment.code, "a\n\nb");
  });

  it("gives each segment an id that survives a later one being appended", () => {
    // Mid-stream the trailing prose does not exist yet. The segments that do
    // exist must keep the same ids once it arrives, or React remounts them and
    // the transcript flickers as the reply lands.
    const open = splitSegments("Here you go:\n```python\nprint(1)\n```");
    const complete = splitSegments("Here you go:\n```python\nprint(1)\n```\nThat is it.");
    assert.deepEqual(
      open.map((segment) => segment.id),
      complete.slice(0, open.length).map((segment) => segment.id),
    );
  });

  it("does not treat inline backticks as a fence", () => {
    assert.deepEqual(splitSegments("use the ```code``` thing"), [
      { type: "text", id: 0, text: "use the ```code``` thing" },
    ]);
  });

  it("tolerates an indented fence", () => {
    const segments = splitSegments("  ```\nx\n  ```");
    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.type, "code");
  });
});
