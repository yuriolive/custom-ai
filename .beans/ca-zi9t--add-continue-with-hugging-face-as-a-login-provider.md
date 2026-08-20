---
# ca-zi9t
title: Add "Continue with Hugging Face" as a login provider (Supabase custom OIDC)
status: completed
type: feature
priority: normal
created_at: 2026-08-20T03:28:14Z
updated_at: 2026-08-20T03:37:10Z
---

GitHub OAuth is the lead sign-in path; Hugging Face should sit beside it, because the account that hosts a model on the Hub and the account that signs in to Studio should be able to be the same one. HF is a standards-compliant OIDC provider, so this goes in as a Supabase **Custom Provider** (`custom:huggingface`) with no bespoke OAuth code.

GitHub issue: https://github.com/yuriolive/custom-ai/issues/23

## Todo

- [x] `signInWithHuggingFaceAction` in `app/(auth)/actions.ts`
- [x] `components/auth/huggingface-button.tsx`, `variant="secondary"` (DESIGN.md 3.7)
- [x] Provider-aware error copy in `lib/supabase/auth-errors.ts`
- [x] Hide the button on local Supabase (custom providers are dashboard-only)
- [x] Record the provider in `docs/CONTRACTS.md` and `docs/DEPLOY.md`
- [x] `npm run check` and `npm test` green


## Summary of Changes

- `app/(auth)/actions.ts` — `signInWithHuggingFaceAction`. Both OAuth actions now
  delegate to one private `beginOAuth(provider, label, formData)`; the bodies were
  otherwise identical, and an identical-but-separately-maintained pair is how the error
  copy on one path ends up naming the other provider. The `custom:huggingface as Provider`
  cast is commented at the single place it appears.
- `components/auth/huggingface-button.tsx` — new, `variant="secondary"` like
  `GitHubButton`, so three ways in still leave exactly one filled control on the page.
- `lib/supabase/is-local.ts` — new. The local-stack predicate was duplicated in
  `actions.ts` and `signup/page.tsx` and the login page now needs it too, so it is one
  function with the reasoning (no SMTP, and no custom providers) written down once.
- `lib/supabase/auth-errors.ts` — `OAuthProviderLabel`, `oauthUnavailableMessage`, and a
  provider argument on `describeAuthError`. The *start* path knows which button was
  pressed and names it; the *callback* path cannot (GoTrue redirects with `error` /
  `error_code` and nothing else), so its copy no longer names GitHub — with two providers
  it was wrong roughly half the time.
- `lib/supabase/auth-errors.test.ts` — new. Pins the no-enumeration-oracle property and
  the "callback copy names no provider" rule.
- `app/auth/callback/route.ts` — unchanged, as expected: it exchanges any `?code=`.
- `docs/CONTRACTS.md`, `docs/DEPLOY.md` — the provider table, and the dashboard steps
  including the two ways HF setup fails (a secret-less public app; an inexact `https`
  redirect URI).

Verified: `npm run check` and `npm test` green (49 app tests, 0 fail), `next build`
clean, and the two configurations rendered — hosted URL shows both OAuth buttons in
light and dark, `127.0.0.1` URL shows GitHub only. The Server Action carries its own
local-stack guard, since it stays reachable as a POST endpoint with the button hidden.

Deferred to ca-uquk: capturing `session.provider_token` so the Studio probe can read
private and gated repos.
