---
# ca-zmam
title: 'Crypto rails: provider-agnostic ledger migration first'
status: todo
type: feature
priority: normal
created_at: 2026-08-20T00:52:42Z
updated_at: 2026-08-20T00:52:42Z
parent: ca-l5oz
---

Designed, not built — `docs/PAYMENTS.md`. The next step is the
provider-agnostic ledger migration, which lands **before** a second rail exists to need
it; retrofitting the ledger under a live second processor is the expensive order.

Money stays integer micro-USD across any rail. pgTAP under `supabase/tests/` is the
authority on the invariants, so this migration is incomplete until it touches them.
