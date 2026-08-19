-- ============================================================================
-- 20260819000100_gpu_tiers_modal_catalog.sql
--
-- `public.gpu_tiers` was seeded with RunPod hardware and RunPod prices. The
-- platform runs on MODAL, and this table — not tools/modal/tiers.py — is what
-- executes at request time: public.resolve_placement() iterates it
-- `order by usd_per_hour_micro asc` and computes cost_floor_micro_per_mtoken
-- from the row it picks. Two consequences of the drift, both live:
--
--   * the solver could resolve `rtx4090`, hardware Modal does not rent at all,
--     so the placement was unprovisionable;
--   * every committed price was BELOW Modal's real rate (l40s $0.86 vs $1.95,
--     a100_80 $1.64 vs $2.50, h100 $2.99 vs $3.95), so the cost floor came out
--     up to ~2.3x too low and any price calibrated against it sold GPU time
--     under cost.
--
-- Prices here are Modal's published hourly rates (`modal billing rates --json`,
-- client 1.5.4), in exact integer micro-USD. tools/modal/sync_rates.py refreshes
-- both catalogs from that command; tools/modal/test_tier_drift.py fails CI if
-- this file and tiers.py disagree again.
-- ============================================================================

-- ── The provider column is no longer RunPod-shaped ──────────────────────────
-- `runpod_gpu_ids` held RunPod `saveEndpoint` gpuIds (plural: RunPod accepted a
-- fallback list). On Modal the only thing that matters is the single literal
-- passed to `@app.cls(gpu=...)` — `tiers.py:GpuTier.modal_gpu_string`. Renaming
-- rather than adding: `grep -rn runpod_gpu_ids` found no reader anywhere outside
-- this table's own DDL (resolve_placement does `select *` but touches only
-- vram_bytes, memory_bandwidth_bytes_s and usd_per_hour_micro), so there is no
-- code to break and no reason to carry a dead column. Kept provider-neutral, not
-- named `modal_gpu_string`, because §6.6 keeps the provisioning adapter swappable.
alter table public.gpu_tiers rename column runpod_gpu_ids to provider_gpu_id;
comment on column public.gpu_tiers.provider_gpu_id is
  'Provider hardware selector. On Modal: the exact literal for @app.cls(gpu=...).';

-- ── Retire the two ids that do not name Modal hardware ──────────────────────
-- DISABLED, not deleted. custom_models.gpu_tier_id is an FK onto this table and
-- custom_models.gpu_usd_per_hour_micro_snapshot exists precisely so historical
-- cost math stays reproducible (FR-DEP-051). A delete would either fail on the FK
-- or (worse, after a future cascade) strip the tier identity from settled rows and
-- make an audited placement unexplainable. is_enabled = false is enough: every
-- selection path in resolve_placement() filters on `where is_enabled`.
--
--   rtx4090  — consumer hardware; Modal does not offer it. Nothing can provision it.
--   h100_80  — same silicon as the new `h100` row, wrong id. tiers.py calls it
--              `h100` (matching Modal's own `gpu_hour_cost_h100`), and the id is
--              what the drift check compares, so the id has to converge. Its
--              price is deliberately left at the stale RunPod value: a disabled
--              row is never selected and never priced, and rewriting it would
--              imply this row is still a live tier.
update public.gpu_tiers set is_enabled = false where id in ('rtx4090', 'h100_80');

-- ── Modal's catalog, verbatim from tiers.py ─────────────────────────────────
-- Upsert rather than delete-and-insert so `l40s` / `a100_80` keep their identity
-- (and their inbound FKs) while their prices are corrected.
--
-- container_disk_gb and supports_* have no counterpart in tiers.py — they are
-- SQL-path-only provisioning hints, chosen here as:
--   * container_disk_gb scales with VRAM because the local disk has to hold the
--     downloaded GGUF, and a variant is only worth putting on a big card if it is
--     big: 60 GB up to 24 GB VRAM, 80 GB at 48, 120 GB at 80, 200 GB above that.
--     These are floors for the weight download, not measured requirements.
--   * supports_llamacpp is left to the column default (true) everywhere: llama.cpp's CUDA build covers sm75
--     (T4) through sm100 (B200), and llama.cpp is the only worker shipping today.
--   * supports_vllm is false for T4 alone. sm75 has no bf16, so vLLM runs there
--     only with fp16/AWQ weights and no bf16 checkpoint loads at all — claiming
--     support would let a future vLLM path resolve to a card that cannot serve it.
insert into public.gpu_tiers
  (id, label, vram_bytes, memory_bandwidth_bytes_s, provider_gpu_id,
   usd_per_hour_micro, container_disk_gb, supports_vllm, sort_order) values
  ('t4', 'T4 16GB', 17179869184, 320000000000, 'T4', 590000, 60, false, 10),
  ('l4', 'L4 24GB', 25769803776, 300000000000, 'L4', 800000, 60, true, 20),
  ('a10g', 'A10 24GB', 25769803776, 600000000000, 'A10', 1100000, 60, true, 30),
  ('l40s', 'L40S 48GB', 51539607552, 864000000000, 'L40S', 1950000, 80, true, 40),
  ('a100_40', 'A100 40GB', 42949672960, 1555000000000, 'A100-40GB', 2100000, 80, true, 50),
  ('a100_80', 'A100 80GB', 85899345920, 1935000000000, 'A100-80GB', 2500000, 120, true, 60),
  ('h100', 'H100 80GB', 85899345920, 3350000000000, 'H100', 3950000, 120, true, 70),
  ('h200', 'H200 141GB', 151397597184, 4800000000000, 'H200', 4540000, 200, true, 80),
  ('b200', 'B200 180GB', 193273528320, 8000000000000, 'B200', 6250000, 200, true, 90)
on conflict (id) do update set
  label                    = excluded.label,
  vram_bytes               = excluded.vram_bytes,
  memory_bandwidth_bytes_s = excluded.memory_bandwidth_bytes_s,
  provider_gpu_id          = excluded.provider_gpu_id,
  usd_per_hour_micro       = excluded.usd_per_hour_micro,
  container_disk_gb        = excluded.container_disk_gb,
  supports_vllm            = excluded.supports_vllm,
  is_enabled               = true,
  sort_order               = excluded.sort_order;
