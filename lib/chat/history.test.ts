/**
 * Unit tests for browser-side conversation history.
 * Run: npm run test:app
 *
 * What these pin down is the failure behaviour, not the happy path. This module
 * reads a value the user can edit in devtools and that an older build may have
 * written, and it writes into a quota that throws when full. Both of those
 * paths end in a conversation the user watched disappear if they are wrong, and
 * neither is exercised by using the product normally.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearThreads,
  createThread,
  HISTORY_STORAGE_KEY,
  loadThreads,
  MAX_MESSAGES_PER_THREAD,
  MAX_THREADS,
  pruneThreads,
  removeThread,
  saveThreads,
  sortThreads,
  titleFromText,
  upsertThread,
  type ChatThread,
  type MinimalStorage,
} from "./history.ts";

function memoryStorage(initial: Record<string, string> = {}): MinimalStorage & {
  raw: Map<string, string>;
} {
  const raw = new Map(Object.entries(initial));
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => {
      raw.set(key, value);
    },
    removeItem: (key) => {
      raw.delete(key);
    },
  };
}

/** A storage that refuses every write, like Safari with storage disabled. */
function throwingStorage(): MinimalStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  };
}

function thread(id: string, updatedAt: number, messages = 1): ChatThread {
  return {
    id,
    modelId: "creator/model",
    title: `thread ${id}`,
    updatedAt,
    messages: Array.from({ length: messages }, (_unused, index) => ({
      id: `${id}-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message ${index}`,
    })),
  };
}

describe("titleFromText", () => {
  it("collapses whitespace and keeps short prompts whole", () => {
    assert.equal(titleFromText("  hello   there \n friend "), "hello there friend");
  });

  it("falls back rather than producing an empty label", () => {
    assert.equal(titleFromText("   "), "New chat");
  });

  it("truncates on a word boundary when one is close to the limit", () => {
    const title = titleFromText("alpha beta gamma delta epsilon zeta eta theta", 20);
    assert.equal(title, "alpha beta gamma…");
    assert.ok(title.length <= 21);
  });

  it("hard-cuts a single long word rather than returning nothing", () => {
    assert.equal(titleFromText("a".repeat(60), 10), `${"a".repeat(10)}…`);
  });
});

describe("sortThreads / upsertThread", () => {
  it("orders newest first", () => {
    const sorted = sortThreads([thread("a", 1), thread("c", 3), thread("b", 2)]);
    assert.deepEqual(
      sorted.map((t) => t.id),
      ["c", "b", "a"],
    );
  });

  it("replaces rather than duplicating an existing thread", () => {
    const before = [thread("a", 1), thread("b", 2)];
    const after = upsertThread(before, { ...thread("a", 9), title: "renamed" });
    assert.equal(after.length, 2);
    assert.equal(after[0]?.id, "a");
    assert.equal(after[0]?.title, "renamed");
  });
});

describe("removeThread", () => {
  it("drops the named thread and keeps the rest newest-first", () => {
    const after = removeThread([thread("a", 1), thread("b", 3), thread("c", 2)], "b");
    assert.deepEqual(
      after.map((t) => t.id),
      ["c", "a"],
    );
  });

  it("returns the array untouched when the id is not there", () => {
    const before = [thread("a", 1)];
    assert.equal(removeThread(before, "nope"), before);
  });

  it("can empty the list", () => {
    assert.deepEqual(removeThread([thread("a", 1)], "a"), []);
  });
});

describe("pruneThreads", () => {
  it("keeps the newest MAX_THREADS", () => {
    const many = Array.from({ length: MAX_THREADS + 5 }, (_unused, i) => thread(`t${i}`, i));
    const pruned = pruneThreads(many);
    assert.equal(pruned.length, MAX_THREADS);
    assert.equal(pruned[0]?.id, `t${MAX_THREADS + 4}`);
  });

  it("truncates a long thread from the FRONT", () => {
    const long = thread("a", 1, MAX_MESSAGES_PER_THREAD + 10);
    const [pruned] = pruneThreads([long]);
    assert.equal(pruned?.messages.length, MAX_MESSAGES_PER_THREAD);
    // The recent turns are the ones the conversation depends on.
    assert.equal(
      pruned?.messages.at(-1)?.id,
      `a-${MAX_MESSAGES_PER_THREAD + 9}`,
    );
  });
});

describe("loadThreads", () => {
  it("returns [] for an empty store", () => {
    assert.deepEqual(loadThreads(memoryStorage()), []);
  });

  it("returns [] rather than throwing on unparseable JSON", () => {
    const storage = memoryStorage({ [HISTORY_STORAGE_KEY]: "{not json" });
    assert.deepEqual(loadThreads(storage), []);
  });

  it("drops entries whose shape is wrong and keeps the rest", () => {
    const storage = memoryStorage({
      [HISTORY_STORAGE_KEY]: JSON.stringify([
        thread("good", 2),
        { id: "bad", title: "no modelId" },
        { ...thread("bad2", 1), messages: [{ id: "x", role: "system", text: "hi" }] },
      ]),
    });
    const loaded = loadThreads(storage);
    assert.deepEqual(
      loaded.map((t) => t.id),
      ["good"],
    );
  });

  it("returns [] when the stored value is not an array", () => {
    const storage = memoryStorage({ [HISTORY_STORAGE_KEY]: JSON.stringify({ a: 1 }) });
    assert.deepEqual(loadThreads(storage), []);
  });
});

describe("saveThreads", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    const written = saveThreads(storage, [thread("a", 1), thread("b", 2)]);
    assert.equal(written.length, 2);
    assert.deepEqual(
      loadThreads(storage).map((t) => t.id),
      ["b", "a"],
    );
  });

  it("returns what was actually written, not what was asked for", () => {
    const storage = memoryStorage();
    const many = Array.from({ length: MAX_THREADS + 3 }, (_unused, i) => thread(`t${i}`, i));
    assert.equal(saveThreads(storage, many).length, MAX_THREADS);
  });

  it("degrades to an unpersisted session when storage refuses every write", () => {
    // Safari private mode. Chat must keep working for this tab.
    assert.deepEqual(saveThreads(throwingStorage(), [thread("a", 1)]), []);
  });

  it("writes nothing for an empty list", () => {
    const storage = memoryStorage({ [HISTORY_STORAGE_KEY]: "[]" });
    assert.deepEqual(saveThreads(storage, []), []);
    assert.equal(storage.raw.has(HISTORY_STORAGE_KEY), false);
  });
});

describe("clearThreads", () => {
  it("removes the key", () => {
    const storage = memoryStorage({ [HISTORY_STORAGE_KEY]: "[]" });
    clearThreads(storage);
    assert.equal(storage.raw.has(HISTORY_STORAGE_KEY), false);
  });
});

describe("createThread", () => {
  it("starts empty, with the placeholder title the first message replaces", () => {
    const fresh = createThread("id", "creator/model", 1234);
    assert.deepEqual(fresh, {
      id: "id",
      modelId: "creator/model",
      title: "New chat",
      updatedAt: 1234,
      messages: [],
    });
  });
});
