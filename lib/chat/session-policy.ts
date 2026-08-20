/**
 * Policy constants and pure decisions for the chat session key (FR-CHAT-005).
 *
 * Deliberately free of `server-only`, `next/headers` and any database import:
 * everything here is a decision that can be asserted in a unit test, and
 * `session-key.ts` is the thin server-only layer that acts on it.
 *
 * WHY A KEY AT ALL. `/api/playground` presents `PLATFORM_API_KEY` to the
 * gateway, so the platform pays for every playground turn and no
 * `usage_transactions` row is attributable to the caller. That is tolerable for
 * a one-model demo and unacceptable here: chat is aimed at people who are not
 * developers, and their turns have to bill their own wallet so the creator's
 * 80% actually reaches them. Rather than teach the gateway a second credential
 * type, the browser session gets a real `sk-plat-` key of its own, and every
 * chat turn travels the ordinary authenticated path — auth, hold, stream,
 * settle — with nothing about the gateway changed.
 *
 * The plaintext still never touches the database (`api_keys` has no column for
 * it). It lives in one httpOnly cookie and in the memory of the route handler
 * that forwards it.
 */

/**
 * Cookie holding the session's plaintext key.
 *
 * `__Host-` prefix: the browser then refuses the cookie unless it is `Secure`,
 * path `/`, and has no `Domain` — which pins it to this exact origin and makes
 * it unsettable by a sibling subdomain. It is dropped in development, where
 * there is no TLS and the prefix would make the cookie unsettable instead.
 */
export const CHAT_KEY_COOKIE_SECURE = "__Host-nx_chat_key";
export const CHAT_KEY_COOKIE_INSECURE = "nx_chat_key";

export function chatKeyCookieName(isSecure: boolean): string {
  return isSecure ? CHAT_KEY_COOKIE_SECURE : CHAT_KEY_COOKIE_INSECURE;
}

/**
 * How long a chat session key survives without being re-minted.
 *
 * Shorter than the Supabase refresh token on purpose: this credential can spend
 * a wallet balance, and a browser that has been closed for a week should have
 * to mint a fresh one rather than keep a spendable secret at rest indefinitely.
 */
export const CHAT_KEY_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Name written to `api_keys.name`, visible in the console's key list.
 *
 * It says what it is in the user's own words. A credential that can spend their
 * balance must be visible and revocable from the same table as the keys they
 * minted themselves — hiding it would be the more comfortable choice and the
 * wrong one.
 */
export const CHAT_KEY_NAME = "Web chat (browser session)";

/**
 * `api_keys.scopes` for a chat key. `inference` is what the gateway checks;
 * `chat` is the marker that makes these rows findable for pruning and
 * revocation without matching on a display name a user could rename.
 */
export const CHAT_KEY_SCOPES = ["inference", "chat"] as const;
export const CHAT_KEY_SCOPE = "chat";

/**
 * Active chat keys kept per account.
 *
 * One per browser session, so a phone, a laptop and a second profile are three.
 * The cap exists because the plaintext is unrecoverable — a new session can
 * only ever mint, never resume someone else's — and without it a user who
 * clears cookies weekly would silently walk into the console's 25-key ceiling.
 * The oldest is revoked to make room, which logs that browser out of chat and
 * nothing else.
 */
export const MAX_CHAT_KEYS_PER_USER = 3;

/** The subset of `api_keys` this policy needs. */
export type ChatKeyRow = {
  id: string;
  scopes: string[] | null;
  revoked_at: string | null;
  created_at: string;
};

export function isChatKey(row: ChatKeyRow): boolean {
  return (row.scopes ?? []).includes(CHAT_KEY_SCOPE) && row.revoked_at === null;
}

/**
 * Which existing chat keys must be revoked before minting one more.
 *
 * Returns oldest-first, and leaves `max - 1` alive so the key about to be
 * minted brings the account back to exactly `max`. Rows arrive in any order;
 * ties on `created_at` fall back to `id` so the choice is deterministic rather
 * than dependent on however PostgREST happened to sort.
 */
export function chatKeysToRevoke(
  rows: ChatKeyRow[],
  max: number = MAX_CHAT_KEYS_PER_USER,
): string[] {
  const active = rows.filter(isChatKey).toSorted((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  const keep = Math.max(0, max - 1);
  const excess = active.length - keep;
  return excess <= 0 ? [] : active.slice(0, excess).map((row) => row.id);
}
