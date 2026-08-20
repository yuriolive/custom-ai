---
# ca-q6af
title: 'FR-TOOL-007: grammar-constrained decoding (GBNF)'
status: todo
type: feature
priority: normal
created_at: 2026-08-20T00:52:42Z
updated_at: 2026-08-20T00:52:42Z
parent: ca-1wxz
---

Tool calling ships (FR-TOOL-001…006): the gateway forwards
`tools`/`tool_choice`/`functions`/`function_call`, the non-streaming assembler rebuilds
`tool_calls[]` from fragments, and the usage estimator counts tool arguments. What is
open is reliability for models whose chat template renders tools but whose JSON is not
trustworthy — constrain decoding with a GBNF grammar.

## Two established traps
- llama.cpp needs `--jinja` so the model's own chat template drives tool formatting.
  Without it the server ignores `tools` and returns prose that *looks* like a tool call,
  which parses as success. `tools/modal/app.py` passes it and says why.
- `custom_models.supports_tools` is THREE-state. A measured `false` gets a 400; `null`
  ("template unreadable", which every pre-existing row carries) is forwarded. Rows
  provisioned before the measurement cannot be backfilled from SQL — the answer lives
  inside a GGUF file on the Hub — so re-deploying a model is what populates it.
