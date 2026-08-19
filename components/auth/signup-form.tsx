"use client";

import {
  Button,
  Card,
  Description,
  FieldError,
  Input,
  Label,
  Link,
  Separator,
  Spinner,
  TextField,
} from "@heroui/react";
import NextLink from "next/link";
import { useActionState } from "react";

import { signUpAction } from "@/app/(auth)/actions";
import { initialAuthFormState } from "@/app/(auth)/form-state";
import { AuthAlert } from "@/components/auth/auth-alert";
import { GitHubButton } from "@/components/auth/github-button";

/**
 * Sign-up surface.
 *
 * The handle that forms your `creator/model` namespace is assigned by the
 * `on_auth_user_created` trigger and is immutable by RLS (CONTRACTS.md), so
 * this form deliberately does NOT ask for one — there is no handle-claim flow
 * to build, and offering a field we cannot honour would be a lie.
 */
export function SignupForm({
  next,
  isLocalSupabase,
  inbucketUrl,
}: {
  next: string;
  /** True when pointed at a local stack, which has no SMTP. */
  isLocalSupabase: boolean;
  inbucketUrl: string;
}) {
  const [state, formAction, isPending] = useActionState(signUpAction, initialAuthFormState);

  const error = state.status === "error" ? state.message : null;
  const invalidField = state.status === "error" ? state.field : undefined;

  if (state.status === "check-email") {
    return (
      <Card className="w-full gap-6 p-8">
        <Card.Header className="gap-1.5">
          <Card.Title className="text-xl leading-tight font-semibold tracking-[-0.02em]">
            Confirm your email
          </Card.Title>
          <Card.Description>
            We sent a confirmation link to {state.email}. Open it to finish creating your account.
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4 p-0">
          {isLocalSupabase ? (
            <AuthAlert
              description={`Local Supabase does not send real email. The message is sitting in Inbucket at ${inbucketUrl} — open it there and click the confirmation link.`}
              status="warning"
              title="Local dev: check Inbucket, not your inbox"
            />
          ) : null}
          {/* HeroUI Button is a React Aria <button> and has no `as`/`href`
              escape hatch, so navigation uses Link (React Aria's anchor). */}
          <div className="flex flex-wrap items-center gap-4">
            {isLocalSupabase ? (
              <Link href={inbucketUrl} rel="noreferrer" target="_blank">
                Open Inbucket
              </Link>
            ) : null}
            <Link href={`/login?next=${encodeURIComponent(next)}`}>Back to sign in</Link>
          </div>
        </Card.Content>
      </Card>
    );
  }

  return (
    <Card className="w-full gap-6 p-8">
      <Card.Header className="gap-1.5">
        <Card.Title className="text-xl leading-tight font-semibold tracking-[-0.02em]">
          Create an account
        </Card.Title>
        <Card.Description>
          Publish models, mint API keys and earn 80% of what your models bill.
        </Card.Description>
      </Card.Header>

      <Card.Content className="flex flex-col gap-5 p-0">
        <GitHubButton label="Sign up with GitHub" next={next} />

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
            or with email
          </span>
          <Separator className="flex-1" />
        </div>

        {error ? <AuthAlert description={error} status="danger" title="Sign-up failed" /> : null}

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
            <Input autoComplete="email" autoFocus placeholder="you@example.com" />
            <Description>
              {isLocalSupabase
                ? `Local dev: the confirmation email lands in Inbucket at ${inbucketUrl}, not in a real inbox.`
                : "We'll send a confirmation link before the account is active."}
            </Description>
            <FieldError>{invalidField === "email" ? error : null}</FieldError>
          </TextField>

          <TextField
            isInvalid={invalidField === "password"}
            isRequired
            name="password"
            type="password"
          >
            <Label>Password</Label>
            <Input autoComplete="new-password" placeholder="At least 8 characters" />
            <Description>At least 8 characters.</Description>
            <FieldError>{invalidField === "password" ? error : null}</FieldError>
          </TextField>

          <Button
            className="w-full"
            isDisabled={isPending}
            size="lg"
            type="submit"
            variant="primary"
          >
            {isPending ? <Spinner size="sm" /> : null}
            {isPending ? "Creating account…" : "Create account"}
          </Button>

          <Description className="border-border mt-1 border-t pt-4 text-center">
            Already have an account?{" "}
            <NextLink
              className="text-foreground hover:text-accent underline underline-offset-4 transition-colors"
              href={`/login?next=${encodeURIComponent(next)}`}
            >
              Sign in
            </NextLink>
          </Description>
        </form>
      </Card.Content>
    </Card>
  );
}
