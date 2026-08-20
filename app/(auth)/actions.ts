"use server";

import type { Provider } from "@supabase/supabase-js";
import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { AuthFormState } from "@/app/(auth)/form-state";
import type { OAuthProviderLabel } from "@/lib/supabase/auth-errors";
import { describeAuthError, oauthUnavailableMessage } from "@/lib/supabase/auth-errors";
import { INBUCKET_URL, isLocalSupabase } from "@/lib/supabase/is-local";
import { safeNextPath, SIGNED_IN_HOME } from "@/lib/supabase/middleware";
import { createClient } from "@/lib/supabase/server";

/**
 * Server Actions for every auth mutation.
 *
 * Mutations run on the server rather than in the browser for three reasons:
 * the auth cookie is written by the same response that performs the redirect
 * (no flash of signed-out UI), `revalidatePath` refreshes the session-aware nav
 * in the same round trip, and the form keeps working with JavaScript disabled.
 */

function readCredentials(formData: FormData) {
  return {
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
    next: safeNextPath(String(formData.get("next") ?? "")) ?? SIGNED_IN_HOME,
  };
}

/** Cheap shape check only. Deliverability is the confirmation mail's job. */
function isEmailShaped(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

async function requestOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("host") ?? "127.0.0.1:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Sign in — email + password
// ---------------------------------------------------------------------------

export async function signInAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const { email, password, next } = readCredentials(formData);

  if (!email || !password) {
    return {
      status: "error",
      message: "Enter both your email and your password.",
      field: email ? "password" : "email",
      email,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // describeAuthError collapses "no such user" and "wrong password" into one
    // message on purpose — see lib/supabase/auth-errors.ts.
    const failure = describeAuthError(error, "sign-in");
    return {
      status: "error",
      message: failure.message,
      field: failure.field,
      email,
    };
  }

  revalidatePath("/", "layout");
  redirect(next as Route);
}

// ---------------------------------------------------------------------------
// Sign up — email + password
// ---------------------------------------------------------------------------

export async function signUpAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const { email, password, next } = readCredentials(formData);

  if (!email || !password) {
    return {
      status: "error",
      message: "Enter both an email address and a password.",
      field: email ? "password" : "email",
      email,
    };
  }
  if (!isEmailShaped(email)) {
    return {
      status: "error",
      message: "That email address doesn't look valid. Check it and try again.",
      field: "email",
      email,
    };
  }
  if (password.length < 8) {
    return {
      status: "error",
      message: "Passwords need at least 8 characters.",
      field: "password",
      email,
    };
  }

  const supabase = await createClient();
  const origin = await requestOrigin();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error) {
    const failure = describeAuthError(error, "sign-up");
    return {
      status: "error",
      message: failure.message,
      field: failure.field,
      email,
    };
  }

  // Email confirmation OFF: GoTrue returns a live session, so the cookie is
  // already set and the user is in.
  if (data.session) {
    revalidatePath("/", "layout");
    redirect(next as Route);
  }

  // Email confirmation ON. Note that GoTrue returns this same shape for an
  // address that is ALREADY registered (with an empty `identities` array) —
  // that is intentional on their side and on ours: telling the visitor which
  // it was would be an account-enumeration oracle.
  return {
    status: "check-email",
    email,
    message: isLocalSupabase()
      ? `Check your email for a confirmation link. Local Supabase doesn't send real mail — open ${INBUCKET_URL} and the message will be waiting there.`
      : "Check your email for a confirmation link to finish creating your account.",
  };
}

// ---------------------------------------------------------------------------
// OAuth / OIDC
// ---------------------------------------------------------------------------

/**
 * Start an OAuth flow and leave the app for the provider.
 *
 * Shared by both providers because the bodies are otherwise identical, and an
 * identical-but-separately-maintained pair is how the error copy on one path
 * ends up naming the other provider.
 *
 * Never returns on success: `redirect` throws NEXT_REDIRECT, which Next.js
 * unwinds into a 303. The returned state is the failure path only.
 */
async function beginOAuth(
  provider: Provider,
  label: OAuthProviderLabel,
  formData: FormData,
): Promise<AuthFormState> {
  const next = safeNextPath(String(formData.get("next") ?? "")) ?? SIGNED_IN_HOME;
  const supabase = await createClient();
  const origin = await requestOrigin();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error) {
    const failure = describeAuthError(error, "oauth", label);
    return { status: "error", message: failure.message };
  }
  if (!data.url) {
    return { status: "error", message: oauthUnavailableMessage(label) };
  }

  // Leaves the app for the provider; the PKCE verifier cookie set above travels
  // with the browser and is consumed by /auth/callback on the way back.
  redirect(data.url as Route);
}

export async function signInWithGitHubAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  return beginOAuth("github", "GitHub", formData);
}

export async function signInWithHuggingFaceAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  // Custom providers exist only on a hosted project: they are configured in the
  // dashboard and the CLI has no `[auth.external.custom.*]` key, so a local
  // stack can only answer `provider_disabled`. The button is not rendered
  // locally (see lib/supabase/is-local.ts) — this guard is for the Server
  // Action itself, which is a POST endpoint and reachable without it.
  if (isLocalSupabase()) {
    return {
      status: "error",
      message:
        "Hugging Face sign-in needs a hosted Supabase project — custom providers can't be configured on a local stack. Use GitHub, or email and password.",
    };
  }

  // `Provider` in @supabase/auth-js is a closed union of the built-in providers
  // and has no `custom:${string}` member, so a custom provider cannot be typed
  // without this cast. It is safe: auth-js only interpolates the string into
  // the `provider` query parameter of GET /authorize — it never switches on the
  // value, and GoTrue resolves `custom:huggingface` against the Custom Provider
  // registered in the dashboard. Widening the union upstream is the real fix;
  // until then, this is the escape hatch and not an oversight.
  return beginOAuth("custom:huggingface" as Provider, "Hugging Face", formData);
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  // 'local' revokes this browser's refresh token only; other devices keep
  // their sessions, which is what a "sign out" button means to a user.
  await supabase.auth.signOut({ scope: "local" });
  revalidatePath("/", "layout");
  redirect("/");
}
