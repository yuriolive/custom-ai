import "server-only";

/**
 * Service-role credentials for the one console operation the browser is not
 * allowed to perform: minting an API key.
 *
 * `server-only` makes importing this from a `"use client"` module a build
 * error, which is the point — `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS
 * entirely. It must never appear in a `NEXT_PUBLIC_*` variable, never be
 * logged, and never reach an error message that is sent to a client
 * (CONTRACTS.md §Environment, §Frontend / auth contract).
 *
 * Read lazily, through getters: a missing variable should fail the request that
 * needs it with a clear message, not the module graph of every page that
 * happens to sit downstream of an import.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

export const consoleServerEnv = {
  /** Server-side Supabase URL. Falls back to the browser mirror. */
  get supabaseUrl(): string {
    return (
      process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || required("SUPABASE_URL")
    );
  },

  /** Secret. Never log this, never include it in a response body. */
  get serviceRoleKey(): string {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
} as const;
