/**
 * API key extraction, hashing, and generation.
 *
 * SECURITY INVARIANT (FR-GW-010, NFR-SEC-003):
 *   Only the SHA-256 hash of a key is ever stored, compared, or logged.
 *   The plaintext exists exactly twice in its lifetime: in the creation response
 *   body, and in the caller's Authorization header. It must NEVER be written to
 *   a log line, an error message, a span attribute, or a metric label — in ANY
 *   environment. There is no debug flag that turns this off.
 */

import { GatewayError } from "./errors.ts";

/** `sk-plat-` + 43 url-safe base64 chars (32 raw bytes, unpadded). */
export const KEY_PREFIX = "sk-plat-";
export const KEY_BODY_LENGTH = 43;
export const KEY_TOTAL_LENGTH = KEY_PREFIX.length + KEY_BODY_LENGTH; // 51
/** `key_prefix` column: 'sk-plat-' + first 8 body chars (display only). */
export const KEY_DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 8;

const KEY_BODY_RE = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();

/**
 * Pulls the bearer token out of an Authorization header and asserts its SHAPE
 * only — prefix, length, alphabet. This is step 1 of the pipeline because it
 * costs ~0 ms and rejects the overwhelming majority of junk traffic before we
 * touch the body parser, the hash, or Postgres.
 *
 * Every failure is the same opaque 401: we never say whether the prefix, the
 * length, or the lookup was what failed.
 */
export function extractApiKey(req: Request): string {
  const header = req.headers.get("authorization");
  if (!header) throw invalidKey();

  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) throw invalidKey();

  const token = m[1].trim();
  if (!isWellFormedApiKey(token)) throw invalidKey();
  return token;
}

export function isWellFormedApiKey(token: string): boolean {
  return (
    typeof token === "string" &&
    token.length === KEY_TOTAL_LENGTH &&
    token.startsWith(KEY_PREFIX) &&
    KEY_BODY_RE.test(token.slice(KEY_PREFIX.length))
  );
}

function invalidKey(): GatewayError {
  return new GatewayError(
    "invalid_api_key",
    "Incorrect API key provided. You can find your API key at " +
      "https://nexus.dev/dashboard/keys.",
  );
}

/** SHA-256 of the full plaintext key, lower-case hex. Matches `api_keys.key_hash`. */
export async function hashApiKey(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(plaintext));
  return toHex(new Uint8Array(digest));
}

export interface GeneratedApiKey {
  /** Returned to the creator EXACTLY ONCE, in the creation response body. Never persisted. */
  plaintext: string;
  /** SHA-256 hex — the only form that is ever stored. */
  hash: string;
  /** Display-only prefix, e.g. `sk-plat-a1b2c3d4`. Insufficient to authenticate. */
  prefix: string;
}

/**
 * 32 bytes of CSPRNG entropy -> base64url (43 chars, unpadded) -> `sk-plat-` prefix.
 * 256 bits of entropy; brute force is not a consideration.
 */
export async function generateApiKey(): Promise<GeneratedApiKey> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const plaintext = KEY_PREFIX + base64url(raw);
  return {
    plaintext,
    hash: await hashApiKey(plaintext),
    prefix: plaintext.slice(0, KEY_DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * The ONLY representation of a key that may appear in a log line.
 * Deliberately not the plaintext, not a truncation of the plaintext.
 */
export function keyFingerprintForLog(hash: string): string {
  return hash.slice(0, 12);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
