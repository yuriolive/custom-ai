---
# ca-sn5u
title: Supabase Branching to keep the service-role key out of previews
status: todo
type: task
priority: low
created_at: 2026-08-20T00:52:42Z
updated_at: 2026-08-20T00:52:42Z
parent: ca-mun8
---

Preview environments currently carry the production service-role key. Branching
removes it.

Threshold for doing it: the first real user. Before that, the exposure is the operator's
own data.
