---
# ca-jy33
title: 'gateway: wire the Realtime custom_models subscription so a takedown is instant'
status: todo
type: task
priority: normal
created_at: 2026-08-20T05:06:56Z
updated_at: 2026-08-20T05:06:56Z
blocked_by:
    - ca-zim3
---

FR-GW-054 specifies a Realtime subscription on `custom_models` that calls
`invalidateModelCache()` in the gateway. `invalidateModelCache` is exported and nothing
in `index.ts` calls it — only the tests do — and `custom_models` is not in the
`supabase_realtime` publication (20260818000400 added `profiles` only).

So the 60 s per-isolate LRU TTL in `resolve.ts` is the only invalidation there is. The
consequence predates #31: a creator flipping `visibility` to private keeps serving for up
to a minute on a warm isolate. #31 gave it a sharper edge — an operator takedown
(`suspended_at`) rides the same cached row, so a DMCA suspension is observable up to 60 s
late. That is the bound the issue asked for ("404s the same way a private model does") and
it is documented in the caching-boundary comment, but it is not the bound anyone wants for
a legal takedown.

- [ ] add `public.custom_models` to the `supabase_realtime` publication, guarded the same
      way 20260818000400 guards `profiles` (the publication may be absent)
- [ ] subscribe in the gateway and call `invalidateModelCache(handle, slug)` on UPDATE
- [ ] keep the TTL as the backstop for a dropped subscription — it is not the primary
      mechanism, and the comment in `resolve.ts` already says so
- [ ] a test that a suspension observed through Realtime evicts the row
