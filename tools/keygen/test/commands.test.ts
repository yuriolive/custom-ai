import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { create, list, revoke, CommandError, type Io } from "../commands.ts";
import type { ApiKeyRow, KeyStore, NewApiKey, ProfileRef } from "../db.ts";
import { isUuid } from "../db.ts";
import { PLAINTEXT_KEY_RE } from "../key.ts";

// ── in-memory double for the KeyStore seam ──────────────────────────────────

class FakeStore implements KeyStore {
  profiles: ProfileRef[] = [
    { id: "00000000-0000-0000-0000-0000000000a2", handle: "devcaller" },
    { id: "00000000-0000-0000-0000-0000000000a1", handle: "jonathancoletti" },
  ];
  /** Everything that was handed to the database, verbatim. */
  writes: NewApiKey[] = [];
  rows: ApiKeyRow[] = [];
  #n = 0;

  async findProfile(ref: string): Promise<ProfileRef | null> {
    return this.profiles.find((p) => (isUuid(ref) ? p.id === ref : p.handle === ref)) ?? null;
  }

  async insertKey(row: NewApiKey): Promise<ApiKeyRow> {
    this.writes.push({ ...row });
    const created: ApiKeyRow = {
      id: `00000000-0000-0000-0000-00000000${String(++this.#n).padStart(4, "0")}`,
      user_id: row.user_id,
      name: row.name,
      key_prefix: row.key_prefix,
      scopes: ["inference"],
      last_used_at: null,
      request_count: 0,
      revoked_at: null,
      created_at: "2026-08-17T12:00:00.000Z",
    };
    this.rows.push(created);
    return created;
  }

  async listKeys(userId: string): Promise<ApiKeyRow[]> {
    return this.rows.filter((r) => r.user_id === userId);
  }

  async findKeys(selector: string): Promise<ApiKeyRow[]> {
    return this.rows.filter((r) =>
      isUuid(selector) ? r.id === selector : r.key_prefix === selector,
    );
  }

  async revokeKey(id: string): Promise<ApiKeyRow> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error("not found");
    row.revoked_at = "2026-08-17T13:00:00.000Z";
    return row;
  }
}

function makeIo(answer: boolean | "no-tty" = true) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let prompts = 0;
  const io: Io = {
    out: (l) => void stdout.push(l),
    err: (l) => void stderr.push(l),
    async confirm() {
      prompts++;
      return answer === true;
    },
  };
  return {
    io,
    stdout,
    stderr,
    get prompts() {
      return prompts;
    },
    all: () => [...stdout, ...stderr].join("\n"),
  };
}

// ── create ──────────────────────────────────────────────────────────────────

test("create prints the plaintext exactly once, on stdout, and nowhere else", async () => {
  const store = new FakeStore();
  const cap = makeIo();

  await create(store, { user: "devcaller", name: "laptop" }, cap.io);

  const plaintext = cap.stdout.find((l) => PLAINTEXT_KEY_RE.test(l));
  assert.ok(plaintext, "no plaintext key found on stdout");

  // Exactly one line of stdout, and it IS the key.
  assert.deepEqual(cap.stdout, [plaintext]);

  // The plaintext appears exactly once across every byte this command emitted.
  const combined = cap.all();
  const occurrences = combined.split(plaintext).length - 1;
  assert.equal(occurrences, 1, `plaintext emitted ${occurrences} times, expected exactly 1`);

  // Not even a truncation of it leaks into stderr beyond the 16-char display prefix.
  const body = plaintext.slice(16);
  assert.ok(!cap.stderr.join("\n").includes(body), "key body leaked into stderr");
});

test("create persists ONLY the hash — the plaintext never reaches the database", async () => {
  const store = new FakeStore();
  const cap = makeIo();

  await create(store, { user: "devcaller", name: "laptop" }, cap.io);

  assert.equal(store.writes.length, 1);
  const write = store.writes[0]!;
  const plaintext = cap.stdout[0]!;

  const serialized = JSON.stringify(write);
  assert.ok(!serialized.includes(plaintext), "plaintext was sent to the database");
  assert.ok(!serialized.includes(plaintext.slice(16)), "key body was sent to the database");

  // What WAS sent is the SHA-256 of what was printed. This is the round trip.
  assert.equal(write.key_hash, createHash("sha256").update(plaintext, "utf8").digest("hex"));
  assert.match(write.key_hash, /^[a-f0-9]{64}$/);
  assert.equal(write.key_prefix, plaintext.slice(0, 16));
  assert.equal(write.user_id, "00000000-0000-0000-0000-0000000000a2");
  assert.equal(write.name, "laptop");
  assert.deepEqual(Object.keys(write).toSorted(), ["key_hash", "key_prefix", "name", "user_id"]);
});

test("create carries an unmissable one-time warning", async () => {
  const store = new FakeStore();
  const cap = makeIo();
  await create(store, { user: "devcaller", name: "laptop" }, cap.io);
  const stderr = cap.stderr.join("\n");
  assert.match(stderr, /NEVER BE SHOWN AGAIN/);
  assert.match(stderr, /SHA-256 hash was stored/);
});

test("create resolves a user by uuid as well as by handle", async () => {
  const store = new FakeStore();
  const cap = makeIo();
  await create(store, { user: "00000000-0000-0000-0000-0000000000a1", name: "by-uuid" }, cap.io);
  assert.equal(store.writes[0]!.user_id, "00000000-0000-0000-0000-0000000000a1");
});

test("create rejects an unknown user before generating any entropy", async () => {
  const store = new FakeStore();
  const cap = makeIo();
  await assert.rejects(
    () => create(store, { user: "nobody", name: "x" }, cap.io),
    (e: Error) => e instanceof CommandError && /No profile matches/.test(e.message),
  );
  assert.equal(store.writes.length, 0);
  assert.deepEqual(cap.stdout, []);
});

test("create enforces the name CHECK constraint before touching the database", async () => {
  const store = new FakeStore();
  const cap = makeIo();
  for (const name of ["", "x".repeat(61)]) {
    await assert.rejects(
      () => create(store, { user: "devcaller", name }, cap.io),
      (e: Error) => e instanceof CommandError && /1\.\.60/.test(e.message),
    );
  }
  assert.equal(store.writes.length, 0);
});

test("two successive creates produce different keys", async () => {
  const store = new FakeStore();
  const a = makeIo();
  const b = makeIo();
  await create(store, { user: "devcaller", name: "one" }, a.io);
  await create(store, { user: "devcaller", name: "two" }, b.io);
  assert.notEqual(a.stdout[0], b.stdout[0]);
  assert.notEqual(store.writes[0]!.key_hash, store.writes[1]!.key_hash);
});

// ── list ────────────────────────────────────────────────────────────────────

test("list shows name, prefix, created, last used and revoked status — never the hash", async () => {
  const store = new FakeStore();
  await create(store, { user: "devcaller", name: "laptop" }, makeIo().io);
  await create(store, { user: "devcaller", name: "ci" }, makeIo().io);
  store.rows[1]!.revoked_at = "2026-08-17T13:30:00.000Z";
  store.rows[0]!.last_used_at = "2026-08-17T12:45:00.000Z";
  store.rows[0]!.request_count = 7;

  const cap = makeIo();
  await list(store, "devcaller", cap.io);
  const out = cap.stdout.join("\n");

  assert.match(out, /name/);
  assert.match(out, /laptop/);
  assert.match(out, /\bci\b/);
  assert.match(out, /sk-plat-[A-Za-z0-9_-]{8}\b/);
  assert.match(out, /2026-08-17 12:00:00Z/); // created
  assert.match(out, /2026-08-17 12:45:00Z/); // last used
  assert.match(out, /never/); // never-used key
  assert.match(out, /active/);
  assert.match(out, /revoked 2026-08-17 13:30:00Z/);

  // Nothing reconstructible: no 64-hex string, no 43-char key body anywhere.
  const all = cap.all();
  assert.ok(!/[a-f0-9]{64}/.test(all), "a sha256-looking value appeared in list output");
  assert.ok(!PLAINTEXT_KEY_RE.test(all.replace(/\s+/g, "")), "a full key appeared in list output");
  for (const w of store.writes) {
    assert.ok(!all.includes(w.key_hash), "key_hash appeared in list output");
  }
});

test("list on a user with no keys says so and prints no table", async () => {
  const store = new FakeStore();
  const cap = makeIo();
  const rows = await list(store, "jonathancoletti", cap.io);
  assert.deepEqual(rows, []);
  assert.deepEqual(cap.stdout, []);
  assert.match(cap.stderr.join("\n"), /No API keys for jonathancoletti/);
});

test("list rejects an unknown user", async () => {
  const store = new FakeStore();
  await assert.rejects(
    () => list(store, "nobody", makeIo().io),
    (e: Error) => e instanceof CommandError,
  );
});

// ── revoke ──────────────────────────────────────────────────────────────────

test("revoke requires confirmation and aborts on 'no'", async () => {
  const store = new FakeStore();
  await create(store, { user: "devcaller", name: "laptop" }, makeIo().io);
  const id = store.rows[0]!.id;

  const cap = makeIo(false);
  await assert.rejects(
    () => revoke(store, { selector: id, yes: false }, cap.io),
    (e: Error) => e instanceof CommandError && /Aborted/.test(e.message),
  );
  assert.equal(cap.prompts, 1);
  assert.equal(store.rows[0]!.revoked_at, null, "key was revoked despite a 'no' answer");
});

test("revoke sets revoked_at when confirmed", async () => {
  const store = new FakeStore();
  await create(store, { user: "devcaller", name: "laptop" }, makeIo().io);
  const id = store.rows[0]!.id;

  const cap = makeIo(true);
  const row = await revoke(store, { selector: id, yes: false }, cap.io);
  assert.equal(cap.prompts, 1);
  assert.equal(row.revoked_at, "2026-08-17T13:00:00.000Z");
  assert.match(cap.stderr.join("\n"), /cannot be undone/);
});

test("revoke works by display prefix", async () => {
  const store = new FakeStore();
  const created = makeIo();
  await create(store, { user: "devcaller", name: "laptop" }, created.io);
  const prefix = created.stdout[0]!.slice(0, 16);

  const cap = makeIo(true);
  const row = await revoke(store, { selector: prefix, yes: false }, cap.io);
  assert.ok(row.revoked_at);
});

test("--yes skips the prompt but is the only way to do so", async () => {
  const store = new FakeStore();
  await create(store, { user: "devcaller", name: "laptop" }, makeIo().io);
  const cap = makeIo(false);
  const row = await revoke(store, { selector: store.rows[0]!.id, yes: true }, cap.io);
  assert.equal(cap.prompts, 0);
  assert.ok(row.revoked_at);
});

test("revoke refuses an ambiguous prefix rather than guessing", async () => {
  const store = new FakeStore();
  await create(store, { user: "devcaller", name: "one" }, makeIo().io);
  await create(store, { user: "devcaller", name: "two" }, makeIo().io);
  // Force a prefix collision.
  store.rows[1]!.key_prefix = store.rows[0]!.key_prefix;

  const cap = makeIo(true);
  await assert.rejects(
    () => revoke(store, { selector: store.rows[0]!.key_prefix, yes: true }, cap.io),
    (e: Error) => e instanceof CommandError && /Ambiguous/.test(e.message),
  );
  assert.equal(store.rows[0]!.revoked_at, null);
  assert.equal(store.rows[1]!.revoked_at, null);
});

test("revoke never accepts a full plaintext key as a selector", async () => {
  const store = new FakeStore();
  const created = makeIo();
  await create(store, { user: "devcaller", name: "laptop" }, created.io);
  const plaintext = created.stdout[0]!;

  const cap = makeIo(true);
  await assert.rejects(
    () => revoke(store, { selector: plaintext, yes: true }, cap.io),
    (e: Error) => e instanceof CommandError && /never accepted as input/.test(e.message),
  );
  assert.ok(!cap.all().includes(plaintext.slice(16)), "key body echoed back in the error path");
});

test("revoke on an already-revoked key is a no-op that says so", async () => {
  const store = new FakeStore();
  await create(store, { user: "devcaller", name: "laptop" }, makeIo().io);
  store.rows[0]!.revoked_at = "2026-08-16T00:00:00.000Z";

  const cap = makeIo(true);
  const row = await revoke(store, { selector: store.rows[0]!.id, yes: false }, cap.io);
  assert.equal(cap.prompts, 0);
  assert.equal(row.revoked_at, "2026-08-16T00:00:00.000Z");
  assert.match(cap.stderr.join("\n"), /already revoked/);
});

test("revoke rejects a selector that is neither uuid nor display prefix", async () => {
  const store = new FakeStore();
  await assert.rejects(
    () => revoke(store, { selector: "laptop", yes: true }, makeIo().io),
    (e: Error) =>
      e instanceof CommandError && /neither a key uuid nor a display prefix/.test(e.message),
  );
});
