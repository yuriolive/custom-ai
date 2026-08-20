import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./public-config";

/**
 * Middleware Supabase client + route protection
 * (CONTRACTS.md §Frontend / auth contract).
 *
 * This is the only place the auth cookie is refreshed. Server Components can
 * read the session but cannot write a rotated token back, so without this the
 * session dies silently one JWT lifetime after sign-in.
 */

/**
 * Prefixes that require a session. Everything else is public.
 *
 * `/chat` is on the list for a reason that is not "it feels internal": every
 * turn wakes a metered GPU, so an anonymous one is inference the platform pays
 * for outright, with no wallet to charge and no creator to pay. That is the
 * same free-inference shape the minimum-billable-unit rule exists to close
 * (CONTRACTS.md §Money). Guest mode is a budget and a rate limit, not a flag.
 */
const PROTECTED_PREFIXES = ["/chat", "/console", "/studio", "/playground"] as const;

/** Auth pages an already-signed-in user should not sit on. */
const AUTH_PAGES = ["/login", "/signup"] as const;

/** Where an authenticated user lands when they hit /login or /signup. */
export const SIGNED_IN_HOME = "/console";

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Only same-origin, non-protocol-relative paths may be used as a post-login
 * destination. `//evil.com` is a valid *path* to the URL parser and would turn
 * `?next=` into an open redirect.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.startsWith("/\\")) return null;
  return value;
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // Do not put logic between createServerClient and getUser(): getUser() is what
  // actually revalidates and rotates the token. Anything that returns early
  // above it produces a user that is randomly logged out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search, searchParams } = request.nextUrl;

  // Supabase only redirects to URLs on its allow-list. When `emailRedirectTo`
  // is not allow-listed, GoTrue falls back to `site_url` and appends the PKCE
  // `code` there — i.e. the code arrives on `/` rather than `/auth/callback`.
  // Forward it instead of dropping the user on the home page, silently signed
  // out, holding a one-time code nobody will ever exchange.
  if (
    searchParams.has("code") &&
    !pathname.startsWith("/auth/") &&
    !isProtected(pathname)
  ) {
    const callback = request.nextUrl.clone();
    callback.pathname = "/auth/callback";
    return NextResponse.redirect(callback);
  }

  if (!user && isProtected(pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  if (user && isAuthPage(pathname)) {
    // `next` may carry its own query string, so resolve it as a URL rather
    // than assigning it to `pathname`.
    const target = new URL(
      safeNextPath(searchParams.get("next")) ?? SIGNED_IN_HOME,
      request.url,
    );
    return NextResponse.redirect(target);
  }

  // IMPORTANT: return `supabaseResponse` itself (or copy its cookies onto any
  // response you build instead). A fresh NextResponse drops the rotated auth
  // cookie and logs the user out at random.
  return supabaseResponse;
}
