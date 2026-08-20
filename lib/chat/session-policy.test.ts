import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHAT_KEY_SCOPE,
  chatKeyCookieName,
  chatKeysToRevoke,
  isChatKey,
  MAX_CHAT_KEYS_PER_USER,
  type ChatKeyRow,
} from "./session-policy.ts";

function row(overrides: Partial<ChatKeyRow> & { id: string }): ChatKeyRow {
  return {
    scopes: ["inference", CHAT_KEY_SCOPE],
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("chatKeyCookieName", () => {
  it("uses the __Host- prefix only where the cookie can actually be Secure", () => {
    assert.equal(chatKeyCookieName(true).startsWith("__Host-"), true);
    // Over plain http a __Host- cookie is rejected by the browser, so dev must
    // not get one — the failure would look like a broken key, not a lost cookie.
    assert.equal(chatKeyCookieName(false).startsWith("__Host-"), false);
  });
});

describe("isChatKey", () => {
  it("matches only live keys carrying the chat scope", () => {
    assert.equal(isChatKey(row({ id: "a" })), true);
    assert.equal(isChatKey(row({ id: "b", scopes: ["inference"] })), false);
    assert.equal(isChatKey(row({ id: "c", scopes: null })), false);
    assert.equal(
      isChatKey(row({ id: "d", revoked_at: "2026-01-02T00:00:00.000Z" })),
      false,
    );
  });
});

describe("chatKeysToRevoke", () => {
  const at = (iso: string, id: string) => row({ id, created_at: iso });

  it("revokes nothing while there is room for one more", () => {
    const rows = [at("2026-01-01T00:00:00.000Z", "a"), at("2026-01-02T00:00:00.000Z", "b")];
    assert.deepEqual(chatKeysToRevoke(rows, 3), []);
  });

  it("frees exactly one slot when the cap is already reached", () => {
    const rows = [
      at("2026-01-03T00:00:00.000Z", "c"),
      at("2026-01-01T00:00:00.000Z", "a"),
      at("2026-01-02T00:00:00.000Z", "b"),
    ];
    // Oldest first, and only as many as needed to land back on the cap after
    // the new key is inserted.
    assert.deepEqual(chatKeysToRevoke(rows, 3), ["a"]);
  });

  it("catches up when an account is over the cap", () => {
    const rows = [
      at("2026-01-01T00:00:00.000Z", "a"),
      at("2026-01-02T00:00:00.000Z", "b"),
      at("2026-01-03T00:00:00.000Z", "c"),
      at("2026-01-04T00:00:00.000Z", "d"),
      at("2026-01-05T00:00:00.000Z", "e"),
    ];
    assert.deepEqual(chatKeysToRevoke(rows, 3), ["a", "b", "c"]);
  });

  it("ignores keys that are not chat keys", () => {
    const rows = [
      row({ id: "api-1", scopes: ["inference"], created_at: "2020-01-01T00:00:00.000Z" }),
      row({ id: "api-2", scopes: ["inference"], created_at: "2020-01-02T00:00:00.000Z" }),
      at("2026-01-01T00:00:00.000Z", "chat-1"),
    ];
    // A user's own API keys are never collateral damage of opening a chat.
    assert.deepEqual(chatKeysToRevoke(rows, 1), ["chat-1"]);
  });

  it("is deterministic when two keys share a timestamp", () => {
    const rows = [at("2026-01-01T00:00:00.000Z", "b"), at("2026-01-01T00:00:00.000Z", "a")];
    assert.deepEqual(chatKeysToRevoke(rows, 1), ["a", "b"]);
  });

  it("defaults to the policy cap", () => {
    const rows = Array.from({ length: MAX_CHAT_KEYS_PER_USER }, (_unused, index) =>
      at(`2026-01-0${index + 1}T00:00:00.000Z`, `k${index}`),
    );
    assert.equal(chatKeysToRevoke(rows).length, 1);
  });
});
