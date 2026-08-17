-- ============================================================================
-- 20260817000200_enums.sql   (PRD §5.1)
-- ============================================================================

create type public.model_status as enum (
  'draft', 'validating', 'provisioning', 'smoke_testing',
  'ready', 'paused', 'failed', 'auth_failed', 'deleting', 'deleted'
);

create type public.model_visibility as enum ('public', 'private');

create type public.weights_format as enum ('gguf', 'safetensors', 'awq', 'gptq', 'unknown');

-- Inference runtime. DERIVED from weights_format (FR-DEP-060), never creator-selected.
-- The two are not interchangeable: different images, env contracts, KV mechanics, and
-- usage-reporting fidelity. A GGUF model on the vLLM image does not start.
create type public.model_runtime as enum ('vllm', 'llamacpp');

-- Role of a discovered .gguf file. ONLY 'model' is deployable (FR-DEP-041a).
-- 'draft' and 'mmproj' files carry standard quant tags in their filenames and are
-- offered as servable models by any classifier that matches on the tag alone.
create type public.gguf_role as enum ('model', 'draft', 'mmproj', 'lora', 'unknown');

create type public.txn_status as enum (
  'reserved',   -- hold open, stream in flight
  'settled',    -- billed against real token counts
  'voided',     -- released without charge (upstream failed before any token)
  'expired',    -- swept by the stale-hold reaper
  'failed'      -- terminal error; recorded for observability, not billed
);

create type public.ledger_kind as enum (
  'topup', 'grant', 'usage_debit', 'refund', 'chargeback', 'adjustment'
);
