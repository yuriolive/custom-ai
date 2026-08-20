---
# ca-wcvm
title: 'Studio: provisioning stepper with Realtime status and remediation hints'
status: todo
type: feature
priority: normal
created_at: 2026-08-20T00:52:41Z
updated_at: 2026-08-20T00:52:41Z
parent: ca-4kkd
---

Stepper over the deployment pipeline in `lib/studio/server/` (probe → ref →
smoke test), driven by Supabase Realtime, with per-failure remediation hints.

## Two facts the UI must not contradict
- On Modal a model is not a resource — it is a set of class parameters selecting an
  autoscaled pool on first request. Nothing is "created", so there is nothing to roll
  back. Do not offer a rollback affordance.
- Smoke tests call the upstream **directly**, never the gateway (the gateway needs a key
  and a `ready` model, so routing readiness through it is circular). No
  `usage_transactions` row exists for a smoke test and none should — the platform pays.
