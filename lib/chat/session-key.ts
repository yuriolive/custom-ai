import "server-only";

import { createClient as createServiceClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import {
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  KEY_HASH_CHECK_RE,
  KEY_PREFIX_CHECK_RE,
  keyFingerprintForLog,
} from "@custom-ai/keygen";

import { consoleServerEnv } from "@/lib/console/server-env";

import {
  CHAT_KEY_MAX_AGE_SECONDS,
  CHAT_KEY_NAME,
  CHAT_KEY_SCOPES,
  chatKeyCookieName,
  chatKeysToRevoke,
  type ChatKeyRow,
} from "./session-policy";

/**
 * The chat session credential (FR-CHAT-005).
 *
 * `server-only`, and it must stay that way: this module reads
 * `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS entirely.
 *
 * THE PLAINTEXT INVARIANT, restated for this file. A minted key's plaintext
 * reaches exactly two places: the `Set-Cookie` header, and the `Authorization`
 * header the route handler sends to the gateway. It is never written to a
 * column (`api_keys` has none that could hold it), never logged — the fingerprint
 * of the hash is what appears in a log line — and never included in a response
 * body or an error message. This mirrors `app/api/keys/route.ts`, which is the
 * other place in the app allowed to generate one.
 *
 * The service role is used rather than the caller's RLS session because
 * `api_keys` has no client INSERT policy, by design (CONTRACTS.md §Frontend /
 * auth contract). Every query below is filtered on `user_id` explicitly, since
 * RLS is not there to catch a mistake.
 */

export class ChatSessionError extends Error {}

/**
 * `Secure` cookies in production, plain in development.
 *
 * A `Secure` cookie is silently dropped by the browser over plain http, so
 * hard-coding it would make chat work in production and mysteriously not work
 * on `localhost` — the failure would look like a broken key, not a dropped
 * cookie. The `__Host-` prefix rides on the same switch (see session-policy.ts).
 */
function useSecureCookie(): boolean {
  return process.env.NODE_ENV === "production";
}

function serviceClient() {
  return createServiceClient(consoleServerEnv.supabaseUrl, consoleServerEnv.serviceRoleKey, {
    // A route handler is not a browser: nothing here should try to persist or
    // refresh a session on top of the service role.
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A live, non-revoked chat key for this user, minting one if needed.
 *
 * The cookie is checked against the database on every turn rather than trusted.
 * Skipping that check would mean a revoked key is only discovered when the
 * gateway answers 401 — mid-stream, after the response headers have flushed,
 * which is the one point at which nothing useful can be done about it. One
 * indexed lookup on `key_hash` (the gateway's own hot-path index) buys the
 * ability to re-mint before a single byte has been written.
 *
 * Callable only from a Route Handler or Server Action: it writes a cookie, and
 * a Server Component render cannot.
 */
export async function ensureChatKey(userId: string): Promise<string> {
  const jar = await cookies();
  const secure = useSecureCookie();
  const cookieName = chatKeyCookieName(secure);
  const db = serviceClient();

  const existing = jar.get(cookieName)?.value;
  // Shape-check before hashing: the cookie is user-editable, and a malformed
  // value should cost nothing more than a re-mint.
  if (existing && isWellFormedApiKey(existing)) {
    const hash = await hashApiKey(existing);
    const { data, error } = await db
      .from("api_keys")
      .select("id")
      .eq("key_hash", hash)
      // The user filter matters: without it, a cookie left behind by a previous
      // account on a shared browser would keep billing that account's wallet.
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle();

    if (!error && data) return existing;
  }

  return mintChatKey(userId, jar, cookieName, secure);
}

async function mintChatKey(
  userId: string,
  jar: Awaited<ReturnType<typeof cookies>>,
  cookieName: string,
  secure: boolean,
): Promise<string> {
  const db = serviceClient();

  // Make room first. If this fails the mint still proceeds: an account one key
  // over its chat budget is a smaller problem than a chat that will not open.
  const { data: rows } = await db
    .from("api_keys")
    .select("id, scopes, revoked_at, created_at")
    .eq("user_id", userId);

  const stale = chatKeysToRevoke((rows ?? []) as ChatKeyRow[]);
  if (stale.length > 0) {
    await db
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .in("id", stale)
      .is("revoked_at", null);
  }

  const generated = await generateApiKey();

  // Same belt-and-braces check the console mint runs, and for the same reason:
  // the app typechecks `@custom-ai/keygen` against an ambient declaration, so a
  // drift from the real module must fail here rather than persist a malformed
  // key or hand back a token the gateway would refuse. No branch below puts the
  // plaintext in a message.
  if (
    !isWellFormedApiKey(generated.plaintext) ||
    !KEY_HASH_CHECK_RE.test(generated.hash) ||
    !KEY_PREFIX_CHECK_RE.test(generated.prefix)
  ) {
    throw new ChatSessionError("Generated chat key failed its shape check; nothing was saved.");
  }

  const { data: created, error } = await db
    .from("api_keys")
    .insert({
      user_id: userId,
      name: CHAT_KEY_NAME,
      key_hash: generated.hash,
      key_prefix: generated.prefix,
      scopes: [...CHAT_KEY_SCOPES],
    })
    .select("id")
    .single();

  if (error || !created) {
    throw new ChatSessionError("Could not create a chat session key.");
  }

  jar.set(cookieName, generated.plaintext, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: CHAT_KEY_MAX_AGE_SECONDS,
  });

  console.info(
    `[chat] minted session key ${created.id} (${keyFingerprintForLog(generated.hash)}) for user ${userId}`,
  );

  return generated.plaintext;
}

/**
 * Revoke this browser's chat key and drop the cookie.
 *
 * Called on sign-out. Without it the credential outlives the session it belongs
 * to: the Supabase cookie goes, the spendable key stays, and the next person on
 * a shared machine inherits a working wallet.
 *
 * Best-effort by design — a failure here must not stop a sign-out from
 * completing. The key expires with the cookie regardless, and the user can
 * revoke it by hand from the console, where it is listed under its own name.
 */
export async function revokeChatSession(userId: string): Promise<void> {
  const jar = await cookies();

  for (const cookieName of [chatKeyCookieName(true), chatKeyCookieName(false)]) {
    const value = jar.get(cookieName)?.value;
    jar.delete(cookieName);
    if (!value || !isWellFormedApiKey(value)) continue;

    try {
      const hash = await hashApiKey(value);
      await serviceClient()
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("key_hash", hash)
        .eq("user_id", userId)
        .is("revoked_at", null);
    } catch {
      console.warn("[chat] could not revoke the session key on sign-out");
    }
  }
}
