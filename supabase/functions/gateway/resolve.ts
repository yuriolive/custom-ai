/**
 * Model-id parsing + the single-round-trip auth/model resolution.
 *
 * CACHING BOUNDARY (FR-GW-052/053 — this is a security boundary, not an optimization):
 *   CACHEABLE (60 s, per-isolate)  model row: endpoint, served name, prices, status,
 *                                  visibility, owner. Staleness is bounded and prices
 *                                  are snapshot per transaction anyway (FR-GW-024).
 *   NEVER CACHED                   api key validity, wallet balance, suspension state.
 *                                  Caching a key creates a revocation window in which
 *                                  a leaked key still works; caching balance
 *                                  reintroduces the overdraft race.
 *   Balance is deliberately absent from ResolvedRequest: it is read INSIDE the
 *   authorize_request transaction (FR-GW-053).
 */

import type { ModelRuntime, ResolvedRequest } from "../../../packages/shared/types.ts";
import { GatewayError } from "./errors.ts";

// ─── Model id parsing (FR-GW-002) ────────────────────────────────────────────

export interface ParsedModelId {
  creatorHandle: string;
  slug: string;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

/**
 * `creator/model-slug` -> parts. Anything without exactly one `/` is a 400 whose
 * message names the correct form (FR-GW-002).
 */
export function parseModelId(model: unknown): ParsedModelId {
  if (typeof model !== "string" || model.trim() === "") {
    throw new GatewayError(
      "invalid_model_format",
      "You must provide a model parameter of the form 'creator/model-slug'.",
      { param: "model" },
    );
  }

  const value = model.trim();
  const slash = value.indexOf("/");
  if (slash === -1) {
    throw new GatewayError(
      "invalid_model_format",
      `Invalid model '${value}'. Models are addressed as 'creator/model-slug' ` +
        `(for example 'jonathancoletti/qwen3-8b'). The '/' separator is required.`,
      { param: "model" },
    );
  }
  if (value.indexOf("/", slash + 1) !== -1) {
    throw new GatewayError(
      "invalid_model_format",
      `Invalid model '${value}'. Models are addressed as 'creator/model-slug' ` +
        `and contain exactly one '/'.`,
      { param: "model" },
    );
  }

  const creatorHandle = value.slice(0, slash).toLowerCase();
  const slug = value.slice(slash + 1).toLowerCase();

  if (!HANDLE_RE.test(creatorHandle) || !SLUG_RE.test(slug)) {
    throw new GatewayError(
      "invalid_model_format",
      `Invalid model '${value}'. Models are addressed as 'creator/model-slug'.`,
      { param: "model" },
    );
  }

  return { creatorHandle, slug };
}

// ─── Raw shapes returned by the resolve query ────────────────────────────────

export interface RawApiKeyRow {
  id: string;
  user_id: string;
  /** null => live. Non-null => 401 revoked_api_key. */
  revoked_at: string | null;
}

export interface RawModelRow {
  id: string;
  user_id: string;
  status: string;
  visibility: string;
  deleted_at: string | null;
  runpod_endpoint_id: string | null;
  served_model_name: string;
  runtime: ModelRuntime;
  price_prompt_micro_usd_per_mtoken: number;
  price_completion_micro_usd_per_mtoken: number;
  platform_fee_bps: number;
  context_length: number;
  cold_start_budget_s: number;
  /**
   * FR-TOOL-003. Optional on this row type so a fixture that predates the
   * column keeps meaning "unknown" rather than silently reading as `false`.
   */
  supports_tools?: boolean | null;
}

/** One row from the single JOIN. Either half may be null (LEFT JOINs). */
export interface RawResolveRow {
  api_key: RawApiKeyRow | null;
  model: RawModelRow | null;
}

export interface ResolveQuery {
  keyHash: string;
  creatorHandle: string;
  slug: string;
  /**
   * False when the model half was served from the LRU. The key half is ALWAYS
   * fetched — key validity is never cached.
   */
  includeModel: boolean;
}

/** Injected so tests (and the mock upstream harness) need no database. */
export type ResolveExecutor = (q: ResolveQuery) => Promise<RawResolveRow>;

// ─── Per-isolate LRU for the MODEL half only (FR-GW-052/055) ─────────────────

const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_CACHE_MAX = 500;

interface CacheEntry {
  row: RawModelRow;
  expiresAt: number;
}

const modelCache = new Map<string, CacheEntry>();

function cacheKey(creatorHandle: string, slug: string): string {
  return `${creatorHandle}/${slug}`;
}

function cacheGet(creatorHandle: string, slug: string): RawModelRow | null {
  const k = cacheKey(creatorHandle, slug);
  const hit = modelCache.get(k);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    modelCache.delete(k);
    return null;
  }
  // Refresh recency.
  modelCache.delete(k);
  modelCache.set(k, hit);
  return hit.row;
}

function cacheSet(creatorHandle: string, slug: string, row: RawModelRow): void {
  const k = cacheKey(creatorHandle, slug);
  modelCache.delete(k);
  modelCache.set(k, { row, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
  while (modelCache.size > MODEL_CACHE_MAX) {
    const oldest = modelCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    modelCache.delete(oldest);
  }
}

/**
 * Kill switch for the model cache. Call from the Realtime `custom_models`
 * subscription (FR-GW-054); the 60 s TTL is only the backstop for a dropped
 * subscription, not the primary invalidation mechanism.
 */
export function invalidateModelCache(creatorHandle?: string, slug?: string): void {
  if (creatorHandle && slug) modelCache.delete(cacheKey(creatorHandle, slug));
  else modelCache.clear();
}

export function modelCacheSize(): number {
  return modelCache.size;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

export interface ResolveOutcome {
  resolved: ResolvedRequest;
  cacheHit: boolean;
}

/**
 * ONE Postgres round trip: api_keys -> profiles -> custom_models.
 *
 * Check order (each failure is as cheap as the one before it):
 *   1. key exists                          -> 401 invalid_api_key
 *   2. key not revoked                     -> 401 revoked_api_key
 *   3. model exists / not soft-deleted     -> 404 model_not_found
 *   4. visibility: private && not owner    -> 404 model_not_found  (NEVER 403)
 *   5. status === 'ready'                  -> 503 model_unavailable
 *
 * NOTE ON ORDER: the PRD table lists status (step 5) before visibility (step 6).
 * That ordering leaks existence: a stranger probing a PRIVATE, not-yet-ready model
 * would get 503 ("exists but unavailable") instead of 404, which is exactly the
 * confirmation FR-GW-012 exists to prevent. Visibility is therefore evaluated
 * first. For the owner and for public models the observable behavior is identical.
 */
export async function resolveRequest(
  keyHash: string,
  parsed: ParsedModelId,
  exec: ResolveExecutor,
  opts: { useCache?: boolean } = {},
): Promise<ResolveOutcome> {
  const useCache = opts.useCache !== false;
  const cached = useCache ? cacheGet(parsed.creatorHandle, parsed.slug) : null;

  const row = await exec({
    keyHash,
    creatorHandle: parsed.creatorHandle,
    slug: parsed.slug,
    includeModel: cached === null,
  });

  const key = row?.api_key ?? null;
  if (!key) {
    throw new GatewayError(
      "invalid_api_key",
      "Incorrect API key provided. You can find your API key at " +
        "https://nexus.dev/dashboard/keys.",
    );
  }
  if (key.revoked_at !== null && key.revoked_at !== undefined) {
    throw new GatewayError(
      "revoked_api_key",
      "This API key has been revoked. Create a new key at " +
        "https://nexus.dev/dashboard/keys.",
    );
  }

  const model = cached ?? row?.model ?? null;
  if (!model || model.deleted_at) throw notFound(parsed);

  // Visibility BEFORE status — see note above.
  if (model.visibility === "private" && model.user_id !== key.user_id) {
    throw notFound(parsed);
  }

  if (model.status !== "ready") {
    throw new GatewayError(
      "model_unavailable",
      `The model '${parsed.creatorHandle}/${parsed.slug}' is not currently available ` +
        `for inference. Please try again later.`,
      { param: "model" },
    );
  }

  if (!model.runpod_endpoint_id) {
    // A 'ready' model without an endpoint violates a DB constraint; treat as
    // unavailable rather than 500 so the caller gets an actionable status.
    throw new GatewayError(
      "model_unavailable",
      `The model '${parsed.creatorHandle}/${parsed.slug}' is not currently available ` +
        `for inference. Please try again later.`,
      { param: "model" },
    );
  }

  if (cached === null && useCache) cacheSet(parsed.creatorHandle, parsed.slug, model);

  const resolved: ResolvedRequest = {
    apiKeyId: key.id,
    userId: key.user_id,
    modelId: model.id,
    creatorId: model.user_id,
    upstreamEndpointRef: model.runpod_endpoint_id,
    servedModelName: model.served_model_name,
    runtime: model.runtime,
    pricePromptMicro: Number(model.price_prompt_micro_usd_per_mtoken),
    priceCompletionMicro: Number(model.price_completion_micro_usd_per_mtoken),
    platformFeeBps: Number(model.platform_fee_bps),
    contextLength: Number(model.context_length),
    coldStartBudgetS: Number(model.cold_start_budget_s),
    // `?? null` and never `?? false`: unknown is a third state (FR-TOOL-003).
    supportsTools: model.supports_tools ?? null,
  };

  return { resolved, cacheHit: cached !== null };
}

function notFound(parsed: ParsedModelId): GatewayError {
  // Identical response for "does not exist" and "private, not yours" (FR-GW-012).
  return new GatewayError(
    "model_not_found",
    `The model '${parsed.creatorHandle}/${parsed.slug}' does not exist or you do not ` +
      `have access to it.`,
    { param: "model" },
  );
}

// ─── PostgREST-backed executor ───────────────────────────────────────────────

/**
 * The envelope actually returned by `public.gateway_resolve` (migration
 * 20260817001800). It is FLAT and camelCase — it mirrors `ResolvedRequest`
 * rather than the `{api_key, model}` join shape this module consumes — and the
 * raw facts the gateway maps to status codes come back as sibling keys.
 */
interface GatewayResolveEnvelope {
  found: boolean;
  reason?: "no_key" | "no_model";
  apiKeyId?: string;
  userId?: string;
  modelId?: string;
  creatorId?: string;
  upstreamEndpointRef?: string | null;
  servedModelName?: string;
  runtime?: ModelRuntime;
  pricePromptMicro?: number;
  priceCompletionMicro?: number;
  platformFeeBps?: number;
  contextLength?: number;
  coldStartBudgetS?: number;
  supportsTools?: boolean | null;
  keyRevokedAt?: string | null;
  modelStatus?: string;
  modelVisibility?: string;
  modelDeletedAt?: string | null;
}

function envelopeToRow(env: GatewayResolveEnvelope): RawResolveRow {
  if (!env?.found) return { api_key: null, model: null };
  return {
    api_key: {
      id: env.apiKeyId ?? "",
      user_id: env.userId ?? "",
      revoked_at: env.keyRevokedAt ?? null,
    },
    model: {
      id: env.modelId ?? "",
      user_id: env.creatorId ?? "",
      status: env.modelStatus ?? "",
      visibility: env.modelVisibility ?? "",
      deleted_at: env.modelDeletedAt ?? null,
      runpod_endpoint_id: env.upstreamEndpointRef ?? null,
      served_model_name: env.servedModelName ?? "",
      runtime: env.runtime as ModelRuntime,
      price_prompt_micro_usd_per_mtoken: Number(env.pricePromptMicro ?? 0),
      price_completion_micro_usd_per_mtoken: Number(env.priceCompletionMicro ?? 0),
      platform_fee_bps: Number(env.platformFeeBps ?? 0),
      context_length: Number(env.contextLength ?? 0),
      cold_start_budget_s: Number(env.coldStartBudgetS ?? 0),
      supports_tools: env.supportsTools ?? null,
    },
  };
}

/**
 * Calls the `gateway_resolve` RPC (supabase/migrations — owned by A1).
 *
 * The lookup must NOT filter on `revoked_at is null` — a revoked key has to come
 * back so we can answer 401 `revoked_api_key` rather than 401 `invalid_api_key`.
 * The migration honors that.
 *
 * TWO DIVERGENCES from the signature documented in README.md, resolved in favor
 * of the migration because it is the deployed artifact:
 *
 *   1. The parameter is `p_model_slug`, not `p_slug`, and there is no
 *      `p_include_model`. The RPC always resolves both halves.
 *   2. The reply is a flat camelCase envelope, not `{api_key, model}`.
 *
 * Because the RPC has no key-only mode, the two cases that need one are served
 * by a direct `api_keys` read instead:
 *
 *   - `includeModel === false` (model-cache hit, and `GET /v1/models`), which
 *     keeps the "key validity is never cached" invariant intact; and
 *   - `reason === "no_model"`, where the envelope drops the key half entirely.
 *     Without this second read a REVOKED key asking for an UNKNOWN model would
 *     get 404 instead of 401 `revoked_api_key`, inverting the documented check
 *     order. It costs one extra round trip only on an error path.
 */
/**
 * Upstream/RPC faults are reported to the caller as an opaque internal error:
 * a PostgREST failure is a platform fault, never the caller's, and its detail
 * must not leak (FR-GW-034). Hoisted to module scope because it captures
 * nothing from its parent.
 */
function internalError(): GatewayError {
  return new GatewayError(
    "internal_error",
    "The server encountered an internal error. Please retry.",
  );
}

export function makePostgrestExecutor(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): ResolveExecutor {
  const base = supabaseUrl.replace(/\/+$/, "");
  const rpcUrl = `${base}/rest/v1/rpc/gateway_resolve`;
  const authHeaders = {
    "apikey": serviceRoleKey,
    "authorization": `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
    "accept-profile": "public",
  };

  const internal = internalError;

  async function lookupKeyOnly(keyHash: string): Promise<RawApiKeyRow | null> {
    const params = new URLSearchParams({
      select: "id,user_id,revoked_at",
      key_hash: `eq.${keyHash}`,
      limit: "1",
    });
    const res = await fetchImpl(`${base}/rest/v1/api_keys?${params}`, {
      headers: authHeaders,
    });
    if (!res.ok) throw internal();
    const rows = await res.json() as RawApiKeyRow[];
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  return async (q: ResolveQuery): Promise<RawResolveRow> => {
    if (!q.includeModel) {
      return { api_key: await lookupKeyOnly(q.keyHash), model: null };
    }

    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        p_key_hash: q.keyHash,
        p_creator_handle: q.creatorHandle,
        p_model_slug: q.slug,
      }),
    });

    if (!res.ok) {
      // Never surface PostgREST detail to a caller.
      throw internal();
    }
    const env = await res.json() as GatewayResolveEnvelope | null;
    if (!env) return { api_key: null, model: null };

    if (!env.found && env.reason === "no_model") {
      return { api_key: await lookupKeyOnly(q.keyHash), model: null };
    }
    return envelopeToRow(env);
  };
}
