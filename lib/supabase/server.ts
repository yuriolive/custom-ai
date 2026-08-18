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
    .select("id, handle, display_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  if (!data) {
    return {
      id: user.id,
      handle: user.email?.split("@")[0] ?? "account",
      displayName: null,
      avatarUrl: null,
    };
  }

  return {
    id: data.id as string,
    handle: data.handle as string,
    displayName: (data.display_name as string | null) ?? null,
    avatarUrl: (data.avatar_url as string | null) ?? null,
  };
}
