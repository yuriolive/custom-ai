"use client";

import {
  Button,
  Card,
  Description,
  FieldError,
  Input,
  Label,
  Separator,
  Spinner,
  TextField,
} from "@heroui/react";
import Link from "next/link";
import { useActionState } from "react";

import { signInAction } from "@/app/(auth)/actions";
import { initialAuthFormState } from "@/app/(auth)/form-state";
import { AuthAlert } from "@/components/auth/auth-alert";
import { GitHubButton } from "@/components/auth/github-button";

/**
 * Sign-in surface. GitHub first (primary), email + password second.
 *
 * All HeroUI, so the whole file is behind `"use client"` (§4.1.0); the page
 * that renders it is a Server Component and passes plain props down.
 */
export function LoginForm({
  next,
  initialError,
}: {
  next: string;
  /** Message forwarded by /auth/callback via `?authError=` (a code, mapped server-side). */
  initialError?: string | null;
}) {
  const [state, formAction, isPending] = useActionState(
    signInAction,
    initialAuthFormState,
  );

  const error = state.status === "error" ? state.message : null;
  const invalidField = state.status === "error" ? state.field : undefined;

  return (
    <Card className="w-full">
      <Card.Header>
        <Card.Title>Sign in</Card.Title>
        <Card.Description>
          Deploy models, mint API keys and watch your usage settle.
        </Card.Description>
      </Card.Header>

      <Card.Content className="flex flex-col gap-5">
        {initialError && !error ? (
          <AuthAlert
            description={initialError}
            status="danger"
            title="Couldn't finish signing in"
          />
        ) : null}

        <GitHubButton next={next} />

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted text-xs uppercase tracking-wide">
            or with email
          </span>
          <Separator className="flex-1" />
        </div>

        {error ? (
          <AuthAlert description={error} status="danger" title="Sign-in failed" />
        ) : null}

        <form action={formAction} className="flex flex-col gap-4" noValidate>
          <input name="next" type="hidden" value={next} />

          <TextField
            defaultValue={state.email}
            isInvalid={invalidField === "email"}
            isRequired
            name="email"
            type="email"
          >
            <Label>Email</Label>
            <Input
              autoComplete="email"
              placeholder="you@example.com"
              // Autofocus is correct here: this card is the entire purpose of
              // the page, so focus is not being stolen from anything.
              autoFocus
            />
            <FieldError>{invalidField === "email" ? error : null}</FieldError>
          </TextField>

          <TextField
            isInvalid={invalidField === "password"}
            isRequired
            name="password"
            type="password"
          >
            <Label>Password</Label>
            <Input autoComplete="current-password" placeholder="••••••••" />
            <FieldError>{invalidField === "password" ? error : null}</FieldError>
          </TextField>

          <Button
            className="w-full"
            isDisabled={isPending}
            size="lg"
            type="submit"
            variant="secondary"
          >
            {isPending ? <Spinner size="sm" /> : null}
            {isPending ? "Signing in…" : "Sign in"}
          </Button>

          <Description className="text-center">
            No account?{" "}
            <Link
              className="text-foreground underline underline-offset-4"
              href={`/signup?next=${encodeURIComponent(next)}`}
            >
              Create one
            </Link>
          </Description>
        </form>
      </Card.Content>
    </Card>
  );
}
