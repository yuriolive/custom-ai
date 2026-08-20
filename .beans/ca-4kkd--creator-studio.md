---
# ca-4kkd
title: Creator Studio
status: todo
type: epic
priority: high
created_at: 2026-08-20T00:52:40Z
updated_at: 2026-08-20T00:52:40Z
parent: ca-we5n
blocked_by:
    - ca-7c3n
---

The single biggest product gap. The infrastructure half is finished and unused:
the capacity solver (`resolve_placement` in `supabase/migrations`), variant
classification (`packages/hf-probe`), and the placement fields on `custom_models`.
The UI is the missing half. Blocked on nothing technical.

PRD §4.1.2, FR-STU-001…013.

## Hard constraint across every child
Capability-only surfaces. **No GPU names anywhere in the UI, and no GPU selector.**
Hardware is solved by `argmin(price)` over tiers meeting both the VRAM fit and the
throughput target; PRD §4.3.3.3 explains why a human cannot pick it correctly. Show
consequences (quality / size / tok-s / max ctx / cost floor), never hardware.
