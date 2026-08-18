import type { NextRequest } from "next/server";

/**
 * The origin the BROWSER actually used for this request.
 *
 * Do not use `request.nextUrl.origin` (or `request.url`) to build a redirect
 * that must carry a freshly-set auth cookie. Next.js normalises both to the
 * dev server's own origin, so a visitor who arrived on `http://127.0.0.1:3000`
 * — which is exactly what `supabase/config.toml` sets `site_url` to — gets a
 * `Location: http://localhost:3000/...`. `127.0.0.1` and `localhost` are
 * different cookie hosts, so the `Set-Cookie` written by
 * `exchangeCodeForSession` is invisible after the hop and the user lands on
 * `/login`, signed out, holding an already-spent single-use code. Verified
 * against a real confirmation link: the exchange succeeded server-side
 * (`last_sign_in_at` was set) and the browser still had no session.
 *
 * `x-forwarded-host` comes first for the same reason Supabase's own guide uses
 * it: behind a proxy or load balancer that is the only header that still names
 * the host the user typed.
 */
export function browserOrigin(request: NextRequest): string {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return request.nextUrl.origin;

  const proto =
    request.headers.get("x-forwarded-proto") ??
    request.nextUrl.protocol.replace(":", "") ??
    "http";

  return `${proto}://${host}`;
}
