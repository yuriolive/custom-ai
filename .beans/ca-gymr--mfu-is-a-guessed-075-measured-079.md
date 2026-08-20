---
# ca-gymr
title: MFU is a guessed 0.75 (measured ~0.79)
status: todo
type: task
priority: normal
created_at: 2026-08-20T00:52:42Z
updated_at: 2026-08-20T00:52:42Z
parent: ca-mun8
---

The MFU constant decides A10 vs L40S and therefore $0.85/hr. Tier selection
currently rests on a guess that the one measurement we have already contradicts.

There are **two** tier catalogs, and a constant that lands in only one of them silently
makes them disagree: `supabase/migrations` (`gpu_tiers` + `solver_config`) is what runs
at request time, `tools/modal/tiers.py` is what the deploy tooling and Python tests use.
