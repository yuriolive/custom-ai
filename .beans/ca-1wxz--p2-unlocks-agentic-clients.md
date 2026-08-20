---
# ca-1wxz
title: P2 — unlocks agentic clients
status: todo
type: milestone
priority: normal
created_at: 2026-08-20T00:52:40Z
updated_at: 2026-08-20T00:52:40Z
---

Tool calling shipped (FR-TOOL-001…006). What is left is the reliability half of
it and the Anthropic wire shape that Claude Code speaks.

Honest viability note from `docs/ROADMAP.md`: 14 tok/s measured. Agentic coding needs
tool calling **and** a fast tier (~149 tok/s predicted on H100) **and** always-warm.
That combination is a paid "agent tier", not a flag.
