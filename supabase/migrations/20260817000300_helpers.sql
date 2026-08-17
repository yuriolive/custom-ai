-- ============================================================================
-- 20260817000300_helpers.sql   (PRD §5.1)
-- ============================================================================

-- updated_at maintenance.
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Integer-exact token cost. numeric intermediate then CEIL: never floats.
-- Prices are micro-USD per 1,000,000 tokens; the result is micro-USD.
create or replace function public.calc_token_cost_micro(
  p_prompt_tokens      integer,
  p_completion_tokens  integer,
  p_price_prompt       bigint,   -- micro-USD per 1M tokens
  p_price_completion   bigint
) returns bigint
language sql immutable parallel safe as $$
  select greatest(
    1,  -- FR-BIL-004: minimum billable unit
      ceil(  (p_prompt_tokens::numeric     * p_price_prompt::numeric)     / 1000000 )::bigint
    + ceil(  (p_completion_tokens::numeric * p_price_completion::numeric) / 1000000 )::bigint
  );
$$;

comment on function public.calc_token_cost_micro(integer, integer, bigint, bigint) is
  'Pure integer money. numeric is used only as an intermediate before CEIL; no float '
  'type appears anywhere in the monetary path.';
