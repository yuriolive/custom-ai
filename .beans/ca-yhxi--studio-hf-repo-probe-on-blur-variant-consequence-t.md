---
# ca-yhxi
title: 'Studio: HF repo probe on blur → variant consequence table'
status: todo
type: feature
priority: high
created_at: 2026-08-20T00:52:41Z
updated_at: 2026-08-20T00:52:41Z
parent: ca-4kkd
---

Creator pastes an HF repo; on blur, probe it and render one row per variant with
its **consequences**: quality, size, GPU class, tok/s, max context, cost floor.

Not a filename dropdown — a filename tells the creator nothing about what they are
choosing. `packages/hf-probe` already parses the GGUF header and classifies variants;
this is the UI over it.

FR-STU-001…005. Throughput shown must be measured over the decode window, never
predicted and never inclusive of time-to-first-token (folding TTFT in reports ~4 tok/s
for a worker that decodes at 45).
