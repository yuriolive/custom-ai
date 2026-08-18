import { createBrowserClient } from "@supabase/ssr";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./public-config";

/**
 * Browser Supabase client (CONTRACTS.md §Frontend / auth contract).
 *
 * Use this and only this from a `"use client"` module. It reads and writes the
 * same cookie the middleware refreshes, so a session established on the server
 * is visible here without a round trip.
 *
 * `createBrowserClient` memoizes internally per (url, key), so calling this on
 * every render is cheap and does not create competing GoTrue instances.
 *
 * Anything the browser may do directly is enumerated in CONTRACTS.md and is
 * enforced by RLS — never by this client. Creating an API key is NOT on that
 * list; it needs a server route with the service role.
 */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
