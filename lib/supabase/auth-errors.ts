import type { AuthError } from "@supabase/supabase-js";

/**
 * Human error copy for every auth failure we can actually hit.
 *
 * Two rules:
 *
 * 1. **No bare "something went wrong".** Every branch below says what happened
 *    and what to do next. The fallback names the underlying condition rather
 *    than shrugging.
 * 2. **No account-enumeration oracle.** "No such user" and "wrong password"
 *    must be indistinguishable — same text, same status, same timing class.
 *    GoTrue already collapses both into `invalid_credentials`; this module must
 *    not un-collapse it by special-casing anything email-existence-shaped.
 */

/** Identical copy for "no such account" and "wrong password". Do not split. */
const INVALID_CREDENTIALS =
  "That email and password combination doesn't match an account. Check both and try again.";

/**
 * The OAuth providers the sign-in surfaces offer, spelled the way a person
 * reads them. This is display copy only — the Supabase provider strings
 * (`github`, `custom:huggingface`) live in `app/(auth)/actions.ts`.
 */
export type OAuthProviderLabel = "GitHub" | "Hugging Face";

/**
 * Copy for "the sign-in call succeeded but handed back no authorization URL",
 * which is what GoTrue does when the provider is not configured on this
 * project. Shared so the two OAuth actions cannot drift apart in wording.
 */
export function oauthUnavailableMessage(provider: OAuthProviderLabel): string {
  return (
    `${provider} sign-in isn't configured on this deployment — no authorization ` +
    "URL was returned. Use email and password instead."
  );
}

export type AuthErrorCode =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "weak_password"
  | "signup_conflict"
  | "signup_disabled"
  | "provider_disabled"
  | "rate_limited"
  | "expired_link"
  | "oauth_denied"
  | "validation_failed"
  | "user_banned"
  | "network"
  | "unknown";

export type AuthFailure = {
  code: AuthErrorCode;
  /** Shown to the user. Never contains a raw provider string. */
  message: string;
  /** Field to attach the message to, when it belongs to one. */
  field?: "email" | "password";
};

function failure(
  code: AuthErrorCode,
  message: string,
  field?: AuthFailure["field"],
): AuthFailure {
  return field ? { code, message, field } : { code, message };
}

/**
 * Map a Supabase `AuthError` to user-facing copy.
 *
 * `intent` matters for one case only: on sign-up a duplicate email must not be
 * confirmable by the visitor, so it gets the same neutral copy as any other
 * refused sign-up.
 *
 * `provider` is only ever known on the OAuth *start* path, where the caller
 * picked the provider a moment ago. The callback cannot supply it — GoTrue's
 * error redirect carries no provider — so those branches stay neutral rather
 * than naming the wrong one of the two buttons.
 */
export function describeAuthError(
  error: AuthError | Error,
  intent: "sign-in" | "sign-up" | "oauth" | "callback" = "sign-in",
  provider?: OAuthProviderLabel,
): AuthFailure {
  const code = (error as AuthError).code ?? "";
  const status = (error as AuthError).status ?? 0;
  const raw = error.message ?? "";

  switch (code) {
    case "invalid_credentials":
    case "invalid_grant":
      return failure("invalid_credentials", INVALID_CREDENTIALS, "password");

    case "email_not_confirmed":
      return failure(
        "email_not_confirmed",
        "This account still needs its email confirmed. Open the confirmation link we sent, then sign in.",
        "email",
      );

    case "weak_password":
      return failure(
        "weak_password",
        raw.toLowerCase().includes("characters")
          ? `That password is too weak. ${raw.replace(/^Password:?\s*/i, "")}`
          : "That password is too weak. Use at least 8 characters and mix in a number or symbol.",
        "password",
      );

    case "user_already_exists":
    case "email_exists":
      // Deliberately non-committal: confirming the address is taken would tell
      // an attacker which emails are registered.
      return failure(
        "signup_conflict",
        "We couldn't create an account with those details. If you already have one, sign in instead.",
      );

    case "signup_disabled":
    case "email_provider_disabled":
      return failure(
        "signup_disabled",
        "New sign-ups are turned off on this deployment right now.",
      );

    case "provider_disabled":
      return failure(
        "provider_disabled",
        provider
          ? `${provider} sign-in isn't enabled on this deployment. Use email and password instead.`
          : "That sign-in provider isn't enabled on this deployment. Use email and password instead.",
      );

    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return failure(
        "rate_limited",
        "Too many attempts in a short window. Wait about a minute and try again.",
      );

    case "otp_expired":
      return failure(
        "expired_link",
        "That confirmation link has expired or was already used. Request a new one below.",
      );

    case "validation_failed":
      return failure(
        "validation_failed",
        "That email address doesn't look valid. Check it and try again.",
        "email",
      );

    case "user_banned":
      return failure(
        "user_banned",
        "This account is suspended. Contact support to get it reinstated.",
      );
  }

  // No code (older GoTrue builds, or a transport failure). Fall back on status.
  if (status === 400 && intent === "sign-in") {
    return failure("invalid_credentials", INVALID_CREDENTIALS, "password");
  }
  if (status === 422 && /already registered|already exists/i.test(raw)) {
    return failure(
      "signup_conflict",
      "We couldn't create an account with those details. If you already have one, sign in instead.",
    );
  }
  if (status === 429) {
    return failure(
      "rate_limited",
      "Too many attempts in a short window. Wait about a minute and try again.",
    );
  }
  if (status === 0 || /fetch failed|network|ECONNREFUSED/i.test(raw)) {
    return failure(
      "network",
      "Couldn't reach the authentication service. Check your connection — if you're running locally, make sure Supabase is up on port 54321.",
    );
  }

  return failure(
    "unknown",
    intent === "sign-up"
      ? "Sign-up failed before the account was created. Nothing was saved — try again."
      : "Sign-in failed before a session was created. Nothing was changed — try again.",
  );
}

/**
 * Map the `error` / `error_code` query pair an OAuth provider sends back to a
 * redirect URI. The user cancelled far more often than anything else broke.
 */
export function describeOAuthCallbackError(
  error: string | null,
  errorCode: string | null,
  errorDescription: string | null,
): AuthFailure {
  // `otp_expired` FIRST. GoTrue reports an expired or already-used *email*
  // link as `error=access_denied&error_code=otp_expired`, so matching on
  // `access_denied` first told everyone whose confirmation link had expired
  // that their "sign-in was cancelled" — verified against a re-used
  // confirmation link on the local stack.
  //
  // None of the copy below names a provider. The redirect carries `error` and
  // `error_code` and nothing else, so with GitHub *and* Hugging Face on the
  // page, naming one would be wrong roughly half the time.
  if (errorCode === "otp_expired" || errorCode === "expired_token") {
    return failure(
      "expired_link",
      "That link has expired or was already used. Request a new one below.",
    );
  }
  if (error === "access_denied" || errorCode === "access_denied") {
    return failure(
      "oauth_denied",
      "Sign-in was cancelled, so no account was connected. You can try again or use email and password.",
    );
  }
  if (error === "server_error") {
    return failure(
      "unknown",
      "The sign-in provider returned an error instead of completing sign-in. Nothing was changed — try again.",
    );
  }
  if (errorDescription) {
    return failure(
      "unknown",
      "Sign-in couldn't be completed. Nothing was changed — try again, or use email and password.",
    );
  }
  return failure(
    "unknown",
    "Sign-in couldn't be completed. Nothing was changed — try again.",
  );
}

/** Copy for the one non-provider failure the callback route can produce. */
export const CALLBACK_EXCHANGE_FAILED: AuthFailure = {
  code: "expired_link",
  message:
    "That sign-in link is no longer valid — links are single-use and expire. Start again below.",
};

/**
 * Codes the callback route may hand back to /login via `?authError=`.
 *
 * Only the CODE crosses the URL, never the message: a message in a query
 * string is attacker-controlled text rendered in your own UI.
 */
const QUERY_MESSAGES: Partial<Record<AuthErrorCode, string>> = {
  oauth_denied:
    "Sign-in was cancelled, so no account was connected. Try again, or use email and password.",
  expired_link:
    "That link is no longer valid — confirmation links are single-use and expire. Request a new one below.",
  provider_disabled:
    "That sign-in provider isn't enabled on this deployment. Use email and password instead.",
  email_not_confirmed:
    "This account still needs its email confirmed. Open the confirmation link, then sign in.",
  rate_limited:
    "Too many attempts in a short window. Wait about a minute and try again.",
  user_banned: "This account is suspended. Contact support to get it reinstated.",
  unknown: "Sign-in couldn't be completed. Nothing was changed — try again.",
};

/** Resolve a `?authError=` code to copy, or `null` when absent/unrecognised. */
export function messageForQueryCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return QUERY_MESSAGES[code as AuthErrorCode] ?? QUERY_MESSAGES.unknown ?? null;
}
