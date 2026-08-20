/**
 * "Are we pointed at a local Supabase stack?" — one answer, three callers.
 *
 * Three things behave differently against `supabase start` than against the
 * hosted project, and each one needs this predicate:
 *
 *   - there is no SMTP, so confirmation mail lands in Inbucket (sign-up copy);
 *   - **custom OIDC providers do not exist at all.** They are configured in the
 *     dashboard, and the CLI has no `[auth.external.custom.*]` key to mirror
 *     them into `config.toml`, so `custom:huggingface` can only ever answer
 *     `provider_disabled` locally. The Hugging Face button is therefore not
 *     rendered on a local stack; local sign-in is email + GitHub.
 *
 * Read from `NEXT_PUBLIC_SUPABASE_URL` rather than a separate flag so there is
 * nothing to keep in sync: the URL you point at *is* the environment. Written
 * as a full static member expression because that is the only form Next.js
 * inlines into the browser bundle, which lets a `"use client"` module ask the
 * same question if it ever needs to.
 */

/** Matches a `127.0.0.1` or `localhost` host, with or without a port. */
const LOCAL_HOST = /(^|\/\/)(127\.0\.0\.1|localhost)(:|$)/;

/** Inbucket, the local stack's mail catcher. Not reachable in production. */
export const INBUCKET_URL = "http://localhost:54324";

export function isLocalSupabase(): boolean {
  return LOCAL_HOST.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}
