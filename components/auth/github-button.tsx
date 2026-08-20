"use client";

import { Button, Spinner } from "@heroui/react";
import { useActionState } from "react";

import { AuthAlert } from "@/components/auth/auth-alert";
import { signInWithGitHubAction } from "@/app/(auth)/actions";
import { initialAuthFormState } from "@/app/(auth)/form-state";

function GitHubMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="currentColor"
      focusable="false"
      viewBox="0 0 16 16"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * The first sign-in path offered. The audience is HF-adjacent developers, so
 * GitHub leads, Hugging Face sits beside it, and email is the fallback below.
 *
 * FIRST IN ORDER IS NOT THE SAME AS FIRST IN WEIGHT, and this button carries
 * `variant="secondary"` on purpose (DESIGN.md §3.7). The accent is spent once
 * per page and it is spent on the email submit, so a page offering three ways
 * in still has exactly one filled control rather than several competing for the
 * eye. This was inverted in the code for a while — GitHub filled, submit
 * outlined — which left the email form looking disabled next to it.
 *
 * Its own form and its own `useActionState`, so its pending state is
 * independent of the other buttons' and of the email form's.
 */
export function GitHubButton({
  next,
  label = "Continue with GitHub",
}: {
  next: string;
  label?: string;
}) {
  const [state, formAction, isPending] = useActionState(
    signInWithGitHubAction,
    initialAuthFormState,
  );

  return (
    <div className="flex flex-col gap-3">
      {state.status === "error" && state.message ? (
        <AuthAlert description={state.message} status="danger" title="GitHub sign-in unavailable" />
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
          {isPending ? <Spinner size="sm" /> : <GitHubMark />}
          {isPending ? "Redirecting to GitHub…" : label}
        </Button>
      </form>
    </div>
  );
}
