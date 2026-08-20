"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { AuthFormState } from "@/app/(auth)/form-state";
import { describeAuthError } from "@/lib/supabase/auth-errors";
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

/** Local Supabase has no SMTP; confirmation mail lands in Inbucket. */
const isLocalSupabase = (): boolean =>
  /(^|\/\/)(127\.0\.0\.1|localhost)(:|$)/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");

const INBUCKET_URL = "http://localhost:54324";

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
// GitHub OAuth
// ---------------------------------------------------------------------------

export async function signInWithGitHubAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const next = safeNextPath(String(formData.get("next") ?? "")) ?? SIGNED_IN_HOME;
  const supabase = await createClient();
  const origin = await requestOrigin();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error) {
    const failure = describeAuthError(error, "oauth");
    return { status: "error", message: failure.message };
  }
  if (!data.url) {
    return {
      status: "error",
      message:
        "GitHub sign-in isn't configured on this deployment — no authorization URL was returned. Use email and password instead.",
    };
  }

  // Leaves the app for github.com; the PKCE verifier cookie set above travels
  // with the browser and is consumed by /auth/callback on the way back.
  redirect(data.url as Route);
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
