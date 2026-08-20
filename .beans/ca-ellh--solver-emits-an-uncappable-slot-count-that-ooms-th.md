---
# ca-ellh
title: solver emits an uncappable slot count that OOMs the worker; catalogs disagree on it
status: completed
type: bug
priority: critical
created_at: 2026-08-20T03:31:37Z
updated_at: 2026-08-20T03:50:08Z
parent: ca-we5n
---

GitHub issue #37. The placement solver handed the Modal worker `parallel=91`; llama.cpp
multiplies `ctx_size * parallel` and allocates that KV eagerly at load, so the container
booted, asked for 46592 MiB of KV on one card, and died. Sibling of #36 (that one stops a
doomed container from billing; this one stops the doomed parameter set from being produced).

Ground truth from the production log: 46592 MiB / 745472 tokens = 65536 bytes/token, which
is EXACTLY what both catalogs compute for this geometry (2 x 16 attention blocks x 4 kv
heads x 256 key_length x 2 bytes). So `kv_bytes_per_token` was never wrong. What was wrong:

- nothing caps the slot count. `v_concurrent` is whatever the KV pool divides into.
- the cost floor divides by `tok_s * v_concurrent * util`, so a bigger slot count makes a
  tier look cheaper — the pricing math rewards inflating the number that is also `--parallel`.
- `overhead_bytes` is a flat max(2 GiB, 10% of weights): independent of slot count and of
  total context, while llama.cpp's compute buffers scale with both.
- the fit test is single-stream (`weights + one stream + overhead <= usable`); the aggregate
  the worker actually allocates was never asserted.
- the two catalogs already disagreed: SQL applied `prefix_cache_reserve = 0.15`, tools/modal/tiers.py
  applied no reserve at all, so Python returned ~17.6% more slots than the RPC that runs at
  request time.

## Todo

- [x] Cap the slot count: `max_slots_ceiling` in solver_config plus a hard sanity bound in code, both catalogs
- [x] Overhead that grows with total context and slot count, folded into a per-slot cost
- [x] Aggregate fit assertion: weights + overhead(total_ctx, slots) + slots * per_stream <= usable
- [x] Split `--parallel` from the cost floor's throughput multiplier (`batch_throughput_factor`)
- [x] Decide what the 15% prefix reserve means on a llama.cpp worker and name it consistently in both catalogs
- [x] Guard the callers in lib/studio/server/deploy.ts (:351 and the escalation retry at :401)
- [x] pgTAP: no placement whose aggregate allocation exceeds usable VRAM
- [x] Mirrored Python coverage in tools/modal/test_tier_drift.py



## Summary of Changes

`supabase/migrations/20260820000100_solver_slot_cap.sql` — resolve_placement v3, same
signature. The slot count is now `least(floor(allocatable / slot_cost), max_slots_ceiling)`
where `slot_cost = per_stream + slot_overhead_bytes + graph_bytes_per_ctx_token * ctx`, so one
more slot pays for its own compute buffers and the total-context term folds in without a fixed
point. The emitted placement is re-checked against usable VRAM (`aggregate_bytes`) and
rejected if it over-commits, and a migration-time DO block replays the #37 shape so the 91 can
never come back silently. `prefix_cache_reserve` is deleted and replaced by
`kv_headroom_reserve` at the same 0.15: llama.cpp has no prefix-cache pool, it reuses slot KV,
so the reserve was never buying caching — it was buying allocator slack, which is worth
keeping under its real name. The envelope gains `max_concurrent_streams_uncapped`,
`max_slots_ceiling`, `slot_cost_bytes`, `overhead_base_bytes`, `aggregate_bytes` and
`kv_headroom_bytes`; `overhead_bytes` now means overhead AT the emitted slot count, so
`weights + overhead + slots * bytes_per_stream = aggregate_bytes` holds for any reader.

The cost floor no longer divides by the slot count. It divides by
`least(slots, batch_throughput_factor)`, so more slots can never make a tier look cheaper.
This RAISES the floor substantially (the seeded MVP model goes from ~1.18 to ~10.04 USD per 1M
tokens on an L40S): the old figure assumed 34 streams each decoding at full single-stream
speed, which is roughly 8x the card's memory bandwidth.

`tools/modal/tiers.py` carries the same arithmetic and the same constants, plus
`SLOT_HARD_CAP = 32` mirroring `v_slot_hard_cap`. `deploy.py` rejects a `--parallel` override
outside 1..32 and prints the aggregate allocation against usable VRAM.

`lib/studio/server/deploy.ts` — the `Math.max(1, placement.maxConcurrentStreams)` clamp at
both call sites (the initial ref and the escalation retry) is replaced by `workerSlots()`,
which VERIFIES the envelope (slots >= 1, slots <= ceiling, aggregate <= usable) instead of
clamping a bad number upward. It derives nothing, so it is not a second solver.

Coverage: `supabase/tests/07_placement_capacity_test.sql` (26 assertions over a sweep of 6
shapes x every enabled tier) and `AggregateCapacityTest` in `tools/modal/test_tier_drift.py`,
which also compares the hard-cap literal across the two files. The drift reader learned
`delete from public.solver_config`, and its comment stripper is now string-aware — it used to
cut at the first `--` unconditionally, which silently dropped a config row whose description
contained `--parallel`.

Ground truth confirmed rather than assumed: 46592 MiB / 745472 tokens = 65536 bytes/token, and
2 x 16 attention blocks x 4 kv heads x 256 key_length x 2 bytes = 65536. `kv_bytes_per_token`
was right all along; the slot count was the whole bug. The migrations, the seed and the new
pgTAP file were replayed against a real Postgres 16 with pgTAP locally.

Deferred to its own bean: the Python SSM-state formula omits the conv state the SQL one
includes (~4.9% per stream).
