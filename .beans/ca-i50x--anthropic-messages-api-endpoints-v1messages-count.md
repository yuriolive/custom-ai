---
# ca-i50x
title: Anthropic Messages API endpoints (/v1/messages, count_tokens)
status: todo
type: feature
priority: normal
created_at: 2026-08-20T00:52:42Z
updated_at: 2026-08-20T00:52:42Z
parent: ca-1wxz
---

`packages/anthropic-adapter` is already built and tested (53 tests) and
currently unused. Tool calling was the hard prerequisite and is done, so the adapter's
`translateTools` / `translateToolChoice` emit exactly the shapes the gateway now
accepts (`auto` / `required` / `none` / `{type:"function"}`).

## Todo
- [ ] `/v1/messages` route over the existing gateway
- [ ] `x-api-key` auth (Anthropic header, not `Authorization: Bearer`)
- [ ] `POST /v1/messages/count_tokens` — Claude Code calls it and fails before sending a
      single completion if it is missing

PRD §4.5. Token counts include `reasoning_content`, not just `content`.
