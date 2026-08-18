/**
 * The three commands, expressed against the `KeyStore` seam and an injected IO
 * object. Nothing here touches `process` directly, so every path is testable with
 * an in-memory double and every byte of output is capturable.
 *
 * THE ONE RULE: the plaintext key exists in exactly one place in this file — the
 * single `io.out(...)` call inside `create`. It is not returned to the caller, not
 * stored in a variable that outlives that call, not put in the row, not logged.
 */

import {
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  isValidKeyName,
  KEY_HASH_CHECK_RE,
  KEY_PREFIX_CHECK_RE,
  KEY_NAME_MAX_LENGTH,
} from "./key.ts";
import type { ApiKeyRow, KeyStore } from "./db.ts";
import { isUuid } from "./db.ts";

export class CommandError extends Error {}

export interface Io {
  /** stdout. */
  out(line: string): void;
  /** stderr — progress and warnings, so stdout stays parseable. */
  err(line: string): void;
  /** Interactive yes/no. Must return false when it cannot ask. */
  confirm(question: string): Promise<boolean>;
}

// ── create ──────────────────────────────────────────────────────────────────

export interface CreateOptions {
  /** Profile handle or uuid. */
  user: string;
  name: string;
}

/**
 * Mints one key. Returns the persisted row — WITHOUT the plaintext, which was
 * already printed and is now unrecoverable by design.
 */
export async function create(store: KeyStore, opts: CreateOptions, io: Io): Promise<ApiKeyRow> {
  if (!isValidKeyName(opts.name)) {
    throw new CommandError(
      `--name must be 1..${KEY_NAME_MAX_LENGTH} characters (api_keys.name CHECK constraint).`,
    );
  }

  const profile = await store.findProfile(opts.user);
  if (!profile) {
    throw new CommandError(
      `No profile matches "${opts.user}". Pass a handle (e.g. devcaller) or a uuid.`,
    );
  }

  const key = await generateApiKey();

  // Defense in depth: refuse to persist anything the gateway or the schema would
  // reject. A malformed key that reaches the DB is a credential that can never
  // authenticate and can never be diagnosed, because the plaintext is gone.
  if (!isWellFormedApiKey(key.plaintext)) {
    throw new CommandError("Generated key failed the gateway's own format check. Aborting.");
  }
  if (!KEY_HASH_CHECK_RE.test(key.hash)) {
    throw new CommandError("Generated hash is not 64 lower-case hex chars. Aborting.");
  }
  if (!KEY_PREFIX_CHECK_RE.test(key.prefix)) {
    throw new CommandError("Generated display prefix violates the schema CHECK. Aborting.");
  }
  // Round-trip the digest through the gateway's own hasher, on the value we are
  // about to persist, every single time — not just in tests.
  if ((await hashApiKey(key.plaintext)) !== key.hash) {
    throw new CommandError("Hash round trip disagreed with the gateway hasher. Aborting.");
  }

  const row = await store.insertKey({
    user_id: profile.id,
    name: opts.name,
    key_hash: key.hash,
    key_prefix: key.prefix,
  });

  io.err("");
  io.err("  ┌──────────────────────────────────────────────────────────────────┐");
  io.err("  │  COPY THIS NOW. IT WILL NEVER BE SHOWN AGAIN.                    │");
  io.err("  │  Only its SHA-256 hash was stored — nobody, including this tool, │");
  io.err("  │  can recover it. Lose it and your only option is to revoke and   │");
  io.err("  │  mint a new one.                                                 │");
  io.err("  └──────────────────────────────────────────────────────────────────┘");
  io.err("");

  // ── The one and only emission of the plaintext, for its whole lifetime. ──
  io.out(key.plaintext);
  // ────────────────────────────────────────────────────────────────────────

  io.err("");
  io.err(`  key id    ${row.id}`);
  io.err(`  owner     ${profile.handle} (${profile.id})`);
  io.err(`  name      ${row.name}`);
  io.err(`  prefix    ${row.key_prefix}`);
  io.err(`  scopes    ${(row.scopes ?? []).join(", ") || "—"}`);
  io.err(`  created   ${row.created_at}`);
  io.err("");

  return row;
}

// ── list ────────────────────────────────────────────────────────────────────

export async function list(store: KeyStore, user: string, io: Io): Promise<ApiKeyRow[]> {
  const profile = await store.findProfile(user);
  if (!profile) {
    throw new CommandError(
      `No profile matches "${user}". Pass a handle (e.g. devcaller) or a uuid.`,
    );
  }

  const rows = await store.listKeys(profile.id);
  if (rows.length === 0) {
    io.err(`No API keys for ${profile.handle}.`);
    return rows;
  }

  const table = rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.key_prefix,
    created: shortTime(r.created_at),
    last_used: r.last_used_at ? shortTime(r.last_used_at) : "never",
    requests: String(r.request_count ?? 0),
    status: r.revoked_at ? `revoked ${shortTime(r.revoked_at)}` : "active",
  }));

  const headers = ["id", "name", "prefix", "created", "last_used", "requests", "status"] as const;
  const width: Record<string, number> = {};
  for (const h of headers) {
    width[h] = Math.max(h.length, ...table.map((r) => r[h].length));
  }
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(width[headers[i]!]!))
      .join("  ")
      .trimEnd();

  io.out(line(headers));
  io.out(line(headers.map((h) => "─".repeat(width[h]!))));
  for (const r of table) io.out(line(headers.map((h) => r[h])));

  const active = rows.filter((r) => !r.revoked_at).length;
  io.err(`\n${rows.length} key(s) for ${profile.handle} — ${active} active.`);
  return rows;
}

// ── revoke ──────────────────────────────────────────────────────────────────

export interface RevokeOptions {
  /** Key uuid, or the 16-char display prefix (`sk-plat-` + 8). */
  selector: string;
  /** Skips the interactive prompt. Must be an explicit, deliberate flag. */
  yes: boolean;
}

export async function revoke(store: KeyStore, opts: RevokeOptions, io: Io): Promise<ApiKeyRow> {
  const selector = opts.selector.trim();
  if (!isUuid(selector) && !KEY_PREFIX_CHECK_RE.test(selector)) {
    throw new CommandError(
      `"${selector}" is neither a key uuid nor a display prefix. ` +
        `A display prefix is exactly "sk-plat-" plus 8 characters, as shown by \`list\`. ` +
        `Full plaintext keys are never accepted as input.`,
    );
  }

  const matches = await store.findKeys(selector);
  if (matches.length === 0) throw new CommandError(`No key matches "${selector}".`);
  if (matches.length > 1) {
    // key_prefix is not unique — 8 base64url chars will collide eventually, and a
    // wrong guess here revokes a credential someone is actively using.
    io.err(`"${selector}" matches ${matches.length} keys:`);
    for (const m of matches) {
      io.err(`  ${m.id}  ${m.name}  ${m.revoked_at ? "revoked" : "active"}`);
    }
    throw new CommandError("Ambiguous selector. Re-run with the key id.");
  }

  const target = matches[0]!;
  if (target.revoked_at) {
    io.err(`Key ${target.id} (${target.name}) was already revoked at ${target.revoked_at}.`);
    return target;
  }

  io.err(`About to revoke:`);
  io.err(`  id        ${target.id}`);
  io.err(`  name      ${target.name}`);
  io.err(`  prefix    ${target.key_prefix}`);
  io.err(`  created   ${target.created_at}`);
  io.err(`  last used ${target.last_used_at ?? "never"}`);
  io.err(`  requests  ${target.request_count ?? 0}`);
  io.err("This is immediate and cannot be undone. Any caller using it starts getting 401s.");

  const ok = opts.yes || (await io.confirm(`Revoke ${target.key_prefix}…? [y/N] `));
  if (!ok) throw new CommandError("Aborted. Nothing was changed.");

  const updated = await store.revokeKey(target.id);
  io.err(`Revoked ${updated.id} at ${updated.revoked_at}.`);
  return updated;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}
