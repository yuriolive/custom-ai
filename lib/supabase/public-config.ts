/**
 * The two client-safe Supabase values, in one place.
 *
 * Both are readable from the browser by design (CONTRACTS.md §Environment):
 * the anon key is a publishable JWT and is powerless without Row Level
 * Security. `SUPABASE_SERVICE_ROLE_KEY` must never be read from this module,
 * nor from any module that can reach a `"use client"` boundary.
 *
 * Next.js only inlines `process.env.NEXT_PUBLIC_X` when it is written as a
 * full static member expression, so these must not be indexed dynamically.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "Copy .env.example to .env.local and fill both in — auth cannot start without them.",
  );
}

export const SUPABASE_URL: string = url;
export const SUPABASE_ANON_KEY: string = anonKey;
