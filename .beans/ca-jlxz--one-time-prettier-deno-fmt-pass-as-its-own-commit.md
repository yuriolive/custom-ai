---
# ca-jlxz
title: One-time prettier + deno fmt pass, as its own commit
status: todo
type: task
priority: low
created_at: 2026-08-20T00:52:43Z
updated_at: 2026-08-20T00:52:43Z
parent: ca-mun8
---

Both `format:check` steps are advisory and the repo has never been formatted.

Do it as a **single dedicated commit** so it buries nothing. Respect the ignore files:
`docs/` (prose), `tests/fixtures/` (read-only contract), `.beans/` (rewritten by the
beans CLI), other agents' trees, and `supabase/functions/` (which `deno fmt` owns).
