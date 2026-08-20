---
# ca-c2k0
title: 'marketplace: official badge when a creator owns the upstream HF repo'
status: completed
type: feature
priority: normal
created_at: 2026-08-20T04:48:23Z
updated_at: 2026-08-20T05:08:35Z
---

GitHub #30, phase 7 of the marketplace discovery plan. Stacks on #24 (base_models) and #23
(Hugging Face sign-in).

A listing earns an `official` badge when the Hugging Face account behind the creator owns the
upstream repository the listing serves. Everything else is a **third-party host**, which is the
normal state of a healthy marketplace and is rendered as a peer of `official`, never as a
warning.

## The three limits that define it

HF OAuth proves control of an HF account, not authorship of the weights — an org member can
publish a repo they did not train. So:

- gate the badge, never the right to list;
- never let the badge feed a pricing, ranking or payout decision (#29 owns the gate that
  actually governs earning);
- state the limit in the UI's own words rather than implying a verification that did not happen.

## Where the facts come from

`session.provider_token` does not survive a refresh (ca-uquk), so it cannot be a durable
credential. It is read ONCE inside `/auth/callback`, exchanged for
`https://huggingface.co/oauth/userinfo`, and only the DERIVED facts — username and org
usernames — are persisted. The token itself is never stored and never logged.

## Todo

- [x] Migration 20260820004000: `hf_identities` + the `listing_is_official` computed column
- [x] `lib/hf/` — userinfo parse, namespace normalization, the callback writer
- [x] Capture at `/auth/callback`, best-effort, never fatal to sign-in
- [x] Catalog projection + `CatalogModel.isOfficial`
- [x] Badge on the card and a provenance block on the model page
- [x] pgTAP 08 for the rule; node tests for the parser and the copy
- [x] `npm run check` + `npm test`


## Summary of Changes

The rule lives in ONE place: `public.listing_is_official(public.custom_models)`
(migration `20260820004000`), exposed to the catalog as a PostgREST **computed column** so
the badge rides the same indexed query as the rest of the card. SECURITY DEFINER, because
`hf_identities` is not granted to `anon` at all — the badge is public, the org list is
not — and it re-reads every fact from the table under `m.id`, so a hand-built composite
argument cannot be used to guess a creator's orgs one call at a time.

A listing is official when the creator's verified HF namespaces (username + orgs) contain
the owner of `hf_repo_slug`, **or** the publisher segment of `base_models.slug` once the
listing is grouped. OR rather than AND: the second arm covers the lab serving its own
weights through a quantization repo in a namespace it does not own, and requiring both
would mean nothing can be official until the #25 cascade has run.

Facts come from `/auth/callback` calling `https://huggingface.co/oauth/userinfo` with
`session.provider_token` and storing only username + orgs. HF's OIDC discovery document
lists no `claims_supported`, and `orgs` is not a standard claim, so session claims are
tried first and userinfo settles the org list. The token is never persisted and never
logged. Needs the `read-memberships` scope; without it `memberships_readable` stays
false and every creator reads as org-less, which costs badges and never grants one.

No TypeScript copy of the rule — TS owns the strings, SQL owns the decision. Both states
render as the same outline pill in the same colour: `official` and `third-party`, peers,
because absence alone reads as an unexplained signal and a shopper infers the harshest
meaning available for it.

Verified against a real Postgres 16 with every migration + seed applied: 38/38 in
`08_official_badge_test.sql`, and 00-04/06/07 still green (05 needs dblink). `npm run
check` and `npm test` pass.

## Deferred

- The Studio surface that says "linked as @you" and explains why a listing is not
  official. `hf_identities_select_own` exists for it; nothing renders it yet.
- Re-reading org membership without a sign-in. `refreshed_at` makes the staleness
  visible; leaving an org does not clear the badge until the creator signs in again.
  Correct for a badge, and one more reason it must never gate anything.
