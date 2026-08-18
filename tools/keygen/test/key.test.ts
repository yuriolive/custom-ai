import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  isValidKeyName,
  KEY_DISPLAY_PREFIX_LENGTH,
  KEY_HASH_CHECK_RE,
  KEY_PREFIX,
  KEY_PREFIX_CHECK_RE,
  KEY_TOTAL_LENGTH,
  PLAINTEXT_KEY_RE,
} from "../key.ts";
import { SAFE_KEY_COLUMNS } from "../db.ts";

// The gateway's own module, imported separately from our re-export, so the
// "same digest" assertions below are meaningful rather than tautological-looking.
import * as gatewayAuth from "../../../supabase/functions/gateway/auth.ts";

const MIGRATION = fileURLToPath(
  new URL("../../../supabase/migrations/20260817000500_api_keys.sql", import.meta.url),
);

test("generated key matches ^sk-plat-[A-Za-z0-9_-]{43}$", async () => {
  for (let i = 0; i < 200; i++) {
    const key = await generateApiKey();
    assert.match(key.plaintext, /^sk-plat-[A-Za-z0-9_-]{43}$/);
    assert.match(key.plaintext, PLAINTEXT_KEY_RE);
    assert.equal(key.plaintext.length, KEY_TOTAL_LENGTH);
    assert.equal(key.plaintext.length, 51);
  }
});

test("the gateway accepts every key we mint", async () => {
  for (let i = 0; i < 200; i++) {
    const key = await generateApiKey();
    assert.ok(
      gatewayAuth.isWellFormedApiKey(key.plaintext),
      "gateway rejected a key this tool minted",
    );
    assert.ok(isWellFormedApiKey(key.plaintext));
  }
});

test("PLAINTEXT_KEY_RE and the gateway's isWellFormedApiKey agree on rejections", () => {
  const cases = [
    "",
    "sk-plat-",
    "sk-plat-short",
    `${KEY_PREFIX}${"a".repeat(42)}`,
    `${KEY_PREFIX}${"a".repeat(44)}`,
    `${KEY_PREFIX}${"a".repeat(42)}+`, // '+' is base64, not base64url
    `${KEY_PREFIX}${"a".repeat(42)}=`,
    `sk-live-${"a".repeat(43)}`,
    ` sk-plat-${"a".repeat(43)}`,
    `${KEY_PREFIX}${"a".repeat(43)} `,
    // The seeded fixture key: 33 body chars, not 43. See the report.
    "sk-plat-mvp0seedkey0000000000000000000000",
  ];
  for (const c of cases) {
    assert.equal(
      PLAINTEXT_KEY_RE.test(c),
      gatewayAuth.isWellFormedApiKey(c),
      `disagreement on ${JSON.stringify(c)}`,
    );
    assert.equal(PLAINTEXT_KEY_RE.test(c), false, `should have been rejected: ${c}`);
  }
  // …and a real one is accepted by both.
  const good = `${KEY_PREFIX}${"a".repeat(43)}`;
  assert.equal(PLAINTEXT_KEY_RE.test(good), true);
  assert.equal(gatewayAuth.isWellFormedApiKey(good), true);
});

test("display prefix satisfies the schema's key_prefix CHECK constraint", async () => {
  // Read the constraint out of the migration rather than trusting a memory of it.
  const sql = readFileSync(MIGRATION, "utf8");
  const match = /key_prefix\s+text not null check \(key_prefix ~ '([^']+)'\)/.exec(sql);
  assert.ok(match, "could not locate the key_prefix CHECK in the migration");
  const constraintSource = match[1]!;
  assert.equal(
    constraintSource,
    KEY_PREFIX_CHECK_RE.source,
    "KEY_PREFIX_CHECK_RE has drifted from the migration",
  );

  const fromSchema = new RegExp(constraintSource);
  for (let i = 0; i < 200; i++) {
    const key = await generateApiKey();
    assert.match(key.prefix, fromSchema);
    assert.equal(key.prefix.length, KEY_DISPLAY_PREFIX_LENGTH);
    assert.equal(key.prefix.length, 16); // 'sk-plat-' + 8
    assert.equal(key.prefix, key.plaintext.slice(0, 16));
  }
});

test("key_hash satisfies the schema's CHECK constraint: 64 lower-case hex chars", async () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const match = /key_hash\s+text not null unique check \(key_hash ~ '([^']+)'\)/.exec(sql);
  assert.ok(match, "could not locate the key_hash CHECK in the migration");
  assert.equal(match[1]!, KEY_HASH_CHECK_RE.source);

  const fromSchema = new RegExp(match[1]!);
  for (let i = 0; i < 100; i++) {
    const key = await generateApiKey();
    assert.equal(key.hash.length, 64);
    assert.match(key.hash, fromSchema);
    assert.equal(key.hash, key.hash.toLowerCase());
  }
});

test("api_keys.name CHECK constraint (1..60) is enforced client-side", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(sql, /check \(char_length\(name\) between 1 and 60\)/);
  assert.equal(isValidKeyName(""), false);
  assert.equal(isValidKeyName("a"), true);
  assert.equal(isValidKeyName("a".repeat(60)), true);
  assert.equal(isValidKeyName("a".repeat(61)), false);
});

test("two generated keys never collide", async () => {
  const N = 2000;
  const plaintexts = new Set<string>();
  const hashes = new Set<string>();
  const prefixes: string[] = [];
  for (let i = 0; i < N; i++) {
    const key = await generateApiKey();
    plaintexts.add(key.plaintext);
    hashes.add(key.hash);
    prefixes.push(key.prefix);
  }
  assert.equal(plaintexts.size, N, "duplicate plaintext generated");
  assert.equal(hashes.size, N, "duplicate hash generated");
  // The 16-char display prefix is NOT unique by construction — the schema does
  // not constrain it, and `revoke` treats a multi-match as ambiguous rather than
  // guessing. This asserts the property we rely on, not an absence of collisions.
  assert.equal(prefixes.length, N);
});

test("digest agrees with the gateway's hashApiKey and with node:crypto", async () => {
  const vectors = [
    "sk-plat-mvp0seedkey0000000000000000000000",
    `${KEY_PREFIX}${"a".repeat(43)}`,
    "",
    "not-a-key",
  ];
  for (const v of vectors) {
    const ours = await hashApiKey(v);
    const gateway = await gatewayAuth.hashApiKey(v);
    const node = createHash("sha256").update(v, "utf8").digest("hex");
    assert.equal(ours, gateway, `keygen vs gateway digest mismatch for ${JSON.stringify(v)}`);
    assert.equal(ours, node, `keygen vs node:crypto digest mismatch for ${JSON.stringify(v)}`);
  }

  // Freshly minted keys, hashed independently.
  for (let i = 0; i < 100; i++) {
    const key = await generateApiKey();
    assert.equal(key.hash, await gatewayAuth.hashApiKey(key.plaintext));
    assert.equal(key.hash, createHash("sha256").update(key.plaintext, "utf8").digest("hex"));
  }
});

test("the seed fixture's documented hash reproduces exactly", async () => {
  // supabase/seed.sql pins this pair; if either side ever changes, this fails.
  assert.equal(
    await hashApiKey("sk-plat-mvp0seedkey0000000000000000000000"),
    "b17d62828e69077b7bc277ae9de745fc5474ad94a702e15f22888c0bbd060e49",
  );
});

test("there is exactly ONE implementation of the format", () => {
  // Identity, not equality: key.ts re-exports the gateway's functions rather than
  // copying them, so drift is impossible by construction.
  assert.equal(hashApiKey, gatewayAuth.hashApiKey);
  assert.equal(generateApiKey, gatewayAuth.generateApiKey);
  assert.equal(isWellFormedApiKey, gatewayAuth.isWellFormedApiKey);
  assert.equal(KEY_PREFIX, gatewayAuth.KEY_PREFIX);
  assert.equal(KEY_TOTAL_LENGTH, gatewayAuth.KEY_TOTAL_LENGTH);
});

test("no read path ever selects key_hash", () => {
  assert.ok(!(SAFE_KEY_COLUMNS as readonly string[]).includes("key_hash"));
  const dbSource = readFileSync(fileURLToPath(new URL("../db.ts", import.meta.url)), "utf8");
  // key_hash may appear only as a write (the NewApiKey field and the doc comments),
  // never inside a PostgREST `select=` list.
  for (const m of dbSource.matchAll(/select=([^`"'&\s]+)/g)) {
    assert.ok(!m[1]!.includes("key_hash"), `key_hash appears in a select list: ${m[0]}`);
  }
});
