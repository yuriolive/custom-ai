---
# ca-vuan
title: 'Studio: intent-only deployment inputs'
status: todo
type: feature
priority: high
created_at: 2026-08-20T00:52:41Z
updated_at: 2026-08-20T00:52:41Z
parent: ca-4kkd
---

Inputs are intent, not hardware: context window, minimum tok/s, quality. No GPU
selector — see the epic's constraint and PRD §4.3.3.3.

The GPU tier list is not a ladder: memory bandwidth sets decode speed and does not track
VRAM (the L40S has more VRAM than an A100-40GB and less bandwidth; the L4 and A10 have
equal VRAM and differ 2x in speed). Never render it as a menu.
