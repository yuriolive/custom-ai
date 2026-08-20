import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { CALLBACK_EXCHANGE_FAILED, describeAuthError } from "@/lib/supabase/auth-errors";
import { safeNextPath, SIGNED_IN_HOME } from "@/lib/supabase/middleware";
import { browserOrigin } from "@/lib/supabase/request-origin";
import { createClient } from "@/lib/supabase/server";

/**
 * Token-hash confirmation endpoint.
 *
 * Supabase's DEFAULT email template links to `{{ .ConfirmationURL }}`, which
 * lands on `/auth/callback` with a `?code=`. A project that customises the
 * template to `{{ .TokenHash }}` — the shape Supabase's own SSR guide
 * recommends, because it survives email clients that pre-fetch links — sends
 * the user here instead. Both are supported so the app keeps working whichever
 * template `supabase/config.toml` ends up with (that file is owned by another
 * agent, so this route is the cheap way to be right either way).
 */
const VALID_TYPES: readonly EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  // Not `request.nextUrl.origin` — see lib/supabase/request-origin.ts.
  const origin = browserOrigin(request);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNextPath(searchParams.get("next")) ?? SIGNED_IN_HOME;

  if (!tokenHash || !type || !VALID_TYPES.includes(type)) {
    return NextResponse.redirect(
      `${origin}/login?authError=${encodeURIComponent(CALLBACK_EXCHANGE_FAILED.code)}`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error) {
    const failure = describeAuthError(error, "callback");
    return NextResponse.redirect(
      `${origin}/login?authError=${encodeURIComponent(
        failure.code === "unknown" ? CALLBACK_EXCHANGE_FAILED.code : failure.code,
      )}`,
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
