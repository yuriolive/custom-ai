-- ============================================================================
-- 20260817000600_gpu_tiers.sql   (PRD §5.4 — INTERNAL capability catalog: FR-DEP-055)
--
-- This table is solver input, NOT a creator-facing menu. It is readable by
-- authenticated users only so the Studio can render the resolved result; it is
-- never presented as a set of options to choose between.
-- ============================================================================
create table public.gpu_tiers (
  id                    text primary key,               -- 'rtx4090', 'l40s', 'h100_80'
  label                 text not null,
  vram_bytes            bigint not null check (vram_bytes > 0),
  -- Memory bandwidth drives single-stream decode throughput. NOTE: this is NOT
  -- monotonic with VRAM — the L40S has 2x the memory of a 4090 but LESS bandwidth,
  -- so a "bigger" tier can be slower. Precisely why creators must not pick tiers.
  memory_bandwidth_bytes_s bigint not null check (memory_bandwidth_bytes_s > 0),
  runpod_gpu_ids        text not null,                  -- RunPod saveEndpoint gpuIds
  usd_per_hour_micro    bigint not null check (usd_per_hour_micro > 0),
  container_disk_gb     integer not null default 60,
  supports_vllm         boolean not null default true,
  supports_llamacpp     boolean not null default true,
  is_enabled            boolean not null default true,
  sort_order            integer not null default 0
);

insert into public.gpu_tiers
  (id, label, vram_bytes, memory_bandwidth_bytes_s, runpod_gpu_ids,
   usd_per_hour_micro, container_disk_gb, sort_order) values
  ('rtx4090', 'RTX 4090 24GB', 25769803776,  1008000000000, 'NVIDIA GeForce RTX 4090',  440000,  60, 10),
  ('l40s',    'L40S 48GB',     51539607552,   864000000000, 'NVIDIA L40S',              860000,  80, 20),
  ('a100_80', 'A100 80GB',     85899345920,  1935000000000, 'NVIDIA A100 80GB PCIe',   1640000, 120, 30),
  ('h100_80', 'H100 80GB',     85899345920,  3350000000000, 'NVIDIA H100 80GB HBM3',   2990000, 120, 40);

alter table public.gpu_tiers enable row level security;
-- Authenticated only: anon has no reason to enumerate platform hardware.
create policy gpu_tiers_read_authed on public.gpu_tiers
  for select to authenticated using (is_enabled = true);

-- Solver constants, recalibrated from production measurements (FR-DEP-058).
create table public.solver_config (
  key         text primary key,
  value       numeric not null,
  description text
);
insert into public.solver_config (key, value, description) values
  ('mfu',                  0.75, 'Achieved fraction of theoretical memory bandwidth'),
  ('vram_utilization',     0.92, 'GPU_MEMORY_UTILIZATION passed to the worker'),
  ('assumed_utilization',  0.35, 'Assumed endpoint saturation used in cost-floor math'),
  ('speed_tolerance',      0.90, 'Fraction of target tok/s accepted as meeting target'),
  -- Without a reserved pool, KV is fully consumed by active sequences and every
  -- cached prefix is evicted on arrival — APC silently does nothing (NFR-CACHE-021).
  ('prefix_cache_reserve', 0.15, 'Fraction of the KV region held for prefix caching'),
  ('volume_threshold_bytes', 21474836480, 'Variants above this get a network volume'),
  ('download_bytes_per_s', 314572800, 'Assumed HF->RunPod throughput for cold-start budget');

alter table public.solver_config enable row level security;
create policy solver_config_read on public.solver_config
  for select to authenticated using (true);
