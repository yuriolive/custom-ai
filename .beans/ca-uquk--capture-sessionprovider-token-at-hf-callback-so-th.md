---
# ca-uquk
title: Capture session.provider_token at HF callback so the Studio probe can read private and gated repos
status: todo
type: feature
priority: low
created_at: 2026-08-20T03:36:42Z
updated_at: 2026-08-20T03:36:42Z
---

Today `packages/hf-probe` hits the Hub anonymously, so pointing Studio at a private or gated repo fails as "not found" rather than "you need to grant access".

With HF login in place (`custom:huggingface`), the callback exchange returns a real HF access token as `session.provider_token`. Requested with the `read-repos` / `gated-repos` scopes on the HF OAuth app, it would let the probe read a creator repo as that creator.

The constraint that shapes the whole design: **`provider_token` does not survive a session refresh.** It exists on the response to the code exchange in `app/auth/callback/route.ts` and nowhere afterwards, so it has to be captured there — it cannot be treated as a durable credential fetched on demand later.

Deliberately out of scope of the login PR (issue #23), which ships the sign-in path only. This is the strongest product argument for HF login, so it is worth doing, but it is a credential-handling change and wants its own review.

## Todo

- [ ] Decide where a captured token lives and for how long (encrypted at rest, short TTL, never a `NEXT_PUBLIC_*` anything)
- [ ] Add `read-repos` / `gated-repos` to the HF OAuth app scopes and to the Supabase custom provider config
- [ ] Capture `provider_token` in `app/auth/callback/route.ts` at exchange time
- [ ] Teach `packages/hf-probe` to send a bearer token when one is available, and to stay anonymous when it is not
- [ ] Probe error copy that distinguishes "gated, needs your access" from "does not exist"
- [ ] Never log the token (CONTRACTS.md)
