---
# ca-dfil
title: Route a permanent worker load failure into custom_models and the stepper
status: todo
type: task
priority: normal
created_at: 2026-08-20T03:43:38Z
updated_at: 2026-08-20T03:43:38Z
parent: ca-l5oz
blocked_by:
    - ca-abmv
---

Issue #36 step 5, database half. The Modal worker now classifies a permanent llama-server load failure and stops the pool being cold-started (bean `ca-abmv`), but the reason never reaches the control plane: the model row stays `ready`, so the gateway still resolves it, and the creator sees nothing.

The blocker is a credential, not a schema — `custom_models` already carries `provisioning_error jsonb`, `remediation_hint` and `last_error_at`, and `model_status` already has `failed`. What is missing is a way for the worker to say so. A service-role key inside a container that executes creator-supplied GGUF weights is not it.

Options worth weighing, cheapest first:

- an ops job that tails `[serve] LOAD-FAILURE {json}` out of `modal app logs` and applies the status change from a trusted place;
- a narrow control-plane endpoint the worker can POST to with a purpose-scoped shared secret, no read access and no other mutation;
- have the Studio deploy path treat the classified codes as first-class, so the deploy-time case (which already runs with admin access, in `lib/studio/server/deploy.ts`) writes the same `provisioning_error.code` the worker would.

## Todo

- [ ] Pick the channel and write down why the other two lose
- [ ] A permanent load failure takes the row out of `ready` with `provisioning_error.code` set from the worker's classification
- [ ] The reason and its remediation hint render in the provisioning stepper (see `ca-wcvm`)
- [ ] A transient or unclassified failure changes no row
