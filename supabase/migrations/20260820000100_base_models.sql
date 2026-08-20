-- ============================================================================
-- 20260820000100_base_models.sql
--
-- Phase 1 of the marketplace discovery plan (GitHub #24), and the only
-- irreversible step in it, which is why it lands alone and first.
--
-- ── The defect ──────────────────────────────────────────────────────────────
-- `custom_models` has no notion of WHICH MODEL a row is. A row is a DEPLOYMENT:
-- one creator, one repo, one quantization, one price. Nothing in the schema says
-- that six quantizations of Qwen3-8B are the same weights, so the catalog draws
-- six unrelated cards; the quality facet DELETES cards instead of picking a
-- variant within one; and two creators serving identical weights at different
-- prices render as two cards a shopper has to diff by eye.
--
-- `base_models` is the missing noun. A listing (`custom_models`) points at the
-- model it serves, and the catalog groups on that pointer.
--
-- ── What this is NOT ────────────────────────────────────────────────────────
-- It is NOT an addressing change. The platform model id stays
-- `creator-handle/model-slug` (CONTRACTS.md, top) and resolves through
-- `custom_models_resolve_idx`, which this migration does not touch.
-- `base_models` is unreachable from the gateway: `gateway_resolve` does not read
-- it, no RPC exposes it to the upstream path, and a base model on its own serves
-- nothing. It is a CATALOG concept.
--
-- ── §1.2, the rule that shapes the table ────────────────────────────────────
-- A fine-tune is its OWN base model with a `parent_id`, never a variant of the
-- model it was trained from. Any scheme that folds fine-tunes into their parent
-- presents `SomeLab/Qwen3-8B-Uncensored`'s output as `Qwen3-8B`'s — the
-- architecture fingerprint of a fine-tune is IDENTICAL to its parent's (same
-- layers, same heads, same vocab), so grouping on architecture cannot tell them
-- apart. That is also why the fingerprint columns below feed a SUGGESTION the
-- creator confirms (#25 cascade signals 3 and 4) and never an auto-link.
--
-- ── Why one file ────────────────────────────────────────────────────────────
-- The two halves depend on each other in opposite directions:
-- `custom_models.base_model_id` needs `base_models` to exist, and the
-- `base_models` visibility predicate reads `custom_models.suspended_at`. Split
-- across two migrations, either order leaves a database state where one half is
-- granted to `anon` without the policy that constrains it. One file, one
-- transaction, no such window.
-- ============================================================================

-- ── Licence posture (§5.1) ──────────────────────────────────────────────────
-- The question a marketplace has to answer is not "what licence is this" but
-- "may this be SERVED FOR MONEY BY A THIRD PARTY", and the answer is not a
-- function of the SPDX id alone: Llama's community licence permits commercial
-- hosting with conditions (attribution, the 700M-MAU clause), CC-BY-NC forbids
-- it outright, and `other` says nothing at all. Four states, because collapsing
-- `conditional` into `allowed` publishes a listing that needs a human to look at
-- it, and collapsing it into `prohibited` blocks Llama — the single most
-- deployed weight family on the Hub.
create type public.commercial_hosting as enum (
  'allowed',      -- permissive: MIT, Apache-2.0, and friends
  'conditional',  -- permitted with obligations a human must read (Llama, Gemma)
  'prohibited',   -- non-commercial or no-hosting (CC-BY-NC, research-only)
  'unknown'       -- unparsed, absent, or `other`. NEVER auto-publishes (#29)
);

-- ── pgvector (§4.2) ─────────────────────────────────────────────────────────
-- `embedding` needs the type to exist before the table. The normalization below
-- exists because the schema an earlier install chose is load-bearing here: the
-- column is declared `extensions.vector(384)` by qualified name (the same reason
-- `pg_trgm` lives in `extensions` — see 20260817000100), so a `vector` sitting
-- in `public` from a dashboard toggle would fail this file at the CREATE TABLE.
-- Relocating it is safe today and only today: nothing in this schema references
-- the type yet, which is precisely why the normalization belongs in the
-- migration that introduces the first reference.
do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'vector';

  if v_schema is null then
    create extension vector with schema extensions;
  elsif v_schema <> 'extensions' then
    raise notice 'relocating extension vector from % to extensions', v_schema;
    alter extension vector set schema extensions;
  end if;
end $$;

-- ── The embedding dimension, in ONE place ───────────────────────────────────
-- 384 is `gte-small`'s output width, and gte-small is chosen because
-- `Supabase.ai.Session('gte-small')` runs inside an Edge Function: no external
-- key, so no new secret in CONTRACTS.md §Environment. It is a property of the
-- MODEL, not of this table, and it otherwise appears in the query embedder, the
-- RPC signature, the column type and every fixture. Written five times it
-- becomes five things to change when the model changes; a swap is meant to be
-- one env var, a re-embed and a dimension bump.
--
-- SQL cannot take a column typmod from a function, so the literal appears twice:
-- here, and in the column type below. pgTAP pins them to each other
-- (07_base_models_test.sql), so they cannot drift silently.
create or replace function public.embedding_dimension()
returns integer
language sql immutable parallel safe
as $$ select 384 $$;

comment on function public.embedding_dimension() is
  'Width of public.base_models.embedding — gte-small''s output dimension. The '
  'single source of truth for every SQL consumer; pgTAP asserts the column type '
  'agrees with it. Changing the embedding model means changing this, the column '
  'type, and re-embedding every row.';

revoke all on function public.embedding_dimension() from public;
grant execute on function public.embedding_dimension() to anon, authenticated, service_role;

-- ── An immutable array flattener, for the generated tsvector below ──────────
-- `array_to_string(anyarray, text)` is marked STABLE, not IMMUTABLE, and a
-- generated column rejects anything less: the volatility is a property of
-- `anyarray`, whose element output function may depend on a GUC (rendering a
-- `timestamptz[]` reads TimeZone). Over `text[]` with a literal separator there
-- is no such dependency — text has no settings-sensitive output — so this
-- narrowing wrapper is immutable in fact, not merely by assertion.
--
-- Note the coupling: `base_models.search_vector` is GENERATED from this
-- function, so it cannot be dropped or have its signature changed without
-- dropping that column first.
create or replace function public.text_array_to_string(p_values text[], p_sep text)
returns text
language sql immutable parallel safe strict
as $$ select array_to_string(p_values, p_sep) $$;

comment on function public.text_array_to_string(text[], text) is
  'array_to_string narrowed to text[], which makes it genuinely IMMUTABLE and '
  'therefore usable in a GENERATED column. See 20260820000100 for why the '
  'built-in is only STABLE.';

revoke all on function public.text_array_to_string(text[], text) from public;
grant execute on function public.text_array_to_string(text[], text)
  to anon, authenticated, service_role;

-- ============================================================================
-- base_models
-- ============================================================================
create table public.base_models (
  id uuid primary key default gen_random_uuid(),

  -- ── Identity ──────────────────────────────────────────────────────────────
  -- Two lowercase segments, `publisher/name`, URL-addressable as
  -- /models/qwen/qwen3-8b. Two segments and not one because `qwen3-8b` alone is
  -- not unique across publishers (every lab ships an `-instruct`), and the
  -- publisher segment is also what §5.2's provenance line renders as "weights
  -- by …" — without it a creator who did nothing but run a deploy reads as the
  -- author of the weights.
  --
  -- This is NOT the Hugging Face repo path and NOT the addressable platform
  -- model id. The platform id is `creator-handle/model-slug` and lives on
  -- `custom_models` (CONTRACTS.md); this is the canonical name of the WEIGHTS,
  -- and several listings share one.
  slug text not null
    check (slug ~ '^[a-z0-9][a-z0-9._-]{0,62}/[a-z0-9][a-z0-9._-]{0,62}$'),
  display_name text not null check (char_length(display_name) between 1 and 100),
  summary text check (char_length(summary) <= 2000),
  -- Weight family, e.g. 'qwen3', 'llama-3.1'. Coarser than the slug: it groups
  -- sizes and fine-tunes for the facet rail, where the slug groups listings.
  family text check (family ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  -- Total parameters, exact where the config states it. bigint because a 405B
  -- model overflows int4 by two orders of magnitude.
  parameter_count bigint check (parameter_count > 0),

  -- ── §1.2: a fine-tune is its own model, with a parent ─────────────────────
  -- ON DELETE SET NULL rather than CASCADE: deleting `Qwen3-8B` must not delete
  -- every fine-tune of it, and a child that loses its parent is still a
  -- perfectly good model — it just loses one line of provenance.
  parent_id uuid references public.base_models(id) on delete set null,

  -- ── Architecture fingerprint (#25 cascade signal 3 — SUGGEST ONLY) ────────
  -- Every field here is already probed per listing (see `ModelArchitecture` in
  -- packages/shared/types.ts). Held again at model level so a new repo can be
  -- compared against known models without joining through a listing, and so a
  -- model with no listing yet still has a fingerprint.
  --
  -- A MATCH HERE IS NOT AN IDENTITY. It is necessary, never sufficient: a
  -- fine-tune matches its parent on every column. See the header.
  architecture text check (char_length(architecture) <= 100),  -- raw string, e.g. 'qwen35'
  n_layers integer check (n_layers > 0),
  n_attention_heads integer check (n_attention_heads > 0),
  n_kv_heads integer check (n_kv_heads > 0),          -- GQA count, NOT n_attention_heads
  head_dim integer check (head_dim > 0),              -- `key_length`, not hidden/heads
  hidden_size integer check (hidden_size > 0),
  full_attention_interval integer check (full_attention_interval > 0),
  max_position_embeddings integer check (max_position_embeddings > 0),

  -- ── Use cases (§4.1) — a CLOSED vocabulary ────────────────────────────────
  -- Closed because an open tag cloud degrades into synonyms
  -- (`coding`/`code`/`programming`) that split one facet three ways and make
  -- every count on the category tabs wrong. Enforced in the schema rather than
  -- in the writer: the tabs are counted server-side, so an unrecognised tag is
  -- not a cosmetic problem — it is a facet nobody can select and a count that
  -- does not add up.
  use_cases text[] not null default '{}',

  -- ── Hybrid retrieval, layer B (§4.2) ──────────────────────────────────────
  -- Embedded at DEPLOY time, per BASE MODEL, never per listing: six
  -- quantizations embedded six times cost six times as much and put six
  -- near-duplicate vectors in the top-k, crowding out every other model.
  -- NULL until embedded; the search RPC (#28) skips the vector arm for NULLs.
  embedding extensions.vector(384),

  -- ── Full-text arm of the same search (§4.3) ───────────────────────────────
  -- Same weighting discipline as `custom_models.search_vector`: name and slug
  -- are what a shopper types, the summary is corroboration.
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(display_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(slug, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(family, '')), 'B') ||
    -- coalesce even though use_cases is NOT NULL: text_array_to_string is STRICT,
    -- so a future migration that relaxed the NOT NULL would turn the whole
    -- concatenation NULL and silently drop the row out of every FTS result.
    setweight(to_tsvector('english',
      coalesce(public.text_array_to_string(use_cases, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'C')
  ) stored,

  -- ── Licence (§5.1) ────────────────────────────────────────────────────────
  -- A property of the WEIGHTS, which is why it lives here and not on the
  -- listing: a community re-quantization routinely carries `other` or omits the
  -- licence entirely, and a permissive string on a quant repo does not
  -- relicense the weights underneath it.
  license_id text check (char_length(license_id) <= 100),   -- 'apache-2.0', 'llama3.1'
  license_name text check (char_length(license_name) <= 200),
  license_url text check (char_length(license_url) <= 2000),
  -- The revision of the licence TEXT currently in force, where the licence has
  -- one. The Llama community licence has been revised more than once, and
  -- acknowledging the old text is not acknowledging the new one — so
  -- `custom_models.license_ack_version` is compared against THIS, which makes a
  -- stale ack distinguishable from a missing one (#29 owns that gate; this
  -- column is what it compares against).
  license_version text check (char_length(license_version) <= 100),
  commercial_hosting public.commercial_hosting not null default 'unknown',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint base_models_slug_uniq unique (slug),
  -- A model cannot be its own parent. Deeper cycles are not reachable through
  -- the writer (a parent is always an existing row, resolved before the child is
  -- inserted) and a recursive CHECK is not expressible, so this catches the one
  -- case a single statement can create.
  constraint base_models_parent_not_self check (parent_id is null or parent_id <> id),
  -- The closed vocabulary of §4.1. `<@` yields NULL — which a CHECK ACCEPTS —
  -- for an array holding a NULL element, so the null guard is not redundant.
  constraint base_models_use_cases_vocab check (
    array_position(use_cases, null) is null
    and use_cases <@ array[
      'code', 'reasoning', 'chat', 'roleplay', 'uncensored', 'multilingual',
      'vision', 'long-context', 'tool-use', 'math', 'embeddings', 'summarization'
    ]::text[]
  ),
  -- A licence url or version without an id is a fact about nothing.
  constraint base_models_license_url_needs_id
    check (license_url is null or license_id is not null),
  constraint base_models_license_version_needs_id
    check (license_version is null or license_id is not null)
);

comment on table public.base_models is
  'The MODEL a listing serves, as distinct from the listing itself. Many '
  'custom_models rows (quantizations, creators, prices) point at one row here, '
  'and the catalog groups on that pointer. NEVER reachable from the gateway: '
  'the addressable platform id is creator-handle/model-slug on custom_models.';

comment on column public.base_models.parent_id is
  'The model these weights were trained FROM. Set on a fine-tune, a merge or an '
  'adapter; NULL on an original. §1.2: a fine-tune is its own base model with a '
  'parent, never a variant of its parent — its output is not the parent''s.';

comment on column public.base_models.use_cases is
  'Closed vocabulary (§4.1), enforced by base_models_use_cases_vocab. This is '
  'the layer that improves discovery today: deterministic, indexable, cheap, '
  'and it works for the shopper who types nothing at all.';

comment on column public.base_models.embedding is
  'gte-small, 384 dims — see public.embedding_dimension(). Written once per '
  'base model at deploy time, never per listing.';

comment on column public.base_models.commercial_hosting is
  'Whether a THIRD PARTY may serve these weights for money. Not derivable from '
  'license_id alone, and `unknown` never auto-publishes.';

create trigger base_models_updated_at
  before update on public.base_models
  for each row execute function public.tg_set_updated_at();

-- ── Indexes ─────────────────────────────────────────────────────────────────
create index base_models_parent_idx on public.base_models (parent_id)
  where parent_id is not null;
create index base_models_family_idx on public.base_models (family)
  where family is not null;
-- Facet counts and the counted category tabs: `use_cases @> array['code']`.
create index base_models_use_cases_idx on public.base_models using gin (use_cases);
create index base_models_search_idx on public.base_models using gin (search_vector);
create index base_models_trgm_idx
  on public.base_models using gin (display_name extensions.gin_trgm_ops);
-- The suggest-only arm probes this shape; it is never a uniqueness constraint,
-- because a fine-tune legitimately shares every column of it with its parent.
create index base_models_fingerprint_idx
  on public.base_models (architecture, n_layers, n_kv_heads, head_dim, hidden_size)
  where architecture is not null;
-- HNSW over cosine, matching the distance the search RPC will use (#28). An
-- ivfflat index would need a representative sample to build its lists and the
-- table is empty; HNSW has no such warm-up and no `lists` to tune wrongly.
create index base_models_embedding_idx
  on public.base_models using hnsw (embedding extensions.vector_cosine_ops);

-- ============================================================================
-- custom_models: point a listing at the model it serves
-- ============================================================================
alter table public.custom_models
  -- The grouping pointer. ON DELETE SET NULL: an ungrouped listing still
  -- resolves and still bills — the gateway never reads this column — so losing
  -- the group must not take the listing down with it.
  add column base_model_id uuid references public.base_models(id) on delete set null,

  -- WHICH SIGNAL grouped this row, and whether a human confirmed it. Same
  -- rationale as `placement_rationale` (§2.1): a wrong grouping has to be
  -- explainable after the fact, and a re-resolution pass has to be able to find
  -- every row that was grouped on a weak signal. Shape (#25 owns the writer):
  --   {"signal":"card_data"|"gguf_header"|"fingerprint"|"name"|"manual",
  --    "relation":"quantized"|"finetune"|"merge"|"adapter"|null,
  --    "confidence":0..1, "confirmed_by":<uuid|null>, "at":<timestamptz>,
  --    "candidates":[…]}
  add column base_model_match jsonb,

  -- ── Licence acknowledgement (§5.1) ──────────────────────────────────────
  -- A VERSION, not a boolean: the Llama community licence has been revised, and
  -- acknowledging the old text is not acknowledging the new one. Compared
  -- against `base_models.license_version`, so a stale ack is distinguishable
  -- from a missing one.
  add column license_ack_at timestamptz,
  add column license_ack_version text check (char_length(license_ack_version) <= 100),

  -- ── Operator-only suspension (§5.5) ─────────────────────────────────────
  -- Deliberately NOT a `model_visibility` value and NOT a `model_status`.
  -- `visibility` sits inside the creator's own update policy
  -- (`custom_models_update_own`), so a licence complaint, a DMCA notice or an
  -- acceptable-use violation expressed as a visibility flip is a takedown the
  -- offender can undo. `status` is the provisioning state machine, written by
  -- the deploy pipeline, which would clobber a suspension on the next status
  -- write. A separate column, pinned out of every client policy, is the only
  -- shape a creator cannot reach.
  --
  -- `profiles.is_suspended` already exists and is honoured by `creator_public`,
  -- but a whole-account suspension is too blunt for one bad listing.
  add column suspended_at timestamptz,
  add column suspension_reason text check (char_length(suspension_reason) <= 2000),

  -- An ack half-written is not an ack: the gate reads both halves, and a
  -- timestamp with no version cannot be compared against anything.
  add constraint custom_models_license_ack_complete
    check ((license_ack_at is null) = (license_ack_version is null)),
  -- A suspension nobody can explain is a support ticket with no answer. The
  -- operator surface (#31) collects the reason; the schema insists on it.
  add constraint custom_models_suspension_needs_reason
    check ((suspended_at is null) = (suspension_reason is null));

comment on column public.custom_models.base_model_id is
  'The base model these weights ARE. Catalog grouping only — the gateway never '
  'reads it, and the addressable platform id remains creator-handle/model-slug. '
  'Platform-resolved (#25 cascade), pinned out of both creator RLS policies.';

comment on column public.custom_models.base_model_match is
  'Why this row is grouped where it is: the signal that fired, its confidence, '
  'and who confirmed it. The audit trail that makes a wrong grouping '
  'explainable and a weak-signal re-resolution pass possible.';

comment on column public.custom_models.license_ack_version is
  'The licence REVISION the creator acknowledged, compared against '
  'base_models.license_version. A version rather than a boolean because the '
  'Llama licence has been revised and acknowledging the old text is not '
  'acknowledging the new one. Platform-written: it is a record the platform '
  'makes of what was shown, not a claim the creator supplies.';

comment on column public.custom_models.suspended_at is
  'Operator-only per-listing takedown (§5.5). NOT a visibility value and NOT a '
  'status, because both are writable by the creator or by the deploy pipeline — '
  'a suspension the offender can clear is not a suspension. Pinned out of '
  'custom_models_insert_own and custom_models_update_own.';

-- ── The duplicate-listing constraint ────────────────────────────────────────
-- One creator, one repo, one revision, one variant = ONE listing. Without this
-- the same deploy submitted twice yields two identical cards at two prices, and
-- grouping by base model then renders "2 listings" for what is one deployment.
--
-- `coalesce` on both nullable variant columns is load-bearing: NULL means "the
-- native/base family", and in a unique index NULLs are DISTINCT from each other,
-- so the two rows the constraint most needs to catch — a repo with no quant tag
-- deployed twice — are exactly the two it would miss.
--
-- Partial on `deleted_at is null` so a soft-deleted listing does not block a
-- re-deploy of the same variant. `hf_revision` is NOT NULL DEFAULT 'main' and
-- needs no coalesce.
create unique index if not exists custom_models_variant_uniq
  on public.custom_models (user_id, hf_repo_slug, hf_revision,
                           coalesce(variant_quant_tag, ''),
                           coalesce(variant_family, ''))
  where deleted_at is null;

-- Grouped-catalog lookup and the visibility oracle below.
create index custom_models_base_model_idx
  on public.custom_models (base_model_id)
  where base_model_id is not null and deleted_at is null;

-- ============================================================================
-- base_models visibility
--
-- A base model is visible when SOMETHING SERVES IT publicly. Without that
-- predicate the table is a directory of every model anyone ever deployed,
-- including the private ones: a creator who privately deploys their own
-- fine-tune gets a `base_models` row named after it, and an unconditional
-- SELECT policy publishes that name to the anonymous internet — exactly what
-- `custom_models_select_public` exists to prevent, reintroduced one table over.
--
-- ── Why a SECURITY DEFINER function and not an inline EXISTS ───────────────
-- The predicate has to reach `parent_id`, because a parent model legitimately
-- has no listings of its own — `Qwen3-8B` may be served only through fine-tunes,
-- and §5.2's provenance line still has to name it. Reading `base_models` from
-- inside a `base_models` policy raises `infinite recursion detected in policy
-- for relation "base_models"`, so the lookup moves into a definer function,
-- which is not subject to the policy that calls it.
--
-- The function is a boolean oracle over an id the caller already holds. It
-- returns nothing about the row and cannot be used to enumerate anything.
--
-- Cost: one function call per candidate row, and it cannot inline. That is
-- correct at today's catalog size and is the reason #26's grouped-catalog query
-- is specified as a single server-side RPC rather than a client-side join.
-- ============================================================================
create or replace function public.base_model_visible_to(
  p_base_model_id uuid,
  p_viewer        uuid
) returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.custom_models m
      left join public.base_models b on b.id = m.base_model_id
     where (m.base_model_id = p_base_model_id or b.parent_id = p_base_model_id)
       and m.deleted_at is null
       and (
         -- Served to the public: the catalog case.
         (m.visibility = 'public' and m.status = 'ready' and m.suspended_at is null)
         -- Or the viewer's own listing, in any status: the Studio case, where a
         -- creator has to see the model their draft resolved to.
         or (p_viewer is not null and m.user_id = p_viewer)
       )
  );
$$;

comment on function public.base_model_visible_to(uuid, uuid) is
  'True when p_base_model_id is served by a public+ready+unsuspended listing, or '
  'by any listing belonging to p_viewer. SECURITY DEFINER because the predicate '
  'reads base_models.parent_id, and reading base_models from inside a '
  'base_models policy is infinite RLS recursion. Boolean only — it reveals '
  'nothing about the row and cannot enumerate.';

revoke all on function public.base_model_visible_to(uuid, uuid) from public;
grant execute on function public.base_model_visible_to(uuid, uuid)
  to anon, authenticated, service_role;

-- ── RLS: base_models ────────────────────────────────────────────────────────
alter table public.base_models enable row level security;

-- Same shape as custom_models: a public policy for the catalog, an owner policy
-- for the Studio. Permissive policies OR together, so a creator sees both.
create policy base_models_select_public on public.base_models
  for select to anon, authenticated
  using (public.base_model_visible_to(id, null));

create policy base_models_select_own_listing on public.base_models
  for select to authenticated
  using (public.base_model_visible_to(id, auth.uid()));

-- NO client INSERT/UPDATE/DELETE policy, deliberately. Every column here is
-- platform output — the resolution cascade (#25), the licence parse (§5.1), the
-- embedder (§4.2) — and a creator who could write `display_name` or
-- `commercial_hosting` could rename someone else's model, or relicense weights
-- they merely re-quantized. service_role holds BYPASSRLS and writes all of it.

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Nothing is auto-exposed since CLI 2.10 / the current cloud default, so RLS
-- would be irrelevant here without these: the table grant fails first. See
-- 20260817001600.
--
-- SELECT is table-wide, which includes `embedding` and `search_vector`. Neither
-- is a secret — both are derived from text this table already publishes — but a
-- 384-float vector per row is a payload nobody asked for, so the catalog query
-- must PROJECT rather than `select *`. That is the rule already at the head of
-- components/marketplace/queries.ts, and it applies here for size as well as
-- for security.
grant select on public.base_models to anon, authenticated;
grant select, insert, update, delete on public.base_models to service_role;

-- ============================================================================
-- RLS: custom_models — pin the six new columns
--
-- All six are PLATFORM output, and `custom_models` is directly INSERT-able and
-- UPDATE-able by its owner from the browser (CONTRACTS.md §Frontend), so a pin
-- is the only thing standing between a creator and each of them:
--
--   base_model_id / base_model_match  a creator who could write these could
--                                     attach their listing to any model in the
--                                     catalog — including a well-known one they
--                                     do not serve — and inherit its traffic.
--   license_ack_*                     an ack the creator can write freely is not
--                                     a record of what they were shown.
--   suspended_at / suspension_reason   THE ENTIRE POINT of §5.5. A takedown the
--                                     offender can clear is not a takedown.
--
-- Both policies are otherwise BYTE-IDENTICAL to their definitions in
-- 20260819000300_tool_calling.sql, which is the current definition of record.
-- ============================================================================
drop policy if exists custom_models_insert_own on public.custom_models;

create policy custom_models_insert_own on public.custom_models
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status in ('draft', 'validating')
    and upstream_endpoint_ref is null
    and runpod_template_id is null
    and runpod_workers_min = 0
    and runpod_idle_timeout = 30
    -- Solver output columns must be empty on creator insert.
    and gpu_tier_id is null
    and measured_tokens_per_second is null
    and max_concurrent_streams is null
    and placement_rationale is null
    -- Measured at provisioning by the service role, never asserted by a creator.
    and supports_tools is null
    -- Resolved by the cascade, recorded by the platform, held by the operator.
    and base_model_id is null
    and base_model_match is null
    and license_ack_at is null
    and license_ack_version is null
    and suspended_at is null
    and suspension_reason is null
  );

drop policy if exists custom_models_update_own on public.custom_models;

create policy custom_models_update_own on public.custom_models
  for update to authenticated
  using (user_id = auth.uid() and deleted_at is null)
  with check (
    user_id = auth.uid()
    and slug               = (select m.slug               from public.custom_models m where m.id = custom_models.id)
    and hf_repo_slug       = (select m.hf_repo_slug       from public.custom_models m where m.id = custom_models.id)
    -- `is not distinct from` on the nullable columns: `=` yields NULL, i.e. a
    -- WITH CHECK failure, for every pre-provisioning draft. See 20260817000700.
    and gpu_tier_id        is not distinct from
                             (select m.gpu_tier_id        from public.custom_models m where m.id = custom_models.id)
    and upstream_endpoint_ref is not distinct from
                             (select m.upstream_endpoint_ref from public.custom_models m where m.id = custom_models.id)
    and hf_token_secret_id is not distinct from
                             (select m.hf_token_secret_id from public.custom_models m where m.id = custom_models.id)
    and supports_tools     is not distinct from
                             (select m.supports_tools     from public.custom_models m where m.id = custom_models.id)
    and base_model_id      is not distinct from
                             (select m.base_model_id      from public.custom_models m where m.id = custom_models.id)
    and base_model_match   is not distinct from
                             (select m.base_model_match   from public.custom_models m where m.id = custom_models.id)
    and license_ack_at     is not distinct from
                             (select m.license_ack_at     from public.custom_models m where m.id = custom_models.id)
    and license_ack_version is not distinct from
                             (select m.license_ack_version from public.custom_models m where m.id = custom_models.id)
    and suspended_at       is not distinct from
                             (select m.suspended_at       from public.custom_models m where m.id = custom_models.id)
    and suspension_reason  is not distinct from
                             (select m.suspension_reason  from public.custom_models m where m.id = custom_models.id)
    and total_requests     = (select m.total_requests     from public.custom_models m where m.id = custom_models.id)
    and platform_fee_bps   = (select m.platform_fee_bps   from public.custom_models m where m.id = custom_models.id)
    and runpod_workers_min = 0
  );

-- ── A suspended listing leaves the public catalog immediately ───────────────
-- Shipping `suspended_at` without this would ship a column that does nothing:
-- the operator sets it and the listing keeps rendering. RLS is the right layer
-- because it covers every reader of the table at once — the catalog, the model
-- page, the sitemap — instead of one query at a time.
--
-- The GATEWAY is deliberately NOT covered here and still serves a suspended
-- listing: `gateway_resolve` is SECURITY DEFINER and bypasses RLS by design (it
-- returns raw facts and lets the Edge Function map them to status codes), so
-- stopping the stream means adding a fact to that envelope and a branch in the
-- gateway. That is #31's scope, and this issue is explicitly forbidden from
-- touching the resolve path. Nothing regresses in the meantime: no operator
-- surface writes this column yet, so it is NULL on every row.
--
-- Otherwise byte-identical to its definition in 20260817000700.
drop policy if exists custom_models_select_public on public.custom_models;

create policy custom_models_select_public on public.custom_models
  for select to anon, authenticated
  using (visibility = 'public' and status = 'ready' and deleted_at is null
         and suspended_at is null);
