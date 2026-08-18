/**
 * POST /api/keys — mint one API key.
 *
 * WHY THIS ROUTE EXISTS AT ALL. Everything else the console does, the browser
 * does directly against PostgREST under RLS (CONTRACTS.md §Frontend / auth
 * contract). Creating a key is the single documented exception: `api_keys` has
 * no client INSERT policy, because the plaintext has to be generated with
 * server-side entropy, returned exactly once, and then forgotten. A client that
 * could INSERT would have to choose its own key material.
 *
 * THE PLAINTEXT INVARIANT (FR-CON-002, FR-GW-010, NFR-SEC-003). In this file the
 * plaintext lives in exactly one binding, `generated.plaintext`, and reaches
 * exactly one place — the `plaintext` field of the 201 body. It is never
 * assigned to the insert payload, never interpolated into a message, never
 * passed to `console.*`, and never read back by any other route: the console's
 * read path (`fetchApiKeys`) does not select `key_hash`, let alone a plaintext
 * column, because no such column exists. `Cache-Control: no-store` keeps the one
 * response that carries it out of every cache between here and the tab.
 *
 * The generation and hashing come from `@custom-ai/keygen`, which re-exports the
 * gateway's own `supabase/functions/gateway/auth.ts` verbatim. The gateway is
 * what has to *accept* these keys, so the gateway owns the format; there is no
 * second implementation of it here. See lib/console/keygen-module.d.ts for why
 * that import is typed through an ambient declaration.
 */

import {
  generateApiKey,
  isValidKeyName,
  isWellFormedApiKey,
  keyFingerprintForLog,
  KEY_HASH_CHECK_RE,
  KEY_NAME_MAX_LENGTH,
  KEY_PREFIX_CHECK_RE,
  PostgrestKeyStore,
} from "@custom-ai/keygen";

import { consoleServerEnv } from "@/lib/console/server-env";
import type { CreatedApiKey } from "@/lib/console/types";
import { createClient } from "@/lib/supabase/server";

/** Node, not edge: `crypto.subtle` and `crypto.getRandomValues` both exist here. */
export const runtime = "nodejs";
/** Reads a session cookie and mints a credential — never prerender, never cache. */
export const dynamic = "force-dynamic";

/**
 * Cap on simultaneously-active keys per account.
 *
 * Not a product limit anyone asked for — a bound on an authenticated endpoint
 * that writes a row and burns entropy on every call. A developer who genuinely
 * needs more than this is a conversation, not a loop.
 */
const MAX_ACTIVE_KEYS = 25;

type ErrorCode =
  | "unauthenticated"
  | "invalid_request_body"
  | "invalid_key_name"
  | "too_many_keys"
  | "key_generation_failed"
  | "internal_error";

/**
 * Same envelope shape the gateway and the playground proxy use, so a client has
 * one error parser for the whole product.
 */
function errorResponse(status: number, code: ErrorCode, message: string) {
  return Response.json(
    { error: { message, type: "invalid_request_error", param: null, code } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  // ── 1. Session. The user id comes from the verified cookie and NOTHING else.
  // A `user_id` in the request body would be a straight account-takeover
  // primitive: this route inserts with the service role, so RLS is not there to
  // catch a mistake here. The body is read for `name` only.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse(
      401,
      "unauthenticated",
      "Sign in to create an API key.",
    );
  }

  // ── 2. Name.
  let rawName: unknown;
  try {
    const body: unknown = await request.json();
    rawName =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).name
        : undefined;
  } catch {
    return errorResponse(
      400,
      "invalid_request_body",
      "Expected a JSON body of the form {\"name\": \"...\"}.",
    );
  }

  if (typeof rawName !== "string") {
    return errorResponse(
      400,
      "invalid_key_name",
      "A key name is required.",
    );
  }

  const name = rawName.trim();
  if (!isValidKeyName(name)) {
    return errorResponse(
      400,
      "invalid_key_name",
      `A key name must be 1 to ${KEY_NAME_MAX_LENGTH} characters.`,
    );
  }

  const store = new PostgrestKeyStore(
    consoleServerEnv.supabaseUrl,
    consoleServerEnv.serviceRoleKey,
  );

  try {
    // ── 3. Quota, scoped to this user only.
    const existing = await store.listKeys(user.id);
    const active = existing.filter((row) => row.revoked_at === null).length;
    if (active >= MAX_ACTIVE_KEYS) {
      return errorResponse(
        409,
        "too_many_keys",
        `You already have ${MAX_ACTIVE_KEYS} active keys. Revoke one before creating another.`,
      );
    }

    // ── 4. Generate. 32 CSPRNG bytes -> base64url -> `sk-plat-`, hashed with
    // SHA-256 by the gateway's own code.
    const generated = await generateApiKey();

    // Belt and braces against a drift between the ambient declaration in
    // lib/console/keygen-module.d.ts and the real module: assert the three
    // values against the database's own CHECK constraints BEFORE the insert, so
    // a mismatch fails loudly here instead of persisting a malformed key or
    // handing back a token the gateway would refuse. Note that no branch below
    // puts `plaintext` in the message.
    if (
      !isWellFormedApiKey(generated.plaintext) ||
      !KEY_HASH_CHECK_RE.test(generated.hash) ||
      !KEY_PREFIX_CHECK_RE.test(generated.prefix)
    ) {
      console.error(
        "[keys] generated key failed shape validation; nothing was persisted",
      );
      return errorResponse(
        500,
        "key_generation_failed",
        "Key generation failed a self-check. Nothing was saved; please retry.",
      );
    }

    // ── 5. Persist the HASH. `generated.plaintext` is deliberately not in this
    // object, and `api_keys` has no column that could hold it.
    const row = await store.insertKey({
      user_id: user.id,
      name,
      key_hash: generated.hash,
      key_prefix: generated.prefix,
    });

    // A fingerprint of the hash is the only representation of a key that may
    // appear in a log line — not the plaintext, not a slice of it.
    console.info(
      `[keys] minted key ${row.id} (${keyFingerprintForLog(generated.hash)}) for user ${user.id}`,
    );

    // ── 6. The one and only time the plaintext crosses a wire outbound.
    // Fields are mapped explicitly rather than spread: `scopes` and `user_id`
    // are on the store's row type and have no business in the client payload,
    // and an explicit list cannot silently start carrying a new column.
    const payload: CreatedApiKey = {
      id: row.id,
      name: row.name,
      key_prefix: row.key_prefix,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
      request_count: row.request_count,
      plaintext: generated.plaintext,
    };

    return Response.json(payload, {
      status: 201,
      headers: {
        // This body holds a credential. Keep it out of the browser cache, any
        // shared cache, and any Next.js data cache.
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        Pragma: "no-cache",
      },
    });
  } catch (cause) {
    // `PostgrestKeyStore` redacts the service role key out of its own messages,
    // but the detail still describes internal topology, so it goes to the server
    // log and the client gets a flat message.
    console.error("[keys] mint failed:", cause instanceof Error ? cause.message : cause);
    return errorResponse(
      500,
      "internal_error",
      "Could not create the key. Please try again.",
    );
  }
}
