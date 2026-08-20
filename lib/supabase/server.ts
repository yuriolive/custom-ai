import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./public-config";

/**
 * Server Supabase client for React Server Components, Server Actions and Route
 * Handlers (CONTRACTS.md §Frontend / auth contract).
 *
 * Async, because `cookies()` is async in Next.js 15. Create a NEW client per
 * request — never hoist one to module scope, or one user's session leaks into
 * another user's render.
 *
 * The `setAll` catch is deliberate and load-bearing: a Server Component may not
 * mutate cookies, so a token refresh that happens during a render throws. That
 * is safe to swallow **only because** `middleware.ts` calls `updateSession` on
 * every matched request and writes the refreshed cookie there. If you ever
 * delete the middleware, sessions will start expiring silently.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render. Ignored — the middleware
          // owns cookie writes. See the note above.
        }
      },
    },
  });
}

/**
 * The authenticated user, or `null`.
 *
 * Always `getUser()`, never `getSession()`, on the server: `getSession` reads
 * the cookie without verifying its signature, so it will happily report a user
 * from a forged cookie. `getUser` revalidates against the Auth server.
 */
export async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** The shape the nav and any greeting need. Handle is immutable (CONTRACTS.md). */
export type SessionProfile = {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  /**
   * Spendable wallet, micro-USD. Null only in the brief window where the
   * signup trigger has not committed a profile row yet — the nav renders no
   * balance chip at all in that case rather than a $0.00 that is not true.
   */
  balanceMicroUsd: number | null;
  /**
   * Platform moderator (§5.5). Read here rather than in a second query because
   * the nav needs it on every render and this row is already being fetched.
   *
   * NOT a security boundary — it only decides whether a link is drawn. The
   * operator RPCs each re-check `is_platform_operator(auth.uid())` in Postgres
   * and raise 42501 regardless (migration 20260820002000, and
   * supabase/tests/08). It is safe to read here for the same reason it is safe
   * to store: `profiles_update_own` is an allowlist over three columns, so the
   * flag is read-only to its owner.
   */
  isOperator: boolean;
};

/**
 * Current user's profile row, or `null` when signed out.
 *
 * `profiles` rows are created by the `on_auth_user_created` trigger, so a
 * signed-in user normally has exactly one. It can still be missing for a
 * moment on a brand-new OAuth signup if the trigger has not committed when the
 * first render runs, so callers must tolerate `null` and fall back to the
 * email local part rather than crashing the nav.
 */
export async function getSessionProfile(): Promise<SessionProfile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, handle, display_name, avatar_url, balance_micro_usd, is_operator")
    .eq("id", user.id)
    .maybeSingle();

  if (!data) {
    return {
      id: user.id,
      handle: user.email?.split("@")[0] ?? "account",
      displayName: null,
      avatarUrl: null,
      balanceMicroUsd: null,
      isOperator: false,
    };
  }

  return {
    id: data.id as string,
    handle: data.handle as string,
    displayName: (data.display_name as string | null) ?? null,
    avatarUrl: (data.avatar_url as string | null) ?? null,
    balanceMicroUsd: (data.balance_micro_usd as number | null) ?? null,
    isOperator: data.is_operator === true,
  };
}
