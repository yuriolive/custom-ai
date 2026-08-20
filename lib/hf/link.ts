import "server-only";

import type { Session } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

import { fetchHfUserInfo, parseHfUserInfo, type HfIdentityFacts } from "./userinfo.ts";

/**
 * Recording a Hugging Face sign-in as the facts the `official` badge reads
 * (GitHub #30).
 *
 * ── Why this runs in the callback and nowhere else ─────────────────────────
 * `session.provider_token` is present on the response to the code exchange and
 * on nothing afterwards — it does not survive a refresh (#23, bean ca-uquk). A
 * later job cannot go and get it. So the one moment the platform can learn a
 * creator's HF org list is the moment they come back from huggingface.co, and
 * this function is what happens in that moment.
 *
 * ── Why the service role ───────────────────────────────────────────────────
 * `hf_identities` has no client write policy, deliberately: a creator who could
 * write `orgs` could type `qwen` into it and wear a lab's badge. The values are
 * worth something precisely because the only writer is this path, holding a
 * token the Hub issued seconds ago. The user id comes from the verified session,
 * never from a request parameter — the rule at the head of lib/supabase/admin.ts.
 */

/** The Supabase Custom Provider id configured for Hugging Face (CONTRACTS.md). */
const HF_PROVIDER = "custom:huggingface";

/**
 * True when this session was established through Hugging Face.
 *
 * Both places are checked because they answer different questions.
 * `app_metadata.provider` is the provider of THIS sign-in, and `identities` is
 * every provider ever linked to the account — a creator who signed up with
 * email and later linked HF has the identity but not the `provider`, and a
 * creator with two identities who signs in through GitHub today has the
 * identity but did not just prove anything about it. Only the first grants a
 * token, so the identity check exists solely to read stored claims, and the
 * caller gates the write on having actually learned something.
 */
function isHuggingFaceSession(session: Session): boolean {
  if (session.user.app_metadata?.provider === HF_PROVIDER) return true;
  return (session.user.identities ?? []).some((identity) => identity.provider === HF_PROVIDER);
}

/**
 * The HF claims GoTrue already carried into the session, if it carried enough.
 *
 * Tried before the network call because it costs nothing, and because on a
 * project whose Custom Provider maps HF's claims through it is the complete
 * answer. It is NOT assumed to be the complete answer: HF's memberships list is
 * not a standard OIDC claim, so a payload with a username and no org list is the
 * expected case, and the caller falls through to userinfo rather than storing a
 * creator as org-less on the strength of a claim mapping that was never
 * specified to carry orgs.
 */
function factsFromSessionClaims(session: Session): HfIdentityFacts | null {
  const identity = (session.user.identities ?? []).find(
    (candidate) => candidate.provider === HF_PROVIDER,
  );
  // `user_metadata` first: it is the merged view GoTrue writes on every sign-in,
  // where `identity_data` is the per-identity snapshot and may be older.
  return (
    parseHfUserInfo(session.user.user_metadata) ?? parseHfUserInfo(identity?.identity_data ?? null)
  );
}

/**
 * Learn and store what this Hugging Face sign-in says about its creator.
 *
 * Returns quietly and does nothing at all when the session is not a Hugging Face
 * one, when neither the claims nor the Hub yield a usable identity, or when the
 * write fails. **It must never throw**: it is called from the OAuth callback,
 * and a badge lookup that broke sign-in would be a far worse defect than a badge
 * that shows up one sign-in later. Every failure path here costs a badge and
 * nothing else.
 *
 * Nothing it logs contains the token, and it never returns it.
 */
export async function recordHuggingFaceIdentity(session: Session): Promise<void> {
  try {
    if (!isHuggingFaceSession(session)) return;

    const fromClaims = factsFromSessionClaims(session);
    // The org list is the fact only the Hub can settle, so the network call
    // happens whenever the claims did not carry a memberships list — even if
    // they named the user. A username alone is still stored if the Hub says
    // nothing (`?? fromClaims`), because a username-only identity earns the
    // badge on a personal repo and that is most creators.
    const facts =
      fromClaims?.membershipsReadable === true
        ? fromClaims
        : ((session.provider_token ? await fetchHfUserInfo(session.provider_token) : null) ??
          fromClaims);

    if (!facts) return;

    const admin = createAdminClient();
    const { error } = await admin.from("hf_identities").upsert(
      {
        user_id: session.user.id,
        hf_sub: facts.sub,
        username: facts.username,
        orgs: facts.orgs,
        memberships_readable: facts.membershipsReadable,
        refreshed_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    if (error) {
      // Never `console.error(error)` wholesale on this path: the row being
      // written is not secret, but the object a client error carries is not a
      // shape this file controls, and this is the one request in the app whose
      // scope includes a bearer token. Named fields only.
      console.error("hugging face identity write failed", {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });
    }
  } catch (cause) {
    // Same reason the whole function is wrapped: sign-in outranks the badge.
    console.error("hugging face identity capture failed", {
      message: cause instanceof Error ? cause.message : "unknown",
    });
  }
}
