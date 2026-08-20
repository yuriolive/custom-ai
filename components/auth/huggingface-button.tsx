"use client";

import { Button, Spinner } from "@heroui/react";
import { useActionState } from "react";

import { signInWithHuggingFaceAction } from "@/app/(auth)/actions";
import { initialAuthFormState } from "@/app/(auth)/form-state";
import { AuthAlert } from "@/components/auth/auth-alert";

/**
 * A monochrome stand-in for the Hugging Face mark, not a reproduction of it.
 * The real logo is a multi-colour gradient emoji face with hands; at 16px in a
 * button, inheriting `currentColor` and sitting on both themes, none of that
 * survives — so this is the face reduced to what reads at that size. Kept in
 * this file rather than an asset so it cannot drift out of sync with the label.
 */
function HuggingFaceMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      focusable="false"
      viewBox="0 0 16 16"
    >
      <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5.75" cy="6.5" fill="currentColor" r="1" />
      <circle cx="10.25" cy="6.5" fill="currentColor" r="1" />
      {/* Sweep flag 0: with SVG's y-axis pointing down, the clockwise arc
          between these two points bulges upward. A smile needs the other one. */}
      <path
        d="M5.25 9.25a3.5 3.5 0 0 0 5.5 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/**
 * Sign in through Hugging Face, a Supabase **Custom Provider** (`custom:huggingface`)
 * rather than a built-in one — HF is a standards-compliant OIDC issuer, so there is no
 * bespoke OAuth code behind this button, only dashboard configuration.
 *
 * `variant="secondary"`, like `GitHubButton` and for the same reason (DESIGN.md §3.7):
 * the accent is spent once per page and it is spent on the email submit, so a page
 * offering *three* ways in still has exactly one filled control. Two filled OAuth
 * buttons above an outlined submit would make the email form look disabled.
 *
 * The caller decides whether to render this at all — a local Supabase stack cannot
 * have a custom provider, so the login and sign-up surfaces omit it there.
 *
 * Its own form and its own `useActionState`, so its pending state is independent of
 * the GitHub button's and of the email form's.
 */
export function HuggingFaceButton({
  next,
  label = "Continue with Hugging Face",
}: Readonly<{
  next: string;
  label?: string;
}>) {
  const [state, formAction, isPending] = useActionState(
    signInWithHuggingFaceAction,
    initialAuthFormState,
  );

  return (
    <div className="flex flex-col gap-3">
      {state.status === "error" && state.message ? (
        <AuthAlert
          description={state.message}
          status="danger"
          title="Hugging Face sign-in unavailable"
        />
      ) : null}

      <form action={formAction}>
        <input name="next" type="hidden" value={next} />
        <Button
          className="w-full"
          isDisabled={isPending}
          size="lg"
          type="submit"
          variant="secondary"
        >
          {isPending ? <Spinner size="sm" /> : <HuggingFaceMark />}
          {isPending ? "Redirecting to Hugging Face…" : label}
        </Button>
      </form>
    </div>
  );
}
