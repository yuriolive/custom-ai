/**
 * Key format — NOT a second implementation.
 *
 * The canonical generation + hashing logic lives in the gateway
 * (`supabase/functions/gateway/auth.ts`), because the gateway is the thing that
 * has to *accept* what this CLI mints. Re-implementing it here would create two
 * definitions of one format that can silently drift apart, so this module
 * re-exports the gateway's functions verbatim and adds only the shape assertions
 * that come from the DATABASE side (the CHECK constraints in
 * `supabase/migrations/20260817000500_api_keys.sql`).
 *
 * That file targets Deno, but it uses nothing outside the Web platform
 * (`crypto.getRandomValues`, `crypto.subtle.digest`, `TextEncoder`, `btoa`), all
 * of which are globals in Node >= 22. Its only runtime import is `errors.ts`,
 * which imports types only.
 *
 * SECURITY INVARIANT (inherited, FR-GW-010 / NFR-SEC-003):
 *   `plaintext` may be written to stdout exactly once at creation and nowhere
 *   else — no file, no log line, no error message, no argv, no DB column.
 */

export {
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  keyFingerprintForLog,
  KEY_PREFIX,
  KEY_BODY_LENGTH,
  KEY_TOTAL_LENGTH,
  KEY_DISPLAY_PREFIX_LENGTH,
} from "../../supabase/functions/gateway/auth.ts";

export type { GeneratedApiKey } from "../../supabase/functions/gateway/auth.ts";

/**
 * The full plaintext key. Mirrors `isWellFormedApiKey` in auth.ts; asserted
 * equivalent to it by test/key.test.ts.
 */
export const PLAINTEXT_KEY_RE = /^sk-plat-[A-Za-z0-9_-]{43}$/;

/**
 * `api_keys.key_prefix` CHECK constraint, copied character-for-character from
 * 20260817000500_api_keys.sql. Exactly 8 body characters — NOT the 43 of the
 * full key. Verified against the live constraint definition by the live smoke test.
 */
export const KEY_PREFIX_CHECK_RE = /^sk-plat-[A-Za-z0-9_-]{8}$/;

/** `api_keys.key_hash` CHECK constraint. Lower-case hex only, exactly 64 chars. */
export const KEY_HASH_CHECK_RE = /^[a-f0-9]{64}$/;

/** `api_keys.name` CHECK constraint: char_length between 1 and 60. */
export const KEY_NAME_MIN_LENGTH = 1;
export const KEY_NAME_MAX_LENGTH = 60;

export function isValidKeyName(name: string): boolean {
  return (
    typeof name === "string" &&
    [...name].length >= KEY_NAME_MIN_LENGTH &&
    [...name].length <= KEY_NAME_MAX_LENGTH
  );
}
