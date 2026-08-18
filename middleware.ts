import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

/**
 * Refreshes the Supabase auth cookie on every matched request and enforces the
 * route table in CONTRACTS.md:
 *
 *   public         /  ·  /models/**  ·  /login  ·  /signup  ·  /auth/**
 *   authenticated  /console/**  ·  /studio/**  ·  /playground/**
 *
 * The whole route table lives in `lib/supabase/middleware.ts` so it is testable
 * without booting a request.
 */
export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Every path except static assets and image files. Auth cookies must be
     * refreshed on ordinary page navigations, which is exactly what is left
     * after these exclusions.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
