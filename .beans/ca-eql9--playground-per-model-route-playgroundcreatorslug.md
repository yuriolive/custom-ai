---
# ca-eql9
title: 'Playground: per-model route /playground/[creator]/[slug]'
status: todo
type: feature
priority: high
created_at: 2026-08-20T00:52:41Z
updated_at: 2026-08-20T00:52:41Z
parent: ca-l5oz
---

The Playground serves one hardcoded model. Correct with exactly one public model,
broken the moment a second exists — and the marketplace cards already link to the
per-model URL.

Model ids are `creator-handle/model-slug`, case-insensitive, and are **not** HF repo
paths. The seeded model happening to coincide with one is a coincidence, not an alias.
