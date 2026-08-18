import "server-only";

/**
 * Service-role Supabase client for the two Studio operations RLS cannot express.
 *
 * WHY THIS EXISTS, stated precisely, because a service-role client is the
 * single most dangerous object in the codebase:
 *
 *   DEPLOY — `custom_models_insert_own` (migration 20260817000700) requires
 *            `gpu_tier_id IS NULL AND max_concurrent_streams IS NULL AND
 *            placement_rationale IS NULL` on a creator INSERT. Solver output is
 *            deliberately not creator-writable, so the row that carries a
 *            placement cannot be written by the browser. By design: a creator
 *            who could write `predicted_tokens_per_second` could publish a
 *            throughput claim the hardware never met.
 *
 *   DELETE — `custom_models` has NO client DELETE policy, also by design.
 *            Deletion has to destroy the Vault secret and soft-delete the row
 *            so `usage_transactions` is never orphaned (FR-STU-010,
 *            FR-DEP-014), which is a workflow rather than a statement.
 *
 * Everything else the Studio does — reading its own models, editing pricing,
 * toggling visibility — goes straight from the browser under RLS, per
 * CONTRACTS.md §Frontend / auth contract. Do not route those through here.
 *
 * THE RULE FOR EVERY CALLER: this client bypasses RLS entirely, so the owning
 * user id must come from a verified session cookie (`supabase.auth.getUser()`)
 * and NEVER from the request body. A `user_id` accepted from a client here is a
 * straight account-takeover primitive.
 *
 * `server-only` makes importing this from a `"use client"` module a build
 * error, and `npm run check:env` fails the build if the key ever appears in a
 * NEXT_PUBLIC_* variable.
 */

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

import { consoleServerEnv } from "@/lib/console/server-env";

/**
 * A new client per call. Never hoisted to module scope: a module-level client
 * outlives a request, and one holding the service role is not something to keep
 * warm across users.
 */
export function createAdminClient(): SupabaseClient {
  return createSupabaseClient(
    consoleServerEnv.supabaseUrl,
    consoleServerEnv.serviceRoleKey,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { "X-Client-Info": "studio-admin" } },
    },
  );
}
