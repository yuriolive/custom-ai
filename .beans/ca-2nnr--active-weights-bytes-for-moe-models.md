---
# ca-2nnr
title: active_weights_bytes for MoE models
status: todo
type: task
priority: low
created_at: 2026-08-20T00:52:43Z
updated_at: 2026-08-20T00:52:43Z
parent: ca-mun8
---

Correct for the current dense model. MoE needs the GGUF tensor-info section,
which sits outside the header range window the probe reads today — so this is a probe
change in `packages/hf-probe`, not a formula change.

Wrong here means the solver sizes hardware against total rather than active weights.
