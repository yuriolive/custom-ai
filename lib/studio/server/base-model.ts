import "server-only";

/**
 * The base-model resolution cascade, at deploy time — issue #25, §2.
 *
 * `custom_models` says what was DEPLOYED; `base_models` says what it IS. This
 * module is the only writer of the pointer between them, and the only place
 * allowed to decide that two listings serve the same weights.
 *
 * The rule it enforces is `resolveBaseModelIdentity`'s (packages/hf-probe): a
 * row is auto-linked ONLY on a signal the repository declares — its card data
 * or its GGUF header. An architecture fingerprint and a normalized name are
 * shown to the creator to confirm and never applied on their own, because a
 * fine-tune matches its parent on every one of those and grouping on them
 * serves `SomeLab/Qwen3-8B-Uncensored`'s output under `Qwen3-8B`'s name.
 *
 * NOTHING HERE MAY FAIL A DEPLOYMENT. The gateway never reads `base_model_id`
 * (CONTRACTS.md: the addressable id stays `creator-handle/model-slug`), so an
 * ungrouped listing still resolves, still streams and still bills. Every path
 * below therefore degrades to `{baseModelId: null}` and a recorded reason
 * rather than throwing — which also means an unresolved base model carries no
 * licence, and an unknown licence is what the publish gate (#29) reads.
 */

import {
  baseModelSlugFromRepo,
  getModelInfo,
  licenseFromCardData,
  nameTokens,
  resolveBaseModelIdentity,
  scoreCandidates,
  type BaseModelCandidate,
  type BaseModelIdentity,
  type DeclaredBaseModel,
  type Fingerprint,
  type RepoLicense,
} from "@nexus/hf-probe";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  BaseModelChoice,
  BaseModelMatch,
  BaseModelSuggestion,
  StudioArchitecture,
} from "../types";

/** The columns `base_models` compares a repo against. */
const CANDIDATE_COLUMNS =
  "id, slug, display_name, architecture, n_layers, n_attention_heads, n_kv_heads, head_dim, hidden_size";

/** Rows scanned per arm of the candidate search. Both arms are indexed. */
const CANDIDATE_LIMIT = 100;

export function fingerprintOf(architecture: StudioArchitecture | null): Fingerprint | null {
  if (!architecture) return null;
  return {
    architecture: architecture.architecture,
    nLayers: architecture.nLayers,
    nAttentionHeads: architecture.nAttentionHeads,
    nKvHeads: architecture.nKvHeads,
    headDim: architecture.headDim,
    hiddenSize: architecture.hiddenSize,
  };
}

interface CandidateRow {
  id: string;
  slug: string;
  display_name: string;
  architecture: string | null;
  n_layers: number | null;
  n_attention_heads: number | null;
  n_kv_heads: number | null;
  head_dim: number | null;
  hidden_size: number | null;
}

function toCandidate(row: CandidateRow): BaseModelCandidate {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    fingerprint: {
      architecture: row.architecture,
      nLayers: row.n_layers,
      nAttentionHeads: row.n_attention_heads,
      nKvHeads: row.n_kv_heads,
      headDim: row.head_dim,
      hiddenSize: row.hidden_size,
    },
  };
}

/**
 * Existing base models worth comparing against, over two arms.
 *
 * Two queries rather than one `or(...)`: PostgREST's filter grammar is
 * comma-separated, so a repo name containing a comma or a parenthesis inside an
 * `or()` changes which rows come back. Each arm here binds its value as a
 * single filter, and the name arm is reduced to one `[a-z0-9.-]` token first.
 *
 * `client` may be the caller's session client — `base_models` is readable only
 * for models served by a public, ready, unsuspended listing (migration
 * 20260820000100), so a creator is offered models that already exist publicly
 * and never learns about somebody's private fine-tune.
 */
export async function loadCandidates(
  client: SupabaseClient,
  args: { repoSlug: string; fingerprint: Fingerprint | null },
): Promise<BaseModelCandidate[]> {
  const arch = args.fingerprint?.architecture ?? null;
  const nameToken = nameTokens(args.repoSlug.slice(args.repoSlug.indexOf("/") + 1))[0] ?? null;
  const safeToken = nameToken ? nameToken.replace(/[^a-z0-9.-]/g, "") : "";

  const queries: PromiseLike<{ data: CandidateRow[] | null }>[] = [];
  if (arch) {
    queries.push(
      client
        .from("base_models")
        .select(CANDIDATE_COLUMNS)
        .eq("architecture", arch)
        .limit(CANDIDATE_LIMIT)
        .returns<CandidateRow[]>(),
    );
  }
  if (safeToken.length >= 2) {
    queries.push(
      client
        .from("base_models")
        .select(CANDIDATE_COLUMNS)
        .ilike("slug", `%${safeToken}%`)
        .limit(CANDIDATE_LIMIT)
        .returns<CandidateRow[]>(),
    );
  }
  if (queries.length === 0) return [];

  const results = await Promise.all(queries);
  const byId = new Map<string, BaseModelCandidate>();
  for (const result of results) {
    for (const row of result.data ?? []) byId.set(row.id, toCandidate(row));
  }
  return [...byId.values()];
}

/**
 * The confirm step's options: what this repo might be, ranked.
 *
 * Only ever called when the repository declared nothing — a declared parent is
 * an answer, and asking a creator to confirm an answer trains them to click
 * past it. Never throws: no suggestions is a supported outcome.
 */
export async function suggestBaseModels(
  client: SupabaseClient,
  args: { repoSlug: string; architecture: StudioArchitecture | null },
): Promise<BaseModelSuggestion[]> {
  const fingerprint = fingerprintOf(args.architecture);
  try {
    const candidates = await loadCandidates(client, { repoSlug: args.repoSlug, fingerprint });
    return scoreCandidates({ repoSlug: args.repoSlug, fingerprint }, candidates).map((c) => ({
      baseModelId: c.id,
      slug: c.slug,
      displayName: c.displayName,
      confidence: c.confidence,
      matchedOn: c.matchedOn,
      relationHint: c.relationHint,
    }));
  } catch (cause) {
    console.error(
      "[studio] base-model suggestions failed:",
      cause instanceof Error ? cause.message : cause,
    );
    return [];
  }
}

// ─── writing the rows ───────────────────────────────────────────────────────

interface BaseModelSpec {
  slug: string;
  displayName: string;
  family: string | null;
  parameterCount: number | null;
  license: RepoLicense | null;
  fingerprint: Fingerprint | null;
  maxPositionEmbeddings: number | null;
  fullAttentionInterval: number | null;
  parentId: string | null;
}

/** `base_models.family`'s CHECK: one lowercase segment. */
function familyFromRepo(repoSlug: string): string | null {
  const token = nameTokens(repoSlug.slice(repoSlug.indexOf("/") + 1))[0] ?? "";
  const family = token.replace(/[^a-z0-9._-]/g, "").slice(0, 63);
  return /^[a-z0-9]/.test(family) ? family : null;
}

/** The repo's own name, which is what every model card calls the weights. */
function displayNameFromRepo(repoSlug: string): string {
  const name = repoSlug.slice(repoSlug.indexOf("/") + 1).trim();
  return (name.length > 0 ? name : repoSlug).slice(0, 100);
}

/**
 * Find or create the row for one model.
 *
 * An existing row is only ever FILLED IN, never overwritten: the first deploy
 * that resolved a model may have read a better card than this one, and a
 * community re-quantization that says `other` must not be able to blank a
 * licence somebody else established. The one exception is `parent_id`, which is
 * set when it was null and left alone otherwise — the same reasoning.
 */
async function ensureBaseModel(admin: SupabaseClient, spec: BaseModelSpec): Promise<string | null> {
  const existing = await admin
    .from("base_models")
    .select("id, license_id, commercial_hosting, architecture, parent_id, parameter_count")
    .eq("slug", spec.slug)
    .maybeSingle();

  if (existing.data) {
    const row = existing.data as {
      id: string;
      license_id: string | null;
      commercial_hosting: string;
      architecture: string | null;
      parent_id: string | null;
      parameter_count: number | null;
    };
    const patch: Record<string, unknown> = {};
    if (row.license_id === null && spec.license?.id) {
      patch.license_id = spec.license.id;
      patch.license_name = spec.license.name;
      patch.license_url = spec.license.url;
    }
    if (row.commercial_hosting === "unknown" && spec.license?.commercialHosting) {
      patch.commercial_hosting = spec.license.commercialHosting;
    }
    if (row.architecture === null && spec.fingerprint?.architecture) {
      Object.assign(patch, fingerprintColumns(spec));
    }
    if (row.parent_id === null && spec.parentId && spec.parentId !== row.id) {
      patch.parent_id = spec.parentId;
    }
    if (row.parameter_count === null && spec.parameterCount) {
      patch.parameter_count = spec.parameterCount;
    }
    if (Object.keys(patch).length > 0) {
      const { error } = await admin.from("base_models").update(patch).eq("id", row.id);
      if (error)
        console.error(`[studio] base_models patch failed for ${spec.slug}:`, error.message);
    }
    return row.id;
  }

  const insert = await admin
    .from("base_models")
    .insert({
      slug: spec.slug,
      display_name: spec.displayName,
      family: spec.family,
      parameter_count: spec.parameterCount,
      parent_id: spec.parentId,
      license_id: spec.license?.id ?? null,
      license_name: spec.license?.id ? spec.license.name : null,
      license_url: spec.license?.id ? spec.license.url : null,
      commercial_hosting: spec.license?.commercialHosting ?? "unknown",
      ...fingerprintColumns(spec),
    })
    .select("id")
    .maybeSingle();

  if (insert.data) return (insert.data as { id: string }).id;

  // 23505: a concurrent deploy of a sibling quantization created the same row
  // between the select and the insert. That is the expected race — the second
  // writer wants the first writer's id, not an error.
  if (insert.error?.code === "23505") {
    const retry = await admin.from("base_models").select("id").eq("slug", spec.slug).maybeSingle();
    if (retry.data) return (retry.data as { id: string }).id;
  }
  console.error(`[studio] base_models insert failed for ${spec.slug}:`, insert.error?.message);
  return null;
}

/**
 * The fingerprint columns, or nothing at all: `base_models` keys its
 * suggest-only index on `architecture is not null`, and writing the geometry
 * without the architecture string leaves a row the index cannot find.
 */
function fingerprintColumns(spec: BaseModelSpec): Record<string, unknown> {
  const f = spec.fingerprint;
  if (!f?.architecture) return {};
  return {
    architecture: f.architecture,
    n_layers: f.nLayers,
    n_attention_heads: f.nAttentionHeads,
    n_kv_heads: f.nKvHeads,
    head_dim: f.headDim,
    hidden_size: f.hiddenSize,
    full_attention_interval: spec.fullAttentionInterval,
    max_position_embeddings: spec.maxPositionEmbeddings,
  };
}

/**
 * What a repo says about ITSELF, for a parent this deployment never probed.
 *
 * The creator's HF token rides along because a gated parent is otherwise
 * unreadable, and it can only ever reach huggingface.co: the slug came through
 * `repoSlugFromRef`, whose pattern admits two `[A-Za-z0-9][A-Za-z0-9._-]*`
 * segments and therefore no scheme, no host and no traversal — a declaration
 * inside a repository cannot redirect that request anywhere else.
 */
async function fetchRepoFacts(
  repoSlug: string,
  opts: { hfToken?: string; signal?: AbortSignal },
): Promise<{ license: RepoLicense | null; parameterCount: number | null }> {
  try {
    const info = await getModelInfo(repoSlug, opts);
    if (info.status !== 200 || info.body === null) return { license: null, parameterCount: null };
    const total = info.body.safetensors?.total;
    return {
      license: licenseFromCardData(info.body.cardData, { repoSlug, revision: "main" }),
      // Only safetensors repos report this. A GGUF-only parent keeps null
      // rather than a parameter count inferred from a quantized file size.
      parameterCount: typeof total === "number" && total > 0 ? total : null,
    };
  } catch {
    // A parent whose card cannot be read still gets a row — with an `unknown`
    // licence, which is exactly what an unresolved licence has to mean.
    return { license: null, parameterCount: null };
  }
}

// ─── the deploy-time entry point ────────────────────────────────────────────

export interface BaseModelResolution {
  baseModelId: string | null;
  /** `custom_models.base_model_match` — why this row is grouped where it is. */
  match: BaseModelMatch | null;
}

export interface ResolveArgs {
  /**
   * The client used to READ candidate base models — the caller's session
   * client, not the service role. `base_models` is only selectable for models
   * served by a public, ready, unsuspended listing, so RLS is what keeps
   * somebody else's private fine-tune out of a suggestion list that gets
   * written into this creator's `base_model_match`. Writes still go through
   * `admin`; defaults to `admin` when omitted, which is a fallback and not the
   * intended configuration.
   */
  reader?: SupabaseClient;
  repoSlug: string;
  architecture: StudioArchitecture | null;
  /** The licence THIS repo declares. Not the weights' licence when it is a quant. */
  license: RepoLicense | null;
  declared: DeclaredBaseModel[];
  userId: string;
  /** The creator's answer to the confirm step. Honoured only when nothing was declared. */
  choice?: BaseModelChoice | null;
  hfToken?: string;
  signal?: AbortSignal;
}

/**
 * Resolve, write the rows, and hand back what `custom_models` should store.
 *
 * Never throws; see the module header.
 */
export async function resolveBaseModel(
  admin: SupabaseClient,
  args: ResolveArgs,
): Promise<BaseModelResolution> {
  try {
    return await resolveInner(admin, args);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[studio] base-model resolution failed for ${args.repoSlug}:`, message);
    return {
      baseModelId: null,
      match: {
        signal: "unresolved",
        relation: null,
        confidence: 0,
        confirmedBy: null,
        at: new Date().toISOString(),
        reason: `Base-model resolution failed: ${message}`,
        sourceRepo: null,
        candidates: [],
      },
    };
  }
}

async function resolveInner(
  admin: SupabaseClient,
  args: ResolveArgs,
): Promise<BaseModelResolution> {
  const fingerprint = fingerprintOf(args.architecture);
  const at = new Date().toISOString();

  // Candidates are only loaded when they can be used: a declared parent is an
  // answer, and scoring the catalog against it would be a query for a list
  // nothing reads.
  const reader = args.reader ?? admin;
  const candidates =
    args.declared.length > 0
      ? []
      : await loadCandidates(reader, { repoSlug: args.repoSlug, fingerprint });

  const identity = resolveBaseModelIdentity({
    repoSlug: args.repoSlug,
    declared: args.declared,
    fingerprint,
    candidates,
  });

  if (identity.autoLink && identity.parentRepoSlug) {
    return await linkDeclared(admin, args, identity, fingerprint, at);
  }

  const suggestions = identity.suggestions.map((c) => ({
    baseModelId: c.id,
    slug: c.slug,
    confidence: c.confidence,
    matchedOn: c.matchedOn,
    relationHint: c.relationHint,
  }));

  if (args.choice && args.choice.kind !== "none") {
    const confirmed = await linkManual(
      admin,
      reader,
      args,
      args.choice,
      fingerprint,
      at,
      suggestions,
    );
    if (confirmed) return confirmed;
  }

  if (args.choice?.kind === "none") {
    // "Something else": its own model, no parent. A deliberate answer, so it
    // gets a row — the next quantization of this repo groups under it.
    const ownId = await ensureOwnModel(admin, args, fingerprint, null);
    return {
      baseModelId: ownId,
      match: {
        signal: "manual",
        relation: null,
        confidence: 1,
        confirmedBy: args.userId,
        at,
        reason: "The creator confirmed this is a model of its own, with no parent in the catalog.",
        sourceRepo: null,
        candidates: suggestions,
      },
    };
  }

  // Nothing declared and nothing confirmed. The listing stays UNGROUPED on
  // purpose: `base_model_id` is null, the catalog renders it as its own card,
  // and no licence is claimed for weights nobody has identified.
  return {
    baseModelId: null,
    match: {
      signal: "unresolved",
      relation: null,
      confidence: 0,
      confirmedBy: null,
      at,
      reason: identity.reason,
      sourceRepo: null,
      candidates: suggestions,
    },
  };
}

/** Signals 1 and 2 — the only ones that link without asking anybody. */
async function linkDeclared(
  admin: SupabaseClient,
  args: ResolveArgs,
  identity: BaseModelIdentity,
  fingerprint: Fingerprint | null,
  at: string,
): Promise<BaseModelResolution> {
  const parentRepo = identity.parentRepoSlug!;
  const parentSlug = baseModelSlugFromRepo(parentRepo);
  if (parentSlug === null) {
    return {
      baseModelId: null,
      match: {
        signal: "unresolved",
        relation: identity.relation,
        confidence: 0,
        confirmedBy: null,
        at,
        reason: `Declared base model ${parentRepo} is not a usable model slug.`,
        sourceRepo: parentRepo,
        candidates: [],
      },
    };
  }

  const parentFacts = await fetchRepoFacts(parentRepo, {
    ...(args.hfToken ? { hfToken: args.hfToken } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });

  // A REQUANTIZATION HAS ITS PARENT'S GEOMETRY — that is what makes it a
  // requantization — so the geometry probed here describes the parent and is
  // written onto it. A fine-tune's geometry is its own and is not, even though
  // it usually matches: the row it would land on is somebody else's.
  const parentId = await ensureBaseModel(admin, {
    slug: parentSlug,
    displayName: displayNameFromRepo(parentRepo),
    family: familyFromRepo(parentRepo),
    parameterCount: parentFacts.parameterCount,
    license: parentFacts.license,
    fingerprint: identity.relation === "quantized" ? fingerprint : null,
    maxPositionEmbeddings: args.architecture?.maxPositionEmbeddings ?? null,
    fullAttentionInterval: args.architecture?.fullAttentionInterval ?? null,
    parentId: null,
  });

  const match: BaseModelMatch = {
    signal: identity.signal ?? "card_data",
    relation: identity.relation,
    confidence: identity.confidence,
    confirmedBy: null,
    at,
    reason: identity.reason,
    sourceRepo: parentRepo,
    candidates: [],
  };

  if (!identity.ownModel) return { baseModelId: parentId, match };

  // A fine-tune, a merge or an adapter: its own model, whose parent is what it
  // was trained from. Its licence is its own where it declares one and the
  // parent's where it does not — a derivative does not escape the terms of the
  // weights it came from by saying nothing.
  const ownId = await ensureOwnModel(
    admin,
    { ...args, license: args.license ?? parentFacts.license },
    fingerprint,
    parentId,
  );
  return { baseModelId: ownId ?? parentId, match };
}

/**
 * The creator's answer to the confirm step. Only reachable when nothing was
 * declared, and only for an answer that names a model — "something else" is
 * handled by its caller, which has no row to look up.
 */
async function linkManual(
  admin: SupabaseClient,
  reader: SupabaseClient,
  args: ResolveArgs,
  choice: Exclude<BaseModelChoice, { kind: "none" }>,
  fingerprint: Fingerprint | null,
  at: string,
  candidates: BaseModelMatch["candidates"],
): Promise<BaseModelResolution | null> {
  const targetId = choice.kind === "existing" ? choice.baseModelId : choice.parentBaseModelId;
  if (!targetId) return null;

  // Read as the creator: a base model they cannot see is one they cannot claim,
  // which is also what stops a guessed id from naming somebody's private model.
  const target = await reader
    .from("base_models")
    .select("id, slug, display_name")
    .eq("id", targetId)
    .maybeSingle();
  const row = target.data as { id: string; slug: string; display_name: string } | null;
  if (!row) return null;

  if (choice.kind === "existing") {
    return {
      baseModelId: row.id,
      match: {
        signal: "manual",
        relation: "quantized",
        confidence: 1,
        confirmedBy: args.userId,
        at,
        reason: `The creator confirmed these weights are ${row.display_name}.`,
        sourceRepo: row.slug,
        candidates,
      },
    };
  }

  const ownId = await ensureOwnModel(admin, args, fingerprint, row.id);
  return {
    baseModelId: ownId,
    match: {
      signal: "manual",
      relation: "finetune",
      confidence: 1,
      confirmedBy: args.userId,
      at,
      reason: `The creator confirmed this is derived from ${row.display_name}.`,
      sourceRepo: row.slug,
      candidates,
    },
  };
}

/** The row for the repo being deployed, as a model in its own right. */
async function ensureOwnModel(
  admin: SupabaseClient,
  args: ResolveArgs,
  fingerprint: Fingerprint | null,
  parentId: string | null,
): Promise<string | null> {
  const slug = baseModelSlugFromRepo(args.repoSlug);
  if (slug === null) return null;
  return await ensureBaseModel(admin, {
    slug,
    displayName: displayNameFromRepo(args.repoSlug),
    family: familyFromRepo(args.repoSlug),
    parameterCount: null,
    license: args.license,
    fingerprint,
    maxPositionEmbeddings: args.architecture?.maxPositionEmbeddings ?? null,
    fullAttentionInterval: args.architecture?.fullAttentionInterval ?? null,
    parentId,
  });
}
