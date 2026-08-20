import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { consoleServerEnv } from "@/lib/console/server-env";

/**
 * Service-role Supabase client. BYPASSES ROW LEVEL SECURITY COMPLETELY.
 *
 * Use it only where RLS cannot help by construction — today that means the
 * Stripe webhook, which has no user session at all: it is authenticated by an
 * HMAC signature over the request body, and the user it credits is named inside
 * that verified payload.
 *
 * Rules for every call site:
 *   • the user id must come from a source the caller has cryptographically
 *     verified (a Supabase session cookie, or a signature-checked webhook
 *     body) — never from an unauthenticated request parameter;
 *   • never construct this in a module that a `"use client"` file can reach;
 *   • never put the key, or a message containing it, in a response.
 *
 * A new client per call, not a module-scope singleton: this key is never
 * session-bound, and a fresh instance keeps auth state from being shared or
 * accidentally persisted between requests.
 */
export function createAdminClient() {
  return createSupabaseClient(consoleServerEnv.supabaseUrl, consoleServerEnv.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
