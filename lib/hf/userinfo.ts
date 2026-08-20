/**
 * Reading a Hugging Face identity at callback time (GitHub #30).
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 * The badge needs two facts about the signing-in creator: their HF username and
 * the orgs they belong to. Supabase's Custom Provider hands us a session, and
 * whether GoTrue carries HF's non-standard `orgs` claim through into
 * `user_metadata` is a property of GoTrue's OIDC claim mapping, not of anything
 * this repo controls. So the claims are used when they are there and the
 * userinfo endpoint is asked when they are not.
 *
 * ── Why the token is not kept ──────────────────────────────────────────────
 * `session.provider_token` exists ONLY on the response to the code exchange and
 * does not survive a session refresh (#23, bean ca-uquk). It is not a credential
 * this platform holds. It is read once, in the callback, and what is persisted
 * is the DERIVED FACTS — never the token, and never a log line containing it
 * (CONTRACTS.md §Environment).
 *
 * ── The scope this depends on ──────────────────────────────────────────────
 * `orgs` requires the **`read-memberships`** scope on the HF OAuth app AND on
 * the Supabase Custom Provider config. Without it the response simply omits the
 * list — no error, no warning — which is why `membershipsReadable` below is a
 * separate fact from "the list is empty". An app that was never allowed to look
 * must produce the neutral third-party state, not a wrong badge.
 */

import { normalizeHfNamespace, normalizeHfNamespaces } from "./namespaces.ts";

/**
 * The OIDC userinfo endpoint, from
 * https://huggingface.co/.well-known/openid-configuration.
 *
 * A constant rather than an env var: it is not a secret, it is not
 * per-deployment, and a wrong value here is a silently missing badge rather than
 * a visible failure — exactly the kind of thing that should not be configurable.
 * The discovery document is the source of truth if HF ever moves it.
 */
export const HF_USERINFO_URL = "https://huggingface.co/oauth/userinfo";

/** What a sign-in is worth to the badge, once every string has been normalized. */
export type HfIdentityFacts = {
  /** HF's stable subject id. Survives a username change; the username does not. */
  sub: string;
  /** `preferred_username`, lowercased. */
  username: string;
  /** Org usernames, lowercased, deduped, sorted. */
  orgs: string[];
  /**
   * Whether the payload carried a memberships list at all.
   *
   * `false` with an empty `orgs` means "we were never allowed to look";
   * `true` with an empty `orgs` means "this account is in no orgs". The badge
   * rule treats them identically — both cost the badge — but support cannot
   * diagnose a missing dashboard scope without the distinction.
   */
  membershipsReadable: boolean;
};

/** Anything object-shaped, for walking an untyped JSON payload. */
type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/**
 * The org list, wherever HF put it.
 *
 * Both keys are read on purpose. The Hub's OAuth documentation refers to the
 * `organizations.sub` field of the userinfo response, while `@huggingface/hub`
 * types the same list as `orgs` — so the two names are both in circulation for
 * one payload. Reading only the documented one would produce a silently
 * org-less identity against a live response that used the other, and the
 * failure mode is a missing badge, which nobody reports as a bug.
 *
 * Returns `null` for "no list present" — distinct from `[]`, "a list with
 * nothing in it".
 */
function readOrgList(payload: JsonRecord): unknown[] | null {
  for (const key of ["orgs", "organizations"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * Turn a userinfo (or id-token claims) payload into the facts worth storing.
 *
 * Returns `null` when the payload names no usable account — a missing `sub`, a
 * missing or malformed `preferred_username`. A creator with an unreadable
 * identity is a creator with no badge, which is the neutral state and a
 * perfectly good outcome; it is never a reason to fail the sign-in.
 */
export function parseHfUserInfo(payload: unknown): HfIdentityFacts | null {
  const record = asRecord(payload);
  if (!record) return null;

  const sub = typeof record.sub === "string" ? record.sub.trim() : "";
  const username = normalizeHfNamespace(record.preferred_username);
  if (!sub || sub.length > 200 || !username) return null;

  const list = readOrgList(record);
  const orgs =
    list === null
      ? []
      : normalizeHfNamespaces(
          // Each entry is an object whose `preferred_username` is the namespace;
          // `name` is a display name and `sub` is an opaque id, so neither is a
          // namespace and neither is accepted as a fallback. A bare string is
          // tolerated because it costs one line and a claim shaped that way
          // would otherwise be dropped in silence.
          list.map((entry) =>
            typeof entry === "string" ? entry : (asRecord(entry)?.preferred_username ?? null),
          ),
        );

  return { sub, username, orgs, membershipsReadable: list !== null };
}

/**
 * Ask the Hub who this token belongs to.
 *
 * Never throws and never returns the token in anything it produces. A failure
 * here — HF down, a revoked token, a scope change — degrades to `null`, which
 * the caller turns into "no badge", not into a failed sign-in: a creator whose
 * login broke because a badge lookup timed out would be a far worse defect than
 * a badge that appears one sign-in later than it could have.
 *
 * The timeout is explicit. `fetch` has no default one, and this call sits
 * directly in the redirect path of every Hugging Face sign-in — an unbounded
 * wait here is a login that hangs.
 */
export async function fetchHfUserInfo(
  providerToken: string,
  timeoutMs = 4_000,
): Promise<HfIdentityFacts | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(HF_USERINFO_URL, {
      headers: { Authorization: `Bearer ${providerToken}`, Accept: "application/json" },
      signal: abort.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    return parseHfUserInfo(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
