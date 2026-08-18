/**
 * OPT-IN live smoke test. Not part of `npm test` — the filename ends in
 * `.live.ts`, outside the `test/*.test.ts` glob, so CI never needs Postgres.
 *
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" \
 *   node --test tools/keygen/test/live-smoke.live.ts
 *
 * It mints a real key against a real database, asserts the row landed with the
 * right hash, then REVOKES it in an `after` hook so no live credential is left
 * behind even if an assertion fails.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { PostgrestKeyStore } from "../db.ts";
import { create, list, revoke, type Io } from "../commands.ts";
import { resolveConfig, PRODUCTION_FLAG } from "../config.ts";
import { KEY_PREFIX_CHECK_RE, PLAINTEXT_KEY_RE } from "../key.ts";

const USER = process.env["KEYGEN_SMOKE_USER"] ?? "devcaller";
const NAME = `keygen smoke ${new Date().toISOString()}`.slice(0, 60);

const cfg = resolveConfig({
  env: process.env,
  allowProduction: process.argv.includes(PRODUCTION_FLAG),
});
const store = new PostgrestKeyStore(cfg.url, cfg.serviceRoleKey);

const stdout: string[] = [];
const io: Io = {
  out: (l) => void stdout.push(l),
  err: () => {},
  confirm: async () => true,
};

let createdId: string | undefined;

before(async () => {
  const profile = await store.findProfile(USER);
  assert.ok(profile, `seeded user "${USER}" not found — run \`supabase db reset\` first`);
});

after(async () => {
  // Never leave a live credential behind, pass or fail.
  if (!createdId) return;
  const rows = await store.findKeys(createdId);
  if (rows[0] && !rows[0].revoked_at) await store.revokeKey(createdId);
});

test("live: mint → row lands with the right hash → revoke", async () => {
  const row = await create(store, { user: USER, name: NAME }, io);
  createdId = row.id;

  const plaintext = stdout.at(-1)!;
  assert.match(plaintext, PLAINTEXT_KEY_RE);
  assert.match(row.key_prefix, KEY_PREFIX_CHECK_RE);
  assert.equal(row.key_prefix, plaintext.slice(0, 16));
  assert.equal(row.revoked_at, null);

  // The row is really there, and readable through the same safe projection.
  const listed = await list(store, USER, { ...io, out: () => {} });
  const found = listed.find((r) => r.id === row.id);
  assert.ok(found, "minted key did not appear in list output");
  assert.equal(found.name, NAME);
  assert.ok(!("key_hash" in found), "list projection leaked key_hash");

  // The stored hash is the SHA-256 of the printed plaintext. Confirmed by asking
  // PostgREST to match on the digest we computed independently — we never read
  // key_hash back, we only prove the server has it.
  const digest = createHash("sha256").update(plaintext, "utf8").digest("hex");
  const byHash = await fetch(
    `${cfg.url}/rest/v1/api_keys?select=id&key_hash=eq.${digest}`,
    {
      headers: {
        apikey: cfg.serviceRoleKey,
        authorization: `Bearer ${cfg.serviceRoleKey}`,
      },
    },
  );
  assert.equal(byHash.status, 200);
  const hits = (await byHash.json()) as Array<{ id: string }>;
  assert.deepEqual(
    hits.map((h) => h.id),
    [row.id],
    "no row matched sha256(plaintext) — the gateway would reject this key",
  );

  const revoked = await revoke(store, { selector: row.id, yes: true }, io);
  assert.ok(revoked.revoked_at, "revoke did not set revoked_at");
});
