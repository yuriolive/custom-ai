---
# ca-r6fl
title: 'studio: licence gate on publishing and monetising a listing'
status: completed
type: feature
priority: high
created_at: 2026-08-20T05:23:45Z
updated_at: 2026-08-20T05:51:01Z
parent: ca-l5oz
---

GitHub issue #29. Phase 6 of the marketplace discovery plan, stacked on #24 (ca-7z3e) whose
columns it reads and #25 (ca-s0cx) whose cascade fills them in.

A creator does not sell weights, they sell inference — so ownership is the wrong gate and the
licence is the right one. The legal exposure sits with the PLATFORM: our GPU, our endpoint, our
invoice, our name on the request the end user made.

## The gate

| `commercial_hosting` | Behaviour |
|---|---|
| `allowed` | publishes |
| `conditional` | publishes once the creator acknowledges the conditions — `license_ack_at` + `license_ack_version` |
| `prohibited` | a PRIVATE deploy is still fine; never `public`, never accrues `creator_earnings` |
| `unknown` | operator review queue — not a silent publish and not a silent rejection |

Enforced in the deploy pipeline AND as a CHECK, for the same reason
`custom_models_ready_needs_placement` is a CHECK: a rule that only lives in application code is
a rule one code path forgets.

## Scope

- [x] migration 20260820007000: the governing-licence function, the mirror columns, the CHECK, the resync triggers, the review-queue view
- [x] the deploy pipeline: born private, published only when the gate allows
- [x] the creator surface: the acknowledgement, and what happens when it is missing
- [x] pgTAP: prohibited cannot reach public; conditional cannot reach public without a matching ack
- [x] seed + existing pgTAP fixtures pass the gate rather than route around it
- [x] npm run check + npm test pass


## Summary of Changes

**The gate is a CHECK, and the mirror is what makes that possible.** A CHECK can only read
its own row and `commercial_hosting` lives on `base_models`, so
`custom_models.license_hosting` / `license_terms_version` MIRROR the governing licence onto
the listing — trigger-maintained, and overwritten on the same statement if a client writes
them, which is stronger than an RLS pin and does not require re-declaring two long policies a
third migration would have to remember.

**The verdict is the strictest reading over the base model AND its ancestors**
(`public.license_governing`, the only definition of it; both triggers call it). "apache-2.0"
on a Llama fine-tune is a common and wrong model card, and #25's cascade writes whatever the
repo declares. `unknown` DEFERS rather than ranking, matching `strictest()` in
packages/hf-probe. The row that contributes the verdict is also the row whose text is
acknowledged, nearest first.

**The two halves do opposite jobs.** The CHECK RAISES when somebody asks for `public` on a
listing the gate does not allow — a request to refuse out loud. The trigger DEMOTES a listing
whose licence moved under it: an operator classifying weights as prohibited must succeed and
take the listing down with it, and raising there would leave it published. They are told apart
by whether the mirror moved on the statement.

**A held request completes by itself.** The creator's ask is recorded as
`license_public_requested_at`, and the listing publishes when an operator establishes terms
that allow it or the creator acknowledges them. `public.license_review_queue` is that column
plus an `unknown` verdict, service_role only, and reports how long each creator has waited —
countable, which is the difference between an unstaffed queue somebody can measure and one
nobody knows exists.

**The pipeline's row is born private** and `isPublic` became a request. Publication happens in
the same statement that writes `ready`, so a listing is never in the catalog without a
measured speed and never public without the acknowledgement the CHECK looks for on the same
row version. `evaluateLicenseGate` (`lib/studio/license.ts`, pure) decides one step early so
the creator gets a sentence instead of a constraint name, and the ack is CHECKED against the
resolved weights' own terms rather than trusted from the client.

**Reading implemented, of the two §7 allows:** `unknown` blocks the LISTING, not the deploy.
Forced by the issue's own table — a private deploy of `prohibited` weights is explicitly fine,
and `unknown` is weaker than `prohibited`. Under the other reading the CHECK gates
`status = 'ready'` instead of `visibility = 'public'` and the pipeline fails the deployment;
the mirror columns are already on the row before the insert, so it is a predicate edit and not
a schema change.

**The seeded base model is now `allowed` with no licence id.** `unknown` may not be `public`,
and MVP-0's acceptance test needs a caller who is not the creator. Naming a licence would
invent a fact about real weights (the recorded probe predates `?full=true` and has no
cardData), so the fixture records the operator review DECISION instead — a separate fact from
the id by the column's own definition.

**Not touched:** no money column, no settlement RPC, no existing invariant. "Prohibited never
accrues creator_earnings" follows from three facts that already hold — prohibited can never be
public, the gateway 404s a private listing for a non-owner, and self-dealing writes no row —
and section 9 of the new pgTAP file asserts the two that live in this schema.

pgTAP 289 -> 372. Node tests 390 -> 400. The pgTAP suite was RUN, not summed: see the note
added to docs/HANDOFF.md for how to do that without Docker.

The unstaffed review queue and the two counsel questions are recorded in docs/ROADMAP.md P3.
