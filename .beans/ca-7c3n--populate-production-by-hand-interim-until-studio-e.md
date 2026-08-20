---
# ca-7c3n
title: Populate production by hand (interim, until Studio exists)
status: todo
type: task
priority: critical
created_at: 2026-08-20T00:52:40Z
updated_at: 2026-08-20T00:52:40Z
parent: ca-we5n
blocked_by:
    - ca-1ihu
---

Models can only be added by SQL today, so production has no supply side. Do it
once by hand to prove the deployed stack bills a real request.

## Todo
- [ ] One creator profile
- [ ] The Qwen `custom_models` row pointed at the live Modal endpoint
- [ ] A funded caller wallet
- [ ] An API key minted against **production** with `tools/keygen` — never the committed
      fixture key (see the seed warning in `docs/DEPLOY.md`)
- [ ] Run the `docs/DEPLOY.md` §5 verification: one real billed request through the
      deployed stack, exactly one `usage_transactions` row, correct 80/20 split

## Trap
Wrong-length seed keys and the committed fixture key are the two ways this has silently
failed before. The acceptance test is the row, not the 200.
