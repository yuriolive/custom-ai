---
# ca-2jl6
title: Persisted KV cache on a Modal Volume (§6.6 C2a)
status: todo
type: feature
priority: normal
created_at: 2026-08-20T00:52:42Z
updated_at: 2026-08-20T00:52:42Z
parent: ca-mun8
---

Prefill dominates cold cost: a 10k-token prefix runs ~75 s cold versus ~0.6 s
restored from a Volume. This may remove the always-warm requirement for the agent tier
entirely, which is why it sits upstream of the pricing decisions rather than beside them.

KV math uses the declared `key_length`, not `hidden_size / head_count`, and hybrid
attention/SSM models keep a KV cache only on their full-attention blocks. Getting either
wrong picks a GPU two tiers too big.
