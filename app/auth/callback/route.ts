import { NextResponse, type NextRequest } from "next/server";

import { recordHuggingFaceIdentity } from "@/lib/hf/link";
import {
  CALLBACK_EXCHANGE_FAILED,
  describeAuthError,
  describeOAuthCallbackError,
} from "@/lib/supabase/auth-errors";
import { safeNextPath, SIGNED_IN_HOME } from "@/lib/supabase/middleware";
import { browserOrigin } from "@/lib/supabase/request-origin";
import { createClient } from "@/lib/supabase/server";

/**
 * PKCE callback. Handles BOTH paths that end in a `?code=`:
 *
 *   - GitHub OAuth, returning from github.com
 *   - the email confirmation link, when the template uses `{{ .ConfirmationURL }}`
 *
 * The code is single-use: exchanging it sets the auth cookie on this response,
 * which is why the redirect must be built from the response the Supabase client
 * wrote its cookies onto (`createClient` here writes through `cookies()`, and
 * Route Handlers *may* write cookies, unlike Server Components).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  // Not `request.nextUrl.origin` — see lib/supabase/request-origin.ts.
  const origin = browserOrigin(request);
  const next = safeNextPath(searchParams.get("next")) ?? SIGNED_IN_HOME;

  const providerError = searchParams.get("error");
  const providerErrorCode = searchParams.get("error_code");
  if (providerError || providerErrorCode) {
    const failure = describeOAuthCallbackError(
      providerError,
      providerErrorCode,
      searchParams.get("error_description"),
    );
    return NextResponse.redirect(
      `${origin}/login?authError=${encodeURIComponent(failure.code)}`,
    );
  }

  const code = searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      `${origin}/login?authError=${encodeURIComponent(CALLBACK_EXCHANGE_FAILED.code)}`,
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const failure = describeAuthError(error, "callback");
    return NextResponse.redirect(
      `${origin}/login?authError=${encodeURIComponent(
        failure.code === "unknown" ? CALLBACK_EXCHANGE_FAILED.code : failure.code,
      )}`,
    );
  }

  // THE ONE MOMENT the platform can learn a creator's Hugging Face identity.
  // `data.session.provider_token` is on this response and on nothing afterwards
  // — it does not survive a refresh (#23) — so the org list behind the `official`
  // badge (#30) is read here or not at all. Awaited rather than fired and
  // forgotten: the serverless invocation ends with this response, and work still
  // running when it does is work that may simply not happen.
  //
  // `recordHuggingFaceIdentity` cannot throw and does nothing for a non-HF
  // session, which is what keeps this line out of the sign-in failure surface.
  if (data.session) await recordHuggingFaceIdentity(data.session);

  return NextResponse.redirect(`${origin}${next}`);
}
