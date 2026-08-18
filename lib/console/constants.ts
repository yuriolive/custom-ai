/**
 * Client-safe constants for the console UI.
 *
 * WHY THIS IS NOT IMPORTED FROM `@custom-ai/keygen`, which also exports it:
 * that package re-exports `supabase/functions/gateway/auth.ts`, i.e. the key
 * GENERATION and HASHING code. Importing it from a `"use client"` module would
 * pull the gateway's credential logic into the browser bundle to read one
 * integer. The server route (`app/api/keys/route.ts`) imports the real thing and
 * is the authority on validity; the value here only drives `maxLength` and a
 * hint on an input.
 *
 * Both mirror the `api_keys.name` CHECK constraint in
 * supabase/migrations/20260817000500_api_keys.sql: char_length between 1 and 60.
 */
export const KEY_NAME_MAX_LENGTH = 60;
export const KEY_NAME_MIN_LENGTH = 1;
