/**
 * Ambient declaration for the `@custom-ai/keygen` workspace package.
 *
 * WHY THIS FILE EXISTS, and why it is not a second implementation:
 *
 * The canonical key format lives in `supabase/functions/gateway/auth.ts` — the
 * gateway is the thing that has to *accept* what the console mints, so it owns
 * the format. `tools/keygen` re-exports it verbatim for exactly this reuse, and
 * `app/api/keys/route.ts` imports the real runtime code from there. No byte of
 * generation or hashing logic is restated anywhere in `app/` or `lib/`.
 *
 * What cannot be shared is the *typechecker*. Those sources target Deno and are
 * compiled under `supabase/functions/gateway/tsconfig.json` and
 * `tools/keygen/tsconfig.json`, both of which set `allowImportingTsExtensions`
 * and `noUncheckedIndexedAccess: false`. The Next app's `tsconfig.json` sets
 * neither, so pulling those files into the app's program reports errors in code
 * this agent does not own and that is already green under its own project:
 *
 *   supabase/functions/gateway/auth.ts(12,30): TS5097  '.ts' import extension
 *   supabase/functions/gateway/auth.ts(41,17): TS2532  possibly 'undefined'
 *   tools/keygen/key.ts(31,8):                 TS5097  '.ts' import extension
 *
 * An ambient module declaration shadows node resolution for a non-relative
 * specifier, so the app typechecks against the surface below while the bundler
 * still resolves and executes the real module. The declaration mirrors the
 * runtime exports; `app/api/keys/route.ts` re-asserts the shape of what it
 * actually received against the database's own CHECK constraints before it
 * inserts, so a drift between this file and the source fails loudly at the
 * first mint rather than persisting a malformed key.
 *
 * The right permanent fix is a project reference or matching compiler flags in
 * the root tsconfig, which this agent does not own. Reported rather than
 * silently patched.
 */
declare module "@custom-ai/keygen" {
  /** `sk-plat-`. */
  export const KEY_PREFIX: string;
  /** 43 — the base64url body length. */
  export const KEY_BODY_LENGTH: number;
  /** 51 — `sk-plat-` + 43. */
  export const KEY_TOTAL_LENGTH: number;
  /** 16 — `sk-plat-` + the first 8 body characters. */
  export const KEY_DISPLAY_PREFIX_LENGTH: number;

  /** `api_keys.name` CHECK: char_length between 1 and 60. */
  export const KEY_NAME_MIN_LENGTH: number;
  export const KEY_NAME_MAX_LENGTH: number;
  export function isValidKeyName(name: string): boolean;

  /** Mirrors the database CHECK constraints, character for character. */
  export const PLAINTEXT_KEY_RE: RegExp;
  export const KEY_PREFIX_CHECK_RE: RegExp;
  export const KEY_HASH_CHECK_RE: RegExp;

  export interface GeneratedApiKey {
    /** Returned to the creator EXACTLY ONCE. Never persisted, never logged. */
    plaintext: string;
    /** SHA-256 hex — the only form that is ever stored. */
    hash: string;
    /** Display-only prefix, e.g. `sk-plat-a1b2c3d4`. */
    prefix: string;
  }

  export function generateApiKey(): Promise<GeneratedApiKey>;
  export function hashApiKey(plaintext: string): Promise<string>;
  export function isWellFormedApiKey(token: string): boolean;
  /** The only representation of a key that may appear in a log line. */
  export function keyFingerprintForLog(hash: string): string;

  export interface ApiKeyRow {
    id: string;
    user_id: string;
    name: string;
    key_prefix: string;
    scopes: string[];
    last_used_at: string | null;
    request_count: number;
    revoked_at: string | null;
    created_at: string;
  }

  export interface NewApiKey {
    user_id: string;
    name: string;
    key_hash: string;
    key_prefix: string;
  }

  export interface KeyStore {
    insertKey(row: NewApiKey): Promise<ApiKeyRow>;
    listKeys(userId: string): Promise<ApiKeyRow[]>;
    revokeKey(id: string): Promise<ApiKeyRow>;
  }

  export class StoreError extends Error {}

  /**
   * PostgREST-over-fetch store using the service role. Redacts the service role
   * key out of every error message it raises.
   */
  export class PostgrestKeyStore implements KeyStore {
    constructor(url: string, serviceRoleKey: string);
    insertKey(row: NewApiKey): Promise<ApiKeyRow>;
    listKeys(userId: string): Promise<ApiKeyRow[]>;
    revokeKey(id: string): Promise<ApiKeyRow>;
  }
}
