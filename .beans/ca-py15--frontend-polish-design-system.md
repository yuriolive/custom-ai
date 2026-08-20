---
# ca-py15
title: Frontend polish + design system
status: todo
type: epic
priority: high
created_at: 2026-08-20T00:52:41Z
updated_at: 2026-08-20T00:52:41Z
parent: ca-l5oz
blocked_by:
    - ca-4kkd
---

Currently functional and plain. Target: Modal's visual language (see
`docs/DESIGN.md`), with together.ai as a secondary reference.

Deliberately sequenced **after** Creator Studio so the new surfaces get the same
treatment in one pass instead of two.

## Constraints that already exist and must not be broken
- HeroUI v3 only — compound components, `onPress`, `Alert status=`, and
  `@heroui/react` is **client-only** (Server Component fetches, client renders)
- capability-only surfaces: no GPU names anywhere in the UI
- measured, never predicted, throughput on cards
- light **and** dark must both be correct; 375px must not overflow
